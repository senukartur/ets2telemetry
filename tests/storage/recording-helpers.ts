// Shared harness of the ET-015a recording tests under the Electron runtime: the real storage worker (or the test-only
// fault worker), StorageClient, TripRecorderSink and V1Ingestion against the reactive v1 simulator on actual Windows
// pipes, into a temporary synthetic-purpose database, and the labelled rows read back from that database. Barriers and
// waits are counted in commits, ACKs and connections; real-time bounds are liveness bounds only.
import net from 'node:net';
import {EventEmitter, once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {MessageChannel, Worker, type MessagePort} from 'node:worker_threads';
import {expect} from 'vitest';
import {FrameDecoder, decodePayload, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import type {TripSummaryView, TripView} from '../../packages/telemetry-core/src/index';
import {TripRecorderSink, type TripRecorderClient} from '../../apps/desktop/src/trip-recorder';
import {V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import type {ClientPolicy} from '../../tools/telemetry-simulator/src/v1/client';
import {reactiveConflicts, serveV1Reactive, type ReactiveReport, type ReactiveServeOptions} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {validateScenario} from '../../tools/telemetry-simulator/src/v1/scenario';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {SIMULATOR_V1_DIR} from '../shared/simulator-v1-expected';
import type {Storage} from '../../packages/storage/src/index';
import {ok, readOnly, TEST_CLOSE_GRACE_MS} from './helpers';

const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if (!bundles) throw new Error('Storage test bundles are missing; run npm run test:storage.');
export const WORKER = path.join(bundles, 'storage-worker.cjs');
export const FAULT_WORKER = path.join(bundles, 'fault-storage-worker.cjs');
export const RECORDING_FIXTURES = path.resolve('tests/fixtures/recording');
type Json = Record<string, unknown>;
/** Storage workers of every run that have not exited yet. */
const live = new Set<Worker>();
/** Terminates the workers a failed case left running, so the temporary database can be removed (afterEach). */
export async function terminateWorkers(): Promise<void> { await Promise.all([...live].map(worker => worker.terminate())); live.clear(); }

/**
 * A scenario fixture with its transport replaced, for a reconnection the scripted corpus does not have, and optional
 * source steps appended after its last step.
 */
export function withTransport(input: Json, id: string, transport: Json[], steps: Json[] = []): Json {
  const copy = structuredClone(input) as Json & {steps: Json[]};
  return {...copy, id, transport, steps: [...copy.steps, ...steps]};
}

/** Seeded identifiers and trip UUIDs as labels: `trip@<eventSeq of the job configuration>` (T4 with node:crypto). */
export function labels(seed: string): Map<string, string> {
  const map = new Map<string, string>(), session = seededId(seed, 'plugin-session');
  for (const label of ['plugin-session', 'process-instance', 'capture-clock']) map.set(seededId(seed, label), label);
  for (let n = 0; n < 20; n++) map.set(seededId(seed, `game-clock-${n}`), `game-clock-${n}`);
  for (let seq = 1; seq <= 200; seq++) {
    const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${seq}`, 'utf8').digest('hex');
    map.set(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`, `trip@${seq}`);
  }
  return map;
}
const key = (value: string | null) => value === null ? undefined : value.replace(/^0+(?=.)/, '');

/**
 * The stored trips (through the read API, in the shape of the hand-written `<id>.trip.expected.json` rows), attributions
 * and completeness intervals in insertion order, with labels for seeded identifiers. The database must be closed.
 */
export interface StoredRows {trips: unknown[]; attributions: unknown[]; intervals: unknown[]}
export async function storedRows(ws: {open(): Promise<Storage>; database: string}, seed: string): Promise<StoredRows> {
  const reader = await ws.open();
  const trips = ok(reader.listTrips()).trips.map(t => ({trip: t.tripUuid, jobConfigurationEventSeq: t.jobConfigurationEventSeq, truckConfigurationEventSeq: t.truckConfigurationEventSeq,
    trailerConfigurationEventSeqs: t.trailerConfigurationEventSeqs, openedEventSeq: t.openedEventSeq, gameMode: t.gameMode, gameModeAmbiguous: t.gameModeAmbiguous,
    outcome: t.outcome, outcomeEventSeq: t.outcomeEventSeq, closeReason: t.closeReason, recordingCompleteness: t.recordingCompleteness, startedUtcMs: t.startedUtcMs,
    endedUtcMs: t.endedUtcMs, observedDistanceM: t.observedDistanceM}));
  reader.close();
  const rows = readOnly(ws.database, db => ({
    attributions: db.prepare(`SELECT e.event_seq AS eventSeq, t.trip_uuid AS trip, a.attribution FROM event_attributions a JOIN events e ON e.id = a.event_ref
      LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.event_seq`).all() as {eventSeq: string; trip: string | null; attribution: string}[],
    intervals: db.prepare(`SELECT t.trip_uuid AS trip, c.kind, c.start_utc_ms AS startUtcMs, c.end_utc_ms AS endUtcMs, c.start_monotonic_ns AS startMonotonicNs,
      c.end_monotonic_ns AS endMonotonicNs, k.clock_uuid AS sourceClockId, c.first_event_seq AS firstEventSeq, c.last_event_seq AS lastEventSeq, c.detail_json AS detail
      FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref LEFT JOIN clocks k ON k.id = c.source_clock_ref ORDER BY c.id`).all() as Record<string, string | number | null>[]
  }));
  const out = {
    trips,
    attributions: rows.attributions.map(a => ({eventSeq: key(a.eventSeq), trip: a.trip, attribution: a.attribution})),
    intervals: rows.intervals.map(i => {
      const row: Record<string, unknown> = {trip: i.trip, kind: i.kind};
      for (const name of ['startUtcMs', 'endUtcMs'] as const) if (i[name] !== null) row[name] = Number(i[name]);
      for (const name of ['startMonotonicNs', 'endMonotonicNs', 'firstEventSeq', 'lastEventSeq'] as const) if (i[name] !== null) row[name] = key(String(i[name]));
      if (i.sourceClockId !== null) row.sourceClockId = i.sourceClockId;
      if (i.detail !== null) row.detail = JSON.parse(String(i.detail));
      return row;
    })
  };
  const map = labels(seed);
  return JSON.parse(JSON.stringify(out), (_key, v: unknown) => typeof v === 'string' && map.has(v) ? map.get(v) : v) as StoredRows;
}

/** The recorder's trip view in the shape of the `view` block of a `<id>.trip.expected.json`, with labels. */
export function viewSummary(view: TripView, seed: string): unknown {
  const trip = (v: TripSummaryView | null) => v === null ? null : {trip: v.tripUuid, recordingCompleteness: v.recordingCompleteness, observedDistanceM: v.observedDistanceM,
    fuelUsedL: v.fuelUsedL, refuelledL: v.refuelledL, refuels: v.refuels};
  const out = {phase: view.phase, untrackedJob: view.untrackedJob, current: trip(view.current),
    lastClosed: view.lastClosed === null ? null : {...trip(view.lastClosed), outcome: view.lastClosed.outcome, closeReason: view.lastClosed.closeReason}};
  const map = labels(seed);
  return JSON.parse(JSON.stringify(out), (_key, v: unknown) => typeof v === 'string' && map.has(v) ? map.get(v) : v) as unknown;
}

/** A hand-written `<id>.trip.expected.json` of the simulator corpus, or a `tests/fixtures/recording/<id>.rows.expected.json`. */
export interface RowsExpected {scenario: string; authoredFrom: string[]; trips: unknown[]; attributions: unknown[]; intervals: unknown[]; coverage: {committedThroughEventSeq: string} & Record<string, unknown>; view?: unknown}
export const tripExpected = (id: string) => JSON.parse(readFileSync(path.join(SIMULATOR_V1_DIR, `${id}.trip.expected.json`), 'utf8')) as RowsExpected;
export const recordingExpected = (id: string) => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, `${id}.rows.expected.json`), 'utf8')) as RowsExpected;

/** Commit statuses and coverage the recorder's storage reported, counted at the storage client. */
export interface CommitTally {committed: number; duplicate: number; covered: number; conflict: number; coverage: bigint}
/** One telemetry-service instance: its own (fault) worker on the shared database file, its recorder and its ingestion. */
export interface Service {
  ingestion: V1Ingestion; recorder: TripRecorderSink; client: StorageClient; worker: Worker; exit: Promise<number>;
  states: V1SourceState[]; logs: [string, unknown][]; control?: MessagePort;
}
export interface RecordingPlan {
  /** workerData for the fault worker of the first service (R13); without it the production worker entry runs. */
  fault?: Record<string, unknown>;
  /** The coverage-item bound of the first service only; a restarted service has the production bound (256). */
  maxPendingCommits?: number;
  /** After the connection with this 0-based index closes, the service stops and a new one cold-starts on the same file. */
  restartAfter?: number[];
  serve?: ReactiveServeOptions;
  /** Runs after a stopped service released the database and before the next one opens it. */
  between?: () => Promise<void>;
  /** Called after every state change of a service, for tests that react to a status (for example a release). */
  onState?: (state: V1SourceState, service: Service, mark: (label: string) => void) => void;
  /**
   * Holds back the first connection's stream after the server frame of the event with this eventSeq until `until`
   * resolves (see ClientSocket), so that a storage state, such as a held commit, is reached before later items arrive.
   */
  gate?: {afterEventSeq: string; until: (service: Service) => Promise<unknown>};
}
export interface RecordingRun {
  report: ReactiveReport; services: Service[]; tally: CommitTally;
  /** Every ACK written to a pipe with the storage coverage the recorder had reported when it was written. */
  acks: {connection: number; through: bigint; coverage: bigint}[];
  /** ACKs written to each connection, as the server received them (lost ACKs excluded). */
  served: (connection: number) => string[];
  /** ACK writes (`ack <connection> <through>`) and the labels tests mark from `onState`, in order. */
  timeline: string[];
}

/**
 * The client socket the ingestion and the harness see: the connect, data, end, error and close events of the real pipe
 * socket, passed on synchronously and in their order. With a gate, the server bytes are passed on one whole frame at a
 * time up to the frame of the gate's event; everything after it (the rest of the stream, end, error and close) waits in
 * order until the gate's promise resolves, then follows at once. Re-cutting a byte stream at frame boundaries is
 * invisible to a consumer that decodes it, and nothing is reordered, dropped or added.
 */
class ClientSocket extends EventEmitter {
  private partial = Buffer.alloc(0);
  private waiting?: [string, unknown[]][];
  constructor(private readonly real: net.Socket, private gate: {afterEventSeq: string; until: () => Promise<unknown>} | undefined, private readonly fail: (error: unknown) => void) {
    super();
    real.on('connect', () => this.pass('connect'));
    real.on('data', (chunk: Buffer) => { if (this.gate) this.frames(chunk); else this.pass('data', chunk); });
    real.on('end', () => {
      if (this.partial.length) { this.pass('data', this.partial); this.partial = Buffer.alloc(0); }
      this.pass('end');
    });
    real.on('error', (error: Error) => this.pass('error', error));
    real.on('close', (hadError: boolean) => this.pass('close', hadError));
  }
  write(bytes: Uint8Array, ...rest: unknown[]): boolean { return (this.real.write.bind(this.real) as (...args: unknown[]) => boolean)(bytes, ...rest); }
  destroy(): void { this.real.destroy(); }
  private pass(event: string, ...args: unknown[]): void {
    if (this.waiting) this.waiting.push([event, args]); else this.emit(event, ...args);
  }
  /** Passes whole frames until the gate's event has been passed; the rest waits behind the gate. */
  private frames(chunk: Buffer): void {
    let bytes = Buffer.concat([this.partial, chunk]);
    while (this.gate && bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
      const frame = bytes.subarray(0, 4 + bytes.readUInt32LE(0)); bytes = bytes.subarray(frame.length);
      this.pass('data', frame);
      let message: ReturnType<typeof decodePayload> | undefined;
      // An invalid frame is the ingestion's own decoder's to report.
      try { message = decodePayload(frame.subarray(4), 'server'); } catch { message = undefined; }
      if (message?.kind === 'event' && message.data.eventSeq === this.gate.afterEventSeq) this.hold(this.gate.until);
    }
    if (this.gate) this.partial = bytes;
    else if (bytes.length) this.pass('data', bytes);
  }
  private hold(until: () => Promise<unknown>): void {
    this.gate = undefined;
    const waiting: [string, unknown[]][] = this.waiting = [];
    until().then(() => {
      // Events passed while these are emitted queue behind them.
      for (let next = waiting.shift(); next; next = waiting.shift()) this.emit(next[0], ...next[1]);
      this.waiting = undefined;
    }, this.fail);
  }
}

/** Every pending ACK the policy of a scripted connection loses on the way to the pipe, as in the replay. */
function acksLost(policy: ClientPolicy, sent: number): boolean {
  return policy.ack.kind === 'withhold' || (policy.ack.kind === 'dropAfter' && sent >= policy.ack.count);
}

/**
 * Runs one scenario against the recorder. The scripted client policies are applied around the production consumer, as
 * in tests/unit/v1-ingestion-pipe.test.ts: lost ACKs are dropped on the way to the pipe, and a connection whose
 * client never commits (`none`) holds each commit command until the connection is gone, then fails it as retryable.
 */
export async function runRecording(input: Json, database: {path: string; backups: string}, plan: RecordingPlan = {}): Promise<RecordingRun> {
  expect(reactiveConflicts(input)).toEqual([]);
  const scenario = validateScenario(input), policies = scenario.transport.flatMap(t => t.action === 'connect' ? [t.client] : []);
  const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true, ...plan.serve});
  const timeline: string[] = [], services: Service[] = [], tally: CommitTally = {committed: 0, duplicate: 0, covered: 0, conflict: 0, coverage: 0n}, acks: RecordingRun['acks'] = [];
  const closed: Promise<void>[] = [];
  let connection = -1, finished!: () => void, gate = plan.gate;
  const allClosed = new Promise<void>(r => { finished = r; });
  let fail!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; }), background: Promise<unknown>[] = [];
  failed.catch(() => undefined);
  const track = (work: Promise<unknown>) => { background.push(work.catch(error => fail(error))); };
  const connect = (endpoint: string) => {
    // Only the first connection's stream is gated; `until` receives the service that owns it.
    const gated = gate; gate = undefined;
    const socket = new ClientSocket(net.connect(endpoint), gated && {afterEventSeq: gated.afterEventSeq, until: () => gated.until(services.at(-1)!)}, error => fail(error));
    const write = socket.write.bind(socket), decoder = new FrameDecoder('server');
    let index: number | undefined, sent = 0;
    // Registered before the ingestion's listeners: a welcome is numbered before the ingestion applies it.
    socket.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk, m => {
          if (m.kind !== 'welcome' || index !== undefined) return;
          const own = index = ++connection;
          let gone!: () => void; closed[own] = new Promise<void>(r => { gone = r; });
          socket.once('close', () => {
            gone();
            if (own === policies.length - 1) { track(services.at(-1)!.ingestion.stop()); finished(); }
            else if (plan.restartAfter?.includes(own)) {
              const old = services.at(-1)!;
              // Selecting no source cancels the pending reconnection at once; the old service stops once its queued work
              // settled, then the next service opens the file after the old worker released its exclusive lock.
              old.ingestion.select('game');
              track(old.ingestion.stop().then(() => old.client.close()).then(() => plan.between?.()).then(() => start()));
            }
          });
        });
      } catch { /* the ingestion's own decoder reports the violation */ }
    });
    socket.write = ((bytes: Uint8Array, ...rest: unknown[]) => {
      const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage;
      if (m.kind === 'ack' && index !== undefined) {
        acks.push({connection: index, through: BigInt(m.data.throughEventSeq), coverage: tally.coverage}); timeline.push(`ack ${index} ${m.data.throughEventSeq}`);
        if (acksLost(policies[index], sent++)) return true;
      }
      return write(bytes, ...rest);
    });
    return socket;
  };
  const start = async (): Promise<void> => {
    const first = services.length === 0, channel = plan.fault && first ? new MessageChannel() : undefined;
    const worker = channel ? new Worker(FAULT_WORKER, {workerData: {kind: 'storage', ...plan.fault, control: channel.port2}, transferList: [channel.port2]})
      : new Worker(WORKER, {workerData: {kind: 'storage'}});
    live.add(worker); void once(worker, 'exit').then(() => live.delete(worker));
    const exit = once(worker, 'exit').then(([code]) => code as number), client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: database.path, purpose: 'synthetic', backupsDirectory: database.backups, appVersion: '0.1.0-test'}));
    const counted = async (command: ReturnType<StorageClient['commitEvent']>) => {
      const result = await command;
      if (result.ok) { tally[result.value.status]++; const through = BigInt(result.value.committedThroughEventSeq); if (through > tally.coverage) tally.coverage = through; }
      return result;
    };
    // A scripted client that never commits: hold the command until its connection is gone, then fail it as retryable.
    const scripted = async (commit: () => ReturnType<StorageClient['commitEvent']>) => {
      const own = connection;
      if (own >= 0 && policies[own].commit.kind === 'none') { await closed[own]; return {ok: false as const, error: storageError('DISK_FULL')}; }
      return counted(commit());
    };
    const storage: TripRecorderClient = {
      upsertSession: input => client.upsertSession(input), committedThrough: session => client.committedThrough(session),
      commitEvent: input => scripted(() => client.commitEvent(input)), commitGap: input => scripted(() => client.commitGap(input)),
      recordCompleteness: (session, interval, options) => client.recordCompleteness(session, interval, options),
      listTrips: page => client.listTrips(page), getEvent: (session, eventSeq) => client.getEvent(session, eventSeq), listEvents: (session, page) => client.listEvents(session, page)
    };
    const recorder = new TripRecorderSink(storage), states: V1SourceState[] = [], logs: [string, unknown][] = [];
    const service: Service = {ingestion: undefined as unknown as V1Ingestion, recorder, client, worker, exit, states, logs, control: channel?.port1};
    service.ingestion = new V1Ingestion({connect, sink: recorder, maxPendingCommits: first ? plan.maxPendingCommits : undefined, diagnose: (event, facts) => logs.push([event, facts]),
      onState: s => { states.push(s); try { plan.onState?.(s, service, label => timeline.push(label)); } catch (error) { fail(error); } }});
    services.push(service);
    service.ingestion.select('synthetic', server.endpoint);
  };
  try {
    await start();
    const report = await Promise.race([server.done, failed]);
    await Promise.race([allClosed, failed]);
    await Promise.all(background);
    // A failure of tracked work that settled after the races above still fails the run.
    await Promise.race([failed, Promise.resolve()]);
    for (const service of services) await service.ingestion.stop();
    const served = (index: number) => report.transcript.filter(l => l.connection === index + 1 && l.direction === 'client' && l.message.kind === 'ack')
      .map(l => (l.message as Extract<ClientMessage, {kind: 'ack'}>).data.throughEventSeq);
    return {report, services, tally, acks, served, timeline};
  } catch (error) {
    // A failed run reconnects nowhere afterwards; its workers are terminated by terminateWorkers() in afterEach.
    for (const service of services) await service.ingestion.stopSource().catch(() => undefined);
    throw error;
  } finally { await server.stop(); }
}

/** The replay of a scenario, for `reactiveDifferences`. */
export const replayOf = (input: Json) => replayV1(input);
