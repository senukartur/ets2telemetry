// ET-065: storage trip deletion integration tests.
// Verifies deleting a trip cascades to child tables (samples, completeness_intervals, trip_trailers),
// unlinks event attributions, preserves immutable events, respects foreign key and schema triggers,
// cascades across multi-segment continuation trips under schema v4, enforces active recording guards
// (STORAGE_BUSY), and works across the StorageClient worker boundary.
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {SampleInput, Storage} from '../../packages/storage/src/index';
import type {WorkerOpenOptions} from '../../packages/storage/src/worker/protocol';
import {tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {JOURNAL_TRIPS as T, MIGRATED_V1_TRIP, seedJournalAnchors} from '../shared/journal-seed';
import {ETS2_A, ETS2_B, job, r, Script} from '../shared/trip-messages';
import {failed, ok, readOnly, REPRESENTATIVE, TEST_CLOSE_GRACE_MS, workspace} from './helpers';

const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if (!bundles) throw new Error('Storage test bundles are missing; run npm run test:storage.');
const WORKER = path.join(bundles, 'storage-worker.cjs');

let ws: Awaited<ReturnType<typeof workspace>>;
const started: Worker[] = [];

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map(worker => worker.terminate()));
  await ws.dispose();
});

function startWorker() {
  const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
  started.push(worker);
  const exit = once(worker, 'exit').then(([code]) => code as number);
  return {worker, client: new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS}), exit};
}

const workerOptions = (overrides: Partial<WorkerOpenOptions> = {}): WorkerOpenOptions =>
  ({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test', ...overrides});

const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;

function proof(script: Script): ProfileObservation {
  const source = script.welcome().source;
  return {version: 1, scope: 'a'.repeat(64), binding: 'b'.repeat(64), game: source.game, pluginSessionId: source.pluginSessionId,
    processInstanceId: source.processInstanceId, sourceClockId: script.clockId, afterMonotonicNs: '0', loadGeneration: 1};
}

function openContinuation(storage: Storage, script: Script, values = job(), verified = true) {
  ok(storage.upsertSession({message: script.welcome()}));
  const message = script.event(r.jobConfigured(values)), uuid = tripUuidFor(script.session, message.data.eventSeq);
  ok(storage.commitEvent({message, ...(verified ? {profile: proof(script)} : {}), effects: [{kind: 'trip.open', tripUuid: uuid, game: script.game,
    gameMode: mode, jobConfiguration: 'this-event', startedUtcMs: 1000, recordingCompleteness: 'complete'},
  {kind: 'event.attribute', tripUuid: uuid, attribution: 'trip'}]}));
  return uuid;
}

function sampleContinuation(storage: Storage, script: Script, uuid: string, seconds: number, odometerM: number, values = job()) {
  const absent = {available: false, reason: 'not-observed'} as const;
  const row: SampleInput = {tripUuid: uuid, utcMs: 1000 + seconds * 1000, sourceClockId: script.clockId, monotonicNs: String(BigInt(seconds) * 1_000_000_000n),
    odometer: {available: true, value: odometerM}, fuel: {available: true, value: 500 - odometerM / 10000}, speed: absent, gameTime: null,
    averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent, position: absent,
    recording: {profile: proof(script), job: values, truck: 'verified-truck', processInstanceId: script.welcome().source.processInstanceId,
      previous: {tripUuid: uuid, sourceClockId: script.clockId, monotonicNs: String(BigInt(seconds - 1) * 1_000_000_000n)}}};
  ok(storage.appendSamples(script.session, [row], {uniqueSeconds: true}));
}

function closeContinuation(storage: Storage, script: Script, uuid: string, terminal = false) {
  const message = script.event(terminal ? r.cancelled() : r.timersRestart());
  ok(storage.commitEvent({message, effects: [{kind: 'trip.close', tripUuid: uuid, outcome: terminal ? 'cancelled' : 'none',
    closeReason: terminal ? 'outcome' : 'restart', ...(terminal ? {outcomeEvent: 'this-event' as const} : {}), recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
}

describe('ET-065 trip deletion', () => {
  it('retains redirected provisional roots before any group deletion mutation until their pins are released',async()=>{
    const storage=await ws.open(),a=new Script(ETS2_A),root=openContinuation(storage,a);closeContinuation(storage,a,root);
    const b=new Script(ETS2_B),alias=openContinuation(storage,b,job(),false),pinId=randomUUID();
    ok(storage.beginUploadProjection({pinId,tripUuid:alias}));
    // Commit the association after the provisional root has been retained.
    ok(storage.openAttachedTrip({pluginSessionId:b.session,nextEventSeq:String(b.next),job:job(),effects:[],observeTripUuid:alias,
      profile:proof(b),sourceClockId:b.clockId,monotonicNs:'999999999999999'}));
    closeContinuation(storage,b,alias,true);
    const before=ok(storage.journalTrip(root));
    failed(storage.deleteTrip(root),'STORAGE_BUSY');failed(storage.deleteTrip(alias),'STORAGE_BUSY');expect(ok(storage.journalTrip(root))).toEqual(before);
    expect(ok(storage.advanceUploadProjection(pinId)).state).toBe('invalidated');failed(storage.deleteTrip(root),'STORAGE_BUSY');
    let released=ok(storage.releaseUploadProjection(pinId));while(released.state==='releasing')released=ok(storage.releaseUploadProjection(pinId));
    ok(storage.deleteTrip(root));expect(ok(storage.listTrips()).trips).toEqual([]);
  });
  it('deletes a delivered trip, cascades child records, unlinks event attributions, and satisfies schema foreign keys (REG-014)', async () => {
    ws.copyFixture(REPRESENTATIVE, ws.database);
    const storage: Storage = await ws.open();
    await seedJournalAnchors(storage);

    // Verify trip exists before deletion
    const beforeTrip = ok(storage.getTrip(T.delivered));
    expect(beforeTrip).toBeDefined();
    const samplesBefore = ok(storage.listSamples({tripUuid: T.delivered}));
    expect(samplesBefore.length).toBeGreaterThan(0);

    // Delete the trip
    const result = storage.deleteTrip(T.delivered);
    expect(result.ok).toBe(true);

    // Attempting to read deleted trip fails with UNKNOWN_TRIP
    failed(storage.journalTrip(T.delivered), 'UNKNOWN_TRIP');
    expect(ok(storage.getTrip(T.delivered))).toBeUndefined();
    failed(storage.listSamples({tripUuid: T.delivered}), 'UNKNOWN_TRIP');

    // Close storage connection so readOnly can inspect the database file
    ok(storage.close());

    // Verify database state directly
    readOnly(ws.database, db => {
      // Trip row is deleted
      const tripExists = db.prepare('SELECT count(*) AS n FROM trips WHERE trip_uuid = ?').get(T.delivered) as {n: number};
      expect(tripExists.n).toBe(0);

      // Total samples still include non-trip and other trip samples
      const totalSamples = db.prepare('SELECT count(*) AS n FROM samples').get() as {n: number};
      expect(totalSamples.n).toBeGreaterThan(0);

      // Event attributions for deleted trip are unlinked to ambiguous
      const unlinkedAttributions = db.prepare("SELECT count(*) AS n FROM event_attributions WHERE trip_ref IS NULL AND attribution = 'ambiguous'").get() as {n: number};
      expect(unlinkedAttributions.n).toBeGreaterThan(0);

      // Events remain intact
      const totalEvents = db.prepare('SELECT count(*) AS n FROM events').get() as {n: number};
      expect(totalEvents.n).toBeGreaterThan(0);

      // Schema foreign key and integrity checks pass
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);

      const integrityCheck = db.pragma('integrity_check') as {integrity_check: string}[];
      expect(integrityCheck).toEqual([{integrity_check: 'ok'}]);
    });
  });

  it('deletes a migrated v1 trip cleanly under schema v4', async () => {
    ws.copyFixture(REPRESENTATIVE, ws.database);
    const storage: Storage = await ws.open();

    const detail = ok(storage.journalTrip(MIGRATED_V1_TRIP));
    expect(detail.trip.tripUuid).toBe(MIGRATED_V1_TRIP);

    const result = storage.deleteTrip(MIGRATED_V1_TRIP);
    expect(result.ok).toBe(true);

    failed(storage.journalTrip(MIGRATED_V1_TRIP), 'UNKNOWN_TRIP');
    ok(storage.close());

    readOnly(ws.database, db => {
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);

      const integrityCheck = db.pragma('integrity_check') as {integrity_check: string}[];
      expect(integrityCheck).toEqual([{integrity_check: 'ok'}]);
    });
  });

  it('rejects deletion of an open trip when rejectIfOpen is true and deletes it when rejectIfOpen is false', async () => {
    ws.copyFixture(REPRESENTATIVE, ws.database);
    const storage: Storage = await ws.open();
    await seedJournalAnchors(storage);

    // Verify trip is open
    const initialDetail = ok(storage.journalTrip(T.open));
    expect(initialDetail.trip.outcome).toBe('open');

    // Attempting delete with rejectIfOpen: true must fail with STORAGE_BUSY
    failed(storage.deleteTrip(T.open, {rejectIfOpen: true}), 'STORAGE_BUSY');

    // Trip still exists and is untouched
    const stillOpen = ok(storage.journalTrip(T.open));
    expect(stillOpen.trip.outcome).toBe('open');

    // Deleting with rejectIfOpen: false succeeds
    const deleteResult = storage.deleteTrip(T.open, {rejectIfOpen: false});
    expect(deleteResult.ok).toBe(true);

    // Now trip is gone
    failed(storage.journalTrip(T.open), 'UNKNOWN_TRIP');
    ok(storage.close());

    readOnly(ws.database, db => {
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
    });
  });

  it('deletes a multi-segment continued trip atomically under schema v4 without orphaned records (REG-014)', async () => {
    let storage = await ws.open();
    const a = new Script(ETS2_A), first = openContinuation(storage, a);
    sampleContinuation(storage, a, first, 1, 1000000);
    closeContinuation(storage, a, first, false);
    ok(storage.close());

    ws.advance(86_400_000);
    storage = await ws.open();
    const b = new Script(ETS2_B), second = openContinuation(storage, b, job({cargo: {available: true, value: 'Localized cargo'}}));
    sampleContinuation(storage, b, second, 1, 1000050);

    // Initial state: two raw trips in storage, one logical trip in journal
    expect(ok(storage.listTrips()).trips).toHaveLength(2);
    expect(ok(storage.journalTrips()).trips).toHaveLength(1);

    // Active guard rejects deletion targeting either segment UUID when second segment is open
    failed(storage.deleteTrip(first, {rejectIfOpen: true}), 'STORAGE_BUSY');
    failed(storage.deleteTrip(second, {rejectIfOpen: true}), 'STORAGE_BUSY');

    // Close the second segment
    closeContinuation(storage, b, second, true);

    // Delete targeting the continuation segment UUID
    const result = storage.deleteTrip(second);
    expect(result.ok).toBe(true);

    // Both raw trips and the logical group are removed
    expect(ok(storage.listTrips()).trips).toHaveLength(0);
    expect(ok(storage.journalTrips()).trips).toHaveLength(0);
    failed(storage.journalTrip(first), 'UNKNOWN_TRIP');
    failed(storage.journalTrip(second), 'UNKNOWN_TRIP');

    ok(storage.close());

    // Verify complete cleanup without orphaned records
    readOnly(ws.database, db => {
      expect((db.prepare('SELECT count(*) AS n FROM trips').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM samples').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_memberships').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_trips').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_progress').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_revisions').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM observation_closes').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_projection_states WHERE id NOT IN (SELECT state_ref FROM logical_revisions)').get() as {n: number}).n).toBe(0);

      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);

      const integrityCheck = db.pragma('integrity_check') as {integrity_check: string}[];
      expect(integrityCheck).toEqual([{integrity_check: 'ok'}]);
    });
  });

  it('deletes a multi-segment continued trip when targeting the root trip UUID', async () => {
    let storage = await ws.open();
    const a = new Script(ETS2_A), first = openContinuation(storage, a);
    sampleContinuation(storage, a, first, 1, 1000000);
    closeContinuation(storage, a, first, false);
    ok(storage.close());

    ws.advance(86_400_000);
    storage = await ws.open();
    const b = new Script(ETS2_B), second = openContinuation(storage, b, job({cargo: {available: true, value: 'Localized cargo'}}));
    sampleContinuation(storage, b, second, 1, 1000050);
    closeContinuation(storage, b, second, true);

    // Delete targeting the root trip UUID
    const result = storage.deleteTrip(first);
    expect(result.ok).toBe(true);

    expect(ok(storage.listTrips()).trips).toHaveLength(0);
    expect(ok(storage.journalTrips()).trips).toHaveLength(0);
    failed(storage.journalTrip(first), 'UNKNOWN_TRIP');
    failed(storage.journalTrip(second), 'UNKNOWN_TRIP');

    ok(storage.close());

    readOnly(ws.database, db => {
      expect((db.prepare('SELECT count(*) AS n FROM trips').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_memberships').get() as {n: number}).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM logical_trips').get() as {n: number}).n).toBe(0);

      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
    });
  });

  it('rejects non-existent UUID with UNKNOWN_TRIP and malformed inputs with INVALID_INPUT', async () => {
    ws.copyFixture(REPRESENTATIVE, ws.database);
    const storage: Storage = await ws.open();

    failed(storage.deleteTrip('ffffffff-ffff-4fff-8fff-ffffffffffff'), 'UNKNOWN_TRIP');
    failed(storage.deleteTrip('not-a-valid-uuid'), 'INVALID_INPUT');
    failed(storage.deleteTrip(T.delivered, 'invalid-options' as never), 'INVALID_INPUT');
    failed(storage.deleteTrip(T.delivered, {rejectIfOpen: 'yes' as never}), 'INVALID_INPUT');
  });

  it('executes trip deletion through StorageClient worker thread', async () => {
    ws.copyFixture(REPRESENTATIVE, ws.database);
    const {client, exit} = startWorker();
    ok(await client.open(workerOptions()));
    await seedJournalAnchors(client);

    // rejectIfOpen guard over IPC worker (defaults to true)
    failed(await client.deleteTrip(T.open), 'STORAGE_BUSY');
    failed(await client.deleteTrip(T.open, {rejectIfOpen: true}), 'STORAGE_BUSY');
    ok(await client.journalTrip(T.open));

    // Delete delivered trip over IPC worker
    ok(await client.deleteTrip(T.delivered));
    failed(await client.journalTrip(T.delivered), 'UNKNOWN_TRIP');

    // Clean worker shutdown
    const closed = await client.close();
    expect(closed).toEqual({clean: true});
    expect(await exit).toBe(0);

    readOnly(ws.database, db => {
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
      const integrityCheck = db.pragma('integrity_check') as {integrity_check: string}[];
      expect(integrityCheck).toEqual([{integrity_check: 'ok'}]);
    });
  });
});
