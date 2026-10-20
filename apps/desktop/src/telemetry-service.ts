import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { processEntrypoint } from './entrypoints';
import { ServiceProbe } from './service-probe';
import {existsSync} from 'node:fs';
import {createDiagnostics, SERVICE_EXIT_FLUSH_MS, SERVICE_REPORT_SETTLE_MS} from './diagnostics';
import {stopTimeLeftMs} from './service-supervisor';
import {serviceLogLocation} from './log-location';
import {TelemetryIngestion, initialLive, sourceSelection} from './telemetry-ingestion';
import {LiveSubscriptions} from './live-subscriptions';
import {NativePipeClient, coalesceBrokerDiagnostics, v1BrokerConfiguration, type BrokerConfiguration} from './native-pipe-client';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {CaptureController} from './capture-controller';
import {ShutdownSequence} from './shutdown-sequence';
import {HISTORY_CLOSE_BUDGET_MS, historyWorker} from './history-storage';
import type {V1SourceState} from './v1-ingestion';
import {GAME_HISTORY_RECORDING} from './recording-policy';
import {createRecordingRuntime} from './recording-runtime';
import {JournalService} from './journal-service';
import type {LiveTelemetry, LiveTelemetryV1, SourceSelection} from '../../../packages/contracts/src';
import {liveV1Projection, withV1} from './live-v1';
import {HEARTBEAT_INTERVAL_MS} from './service-heartbeat';
import {latencyEnabled, latencyReply} from './overlay-latency';
const port = process.parentPort;
if (!port) throw new Error('Missing Electron parent port');
// ET-036: liveness heartbeat to main, unreferenced so it never keeps the event loop alive alone.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
  port.postMessage({type: 'heartbeat'});
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();
function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}
// The `service` subdirectory of the log root main resolved and passed at fork (log-location.ts).
const logLocation = serviceLogLocation(process.env, tmpdir());
const log = createDiagnostics(logLocation.directory, logLocation.detailed);
log('SERVICE_BOOT');
/**
 * An uncaught exception ends the service at once, so the records still queued behind the asynchronous log write would be
 * lost. Log one fixed row, write the queue synchronously (at most the 256 KiB the log bounds counted) and exit 1, as an
 * uncaught exception did before. A batch already being written asynchronously may land after the drained rows or be
 * lost, because process.exit does not wait for thread-pool work; nothing is written twice.
 */
process.on('uncaughtException', error => {
  log('SERVICE_UNCAUGHT', error);
  log.drainSync();
  process.exit(1);
});
/**
 * Without a handler an Electron 44 utilityProcess only warns on an unhandled rejection and keeps running (measured on
 * October 18, 2026), so the service keeps running here too: it logs one fixed row and writes it at once.
 */
process.on('unhandledRejection', reason => {
  log('SERVICE_UNHANDLED_REJECTION', reason);
  log.drainSync();
});
/**
 * Main answers a `failed` report after readiness by killing this process, so the rows that explain the failure are on
 * disk before it is posted: the append in flight gets up to SERVICE_REPORT_SETTLE_MS, and the queue is then written
 * synchronously.
 */
function postFailure(message: {type: string; code?: unknown}): void {
  void log.settle(SERVICE_REPORT_SETTLE_MS).then(() => {port.postMessage(message);});
}
const subscriptions = new LiveSubscriptions(initialLive());
// The live update is the latest v0 update with the whitelisted v1 projection of the same selection attached
// (ET-010c decisions F1 and F2); the subscriptions coalesce both to at most 20 Hz.
let v0Live: LiveTelemetry = initialLive();
let v1Live: LiveTelemetryV1 | undefined;
function publishLive(): void {subscriptions.publish(withV1(v0Live, v1Live));}
// Broker exits are logged as fixed outcome/stage codes and numbers only; routine waiting exits are omitted
// and repeated identical failures are coalesced so a retry loop cannot fill the bounded log.
const ingestion = new TelemetryIngestion(update => {v0Live = update; publishLive();}, {diagnose: coalesceBrokerDiagnostics(diagnostic => log('NATIVE_BROKER_EXIT', undefined, {...diagnostic}))});
const fixtureEndpoint = process.env.ETS2TELEMETRY_SOURCE_PIPE;
// Protocol v1 (ET-006b, E2) runs beside v0 and follows every selection. Unless the recording gate below gives it a sink,
// it is live-only: each hello asks for durableEvents false, nothing is acknowledged and no history row is written. Since
// ET-010c its whitelisted projection rides on the live update to the dashboard card and main's overlay projection; the
// window, clock mapping, delivery cursor and durable status stay in this service. Game sources are reached only through
// the verified broker in its v1 mode; fixtures only through an endpoint that matches the synthetic v1 test pipe pattern
// (ETS2TELEMETRY_SOURCE_PIPE_V1). Only fixed codes are logged: status changes per status at occurrences 1, 2, 4, 8, ...,
// and broker exits like v0's.
const v1FixtureEndpoint = process.env.ETS2TELEMETRY_SOURCE_PIPE_V1;
const diagnoseV1Broker = coalesceBrokerDiagnostics(diagnostic => log('NATIVE_BROKER_V1_EXIT', undefined, {...diagnostic}));
const v1StatusCounts = new Map<string, number>();
let v1Status: string | undefined;
function recordV1State(state: V1SourceState): void {
  if (state.status === v1Status) return;
  v1Status = state.status;
  const count = (v1StatusCounts.get(state.status) ?? 0) + 1; v1StatusCounts.set(state.status, count);
  if ((count & (count - 1)) === 0) log('V1_SOURCE_STATUS', undefined, {status: state.status, selection: state.selection, durable: state.durable.state, count});
}
let lastV1: V1SourceState | undefined;
/** Republishes only for a change the projection shows: a clock mapping or durable status update alone is not one. */
function onV1State(state: V1SourceState): void {
  recordV1State(state);
  const previous = lastV1; lastV1 = state;
  if (previous && previous.selection === state.selection && previous.status === state.status && previous.reason === state.reason &&
    previous.fresh === state.fresh && previous.observation === state.observation) return;
  v1Live = liveV1Projection(state); publishLive();
}
// ET-015a recording gate (R3, R10): game selections stay live-only while GAME_HISTORY_RECORDING is false. Only
// ETS2TELEMETRY_RECORDING=synthetic:<name>|replay:<name> constructs the trip recorder, over a database in the synthetic
// directory that replaces history, and makes only the matching selection durable once that database is open. The
// durable history database (ET-013, OD-2), or the recording target that replaces it, is opened at start in its own
// storage worker without delaying readiness or live telemetry; the ET-001 temporary probe below stays the readiness gate,
// and opening the database lets the live-only v1 connection reconnect durable (R10). This wiring lives in
// recording-runtime.ts (ET-015c, G13), so the storage suite drives the same code with a real storage worker. ET-015c
// (G4): the recording status goes to main on the parent port as {type: 'recording', status}, from the start until the
// orderly stop begins; production, which builds no recorder, reports {state: 'disabled'} once.
const runtime = createRecordingRuntime({env: process.env, gameHistory: GAME_HISTORY_RECORDING, localAppData: process.env.LOCALAPPDATA, log,
  createWorker: () => historyWorker(__dirname), connectGame: (configuration, game) => new NativePipeClient(configuration, game, diagnoseV1Broker, 'v1'),
  onV1State, onRecordingStatus: status => port.postMessage({type: 'recording', status})});
const v1 = runtime.v1;
// ET-016 (J2, J4): journal reads from main, through the database the runtime opened, one at a time and only while it is
// open. Main sends {type: 'journal', id, query}; the answer is {type: 'journal', id, result} with a fixed J11 code on refusal.
const journal = new JournalService({history: runtime.history, stopping: () => stopping, log});
/** A v1 failure never fails the v0 selection it follows. */
function selectV1(selection: SourceSelection, broker: BrokerConfiguration | undefined): void {
  try {v1.configureBroker(v1BrokerConfiguration(broker)); v1.select(selection, v1FixtureEndpoint);}
  catch {log('V1_SELECT_REJECTED');}
}
async function boundedSha256(filename: string, limit: number): Promise<string | null> {
  try {
    const file = await open(filename, 'r');
    try {
      if ((await file.stat()).size > limit) return null;
      const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
      for (;;) { const {bytesRead} = await file.read(chunk, 0, chunk.length, offset); if (!bytesRead) break; offset += bytesRead; if (offset > limit) return null; hash.update(chunk.subarray(0, bytesRead)); }
      return hash.digest('hex');
    } finally {await file.close();}
  } catch {return null;}
}
// One opt-in capture interval per service lifetime; it never feeds live state, history or ACKs.
const captures = new CaptureController({log, localAppData: process.env.LOCALAPPDATA, identity: async broker => {
  const [desktopBuildEvidenceSha256, brokerSha256] = await Promise.all([boundedSha256(path.join(__dirname, 'build-evidence.json'), 1024 * 1024), boundedSha256(broker.executable, 64 * 1024 * 1024)]);
  return {code: {desktopBuildEvidenceSha256, brokerSha256, electron: process.versions.electron ?? null, node: process.versions.node, sourceCommit: process.env.ETS2TELEMETRY_SOURCE_COMMIT ?? null},
    platform: {os: os.version(), release: os.release(), arch: process.arch}};
}});
const probe = new ServiceProbe({
  diagnose: log,
  createDirectory: () => mkdtemp(path.join(tmpdir(), 'ets2telemetry-probe-')),
  createWorker: directory => {
    const entrypoint = processEntrypoint(__dirname, 'storage-worker');
    if (!existsSync(entrypoint)) throw new Error('Missing physical storage worker entrypoint');
    const worker = new Worker(entrypoint, {workerData: {kind: 'probe', filename: path.join(directory, 'probe.sqlite')}});
    return {
      onMessage: listener => {worker.once('message', listener);},
      onError: listener => {worker.once('error', listener);},
      onExit: listener => {worker.once('exit', listener);},
      terminate: async () => {await worker.terminate();}
    };
  },
  removeDirectory: directory => rm(directory, {recursive: true, force: true}),
  report: message => {
    // During an orderly stop the probe's completion belongs to the storage step; the
    // sequence sends the single final `stopped` message after every phase.
    if (stopping && message.type === 'stopped') {storageStopped = true; return;}
    log('SERVICE_REPORT', message);
    if (message.type === 'failed') postFailure(message); else port.postMessage(message);
    if (stopping) return;
    if (message.type === 'stopped') exitAfterHistory(0);
    if (message.code === 'SERVICE_STOP_FAILED') exitAfterHistory(1);
  }
});
// Ordered, bounded service shutdown: 1000 (intake) + 500 (flush) + 1000 (storage) = SERVICE_STOP_BUDGET_MS.
let stopping = false, storageStopped = false, exiting = false;
// When this service received `stop`; main's kill deadline started a little earlier, when main posted it.
let stopReceivedAt: number | undefined;
/**
 * How long the final log write lets an append in flight finish. After `stop` it is the time left until 300 ms before
 * main's kill deadline (stopTimeLeftMs), so the wait ends at most 2,700 ms after `stop` arrived. A stop that overran that
 * point waits 0 ms: the queue is written at once, and a batch still in flight may land after it or be lost. Without a
 * `stop` (a failed probe's exit) the wait is SERVICE_EXIT_FLUSH_MS.
 */
function exitWaitMs(): number {
  return stopReceivedAt === undefined ? SERVICE_EXIT_FLUSH_MS : stopTimeLeftMs(performance.now() - stopReceivedAt);
}
/**
 * Exits once the final rows (the last SHUTDOWN_STEP and SERVICE_REPORT) are on disk. No asynchronous append starts after
 * this point; the one in flight gets exitWaitMs(), and the queue is then written synchronously, so the final rows never
 * depend on a timer racing process.exit. Only that in-flight batch, if it is still unsettled, can land after them or be lost.
 */
function exitAfterLog(code: number): Promise<void> {
  return log.finalize(exitWaitMs()).then(() => {process.exit(code);});
}
/**
 * A failed probe ends the service from its report, outside the orderly sequence. Close the history database first,
 * bounded by the same budget as its shutdown step, then exit with the probe's code; a late close never delays the exit.
 * The recording status stops first, so the closing database is never reported to main (ET-015c).
 */
function exitAfterHistory(code: number): void {
  if (exiting) return;
  stopHeartbeat();
  exiting = true; runtime.stopStatus();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>(resolve => {timer = setTimeout(resolve, HISTORY_CLOSE_BUDGET_MS);});
  void Promise.race([runtime.history.close().catch(() => undefined), bound]).then(() => {clearTimeout(timer); return exitAfterLog(code);});
}
const shutdown = new ShutdownSequence(log);
shutdown.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => ingestion.stop()});
shutdown.register('intake', {name: 'capture', budgetMs: 1000, run: () => captures.stop()});
shutdown.register('storage', {name: 'storage-probe', budgetMs: 1000, run: async () => {
  await probe.stop();
  if (!storageStopped) throw new Error('Storage probe did not stop cleanly');
}});
// v1-ingestion (intake), recording-flush (flush) and history-storage (storage), in that phase order (R14); see
// recording-runtime.ts. Registered after the probe so each phase keeps its earlier step order.
runtime.register(shutdown);
function stop(): void {
  if (stopping) return;
  stopHeartbeat();
  stopping = true; stopReceivedAt = performance.now(); subscriptions.close(); runtime.stopStatus();
  void shutdown.run().then(({clean}) => {
    const message = {type: 'stopped', clean};
    log('SERVICE_REPORT', message); port.postMessage(message);
    return exitAfterLog(clean ? 0 : 1);
  });
}
port.on('message', event => {
  const incoming: unknown = event.data;
  const command = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming as Record<string, unknown> : undefined;
  if (command?.type === 'stop') stop();
  else if (command?.type === 'unsubscribe') subscriptions.close();
  else if (command?.type === 'subscribe' && event.ports.length === 1) subscriptions.attach(event.ports[0]);
  else if (command?.type === 'select') {
    try {
      const selection = sourceSelection(command.source);
      const incomingBroker = command.broker;
      let broker;
      if (incomingBroker !== undefined) {
        if (!incomingBroker || typeof incomingBroker !== 'object' || Array.isArray(incomingBroker)) throw new Error('Invalid broker configuration');
        const configuration = incomingBroker as Record<string, unknown>;
        if (typeof configuration.executable !== 'string' || typeof configuration.discoveryDirectory !== 'string') throw new Error('Invalid broker configuration');
        broker = {executable: configuration.executable, discoveryDirectory: configuration.discoveryDirectory};
      }
      ingestion.configureBroker(broker); ingestion.select(selection, fixtureEndpoint);
      selectV1(selection, broker);
      // Evidence capture is independent of live ingestion: a rejected grant never fails selection.
      if (command.capture !== undefined) captures.offer(command.capture, selection, broker);
    }
    catch {postFailure({type: 'failed', code: 'INVALID_SOURCE_COMMAND'});}
  } else if (latencyEnabled(process.env) && command?.type === 'overlay-latency') {
    for (const transferred of event.ports) transferred.close();
    const reply = latencyReply(command, v1.current, process.hrtime.bigint());
    if (reply) port.postMessage(reply);
  } else if (command?.type === 'journal') {
    for (const transferred of event.ports) transferred.close();
    journal.receive(command, reply => port.postMessage(reply));
  } else if (process.env.ETS2TELEMETRY_LIVE_SMOKE === '1' && command?.type === 'diagnostic-freeze') {
    for (const transferred of event.ports) transferred.close();
    const duration = typeof command.ms === 'number' && Number.isFinite(command.ms) && command.ms > 0 ? command.ms : 10000;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
  } else {for (const transferred of event.ports) transferred.close();}
});
void probe.start();
runtime.start();
