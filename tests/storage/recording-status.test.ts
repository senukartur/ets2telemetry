// ET-015c PR-3 (G3-G7, G9, G10, G14, G16, G17, G20): the recording status the telemetry service derives, driven through
// the production wiring (apps/desktop/src/recording-runtime.ts) in process under the pinned Electron runtime, with the
// real or the fault storage worker and the reactive v1 simulator on actual Windows pipes. Each case records
// `synthetic:<name>` under a temporary LOCALAPPDATA and must never create its history database. The status sequences are
// written by hand from G3 and docs/telemetry-service-v1.md#recording-status-et-015c; stored rows from the hand-written
// expectations in tests/fixtures/recording and the simulator corpus. Waits count held requests, commits, ACKs and
// source messages; real-time bounds are named hang guards only.
import {existsSync, readFileSync} from 'node:fs';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import type {MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {RecordingHealth} from '../../packages/contracts/src';
import type {StorageWorkerHandle} from '../../packages/storage/src/client';
import type {TelemetrySocket} from '../../apps/desktop/src/native-pipe-client';
import {createRecordingRuntime, type RecordingIngestionOverrides, type RecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {
  ClientSocket, guarded, RECORDING_FIXTURES, recordingExpected, replayOf, servedAcks, storageWorker, storedRows, storedSamples, terminateWorkers, tracedConnect,
  tracedHandle, tracedShutdown, tripExpected, until, withTransport
} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a held request, a server run, a status); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
const connect = (atMs: number, client: Json = {durable: true}) => ({atMs, action: 'connect', client});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
const scenario = (id: string) => readFixtureFile(scenarioPath(id)) as Json & {seed: string; steps: Json[]};
/** ET-015b's sample scenario (not in the simulator manifest). */
const samplesScenario = () => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string; steps: Json[]};
const sessionOf = (input: Json) => scenarioSource(replayOf(input).scenario).pluginSessionId;
const target = (name: string) => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', `${name}.sqlite`);
const historyFile = () => path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
/** The synthetic target as the storage readers of recording-helpers.ts expect it. The database must be closed. */
const reader = (name: string) => ({database: target(name), open: () => ws.open({path: target(name), backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups')})});
const ZERO = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
const IDLE = {phase: 'idle', completeness: null, untrackedJob: false};
/** A full status of the synthetic target, written by hand. */
const status = (state: string, losses: Partial<typeof ZERO> = {}, trip: unknown = IDLE, code: string | null = null) =>
  ({state, target: 'synthetic', code, losses: {...ZERO, ...losses}, trip});
/** The published states, `state` or `state CODE`, with adjacent repeats removed (a trip or loss change alone is not a step). */
const sequence = (statuses: RecordingHealth[]) => statuses.map(s => 'code' in s && s.code ? `${s.state} ${s.code}` : s.state).filter((s, i, all) => i === 0 || s !== all[i - 1]);
const lastState = (statuses: RecordingHealth[]) => statuses.at(-1)?.state;

/** Codes the runtime logs that a case orders against its other observations. */
const TIMELINE_CODES = /^(HISTORY_STORAGE_OPENED|HISTORY_STORAGE_CLOSED|V1_DURABLE_RESTORE_LOSS)$/;
/**
 * One service's recording runtime for `synthetic:<name>` under the workspace as LOCALAPPDATA, built by the production
 * factory. Only the worker, the fixture connect, the test close grace, ingestion test knobs and a status interval of 0
 * are supplied: every status change the publisher settles is recorded, none is coalesced away by real time.
 */
/**
 * The v1 staleness bound of these cases. With the 500 ms default, a host that stalls the test process for longer, or a
 * session open slower than 500 ms after the last frame of a connection, would turn connected data stale by real time
 * and add or remove an `interrupted` or `recording` step. Staleness is covered by the unit rule table; here each step
 * follows source messages only.
 */
const NO_STALE_MS = 600_000;
/**
 * The sample flush delay of these cases (review pass 1). With the 5 s default a slow host could let the timer write
 * pending rows mid-case: a successful write clears the retry code early in (a), and a write before the failure leaves
 * nothing to discard in (b). No case tests the timer, so pending rows are written only by a full batch or at the stop.
 */
const NO_FLUSH_TIMER_MS = 600_000;
function serviceRuntime(name: string, worker: StorageWorkerHandle, socket: {connect: (endpoint: string) => TelemetrySocket}, timeline: string[],
  options: {onState?: (state: V1SourceState) => void; onStatus?: (status: RecordingHealth) => void; ingestionOverrides?: RecordingIngestionOverrides} = {}) {
  const logs: [string, unknown][] = [], states: V1SourceState[] = [], statuses: RecordingHealth[] = [];
  const runtime = createRecordingRuntime({env: {ETS2TELEMETRY_RECORDING: `synthetic:${name}`}, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory,
    log: (event, _detail, facts) => { logs.push([event, facts]); if (TIMELINE_CODES.test(event)) timeline.push(event); },
    createWorker: () => worker, connect: socket.connect, ingestionOverrides: {staleMs: NO_STALE_MS, sampleFlushMs: NO_FLUSH_TIMER_MS, ...options.ingestionOverrides},
    historyOverrides: {appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS}, statusOverrides: {intervalMs: 0},
    onV1State: state => { states.push(state); options.onState?.(state); },
    onRecordingStatus: next => { statuses.push(next); options.onStatus?.(next); }});
  return {runtime, logs, states, statuses};
}
/** Starts the runtime and selects the simulator once the database is open, so the first hello is durable (R10). */
async function startDurable(runtime: RecordingRuntime, endpoint: string) {
  runtime.start();
  await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(runtime.history.state).toBe('open');
  runtime.v1.select('synthetic', endpoint);
}
/** Stops the status, then the runtime through the real shutdown sequence, as the service's orderly stop does. */
async function stopService(s: ReturnType<typeof serviceRuntime>, timeline: string[], exit: Promise<number>) {
  s.runtime.stopStatus();
  const shutdown = tracedShutdown(timeline);
  s.runtime.register(shutdown.registrar);
  await shutdown.sequence.run();
  expect(await guarded(exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
}
const durableLogs = (logs: [string, unknown][]) => logs.filter(([event]) => /^V1_(DURABLE|SAMPLES)_/.test(event));
/** The status sequence of a service that starts, sees its database open and then selects the source (startDurable). */
const STARTED = ['opening', 'not-recorded-source', 'waiting'];

describe('ET-015c recording status through the production wiring', () => {
  it('(a) SQLITE_FULL at job.delivered: recording, retrying DISK_FULL, recording again once the redelivery commits (G9, REG-007)', async () => {
    // normal-delivery with a second durable connection at 606 ms; the first commit of eventSeq 8 fails inside its
    // transaction, and the redelivery on the second connection commits it with the reconnection's not-connected interval.
    const input = withTransport(scenario('normal-delivery'), 'normal-delivery-disk-full-status', [connect(0), disconnect(605), connect(606), disconnect(1100)]);
    const expected = recordingExpected('normal-delivery-retry');
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker({fault: {eventSeq: '8', code: 'SQLITE_FULL', times: 1}});
    const s = serviceRuntime('t', worker.handle, tracedConnect(timeline), timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => lastState(s.statuses) === 'interrupted', 'the final interrupted status', HANG_GUARD_MS);
      expect(sequence(s.statuses)).toEqual([...STARTED, 'recording', 'retrying DISK_FULL', 'recording', 'interrupted']);
      expect(s.statuses.at(-1)).toEqual(status('interrupted', {notConnected: 1}));
      expect(durableLogs(s.logs)).toEqual([['V1_DURABLE_RETRY', {code: 'DISK_FULL', count: 1}]]);
      expect([servedAcks(report, 0), servedAcks(report, 1)]).toEqual([['1', '2', '3', '4', '5', '6', '7'], ['8', '9']]);
      await stopService(s, timeline, worker.exit);
      const storage = await reader('t').open();
      expect(ok(storage.committedThrough(sessionOf(input)))).toBe(expected.coverage.committedThroughEventSeq);
      storage.close();
      expect(await storedRows(reader('t'), input.seed as string)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(b) SQLITE_READONLY at job.delivered: stopped PERMISSION_DENIED for the service lifetime, and the reconnection is live-only (G10)', async () => {
    // As S4 (b): the second connection is scripted live-only, as the failed service reconnects; a frame at 650 ms
    // publishes the job clear's noDurableConsumer loss.
    const input = withTransport(scenario('normal-delivery'), 'normal-delivery-permission-denied-status', [connect(0), disconnect(605), connect(606, {durable: false}), disconnect(700)],
      [{atMs: 650, action: 'frame'}]);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker({fault: {eventSeq: '8', code: 'SQLITE_READONLY', times: 1}});
    const s = serviceRuntime('t', worker.handle, tracedConnect(timeline), timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => s.runtime.v1.current.status === 'disconnected' && report.connections.length === 2, 'the end of the live-only connection', HANG_GUARD_MS);
      expect(sequence(s.statuses)).toEqual([...STARTED, 'recording', 'stopped PERMISSION_DENIED']);
      // The trip opened by eventSeq 3 stays open: its delivery was never committed.
      expect(s.statuses.at(-1)).toEqual(status('stopped', {}, {phase: 'active', completeness: 'partial', untrackedJob: false}, 'PERMISSION_DENIED'));
      // H12: the unavailable failure discards the one pending sample row, second 1000 from the snapshot at 100 ms (the
      // checkpoint at 0 ms is the baseline; the snapshot at 200 ms is in the same second).
      expect(durableLogs(s.logs)).toEqual([['V1_DURABLE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}], ['V1_SAMPLES_DISCARDED', {count: 1}]]);
      expect([report.connections.map(c => c.durable), servedAcks(report, 0), servedAcks(report, 1)]).toEqual([[true, false], ['1', '2', '3', '4', '5', '6', '7'], []]);
      await stopService(s, timeline, worker.exit);
      const storage = await reader('t').open();
      expect([ok(storage.committedThrough(sessionOf(input))), ok(storage.listTrips()).trips.map(t => [t.outcome, t.recordingCompleteness])]).toEqual(['7', [['open', 'partial']]]);
      storage.close();
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(c) a held commit and a bound of four: retrying BACKLOG_FULL, then the restarted service records the redelivery (REG-011)', async () => {
    // As S4 (c): the first connection's client does not wait for ACKs, so the server writes events 1-5 while eventSeq 1
    // is held inside its transaction; the fifth closes the connection with BACKLOG_FULL. Every item is redelivered, one
    // more than the bound, so the redelivery goes to a restarted service with the production bound (G11 is PR-2's; this
    // case shows the status).
    const input = withTransport(scenario('normal-delivery'), 'normal-delivery-backlog-status', [connect(0, {durable: true, ack: 'withhold'}), disconnect(350), connect(360), disconnect(1100)]);
    const expected = recordingExpected('normal-delivery-backlog');
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true, quiesceMs: 0});
    const first: string[] = [], workerA = storageWorker({hold: {eventSeq: '1'}}), control = workerA.control as MessagePort, failures: unknown[] = [];
    const held = guarded(once(control, 'message'), 'the held commit of eventSeq 1', HANG_GUARD_MS);
    let recorded!: () => void;
    const recording = new Promise<void>(resolve => { recorded = resolve; });
    let gated = false;
    // The first connection's eventSeq 5 and everything after it reach the ingestion only once (1) the worker holds the
    // commit of eventSeq 1, so 2-4 queue behind a commit in flight and 5 exceeds the bound (S4 (c), hosted run
    // 38907225873), and (2) the publisher sent `recording` for the snapshots before 5. The publisher computes the status
    // one macrotask after a change (G5): when the snapshot that makes the source connected and eventSeq 5 are applied in
    // the same macrotask, as on a slow host that has read both already, it correctly sends only `retrying` (hosted run
    // 38949384603). Holding 5 back until `recording` was sent makes that step observable on every host.
    const gatedConnect = {connect: (endpoint: string) => {
      const gate = gated ? undefined : {beforeEventSeq: '5', until: () => Promise.all([held, guarded(recording, 'the recording status before eventSeq 5', HANG_GUARD_MS)])};
      gated = true;
      return new ClientSocket(net.connect(endpoint), gate, error => failures.push(error)) as unknown as TelemetrySocket;
    }};
    let stoppedA: Promise<void> | undefined;
    const a = serviceRuntime('t', workerA.handle, gatedConnect, first, {onStatus: next => { if (next.state === 'recording') recorded(); }, onState: state => {
      if (stoppedA || state.reason !== 'Durable commit not completed (BACKLOG_FULL); retrying') return;
      // One macrotask later: release the held commit and stop this service; the flush waits for that commit.
      stoppedA = new Promise(resolve => setImmediate(() => { first.push('release'); control.postMessage({type: 'release'}); void stopService(a, first, workerA.exit).then(resolve); }));
    }, ingestionOverrides: {maxPendingCommits: 4}});
    try {
      await startDurable(a.runtime, server.endpoint);
      expect(await held).toEqual([{type: 'held', eventSeq: '1'}]);
      await until(() => stoppedA !== undefined, 'the BACKLOG_FULL close', HANG_GUARD_MS);
      await guarded(stoppedA!, 'the stop of the first service', HANG_GUARD_MS);
      expect(sequence(a.statuses)).toEqual([...STARTED, 'recording', 'retrying BACKLOG_FULL']);
      expect(a.statuses.at(-1)).toEqual(status('retrying', {}, IDLE, 'BACKLOG_FULL'));
      expect(durableLogs(a.logs)).toEqual([['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]);

      const timeline: string[] = [], workerB = storageWorker();
      const b = serviceRuntime('t', workerB.handle, tracedConnect(timeline), timeline);
      await startDurable(b.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => lastState(b.statuses) === 'interrupted', 'the final interrupted status', HANG_GUARD_MS);
      expect(sequence(b.statuses)).toEqual([...STARTED, 'recording', 'interrupted']);
      // The redelivered trip opens with its opened-before-attach cause, a committed not-connected interval.
      expect(b.statuses.at(-1)).toEqual(status('interrupted', {notConnected: 1}));
      expect([servedAcks(report, 0), servedAcks(report, 1), failures]).toEqual([[], ['1', '2', '3', '4', '5', '6', '7', '8', '9'], []]);
      await stopService(b, timeline, workerB.exit);
      const storage = await reader('t').open();
      expect(ok(storage.committedThrough(sessionOf(input)))).toBe(expected.coverage.committedThroughEventSeq);
      storage.close();
      expect(await storedRows(reader('t'), input.seed as string)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { control.close(); await server.stop(); }
  }, 90_000);

  it('(d) a pause reads paused, a scripted disconnection interrupted, and the reconnection records again (REG-002, REG-003)', async () => {
    // one-second-samples: every frame from 6,000 to 8,750 ms reports simulation paused; connection 1 ends at 13,000 ms
    // and connection 2 starts at 15,500 ms. Its first carrier commits the reconnection's not-connected interval of trip@3.
    const input = samplesScenario();
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker();
    const s = serviceRuntime('t', worker.handle, tracedConnect(timeline), timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => lastState(s.statuses) === 'interrupted' && report.connections.length === 2, 'the final interrupted status', HANG_GUARD_MS);
      expect(sequence(s.statuses)).toEqual([...STARTED, 'recording', 'paused', 'recording', 'interrupted', 'recording', 'interrupted']);
      expect(s.statuses.at(-1)).toEqual(status('interrupted', {notConnected: 1}));
      expect(durableLogs(s.logs)).toEqual([]);
      await stopService(s, timeline, worker.exit);
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);

  it('(e) a database restored behind the plugin: live-only ACK_AHEAD_OF_STORAGE with one restore loss of A - C events (R9, G6)', async () => {
    // normal-delivery with a durable reconnection at 606 ms. Service A records connection 1 (events 1-8, all acknowledged)
    // into synthetic:a and stops. Service B opens a new synthetic:b (C = 0) and its checkpoint reports A = 8.
    const input = withTransport(scenario('normal-delivery'), 'normal-delivery-restore-loss-status', [connect(0), disconnect(605), connect(606), disconnect(1100)]);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    try {
      const first: string[] = [], workerA = storageWorker();
      let stoppedA: Promise<void> | undefined;
      const a = serviceRuntime('a', workerA.handle, tracedConnect(first), first, {onState: state => {
        if (!stoppedA && state.status === 'disconnected') stoppedA = new Promise(resolve => setImmediate(() => { void stopService(a, first, workerA.exit).then(resolve); }));
      }});
      await startDurable(a.runtime, server.endpoint);
      await until(() => stoppedA !== undefined, 'the end of connection 1', HANG_GUARD_MS);
      await guarded(stoppedA!, 'the stop of service A', HANG_GUARD_MS);
      expect(sequence(a.statuses)).toEqual([...STARTED, 'recording']);

      const timeline: string[] = [], workerB = storageWorker();
      const b = serviceRuntime('b', workerB.handle, tracedConnect(timeline), timeline);
      await startDurable(b.runtime, server.endpoint);
      const restoreLosses = () => { const last = b.statuses.at(-1); return last && 'losses' in last ? last.losses.restoreLoss : undefined; };
      await until(() => timeline.includes('V1_DURABLE_RESTORE_LOSS') && lastState(b.statuses) === 'live-only' && restoreLosses() === 1, 'the recorded restore loss', HANG_GUARD_MS);
      expect(sequence(b.statuses)).toEqual([...STARTED, 'live-only ACK_AHEAD_OF_STORAGE']);
      expect(b.statuses.at(-1)).toEqual(status('live-only', {lostEvents: 8, restoreLoss: 1}, IDLE, 'ACK_AHEAD_OF_STORAGE'));
      expect(durableLogs(b.logs)).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}], ['V1_DURABLE_RESTORE_LOSS', {code: 'RECORDED'}]]);
      await stopService(b, timeline, workerB.exit);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect([servedAcks(report, 0), servedAcks(report, 1)]).toEqual([['1', '2', '3', '4', '5', '6', '7', '8'], []]);
      expect(await storedRows(reader('b'), input.seed as string)).toEqual({trips: [], attributions: [], intervals: [
        {trip: null, kind: 'restore-loss', firstEventSeq: '1', lastEventSeq: '8', detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq: '0', ackedThroughEventSeq: '8'}}]});
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);

  it('(f) the application absent: no spool and no history for the absent interval; the checkpoint hydrates and the offline gaps are counted (G17)', async () => {
    // app-absent-hydration: events 1-3 and 4 happen before the client attaches at 100 ms and arrive as offline gaps; the
    // checkpoint hydrates the job without an event; the clear (5) is the only event row.
    const input = scenario('app-absent-hydration'), expected = tripExpected('app-absent-hydration');
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker();
    const s = serviceRuntime('t', worker.handle, tracedConnect(timeline), timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => lastState(s.statuses) === 'interrupted', 'the final interrupted status', HANG_GUARD_MS);
      expect(sequence(s.statuses)).toEqual([...STARTED, 'recording', 'interrupted']);
      expect(s.statuses.at(-1)).toEqual(status('interrupted', {lostEvents: 4, notConnected: 2}));
      await stopService(s, timeline, worker.exit);
      const storage = await reader('t').open(), session = sessionOf(input);
      expect([ok(storage.committedThrough(session)), ok(storage.listEvents(session)).map(event => event.eventSeq)]).toEqual([expected.coverage.committedThroughEventSeq, ['5']]);
      storage.close();
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      // The only one-second row is the frame at 150 ms, after the attach; the checkpoint at 100 ms is the baseline (H4).
      expect((await storedSamples(reader('t'), input.seed, session)).map(row => (row as {monotonicNs: string}).monotonicNs)).toEqual(['1000150000000']);
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);

  it('(g) a plugin exit then a new plugin session: the old trip closes as restart, partial, and the new session starts at eventSeq 1 (G16)', async () => {
    const base = scenario('normal-delivery');
    // Session A: normal-delivery up to its second simulation.started (500 ms), then a plugin shutdown that sends end.
    const inputA = {...base, id: 'plugin-restart-a', steps: [...base.steps.filter(step => (step.atMs as number) <= 500), {atMs: 700, action: 'shutdown', reason: 'plugin-shutdown'}],
      transport: [connect(0)]};
    // Session B: a new plugin session of the same game with its own seed.
    const inputB = {...base, id: 'plugin-restart-b', seed: 'et015c-plugin-restart-b', steps: [base.steps[0], {atMs: 40, action: 'lifecycle', event: 'simulation.started'},
      {atMs: 100, action: 'frame', channels: {speed: 10}}], transport: [connect(0), disconnect(300)]};
    const expected = JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'plugin-restart.rows.expected.json'), 'utf8')) as ReturnType<typeof recordingExpected> & {
      coverage: {sessionB: {committedThroughEventSeq: string; events: string[]}}};
    expect([reactiveConflicts(inputA), reactiveConflicts(inputB)]).toEqual([[], []]);
    const serverA = await serveV1Reactive(inputA, {scale: 0, awaitScriptedAcks: true}), serverB = await serveV1Reactive(inputB, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker();
    const s = serviceRuntime('t', worker.handle, tracedConnect(timeline), timeline);
    try {
      await startDurable(s.runtime, serverA.endpoint);
      const reportA = await guarded(serverA.done, 'the run of plugin session A', HANG_GUARD_MS);
      await until(() => s.runtime.v1.current.reason === 'Source ended (plugin-shutdown)', 'the end of plugin session A', HANG_GUARD_MS);
      expect([reportA.connections.map(c => c.closedBy), servedAcks(reportA, 0)]).toEqual([['end'], ['1', '2', '3', '4', '5', '6', '7']]);
      // The game restarts: its new plugin session is reached through the same selection.
      s.runtime.v1.select('synthetic', serverB.endpoint);
      const reportB = await guarded(serverB.done, 'the run of plugin session B', HANG_GUARD_MS);
      await until(() => lastState(s.statuses) === 'interrupted' && s.runtime.v1.current.observation?.source.pluginSessionId === sessionOf(inputB), 'the end of plugin session B', HANG_GUARD_MS);
      expect(servedAcks(reportB, 0)).toEqual(expected.coverage.sessionB.events);
      expect(sequence(s.statuses)).toEqual([...STARTED, 'recording', 'interrupted', 'recording', 'interrupted']);
      expect(s.statuses.at(-1)).toEqual(status('interrupted'));
      expect(durableLogs(s.logs)).toEqual([]);
      await stopService(s, timeline, worker.exit);
      const storage = await reader('t').open(), sessionB = sessionOf(inputB);
      expect([ok(storage.committedThrough(sessionOf(inputA))), ok(storage.committedThrough(sessionB)), ok(storage.listEvents(sessionB)).map(event => event.eventSeq)])
        .toEqual([expected.coverage.committedThroughEventSeq, expected.coverage.sessionB.committedThroughEventSeq, expected.coverage.sessionB.events]);
      storage.close();
      expect(await storedRows(reader('t'), base.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { await serverA.stop(); await serverB.stop(); }
  }, 90_000);

  it('(h) R10: the live-only window of a database still opening becomes a committed noDurableConsumer gap, which the status counts (G14)', async () => {
    // As PR-1 (b): live-only.json's steps paced at scale 1, the open held until the live-only connection counted both
    // events as noDurableConsumer loss; the durable reconnection commits the gap 1-2 (r10-upgrade.rows.expected.json).
    const base = scenario('live-only');
    const input = {...base, id: 'r10-upgrade', steps: [...base.steps, ...Array.from({length: 98}, (_, i) => ({atMs: 300 + 100 * i, action: 'frame'}))],
      transport: [connect(0, {durable: false}), disconnect(10_050), connect(10_100), disconnect(10_200)]};
    const expected = recordingExpected('r10-upgrade');
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 1, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker(), traced = tracedHandle(worker.handle, timeline, 'open');
    const s = serviceRuntime('t', traced.handle, tracedConnect(timeline), timeline, {onState: state => {
      if (state.observation?.status.eventLoss.noDurableConsumer === '2' && !timeline.includes('release')) traced.release();
    }});
    try {
      s.runtime.start();
      await guarded(traced.held, 'the held open', HANG_GUARD_MS);
      s.runtime.v1.select('synthetic', server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', 60_000);
      await until(() => lastState(s.statuses) === 'interrupted', 'the final interrupted status', HANG_GUARD_MS);
      expect(report.connections.map(c => [c.durable, c.closedBy])).toEqual([[false, 'client'], [true, 'disconnect']]);
      // While the open is held the status stays opening, whatever the live-only connection does.
      expect(sequence(s.statuses)).toEqual(['opening', 'waiting', 'recording', 'interrupted']);
      expect(s.statuses.at(-1)).toEqual(status('interrupted', {lostEvents: 2, notConnected: 1}));
      await stopService(s, timeline, worker.exit);
      expect(await storedRows(reader('t'), base.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);

  it('(i) live state and the status keep advancing while a commit is held (G20)', async () => {
    // one-second-samples with one connection whose client does not wait for ACKs, so the server keeps writing frames while
    // the commit of simulation.paused (eventSeq 5, 5,900 ms) is held inside its transaction. The paused frames reach the
    // live state and the status before the release; the recorder sees them only after the commit, in FIFO order.
    const input = withTransport(samplesScenario(), 'one-second-samples-held-commit', [connect(0, {durable: true, ack: 'withhold'}), disconnect(17_500)]);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true, quiesceMs: 0});
    const timeline: string[] = [], worker = storageWorker({hold: {eventSeq: '5'}}), control = worker.control as MessagePort, traced = tracedHandle(worker.handle, timeline);
    const held = guarded(once(control, 'message'), 'the held commit of eventSeq 5', HANG_GUARD_MS).then(message => { timeline.push('held'); return message; });
    /** Source time of the frame at 8,000 ms: the live state passed it while the commit is held. */
    const LIVE_PAST_NS = 1_008_000_000_000n;
    let live!: () => void, paused!: () => void;
    const livePast = new Promise<void>(resolve => { live = resolve; }), pausedStatus = new Promise<void>(resolve => { paused = resolve; });
    // The hold is released only once the live state passed 8,000 ms and the status reported the pause, so a live state
    // or status that waited for the held commit would end at the hang guard instead.
    const released = Promise.all([held, livePast, pausedStatus]).then(() => { timeline.push('release'); control.postMessage({type: 'release'}); });
    const s = serviceRuntime('t', traced.handle, tracedConnect(timeline), timeline, {onState: state => {
      const capture = state.observation?.capture.monotonicNs;
      if (capture === undefined || BigInt(capture) < LIVE_PAST_NS || timeline.includes('live 8000')) return;
      timeline.push('live 8000'); live();
    }, onStatus: next => { if (next.state === 'paused' && !timeline.includes('status paused')) { timeline.push('status paused'); paused(); } }});
    try {
      await startDurable(s.runtime, server.endpoint);
      expect(await held).toEqual([{type: 'held', eventSeq: '5'}]);
      await guarded(released, 'the live state and the paused status while the commit of eventSeq 5 is held', HANG_GUARD_MS);
      await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => timeline.includes('done commitEvent 8'), 'the last commit', HANG_GUARD_MS);
      // No commit after 4 completed before the release; the commit of 5 completed only after it.
      const at = (line: string) => timeline.indexOf(line);
      expect(timeline.slice(0, at('release')).filter(line => /^done commit(Event|Gap)/.test(line))).toEqual(['done commitEvent 1', 'done commitEvent 2', 'done commitEvent 3', 'done commitEvent 4']);
      expect(at('done commitEvent 5')).toBeGreaterThan(at('release'));
      expect(durableLogs(s.logs)).toEqual([]);
      await stopService(s, timeline, worker.exit);
      const storage = await reader('t').open(), session = sessionOf(input);
      expect(ok(storage.listEvents(session)).map(event => event.eventSeq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      storage.close();
      expect(existsSync(historyFile())).toBe(false);
    } finally { control.close(); await server.stop(); }
  }, 90_000);
});
