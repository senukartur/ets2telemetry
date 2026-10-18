// Shared helpers of the Electron-runtime storage suite. Every database lives in a per-test temporary directory from
// tests/shared/resources.ts; committed fixtures are copied there first and never opened in place.
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {expect} from 'vitest';
import {decodePayload, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {openStorage, type JournalResult, type OpenOptions, type Result, type Storage, type StorageErrorCode} from '../../packages/storage/src/index';
import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {temporaryResources} from '../shared/resources';

export const PROTOCOL_V1 = path.resolve('tests/fixtures/protocol-v1');
export const STORAGE_FIXTURES = path.resolve('tests/fixtures/storage');
export const P1 = '10000000-0000-4000-8000-000000000001';
/**
 * Close grace of every real-worker StorageClient in this suite. It bounds a hung close inside the case timeouts and is
 * not a latency check: the cases assert the close protocol (answer, then exit code 0). With the 2 s production default,
 * one close on a loaded shared host took longer than 2 s and was reported `{clean: false}` (docs/validation/et-013.md,
 * October 15, 2026). Grace expiry itself is checked with fake timers in tests/unit/storage-client.test.ts and with a
 * held close in worker.test.ts. The crash-test child processes keep the default: they are killed and never close.
 */
export const TEST_CLOSE_GRACE_MS = 15_000;

/** A decoded protocol v1 fixture, validated by the contract decoder. */
export const v1 = (name: string) => decodePayload(new Uint8Array(readFileSync(path.join(PROTOCOL_V1, `${name}.json`))), 'server') as ServerMessage;
/** A fixture message with its event or gap range replaced, for synthetic sequences; the result is validated on commit. */
export function withEventSeq(name: string, first: bigint, last = first): ServerMessage {
  const m = structuredClone(v1(name)) as ServerMessage & {data: Record<string, unknown>};
  if (m.kind === 'event') m.data.eventSeq = first.toString();
  else if (m.kind === 'gap') {
    m.data.firstEventSeq = first.toString(); m.data.lastEventSeq = last.toString();
    m.data.causes = {offline: '0', noDurableConsumer: '0', queueCount: (last - first + 1n).toString(), queueBytes: '0', retentionExpired: '0', encodingFailed: '0'};
  } else throw new Error('Harness: event or gap fixture expected');
  return m;
}

export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export const files = (directory: string) => readdirSync(directory).sort();

/** Accepts a journal result too, whose error may be the client's JOURNAL_ANSWER_INVALID (ET-016). */
export function ok<T>(result: Result<T> | JournalResult<T>): T {
  if (!result.ok) {
    const cause = 'cause' in result.error ? result.error.cause : undefined;
    throw new Error(`Expected success, got ${result.error.code}${cause ? `/${cause}` : ''}`);
  }
  return result.value;
}
export function failed<R extends Result<unknown> | JournalResult<unknown>>(result: R, code: StorageErrorCode | 'JOURNAL_ANSWER_INVALID'): Extract<R, {ok: false}>['error'] {
  expect(result.ok, `expected ${code}`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.error.code).toBe(code);
  return result.error;
}

/** A per-test workspace: a database path, its backup directory and a controlled clock. */
export async function workspace() {
  const resources = await temporaryResources();
  let clock = Date.UTC(2026, 9, 15, 12, 0, 0);
  const opened: Storage[] = [];
  const self = {
    directory: resources.directory,
    database: resources.database,
    backups: path.join(resources.directory, 'backups'),
    now: () => clock,
    advance(ms: number) { clock += ms; },
    options(overrides: Partial<OpenOptions> = {}): OpenOptions {
      return {path: resources.database, purpose: 'synthetic', backupsDirectory: self.backups, appVersion: '0.1.0-test', now: self.now, ...overrides};
    },
    async open(overrides: Partial<OpenOptions> = {}): Promise<Storage> { const storage = ok(await openStorage(self.options(overrides))); opened.push(storage); return storage; },
    /** Copies a committed storage fixture into this workspace and returns the copy's path. */
    copyFixture(name: string, target = path.join(resources.directory, name)): string { copyFileSync(path.join(STORAGE_FIXTURES, name), target); return target; },
    async dispose() { for (const storage of opened) if (!storage.closed) storage.close(); await resources.dispose(); }
  };
  return self;
}

/**
 * Reads a closed database file through a separate read-only connection. A read-only connection to a WAL-format file
 * creates `-shm` and an empty `-wal`; this removes exactly the ones it created.
 */
export function readOnly<T>(file: string, body: (db: Database.Database) => T): T {
  const before = ['-wal', '-shm'].filter(suffix => existsSync(file + suffix));
  const db = new Database(file, {readonly: true, fileMustExist: true});
  try { return body(db); } finally {
    db.close();
    for (const suffix of ['-wal', '-shm']) if (!before.includes(suffix) && existsSync(file + suffix) && (suffix === '-shm' || statSync(file + suffix).size === 0)) rmSync(file + suffix);
  }
}
export const digestOf = (file: string) => readOnly(file, contentDigest);

export const REPRESENTATIVE = 'schema-v1-representative.sqlite';
const expectedRepresentative = () => JSON.parse(readFileSync(path.join(STORAGE_FIXTURES, 'schema-v1-representative.expected.json'), 'utf8'));
/**
 * Checks an opened copy of the representative fixture against its hand-written expected content through the read API,
 * then closes it and checks gaps, attributions, completeness and row counts with plain SQL. `rowCountChanges` covers
 * rows that a later schema legitimately adds, such as its own schema_migrations row.
 */
/**
 * ET-016 PR-7 (J9): the TripRecord fields added after the immutable fixture expectations were written, with the values of
 * a trip opened at its job.configured event, as every fixture trip was (their SQL: opened_by 'event', job source 'event').
 */
export const EVENT_OPENED = {jobSource: 'event', checkpointJob: null, openedBy: 'event'} as const;
export function expectRepresentative(storage: Storage, file: string, rowCountChanges: Record<string, number> = {}) {
  const expected = expectedRepresentative();
  expect(storage.summary.databaseUuid).toBe(expected.databaseUuid);
  expect(ok(storage.getSession(P1))).toEqual(expected.session);
  const events = ok(storage.listEvents(P1));
  expect(events.map(({eventSeq, type, firstRedelivered, protocolMinor, committedUtcMs}) => ({eventSeq, type, firstRedelivered, protocolMinor, committedUtcMs}))).toEqual(expected.events);
  for (const [eventSeq, values] of Object.entries(expected.recordValues)) expect(events.find(e => e.eventSeq === eventSeq)?.record, eventSeq).toMatchObject(values as object);
  // ET-016 PR-6: TripRecord gained fuelUsedL after this immutable expectation was written. A version 1 trip has no fuel
  // used, and migration 0002 stores `not-observed` for it (docs/storage.md, schema version 2). ET-016 PR-7: TripRecord also
  // gained where its job and opening came from; every version 1 trip opened at its job.configured event.
  expect(ok(storage.listTrips()).trips).toEqual((expected.trips as object[]).map(trip => ({...trip, fuelUsedL: {available: false, reason: 'not-observed'}, ...EVENT_OPENED})));
  expect(ok(storage.listSamples({pluginSessionId: P1}))).toEqual(expected.samples);
  storage.close();
  readOnly(file, db => {
    expect(db.prepare('SELECT first_event_seq, last_event_seq, cause_queue_count, cause_queue_bytes, cause_offline FROM event_gaps ORDER BY id').all()).toEqual(expected.gaps);
    expect(db.prepare('SELECT e.event_seq, t.trip_uuid, a.attribution FROM event_attributions a JOIN events e ON e.id = a.event_ref LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.event_seq').all()).toEqual(expected.attributions);
    expect(db.prepare('SELECT c.kind, t.trip_uuid, c.first_event_seq, c.last_event_seq, c.detail_json FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref ORDER BY c.id').all()).toEqual(expected.completeness);
    expect(contentDigest(db).rowCounts).toEqual({...expected.rowCounts, ...rowCountChanges});
  });
}

// The version 1 to version 2 expectations of the representative fixture (ET-016 PR-1), moved unchanged from
// migrations.test.ts so that tests/storage/migration-crash.test.ts (ET-019) checks a migration completed after a killed
// open against the same hand-written rows. The expected rows are written by hand from schema-v1-representative.sql and J6.
// trips is rebuilt too: its rows and every row that references a trip must survive unchanged.
const REFERENCING = ['trip_trailers', 'event_attributions', 'completeness_intervals', 'samples'];
const rowsOf = (file: string, table: string) => readOnly(file, db => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
/** Reads what migration 0002 must keep from a version 1 copy of the representative fixture, before it is migrated. */
export function readVersion1(copy: string) {
  return {original: digestOf(copy), v1Jobs: readOnly(copy, db => db.prepare('SELECT * FROM job_configurations ORDER BY id').all()),
    v1Trips: rowsOf(copy, 'trips'), v1Referencing: REFERENCING.map(table => rowsOf(copy, table))};
}
/**
 * Checks a copy of the representative fixture migrated to version 2 through `storage` (which it closes) against `before`
 * from readVersion1 and against the pre-migration backup at `backup` with its manifest.
 */
export function expectMigratedFromVersion1(storage: Storage, copy: string, {original, v1Jobs, v1Trips, v1Referencing}: ReturnType<typeof readVersion1>, backup: string) {
  const backupName = path.basename(backup);
  expectRepresentative(storage, copy, {schema_migrations: 2});
  // The backup is the version 1 content, byte-for-byte in logical terms, with a manifest written last.
  expect(digestOf(backup)).toEqual(original);
  const manifest = JSON.parse(readFileSync(backup.replace(/\.sqlite$/, '.json'), 'utf8'));
  expect(manifest).toMatchObject({format: 'ets2telemetry-backup-1', databaseUuid: 'f0000000-0000-4000-8000-000000000001', fromVersion: 1, fileName: backupName,
    fileSha256: sha256(backup), logicalDigest: original.logicalDigest, rowCounts: original.rowCounts, reason: 'pre-migration'});
  const recorded = readOnly(copy, db => db.prepare('SELECT version, name, backup_file_name, backup_sha256 FROM schema_migrations ORDER BY version').all());
  expect(recorded).toEqual([{version: 1, name: '0001-initial', backup_file_name: null, backup_sha256: null}, {version: 2, name: '0002-journal', backup_file_name: backupName, backup_sha256: manifest.fileSha256}]);
  expect(digestOf(copy).userVersion).toBe(2);
  readOnly(copy, db => {
    // The cancelled trip of version 1 keeps every column, opened at an event, has no recorded carrier, and its fuel
    // used was never observed.
    expect(db.prepare('SELECT id, opened_event_ref, opened_by, fuel_used_l, fuel_used_l_state, closed_by_session_ref, closed_by_event_seq FROM trips').all())
      .toEqual([{id: 1, opened_event_ref: 1, opened_by: 'event', fuel_used_l: null, fuel_used_l_state: 'not-observed', closed_by_session_ref: null, closed_by_event_seq: null}]);
    expect(db.prepare('SELECT * FROM trips ORDER BY id').all()).toEqual(v1Trips.map(row => ({...row as object, opened_by: 'event', fuel_used_l: null,
      fuel_used_l_state: 'not-observed', closed_by_session_ref: null, closed_by_event_seq: null})));
    REFERENCING.forEach((table, index) => expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table).toEqual(v1Referencing[index]));
    expect(v1Referencing.map(rows => rows.length)).toEqual([1, 4, 1, 3]);
    // The job configuration keeps every version 1 column and comes from event 1 of session 1.
    expect(db.prepare('SELECT * FROM job_configurations ORDER BY id').all()).toEqual(v1Jobs.map(row => ({...row as object, plugin_session_ref: 1, source: 'event', checkpoint_next_event_seq: null})));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
  });
}
