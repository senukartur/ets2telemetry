// ET-016 PR-3 (J2, J4, J11): journal queries through the telemetry service's production recording wiring, in process under
// the pinned Electron runtime, with the real or the fault storage worker and the reactive v1 simulator on actual Windows
// pipes. A journal read shares the recorder's single storage command lane: it waits behind a held commit and is answered
// after it, it never changes the ACK order or the stored rows, and a bad journal page fails only that read. Each case
// records `synthetic:<name>` under a temporary LOCALAPPDATA and must never create its history database. Expected values
// are written by hand from normal-delivery.json and normal-delivery.trip.expected.json; waits count held requests,
// commits and ACKs, and real-time bounds are named hang guards only (REG-011, REG-012, REG-014).
import {existsSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {JournalCallResult} from '../../packages/contracts/src';
import type {StorageWorkerHandle} from '../../packages/storage/src/client';
import type {StorageRequest} from '../../packages/storage/src/worker/protocol';
import {parseJournalReply, type JournalQuery} from '../../apps/desktop/src/journal-contract';
import {JournalService} from '../../apps/desktop/src/journal-service';
import {createRecordingRuntime, type RecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {guarded, servedAcks, storageWorker, storedRows, terminateWorkers, tracedConnect, tracedHandle, tracedShutdown, tripExpected, until} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a held request, a server run, an answer); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
/** A flush delay far beyond any run, so no sample write joins the command lane during a case (ET-015b H8). */
const NO_FLUSH_TIMER_MS = 600_000;
const scenario = (id: string) => readFixtureFile(scenarioPath(id)) as Json & {seed: string; steps: Json[]};
const target = (name: string) => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', `${name}.sqlite`);
const historyFile = () => path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
const reader = (name: string) => ({database: target(name), open: () => ws.open({path: target(name), backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups')})});
const ordered = (timeline: string[], lines: string[]) => timeline.filter(line => lines.includes(line));
const TRIPS: JournalQuery = {kind: 'trips', query: {}};
/** normal-delivery: events 1-9 on one durable connection, every one acknowledged in order. */
const ACKS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ACK_LINES = ACKS.map(seq => `ack ${seq}`);
/**
 * The trip of normal-delivery as the journal lists it, by hand from the scenario and its trip expectation: the ETS2 job
 * configured at eventSeq 3 before the first simulation.started (partial, opened at load), 152 km planned, income 12345 of
 * unknown currency, unknown game mode, started at the UTC label 1,800,000,000,030.
 */
const TRIP_ROW = {game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, recordingCompleteness: 'partial',
  startedUtcMs: 1_800_000_000_030, job: {source: 'event', plannedDistance: {available: true, value: 152_000, unit: 'm'},
    expectedIncome: {available: true, value: {raw: '12345', sdkType: 'u64', currency: {status: 'unknown'}}}}};
const SYNTHETIC_V2 = {purpose: 'synthetic', schemaVersion: 2};

/** One service's recording runtime for `synthetic:<name>` and the journal service over its database, as the service builds them. */
function service(name: string, worker: StorageWorkerHandle, timeline: string[], sampleFlushMs = NO_FLUSH_TIMER_MS) {
  const logs: [string, unknown][] = [], socket = tracedConnect(timeline);
  let stopping = false;
  const runtime = createRecordingRuntime({env: {ETS2TELEMETRY_RECORDING: `synthetic:${name}`}, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory,
    log: (event, _detail, facts) => { logs.push([event, facts]); }, createWorker: () => worker, connect: socket.connect,
    ingestionOverrides: {sampleFlushMs}, historyOverrides: {appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS}, onV1State: () => undefined});
  const journal = new JournalService({history: runtime.history, stopping: () => stopping, log: (event, _detail, facts) => { logs.push([event, facts]); }});
  /** A journal read that writes `journal answered` to the timeline when its answer arrives. */
  const read = (query: JournalQuery) => journal.query(query).then(result => { timeline.push('journal answered'); return result; });
  const stop = async () => {
    stopping = true; runtime.stopStatus();
    const shutdown = tracedShutdown(timeline);
    runtime.register(shutdown.registrar);
    await shutdown.sequence.run();
  };
  return {runtime, journal, read, logs, stop};
}
async function startDurable(runtime: RecordingRuntime, endpoint: string) {
  runtime.start();
  await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(runtime.history.state).toBe('open');
  runtime.v1.select('synthetic', endpoint);
}
/** Main's check of the answer (journal-contract.ts): the value it would forward, or undefined if it would answer FAILED. */
function forwarded(query: JournalQuery, result: JournalCallResult<unknown>) { return parseJournalReply(query, result); }
const failures = (logs: [string, unknown][]) => logs.filter(([event]) => /^V1_(DURABLE|SAMPLES)_|STORAGE_BUSY|HISTORY_STORAGE_UNAVAILABLE/.test(event));

describe('ET-016 journal queries through the production recording wiring', () => {
  it('(a) a journal read behind a held commit is answered after its release; the ACK order and the stored rows are unchanged, with no STORAGE_BUSY (REG-011, REG-012)', async () => {
    const input = scenario('normal-delivery'), timeline: string[] = [];
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    // The fault worker holds the commit of simulation.started (eventSeq 4) inside its transaction, after 1-3 were committed.
    const worker = storageWorker({hold: {eventSeq: '4'}}), traced = tracedHandle(worker.handle, timeline);
    const held = once(worker.control!, 'message');
    const s = service('t', traced.handle, timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      expect((await guarded(held, 'the held commit of eventSeq 4', HANG_GUARD_MS))[0]).toEqual({type: 'held', eventSeq: '4'});
      // The read is queued behind the held commit; a second one is refused at once, so the lane holds one journal command.
      const first = s.read(TRIPS);
      await expect(s.journal.query({kind: 'trip', tripUuid: '7a000000-0000-4000-8000-000000000001'})).resolves.toEqual({ok: false, code: 'BUSY'});
      // Let the worker run for a while with the commit held: the read stays unanswered.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(timeline).not.toContain('journal answered');
      timeline.push('release'); worker.control!.postMessage({type: 'release'});
      const answer = await guarded(first, 'the journal answer', HANG_GUARD_MS);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);

      // The read went to the worker only after the held commit finished, and its answer came after the release.
      expect(ordered(timeline, ['release', 'done commitEvent 4', 'done journalTrips', 'journal answered'])).toEqual(['release', 'done commitEvent 4', 'done journalTrips', 'journal answered']);
      expect(timeline.filter(line => line.startsWith('done journal'))).toEqual(['done journalTrips']);
      // The page shows the open trip as committed through eventSeq 4, and main would forward it unchanged.
      expect(answer).toMatchObject({ok: true, value: {database: SYNTHETIC_V2, nextCursor: null, trips: [{...TRIP_ROW, outcome: 'open', closeReason: null, endedUtcMs: null}]}});
      expect(forwarded(TRIPS, answer)).toEqual(answer);
      // The ACK order is unchanged and no command was refused for a full queue.
      expect(timeline.filter(line => line.startsWith('ack '))).toEqual(ACK_LINES);
      expect(servedAcks(report, 0)).toEqual(ACKS);
      expect(failures(s.logs)).toEqual([]);

      // After the delivery the same trip reads delivered; its detail, timeline and intervals pass main's check as read.
      // No sample row is written before the stop here (the flush timer is off); case (d) reads a stored sample page.
      const after = await s.read(TRIPS);
      expect(after).toMatchObject({ok: true, value: {trips: [{...TRIP_ROW, outcome: 'delivered', closeReason: 'outcome', endedUtcMs: 1_800_000_000_600}]}});
      const tripUuid = (after as {value: {trips: {tripUuid: string}[]}}).value.trips[0].tripUuid;
      for (const query of [{kind: 'trip', tripUuid}, {kind: 'events', tripUuid, page: {limit: 100}}, {kind: 'intervals', tripUuid, page: {limit: 100}}] as JournalQuery[]) {
        const result = await s.read(query);
        expect(result.ok, query.kind).toBe(true);
        expect(forwarded(query, result), query.kind).toEqual(result);
      }
      await expect(s.read({kind: 'trip', tripUuid: '7a000000-0000-4000-8000-000000000001'})).resolves.toEqual({ok: false, code: 'NOT_FOUND'});

      await s.stop();
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
      const expected = tripExpected('normal-delivery');
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(b) a bad journal page fails only that read: recording continues, every event is acknowledged and the next read succeeds', async () => {
    const input = scenario('normal-delivery'), timeline: string[] = [];
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker({hold: {eventSeq: '4'}}), traced = tracedHandle(worker.handle, timeline);
    // A test-side wrapper of the worker handle (no worker change) that adds a field to the first journalTrips answer.
    const journalIds = new Set<number>();
    let corrupted = false;
    const handle: StorageWorkerHandle = {...traced.handle,
      postMessage: (request: StorageRequest) => { if (request.command.name === 'journalTrips') journalIds.add(request.id); traced.handle.postMessage(request); },
      onMessage: listener => traced.handle.onMessage(message => {
        const response = message as {id: number; result: {ok: boolean; value?: Json}};
        if (!corrupted && journalIds.has(response.id) && response.result.ok) {
          corrupted = true;
          listener({...response, result: {ok: true, value: {...response.result.value, path: 'C:\\Users\\owner\\telemetry.sqlite'}}});
          return;
        }
        listener(message);
      })};
    const held = once(worker.control!, 'message');
    const s = service('t', handle, timeline);
    try {
      await startDurable(s.runtime, server.endpoint);
      await guarded(held, 'the held commit of eventSeq 4', HANG_GUARD_MS);
      const bad = s.read(TRIPS);
      worker.control!.postMessage({type: 'release'});
      await expect(guarded(bad, 'the bad journal answer', HANG_GUARD_MS)).resolves.toEqual({ok: false, code: 'FAILED'});
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);

      expect(corrupted).toBe(true);
      expect(s.logs.filter(([event]) => event === 'JOURNAL_ANSWER_INVALID')).toEqual([['JOURNAL_ANSWER_INVALID', {command: 'journalTrips', count: 1}]]);
      // Recording continued: the database stays open, its client running, and every event was committed and acknowledged.
      expect([s.runtime.history.state, s.runtime.history.client?.state, s.runtime.history.failureCode]).toEqual(['open', 'running', null]);
      expect(servedAcks(report, 0)).toEqual(ACKS);
      expect(failures(s.logs)).toEqual([]);
      await expect(s.read(TRIPS)).resolves.toMatchObject({ok: true, value: {trips: [{...TRIP_ROW, outcome: 'delivered'}]}});

      await s.stop();
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
      const expected = tripExpected('normal-delivery');
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(c) a read while the database opens is refused without reaching the worker, and answered once it is open (J4)', async () => {
    const timeline: string[] = [], worker = storageWorker(), traced = tracedHandle(worker.handle, timeline, 'open');
    const s = service('t', traced.handle, timeline);
    s.runtime.start();
    await guarded(traced.held, 'the held open', HANG_GUARD_MS);
    await expect(s.read(TRIPS)).resolves.toEqual({ok: false, code: 'DATABASE_OPENING'});
    traced.release();
    await until(() => s.runtime.history.state === 'open', 'the database open', HANG_GUARD_MS);
    await expect(s.read(TRIPS)).resolves.toEqual({ok: true, value: {database: SYNTHETIC_V2, trips: [], nextCursor: null}});
    expect(timeline.filter(line => /^(held|done) /.test(line))).toEqual(['held open', 'done open', 'done journalTrips']);
    // Once the orderly stop began, reads are refused.
    await s.stop();
    await expect(s.read(TRIPS)).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
    expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
    expect(existsSync(historyFile())).toBe(false);
  }, 60_000);

  it('(d) a stored one-second sample reads back as a sample page that main forwards unchanged (J5, J10; REG-014)', async () => {
    // normal-delivery with a 1 ms sample flush: the checkpoint at 0 ms is the session's baseline, the snapshot at 100 ms
    // is the first reading of source second 1000 (the one at 200 ms is the same second), so the recorder writes exactly
    // one row, attributed to the trip that eventSeq 3 opened (normal-delivery-runtime-journey.rows.expected.json).
    const input = scenario('normal-delivery'), timeline: string[] = [];
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker(), traced = tracedHandle(worker.handle, timeline);
    const s = service('t', traced.handle, timeline, 1);
    try {
      await startDurable(s.runtime, server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect(servedAcks(report, 0)).toEqual(ACKS);
      await until(() => timeline.includes('done appendSamples'), 'the sample write', HANG_GUARD_MS);
      const trips = await s.read(TRIPS);
      const tripUuid = (trips as {value: {trips: {tripUuid: string}[]}}).value.trips[0].tripUuid;
      const query: JournalQuery = {kind: 'samples', tripUuid, page: {limit: 300}};
      const page = await s.read(query);
      expect(page).toMatchObject({ok: true, value: {database: SYNTHETIC_V2, nextCursor: null, samples: [{tripUuid, utcMs: 1_800_000_000_100, monotonicNs: '1000100000000',
        speed: {available: true, value: 25.5}, odometer: {available: true, value: 1_000_500}, gameTime: {minutes: {available: true, value: 601}}}]}});
      expect((page as {value: {samples: unknown[]}}).value.samples).toHaveLength(1);
      expect(forwarded(query, page)).toEqual(page);
      // The page after that row is empty and passes as well.
      const id = (page as {value: {samples: {id: string}[]}}).value.samples[0].id;
      const next: JournalQuery = {kind: 'samples', tripUuid, page: {cursor: id, limit: 300}};
      const empty = await s.read(next);
      expect(empty).toEqual({ok: true, value: {database: SYNTHETIC_V2, samples: [], nextCursor: null}});
      expect(forwarded(next, empty)).toEqual(empty);
      expect(failures(s.logs)).toEqual([]);
      await s.stop();
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);
});
