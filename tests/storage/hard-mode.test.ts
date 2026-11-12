// Real storage worker/temp SQLite checks. No real game directories or application history are opened.
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import type {HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {EventRecord} from '../../packages/contracts/src/protocol-v1';
import {TripExportSerializer, tripExportHeader} from '../../apps/desktop/src/journal-export';
import {hardModeView} from '../../apps/desktop/src/hard-mode/view';
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
let checkSequence = 0;
const check = () => ({producer: '90000000-0000-4000-8000-000000000001', sequence: ++checkSequence});
function evidence(config = HARD_MODE_CONFIG): HardModeObservation {
  return {check: check(), assessment: evaluateHardMode(parseHardModeConfig(config), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: ETS2_A, sourceMonotonicNs: '1'};
}
async function audit(trip: string) {const details = ok(await client.getTrip(trip))!.hardModeDetails; if (details?.version !== 2) throw new Error('Expected v2'); return details;}
const manual = (): EventRecord => {const d = r.delivered(); if (d.type !== 'job.delivered') throw new Error('fixture'); return {...d, autoParkUsed: {available: true, value: false}};};
async function setup() {
  const script = new Script(ETS2_A); let current = evidence(), reads = 0;
  const recorder = new TripRecorderSink(client, {hardModeEvidence: () => {reads++; return structuredClone(current);}});
  ok(await recorder.openSession(script.welcome()));
  const send = async (record: EventRecord) => {const message = script.event(record); ok(await recorder.commit(message, {receivedUtcMs: Date.now()})); return message;};
  await send(r.jobConfigured());
  const trips = ok(await client.listTrips()).trips;
  expect(trips).toHaveLength(1);
  const counts = {passingChecks:1, failingChecks:0, unknownChecks:0};
  const observe = (value: HardModeObservation, fresh = true) => {
    counts[value.assessment.state === 'pass' ? 'passingChecks' : value.assessment.state === 'fail' ? 'failingChecks' : 'unknownChecks']++;
    return client.observeHardMode('ets2', {...value, member: trips[0].tripUuid, batch:{tripUuid:trips[0].tripUuid, producer:'90000000-0000-4000-8000-000000000002', sequence:counts.passingChecks+counts.failingChecks+counts.unknownChecks-1,
      passingChecks:counts.passingChecks-1,failingChecks:counts.failingChecks,unknownChecks:counts.unknownChecks}}, fresh);
  };
  return {script, recorder, send, observe, trip: trips[0].tripUuid, set: (v: HardModeObservation) => {current = v;}, reads: () => reads};
}
describe('ET-026 worker classification (REG-001/003/005/006/007/014)', () => {
  it.each(['manual', 'automatic', 'unavailable'] as const)('qualifies compliant settings with %s parking, reconciles SQL and exports typed v5', async kind => {
    const f = await setup(), d = manual(); if (d.type !== 'job.delivered') throw new Error('fixture');
    await f.send({...d, autoParkUsed: kind === 'unavailable' ? {available: false, reason: 'not-supported'} : {available: true, value: kind === 'automatic'}});
    const trip = ok(await client.getTrip(f.trip)); expect(trip).toMatchObject({outcome: 'delivered', isHardMode: true, hardModeDetails: {manualDelivery: null, firstLoss: null}});
    const detail = ok(await client.journalTrip(f.trip)); expect(detail.trip.isHardMode).toBe(true);
    expect(detail.outcomeDetails?.record).toMatchObject({autoParkUsed: kind === 'unavailable' ? {available: false, reason: 'not-supported'} : {available: true, value: kind === 'automatic'}});
    const page = ok(await client.journalTrips()); expect(page.trips[0].isHardMode).toBe(true);
    const header = tripExportHeader({uuid: '30000000-0000-4000-8000-000000000001', purpose: 'synthetic', schemaVersion: 6}, 'test', Date.now());
    const serializer = new TripExportSerializer(detail, header), text = serializer.begin() + serializer.rows('sources', ok(await client.journalIntervals(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.sources})).sources!) + serializer.rows('intervals', ok(await client.journalIntervals(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.intervals})).intervals) + serializer.rows('events', ok(await client.journalEvents(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.events})).events) + serializer.end();
    const exported = JSON.parse(text) as {formatVersion: number; trip: {is_hard_mode: boolean; hard_mode_details: {manualDelivery: null}}}; expect(exported.formatVersion).toBe(6); expect(exported.trip.is_hard_mode).toBe(true); expect(exported.trip.hard_mode_details.manualDelivery).toBeNull(); expect(tripExportProblems(exported)).toEqual([]);
    for (const manualDelivery of [null, true, false]) {
      const variant = {...exported, trip: {...exported.trip, hard_mode_details: {...exported.trip.hard_mode_details, manualDelivery}}};
      expect(tripExportProblems(variant)).toEqual(manualDelivery !== null ? ['$.trip.hard_mode_details: malformed v2'] : []);
      if (manualDelivery === false) expect(tripExportProblems({...variant, trip: {...variant.trip, is_hard_mode: false}})).toContain('$.trip.hard_mode_details: malformed v2');
    }
    expect(await client.close()).toEqual({clean: true});
    readOnly(ws.database, db => expect(db.prepare("SELECT outcome, is_hard_mode, json_extract(hard_mode_details, '$.manualDelivery') AS manual FROM trips").get()).toEqual({outcome: 'delivered', is_hard_mode: 1, manual: null}));
  });
  it.each(['truck', 'trailer'] as const)('keeps the original raw %s stability diagnostic through restoration and export', async id => {
    const f = await setup(), raw = id === 'truck' ? 0.255 : 0.26;
    const failed = evidence(HARD_MODE_CONFIG.replace(`g_${id}_stability "0.25"`, `g_${id}_stability "${raw}"`));
    ok(await f.observe( failed, true));
    ok(await f.observe( evidence(), true)); await f.send(manual());
    const trip = ok(await client.getTrip(f.trip))!;
    expect(trip).toMatchObject({isHardMode: false, hardModeDetails: {firstDiagnostic: {rule: id, values: [raw]}, manualDelivery: null}});
    const detail = ok(await client.journalTrip(f.trip));
    const serialized = new TripExportSerializer(detail, tripExportHeader({uuid: '30000000-0000-4000-8000-000000000001', purpose: 'synthetic', schemaVersion: 6}, 'test', Date.now())).begin();
    expect(serialized).toContain(`"values":[${raw}]`);
    expect(await client.close()).toEqual({clean: true});
    readOnly(ws.database, db => expect(db.prepare("SELECT json_extract(hard_mode_details, '$.firstDiagnostic.values[0]') AS raw FROM trips").get()).toEqual({raw}));
  });
  it('keeps a cancelled trip unqualified despite continuous passing settings', async () => {
    const f = await setup(); await f.send(r.cancelled());
    expect(ok(await client.getTrip(f.trip))).toMatchObject({outcome: 'cancelled', isHardMode: false, hardModeDetails: {firstLoss: null, manualDelivery: null}});
  });
  it.each([false, true])('preserves saved qualification and legacy parking evidence across reopen (qualified=%s)', async qualified => {
    const f = await setup(); await f.send(manual());
    const saved = advanceHardMode(null, ok(await client.getTrip(f.trip))!.hardModeDetails!.opening);
    for (const assessment of [saved.opening, saved.latest]) {
      for (const rule of assessment.rules) if (rule.id === 'truck' || rule.id === 'trailer') rule.values = [0.5];
      assessment.rules[7].values = [0, 2];
    }
    saved.manualDelivery = qualified;
    saved.firstLoss = qualified ? null : {atUtcMs: 1000, reason: 'parking-unproven', rule: null, values: null};
    expect(await client.close()).toEqual({clean: true}); await worker.terminate();
    // Emulate earlier saved audits only in this test's temporary database; frozen historical fixtures stay untouched.
    const db = new Database(ws.database), text = JSON.stringify(saved);
    try {
      db.prepare('UPDATE trips SET is_hard_mode = ?, hard_mode_details = ?').run(qualified ? 1 : 0, text);
      db.prepare('UPDATE logical_trips SET hard_mode_lost = ?, first_loss_json = ?').run(qualified ? 0 : 1, saved.firstLoss === null ? null : JSON.stringify(saved.firstLoss));
      db.prepare("UPDATE logical_projection_states SET row_json = json_set(row_json, '$.is_hard_mode', json(?), '$.hard_mode_details', ?) WHERE id = (SELECT state_ref FROM logical_revisions ORDER BY id DESC LIMIT 1)")
        .run(JSON.stringify({$integer: qualified ? '1' : '0'}), text);
    } finally {db.close();}
    worker = new Worker(path.join(process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES!, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, backupsDirectory: ws.backups, appVersion: 'test-et026', purpose: 'synthetic'}));
    ok(await f.observe( evidence(), true));
    const trip = ok(await client.getTrip(f.trip))!;
    expect(trip).toMatchObject({isHardMode: qualified, hardModeDetails: saved});
    expect(ok(await client.journalTrips()).trips[0].isHardMode).toBe(qualified);
    const audit = ok(await client.journalTrip(f.trip)).trip.hardModeDetails!;
    expect(audit).toEqual(saved);
    const before = structuredClone(audit);
    expect(hardModeView({assessment: audit.latest, trip: audit}, 2000).rows[5]).toMatchObject({state: 'pass', detected: '100% (0.5)'});
    expect(audit).toEqual(before);
    expect(await client.close()).toEqual({clean: true});
    readOnly(ws.database, sql => expect(sql.prepare('SELECT is_hard_mode, hard_mode_details FROM trips').get()).toEqual({is_hard_mode: qualified ? 1 : 0, hard_mode_details: text}));
  });
  it.each(['failed', 'unknown', 'source-changed'] as const)('counts %s evidence and preserves diagnostics through later compliant observations', async kind => {
    const f = await setup();
    const bad = evidence(kind === 'failed' ? HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"') : HARD_MODE_CONFIG);
    if (kind === 'unknown') bad.assessment = unknownHardMode(Date.now(), 'interrupted');
    if (kind === 'source-changed') bad.binding = 'b'.repeat(64);
    ok(await f.observe( bad, true));
    const first = (await audit(f.trip)).firstDiagnostic;
    ok(await f.observe( evidence(), true)); await f.send(manual());
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: kind !== 'failed', hardModeDetails: {firstDiagnostic: first}}); expect(first).not.toBeNull();
    if (kind === 'failed') {expect(first!.values).toEqual([0]); expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.latest.rules[3].values).toEqual([1]);}
  });
  it.each([false, true])('publishes latest through UTC rollback and preserves it against frozen closing proof (restore=%s)', async restore => {
    const f = await setup(), last = f.script.event(manual()), capture = f.recorder.capture(last)!;
    const observedUtcMs = capture.observation.assessment.observedUtcMs - 120_000;
    const failure = evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')); failure.assessment.observedUtcMs = observedUtcMs;
    ok(await f.observe( failure, true));
    const first = (await audit(f.trip)).firstDiagnostic;
    expect(first).toMatchObject({atUtcMs: observedUtcMs, rule: 'fatigue', values: [0]});
    let expected = failure.assessment;
    expect(ok(await client.journalTrip(f.trip)).trip.hardModeDetails!.latest).toEqual(expected);
    if (restore) {
      const passing = evidence(); passing.assessment.observedUtcMs = observedUtcMs - 1000;
      ok(await f.observe( passing, true)); expected = passing.assessment;
    }
    ok(await f.recorder.commit(last, {receivedUtcMs: Date.now(), hardModeCapture: capture}));
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {latest: expected, firstDiagnostic: first}});
    const detail = ok(await client.journalTrip(f.trip)); expect(detail.trip.hardModeDetails!.latest).toEqual(expected);
    const serializer = new TripExportSerializer(detail, tripExportHeader({uuid: '30000000-0000-4000-8000-000000000001', purpose: 'synthetic', schemaVersion: 6}, 'test', Date.now()));
    const text = serializer.begin() + serializer.rows('sources', ok(await client.journalIntervals(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.sources})).sources!) + serializer.rows('intervals', ok(await client.journalIntervals(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.intervals})).intervals) + serializer.rows('events', ok(await client.journalEvents(f.trip, {limit: 500, cursor: detail.exportBounds.snapshot!.events})).events) + serializer.end();
    const exported = JSON.parse(text) as {trip: {hard_mode_details: {latest: unknown; firstDiagnostic: unknown}}};
    expect(exported.trip.hard_mode_details).toMatchObject({latest: expected, firstDiagnostic: first}); expect(tripExportProblems(exported)).toEqual([]);
  });
  it('requires an explicit validated freshness verdict and never discards negative evidence with a false verdict', async () => {
    const f = await setup(), message = f.script.event(r.fined());
    const invalid = await client.commitEvent({message, hardMode: evidence(), hardModeFresh: 'true' as unknown as boolean}); expect(invalid.ok).toBe(false);
    expect(ok(await client.committedThrough(ETS2_A))).toBe('1');
    ok(await f.recorder.commit(message, {receivedUtcMs: Date.now()}));
    ok(await f.observe(evidence(), false));
    expect((await audit(f.trip)).latestDiagnostic).toMatchObject({code: 'profile-verification'});
    await f.send(manual()); expect(ok(await client.getTrip(f.trip))!.isHardMode).toBe(true);
  });
  it('does not qualify cancellation, redelivered openings or older queued events from current files', async () => {
    const script = new Script(ETS2_A); ok(await client.upsertSession({message: script.welcome()}));
    const opened = script.event(r.jobConfigured()), obs = evidence(); obs.sourceMonotonicNs = (BigInt(opened.capture.monotonicNs) + 1n).toString();
    const id = '70000000-0000-4000-8000-000000000001';
    ok(await client.commitEvent({message: opened, hardMode: obs, hardModeFresh: true, effects: [{kind: 'trip.open', tripUuid: id, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: Date.now()}]}));
    expect(ok(await client.getTrip(id))).toMatchObject({isHardMode: false, hardModeDetails: {firstLoss: null, opening: {state:'unknown'}, passingChecks:0}});
    const cancelled = script.event(r.cancelled());
    ok(await client.commitEvent({message: cancelled, hardMode: evidence(), hardModeFresh: true, effects: [{kind: 'trip.close', tripUuid: id, outcome: 'cancelled', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: Date.now()}]}));
    expect(ok(await client.getTrip(id))!.isHardMode).toBe(false);
  });
  it('keeps loss across worker restart and duplicate delivery without changing coverage', async () => {
    const f = await setup(); ok(await f.observe( {...evidence(), assessment: unknownHardMode(Date.now(), 'interrupted')}));
    const first = (await audit(f.trip)).firstDiagnostic;
    const delivered = await f.send(manual()); expect(ok(await client.commitEvent({message: delivered, hardMode: evidence()})).status).toBe('duplicate');
    expect(await client.close()).toEqual({clean: true}); await worker.terminate();
    worker = new Worker(path.join(process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES!, 'storage-worker.cjs'), {workerData: {kind: 'storage'}}); client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, backupsDirectory: ws.backups, appVersion: 'test-et026', purpose: 'synthetic'}));
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: true, hardModeDetails: {firstDiagnostic: first}});
    expect(ok(await client.committedThrough(ETS2_A))).toBe(delivered.data.eventSeq);
  });
  it('tolerates a cold recorder interruption with identical source/binding before resuming the open trip', async () => {
    const f = await setup(); expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss).toBeNull();
    const replacement = new TripRecorderSink(client, {hardModeEvidence: () => evidence()});
    ok(await replacement.openSession(f.script.welcome()));
    const details = (await audit(f.trip));
    expect(details.firstLoss).toBeNull();
    ok(await f.observe( evidence(), true));
    expect(ok(await client.getTrip(f.trip))!.hardModeDetails!.firstLoss).toEqual(details.firstLoss);
  });
  it('stores a pending observed loss before delivery after an observation-write failure, retaining the original value', async () => {
    const f = await setup(), original = client.observeHardMode.bind(client); let failed = false;
    client.observeHardMode = (game, observation, fresh) => {if (!failed) {failed = true; return Promise.resolve({ok: false, error: {code: 'IO_ERROR', retryable: true, message: 'Injected'}});} return original(game, observation, fresh);};
    f.recorder.observeHardMode('ets2', evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')));
    f.set(evidence()); await f.send(manual());
    expect(ok(await client.getTrip(f.trip))).toMatchObject({isHardMode: false, hardModeDetails: {firstDiagnostic: {rule: 'fatigue', values: [0]}}});
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
