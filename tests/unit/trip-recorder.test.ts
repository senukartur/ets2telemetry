// The trip recorder in the protocol v1 ingestion pipeline (ET-015a PR-2; R2, R5-R9): V1Ingestion with fake sockets and
// fake timers, DurableDelivery and TripRecorderSink, over an async adapter of the first-insert storage model in
// tests/shared/trip-replay.ts, which throws on any storage-rule violation. Messages are built from the shared protocol
// v1 fixtures by tests/shared/trip-messages.ts. Expected effects and rows are written by hand from docs/trips.md,
// docs/storage.md and the decisions R1-R17 (concept.md); none is read back from the code under test (REG-001,
// REG-003, REG-004, REG-006, REG-007, REG-011). Real commits through the storage worker are in tests/storage.
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {decodePayload, encodeFrame, type ClientMessage, type ServerMessage, type SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import type {
  CommitResult, CompletenessInterval, CompletenessOptions, EventRow, Result, SampleAppendOptions, SampleAppendResult, SampleInput, StorageErrorCode, TripEffect, TripList, TripPage,
  TripRecord
} from '../../packages/storage/src/api';
import {storageError} from '../../packages/storage/src/errors';
import {canonicalJson} from '../../packages/telemetry-core/src/index';
import type {CoverageMessage, DurableSink, WelcomeMessage} from '../../apps/desktop/src/durable-sink';
import type {TelemetrySocket} from '../../apps/desktop/src/native-pipe-client';
import {RECORDER_FAILURE_CLASS, TripRecorderSink, type TripRecorderClient} from '../../apps/desktop/src/trip-recorder';
import {V1Ingestion, type V1IngestionOptions, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {failureClass} from '../../apps/desktop/src/durable-sink';
import {BASE_UTC, ETS2_A, RECEIVED_UTC, Script, r} from '../shared/trip-messages';
import {TripStorageModel} from '../shared/trip-replay';

const ENDPOINT = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-1-00000000-0000-4000-8000-000000000000';
/** The T4 trip UUID, written independently of the reducer with node:crypto. */
const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ok: true, value});
/** The source second of a capture time, floor(ns / 1e9) (H3). */
const second = (ns: string) => (BigInt(ns) / 1_000_000_000n).toString();
const UNKNOWN_MODE = {mode: 'unknown', method: 'none', confidence: 'none'} as const;

class FakeSocket extends EventEmitter implements TelemetrySocket {
  readonly sent: ClientMessage[] = []; destroyed = false; authority?: SourceIdentity; completion?: Promise<void>;
  write(bytes: Uint8Array) { this.sent.push(decodePayload(bytes.subarray(4), 'client') as ClientMessage); }
  destroy() { this.destroyed = true; }
  /** Each message arrives in its own read, as the broker relays one frame per credit. */
  feed(...messages: ServerMessage[]) { for (const m of messages) this.emit('data', encodeFrame(m)); }
  get hello() { const h = this.sent[0]; if (h?.kind !== 'hello') throw new Error('hello expected'); return h.data; }
  get acks() { return this.sent.flatMap(m => m.kind === 'ack' ? [m.data.throughEventSeq] : []); }
}

/**
 * The recorder's storage: an async adapter over TripStorageModel (coverage, first-insert effects, every trip rule) that
 * keeps the committed event rows for the cold-start reads and the session-level intervals of recordCompleteness, with
 * storage's `ifAbsent` comparison (trip reference, kind, first and last eventSeq, canonical detail). Commits can be held
 * or scripted to fail; every attempt is logged with its effects before the outcome.
 */
class ModelStorage implements TripRecorderClient {
  readonly model = new TripStorageModel();
  readonly attempts: {eventSeq: string; effects: TripEffect[]}[] = [];
  readonly violations: string[] = [];
  readonly intervals: {pluginSessionId: string; interval: CompletenessInterval}[] = [];
  /** Scripted failures of the next commits of an item, keyed by its last eventSeq. */
  readonly failures = new Map<string, StorageErrorCode[]>();
  /** Hold the first commit of the item ending at this eventSeq until `release`. */
  holdAt?: string;
  /** ET-015b: scripted failures of the next appendSamples calls, and every sample write in order (`samples <seconds>` or `loss <count>`). */
  readonly sampleFailures: StorageErrorCode[] = [];
  /** Scripted failures of the next `sample-loss` recordCompleteness calls (review pass 1). */
  readonly lossFailures: StorageErrorCode[] = [];
  readonly sampleWrites: string[] = [];
  readonly sampleOptions: unknown[] = [];
  private readonly held: (() => void)[] = [];
  private readonly rows = new Map<string, EventRow[]>();
  get holding(): number { return this.held.length; }
  release(): void { this.held.shift()?.(); }
  upsertSession(input: {message: unknown}) {
    const welcome = input.message as WelcomeMessage;
    this.model.openSession(welcome.source.pluginSessionId, welcome.source.game);
    return ok({created: !this.rows.has(welcome.source.pluginSessionId), committedThroughEventSeq: this.model.committedThrough(welcome.source.pluginSessionId)});
  }
  appendSamples(pluginSessionId: string, rows: SampleInput[], options?: SampleAppendOptions): Promise<Result<SampleAppendResult>> {
    this.sampleOptions.push(options);
    const failure = this.sampleFailures.shift();
    if (failure) return Promise.resolve({ok: false, error: storageError(failure)});
    const value = this.model.appendSamples(pluginSessionId, rows, options);
    this.sampleWrites.push(`samples ${rows.map(row => second(row.monotonicNs)).join(',')}`);
    return ok(value);
  }
  committedThrough(pluginSessionId: string) { return ok(this.model.committedThrough(pluginSessionId)); }
  commitEvent(input: {message: unknown; effects?: TripEffect[]}) { return this.commit(input.message as CoverageMessage, input.effects); }
  commitGap(input: {message: unknown; effects?: TripEffect[]}) { return this.commit(input.message as CoverageMessage, input.effects); }
  private async commit(m: CoverageMessage, effects: TripEffect[] = []): Promise<Result<CommitResult>> {
    const session = m.source.pluginSessionId, last = m.kind === 'event' ? m.data.eventSeq : m.data.lastEventSeq;
    this.attempts.push({eventSeq: last, effects: structuredClone(effects)});
    if (this.holdAt === last) { this.holdAt = undefined; await new Promise<void>(resolve => this.held.push(resolve)); }
    const failure = this.failures.get(last)?.shift();
    if (failure) return {ok: false, error: storageError(failure)};
    const before = this.model.committedThrough(session);
    try {
      const status = m.kind === 'event' ? this.model.commitEvent(m, effects) : this.model.commitGap(m, effects);
      if (m.kind === 'event' && status === 'committed') {
        const rows = this.rows.get(session) ?? [];
        rows.push({eventSeq: m.data.eventSeq, type: m.data.record.type, occurred: m.data.occurred, record: m.data.record, firstRedelivered: m.data.redelivered, protocolMinor: 0, committedUtcMs: 0});
        this.rows.set(session, rows);
      }
      return {ok: true, value: {status, committedThroughEventSeq: this.model.committedThrough(session), ...(m.kind === 'gap' ? {previouslyCoveredThrough: before} : {})}};
    } catch (error) { this.violations.push(String(error)); throw error; }
  }
  recordCompleteness(pluginSessionId: string, interval: CompletenessInterval, options?: CompletenessOptions): Promise<Result<undefined>> {
    const lossFailure = interval.kind === 'sample-loss' ? this.lossFailures.shift() : undefined;
    if (lossFailure) return Promise.resolve({ok: false, error: storageError(lossFailure)});
    const same = (a: CompletenessInterval) => (a.tripUuid ?? null) === (interval.tripUuid ?? null) && a.kind === interval.kind && a.firstEventSeq === interval.firstEventSeq &&
      a.lastEventSeq === interval.lastEventSeq && canonicalJson(a.detail ?? null) === canonicalJson(interval.detail ?? null);
    if (!(options?.ifAbsent && this.intervals.some(i => i.pluginSessionId === pluginSessionId && same(i.interval)))) this.intervals.push({pluginSessionId, interval: structuredClone(interval)});
    if (interval.kind === 'sample-loss') this.sampleWrites.push(`loss ${String(interval.detail?.count)}`);
    return ok(undefined);
  }
  listTrips(page: TripPage = {}): Promise<Result<TripList>> {
    const trips = this.model.trips.filter(t => (page.game === undefined || t.game === page.game) && (page.outcome === undefined || t.outcome === page.outcome))
      .map(t => ({...structuredClone(t), createdUtcMs: 0, updatedUtcMs: 0}) as TripRecord);
    return ok({trips, nextCursor: null});
  }
  getEvent(pluginSessionId: string, eventSeq: string) { return ok(this.rows.get(pluginSessionId)?.find(row => row.eventSeq === eventSeq)); }
  listEvents(pluginSessionId: string, page: {afterEventSeq?: string; limit?: number} = {}) {
    const after = BigInt(page.afterEventSeq ?? '0');
    return ok((this.rows.get(pluginSessionId) ?? []).filter(row => BigInt(row.eventSeq) > after).slice(0, page.limit ?? 500));
  }
}

let clock: {ms: number; ns: bigint; utc: number};
let sockets: FakeSocket[];
let logs: [string, unknown][];
let states: V1SourceState[];
let ingestion: V1Ingestion | undefined;
beforeEach(() => { vi.useFakeTimers(); clock = {ms: 0, ns: 2_000_000_000_000n, utc: 1_850_000_000_000}; sockets = []; logs = []; states = []; });
afterEach(async () => { await ingestion?.stop(); ingestion = undefined; vi.useRealTimers(); });
/** One service lifetime: a new recorder over `storage` (or the given sink) and a new ingestion of the synthetic endpoint. */
function start(storage: ModelStorage, sink?: DurableSink, options: V1IngestionOptions = {}) {
  const recorder = new TripRecorderSink(storage);
  ingestion = new V1Ingestion({now: () => clock.ms, nowNs: () => clock.ns, utcNow: () => clock.utc, connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    sink: sink ?? recorder, diagnose: (event, facts) => logs.push([event, facts]), onState: s => states.push(s), ...options});
  ingestion.select('synthetic', ENDPOINT);
  return recorder;
}
/** Ends a service lifetime the way the service does: the source, then the storage-commit pipeline. */
async function stopLifetime() { await ingestion!.stop(); ingestion = undefined; }
const latest = () => sockets.at(-1)!;
const connectLatest = () => latest().emit('connect');
const advance = (ms: number) => { clock.ms += ms; return vi.advanceTimersByTimeAsync(ms); };
const settle = () => vi.advanceTimersByTimeAsync(0);
const state = () => ingestion!.current;

describe('ET-015a trip recorder in the v1 ingestion pipeline', () => {
  it('classifies every recorder code as unavailable (R7)', () => {
    expect(RECORDER_FAILURE_CLASS).toEqual({TRIP_ORDER_VIOLATION: 'unavailable', TRIP_COVERAGE_MISMATCH: 'unavailable', TRIP_UNKNOWN_SESSION: 'unavailable'});
    for (const code of ['TRIP_ORDER_VIOLATION', 'TRIP_COVERAGE_MISMATCH', 'TRIP_UNKNOWN_SESSION'] as const) expect(failureClass({code})).toBe('unavailable');
    expect(failureClass({code: 'DISK_FULL'})).toBe('retryable');
  });

  it('U1: commits trip.open with job.configured and adopts the trip only after the commit (REG-001, REG-006)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '1';
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '1');
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.jobConfigured()));
    await settle();
    // The commit is in flight: nothing is adopted or acknowledged yet (T3).
    expect([storage.holding, recorder.view('ets2').phase, latest().acks]).toEqual([1, 'idle', []]);
    // The session starts at coverage 0, so it is loading (T12): the trip opens partial with an opened-at-load cause.
    expect(storage.attempts).toEqual([{eventSeq: '1', effects: [
      {kind: 'trip.open', tripUuid: trip, game: 'ets2', gameMode: UNKNOWN_MODE, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: BASE_UTC + 1_000},
      {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'discontinuity', detail: {cause: 'opened-at-load', atEventSeq: '1'}}}]}]);
    storage.release(); await settle();
    expect(recorder.view('ets2')).toMatchObject({phase: 'active', current: {tripUuid: trip, recordingCompleteness: 'partial', startedUtcMs: BASE_UTC + 1_000}});
    expect(latest().acks).toEqual(['1']);
    expect(storage.model.trips.map(t => [t.tripUuid, t.outcome, t.openedEventSeq, t.recordingCompleteness])).toEqual([[trip, 'open', '1', 'partial']]);
    expect(storage.violations).toEqual([]);
  });

  it('U2: keeps the state after a retryable failure, so the redelivered item carries the same effects (REG-006, REG-007)', async () => {
    const storage = new ModelStorage(); storage.failures.set('1', ['DISK_FULL']);
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '1');
    latest().feed(s.welcome(), s.checkpoint(null));
    const job = s.event(r.jobConfigured());
    latest().feed(job);
    await settle();
    expect([latest().destroyed, latest().acks, recorder.view('ets2').phase, state().durable]).toEqual([true, [], 'idle', {state: 'pending', retryCode: 'DISK_FULL'}]);
    expect(logs).toContainEqual(['V1_DURABLE_RETRY', {code: 'DISK_FULL', count: 1}]);
    // The producer redelivers eventSeq 1 on the next connection (A = 0).
    await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(true);
    latest().feed(s.welcome(), s.checkpoint(null, 1), s.redeliver(job));
    await settle();
    const opened: TripEffect[] = [
      {kind: 'trip.open', tripUuid: trip, game: 'ets2', gameMode: UNKNOWN_MODE, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: BASE_UTC + 1_000},
      {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'discontinuity', detail: {cause: 'opened-at-load', atEventSeq: '1'}}}];
    // The same trip.open again, from the kept state. The redelivered configuration lies before the new checkpoint's
    // nextEventSeq (2), so it is replayed from the producer's retention and also gets an opened-before-attach cause
    // (docs/trips.md, "Replayed events"): the consumer has no readings from before it attached.
    expect(storage.attempts).toEqual([{eventSeq: '1', effects: opened}, {eventSeq: '1', effects: [...opened,
      {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', detail: {cause: 'opened-before-attach', atEventSeq: '1'}}}]}]);
    expect([latest().acks, recorder.view('ets2').phase]).toEqual([['1'], 'active']);

    // A failure after the trip opened: the redelivery is stepped from the kept state and adds only the reconnection's
    // not-connected interval, queued at the session input and committed with the next carrier (the trip is already partial).
    storage.failures.set('2', ['DISK_FULL']);
    const started = s.event(r.started());
    latest().feed(started); await settle();
    expect(latest().destroyed).toBe(true);
    await advance(250); connectLatest();
    const reconnect = s.welcome();
    latest().feed(reconnect, s.checkpoint(null, 1), s.redeliver(started));
    await settle();
    expect(storage.attempts.slice(2)).toEqual([{eventSeq: '2', effects: []}, {eventSeq: '2', effects: [{kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected',
      // From the last committed item (eventSeq 1, label BASE + 1 s, source time 1,000,999,000,000 ns) to the reconnection's welcome.
      startUtcMs: BASE_UTC + 1_000, startMonotonicNs: '1000999000000', endMonotonicNs: reconnect.capture.monotonicNs, sourceClockId: s.clockId,
      // Both checkpoints report the same truck and odometer, so the change across the hole is 0 m (T16).
      detail: {cause: 'disconnected', odometerDeltaM: 0}}}]}]);
    expect(reconnect.capture.monotonicNs).toBe('1002000000000');
    expect([latest().acks, storage.model.committedThrough(ETS2_A), storage.violations]).toEqual([['2'], '2', []]);
  });

  it('U3: applies readings in stream order behind a commit in flight (T16, REG-001)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '1';
    start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '1');
    const odometer = (value: number) => ({odometer: {available: true as const, value, unit: 'm' as const}});
    latest().feed(s.welcome(), s.checkpoint(null, 0, odometer(1_000)), s.event(r.jobConfigured()));
    // Both snapshots arrive while job.configured is in flight; they reach the recorder only after its commit.
    latest().feed(s.snapshot(odometer(1_100), 2_000), s.snapshot(odometer(1_250), 2_000), s.event(r.delivered()));
    await settle(); expect(storage.holding).toBe(1);
    storage.release(); await settle();
    // The opening step (1,000 -> 1,100) began before the trip opened, so only 1,100 -> 1,250 counts: 150 m.
    expect(storage.attempts[1]).toEqual({eventSeq: '2', effects: [
      {kind: 'event.attribute', tripUuid: trip, attribution: 'trip'},
      {kind: 'trip.update', tripUuid: trip, set: {observedDistanceM: {available: true, value: 150}}},
      {kind: 'trip.close', tripUuid: trip, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 6_000}]});
    expect(storage.model.trips.map(t => [t.outcome, t.observedDistanceM])).toEqual([['delivered', {available: true, value: 150}]]);
    expect([latest().acks, storage.violations]).toEqual([['1', '2'], []]);
  });

  it('U4: steps the disconnection at the next session open, so a reconnection marks the trip partial (R6, REG-003)', async () => {
    const storage = new ModelStorage();
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    // The start comes first, so the job opens while running and outside a load: the trip is not partial yet.
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.jobConfigured()));
    await settle();
    expect(recorder.view('ets2').current?.recordingCompleteness).toBe('unknown');
    latest().emit('end');
    await advance(250); connectLatest();
    const reconnect = s.welcome();
    latest().feed(reconnect, s.checkpoint(null), s.event(r.paused(), {simulation: 'paused'}));
    await settle();
    expect(storage.attempts.at(-1)).toEqual({eventSeq: '3', effects: [
      {kind: 'trip.update', tripUuid: trip, set: {recordingCompleteness: 'partial'}},
      // From the last item before the disconnection (eventSeq 2: label BASE + 2 s, source time 1,001,999,000,000 ns).
      {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: BASE_UTC + 2_000, startMonotonicNs: '1001999000000',
        endMonotonicNs: reconnect.capture.monotonicNs, sourceClockId: s.clockId, detail: {cause: 'disconnected', odometerDeltaM: 0}}}]});
    expect([latest().acks, recorder.view('ets2').current?.recordingCompleteness, storage.violations]).toEqual([['3'], 'partial', []]);
  });

  it('U5: resumes a stored open trip at a cold start, awaiting its outcome after a clear (R4, R15, REG-006, REG-004)', async () => {
    const storage = new ModelStorage(), s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    start(storage); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.jobConfigured()), s.event(r.jobCleared()));
    await settle(); expect(latest().acks).toEqual(['1', '2', '3']);
    await stopLifetime();
    // A new service lifetime: the recorder knows nothing and reads the stored open trip as a seed.
    const recorder = start(storage); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.fined()), s.event(r.delivered()));
    await settle();
    expect(storage.attempts.slice(3)).toEqual([
      // The seed resumes partial with consumer-restart; the fine after the clear is free driving (awaiting the outcome).
      {eventSeq: '4', effects: [{kind: 'trip.update', tripUuid: trip, set: {recordingCompleteness: 'partial'}},
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', detail: {cause: 'consumer-restart'}}},
        {kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'}]},
      {eventSeq: '5', effects: [{kind: 'event.attribute', tripUuid: trip, attribution: 'trip'},
        {kind: 'trip.close', tripUuid: trip, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 5_000}]}]);
    expect(storage.model.trips.map(t => [t.tripUuid, t.outcome, t.outcomeEventSeq, t.recordingCompleteness, t.startedUtcMs])).toEqual([[trip, 'delivered', '5', 'partial', BASE_UTC + 2_000]]);
    expect([latest().acks, recorder.view('ets2').lastClosed?.outcome, storage.violations]).toEqual([['4', '5'], 'delivered', []]);
  });

  /** Storage whose gap commits report `committed` with a wrong or missing `previouslyCoveredThrough`. */
  class GapStorage extends ModelStorage {
    constructor(private readonly previous: string | undefined) { super(); }
    override async commitGap(input: {message: unknown; effects?: TripEffect[]}): Promise<Result<CommitResult>> {
      const result = await super.commitGap(input);
      if (!result.ok) return result;
      const {previouslyCoveredThrough: _stored, ...rest} = result.value;
      void _stored;
      return {ok: true, value: this.previous === undefined ? rest : {...rest, previouslyCoveredThrough: this.previous}};
    }
  }
  for (const [name, previous] of [['a different', '0'], ['a missing', undefined]] as const) it(`R7: fails closed on a gap result with ${name} previouslyCoveredThrough and adopts nothing`, async () => {
    const storage = new GapStorage(previous), trip = uuid(ETS2_A, '2');
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.jobConfigured()));
    await settle();
    expect(latest().acks).toEqual(['1', '2']);
    const before = recorder.view('ets2');
    expect(before).toMatchObject({phase: 'active', current: {tripUuid: trip}});
    // The coverage read before the gap is 2; the gap would close the trip, but its result names another starting point.
    latest().feed(s.gap(1));
    await settle();
    expect(logs).toContainEqual(['V1_DURABLE_UNAVAILABLE', {code: 'TRIP_COVERAGE_MISMATCH'}]);
    expect([latest().acks, latest().destroyed, state().durable]).toEqual([['1', '2'], true, {state: 'failed', code: 'TRIP_COVERAGE_MISMATCH'}]);
    expect(recorder.view('ets2')).toEqual(before);
    await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
  });

  it('U6: fails closed on a reducer order violation and reconnects live-only (R7, T5)', async () => {
    const storage = new ModelStorage(), recorder = new TripRecorderSink(storage);
    // A defect injected at the sink: eventSeq 2 reaches the recorder as eventSeq 3.
    const skipping: DurableSink = {
      openSession: welcome => recorder.openSession(welcome),
      commit: (m, context) => {
        if (m.kind !== 'event' || m.data.eventSeq !== '2') return recorder.commit(m, context);
        const skipped = structuredClone(m); skipped.data.eventSeq = '3'; return recorder.commit(skipped, context);
      },
      observe: (m, context) => recorder.observe(m, context)
    };
    start(storage, skipping); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.jobConfigured()));
    await settle();
    expect(logs).toContainEqual(['V1_DURABLE_UNAVAILABLE', {code: 'TRIP_ORDER_VIOLATION'}]);
    expect([latest().acks, latest().destroyed, state().durable, storage.attempts.map(a => a.eventSeq)]).toEqual([['1'], true, {state: 'failed', code: 'TRIP_ORDER_VIOLATION'}, ['1']]);
    await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
  });

  it('U7: records one restore-loss interval for an ACK ahead of storage across service lifetimes (R9)', async () => {
    const storage = new ModelStorage(), s = new Script(ETS2_A);
    start(storage); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.paused(), {simulation: 'paused'}));
    await settle(); expect(latest().acks).toEqual(['1', '2']);
    await stopLifetime();
    // The producer released eventSeq 3-5 that storage never committed (for example a restored database): A = 5, C = 2.
    for (let i = 0; i < 3; i++) s.event(r.started());
    const loss = {pluginSessionId: ETS2_A, interval: {kind: 'restore-loss', firstEventSeq: '3', lastEventSeq: '5',
      detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq: '2', ackedThroughEventSeq: '5'}}};
    for (const lifetime of [1, 2]) {
      logs = [];
      start(storage); connectLatest();
      latest().feed(s.welcome(), s.checkpoint(null));
      await settle();
      expect([latest().destroyed, state().durable]).toEqual([true, {state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'}]);
      expect(logs.filter(([event]) => event.startsWith('V1_DURABLE'))).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}], ['V1_DURABLE_RESTORE_LOSS', {code: 'RECORDED'}]]);
      // A service restart in the same plugin session adds no second row (ifAbsent).
      expect(storage.intervals, `lifetime ${lifetime}`).toEqual([loss]);
      // The plugin session continues live-only.
      await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
      await stopLifetime();
    }
  });

  it('U8: closes the connection on the 513th queued reading without an ACK and drops its queue (R5, REG-011)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '1';
    start(storage); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()));
    await settle(); expect(storage.holding).toBe(1);
    for (let n = 1; n <= 512; n++) latest().feed(s.snapshot({}, 10));
    expect([latest().destroyed, logs.filter(([event]) => event === 'V1_DURABLE_RETRY')]).toEqual([false, []]);
    latest().feed(s.snapshot({}, 10));
    expect([latest().destroyed, state().durable, logs.filter(([event]) => event === 'V1_DURABLE_RETRY')])
      .toEqual([true, {state: 'pending', retryCode: 'BACKLOG_FULL'}, [['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]]);
    // The commit in flight completes in storage, but nothing is acknowledged on the closed connection.
    const closed = latest(); storage.release(); await settle();
    expect([closed.acks, storage.model.committedThrough(ETS2_A), storage.violations]).toEqual([[], '1', []]);
  });

  it('U10: labels an item with its receipt time, not the commit time (R8, T15)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '1';
    start(storage); connectLatest();
    const s = new Script(ETS2_A), received = clock.utc;
    // No event carries a UTC label, so the trip starts at the consumer's receipt label.
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.jobConfigured(), {utcMs: null}));
    await settle();
    clock.utc += 60_000;
    storage.release(); await settle();
    expect(storage.model.trips.map(t => t.startedUtcMs)).toEqual([received]);
    expect(storage.attempts[0].effects[0]).toMatchObject({kind: 'trip.open', startedUtcMs: 1_850_000_000_000});
  });
});

describe('ET-015b one-second samples through the trip recorder', () => {
  /** The stored samples as [source second, trip UUID or null, UTC label]. */
  const stored = (storage: ModelStorage) => storage.model.samples.map(row => [second(row.monotonicNs), row.tripUuid ?? null, row.utcMs]);

  it('S1: a sample names the trip that a committed event earlier in the FIFO opened, and is written with uniqueSeconds (H2, H6, H7, REG-001)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '2';
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    // The checkpoint (second 1000) is the session's baseline; the snapshot after the start (second 1001) has no trip yet.
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.snapshot({}, 200), s.event(r.jobConfigured()));
    // This snapshot (second 1002) arrives while job.configured is in flight, so it is sampled only after that commit.
    latest().feed(s.snapshot({}, 500));
    await settle();
    expect([storage.holding, recorder.samples.pending()]).toEqual([1, {rows: 1, losses: 0}]);
    storage.release(); await settle();
    expect(recorder.samples.pending()).toEqual({rows: 2, losses: 0});
    // The rows wait for the 5 s flush timer, which started with the first row.
    expect(storage.model.samples).toEqual([]);
    await advance(5_000);
    expect(stored(storage)).toEqual([['1001', null, BASE_UTC + 1_200], ['1002', trip, BASE_UTC + 2_700]]);
    expect([storage.sampleOptions, storage.sampleWrites, storage.violations, latest().acks]).toEqual([[{uniqueSeconds: true}], ['samples 1001,1002'], [], ['1', '2']]);
  });

  it('S2: never names a trip whose opening commit failed; the reconnection samples a fresh checkpoint without it (H4, H7, REG-003, REG-007)', async () => {
    const storage = new ModelStorage(); storage.failures.set('2', ['DISK_FULL']);
    start(storage); connectLatest();
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()));
    const job = s.event(r.jobConfigured(), {advanceMs: 2_000});
    // The snapshot behind the failed commit is dropped with the connection's queued work: no row for second 1003.
    latest().feed(job, s.snapshot({}, 500));
    await settle();
    expect([latest().destroyed, latest().acks, storage.model.samples]).toEqual([true, ['1'], []]);
    await advance(250); connectLatest();
    // The reconnection's checkpoint carries a later SDK boundary, so it is fresh: second 1003, before the redelivered job.
    latest().feed(s.welcome(), s.checkpoint(null, 1, {boundaryOrder: '200'}), s.redeliver(job), s.snapshot({boundaryOrder: '210'}, 1_000));
    await settle(); await advance(5_000);
    expect(stored(storage)).toEqual([['1003', null, BASE_UTC], ['1004', trip, BASE_UTC + 4_500]]);
    expect([latest().acks, storage.violations]).toEqual([['2'], []]);
  });

  it('S3: labels a sample without a capture UTC label with the receipt label taken at decode (H13)', async () => {
    const storage = new ModelStorage(); storage.holdAt = '1';
    start(storage); connectLatest();
    const s = new Script(ETS2_A), decoded = clock.utc;
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.snapshot({captureUtcUnixMs: {available: false, reason: 'not-observed'}}, 500));
    await settle();
    clock.utc += 60_000;
    storage.release(); await settle(); await advance(5_000);
    expect(stored(storage)).toEqual([['1001', null, decoded]]);
  });

  it('S4: writes the sample-loss interval of rows dropped beyond 300 before the next rows (H9, REG-007)', async () => {
    const storage = new ModelStorage(); storage.sampleFailures.push('DISK_FULL');
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null));
    // Seconds 1001-1302 are all observed before the first batch runs: 300 rows are held and the newest two are dropped.
    for (let n = 1; n <= 302; n++) latest().feed(s.snapshot({}, 1_000));
    await settle();
    // That batch failed. The run is still open while the buffer is full, so no loss interval was written yet.
    expect([recorder.samples.pending(), recorder.samples.dropped(), storage.model.samples, storage.sampleWrites]).toEqual([{rows: 300, losses: 1}, 2, [], []]);
    expect(logs.filter(([event]) => event.startsWith('V1_SAMPLES'))).toEqual([['V1_SAMPLES_DROPPED', {count: 1}], ['V1_SAMPLES_DROPPED', {count: 2}],
      ['V1_SAMPLES_RETRY', {code: 'DISK_FULL', count: 1}]]);
    await advance(5_000);
    const batch = (first: number) => `samples ${Array.from({length: 60}, (_, i) => first + i).join(',')}`;
    // The first stored batch frees room and so ends the run; the next batch writes its one interval before its rows.
    expect(storage.sampleWrites).toEqual([batch(1001), 'loss 2', batch(1061), batch(1121), batch(1181), batch(1241)]);
    expect(storage.intervals).toEqual([{pluginSessionId: ETS2_A, interval: {tripUuid: null, kind: 'sample-loss', startUtcMs: BASE_UTC + 301_000, endUtcMs: BASE_UTC + 302_000,
      startMonotonicNs: '1301000000000', endMonotonicNs: '1302000000000', sourceClockId: s.clockId, detail: {cause: 'sample-backlog', count: 2}}}]);
    expect([recorder.samples.pending(), storage.model.samples.length, latest().destroyed]).toEqual([{rows: 0, losses: 0}, 300, false]);
  });

  it('S5: writes the pending rows at the stop, after the commit in flight, without an ACK (H11)', async () => {
    const storage = new ModelStorage();
    start(storage); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null), s.snapshot({}, 1_000), s.snapshot({}, 1_000));
    storage.holdAt = '1'; latest().feed(s.event(r.started()));
    await settle(); expect(storage.holding).toBe(1);
    const socket = latest(), stopping = ingestion!.stop(); ingestion = undefined;
    await settle(); expect(storage.model.samples).toEqual([]);
    storage.release(); await stopping;
    expect([stored(storage), socket.acks, logs.filter(([event]) => event === 'V1_SAMPLES_EXIT')])
      .toEqual([[['1001', null, BASE_UTC + 1_000], ['1002', null, BASE_UTC + 2_000]], [], [['V1_SAMPLES_EXIT', {rows: 2, losses: 0, code: 'WRITTEN'}]]]);
  });

  it('S6: stores one sample-loss interval for one contiguous outage across failed retries of rows and of the interval (H9, H12, review pass 1)', async () => {
    const storage = new ModelStorage(); storage.sampleFailures.push('DISK_FULL', 'DISK_FULL', 'DISK_FULL'); storage.lossFailures.push('DISK_FULL', 'DISK_FULL');
    const recorder = start(storage); connectLatest();
    const s = new Script(ETS2_A);
    latest().feed(s.welcome(), s.checkpoint(null));
    // Seconds 1001-1300 are held, 1301-1302 dropped; the first batch fails.
    for (let n = 1; n <= 302; n++) latest().feed(s.snapshot({}, 1_000));
    await settle();
    // The outage goes on: each retry fails while seconds 1303-1307 are dropped into the same open run.
    for (const more of [3, 2]) {
      for (let n = 0; n < more; n++) latest().feed(s.snapshot({}, 1_000));
      await advance(5_000);
    }
    expect([recorder.samples.pending(), recorder.samples.dropped(), storage.intervals]).toEqual([{rows: 300, losses: 1}, 7, []]);
    // The fourth attempt stores rows 1001-1060, which ends the run; its interval then fails twice and is retried as it is.
    await advance(5_000);
    expect([storage.sampleWrites, recorder.samples.pending()]).toEqual([[`samples ${Array.from({length: 60}, (_, i) => 1001 + i).join(',')}`], {rows: 240, losses: 1}]);
    await advance(5_000); await advance(5_000);
    expect(storage.intervals).toEqual([{pluginSessionId: ETS2_A, interval: {tripUuid: null, kind: 'sample-loss', startUtcMs: BASE_UTC + 301_000, endUtcMs: BASE_UTC + 307_000,
      startMonotonicNs: '1301000000000', endMonotonicNs: '1307000000000', sourceClockId: s.clockId, detail: {cause: 'sample-backlog', count: 7}}}]);
    expect([recorder.samples.pending(), storage.model.samples.length, latest().destroyed]).toEqual([{rows: 0, losses: 0}, 300, false]);
  });
});

// ET-015c (G2, G6): what the recording status reads from the recorder. Expected counts are written by hand from G6:
// only effects storage stored as a new row count, a gap counts only the eventSeq values it newly covers, and restore
// losses, stored sample-loss intervals and dropped rows count once each.
describe('ET-015c committed losses and the trip summary of the recorder', () => {
  const ZERO = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
  const context = {receivedUtcMs: RECEIVED_UTC};

  it('L1: counts the new coverage of committed gaps and their interval kinds, never the covered part of a gap or a covered record (G6)', async () => {
    const storage = new ModelStorage();
    let changes = 0;
    const recorder = new TripRecorderSink(storage, {onChange: () => changes++}), s = new Script(ETS2_A);
    expect([recorder.losses(), recorder.tripSummary('ets2')]).toEqual([ZERO, {phase: 'idle', completeness: null, untrackedJob: false}]);
    expect((await recorder.openSession(s.welcome())).ok).toBe(true);
    expect(recorder.observe(s.checkpoint(null), context).ok).toBe(true);
    expect(await recorder.commit(s.event(r.started()), context)).toMatchObject({ok: true, value: {status: 'committed'}});
    // A queue loss of 2-4 with no trip open: one session-level event-loss interval.
    expect(await recorder.commit(s.gap(3), context)).toMatchObject({ok: true, value: {status: 'committed', committedThroughEventSeq: '4'}});
    expect(recorder.losses()).toEqual({...ZERO, lostEvents: 3, eventLoss: 1});
    // An offline loss of 5-6 is a not-connected interval.
    expect(await recorder.commit(s.gap(2, 'offline'), context)).toMatchObject({ok: true, value: {status: 'committed', committedThroughEventSeq: '6'}});
    expect(recorder.losses()).toEqual({...ZERO, lostEvents: 5, eventLoss: 1, notConnected: 1});
    // A merged record 3-8 that storage already covers through 6: only 7 and 8 are new.
    const merged = s.gapRange(3n, 8n, {queueCount: '6'});
    expect(await recorder.commit(merged, context)).toMatchObject({ok: true, value: {status: 'committed', committedThroughEventSeq: '8', previouslyCoveredThrough: '6'}});
    expect(recorder.losses()).toEqual({...ZERO, lostEvents: 7, eventLoss: 2, notConnected: 1});
    // The same record again lies wholly inside coverage: covered, and nothing more is counted.
    expect(await recorder.commit(merged, context)).toMatchObject({ok: true, value: {status: 'covered'}});
    expect(recorder.losses()).toEqual({...ZERO, lostEvents: 7, eventLoss: 2, notConnected: 1});
    expect([changes > 0, storage.violations]).toEqual([true, []]);
  });

  it('L2: counts nothing for a failed commit and reports the open trip of a game (G2, G6)', async () => {
    const storage = new ModelStorage(); storage.failures.set('2', ['DISK_FULL']);
    const recorder = new TripRecorderSink(storage), s = new Script(ETS2_A);
    await recorder.openSession(s.welcome()); recorder.observe(s.checkpoint(null), context);
    await recorder.commit(s.event(r.started()), context);
    const job = s.event(r.jobConfigured());
    expect(await recorder.commit(job, context)).toMatchObject({ok: false, error: {code: 'DISK_FULL'}});
    expect([recorder.losses(), recorder.tripSummary('ets2')]).toEqual([ZERO, {phase: 'idle', completeness: null, untrackedJob: false}]);
    expect(await recorder.commit(job, context)).toMatchObject({ok: true, value: {status: 'committed'}});
    // Opened while running, outside a load: its completeness is not known yet (T12). The other game stays idle.
    expect([recorder.tripSummary('ets2'), recorder.tripSummary('ats'), recorder.losses()]).toEqual([{phase: 'active', completeness: 'unknown', untrackedJob: false},
      {phase: 'idle', completeness: null, untrackedJob: false}, ZERO]);
  });

  it('L3: counts a recorded restore loss with its released range (R9, G6)', async () => {
    const storage = new ModelStorage(), s = new Script(ETS2_A);
    start(storage); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null), s.event(r.started()), s.event(r.paused(), {simulation: 'paused'}));
    await settle(); expect(latest().acks).toEqual(['1', '2']);
    await stopLifetime();
    // The producer released eventSeq 3-5 that storage never committed: A = 5, C = 2.
    for (let i = 0; i < 3; i++) s.event(r.started());
    const counting = new TripRecorderSink(storage);
    start(storage, counting); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null));
    await settle();
    expect([state().durable, counting.losses()]).toEqual([{state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'}, {...ZERO, lostEvents: 3, restoreLoss: 1}]);
  });

  it('L4: counts each stored sample-loss interval and the rows the pending bound dropped (H9, G6)', async () => {
    const storage = new ModelStorage(); storage.sampleFailures.push('DISK_FULL');
    const recorder = new TripRecorderSink(storage), s = new Script(ETS2_A);
    start(storage, recorder); connectLatest();
    latest().feed(s.welcome(), s.checkpoint(null));
    for (let n = 1; n <= 302; n++) latest().feed(s.snapshot({}, 1_000));
    await settle();
    // Two rows were dropped; their interval is not stored yet, so it is not counted.
    expect(recorder.losses()).toEqual({...ZERO, droppedSamples: 2});
    await advance(5_000);
    expect([storage.intervals.map(i => i.interval.kind), recorder.losses()]).toEqual([['sample-loss'], {...ZERO, sampleLoss: 1, droppedSamples: 2}]);
  });
});
