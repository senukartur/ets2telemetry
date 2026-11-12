// ET-112b2b: closed pending membership decisions and upload (REG-005, REG-008, REG-012). A schema 9 segment whose
// membership is still pending is held from upload by all three identity predicates (upload discovery, the projection's
// readiness and the Journal's sync state) until a later proof or the next session of its game decides it, and the
// resolvePendingMemberships command is strict at the worker boundary. Hand-written synthetic streams; expected values come
// from docs/dashboard-upload.md and docs/storage.md.
import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, Storage, type ResolveMembershipsInput} from '../../packages/storage/src';
import {StorageClient} from '../../packages/storage/src/client';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {tripUuidFor} from '../../packages/telemetry-core/src';
import {ETS2_A, ETS2_B, r, Script} from '../shared/trip-messages';
import {failed, ok, TEST_CLOSE_GRACE_MS, uploadGame, uploadProof, uploadTestOwner, workspace} from './helpers';
import {storageWorker, terminateWorkers} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
const opened: Storage[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); for (const storage of opened.splice(0)) if (!storage.closed) storage.close(); await ws.dispose(); });
const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;

/** History storage with a confirmed Dashboard owner, so every new game-origin trip has an assigned upload reservation. */
async function history(): Promise<{storage: Storage; db: Database.Database; registrationId: string}> {
  const conn = await openConnection(ws.options({purpose: 'history'})), storage = new Storage(conn);
  opened.push(storage);
  const owner = await uploadTestOwner(storage);
  ok(storage.confirmUploadOwner({confirmationId: owner.runId, registrationId: owner.registrationId, credentialGeneration: 'generation', expectedVersion: '0'}));
  return {storage, db: conn.writer(), registrationId: owner.registrationId};
}
/** An unproven trip opened and delivered as eventSeq 1 and 2 of the session: a closed pending segment. */
function deliveredPending(storage: Storage, script: Script): string {
  ok(storage.upsertSession({message: uploadGame(script.welcome())}));
  const configured = uploadGame(script.event(r.jobConfigured())), uuid = tripUuidFor(script.session, configured.data.eventSeq);
  ok(storage.commitEvent({message: configured, effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  ok(storage.commitEvent({message: uploadGame(script.event(r.delivered())), effects: [{kind: 'trip.close', tripUuid: uuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event',
    recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
  return uuid;
}
const resolveInput = (script: Script, nextEventSeq = '3'): ResolveMembershipsInput => ({pluginSessionId: script.session, nextEventSeq, profile: uploadProof(script),
  sourceClockId: script.clockId, monotonicNs: '999999999999999'});
/** The root's readiness from a bounded projection preparation; the pin is released again. */
function readiness(storage: Storage, tripUuid: string): string | undefined {
  const pinId = randomUUID();
  let state = ok(storage.beginUploadProjection({pinId, tripUuid}));
  for (let turn = 0; state.state === 'preparing' && turn < 1000; turn++) state = ok(storage.advanceUploadProjection(pinId));
  const value = state.projection?.rootReadiness;
  for (let turn = 0; state.state !== 'released' && turn < 1000; turn++) state = ok(storage.releaseUploadProjection(pinId));
  return value;
}
const decision = (db: Database.Database) => db.prepare('SELECT state, reason FROM logical_membership_decisions WHERE trip_ref = 1').get();
const bindings = (db: Database.Database) => db.prepare('SELECT * FROM upload_source_bindings ORDER BY root_ref').all();

describe('REG-005/008/012 upload identity of a closed pending segment', () => {
  it('M19 holds a closed pending root in all three predicates until the next session of its game starts', async () => {
    const {storage, db, registrationId} = await history(), a = new Script(ETS2_A), uuid = deliveredPending(storage, a);
    expect(decision(db)).toEqual({state: 'pending', reason: 'profile-unverified'});
    expect(bindings(db)).toEqual([]);
    expect(db.prepare('SELECT identity_state FROM upload_reservations').pluck().all()).toEqual(['pending']);
    expect(ok(storage.getUploadStoreStatus({registrationId}))).toMatchObject({identityPendingSources: 1, pendingSources: 0});
    expect(readiness(storage, uuid)).toBe('identity-pending');
    expect(ok(storage.journalTrips()).sync?.rows).toMatchObject([{tripUuid: uuid, state: 'identity-pending'}]);
    ok(storage.upsertSession({message: uploadGame(new Script(ETS2_B).welcome())}));
    expect(decision(db)).toEqual({state: 'separate', reason: 'process-ended'});
    expect(bindings(db)).toMatchObject([{root_ref: 1n, registration_ref: registrationId, trip_uuid: uuid, http_revision: 0n}]);
    expect(db.prepare('SELECT identity_state FROM upload_reservations').pluck().all()).toEqual(['resolved']);
    expect(ok(storage.getUploadStoreStatus({registrationId}))).toMatchObject({identityPendingSources: 0, pendingSources: 1});
    expect(readiness(storage, uuid)).toBe('ready');
    expect(ok(storage.journalTrips()).sync?.rows).toMatchObject([{tripUuid: uuid, state: 'pending'}]);
  });
  it('M19 makes a closed pending root ready once its own later proof decides it', async () => {
    const {storage, db, registrationId} = await history(), a = new Script(ETS2_A), uuid = deliveredPending(storage, a);
    expect(ok(storage.resolvePendingMemberships(resolveInput(a)))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expect(decision(db)).toEqual({state: 'root', reason: 'no-candidate'});
    expect(ok(storage.getUploadStoreStatus({registrationId}))).toMatchObject({identityPendingSources: 0, pendingSources: 1});
    expect(readiness(storage, uuid)).toBe('ready');
    expect(ok(storage.journalTrips()).sync?.rows).toMatchObject([{tripUuid: uuid, state: 'pending'}]);
  });
  it('M17 keeps a root bound before the guard published and records the segment separate', async () => {
    const {storage, db, registrationId} = await history(), a = new Script(ETS2_A), uuid = deliveredPending(storage, a);
    const run = db.prepare('SELECT active_run FROM upload_connection WHERE id = 1').pluck().get();
    // Test-only state: a binding made before schema 9 held pending roots back.
    db.prepare(`INSERT INTO upload_source_bindings(root_ref, registration_ref, run_ref, mode, game, plugin_session_uuid, trip_uuid) VALUES (1, ?, ?, 'live', 'ets2', ?, ?)`)
      .run(registrationId, run, a.session, uuid);
    const before = bindings(db);
    expect(readiness(storage, uuid)).toBe('ready');
    expect(ok(storage.resolvePendingMemberships(resolveInput(a)))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expect(decision(db)).toEqual({state: 'separate', reason: 'published'});
    expect(db.prepare('SELECT proof_json FROM logical_memberships WHERE trip_ref = 1').pluck().get()).toBeNull();
    expect(bindings(db)).toEqual(before);
  });
});

describe('REG-005/010 resolvePendingMemberships input', () => {
  it('refuses a missing field, a wrong nextEventSeq and an unadmitted proof through the real worker and changes nothing', async () => {
    const {storage} = await history(), a = new Script(ETS2_A);
    deliveredPending(storage, a);
    storage.close();
    const worker = storageWorker(), client = new StorageClient(worker.handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, purpose: 'history', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
    const withoutProfile: Partial<ResolveMembershipsInput> = resolveInput(a);
    delete withoutProfile.profile;
    failed(await client.resolvePendingMemberships(withoutProfile as ResolveMembershipsInput), 'INVALID_INPUT');
    failed(await client.resolvePendingMemberships(resolveInput(a, '2')), 'INVALID_INPUT');
    failed(await client.resolvePendingMemberships(resolveInput(a, '4')), 'INVALID_INPUT');
    failed(await client.resolvePendingMemberships({...resolveInput(a), profile: {...uploadProof(a), pluginSessionId: ETS2_B}}), 'INVALID_INPUT');
    failed(await client.resolvePendingMemberships({...resolveInput(a), profile: {...uploadProof(a), afterMonotonicNs: '2000000000000000'}}), 'INVALID_INPUT');
    // Nothing above changed the pending decision: the valid input still resolves it, once.
    expect(ok(await client.resolvePendingMemberships(resolveInput(a)))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expect(ok(await client.resolvePendingMemberships(resolveInput(a)))).toEqual({status: 'none', resolved: 0, remaining: 0});
    expect(await client.close()).toEqual({clean: true});
  });
  it('refuses an extra input field in process', async () => {
    const {storage, db} = await history(), a = new Script(ETS2_A);
    deliveredPending(storage, a);
    failed(storage.resolvePendingMemberships({...resolveInput(a), effects: []} as ResolveMembershipsInput), 'INVALID_INPUT');
    failed(storage.resolvePendingMemberships({...resolveInput(a), sourceClockId: 'not-a-uuid'}), 'INVALID_INPUT');
    expect(decision(db)).toEqual({state: 'pending', reason: 'profile-unverified'});
  });
  it('resolves nothing below schema 9', async () => {
    const storage = await ws.open({migrations: MIGRATIONS.slice(0, 8)}), a = new Script(ETS2_A);
    expect(storage.summary.schemaVersion).toBe(8);
    ok(storage.upsertSession({message: a.welcome()}));
    const configured = a.event(r.jobConfigured()), uuid = tripUuidFor(a.session, configured.data.eventSeq);
    ok(storage.commitEvent({message: configured, effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
    ok(storage.commitEvent({message: a.event(r.delivered()), effects: [{kind: 'trip.close', tripUuid: uuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event',
      recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
    expect(ok(storage.resolvePendingMemberships(resolveInput(a)))).toEqual({status: 'none', resolved: 0, remaining: 0});
    expect(ok(storage.journalTrips()).trips.map(trip => trip.tripUuid)).toEqual([uuid]);
  });
});
