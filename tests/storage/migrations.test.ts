import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {assertHistoryFacts} from '../../scripts/installer/history-contract.mjs';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS as CURRENT_MIGRATIONS, openStorage, type Migration} from '../../packages/storage/src/index';
import {SCHEMA_V1} from '../../packages/storage/src/sqlite/schema-v1';
import {SCHEMA_V2} from '../../packages/storage/src/sqlite/schema-v2';
import {QUANTITY_FLAGS, tripUuidFor} from '../../packages/telemetry-core/src';
import {job, r, Script} from '../shared/trip-messages';
import {digestOf, expectMigratedFromVersion1, expectRepresentative, failed, files, ok, readOnly, readVersion1, REPRESENTATIVE, sha256, workspace} from './helpers';

// These historical ET-016 cases freeze versions 1/2. ET-026 migration 3 is covered in hard-mode-migrations.test.ts.
const {collectHistory} = createRequire(import.meta.url)('../../scripts/installer/read-upgraded-history.cjs') as {
  collectHistory(DatabaseConstructor: typeof Database, database: string, backups: string): {database: Record<string, unknown>; manifests: {manifest: Record<string, unknown>}[]}
};
const MIGRATIONS = CURRENT_MIGRATIONS.slice(0, 2);
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); const options = ws.options; ws.options = overrides => options({migrations: MIGRATIONS, ...overrides}); });
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
/** The schema 10 column of a table and the value every row written before it holds (docs/storage.md, schema version 10). */
const V10_COLUMNS: Record<string, [string, unknown]> = {logical_trips: ['accounting_engine', 0], logical_progress: ['quantity_flags', null]};
/** `rows` of `table` without its schema 10 column, after checking that every row holds the legacy value. */
function withoutV10(table: string, rows: unknown[]): unknown[] {
  const added = V10_COLUMNS[table];
  if (!added) return rows;
  return (rows as Record<string, unknown>[]).map(({[added[0]]: value, ...rest}) => { expect(value, table).toBe(added[1]); return rest; });
}
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
    const db = new Database(file); db.pragma('user_version = 8'); db.close();
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

// Exercise the installed reader's actual read-only collector with the same contract the hosted driver uses.
describe('REG-013/REG-017 installer history contract', () => {
  it('accepts the actual version 1 to current migration and rejects corrupted upgrade evidence', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), original = readVersion1(copy);
    const storage = await ws.open({path: copy, migrations: CURRENT_MIGRATIONS});
    expect(storage.summary).toMatchObject({schemaVersion: 10, created: false, migratedFrom: 1});
    expectMigratedFromVersion1(storage, copy, original, path.join(ws.backups, storage.summary.backupFileName!));
    const facts = collectHistory(Database, copy, ws.backups);
    expect(() => assertHistoryFacts(facts, '0.1.0-test')).not.toThrow();
    const reopened = await ws.open({path: copy, migrations: CURRENT_MIGRATIONS});
    expect(reopened.summary).toMatchObject({schemaVersion: 10, created: false});
    expect(reopened.summary.migratedFrom).toBeUndefined();
    reopened.close();
    expect(() => assertHistoryFacts(collectHistory(Database, copy, ws.backups), '0.1.0-test')).not.toThrow();
    // Corrupt independent copies, then run the actual collector: counts alone cannot accept a bad singleton or summary.
    const invalid = [
      ['stale version', 'PRAGMA user_version = 3'],
      ['migration name', "UPDATE schema_migrations SET name='0004-wrong' WHERE version=4"],
      ['migration app version', "UPDATE schema_migrations SET app_version='other' WHERE version=4"],
      ['migration backup', "UPDATE schema_migrations SET backup_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE version=4"],
      ['missing membership', 'DELETE FROM logical_memberships'],
      ['mislinked membership', 'UPDATE logical_memberships SET logical_ref=999'],
      ['invented profile', "UPDATE logical_trips SET profile_scope='invented'"],
      ['non-retired history', 'UPDATE logical_trips SET retired=0'],
      ['revision bounds', 'UPDATE logical_revisions SET event_through=4'],
      ['mislinked revision state', 'UPDATE logical_revisions SET state_ref=999'],
      ['changed summary', "UPDATE logical_projection_states SET row_json=json_set(row_json,'$.observed_distance_m',999)"],
      ['invented progress identity', "INSERT INTO logical_trucks VALUES(1,'invented')"]
    ];
    for (const [label, sql] of invalid) {
      const broken = path.join(ws.directory, 'broken.sqlite');
      copyFileSync(copy, broken);
      edit(broken, db => db.exec(sql), false);
      expect(() => assertHistoryFacts(collectHistory(Database, broken, ws.backups), '0.1.0-test'), label).toThrow('HISTORY_CONTENT_UNEXPECTED');
    }
    const manifestPath = path.join(ws.backups, storage.summary.backupFileName!.replace(/\.sqlite$/, '.json'));
    const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes.toString());
    for (const [key, value, error] of [
      ['appVersion', 'other', 'BACKUP_MANIFEST_UNEXPECTED'], ['fromVersion', 3, 'BACKUP_MANIFEST_UNEXPECTED'],
      ['fileSha256', 'wrong', 'BACKUP_FILE_DIFFERS'], ['size', 1, 'BACKUP_FILE_DIFFERS']
    ] as const) {
      writeFileSync(manifestPath, JSON.stringify({...manifest, [key]: value}));
      expect(() => assertHistoryFacts(collectHistory(Database, copy, ws.backups), '0.1.0-test')).toThrow(error);
    }
    writeFileSync(manifestPath, manifestBytes);
  });
});

it('REG-013 migrates frozen schema4 additively and preserves every existing table row after a verified backup',async()=>{
  const copy=ws.copyFixture('schema-v4-representative.sqlite'),before=digestOf(copy);
  const tables=readOnly(copy,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all()) as string[];
  const rows=readOnly(copy,db=>Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const storage=await ws.open({path:copy,migrations:CURRENT_MIGRATIONS});expect(storage.summary).toMatchObject({schemaVersion:10,migratedFrom:4});
  expect(digestOf(path.join(ws.backups,storage.summary.backupFileName!))).toEqual(before);storage.close();
  readOnly(copy,db=>{
    for(const table of tables.filter(t=>t!=='schema_migrations'))expect(withoutV10(table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),table).toEqual(rows[table]);
    expect(db.prepare('SELECT generation FROM upload_projection_evidence_versions').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);expect(db.pragma('integrity_check',{simple:true})).toBe('ok');
  });
});

it('REG-006/013 migrates frozen schema5 additively after a verified backup without rewriting any existing rows or copied pages',async()=>{
  const copy=ws.copyFixture('schema-v5-representative.sqlite'),before=digestOf(copy);
  const tables=readOnly(copy,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all()) as string[];
  const rows=readOnly(copy,db=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const storage=await ws.open({path:copy,migrations:CURRENT_MIGRATIONS});expect(storage.summary).toMatchObject({schemaVersion:10,migratedFrom:5});
  expect(digestOf(path.join(ws.backups,storage.summary.backupFileName!))).toEqual(before);
  const ready=ok(storage.getUploadProjectionPreparation('80000000-0000-4000-8000-000000000001'));expect(ready.state).toBe('ready');
  storage.close();readOnly(copy,db=>{
    expect(tables.map(table=>withoutV10(table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).toEqual(rows);
    expect(db.prepare('SELECT legacy_boundary,next_ordinal,next_change,version,client_uuid FROM upload_connection').all()).toEqual([{legacy_boundary:4,next_ordinal:5,next_change:1,version:0,client_uuid:null}]);
    expect(db.prepare('SELECT count(*) FROM upload_candidates').pluck().get()).toBe(0);expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});


it('REG-006/013 migrates schema6 without rewriting frozen upload bytes, receipts, owners or retained pins',async()=>{
  const copy=ws.copyFixture('schema-v6-representative.sqlite'),before=digestOf(copy);
  const tables=readOnly(copy,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all()) as string[];
  const rows=readOnly(copy,db=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const storage=await ws.open({path:copy,migrations:CURRENT_MIGRATIONS});expect(storage.summary).toMatchObject({schemaVersion:10,migratedFrom:6});
  expect(digestOf(path.join(ws.backups,storage.summary.backupFileName!))).toEqual(before);storage.close();
  readOnly(copy,db=>{expect(tables.map(table=>withoutV10(table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).toEqual(rows);
    expect(db.prepare('SELECT * FROM trailer_baselines').all()).toEqual([]);expect(db.pragma('foreign_key_check')).toEqual([]);});
});
it('REG-007/013 rolls back failed schema7 DDL without modifying schema6 uploads or preparations',async()=>{
  const copy=ws.copyFixture('schema-v6-representative.sqlite'),before=digestOf(copy),real=CURRENT_MIGRATIONS[6];
  failed(await openStorage(ws.options({path:copy,migrations:[...CURRENT_MIGRATIONS.slice(0,6),{...real,up(db){real.up(db);throw new Error('injected schema7 failure');}}]})),'MIGRATION_FAILED');
  expect(digestOf(copy)).toEqual(before);
});

// ET-112b2 M15: migration 0009 adds the decision and boundary tables without a backfill (D1, D6). The expected rows are
// written by hand from schema-v8-representative.sql: trips 1-4 are closed legacy rows, trip 5 is open without proof.
describe('REG-013 schema 9 membership decisions (M15)',()=>{
  // Migration 0009 and its schema: the cases open with 0001-0009, as the frozen schema cases of older versions do.
  const UP_TO_V9=CURRENT_MIGRATIONS.slice(0,9);
  const V8='schema-v8-representative.sqlite',S5='10000000-0000-4000-8000-000000008005',T5='7203d1a0-9072-5fa8-a3cc-cdecb58ed012';
  const atNs=(ms:number)=>(1_000_000_000_000n+BigInt(ms)*1_000_000n).toString();
  const absent={available:false,reason:'not-observed'} as const;
  const tablesOf=(file:string)=>readOnly(file,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all()) as string[];
  const rowsOf=(file:string,tables:string[])=>readOnly(file,db=>Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const decisions=(file:string)=>readOnly(file,db=>db.prepare('SELECT * FROM logical_membership_decisions ORDER BY trip_ref').all());
  const boundaries=(file:string)=>readOnly(file,db=>db.prepare('SELECT * FROM session_profile_boundaries ORDER BY plugin_session_ref').all());
  const script5=()=>{const script=new Script(S5,'ets2',{utcMs:1_791_676_800_000});script.next=2n;return script;};
  /** A proof-less reading of the open legacy trip 5 after its last stored reading at 4,000 ms. */
  function readOpenLegacyTrip(storage:Awaited<ReturnType<typeof ws.open>>){
    const script=script5();
    ok(storage.appendSamples(S5,[{tripUuid:T5,utcMs:1_791_676_805_000,sourceClockId:script.clockId,monotonicNs:atNs(5000),odometer:{available:true,value:950_040},
      fuel:{available:true,value:419.5},speed:{available:true,value:0},gameTime:null,position:absent,averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,
      recording:{job:job({cargoId:{available:true,value:'synthetic_fixture_cargo_z'}}),truck:'synthetic-truck',processInstanceId:script.welcome().source.processInstanceId,
        previous:{tripUuid:T5,sourceClockId:script.clockId,monotonicNs:atNs(4000)}}}],{uniqueSeconds:true}));
  }
  /** The restart that closes trip 5, eventSeq 2 of its session. */
  const restartClose=()=>({message:script5().event(r.timersRestart()),effects:[{kind:'trip.close' as const,tripUuid:T5,outcome:'none' as const,closeReason:'restart' as const,
    recordingCompleteness:'partial' as const,endedUtcMs:1_791_676_806_000}]});
  it('migrates the frozen schema8 copy after a verified backup, keeps every row and writes no decision or boundary row',async()=>{
    const copy=ws.copyFixture(V8),before=digestOf(copy),tables=tablesOf(copy),rows=rowsOf(copy,tables);
    const storage=await ws.open({path:copy,migrations:UP_TO_V9});
    expect(storage.summary).toMatchObject({schemaVersion:9,created:false,migratedFrom:8,databaseUuid:'f0000000-0000-4000-8000-000000000008'});
    const backupName=storage.summary.backupFileName!;
    expect(digestOf(path.join(ws.backups,backupName))).toEqual(before);storage.close();
    expect(rowsOf(copy,tables)).toEqual(rows);
    expect(tablesOf(copy)).toEqual([...tables,'logical_membership_decisions','session_profile_boundaries'].sort());
    expect(decisions(copy)).toEqual([]);expect(boundaries(copy)).toEqual([]);
    expect(readOnly(copy,db=>db.prepare('SELECT version,name,backup_file_name FROM schema_migrations WHERE version=9').get())).toEqual({version:9,name:'0009-membership-decisions',backup_file_name:backupName});
    expect(readOnly(copy,db=>[db.pragma('foreign_key_check'),db.pragma('integrity_check',{simple:true})])).toEqual([[],'ok']);
    // A new database runs the same frozen statements, so its schema equals the migrated one.
    (await ws.open({migrations:UP_TO_V9})).close();expect(schemaOf(copy)).toEqual(schemaOf(ws.database));
  });
  it('gives only the open proof-less legacy trip a decision row, lazily, and never moves the closed legacy rows',async()=>{
    const copy=ws.copyFixture(V8);
    (await ws.open({path:copy,migrations:UP_TO_V9})).close();
    const legacy=rowsOf(copy,['logical_trips','logical_memberships']) as Record<string,Record<string,unknown>[]>;
    const storage=await ws.open({path:copy,migrations:UP_TO_V9});readOpenLegacyTrip(storage);storage.close();
    const pending={trip_ref:5,game:'ets2',plugin_session_ref:5,rule_version:1,state:'pending',reason:'profile-unverified',raw_closed_event_seq:null,target_logical_ref:null,decided_revision:null};
    expect(decisions(copy)).toEqual([pending]);
    const reopened=await ws.open({path:copy,migrations:UP_TO_V9});ok(reopened.commitEvent(restartClose()));reopened.close();
    expect(decisions(copy)).toEqual([{...pending,raw_closed_event_seq:'00000000000000000002'}]);
    expect(boundaries(copy)).toEqual([{plugin_session_ref:5,through_event_seq:'00000000000000000002'}]);
    const after=rowsOf(copy,['logical_trips','logical_memberships']) as Record<string,Record<string,unknown>[]>;
    const closed=(rows:Record<string,unknown>[])=>rows.filter(row=>row.id!==5&&row.trip_ref!==5);
    expect(closed(after.logical_trips)).toEqual(closed(legacy.logical_trips));expect(closed(after.logical_memberships)).toEqual(closed(legacy.logical_memberships));
  });
  it('rolls back an injected 0009 failure, names the verified backup and reuses it on the next open',async()=>{
    const copy=ws.copyFixture(V8),before=digestOf(copy),real=CURRENT_MIGRATIONS[8];
    const error=failed(await openStorage(ws.options({path:copy,migrations:[...CURRENT_MIGRATIONS.slice(0,8),{...real,up(db){real.up(db);throw new Error('injected schema9 failure');}}]})),'MIGRATION_FAILED');
    expect(digestOf(copy)).toEqual(before);
    expect(error.backupFileName).toMatch(/^telemetry-f0000000-v8-.*\.sqlite$/);expect(existsSync(path.join(ws.backups,error.backupFileName!))).toBe(true);
    const storage=await ws.open({path:copy,migrations:UP_TO_V9});
    expect(storage.summary).toMatchObject({schemaVersion:9,migratedFrom:8,backupFileName:error.backupFileName});storage.close();
  });
  it('is refused with SCHEMA_NEWER by a schema8 build without changing the file',async()=>{
    const copy=ws.copyFixture(V8);(await ws.open({path:copy,migrations:UP_TO_V9})).close();
    const hash=sha256(copy),listing=files(path.dirname(copy));
    failed(await openStorage(ws.options({path:copy,migrations:CURRENT_MIGRATIONS.slice(0,8)})),'SCHEMA_NEWER');
    expect(sha256(copy)).toBe(hash);expect(files(path.dirname(copy))).toEqual(listing);
  });
  it('includes both schema9 tables in the logical digest and in a later verified backup',async()=>{
    const copy=ws.copyFixture(V8),storage=await ws.open({path:copy,migrations:UP_TO_V9});
    readOpenLegacyTrip(storage);ok(storage.commitEvent(restartClose()));storage.close();
    const before=digestOf(copy);
    expect(before.rowCounts).toMatchObject({logical_membership_decisions:1,session_profile_boundaries:1});
    const testV10:Migration={version:10,name:'0010-test',up:db=>{db.exec('CREATE TABLE test_v10 (id INTEGER PRIMARY KEY)');}};
    const upgraded=await ws.open({path:copy,migrations:[...UP_TO_V9,testV10]});
    expect(upgraded.summary).toMatchObject({schemaVersion:10,migratedFrom:9});upgraded.close();
    const backup=path.join(ws.backups,upgraded.summary.backupFileName!);
    expect(digestOf(backup)).toEqual(before);
    expect(JSON.parse(readFileSync(backup.replace(/\.sqlite$/,'.json'),'utf8'))).toMatchObject({fromVersion:9,logicalDigest:before.logicalDigest,
      rowCounts:{logical_membership_decisions:1,session_profile_boundaries:1}});
    expect(readOnly(backup,db=>[db.prepare('SELECT trip_ref,state FROM logical_membership_decisions').all(),db.prepare('SELECT * FROM session_profile_boundaries').all()]))
      .toEqual([[{trip_ref:5,state:'pending'}],[{plugin_session_ref:5,through_event_seq:'00000000000000000002'}]]);
  });
});

// ET-112c2: migration 0010 adds the logical trip's distance and fuel engine and the ledger flags, additively and without a
// backfill. The expected rows are written by hand from schema-v9-representative.sql: five groups and seventeen ledger rows,
// all of them engine 0 without flags afterwards (schema 9 meaning).
describe('REG-013 schema 10 quantity engine',()=>{
  const V9='schema-v9-representative.sqlite';
  const tablesOf=(file:string)=>readOnly(file,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all()) as string[];
  const rowsOf=(file:string,tables:string[])=>readOnly(file,db=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const columns=(file:string,table:string,name:string)=>readOnly(file,db=>(db.pragma(`table_info(${table})`) as {name:string}[]).filter(column=>column.name===name));
  it('migrates the frozen schema9 copy after a verified backup and keeps every existing column of every row',async()=>{
    const copy=ws.copyFixture(V9),before=digestOf(copy),tables=tablesOf(copy),rows=rowsOf(copy,tables);
    const storage=await ws.open({path:copy,migrations:CURRENT_MIGRATIONS});
    expect(storage.summary).toMatchObject({schemaVersion:10,created:false,migratedFrom:9,databaseUuid:'f0000000-0000-4000-8000-000000000009'});
    const backupName=storage.summary.backupFileName!;
    expect(backupName).toMatch(/^telemetry-f0000000-v9-.*\.sqlite$/);expect(digestOf(path.join(ws.backups,backupName))).toEqual(before);storage.close();
    expect(tablesOf(copy)).toEqual(tables);
    expect(rowsOf(copy,tables).map((after,index)=>withoutV10(tables[index],after))).toEqual(rows);
    readOnly(copy,db=>{
      expect(db.prepare('SELECT accounting_engine FROM logical_trips ORDER BY id').pluck().all()).toEqual([0,0,0,0,0]);
      expect(db.prepare('SELECT count(*) FROM logical_progress WHERE quantity_flags IS NULL').pluck().get()).toBe(17);
      expect(db.prepare('SELECT version,name,backup_file_name FROM schema_migrations WHERE version=10').get()).toEqual({version:10,name:'0010-quantity-engine',backup_file_name:backupName});
      expect([db.pragma('foreign_key_check'),db.pragma('integrity_check',{simple:true})]).toEqual([[],'ok']);
    });
    // A new database runs the same frozen statements, so its schema equals the migrated one.
    (await ws.open({migrations:CURRENT_MIGRATIONS})).close();expect(schemaOf(copy)).toEqual(schemaOf(ws.database));
  });
  it('defaults the column engine to 0 and the flags to NULL, and the current writer creates engine 1 groups with a base row',async()=>{
    const storage=await ws.open({migrations:CURRENT_MIGRATIONS});
    const script=new Script('10000000-0000-4000-8000-000000010001'),absent={available:false,reason:'not-observed'} as const;
    ok(storage.upsertSession({message:script.welcome()}));
    const configured=script.event(r.jobConfigured()),tripUuid=tripUuidFor(script.session,configured.data.eventSeq);
    ok(storage.commitEvent({message:configured,effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',
      startedUtcMs:1000,recordingCompleteness:'complete'},{kind:'event.attribute',tripUuid,attribution:'trip'}]}));
    ok(storage.appendSamples(script.session,[{tripUuid,utcMs:2000,sourceClockId:script.clockId,monotonicNs:'2000000000',odometer:{available:true,value:1000},fuel:{available:true,value:400},
      speed:{available:true,value:20},gameTime:{minutes:{available:true,value:600},clockId:'40000000-0000-4000-8000-000000000001'},position:{available:true,value:{x:0,y:0,z:0}},
      averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,recording:{job:job(),truck:'synthetic-truck',processInstanceId:script.welcome().source.processInstanceId}}],{uniqueSeconds:true}));
    storage.close();
    expect(columns(ws.database,'logical_trips','accounting_engine')).toEqual([{cid:16,name:'accounting_engine',type:'INTEGER',notnull:1,dflt_value:'0',pk:0}]);
    expect(columns(ws.database,'logical_progress','quantity_flags')).toEqual([{cid:14,name:'quantity_flags',type:'INTEGER',notnull:0,dflt_value:null,pk:0}]);
    expect(readOnly(ws.database,db=>[db.prepare('SELECT accounting_engine FROM logical_trips').pluck().all(),db.prepare('SELECT quantity_flags FROM logical_progress').pluck().all()]))
      .toEqual([[1],[QUANTITY_FLAGS.base]]);
  });
  it('is refused with SCHEMA_NEWER by a schema9 build, and a schema10 build refuses a schema11 database, without changing either file',async()=>{
    const copy=ws.copyFixture(V9);(await ws.open({path:copy,migrations:CURRENT_MIGRATIONS})).close();
    let hash=sha256(copy),listing=files(path.dirname(copy));
    failed(await openStorage(ws.options({path:copy,migrations:CURRENT_MIGRATIONS.slice(0,9)})),'SCHEMA_NEWER');
    expect(sha256(copy)).toBe(hash);expect(files(path.dirname(copy))).toEqual(listing);
    const testV11:Migration={version:11,name:'0011-test',up:db=>{db.exec('CREATE TABLE test_v11 (id INTEGER PRIMARY KEY)');}};
    (await ws.open({path:copy,migrations:[...CURRENT_MIGRATIONS,testV11]})).close();
    hash=sha256(copy);listing=files(path.dirname(copy));
    failed(await openStorage(ws.options({path:copy,migrations:CURRENT_MIGRATIONS})),'SCHEMA_NEWER');
    expect(sha256(copy)).toBe(hash);expect(files(path.dirname(copy))).toEqual(listing);
  });
});
