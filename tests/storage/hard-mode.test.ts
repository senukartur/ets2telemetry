// Real storage worker/temp SQLite checks. No real game directories or application history are opened.
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import type {HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {EventRecord} from '../../packages/contracts/src/protocol-v1';
import {TripExportSerializer, tripExportHeader} from '../../apps/desktop/src/journal-export';
import {tripExportProblems} from '../shared/trip-export-validator';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {ETS2_A, Script, r} from '../shared/trip-messages';
import {readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
function ok<T>(result: {ok: true; value: T} | {ok: false; error: {code: string}}): T {if (!result.ok) throw new Error(result.error.code); return result.value;}
let ws: Awaited<ReturnType<typeof workspace>>, worker: Worker, client: StorageClient;
beforeEach(async () => {
  ws = await workspace(); const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
  if (!bundles) throw new Error('Run npm run test:storage');
  worker = new Worker(path.join(bundles, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
  client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
  ok(await client.open({path: ws.database, backupsDirectory: ws.backups, appVersion: 'test-et026', purpose: 'synthetic'}));
});
afterEach(async () => {await client.close(); await worker.terminate(); await ws.dispose();});
function evidence(config = HARD_MODE_CONFIG): HardModeObservation {
  return {assessment: evaluateHardMode(parseHardModeConfig(config), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: ETS2_A, sourceMonotonicNs: '1'};
}
const manual = (): EventRecord => {const d = r.delivered(); if (d.type !== 'job.delivered') throw new Error('fixture'); return {...d, autoParkUsed: {available: true, value: false}};};
async function setup() {
  const script = new Script(ETS2_A); let current = evidence(), reads = 0;
  const recorder = new TripRecorderSink(client, {hardModeEvidence: () => {reads++; return structuredClone(current);}});
  ok(await recorder.openSession(script.welcome()));
  const send = async (record: EventRecord) => {const message = script.event(record); ok(await recorder.commit(message, {receivedUtcMs: Date.now()})); return message;};
  await send(r.jobConfigured());
  const trips = ok(await client.listTrips()).trips;
  expect(trips).toHaveLength(1);
  return {script, recorder, send, trip: trips[0].tripUuid, set: (v: HardModeObservation) => {current = v;}, reads: () => reads};
}
describe('ET-026 worker classification (REG-001/003/005/006/007/014)', () => {
  it('qualifies a compliant manual delivery, reconciles SQL and exports typed v2', async () => {
    const f = await setup(); await f.send(manual());
    const trip = ok(await client.getTrip(f.trip)); expect(trip).toMatchObject({outcome: 'delivered', isHardMode: true, hardModeDetails: {manualDelivery: true, firstLoss: null}});
    const detail = ok(await client.journalTrip(f.trip)); expect(detail.trip.isHardMode).toBe(true);
    const page = ok(await client.journalTrips()); expect(page.trips[0].isHardMode).toBe(true);
    const header = tripExportHeader({uuid: '30000000-0000-4000-8000-000000000001', purpose: 'synthetic', schemaVersion: 3}, 'test', Date.now());
    const serializer = new TripExportSerializer(detail, header), text = serializer.begin() + serializer.rows('intervals', ok(await client.journalIntervals(f.trip, {limit: 500})).intervals) + serializer.rows('events', ok(await client.journalEvents(f.trip, {limit: 500})).events) + serializer.end();
    const exported = JSON.parse(text) as {formatVersion: number; trip: {is_hard_mode: boolean}}; expect(exported.formatVersion).toBe(3); expect(exported.trip.is_hard_mode).toBe(true); expect(tripExportProblems(exported)).toEqual([]);
    expect(await client.close()).toEqual({clean: true});
    readOnly(ws.database, db => expect(db.prepare("SELECT outcome, is_hard_mode, json_extract(hard_mode_details, '$.manualDelivery') AS manual FROM trips").get()).toEqual({outcome: 'delivered', is_hard_mode: 1, manual: 1}));
  });
  it.each(['failed', 'unknown', 'source-changed'] as const)('irreversibly loses %s evidence and preserves first loss through later compliant observations', async kind => {
    const f = await setup();
    const bad = evidence(kind === 'failed' ? HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"') : HARD_MODE_CONFIG);
    if (kind === 'unknown') bad.assessment = unknownHardMode(Date.now(), 'interrupted');
    if (kind === 'source-changed') bad.binding = 'b'.repeat(64);
    ok(await client.observeHardMode('ets2', bad, true));
    const first = ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss;
    ok(await client.observeHardMode('ets2', evidence(), true)); await f.send(manual());
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: first}}); expect(first).not.toBeNull();
    if (kind === 'failed') {expect(first!.values).toEqual([0]); expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.latest.rules[3].values).toEqual([1]);}
  });
  it.each([false, true])('publishes latest through UTC rollback and preserves it against frozen closing proof (restore=%s)', async restore => {
    const f = await setup(), last = f.script.event(manual()), capture = f.recorder.capture(last)!;
    const observedUtcMs = capture.observation.assessment.observedUtcMs - 120_000;
    const failure = evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')); failure.assessment.observedUtcMs = observedUtcMs;
    ok(await client.observeHardMode('ets2', failure, true));
    const first = ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss;
    expect(first).toMatchObject({atUtcMs: observedUtcMs, rule: 'fatigue', values: [0]});
    let expected = failure.assessment;
    expect(ok(await client.journalTrip(f.trip)).trip.hardModeDetails!.latest).toEqual(expected);
    if (restore) {
      const passing = evidence(); passing.assessment.observedUtcMs = observedUtcMs - 1000;
      ok(await client.observeHardMode('ets2', passing, true)); expected = passing.assessment;
    }
    ok(await f.recorder.commit(last, {receivedUtcMs: Date.now(), hardModeCapture: capture}));
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {latest: expected, firstLoss: first}});
    const detail = ok(await client.journalTrip(f.trip)); expect(detail.trip.hardModeDetails!.latest).toEqual(expected);
    const serializer = new TripExportSerializer(detail, tripExportHeader({uuid: '30000000-0000-4000-8000-000000000001', purpose: 'synthetic', schemaVersion: 3}, 'test', Date.now()));
    const text = serializer.begin() + serializer.rows('intervals', ok(await client.journalIntervals(f.trip, {limit: 500})).intervals) + serializer.rows('events', ok(await client.journalEvents(f.trip, {limit: 500})).events) + serializer.end();
    const exported = JSON.parse(text) as {trip: {hard_mode_details: {latest: unknown; firstLoss: unknown}}};
    expect(exported.trip.hard_mode_details).toMatchObject({latest: expected, firstLoss: first}); expect(tripExportProblems(exported)).toEqual([]);
  });
  it.each(['automatic', 'unavailable'] as const)('requires explicit manual delivery rather than %s autoparking evidence', async kind => {
    const f = await setup(), d = manual(); if (d.type !== 'job.delivered') throw new Error('fixture');
    await f.send({...d, autoParkUsed: kind === 'automatic' ? {available: true, value: true} : {available: false, reason: 'not-supported'}});
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: {reason: 'parking-unproven'}}});
  });
  it('requires an explicit validated freshness verdict and never discards negative evidence with a false verdict', async () => {
    const f = await setup(), message = f.script.event(r.fined());
    const invalid = await client.commitEvent({message, hardMode: evidence(), hardModeFresh: 'true' as unknown as boolean}); expect(invalid.ok).toBe(false);
    expect(ok(await client.committedThrough(ETS2_A))).toBe('1');
    ok(await f.recorder.commit(message, {receivedUtcMs: Date.now()}));
    ok(await client.observeHardMode('ets2', evidence()));
    expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss).toMatchObject({reason: 'interrupted'});
    await f.send(manual()); expect(ok(await client.getTrip(f.trip))!.isHardMode).toBe(false);
  });
  it('does not qualify cancellation, redelivered openings or older queued events from current files', async () => {
    const script = new Script(ETS2_A); ok(await client.upsertSession({message: script.welcome()}));
    const opened = script.event(r.jobConfigured()), obs = evidence(); obs.sourceMonotonicNs = (BigInt(opened.capture.monotonicNs) + 1n).toString();
    const id = '70000000-0000-4000-8000-000000000001';
    ok(await client.commitEvent({message: opened, hardMode: obs, hardModeFresh: true, effects: [{kind: 'trip.open', tripUuid: id, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: Date.now()}]}));
    expect(ok(await client.getTrip(id))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: {reason: 'historical'}}});
    const cancelled = script.event(r.cancelled());
    ok(await client.commitEvent({message: cancelled, hardMode: evidence(), hardModeFresh: true, effects: [{kind: 'trip.close', tripUuid: id, outcome: 'cancelled', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: Date.now()}]}));
    expect(ok(await client.getTrip(id))!.isHardMode).toBe(false);
  });
  it('keeps loss across worker restart and duplicate delivery without changing coverage', async () => {
    const f = await setup(); ok(await client.observeHardMode('ets2', {...evidence(), assessment: unknownHardMode(Date.now(), 'interrupted')}));
    const first = ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss;
    const delivered = await f.send(manual()); expect(ok(await client.commitEvent({message: delivered, hardMode: evidence()})).status).toBe('duplicate');
    expect(await client.close()).toEqual({clean: true}); await worker.terminate();
    worker = new Worker(path.join(process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES!, 'storage-worker.cjs'), {workerData: {kind: 'storage'}}); client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, backupsDirectory: ws.backups, appVersion: 'test-et026', purpose: 'synthetic'}));
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: first}});
    expect(ok(await client.committedThrough(ETS2_A))).toBe(delivered.data.eventSeq);
  });
  it('latches a cold recorder interruption with identical source/binding before resuming the open trip', async () => {
    const f = await setup(); expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss).toBeNull();
    const replacement = new TripRecorderSink(client, {hardModeEvidence: () => evidence()});
    ok(await replacement.openSession(f.script.welcome()));
    const details = ok(await client.getTrip(f.trip))!.hardModeDetails!;
    expect(details.firstLoss).not.toBeNull();
    ok(await client.observeHardMode('ets2', evidence(), true));
    expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss).toEqual(details.firstLoss);
  });
  it('stores a pending observed loss before delivery after an observation-write failure, retaining the original value', async () => {
    const f = await setup(), original = client.observeHardMode.bind(client); let failed = false;
    client.observeHardMode = (game, observation, fresh) => {if (!failed) {failed = true; return Promise.resolve({ok: false, error: {code: 'IO_ERROR', retryable: true, message: 'Injected'}});} return original(game, observation, fresh);};
    f.recorder.observeHardMode('ets2', evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')));
    f.set(evidence()); await f.send(manual());
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: {rule: 'fatigue', values: [0]}}});
  });
  it('freezes evidence on a failed commit and reuses it on retry rather than reading newer files', async () => {
    const f = await setup(), original = client.commitEvent.bind(client); let failed = false;
    client.commitEvent = input => {if (!failed) {failed = true; return Promise.resolve({ok: false, error: {code: 'IO_ERROR', retryable: true, message: 'Injected'}});} return original(input);};
    const delivery = f.script.event(manual()); const before = f.reads();
    expect((await f.recorder.commit(delivery, {receivedUtcMs: Date.now()})).ok).toBe(false);
    f.set({...evidence(), assessment: unknownHardMode(Date.now())});
    ok(await f.recorder.commit(delivery, {receivedUtcMs: Date.now()})); expect(f.reads()).toBe(before + 1);
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: true});
  });
});
