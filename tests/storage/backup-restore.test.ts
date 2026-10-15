import {closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage, restoreBackup, type Migration} from '../../packages/storage/src/index';
import {digestOf, expectRepresentative, failed, files, ok, REPRESENTATIVE, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const step = (version: number): Migration => ({version, name: `000${version}-test`, up: db => { db.exec(`CREATE TABLE test_v${version} (id INTEGER PRIMARY KEY)`); }});
const upTo = (version: number) => [...MIGRATIONS, ...Array.from({length: version - 1}, (_, i) => step(i + 2))];
const failingStep = (version: number): Migration => ({version, name: `000${version}-test-failure`, up: () => { throw new Error('injected migration failure'); }});
/** Overwrites bytes in the middle of a file, as disk damage would. */
function damage(file: string) { const fd = openSync(file, 'r+'); try { writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 8192); } finally { closeSync(fd); } }

describe('REG-013/REG-007 verified backups', () => {
  it('refuses a damaged backup copy and migrates nothing', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = digestOf(copy);
    const error = failed(await openStorage(ws.options({path: copy, migrations: upTo(2), testHooks: {afterCopy: damage}})), 'BACKUP_FAILED');
    expect(error.cause).toBe('DATABASE_CORRUPT');
    expect(digestOf(copy)).toEqual(before);
    expect(files(ws.backups)).toEqual([]);
  });
  it('stops before migrating when the backup directory is blocked by a file or free space is too low', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = digestOf(copy);
    writeFileSync(ws.backups, 'a file where the backup directory belongs');
    expect(failed(await openStorage(ws.options({path: copy, migrations: upTo(2)})), 'BACKUP_FAILED').cause).toBe('DATA_PATH_INVALID');
    expect(digestOf(copy)).toEqual(before);
    const lowDisk = path.join(ws.directory, 'low-disk-backups');
    expect(failed(await openStorage(ws.options({path: copy, backupsDirectory: lowDisk, migrations: upTo(2), testHooks: {freeBytes: () => 1_000}})), 'BACKUP_FAILED').cause).toBe('DISK_FULL');
    expect(digestOf(copy)).toEqual(before);
    expect(files(lowDisk)).toEqual([]);
  });
  it('reuses one verified backup when the same migration fails on every open', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), alwaysFails = [...upTo(2), failingStep(3)];
    const names = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
      ws.advance(60_000);
      names.add(failed(await openStorage(ws.options({path: copy, migrations: alwaysFails})), 'MIGRATION_FAILED').backupFileName!);
    }
    expect(names.size).toBe(1);
    expect(files(ws.backups)).toEqual(['telemetry-f0000000-v1-20261015T120100000Z.json', 'telemetry-f0000000-v1-20261015T120100000Z.sqlite']);
  });
  it('never reuses a backup whose bytes no longer match its manifest', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), alwaysFails = [...upTo(2), failingStep(3)];
    const first = failed(await openStorage(ws.options({path: copy, migrations: alwaysFails})), 'MIGRATION_FAILED').backupFileName!;
    damage(path.join(ws.backups, first));
    ws.advance(60_000);
    const second = failed(await openStorage(ws.options({path: copy, migrations: alwaysFails})), 'MIGRATION_FAILED').backupFileName!;
    expect(second).not.toBe(first);
    expect(digestOf(path.join(ws.backups, second))).toEqual(digestOf(copy));
  });
  it('keeps the three newest verified backups of a database and never touches other files', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    mkdirSync(ws.backups);
    writeFileSync(path.join(ws.backups, 'unrelated.sqlite'), 'not described by a manifest');
    writeFileSync(path.join(ws.backups, 'other.json'), JSON.stringify({format: 'something-else'}));
    for (let version = 2; version <= 5; version++) {
      ws.advance(60_000);
      ok(await openStorage(ws.options({path: copy, migrations: upTo(version)}))).close();
    }
    const backups = files(ws.backups).filter(name => name.startsWith('telemetry-'));
    expect(backups).toEqual([
      'telemetry-f0000000-v2-20261015T120200000Z.json', 'telemetry-f0000000-v2-20261015T120200000Z.sqlite',
      'telemetry-f0000000-v3-20261015T120300000Z.json', 'telemetry-f0000000-v3-20261015T120300000Z.sqlite',
      'telemetry-f0000000-v4-20261015T120400000Z.json', 'telemetry-f0000000-v4-20261015T120400000Z.sqlite'
    ]);
    expect(files(ws.backups).filter(name => !name.startsWith('telemetry-'))).toEqual(['other.json', 'unrelated.sqlite']);
  });
});

describe('REG-013 restore into a new file', () => {
  async function migratedWithBackup() {
    const copy = ws.copyFixture(REPRESENTATIVE);
    const storage = ok(await openStorage(ws.options({path: copy, migrations: upTo(2)})));
    const manifest = path.join(ws.backups, storage.summary.backupFileName!.replace(/\.sqlite$/, '.json'));
    storage.close();
    return manifest;
  }
  it('restores trip, session and event identities and exact money from a verified backup', async () => {
    const manifest = await migratedWithBackup(), target = path.join(ws.directory, 'restored', 'telemetry.sqlite');
    const storage = ok(await restoreBackup(manifest, ws.options({path: target})));
    expect(storage.summary).toMatchObject({schemaVersion: 1, created: false, databaseUuid: 'f0000000-0000-4000-8000-000000000001'});
    expectRepresentative(storage, target);
  });
  it('migrates a restored older backup through the normal open path', async () => {
    const manifest = await migratedWithBackup(), target = path.join(ws.directory, 'restored.sqlite');
    const storage = ok(await restoreBackup(manifest, ws.options({path: target, backupsDirectory: path.join(ws.directory, 'restored-backups'), migrations: upTo(2)})));
    expect(storage.summary).toMatchObject({schemaVersion: 2, migratedFrom: 1});
    expectRepresentative(storage, target, {schema_migrations: 2, test_v2: 0});
  });
  it('refuses an existing target or a stray WAL file, and a backup whose bytes changed', async () => {
    const manifest = await migratedWithBackup();
    const existing = ws.copyFixture('foreign-application.sqlite'), before = sha256(existing);
    failed(await restoreBackup(manifest, ws.options({path: existing})), 'DATA_PATH_INVALID');
    expect(sha256(existing)).toBe(before);
    const stray = path.join(ws.directory, 'stray.sqlite'); writeFileSync(`${stray}-wal`, '');
    failed(await restoreBackup(manifest, ws.options({path: stray})), 'DATA_PATH_INVALID');
    const backup = manifest.replace(/\.json$/, '.sqlite'); damage(backup);
    const target = path.join(ws.directory, 'from-damaged.sqlite');
    expect(failed(await restoreBackup(manifest, ws.options({path: target})), 'BACKUP_FAILED').cause).toBe('DATABASE_CORRUPT');
    expect(files(ws.directory).filter(name => name.startsWith('from-damaged'))).toEqual([]);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).fileSha256).not.toBe(sha256(backup));
  });
});
