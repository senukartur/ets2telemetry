// ET-016 PR-7 (J9, J22): openAttachedTrip through the in-process storage core and the bundled storage worker, against
// temporary synthetic databases. Expected rows are written by hand from docs/storage.md (openAttachedTrip), docs/trips.md
// (late-attach trips) and the AttachInput contract; none is read back from the reducer or the command. Runs under
// npm run test:storage.
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {AttachInput, Storage, TripEffect} from '../../packages/storage/src/index';
import {BASE_UTC, ETS2_A, ETS2_B, Script, job, r} from '../shared/trip-messages';
import {failed, ok, readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
const workers: Worker[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.terminate())); await ws.dispose(); });

/** The late-attach UUID (J9) written independently of the reducer: the T4 shape over its own prefix. */
const attachUuid = (session: string, nextEventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-attach-v1:${session}:${nextEventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const MODE = {mode: 'single-player', method: 'module-scan', confidence: 'weak'} as const;
const NOT_OBSERVED = {available: false, reason: 'not-observed'} as const;
const open = (tripUuid: string, extra: Partial<Extract<TripEffect, {kind: 'trip.open'}>> = {}): TripEffect =>
  ({kind: 'trip.open', tripUuid, game: 'ets2', gameMode: MODE, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: BASE_UTC, ...extra});
const lateAttach = (tripUuid: string, nextEventSeq: string): TripEffect =>
  ({kind: 'completeness.add', interval: {tripUuid, kind: 'not-connected', detail: {cause: 'late-attach', source: 'checkpoint', nextEventSeq}}});
const attachInput = (pluginSessionId: string, nextEventSeq: string, overrides: Partial<AttachInput> = {}): AttachInput => {
  const trip = attachUuid(pluginSessionId, nextEventSeq);
  return {pluginSessionId, nextEventSeq, job: job(), effects: [open(trip), lateAttach(trip, nextEventSeq)], ...overrides};
};
/** Session A with eventSeq 1 and 2 committed (a pause and a fine, no trip), so coverage is 2. */
function sessionWithCoverage(storage: Storage) {
  const s = new Script(ETS2_A);
  ok(storage.upsertSession({message: s.welcome()}));
  ok(storage.commitEvent({message: s.event(r.paused(), {simulation: 'paused'})}));
  ok(storage.commitEvent({message: s.event(r.fined()), effects: [{kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'}]}));
  return s;
}
const counts = (file: string) => readOnly(file, db => Object.fromEntries(['job_configurations', 'trips', 'completeness_intervals', 'events']
  .map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n])));

describe('openAttachedTrip (J9)', () => {
  it('stores the checkpoint job and an open trip with no opening event, applies its intervals and leaves coverage unchanged', async () => {
    const storage = await ws.open(), s = sessionWithCoverage(storage), trip = attachUuid(ETS2_A, '3');
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '3')))).toEqual({status: 'committed'});
    expect(ok(storage.committedThrough(ETS2_A))).toBe('2');
    expect(ok(storage.getTrip(trip))).toEqual({tripUuid: trip, pluginSessionId: ETS2_A, game: 'ets2', gameMode: MODE, gameModeAmbiguous: false,
      jobSource: 'checkpoint', jobConfigurationEventSeq: null, checkpointJob: {nextEventSeq: '3', values: job()}, truckConfigurationEventSeq: null, trailerConfigurationEventSeqs: [],
      openedBy: 'checkpoint', openedEventSeq: null, outcome: 'open', outcomeEventSeq: null, closeReason: null, recordingCompleteness: 'partial', startedUtcMs: BASE_UTC,
      endedUtcMs: null, observedDistanceM: NOT_OBSERVED, fuelUsedL: NOT_OBSERVED, createdUtcMs: expect.any(Number), updatedUtcMs: expect.any(Number)});
    // A later event commit of the session refers to the trip like any other: the live fine is attributed to it.
    ok(storage.commitEvent({message: s.event(r.fined()), effects: [{kind: 'event.attribute', tripUuid: trip, attribution: 'trip'}]}));
    storage.close();
    readOnly(ws.database, db => {
      expect(db.prepare(`SELECT j.source, j.event_ref, j.checkpoint_next_event_seq, s.plugin_session_uuid AS session, j.cargo_id FROM job_configurations j
        JOIN plugin_sessions s ON s.id = j.plugin_session_ref`).all()).toEqual([{source: 'checkpoint', event_ref: null, checkpoint_next_event_seq: '00000000000000000003', session: ETS2_A,
        cargo_id: (job().cargoId as {value: string}).value}]);
      expect(db.prepare('SELECT opened_by, opened_event_ref FROM trips').all()).toEqual([{opened_by: 'checkpoint', opened_event_ref: null}]);
      expect(db.prepare('SELECT kind, first_event_seq, detail_json FROM completeness_intervals').all())
        .toEqual([{kind: 'not-connected', first_event_seq: null, detail_json: '{"cause":"late-attach","nextEventSeq":"3","source":"checkpoint"}'}]);
    });
  });
  it('is a duplicate for the same session and nextEventSeq: nothing is written again (restart idempotence)', async () => {
    const storage = await ws.open();
    sessionWithCoverage(storage);
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '3')))).toEqual({status: 'committed'});
    // The same attach, as a retry or after a service restart, even with a different trip UUID in its effects.
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '3')))).toEqual({status: 'duplicate'});
    const other = '7a000000-0000-4000-8000-000000000001';
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '3', {effects: [open(other), lateAttach(other, '3')]})))).toEqual({status: 'duplicate'});
    expect(ok(storage.listTrips()).trips.map(t => t.tripUuid)).toEqual([attachUuid(ETS2_A, '3')]);
    storage.close();
    expect(counts(ws.database)).toEqual({job_configurations: 1, trips: 1, completeness_intervals: 1, events: 2});
  });
  it('accepts nextEventSeq up to the coverage + 1 and refuses beyond it, 0 and non-canonical numbers', async () => {
    const storage = await ws.open();
    sessionWithCoverage(storage);
    // 4 is beyond coverage 2 + 1: an attach before the replayed events drained (RED: attach before drain).
    for (const next of ['4', '0', '03', '-1', '18446744073709551616']) failed(storage.openAttachedTrip(attachInput(ETS2_A, next)), 'INVALID_INPUT');
    // The bound is the only order check storage makes: 1 and 3 are both at or below coverage + 1.
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '1')))).toEqual({status: 'committed'});
    expect(ok(storage.openAttachedTrip(attachInput(ETS2_A, '3')))).toEqual({status: 'committed'});
    failed(storage.openAttachedTrip(attachInput('10000000-0000-4000-8000-0000000000ff', '1')), 'UNKNOWN_SESSION');
    storage.close();
  });
  it('refuses a malformed job or effect list and writes nothing', async () => {
    const storage = await ws.open();
    sessionWithCoverage(storage);
    const trip = attachUuid(ETS2_A, '3'), withJob = (change: (j: Record<string, unknown>) => void) => { const j = structuredClone(job()) as unknown as Record<string, unknown>; change(j); return j as unknown as JobConfiguration; };
    const cases: [string, Partial<AttachInput>][] = [
      ['an extra job field', {job: withJob(j => { j.extra = {available: false, reason: 'not-observed'}; })}],
      ['a missing job field', {job: withJob(j => { delete j.cargo; })}],
      ['a measure without its unit', {job: withJob(j => { delete (j.cargoMass as Record<string, unknown>).unit; })}],
      ['a wrong unit', {job: withJob(j => { (j.plannedDistance as Record<string, unknown>).unit = 'km'; })}],
      ['a unit on a field without one', {job: withJob(j => { (j.cargoUnitCount as Record<string, unknown>).unit = 'count'; })}],
      ['a text value that is a number', {job: withJob(j => { j.cargo = {available: true, value: 7}; })}],
      ['an unknown reason', {job: withJob(j => { j.cargo = {available: false, reason: 'missing'}; })}],
      ['money of the wrong SDK type', {job: withJob(j => { j.expectedIncome = {available: true, value: {raw: '5', sdkType: 's64', currency: {status: 'unknown'}}}; })}],
      ['a currency without its source', {job: withJob(j => { j.expectedIncome = {available: true, value: {raw: '5', sdkType: 'u64', currency: {status: 'sdk-documented', code: 'EUR'}}}; })}],
      ['deadline minutes beyond u32', {job: withJob(j => { j.deliveryDeadline = {available: true, value: '4294967296', unit: 'min'}; })}],
      ['no effects', {effects: []}],
      ['no trip.open', {effects: [lateAttach(trip, '3')]}],
      ['a job reference to an event', {effects: [open(trip, {jobConfiguration: {eventSeq: '1'}})]}],
      ['a truck reference (J22)', {effects: [open(trip, {truckConfiguration: {eventSeq: '1'}})]}],
      ['a trailer reference (J22)', {effects: [open(trip, {trailerConfigurations: [{eventSeq: '1'}]})]}],
      ['an attribution', {effects: [open(trip), {kind: 'event.attribute', tripUuid: trip, attribution: 'trip'}]}],
      ['an interval of another trip after the open', {effects: [open(trip), {kind: 'completeness.add', interval: {tripUuid: null, kind: 'not-connected'}}]}],
      ['a close with an outcome', {effects: [{kind: 'trip.close', tripUuid: trip, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: BASE_UTC}, open(trip)]}],
      ['a trip of another game', {effects: [open(trip, {game: 'ats'})]}]
    ];
    for (const [name, overrides] of cases) expect(failed(storage.openAttachedTrip(attachInput(ETS2_A, '3', overrides)), 'INVALID_INPUT').code, name).toBe('INVALID_INPUT');
    storage.close();
    expect(counts(ws.database)).toEqual({job_configurations: 0, trips: 0, completeness_intervals: 0, events: 2});
  });
  it('applies queued lifecycle effects first: an earlier session\'s trip closes as restart with this session and nextEventSeq as its carrier (J7)', async () => {
    const storage = await ws.open(), a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), old = '7b000000-0000-4000-8000-000000000001';
    ok(storage.upsertSession({message: a.welcome()}));
    ok(storage.commitEvent({message: a.event(r.jobConfigured()), effects: [{kind: 'trip.open', tripUuid: old, game: 'ets2', gameMode: MODE, jobConfiguration: 'this-event',
      recordingCompleteness: 'unknown', startedUtcMs: BASE_UTC + 1_000}]}));
    ok(storage.upsertSession({message: b.welcome()}));
    const next = attachUuid(ETS2_B, '1');
    expect(ok(storage.openAttachedTrip({pluginSessionId: ETS2_B, nextEventSeq: '1', job: job(), effects: [
      {kind: 'trip.close', tripUuid: old, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 1_000},
      open(next), lateAttach(next, '1'),
      {kind: 'completeness.add', interval: {tripUuid: next, kind: 'discontinuity', detail: {cause: 'restart', continuationOf: old, decision: 'not-merged', source: 'checkpoint', nextEventSeq: '1'}}}]})))
      .toEqual({status: 'committed'});
    expect(ok(storage.listTrips()).trips.map(t => [t.tripUuid, t.outcome, t.closeReason, t.openedBy])).toEqual([[old, 'none', 'restart', 'event'], [next, 'open', null, 'checkpoint']]);
    // The restart close records session B and nextEventSeq 1, so the journal window of the old trip ends with its session.
    expect(ok(storage.journalTrip(old)).trip.closedBy).toEqual({pluginSessionId: ETS2_B, eventSeq: '1'});
    expect(ok(storage.journalTrip(old)).window).toEqual({known: true, pluginSessionId: ETS2_A, fromEventSeq: '1', throughEventSeq: null, end: 'end-of-session'});
    storage.close();
  });
  it('crosses the worker boundary with only its four input fields and the exact result shape', async () => {
    const worker = new Worker(path.join(process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES!, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    workers.push(worker);
    const exit = once(worker, 'exit'), client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
    const s = new Script(ETS2_A);
    ok(await client.upsertSession({message: s.welcome()}));
    expect(ok(await client.openAttachedTrip(attachInput(ETS2_A, '1')))).toEqual({status: 'committed'});
    expect(ok(await client.openAttachedTrip(attachInput(ETS2_A, '1')))).toEqual({status: 'duplicate'});
    expect(ok(await client.getTrip(attachUuid(ETS2_A, '1')))).toMatchObject({openedBy: 'checkpoint', jobSource: 'checkpoint', checkpointJob: {nextEventSeq: '1', values: job()}});
    // The client copies only the four fields, so an in-process extra never reaches the worker.
    const extra = {...attachInput(ETS2_A, '1'), testHooks: {}} as AttachInput;
    expect(ok(await client.openAttachedTrip(extra))).toEqual({status: 'duplicate'});
    expect(await client.close()).toEqual({clean: true});
    await exit;
  });
});
