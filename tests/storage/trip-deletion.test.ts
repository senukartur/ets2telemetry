// ET-065: storage trip deletion integration tests.
// Verifies deleting a trip cascades to child tables (samples, completeness_intervals, trip_trailers),
// unlinks event attributions, preserves immutable events, respects foreign key and schema triggers,
// enforces active recording guards (STORAGE_BUSY), and works across the StorageClient worker boundary.
import {once} from 'node:events';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {Storage} from '../../packages/storage/src/index';
import type {WorkerOpenOptions} from '../../packages/storage/src/worker/protocol';
import {JOURNAL_TRIPS as T, MIGRATED_V1_TRIP, seedJournalAnchors} from '../shared/journal-seed';
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

describe('ET-065 trip deletion', () => {
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

      // Event attributions for deleted trip are unlinked to free-driving
      const unlinkedAttributions = db.prepare("SELECT count(*) AS n FROM event_attributions WHERE trip_ref IS NULL AND attribution = 'free-driving'").get() as {n: number};
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

    // rejectIfOpen guard over IPC worker
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
