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
import type {UploadEnvelope} from '../../packages/storage/src/upload-envelope';
import {tripUuidFor} from '../../packages/telemetry-core/src';
import {ETS2_A, ETS2_B, r, Script} from '../shared/trip-messages';
import {failed, ok, TEST_CLOSE_GRACE_MS, uploadGame, uploadProof, uploadReceipt, uploadTestOwner, uploadTestWork, workspace} from './helpers';
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
type CommitInput = Parameters<Storage['commitEvent']>[0];
/** An unproven trip opened and delivered as eventSeq 1 and 2 of the session: a closed pending segment, with its delivery input. */
function pendingSegment(storage: Storage, script: Script): {uuid: string; delivery: CommitInput} {
  ok(storage.upsertSession({message: uploadGame(script.welcome())}));
  const configured = uploadGame(script.event(r.jobConfigured())), uuid = tripUuidFor(script.session, configured.data.eventSeq);
  ok(storage.commitEvent({message: configured, effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  const delivery: CommitInput = {message: uploadGame(script.event(r.delivered())), effects: [{kind: 'trip.close', tripUuid: uuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event',
    recordingCompleteness: 'partial', endedUtcMs: 2000}]};
  ok(storage.commitEvent(delivery));
  return {uuid, delivery};
}
function deliveredPending(storage: Storage, script: Script): string {
  return pendingSegment(storage, script).uuid;
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

/** Session A opens its trip as eventSeq 1, with or without an admitted profile proof. */
function opening(storage: Storage, script: Script, withProof: boolean): string {
  ok(storage.upsertSession({message: uploadGame(script.welcome())}));
  const configured = uploadGame(script.event(r.jobConfigured())), uuid = tripUuidFor(script.session, configured.data.eventSeq);
  ok(storage.commitEvent({message: configured, ...(withProof ? {profile: uploadProof(script)} : {}),
    effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  return uuid;
}
/** A proven trip of session A closed by a timer restart: its raw trip is closed and its logical trip stays open. */
function restarted(storage: Storage, script: Script): string {
  const uuid = opening(storage, script, true);
  ok(storage.commitEvent({message: uploadGame(script.event(r.timersRestart())), effects: [{kind: 'trip.close', tripUuid: uuid, outcome: 'none', closeReason: 'restart',
    recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
  return uuid;
}
/** Materializes and freezes the root's current material as minor-1 work; the frozen event ID, or the work status when not frozen. */
async function freeze(storage: Storage, tripUuid: string, registrationId: string, createdUtcMs: number) {
  const workId = await uploadTestWork(storage, {tripUuid, registrationId});
  const frozen = ok(storage.freezeUploadMaterialization({workId, producerVersion: 'test', createdUtcMs, contractMinor: 1}));
  ok(storage.releaseUploadMaterialization({workId}));
  return frozen;
}
/** Freezes the root's next revision and commits its 202 receipt; the delivered event ID. */
async function publish(storage: Storage, tripUuid: string, registrationId: string, expectedVersion: string, createdUtcMs: number): Promise<string> {
  const frozen = await freeze(storage, tripUuid, registrationId, createdUtcMs);
  expect(frozen.status).toBe('frozen');
  const attempt = ok(storage.claimUploadAttempt({attemptId: randomUUID(), registrationId, expectedVersion, mode: 'any', nowMs: 1000}));
  expect(attempt.eventId).toBe(frozen.eventId);
  expect(ok(storage.commitUploadReceipt({attemptId: attempt.attemptId!, statusCode: 202, body: uploadReceipt(frozen.eventId!)})).status).toBe('delivered');
  return frozen.eventId!;
}
const payload = (db: Database.Database, eventId: string) => Buffer.from(db.prepare('SELECT payload FROM upload_envelopes WHERE event_id = ?').pluck().get(eventId) as Uint8Array);
const wire = (db: Database.Database, eventId: string) => JSON.parse(payload(db, eventId).toString()) as UploadEnvelope;
const envelopes = (db: Database.Database) => (db.prepare('SELECT payload FROM upload_envelopes ORDER BY root_ref, revision').pluck().all() as Uint8Array[])
  .map(bytes => JSON.parse(Buffer.from(bytes).toString()) as UploadEnvelope);
const receipts = (db: Database.Database) => db.prepare('SELECT * FROM upload_receipts ORDER BY event_ref').all();
const syncRows = (storage: Storage) => ok(storage.journalTrips()).sync?.rows.map(row => ({tripUuid: row.tripUuid, state: row.state, reason: row.reason}));
const begin = (storage: Storage, tripUuid: string, registrationId: string) => ok(storage.beginUploadMaterialization({workId: randomUUID(), tripUuid, registrationId}));

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

// ET-112f: a segment whose profile proof follows its delivery joins the published root retroactively. The root publishes its
// next revision under its original source key; the segment never gets a source key of its own.
describe('REG-004/005/008/012 publication of a segment joined after its delivery', () => {
  const status = (storage: Storage, registrationId: string) => ok(storage.getUploadStoreStatus({registrationId}));
  const revenue = {available: true, value: {raw: '15000', sdkType: 's64'}};
  it('F1 publishes the root once more under its original key and replays nothing', async () => {
    const {storage, db, registrationId} = await history(), a = new Script(ETS2_A), b = new Script(ETS2_B), root = restarted(storage, a);
    expect(root).toBe(tripUuidFor(ETS2_A, '1'));
    const first = await publish(storage, root, registrationId, '1', 1000);
    expect(wire(db, first)).toMatchObject({revision: 1, type: 'trip.started', source: {tripId: root, pluginSessionId: ETS2_A}, snapshot: {outcome: 'open'}});
    expect(syncRows(storage)).toEqual([{tripUuid: root, state: 'sent', reason: null}]);
    const {uuid: segment, delivery} = pendingSegment(storage, b);
    expect(segment).toBe(tripUuidFor(ETS2_B, '1'));
    // Before the proof: the delivered segment is its own identity-pending row, with no source key.
    const before = syncRows(storage);
    expect(before).toHaveLength(2);
    expect(before).toEqual(expect.arrayContaining([{tripUuid: root, state: 'sent', reason: null}, {tripUuid: segment, state: 'identity-pending', reason: null}]));
    expect(bindings(db)).toMatchObject([{root_ref: 1n}]);
    expect(status(storage, registrationId).identityPendingSources).toBe(1);
    expect(begin(storage, segment, registrationId)).toMatchObject({status: 'held', reason: 'identity-pending'});
    const bytes = payload(db, first), receipt = receipts(db);
    expect(receipt).toHaveLength(1);
    expect(ok(storage.resolvePendingMemberships(resolveInput(b)))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expect(db.prepare('SELECT state FROM logical_membership_decisions WHERE trip_ref = 2').pluck().get()).toBe('joined');
    expect(syncRows(storage)).toEqual([{tripUuid: root, state: 'pending', reason: null}]);
    expect(status(storage, registrationId)).toMatchObject({identityPendingSources: 0, pendingSources: 1});
    const second = await publish(storage, root, registrationId, '1', 3000);
    expect(wire(db, second)).toMatchObject({revision: 2, type: 'trip.completed', source: {tripId: root, pluginSessionId: ETS2_A},
      snapshot: {outcome: 'delivered', outcomeEventSeq: '2', revenue}});
    expect(payload(db, first)).toEqual(bytes);
    expect(receipts(db).find(row => (row as {event_ref: string}).event_ref === first)).toEqual(receipt[0]);
    expect(bindings(db)).toMatchObject([{root_ref: 1n, trip_uuid: root, plugin_session_uuid: ETS2_A, http_revision: 2n, terminal: 1n}]);
    const sent = envelopes(db);
    expect(sent).toHaveLength(2);
    expect(sent.filter(envelope => envelope.type === 'trip.completed' && envelope.snapshot.revenue.available)).toHaveLength(1);
    expect(syncRows(storage)).toEqual([{tripUuid: root, state: 'sent', reason: null}]);
    // A replayed resolve and a duplicate delivery add no material, revision or event.
    const head = db.prepare('SELECT material_version FROM upload_change_heads WHERE root_ref = 1').pluck().get(), bound = bindings(db);
    expect(ok(storage.resolvePendingMemberships(resolveInput(b)))).toEqual({status: 'none', resolved: 0, remaining: 0});
    expect(ok(storage.commitEvent(delivery))).toMatchObject({status: 'duplicate'});
    expect(db.prepare('SELECT material_version FROM upload_change_heads WHERE root_ref = 1').pluck().get()).toBe(head);
    expect(bindings(db)).toEqual(bound);
    expect(envelopes(db)).toHaveLength(2);
    expect(status(storage, registrationId)).toMatchObject({identityPendingSources: 0, pendingSources: 0, heldSources: 0});
    expect(syncRows(storage)).toEqual([{tripUuid: root, state: 'sent', reason: null}]);
  });
  it('F2 keeps the root owner when the joined segment was recorded under another owner', async () => {
    const {storage, db, registrationId: ownerA} = await history(), a = new Script(ETS2_A), b = new Script(ETS2_B), root = restarted(storage, a);
    await publish(storage, root, ownerA, '1', 1000);
    const installation = ok(storage.ensureUploadInstallation()), ownerB = randomUUID();
    ok(storage.recordUploadRegistration({registrationId: ownerB, clientInstallationId: installation.clientInstallationId!, origin: 'https://dashboard.example', accountId: 'B',
      companyId: 'company', identityEpoch: 'epoch', installationId: randomUUID(), bindingId: randomUUID()}));
    ok(storage.confirmUploadOwner({confirmationId: randomUUID(), registrationId: ownerB, credentialGeneration: 'generation-b', expectedVersion: '1'}));
    deliveredPending(storage, b);
    expect(status(storage, ownerB).identityPendingSources).toBe(1);
    expect(ok(storage.resolvePendingMemberships(resolveInput(b)))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expect(db.prepare('SELECT registration_ref, identity_state FROM upload_reservations WHERE candidate_ref = 2').get()).toEqual({registration_ref: ownerB, identity_state: 'redirected'});
    expect(db.prepare('SELECT registration_ref FROM upload_source_bindings WHERE root_ref = 1').pluck().get()).toBe(ownerA);
    expect(begin(storage, root, ownerB)).toMatchObject({status: 'held', reason: 'reconciliation-required'});
    expect(status(storage, ownerB)).toMatchObject({identityPendingSources: 0, pendingSources: 0, heldSources: 0});
    expect(status(storage, ownerA).pendingSources).toBe(1);
    expect(syncRows(storage)).toEqual([{tripUuid: root, state: 'unavailable', reason: null}]);
    ok(storage.confirmUploadOwner({confirmationId: randomUUID(), registrationId: ownerA, credentialGeneration: 'generation', expectedVersion: '2'}));
    const registration = db.prepare('SELECT installation_id, binding_id FROM upload_registrations WHERE registration_id = ?').get(ownerA) as {installation_id: string; binding_id: string};
    const frozen = await freeze(storage, root, ownerA, 3000);
    expect(frozen.status).toBe('frozen');
    expect(wire(db, frozen.eventId!)).toMatchObject({revision: 2, type: 'trip.completed', installationId: registration.installation_id, bindingId: registration.binding_id,
      source: {tripId: root, pluginSessionId: ETS2_A}, snapshot: {outcome: 'delivered', revenue}});
  });
});

// ET-112f F3, test-only state: live recording never joins a segment that already has its own source binding (separate/published,
// M17 above), so the SQL below writes the membership statements of a retroactive join; a history repair could leave this state.
describe('REG-005/008/010/012 a root whose group holds a separately published member', () => {
  it.each([true, false])('holds the root without a second credit or new bytes (root bound %s)', async rootBound => {
    const {storage, db, registrationId} = await history(), a = new Script(ETS2_A), b = new Script(ETS2_B);
    const root = rootBound ? restarted(storage, a) : opening(storage, a, false);
    const first = rootBound ? await publish(storage, root, registrationId, '1', 1000) : undefined;
    const segment = deliveredPending(storage, b);
    ok(storage.upsertSession({message: uploadGame(new Script('10000000-0000-4000-8000-000000000003').welcome())}));
    expect(db.prepare('SELECT state, reason FROM logical_membership_decisions WHERE trip_ref = 2').get()).toEqual({state: 'separate', reason: 'process-ended'});
    const second = await publish(storage, segment, registrationId, '1', 3000);
    expect(wire(db, second)).toMatchObject({revision: 1, type: 'trip.completed', source: {tripId: segment, pluginSessionId: ETS2_B},
      snapshot: {outcome: 'delivered', revenue: {available: true, value: {raw: '15000', sdkType: 's64'}}}});
    const published = [...(first ? [first] : []), second], bytes = published.map(id => payload(db, id)), receipted = receipts(db);
    db.prepare('UPDATE logical_memberships SET logical_ref = 1, previous_logical_ref = 2, joined_after_revision = (SELECT coalesce(max(id), 0) FROM logical_revisions) WHERE trip_ref = 2').run();
    db.prepare('UPDATE logical_trips SET retired = 1 WHERE id = 2').run();
    db.prepare(`UPDATE logical_trips SET latest_trip_ref = 2, member_count = 2${rootBound ? ', retired = 1' : ''} WHERE id = 1`).run();
    expect(begin(storage, root, registrationId)).toMatchObject({status: 'held', reason: 'reconciliation-required'});
    if (rootBound) expect(db.prepare('SELECT held, hold_reason FROM upload_source_bindings WHERE root_ref = 1').get()).toEqual({held: 1n, hold_reason: 'reconciliation-required'});
    else {
      expect(db.prepare('SELECT hold_reason, identity_state FROM upload_reservations WHERE candidate_ref = 1').get()).toEqual({hold_reason: 'reconciliation-required', identity_state: 'held'});
      expect(db.prepare('SELECT count(*) FROM upload_source_bindings WHERE root_ref = 1').pluck().get()).toBe(0n);
    }
    expect(ok(storage.getUploadStoreStatus({registrationId})).heldSources).toBe(1);
    expect(syncRows(storage)?.find(row => row.tripUuid === root)).toEqual({tripUuid: root, state: 'held', reason: 'reconciliation'});
    expect(envelopes(db)).toHaveLength(published.length);
    expect(published.map(id => payload(db, id))).toEqual(bytes);
    expect(receipts(db)).toEqual(receipted);
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
