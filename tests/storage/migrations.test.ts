import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage, type Migration} from '../../packages/storage/src/index';
import {SCHEMA_V1} from '../../packages/storage/src/sqlite/schema-v1';
import {SCHEMA_V2} from '../../packages/storage/src/sqlite/schema-v2';
import {digestOf, expectMigratedFromVersion1, expectRepresentative, failed, files, ok, readOnly, readVersion1, REPRESENTATIVE, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const failingV3: Migration = {version: 3, name: '0003-test-failure', up: db => { db.exec('CREATE TABLE test_v3 (id INTEGER PRIMARY KEY)'); throw new Error('injected migration failure'); }};
const schemaOf = (file: string) => readOnly(file, db => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all());
/** Runs `change` on a closed database file through a plain connection; `foreignKeys` false allows an orphan row. */
function edit(file: string, change: (db: Database.Database) => void, foreignKeys = true) {
  const db = new Database(file);
  try { if (!foreignKeys) db.pragma('foreign_keys = OFF'); change(db); } finally { db.close(); }
}
/**
 * Adds a second plugin session (id 7) to a version 1 copy, with clocks 11 and 12, its own job.configured event (id 6,
 * eventSeq 1) and that event's job configuration (id 2). The ids differ from every other id, so a backfill from the
 * wrong column cannot produce session 7 by accident.
 */
const SECOND_SESSION = `CREATE TEMP TABLE s AS SELECT * FROM plugin_sessions WHERE id = 1;
  UPDATE s SET id = 7, plugin_session_uuid = '10000000-0000-4000-8000-000000000007', process_instance_uuid = '20000000-0000-4000-8000-000000000007', committed_through_event_seq = '00000000000000000001';
  INSERT INTO plugin_sessions SELECT * FROM s;
  CREATE TEMP TABLE k AS SELECT * FROM clocks WHERE plugin_session_ref = 1;
  UPDATE k SET id = id + 10, plugin_session_ref = 7;
  INSERT INTO clocks SELECT * FROM k;
  CREATE TEMP TABLE e AS SELECT * FROM events WHERE id = 1;
  UPDATE e SET id = 6, plugin_session_id = 7, source_clock_ref = 11, occurred_game_clock_ref = 12;
  INSERT INTO events SELECT * FROM e;
  CREATE TEMP TABLE j AS SELECT * FROM job_configurations WHERE id = 1;
  UPDATE j SET id = 2, event_ref = 6;
  INSERT INTO job_configurations SELECT * FROM j;`;
const jobIdentities = (file: string) => readOnly(file, db => db.prepare('SELECT id, plugin_session_ref, source, event_ref, checkpoint_next_event_seq FROM job_configurations ORDER BY id').all());
/** Opens a file that is not ours and checks that it was refused without changing a byte or leaving sidecar files. */
async function expectRefused(file: string, code: 'SCHEMA_NEWER' | 'DATABASE_UNRECOGNIZED' | 'PURPOSE_MISMATCH', purpose: 'synthetic' | 'history' = 'synthetic') {
  const before = sha256(file), listing = files(path.dirname(file));
  failed(await openStorage(ws.options({path: file, purpose})), code);
  expect(sha256(file)).toBe(before);
  expect(files(path.dirname(file))).toEqual(listing);
}

describe('REG-013 schema migrations', () => {
  // ET-016 PR-1: production migrates version 1 to version 2 (0002-journal), so these cases use the real migration list.
  // The expected rows are written by hand from schema-v1-representative.sql and J6.
  it('migrates an immutable version 1 copy to version 2 after a verified backup and keeps every ID and value', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    const storage = await ws.open({path: copy});
    expect(storage.summary).toMatchObject({schemaVersion: 2, created: false, migratedFrom: 1});
    const backupName = storage.summary.backupFileName!;
    expect(backupName).toMatch(/^telemetry-f0000000-v1-20261015T120000000Z\.sqlite$/);
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, backupName));
  });
  it('backfills each job configuration with the plugin session of its event', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    edit(copy, db => db.exec(SECOND_SESSION));
    const storage = await ws.open({path: copy});
    expect(storage.summary).toMatchObject({schemaVersion: 2, migratedFrom: 1});
    storage.close();
    expect(jobIdentities(copy)).toEqual([
      {id: 1, plugin_session_ref: 1, source: 'event', event_ref: 1, checkpoint_next_event_seq: null},
      {id: 2, plugin_session_ref: 7, source: 'event', event_ref: 6, checkpoint_next_event_seq: null}]);
    expect(readOnly(copy, db => db.pragma('foreign_key_check'))).toEqual([]);
  });
  it('never migrates a version 1 database whose job configuration lost its event: the verified backup refuses it first', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    // A version 1 row whose event is missing, so its session cannot be backfilled. The backup's foreign_key_check
    // refuses the database before 0002 runs; the backfill's LEFT JOIN would fail NOT NULL rather than drop the row.
    edit(copy, db => db.exec('CREATE TEMP TABLE j AS SELECT * FROM job_configurations WHERE id = 1; UPDATE j SET id = 2, event_ref = 999; INSERT INTO job_configurations SELECT * FROM j;'), false);
    const before = digestOf(copy);
    failed(await openStorage(ws.options({path: copy})), 'BACKUP_FAILED');
    expect(digestOf(copy)).toEqual(before);
    expect(files(ws.backups)).toEqual([]);
    expect(readOnly(copy, db => db.prepare('SELECT version FROM schema_migrations').pluck().all())).toEqual([1]);
  });
  it('rolls back migration 0002 with a later failing step: the database stays at version 1 with unchanged content and the backup is named', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = digestOf(copy);
    const error = failed(await openStorage(ws.options({path: copy, migrations: [...MIGRATIONS, failingV3]})), 'MIGRATION_FAILED');
    expect(error.backupFileName).toMatch(/^telemetry-f0000000-v1-.*\.sqlite$/);
    expect(existsSync(path.join(ws.backups, error.backupFileName!))).toBe(true);
    expect(digestOf(copy)).toEqual(before);
    // The next open with the production list migrates the unchanged version 1 content.
    expectRepresentative(await ws.open({path: copy}), copy, {schema_migrations: 2});
  });
  it('creates a new database at version 2 whose schema is the frozen version 1 text followed by migration 0002', async () => {
    const storage = await ws.open(); storage.close();
    // The frozen statements executed by hand on an empty file, outside the migration framework.
    const manual = path.join(ws.directory, 'manual.sqlite');
    edit(manual, db => { for (const statement of [...SCHEMA_V1, ...SCHEMA_V2]) db.exec(statement); }, false);
    expect(schemaOf(ws.database)).toEqual(schemaOf(manual));
    // A migrated version 1 database has the same schema, and so has the committed version 2 fixture.
    const migrated = ws.copyFixture(REPRESENTATIVE);
    (await ws.open({path: migrated})).close();
    expect(schemaOf(migrated)).toEqual(schemaOf(ws.database));
    expect(schemaOf(ws.database)).toEqual(schemaOf(ws.copyFixture('schema-v2-representative.sqlite')));
    // Version 2 keeps every version 1 trigger and index text and adds no index except the new UNIQUE key's own.
    const objects = (file: string, type: string) => (schemaOf(file) as {type: string; name: string; sql: string | null}[]).filter(o => o.type === type).map(({name, sql}) => ({name, sql}));
    const v1 = ws.copyFixture(REPRESENTATIVE, path.join(ws.directory, 'v1.sqlite'));
    expect(objects(ws.database, 'trigger')).toEqual(objects(v1, 'trigger'));
    expect(objects(ws.database, 'index')).toEqual([...objects(v1, 'index'), {name: 'sqlite_autoindex_job_configurations_2', sql: null}].sort((a, b) => a.name < b.name ? -1 : 1));
  });
  it('refuses a newer schema without changing the file', async () => {
    await expectRefused(ws.copyFixture('schema-newer-999.sqlite'), 'SCHEMA_NEWER');
  });
  it('refuses a newer schema that is still in a live WAL, without changing the database or the WAL', async () => {
    const source = path.join(ws.directory, 'live-source.sqlite'), copy = path.join(ws.directory, 'live.sqlite');
    const writer = new Database(source);
    try {
      writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
      writer.pragma('application_id = 1163154226'); writer.exec('CREATE TABLE future_data (id INTEGER PRIMARY KEY)'); writer.pragma('user_version = 999');
      // A crash leaves this state on disk: the newer schema exists only in the WAL, not in the main file header.
      copyFileSync(source, copy); copyFileSync(`${source}-wal`, `${copy}-wal`);
    } finally { writer.close(); }
    expect(readFileSync(copy).readUInt32BE(60)).toBe(0);
    const wal = sha256(`${copy}-wal`);
    await expectRefused(copy, 'SCHEMA_NEWER');
    expect(sha256(`${copy}-wal`)).toBe(wal);
  });
  it('refuses a database of another application, the ET-001 probe layout and a non-database file', async () => {
    await expectRefused(ws.copyFixture('foreign-application.sqlite'), 'DATABASE_UNRECOGNIZED');
    const probe = path.join(ws.directory, 'probe', 'telemetry.sqlite');
    ok(await openStorage(ws.options({path: path.join(ws.directory, 'probe', 'unused.sqlite')}))).close();
    const db = new Database(probe); db.exec('CREATE TABLE probe (value INTEGER NOT NULL); INSERT INTO probe VALUES (42)'); db.close();
    await expectRefused(probe, 'DATABASE_UNRECOGNIZED', 'history');
    const text = path.join(ws.directory, 'notes.sqlite'); writeFileSync(text, 'not a database, but larger than one hundred bytes '.repeat(4));
    await expectRefused(text, 'DATABASE_UNRECOGNIZED');
  });
  it('refuses to open a database for another purpose', async () => {
    await expectRefused(ws.copyFixture(REPRESENTATIVE), 'PURPOSE_MISMATCH', 'history');
  });
  describe('a change between the read-only inspection and the writer lock', () => {
    /** Runs `change` on the file after inspection, records its bytes, and returns them for comparison after the refusal. */
    function changeAfterInspect(change: (db: Database.Database) => void) {
      const state = {hash: ''};
      return {state, afterInspect: (file: string) => { const db = new Database(file); try { change(db); } finally { db.close(); } state.hash = sha256(file); }};
    }
    it('refuses a schema made newer after inspection, before any write', async () => {
      const copy = ws.copyFixture(REPRESENTATIVE), hook = changeAfterInspect(db => db.pragma('user_version = 999'));
      failed(await openStorage(ws.options({path: copy, testHooks: {afterInspect: hook.afterInspect}})), 'SCHEMA_NEWER');
      expect(sha256(copy)).toBe(hook.state.hash);
      expect(existsSync(ws.backups)).toBe(false);
    });
    it('refuses a version changed after inspection even when it is supported, without migrating or backing up', async () => {
      const copy = ws.copyFixture(REPRESENTATIVE), hook = changeAfterInspect(db => db.pragma('user_version = 2'));
      failed(await openStorage(ws.options({path: copy, testHooks: {afterInspect: hook.afterInspect}})), 'DATABASE_UNRECOGNIZED');
      expect(sha256(copy)).toBe(hook.state.hash);
      expect(existsSync(ws.backups)).toBe(false);
    });
    it('refuses a new file that gained foreign tables after inspection instead of creating the schema in it', async () => {
      const hook = changeAfterInspect(db => db.exec('CREATE TABLE other_application (id INTEGER PRIMARY KEY)'));
      failed(await openStorage(ws.options({testHooks: {afterInspect: hook.afterInspect}})), 'DATABASE_UNRECOGNIZED');
      expect(sha256(ws.database)).toBe(hook.state.hash);
      expect(readOnly(ws.database, db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all())).toEqual(['other_application']);
    });
  });
  it('refuses an empty SQLite file with a user version at inspection, before the writer opens', async () => {
    const file = path.join(ws.directory, 'versioned-empty.sqlite');
    const db = new Database(file); db.pragma('user_version = 7'); db.close();
    let writerReached = false;
    await expectRefused(file, 'DATABASE_UNRECOGNIZED');
    failed(await openStorage(ws.options({path: file, testHooks: {afterInspect: () => { writerReached = true; }}})), 'DATABASE_UNRECOGNIZED');
    expect(writerReached).toBe(false);
  });
  it('creates a new database in an existing empty file', async () => {
    writeFileSync(ws.database, '');
    expect((await ws.open()).summary).toMatchObject({created: true, schemaVersion: 2});
  });
});
