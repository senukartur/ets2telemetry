import {tripUuidFor} from '../../packages/telemetry-core/src';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {Storage, MIGRATIONS} from '../../packages/storage/src';
import {StorageClient} from '../../packages/storage/src/client';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {JOURNAL_SYNC_QUERIES} from '../../packages/storage/src/sqlite/journal-sync';
import {Script, r} from '../shared/trip-messages';
import {ok, workspace, uploadTestSource, uploadTestWork, uploadGame, uploadProof, uploadReceipt, TEST_CLOSE_GRACE_MS} from './helpers';
import {storageWorker, terminateWorkers} from './recording-helpers';
let ws: Awaited<ReturnType<typeof workspace>>, opened: Storage[] = [];
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await terminateWorkers(); for (const storage of opened) storage.close(); opened = []; await ws.dispose();});
async function direct() {const conn = await openConnection(ws.options({purpose: 'history'})), storage = new Storage(conn); opened.push(storage); return {conn, storage, db: conn.writer()};}
async function replace(storage: Storage | StorageClient, epoch = 'epoch') {
  const installation = ok(await storage.ensureUploadInstallation()), registrationId = randomUUID(), runId = randomUUID();
  ok(await storage.recordUploadRegistration({registrationId, clientInstallationId: installation.clientInstallationId!, origin: 'https://dashboard.example', accountId: 'B', companyId: 'company', identityEpoch: epoch, installationId: randomUUID(), bindingId: randomUUID()}));
  const version = ok(await storage.getUploadConfiguration()).version;
  ok(await storage.confirmUploadOwner({confirmationId: runId, registrationId, credentialGeneration: 'b-generation', expectedVersion: version}));
  return {registrationId, runId};
}
it('REG-003/005/008/012/014 reads bounded queued/sending/held/sent facts through the real worker without writes and rejects older receipts after changes', async () => {
  const {storage, db} = await direct(), source = await uploadTestSource(storage);
  expect(ok(storage.journalTrips()).sync?.rows).toMatchObject([{tripUuid: source.tripUuid, state: 'pending'}]);
  const workId = await uploadTestWork(storage, source), frozen = ok(storage.freezeUploadMaterialization({workId, producerVersion: 'test', createdUtcMs: 1000}));
  ok(storage.releaseUploadMaterialization({workId}));
  expect(ok(storage.journalTrips()).sync?.rows[0]).toMatchObject({state: 'queued', latestRevision: 1, lastDurableUploadUtcMs: null});
  const attempt = ok(storage.claimUploadAttempt({attemptId: randomUUID(), registrationId: source.registrationId, expectedVersion: '1', mode: 'any', nowMs: 1000}));
  expect(ok(storage.journalTrips()).sync?.rows[0].state).toBe('sending');
  ok(storage.commitUploadReceipt({attemptId: attempt.attemptId!, statusCode: 202, body: uploadReceipt(frozen.eventId!)}));
  const before = contentDigest(db);
  for (let read = 0; read < 3; read++) expect(ok(storage.journalTrips()).sync?.rows[0]).toMatchObject({state: 'sent', latestRevision: 1, lastDurableUploadUtcMs: 5000});
  expect(contentDigest(db)).toEqual(before);
  for (const [name, sql] of Object.entries(JOURNAL_SYNC_QUERIES)) {
    const args = name === 'root' ? [source.tripUuid] : name === 'attempt' ? [] : [1];
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {detail: string}[]).map(row => row.detail).join(';');
    expect(plan).toMatch(/SEARCH/); expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
  }
  ok(storage.recordCompleteness(source.script.session, {tripUuid: source.tripUuid, kind: 'sample-loss'}));
  expect(ok(storage.journalTrips()).sync?.rows[0]).toMatchObject({state: 'pending', latestRevision: 1, lastDurableUploadUtcMs: null});
  const secondWork = await uploadTestWork(storage, source); ok(storage.freezeUploadMaterialization({workId: secondWork, producerVersion: 'test', createdUtcMs: 2000})); ok(storage.releaseUploadMaterialization({workId: secondWork}));
  const second = ok(storage.claimUploadAttempt({attemptId: randomUUID(), registrationId: source.registrationId, expectedVersion: '1', mode: 'any', nowMs: 2000}));
  ok(storage.recordUploadAttemptOutcome({attemptId: second.attemptId!, kind: 'validation', retryAtMs: 2000, nowMs: 2000}));
  expect(ok(storage.journalTrips()).sync?.rows[0]).toMatchObject({state: 'held', reason: 'validation', lastDurableUploadUtcMs: null});
  storage.close();
  const worker = storageWorker(), client = new StorageClient(worker.handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
  ok(await client.open({path: ws.database, backupsDirectory: ws.backups, purpose: 'history', appVersion: 'test'}));
  try {
    const page = ok(await client.journalTrips()); expect(page.sync?.rows.map(row => row.tripUuid)).toEqual(page.trips.map(trip => trip.tripUuid)); expect(page.sync?.rows[0].state).toBe('held');
    await replace(client); expect(ok(await client.journalTrips()).sync?.rows[0]).toEqual({tripUuid: source.tripUuid, state: 'unavailable', materialVersion: null, latestRevision: null, lastDurableUploadUtcMs: null, reason: null});
  } finally {await client.close();}
});
it('REG-003/008/012/014 resolves lazy legacy claims without materializing reservations and isolates account epochs', async () => {
  const old = await ws.open({purpose: 'history', migrations: MIGRATIONS.slice(0, 5)}), script = new Script('10000000-0000-4000-8000-000000000077'), tripUuid = '70000000-0000-4000-8000-000000000077';
  ok(old.upsertSession({message: uploadGame(script.welcome())}));
  ok(old.commitEvent({message: uploadGame(script.event(r.jobConfigured())), effects: [{kind: 'trip.open', tripUuid, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  old.close();
  const {storage, db} = await direct(); const a = await replace(storage);
  const before = contentDigest(db);
  expect(ok(storage.journalTrips()).sync?.rows[0]).toMatchObject({state: 'identity-pending'});
  expect(contentDigest(db)).toEqual(before); expect(db.prepare('SELECT count(*) FROM upload_candidates').pluck().get()).toBe(0n);
  await replace(storage, 'new-epoch'); expect(ok(storage.journalTrips()).sync?.rows[0].state).toBe('unavailable');
  expect(db.prepare('SELECT registration_ref FROM upload_history_claims WHERE first_ordinal<=1 ORDER BY first_ordinal DESC LIMIT 1').pluck().get()).toBe(a.registrationId);
});
it('REG-003/005/014 distinguishes durable unbound roots from missing evidence and preserves exact row order', async () => {
  const {storage, db} = await direct(), source = await uploadTestSource(storage);
  ok(storage.disconnectUploadOwner({expectedVersion: '1'}));
  const script = new Script('10000000-0000-4000-8000-000000000078'), tripUuid = '70000000-0000-4000-8000-000000000078';
  ok(storage.upsertSession({message: uploadGame(script.welcome())}));
  ok(storage.commitEvent({message: uploadGame(script.event(r.jobConfigured())), effects: [{kind: 'trip.open', tripUuid, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  // Reactivation of the same owner does not claim newly unbound history; confirmation does.
  db.prepare('UPDATE upload_connection SET active_registration=?,credential_generation=?,active_run=? WHERE id=1').run(source.registrationId, 'generation', source.runId);
  const before = contentDigest(db), page = ok(storage.journalTrips()); expect(page.sync?.rows.map(row => row.tripUuid)).toEqual(page.trips.map(trip => trip.tripUuid)); expect(page.sync?.rows.find(row => row.tripUuid === tripUuid)?.state).toBe('unbound'); expect(contentDigest(db)).toEqual(before);
  db.pragma('foreign_keys=OFF'); db.prepare('DELETE FROM upload_reservations WHERE candidate_ref=(SELECT ordinal FROM upload_candidates WHERE trip_uuid=?)').run(tripUuid); db.pragma('foreign_keys=ON');
  expect(ok(storage.journalTrips()).sync?.rows.find(row => row.tripUuid === tripUuid)?.state).toBe('unavailable');
});

it('REG-003/005/008/012/014 keeps one continued root and preserves its original owner across a new member opening', async () => {
  const {storage, db} = await direct(), source = await uploadTestSource(storage);
  ok(storage.commitEvent({message: uploadGame(source.script.event(r.timersRestart())), effects: [{kind: 'trip.close', tripUuid: source.tripUuid, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
  await replace(storage);
  const script = new Script('10000000-0000-4000-8000-000000000002'), child = tripUuidFor(script.session, '1');
  ok(storage.upsertSession({message: uploadGame(script.welcome())}));
  ok(storage.commitEvent({message: uploadGame(script.event(r.jobConfigured())), profile: uploadProof(script), effects: [{kind: 'trip.open', tripUuid: child, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}));
  expect(db.prepare('SELECT logical_ref FROM logical_memberships WHERE trip_ref=2').pluck().get()).toBe(1n);
  const page = ok(storage.journalTrips()); expect(page.trips.map(row => row.tripUuid)).toEqual([source.tripUuid]); expect(page.sync?.rows).toMatchObject([{tripUuid: source.tripUuid, state: 'unavailable'}]);
  ok(storage.confirmUploadOwner({confirmationId: randomUUID(), registrationId: source.registrationId, credentialGeneration: 'a-restored', expectedVersion: '2'}));
  const before = contentDigest(db); expect(ok(storage.journalTrips()).sync?.rows).toMatchObject([{tripUuid: source.tripUuid, state: 'pending'}]); expect(contentDigest(db)).toEqual(before);
});
it('REG-005/008/014 recognizes a durable equal-material comparison without counting another event or revision', async () => {
  const {storage} = await direct(), source = await uploadTestSource(storage);
  ok(storage.recordCompleteness(source.script.session, {tripUuid: source.tripUuid, kind: 'sample-loss'}));
  const work = await uploadTestWork(storage, source), frozen = ok(storage.freezeUploadMaterialization({workId: work, producerVersion: 'test', createdUtcMs: 1000})); ok(storage.releaseUploadMaterialization({workId: work}));
  const attempt = ok(storage.claimUploadAttempt({attemptId: randomUUID(), registrationId: source.registrationId, expectedVersion: '1', mode: 'any', nowMs: 1000}));
  ok(storage.commitUploadReceipt({attemptId: attempt.attemptId!, statusCode: 202, body: uploadReceipt(frozen.eventId!)}));
  const first = ok(storage.journalTrips()).sync!.rows[0]; expect(first.state).toBe('sent');
  ok(storage.recordCompleteness(source.script.session, {tripUuid: source.tripUuid, kind: 'sample-loss'}));
  expect(ok(storage.journalTrips()).sync?.rows[0].state).toBe('pending');
  const equal = await uploadTestWork(storage, source); expect(ok(storage.freezeUploadMaterialization({workId: equal, producerVersion: 'test', createdUtcMs: 2000})).status).toBe('equal'); ok(storage.releaseUploadMaterialization({workId: equal}));
  const latest = ok(storage.journalTrips()).sync!.rows[0]; expect(latest).toMatchObject({state: 'sent', latestRevision: first.latestRevision, lastDurableUploadUtcMs: 5000}); expect(BigInt(latest.materialVersion!)).toBeGreaterThan(BigInt(first.materialVersion!));
});

it('REG-014 projects exactly the selected 50-row page and preserves filter and cursor semantics', async () => {
  const {storage, db} = await direct(), source = await uploadTestSource(storage);
  ok(storage.commitEvent({message: uploadGame(source.script.event(r.delivered())), effects: [{kind: 'trip.close', tripUuid: source.tripUuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: 2000}]}));
  for (let index = 1; index <= 52; index++) {
    const tripUuid = `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    ok(storage.commitEvent({message: uploadGame(source.script.event(r.jobConfigured())), effects: [{kind: 'trip.open', tripUuid, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: 1000}]}));
    ok(storage.commitEvent({message: uploadGame(source.script.event(r.delivered())), effects: [{kind: 'trip.close', tripUuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
  }
  const before = contentDigest(db), first = ok(storage.journalTrips({outcome: 'delivered'})); expect(first.trips).toHaveLength(50); expect(first.sync?.rows.map(row => row.tripUuid)).toEqual(first.trips.map(trip => trip.tripUuid));
  const next = ok(storage.journalTrips({outcome: 'delivered', cursor: first.nextCursor!})); expect(next.trips).toHaveLength(3); expect(next.sync?.rows.map(row => row.tripUuid)).toEqual(next.trips.map(trip => trip.tripUuid)); expect(new Set([...first.trips, ...next.trips].map(row => row.tripUuid)).size).toBe(53); expect(contentDigest(db)).toEqual(before);
  expect(ok(storage.journalTrips({game: 'ats'})).sync?.rows).toEqual([]);
});
