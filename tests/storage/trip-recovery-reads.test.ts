// ET-015a PR-1 (S1): the storage reads a trip recorder's cold start needs, through the bundled storage worker in a real
// worker thread under the pinned Electron runtime. The listTrips filter, recordCompleteness ifAbsent, and the seeds
// readTripSeeds() builds from stored rows, including the jobKey round trip of every valid job.configured fixture in the
// protocol v1 manifest. Expected rows and seeds are written by hand from docs/storage.md, docs/trips.md (R4) and the
// fixtures; job keys come from jobKey() of the original wire record (T6). Runs under npm run test:storage.
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {decodePayload, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {CompletenessInterval, TripEffect, TripPage} from '../../packages/storage/src/api';
import {jobKey} from '../../packages/telemetry-core/src/index';
import {readTripSeeds} from '../../apps/desktop/src/trip-seeds';
import {ATS_A, BASE_UTC, ETS2_A, ETS2_B, Script, job, otherJob, r} from '../shared/trip-messages';
import {failed, ok, PROTOCOL_V1, readOnly, TEST_CLOSE_GRACE_MS, v1, workspace} from './helpers';

const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if (!bundles) throw new Error('Storage test bundles are missing; run npm run test:storage.');
const WORKER = path.join(bundles, 'storage-worker.cjs');

let ws: Awaited<ReturnType<typeof workspace>>;
const started: Worker[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => {
  await Promise.all(started.splice(0).map(worker => worker.terminate()));
  await ws.dispose();
});

/** A real storage worker with the database at `file` open. */
async function openWorker(file = ws.database) {
  const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
  started.push(worker);
  const exit = once(worker, 'exit').then(([code]) => code as number);
  const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
  ok(await client.open({path: file, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
  return {client, async close() { expect(await client.close()).toEqual({clean: true}); expect(await exit).toBe(0); }};
}
type Client = Awaited<ReturnType<typeof openWorker>>['client'];
const commit = async (client: Client, message: ServerMessage, effects: TripEffect[] = []) =>
  ok(message.kind === 'event' ? await client.commitEvent({message, effects}) : await client.commitGap({message, effects})).status;

const T = (n: number) => `70000000-0000-4000-8000-00000000000${n}`;
const MODE = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const opens = (tripUuid: string, game: 'ets2' | 'ats' = 'ets2'): TripEffect =>
  ({kind: 'trip.open', tripUuid, game, gameMode: MODE, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: BASE_UTC});
const closes = (tripUuid: string, outcome: 'delivered' | 'cancelled' | 'none', closeReason: 'outcome' | 'gap'): TripEffect => ({kind: 'trip.close', tripUuid, outcome, closeReason,
  ...(outcome === 'none' ? {} : {outcomeEvent: 'this-event' as const}), recordingCompleteness: outcome === 'none' ? 'partial' : 'complete', endedUtcMs: BASE_UTC + 60_000});

describe('listTrips filter (R12)', () => {
  /**
   * Trips in creation order: T1 delivered and T2 open (ETS2 session A), T3 open (ATS session), T4 cancelled, T5 closed
   * `none` by a gap and T6 open (ETS2 session B).
   */
  async function stored() {
    const w = await openWorker();
    const a = new Script(ETS2_A), b = new Script(ATS_A, 'ats'), c = new Script(ETS2_B);
    for (const s of [a, b, c]) ok(await w.client.upsertSession({message: s.welcome()}));
    await commit(w.client, a.event(r.jobConfigured()), [opens(T(1))]);
    await commit(w.client, a.event(r.delivered()), [closes(T(1), 'delivered', 'outcome')]);
    await commit(w.client, a.event(r.jobConfigured(otherJob())), [opens(T(2))]);
    await commit(w.client, b.event(r.jobConfigured()), [opens(T(3), 'ats')]);
    await commit(w.client, c.event(r.jobConfigured()), [opens(T(4))]);
    await commit(w.client, c.event(r.cancelled()), [closes(T(4), 'cancelled', 'outcome')]);
    await commit(w.client, c.event(r.jobConfigured(otherJob())), [opens(T(5))]);
    await commit(w.client, c.gap(1), [closes(T(5), 'none', 'gap')]);
    await commit(w.client, c.event(r.jobConfigured()), [opens(T(6))]);
    return w;
  }
  const uuids = async (client: Client, page?: TripPage) => { const list = ok(await client.listTrips(page)); return {trips: list.trips.map(t => t.tripUuid), next: list.nextCursor}; };

  it('filters by game and outcome in SQL, alone and together', async () => {
    const w = await stored();
    expect(await uuids(w.client)).toEqual({trips: [T(1), T(2), T(3), T(4), T(5), T(6)], next: null});
    expect(await uuids(w.client, {game: 'ets2'})).toEqual({trips: [T(1), T(2), T(4), T(5), T(6)], next: null});
    expect(await uuids(w.client, {game: 'ats'})).toEqual({trips: [T(3)], next: null});
    expect(await uuids(w.client, {outcome: 'open'})).toEqual({trips: [T(2), T(3), T(6)], next: null});
    expect(await uuids(w.client, {game: 'ets2', outcome: 'open'})).toEqual({trips: [T(2), T(6)], next: null});
    expect(await uuids(w.client, {game: 'ats', outcome: 'open'})).toEqual({trips: [T(3)], next: null});
    expect(await uuids(w.client, {outcome: 'delivered'})).toEqual({trips: [T(1)], next: null});
    expect(await uuids(w.client, {outcome: 'cancelled'})).toEqual({trips: [T(4)], next: null});
    expect(await uuids(w.client, {outcome: 'none'})).toEqual({trips: [T(5)], next: null});
    expect(await uuids(w.client, {game: 'ats', outcome: 'delivered'})).toEqual({trips: [], next: null});
    expect(ok(await w.client.listTrips({game: 'ets2', outcome: 'open'})).trips.map(t => [t.game, t.outcome])).toEqual([['ets2', 'open'], ['ets2', 'open']]);
    await w.close();
  });

  it('pages a filtered list before the limit: a full page has a cursor to the next match', async () => {
    const w = await stored();
    // Row ids follow creation order (T1 = 1 … T6 = 6); the cursor is the id of a page's last row.
    expect(await uuids(w.client, {game: 'ets2', limit: 2})).toEqual({trips: [T(1), T(2)], next: '2'});
    expect(await uuids(w.client, {game: 'ets2', limit: 2, cursor: '2'})).toEqual({trips: [T(4), T(5)], next: '5'});
    expect(await uuids(w.client, {game: 'ets2', limit: 2, cursor: '5'})).toEqual({trips: [T(6)], next: null});
    expect(await uuids(w.client, {game: 'ets2', outcome: 'open', limit: 1})).toEqual({trips: [T(2)], next: '2'});
    expect(await uuids(w.client, {game: 'ets2', outcome: 'open', limit: 1, cursor: '2'})).toEqual({trips: [T(6)], next: '6'});
    expect(await uuids(w.client, {game: 'ets2', outcome: 'open', limit: 1, cursor: '6'})).toEqual({trips: [], next: null});
    await w.close();
  });

  it('refuses an unknown game or outcome at the worker boundary and in the storage core', async () => {
    const w = await stored();
    failed(await w.client.listTrips({game: 'ETS2'} as unknown as TripPage), 'INVALID_INPUT');
    failed(await w.client.listTrips({outcome: 'closed'} as unknown as TripPage), 'INVALID_INPUT');
    await w.close();
    const storage = await ws.open();
    failed(storage.listTrips({game: 'ATS'} as unknown as TripPage), 'INVALID_INPUT');
    failed(storage.listTrips({outcome: 'finished'} as unknown as TripPage), 'INVALID_INPUT');
    expect(ok(storage.listTrips({game: 'ats', outcome: 'open'})).trips.map(t => t.tripUuid)).toEqual([T(3)]);
  });
});

describe('recordCompleteness ifAbsent (R12)', () => {
  const RESTORE_LOSS: CompletenessInterval = {kind: 'restore-loss', firstEventSeq: '3', lastEventSeq: '5',
    detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq: '2', ackedThroughEventSeq: '5'}};
  const CLOCK_A = '30000000-0000-4000-8000-0000000000a1', CLOCK_NEW = '30000000-0000-4000-8000-0000000000ff';
  const intervals = () => readOnly(ws.database, db => db.prepare(`SELECT c.kind, t.trip_uuid AS trip, CAST(c.first_event_seq AS INTEGER) AS first,
    CAST(c.last_event_seq AS INTEGER) AS last, c.start_utc_ms AS startUtc, c.detail_json AS detail FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref ORDER BY c.id`).all());
  const clocks = () => readOnly(ws.database, db => db.prepare('SELECT clock_uuid FROM clocks ORDER BY id').pluck().all());
  const detail = '{"ackedThroughEventSeq":"5","cause":"ack-ahead-of-storage","storedThroughEventSeq":"2"}';

  it('stores an interval once across repeats and a worker restart, and only an equal interval is skipped', async () => {
    const a = new Script(ETS2_A);
    const first = await openWorker();
    ok(await first.client.upsertSession({message: a.welcome()}));
    await commit(first.client, a.event(r.jobConfigured()), [opens(T(1))]);
    expect(await first.client.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: true})).toEqual({ok: true, value: undefined});
    expect(await first.client.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: true})).toEqual({ok: true, value: undefined});
    // The same detail with its keys in another order is the same canonical detail; labels are not compared.
    ok(await first.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, startUtcMs: BASE_UTC, detail: {storedThroughEventSeq: '2', ackedThroughEventSeq: '5', cause: 'ack-ahead-of-storage'}}, {ifAbsent: true}));
    await first.close();
    expect(intervals()).toEqual([{kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail}]);

    // A new worker (a service restart in the same plugin session) records the same loss again: still one row.
    const second = await openWorker();
    ok(await second.client.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: true}));
    // Without ifAbsent, or with ifAbsent false, the interval is appended as before.
    ok(await second.client.recordCompleteness(ETS2_A, RESTORE_LOSS));
    ok(await second.client.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: false}));
    // Each compared field makes a different interval: range, detail, kind and trip reference.
    ok(await second.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, lastEventSeq: '6'}, {ifAbsent: true}));
    ok(await second.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, detail: {cause: 'ack-ahead-of-storage'}}, {ifAbsent: true}));
    ok(await second.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, kind: 'event-loss'}, {ifAbsent: true}));
    ok(await second.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, tripUuid: T(1)}, {ifAbsent: true}));
    ok(await second.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, tripUuid: T(1)}, {ifAbsent: true}));
    // An interval without eventSeq bounds or detail is matched on the absent values too.
    ok(await second.client.recordCompleteness(ETS2_A, {kind: 'not-connected', startUtcMs: BASE_UTC}, {ifAbsent: true}));
    ok(await second.client.recordCompleteness(ETS2_A, {kind: 'not-connected', startUtcMs: BASE_UTC + 5_000}, {ifAbsent: true}));
    await second.close();
    expect(intervals()).toEqual([
      {kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail},
      {kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail},
      {kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail},
      {kind: 'restore-loss', trip: null, first: 3, last: 6, startUtc: null, detail},
      {kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail: '{"cause":"ack-ahead-of-storage"}'},
      {kind: 'event-loss', trip: null, first: 3, last: 5, startUtc: null, detail},
      {kind: 'restore-loss', trip: T(1), first: 3, last: 5, startUtc: null, detail},
      {kind: 'not-connected', trip: null, first: null, last: null, startUtc: BASE_UTC, detail: null}
    ]);
  });

  it('writes nothing, not even a clock row, for a skipped interval, and validates its values first', async () => {
    const a = new Script(ETS2_A);
    const w = await openWorker();
    ok(await w.client.upsertSession({message: a.welcome()}));
    const bounded = {...RESTORE_LOSS, startMonotonicNs: '1000', endMonotonicNs: '2000'};
    ok(await w.client.recordCompleteness(ETS2_A, {...bounded, sourceClockId: CLOCK_A}, {ifAbsent: true}));
    ok(await w.client.recordCompleteness(ETS2_A, {...bounded, sourceClockId: CLOCK_NEW}, {ifAbsent: true}));
    failed(await w.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, startUtcMs: -1}, {ifAbsent: true}), 'INVALID_INPUT');
    failed(await w.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, sourceClockId: 'not-a-uuid'}, {ifAbsent: true}), 'INVALID_INPUT');
    failed(await w.client.recordCompleteness(ETS2_A, bounded, {ifAbsent: true}), 'INVALID_INPUT');
    failed(await w.client.recordCompleteness(ETS2_A, {...RESTORE_LOSS, tripUuid: T(9)}, {ifAbsent: true}), 'UNKNOWN_TRIP');
    failed(await w.client.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: 'yes'} as unknown as {ifAbsent: boolean}), 'INVALID_INPUT');
    await w.close();
    expect(clocks()).toEqual([CLOCK_A]);
    expect(intervals()).toEqual([{kind: 'restore-loss', trip: null, first: 3, last: 5, startUtc: null, detail}]);
    const storage = await ws.open();
    failed(storage.recordCompleteness(ETS2_A, RESTORE_LOSS, {ifAbsent: 1} as unknown as {ifAbsent: boolean}), 'INVALID_INPUT');
  });
});

describe('cold-start seeds from the real worker (R4)', () => {
  const NAMES = ['event-job-configured', 'event-job-configured-documented-currency', 'event-job-configured-unobserved-text', 'event-job-configured-localized',
    'event-job-configured-repeat', 'money-uint64-max', 'event-worst', 'event-size-limit'];
  const manifestJobs = readFileSync(path.join(PROTOCOL_V1, 'manifest.txt'), 'utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([, result]) => result === 'valid').map(([file]) => file.replace(/\.json$/, ''))
    .filter(name => { const m = decodePayload(new Uint8Array(readFileSync(path.join(PROTOCOL_V1, `${name}.json`))), 'server'); return m.kind === 'event' && m.data.record.type === 'job.configured'; });

  it('covers every valid job.configured fixture of the protocol v1 manifest', () => {
    expect([...manifestJobs].sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('keeps the jobKey of %s through a commit and a seed read', async name => {
    const message = v1(name);
    if (message.kind !== 'event' || message.data.record.type !== 'job.configured') throw new Error('job.configured fixture expected');
    const w = await openWorker(path.join(ws.directory, `${name}.sqlite`));
    ok(await w.client.upsertSession({message: {...v1('welcome'), source: message.source}}));
    expect(await commit(w.client, message, [opens(T(1))])).toBe('committed');
    // Every fixture labels its event 2026-10-12T00:00:00Z, except the two worst-case events, whose label is the
    // uint64 maximum: not a usable label, so the seed has none (T15).
    const label = name === 'event-worst' || name === 'event-size-limit' ? {} : {lastObservedUtcMs: 1_791_676_800_000};
    expect(ok(await readTripSeeds(w.client, 'ets2'))).toEqual([{tripUuid: T(1), pluginSessionId: message.source.pluginSessionId, game: 'ets2',
      jobKey: jobKey(message.data.record), startedUtcMs: BASE_UTC, recordingCompleteness: 'complete', ...label}]);
    expect(ok(await readTripSeeds(w.client, 'ats'))).toEqual([]);
    await w.close();
  });

  it('reads open trips of the game only, with the stored distance, the last label and a pending outcome', async () => {
    const a = new Script(ETS2_A), b = new Script(ATS_A, 'ats'), c = new Script(ETS2_B);
    const w = await openWorker();
    for (const s of [a, b, c]) ok(await w.client.upsertSession({message: s.welcome()}));
    // Session A, labels BASE_UTC + 1 s per event: T1 opens at 1, its job is cleared at 2 with 150 m observed, a fine at 3 has no label.
    await commit(w.client, a.event(r.jobConfigured()), [opens(T(1))]);
    await commit(w.client, a.event(r.jobCleared()), [{kind: 'trip.update', tripUuid: T(1), set: {observedDistanceM: {available: true, value: 150}}}]);
    await commit(w.client, a.event(r.fined(), {utcMs: null}));
    // ATS session: an open trip that an ETS2 cold start never sees.
    await commit(w.client, b.event(r.jobConfigured()), [opens(T(2), 'ats')]);
    // Session B: T3 is delivered (closed), T4 opens at 3 and stays active.
    await commit(w.client, c.event(r.jobConfigured()), [opens(T(3))]);
    await commit(w.client, c.event(r.delivered()), [closes(T(3), 'delivered', 'outcome')]);
    await commit(w.client, c.event(r.jobConfigured(otherJob())), [opens(T(4))]);
    const activeA = {tripUuid: T(1), pluginSessionId: ETS2_A, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: BASE_UTC, recordingCompleteness: 'complete',
      lastObservedUtcMs: BASE_UTC + 2_000, observedDistanceM: 150};
    const seedA = {...activeA, awaitingOutcome: true};
    const seedB = {tripUuid: T(4), pluginSessionId: ETS2_B, game: 'ets2', jobKey: jobKey(otherJob()), startedUtcMs: BASE_UTC, recordingCompleteness: 'complete',
      lastObservedUtcMs: BASE_UTC + 3_000};
    expect(ok(await readTripSeeds(w.client, 'ets2'))).toEqual([seedA, seedB]);
    expect(ok(await readTripSeeds(w.client, 'ats'))).toEqual([{tripUuid: T(2), pluginSessionId: ATS_A, game: 'ats', jobKey: jobKey(job()), startedUtcMs: BASE_UTC,
      recordingCompleteness: 'complete', lastObservedUtcMs: BASE_UTC + 1_000}]);
    // The re-send of the job after the clear (a save load) ends the pending outcome.
    await commit(w.client, a.event(r.jobConfigured()));
    expect(ok(await readTripSeeds(w.client, 'ets2'))).toEqual([{...activeA, lastObservedUtcMs: BASE_UTC + 4_000}, seedB]);
    await w.close();
  });
});
