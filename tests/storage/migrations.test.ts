import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage, type Migration} from '../../packages/storage/src/index';
import {digestOf, expectRepresentative, failed, files, ok, readOnly, REPRESENTATIVE, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const v2: Migration = {version: 2, name: '0002-test-trip-note', up: db => { db.exec('ALTER TABLE trips ADD COLUMN test_note TEXT'); }};
const failingV3: Migration = {version: 3, name: '0003-test-failure', up: db => { db.exec('CREATE TABLE test_v3 (id INTEGER PRIMARY KEY)'); throw new Error('injected migration failure'); }};
/** Opens a file that is not ours and checks that it was refused without changing a byte or leaving sidecar files. */
async function expectRefused(file: string, code: 'SCHEMA_NEWER' | 'DATABASE_UNRECOGNIZED' | 'PURPOSE_MISMATCH', purpose: 'synthetic' | 'history' = 'synthetic') {
  const before = sha256(file), listing = files(path.dirname(file));
  failed(await openStorage(ws.options({path: file, purpose})), code);
  expect(sha256(file)).toBe(before);
  expect(files(path.dirname(file))).toEqual(listing);
}

describe('REG-013 schema migrations', () => {
  it('migrates an immutable version 1 copy forward after a verified backup and keeps every ID and value', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), original = digestOf(copy);
    const storage = await ws.open({path: copy, migrations: [...MIGRATIONS, v2]});
    expect(storage.summary).toMatchObject({schemaVersion: 2, created: false, migratedFrom: 1});
    const backupName = storage.summary.backupFileName!;
    expect(backupName).toMatch(/^telemetry-f0000000-v1-20261015T120000000Z\.sqlite$/);
    expectRepresentative(storage, copy, {schema_migrations: 2});
    // The backup is the version 1 content, byte-for-byte in logical terms, with a manifest written last.
    const backup = path.join(ws.backups, backupName);
    expect(digestOf(backup)).toEqual(original);
    const manifest = JSON.parse(readFileSync(backup.replace(/\.sqlite$/, '.json'), 'utf8'));
    expect(manifest).toMatchObject({format: 'ets2telemetry-backup-1', databaseUuid: 'f0000000-0000-4000-8000-000000000001', fromVersion: 1, fileName: backupName,
      fileSha256: sha256(backup), logicalDigest: original.logicalDigest, rowCounts: original.rowCounts, reason: 'pre-migration'});
    const recorded = readOnly(copy, db => db.prepare('SELECT version, name, backup_file_name, backup_sha256 FROM schema_migrations ORDER BY version').all());
    expect(recorded).toEqual([{version: 1, name: '0001-initial', backup_file_name: null, backup_sha256: null}, {version: 2, name: '0002-test-trip-note', backup_file_name: backupName, backup_sha256: manifest.fileSha256}]);
    expect(digestOf(copy).userVersion).toBe(2);
  });
  it('leaves the database at version 1 with unchanged content when a later step fails', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = digestOf(copy);
    const error = failed(await openStorage(ws.options({path: copy, migrations: [...MIGRATIONS, v2, failingV3]})), 'MIGRATION_FAILED');
    expect(error.backupFileName).toMatch(/^telemetry-f0000000-v1-.*\.sqlite$/);
    expect(existsSync(path.join(ws.backups, error.backupFileName!))).toBe(true);
    expect(digestOf(copy)).toEqual(before);
    expectRepresentative(await ws.open({path: copy}), copy);
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
  it('creates a new database in an existing empty file', async () => {
    writeFileSync(ws.database, '');
    expect((await ws.open()).summary).toMatchObject({created: true, schemaVersion: 1});
  });
});
