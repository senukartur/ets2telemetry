// ET-019 PR-3 (REG-003, REG-005, REG-007, REG-011, REG-014): producer-side losses inside an open trip, recorded through
// the trip recorder, V1Ingestion and the real (or test-only fault) storage worker against the reactive v1 simulator on
// actual Windows pipes. Each scenario is derived in this file from a simulator corpus scenario: simulation.started, a job
// configured while running, tolls inside the trip, then a loss and the job's delivery after it.
//
// - (a) queue-count overflow: about 260 tolls while the first connection's ACKs are withheld, so the producer's 256
//   retained entries overflow; a reconnection redelivers the store and the delivery follows live.
// - (b) storage stall: the fault worker holds the first commit while more than 256 events arrive, so the producer's
//   retained-entry bound overflows before the application's 512-item backlog bound.
// - (c) an encoding failure and (d) a full SDK-thread handoff inside the trip, through the production recording wiring
//   (recording-runtime.ts) under a temporary LOCALAPPDATA, with the recording status the service publishes.
//
// Every expectation is written by hand in tests/fixtures/recording/<id>.rows.expected.json from docs/trips.md (a gap
// inside an open trip closes it as partial with an event-loss interval, T10 and trip-reducer case 8), docs/storage.md,
// docs/protocol/v1.md §9 and docs/telemetry-service-v1.md (G6), never read back from the code under test (docs/TESTING.md §4).
// Each case also checks that every ACK is within committed coverage, the history invariants I1-I5
// (scripts/ci/history-invariants.mjs), the committed loss counts, and the journal list row and intervals through
// JournalService with main's reply check. Waits count held commits, frames, coverage and ACKs; real-time bounds are named
// hang guards only.
import {existsSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import type {MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {JournalCallResult, RecordingHealth} from '../../packages/contracts/src';
import {StorageClient, type StorageWorkerHandle} from '../../packages/storage/src/client';
import {parseJournalReply, type JournalQuery} from '../../apps/desktop/src/journal-contract';
import {JournalService, type JournalHistory} from '../../apps/desktop/src/journal-service';
import {createRecordingRuntime, type RecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {checkHistoryInvariants, formatViolations, type HistoryAck} from '../../scripts/ci/history-invariants.mjs';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {readHistoryRows} from './history-rows';
import {
  guarded, recordingExpected, replayOf, runRecording, servedAcks, storageWorker, storedRows, terminateWorkers, tracedConnect, tracedShutdown, until,
  type RecordingRun, type RowsExpected, type Service
} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a held commit, coverage, a server run, a status); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
/**
 * Liveness bounds of the overflow cases, which commit about 520 items through the worker, half of them redelivered and
 * acknowledged one by one while the server waits (awaitScriptedAcks); each item crosses several threads and the pipe.
 * Unloaded a case takes 3-6 s; with a busy-loop process on every logical processor of an already busy host, single cases
 * took up to 89 s, so the 30 s defaults are far too close. They bound a hang, never measure a duration. Two overflow
 * cases can together exceed the 5 min CI storage step, so a hang that outlasts the guards on a hosted runner can end as
 * that step's timeout rather than as a named failure.
 */
const OVERFLOW_GUARD_MS = 120_000;
const OVERFLOW_CASE_MS = 240_000;
/** A flush delay far beyond any run, so no sample write joins the command lane during a case (ET-015b H8). */
const NO_FLUSH_TIMER_MS = 600_000;

const connect = (atMs: number, client: Json = {durable: true}) => ({atMs, action: 'connect', client});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
const started = (atMs: number) => ({atMs, action: 'lifecycle', event: 'simulation.started'});
/** A job without cargo.loaded or market: never a cargo_market job before pickup (T14). */
const job = (atMs: number) => ({atMs, action: 'configuration', id: 'job', attributes: [
  {name: 'cargo.id', sdkType: 'string', value: 'synthetic_cargo'}, {name: 'source.city.id', sdkType: 'string', value: 'synthetic_city_a'},
  {name: 'destination.city.id', sdkType: 'string', value: 'synthetic_city_b'}, {name: 'planned_distance.km', sdkType: 'u32', value: 152},
  {name: 'income', sdkType: 'u64', value: '12345'}]});
const toll = (atMs: number, repeat?: number) => ({atMs, action: 'gameplay', id: 'player.tollgate.paid', attributes: [{name: 'pay.amount', sdkType: 's64', value: '5'}],
  ...(repeat === undefined ? {} : {repeat})});
const delivered = (atMs: number) => ({atMs, action: 'gameplay', id: 'job.delivered', attributes: [
  {name: 'revenue', sdkType: 's64', value: '12000'}, {name: 'earned.xp', sdkType: 's32', value: 250}, {name: 'cargo.damage', sdkType: 'float', value: 0.03125},
  {name: 'distance.km', sdkType: 'float', value: 152.5}, {name: 'delivery.time', sdkType: 'u32', value: 300}, {name: 'auto.park.used', sdkType: 'bool', value: false},
  {name: 'auto.load.used', sdkType: 'bool', value: false}]});
const cleared = (atMs: number) => ({atMs, action: 'configuration', id: 'job', attributes: []});
/** A corpus scenario's header and seed with this file's steps and transport. */
function derive(from: string, id: string, purpose: string, reg: string[], steps: Json[], transport: Json[]): Json & {seed: string} {
  const input = structuredClone(readFixtureFile(scenarioPath(from))) as Json & {seed: string};
  return {...input, id, purpose, reg, steps, transport};
}
const sessionOf = (input: Json) => scenarioSource(replayOf(input).scenario).pluginSessionId;
const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => String(from + i));

/** A hand-written expectation of this file: the rows plus the loss counts, ACKs and journal window it states. */
type LossExpected = RowsExpected & {losses: Json; acks: unknown; window?: {fromEventSeq: string; throughEventSeq: string; end: string; events: string[]}};
const expected = (id: string) => recordingExpected(id) as LossExpected;
/** Expands the fixtures' hand-written `eventSeqRange` abbreviation into one attribution per eventSeq, in order. */
function attributions(list: unknown[]): unknown[] {
  return list.flatMap(entry => {
    const e = entry as {eventSeqRange?: [string, string]; trip: string | null; attribution: string};
    if (!e.eventSeqRange) return [entry];
    return range(Number(e.eventSeqRange[0]), Number(e.eventSeqRange[1])).map(eventSeq => ({eventSeq, trip: e.trip, attribution: e.attribution}));
  });
}
const rowsOf = (e: LossExpected) => ({trips: e.trips, attributions: attributions(e.attributions), intervals: e.intervals});

/** No game history: the case records to a synthetic target and the workspace (a temporary LOCALAPPDATA) holds no history database. */
const historyFile = () => path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
function expectNoGameHistory() {
  expect(existsSync(historyFile())).toBe(false);
}
/** I1-I5 over the rows of a closed database and every ACK written to a pipe. */
function expectInvariants(file: string, pluginSessionId: string, acks: string[]) {
  const rows = readHistoryRows(file), written: HistoryAck[] = acks.map(throughEventSeq => ({pluginSessionId, throughEventSeq}));
  const violations = checkHistoryInvariants(rows, written);
  expect(violations, formatViolations(violations)).toEqual([]);
  return rows;
}

const TRIPS: JournalQuery = {kind: 'trips', query: {}};
const SYNTHETIC_V3 = {purpose: 'synthetic', schemaVersion: 3};
/** A journal read that main would forward unchanged (journal-contract.ts, parseJournalReply). */
async function read(journal: JournalService, query: JournalQuery): Promise<JournalCallResult<unknown>> {
  const result = await guarded(journal.query(query), `the journal ${query.kind} read`, HANG_GUARD_MS);
  expect(parseJournalReply(query, result), query.kind).toEqual(result);
  return result;
}
/**
 * The journal shows the loss: one trip, listed under the partial filter and not under the complete one, with outcome
 * none and close reason gap; its intervals page holds exactly the trip's event-loss intervals of the expectation, and its
 * timeline window ends just before the gap (`close-gap`, J7).
 */
async function expectJournal(journal: JournalService, e: LossExpected, window: {fromEventSeq: string; throughEventSeq: string; end: string; events: string[]}) {
  const trip = e.trips[0] as {startedUtcMs: number; endedUtcMs: number};
  const list = await read(journal, TRIPS);
  expect(list).toMatchObject({ok: true, value: {database: SYNTHETIC_V3, nextCursor: null, trips: [{game: 'ets2', outcome: 'none', closeReason: 'gap',
    recordingCompleteness: 'partial', startedUtcMs: trip.startedUtcMs, endedUtcMs: trip.endedUtcMs,
    job: {source: 'event', plannedDistance: {available: true, value: 152_000, unit: 'm'}}}]}});
  const trips = (list as {value: {trips: {tripUuid: string}[]}}).value.trips;
  expect(trips).toHaveLength(1);
  const tripUuid = trips[0].tripUuid;
  const partial = await read(journal, {kind: 'trips', query: {completeness: 'partial'}}), complete = await read(journal, {kind: 'trips', query: {completeness: 'complete'}});
  expect([(partial as {value: {trips: {tripUuid: string}[]}}).value.trips.map(t => t.tripUuid), (complete as {value: {trips: unknown[]}}).value.trips]).toEqual([[tripUuid], []]);
  const intervals = await read(journal, {kind: 'intervals', tripUuid, page: {limit: 100}});
  const own = (e.intervals as Json[]).filter(i => i.trip !== null)
    .map(i => ({kind: i.kind, annotation: false, cause: 'gap', firstEventSeq: i.firstEventSeq, lastEventSeq: i.lastEventSeq, startMonotonicNs: i.startMonotonicNs,
      endMonotonicNs: i.endMonotonicNs, startUtcMs: null, endUtcMs: null, detail: i.detail}));
  const page = (intervals as {value: {intervals: Json[]; total: number; nextCursor: string | null}}).value;
  expect({total: page.total, nextCursor: page.nextCursor, intervals: page.intervals.map(({id, sourceClockId, ...rest}) => { void id; void sourceClockId; return rest; })})
    .toEqual({total: own.length, nextCursor: null, intervals: own});
  const events = await read(journal, {kind: 'events', tripUuid, page: {limit: 500}});
  const timeline = (events as {value: {window: Json; events: {eventSeq: string}[]; nextCursor: string | null}}).value;
  expect(timeline.window).toMatchObject({known: true, fromEventSeq: window.fromEventSeq, throughEventSeq: window.throughEventSeq, end: window.end});
  expect({events: timeline.events.map(x => x.eventSeq), nextCursor: timeline.nextCursor}).toEqual({events: window.events, nextCursor: null});
}

/**
 * The fault worker's first control message, `{type: 'held'}` once the commit is held inside its transaction. The bound
 * is a named hang guard only: a worker that never holds fails the case with its cause.
 */
async function heldOrHang(control: MessagePort): Promise<unknown> {
  return (await guarded(once(control, 'message'), 'the held commit', HANG_GUARD_MS))[0];
}
/**
 * Polls the service's storage until the plugin session's committed coverage is `through`; a hang guard only. Each poll is one
 * read in the storage command lane beside the recorder's commits, so it polls every 25 ms rather than continuously.
 */
async function coverageReaches(service: Service, pluginSessionId: string, through: string): Promise<void> {
  const deadline = performance.now() + OVERFLOW_GUARD_MS;
  for (;;) {
    const covered = await service.client.committedThrough(pluginSessionId);
    if (!covered.ok) throw new Error(`committedThrough failed: ${covered.error.code}`);
    if (covered.value === through) return;
    if (performance.now() > deadline) throw new Error(`Hang guard: coverage ${through} was not reached within ${OVERFLOW_GUARD_MS} ms (at ${covered.value})`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const durableLogs = (run: RecordingRun) => run.services[0].logs.filter(([event]) => event.startsWith('V1_DURABLE'));

/**
 * The checks of a runRecording case: every ACK at or below the coverage storage had reported when it was written, the
 * commit counts and coverage, the hand-written rows, I1-I5 over every ACK written, the G6 loss counts and the journal.
 */
async function expectRecorded(run: RecordingRun, input: Json & {seed: string}, e: LossExpected, window: {fromEventSeq: string; throughEventSeq: string; end: string; events: string[]}) {
  const session = sessionOf(input);
  for (const ack of run.acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
  expect(run.services).toHaveLength(1);
  for (const service of run.services) expect(await service.client.close()).toEqual({clean: true});
  const reader = await ws.open(); const through = ok(reader.committedThrough(session)); reader.close();
  expect(through).toBe(e.coverage.committedThroughEventSeq);
  expect({committed: run.tally.committed, duplicate: run.tally.duplicate, covered: run.tally.covered, conflict: run.tally.conflict})
    .toEqual({committed: e.coverage.committed, duplicate: e.coverage.duplicate, covered: e.coverage.covered, conflict: 0});
  expect(await storedRows(ws, input.seed)).toEqual(rowsOf(e));
  expectInvariants(ws.database, session, run.acks.map(ack => ack.through.toString()));
  // G6: the losses the recording status shows, counted once from what storage committed as new rows.
  expect(run.services[0].recorder.losses()).toEqual(e.losses);
  // The journal through JournalService over a new real worker on the closed file, as the service reads its database.
  const worker = storageWorker(), client = new StorageClient(worker.handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
  const summary = ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
  const history: JournalHistory = {state: 'open', failureCode: null, client, database: {purpose: summary.purpose, schemaVersion: summary.schemaVersion}, databaseUuid: summary.databaseUuid};
  try {
    await expectJournal(new JournalService({history, stopping: () => false, log: () => undefined}), e, window);
  } finally { expect(await client.close()).toEqual({clean: true}); }
  expectNoGameHistory();
}

describe('ET-019 producer losses inside an open trip (runRecording)', () => {
  it('(a) queue-count overflow with withheld ACKs closes the trip as partial with an event-loss interval; the reconnection adds nothing twice (REG-003, REG-005, REG-011)', async () => {
    expectNoGameHistory();
    // eventSeq 1 started, 2 the job, 3-260 tolls (events 1-255 retained, 256-260 lost as queueCount), 261 delivered, 262 cleared.
    const input = derive('queue-count-overflow', 'queue-count-overflow-trip',
      'A job configured while running, 258 tolls while the durable client withholds ACKs (the 256 retained entries overflow), then a reconnection, the delivery and the clear.',
      ['REG-003', 'REG-005', 'REG-011'], [started(10), job(20), toll(30, 258), delivered(250), cleared(260)],
      [connect(0, {durable: true, commit: 'each', ack: 'withhold'}), disconnect(100), connect(200), disconnect(300)]);
    const e = expected('queue-count-overflow-trip'), session = sessionOf(input);
    // The second connection's stream after its redelivered eventSeq 1 waits until the first connection's 260 items are
    // committed, so the pending items never approach the 512 bound whatever the host's commit speed.
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {serve: {quiesceMs: 0, settleTimeoutMs: OVERFLOW_GUARD_MS},
      gate: {afterEventSeq: '1', redelivered: true, until: service => coverageReaches(service, session, '260')}});
    expect(durableLogs(run)).toEqual([]);
    const acks = e.acks as {first: string[]; second: {redeliveredThrough: string; then: string[]}};
    expect([run.served(0), run.served(1)]).toEqual([acks.first, [...range(1, Number(acks.second.redeliveredThrough)), ...acks.second.then]]);
    await expectRecorded(run, input, e, {fromEventSeq: '2', throughEventSeq: '255', end: 'close-gap', events: range(2, 255)});
  }, OVERFLOW_CASE_MS);

  it('(b) a storage stall while more than 256 events arrive: the producer overflows before the 512 backlog, nothing is acknowledged early, and the trip is partial (REG-007, REG-011)', async () => {
    expectNoGameHistory();
    // eventSeq 1 started, 2 the job, 3-262 tolls (events 1-255 retained, 256-262 lost as queueCount), 263 delivered, 264 cleared.
    const input = derive('queue-count-overflow', 'storage-stall-overflow-trip',
      'A job configured while running, then 260 tolls while storage holds the first commit (the 256 retained entries overflow), a reconnection, the delivery and the clear.',
      ['REG-007', 'REG-011'], [started(10), job(20), toll(30, 260), delivered(250), cleared(260)],
      [connect(0, {durable: true, ack: 'withhold'}), disconnect(100), connect(200), disconnect(300)]);
    const e = expected('storage-stall-overflow-trip'), session = sessionOf(input);
    let atRelease: unknown;
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {hold: {eventSeq: '1'}}, serve: {quiesceMs: 0, settleTimeoutMs: OVERFLOW_GUARD_MS},
      gate: {afterEventSeq: '1', redelivered: true, until: async service => {
        // The redelivered 1 has reached the ingestion while the commit of 1 is held with the first connection's 262 items
        // queued behind it: no BACKLOG_FULL closed that connection, and the pipeline is still pending.
        expect(await heldOrHang(service.control!)).toEqual({type: 'held', eventSeq: '1'});
        atRelease = {durable: service.states.at(-1)?.durable, retry: service.states.some(s => s.durable.state === 'pending' && s.durable.retryCode !== undefined)};
        service.control!.postMessage({type: 'release'});
        await coverageReaches(service, session, '262');
      }}});
    run.services[0].control?.close();
    expect(atRelease).toEqual({durable: {state: 'pending'}, retry: false});
    expect(durableLogs(run)).toEqual([]);
    expect(run.services[0].states.filter(s => s.durable.state === 'failed')).toEqual([]);
    // Nothing was acknowledged while storage stalled: the first ACK names a coverage that only the release made possible.
    expect(run.acks[0]?.coverage).toBe(262n);
    const acks = e.acks as {first: string[]; second: {redeliveredThrough: string; then: string[]}};
    expect([run.served(0), run.served(1)]).toEqual([acks.first, [...range(1, Number(acks.second.redeliveredThrough)), ...acks.second.then]]);
    await expectRecorded(run, input, e, {fromEventSeq: '2', throughEventSeq: '255', end: 'close-gap', events: range(2, 255)});
  }, OVERFLOW_CASE_MS);
});

// The production recording wiring, as tests/storage/recording-status.test.ts and journal-service.test.ts build it.
const target = (name: string) => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', `${name}.sqlite`);
const reader = (name: string) => ({database: target(name), open: () => ws.open({path: target(name), backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups')})});
const ZERO = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
const IDLE = {phase: 'idle', completeness: null, untrackedJob: false};
/** The published states, `state` or `state CODE`, with adjacent repeats removed (a trip or loss change alone is not a step). */
const sequence = (statuses: RecordingHealth[]) => statuses.map(s => 'code' in s && s.code ? `${s.state} ${s.code}` : s.state).filter((s, i, all) => i === 0 || s !== all[i - 1]);
function serviceRuntime(name: string, worker: StorageWorkerHandle, timeline: string[]) {
  const logs: [string, unknown][] = [], statuses: RecordingHealth[] = [];
  const runtime = createRecordingRuntime({env: {ETS2TELEMETRY_RECORDING: `synthetic:${name}`}, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory,
    log: (event, _detail, facts) => { logs.push([event, facts]); }, createWorker: () => worker, connect: tracedConnect(timeline).connect,
    ingestionOverrides: {sampleFlushMs: NO_FLUSH_TIMER_MS}, historyOverrides: {appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS},
    statusOverrides: {intervalMs: 0}, onV1State: () => undefined, onRecordingStatus: next => { statuses.push(next); }});
  return {runtime, logs, statuses};
}
async function startDurable(runtime: RecordingRuntime, endpoint: string) {
  runtime.start();
  await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(runtime.history.state).toBe('open');
  runtime.v1.select('synthetic', endpoint);
}

describe('ET-019 producer losses inside an open trip (production recording wiring)', () => {
  // (c) eventSeq 1 started, 2 the job, 3 a toll, 4 a record the contract rejects, 5 a toll, 6 delivered, 7 cleared.
  // (d) eventSeq 1 started, 2 the job, 3 a toll, 4-5 tolls lost to the full handoff ring, 6 a toll, 7 delivered, 8 cleared.
  const cases = [
    {label: '(c) an encoding failure', id: 'encoding-failed-trip', from: 'encoding-failed', reg: ['REG-003', 'REG-005', 'REG-014'],
      purpose: 'A job configured while running, a toll, a record that cannot be encoded inside the trip, then a toll, the delivery and the clear.',
      steps: [started(10), job(20), toll(30), {atMs: 40, action: 'encodingFailure', count: 1}, toll(50), delivered(60), cleared(70)], transport: [connect(0), disconnect(100)]},
    {label: '(d) a full SDK-thread handoff', id: 'handoff-full-trip', from: 'handoff-full', reg: ['REG-003', 'REG-011', 'REG-014'],
      purpose: 'A job configured while running, a toll, two tolls lost to the full handoff ring inside the trip, then a toll, the delivery and the clear.',
      steps: [started(10), job(20), toll(30), {atMs: 40, action: 'handoff', full: true}, toll(50), toll(60), {atMs: 70, action: 'handoff', full: false}, toll(80), delivered(90), cleared(100)],
      transport: [connect(0), disconnect(200)]}
  ];
  for (const c of cases) it(`${c.label} inside the trip is a visible partial trip, counted once in the recording status and shown in the journal (${c.reg.join(', ')})`, async () => {
    expectNoGameHistory();
    const input = derive(c.from, c.id, c.purpose, c.reg, c.steps, c.transport), e = expected(c.id), session = sessionOf(input);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker(), s = serviceRuntime('t', worker.handle, timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      // G6: the committed loss reaches the status, counted once. The wait ends at the last change the run makes (the
      // gap's event-loss interval counted and the untracked job ended by the delivery; G5: every status change is sent),
      // or at a failure state, which the assertions below then report.
      const losses = {...ZERO, ...e.losses}, last = () => s.statuses.at(-1) as {state: string; losses?: typeof ZERO; trip?: {untrackedJob: boolean}} | undefined;
      await until(() => ['stopped', 'live-only', 'retrying'].includes(last()?.state ?? '') || (last()?.losses?.eventLoss === losses.eventLoss && last()?.trip?.untrackedJob === false),
        'the status after the delivery', HANG_GUARD_MS);
      // No scenario here publishes a frame, so every state the source sends has an unavailable simulation and v1 reads
      // `waiting` (docs/telemetry-service-v1.md, Freshness); the selection never recorded fresh data, so the status reads
      // `waiting` throughout (G3 rule 8), while its events and gap are committed and counted.
      expect(sequence(s.statuses)).toEqual(['opening', 'not-recorded-source', 'waiting']);
      expect(s.statuses.at(-1)).toEqual({state: 'waiting', target: 'synthetic', code: null, losses, trip: IDLE});
      expect([...new Set(s.statuses.map(x => 'losses' in x ? x.losses.lostEvents : 0))]).toEqual([0, losses.lostEvents]);
      expect(s.logs.filter(([event]) => /^V1_(DURABLE|SAMPLES)_/.test(event))).toEqual([]);
      const acks = e.acks as string[];
      expect([servedAcks(report, 0), timeline.filter(line => line.startsWith('ack '))]).toEqual([acks, acks.map(a => `ack ${a}`)]);
      await expectJournal(new JournalService({history: s.runtime.history, stopping: () => false, log: () => undefined}), e, e.window!);

      s.runtime.stopStatus();
      const shutdown = tracedShutdown(timeline);
      s.runtime.register(shutdown.registrar);
      await shutdown.sequence.run();
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
      const storage = await reader('t').open();
      expect(ok(storage.committedThrough(session))).toBe(e.coverage.committedThroughEventSeq);
      storage.close();
      expect(await storedRows(reader('t'), input.seed)).toEqual(rowsOf(e));
      const rows = expectInvariants(target('t'), session, timeline.filter(line => line.startsWith('ack ')).map(line => line.slice(4)));
      // Every committed item is one event or gap row: the expectation's first commits.
      expect(rows.events.length + rows.gaps.length).toBe(e.coverage.committed);
      expectNoGameHistory();
    } finally { await server.stop(); }
  }, 90_000);
});
