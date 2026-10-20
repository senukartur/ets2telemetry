import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage} from '../../packages/storage/src/index';
import {digestOf, failed, files, readOnly, sha256, workspace} from './helpers';
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await ws.dispose();});
describe('ET-026 migration 0003 (REG-013)', () => {
  it.each([1, 2])('preserves every existing trip column and ID when migrating frozen schema %i, with false/null defaults', async version => {
    const file = ws.copyFixture(`schema-v${version}-representative.sqlite`), originalHash = sha256(file), before = digestOf(file);
    const trips = readOnly(file, db => db.prepare('SELECT * FROM trips ORDER BY id').all()) as Record<string, unknown>[];
    const storage = await ws.open({path: file}); expect(storage.summary.schemaVersion).toBe(3); expect(storage.summary.migratedFrom).toBe(version);
    const backup = path.join(ws.backups, storage.summary.backupFileName!); expect(digestOf(backup)).toEqual(before);
    expect(storage.summary.backupFileName).toBeTruthy(); storage.close();
    readOnly(file, db => {
      const actual = db.prepare('SELECT * FROM trips ORDER BY id').all() as Record<string, unknown>[];
      expect(actual.map(row => ({isHardMode: row.is_hard_mode, audit: row.hard_mode_details}))).toEqual(trips.map(() => ({isHardMode: 0, audit: null})));
      // Migration 0002 may add columns when the source was v1; every original column stays exactly the same.
      expect(actual.map(row => Object.fromEntries(Object.keys(trips[0]).map(key => [key, row[key]])))).toEqual(trips);
      expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
    });
    expect(originalHash).toBeTruthy();
  });
  it('rolls back partially applied 0003 and reuses its verified backup on a later successful open', async () => {
    const file = ws.copyFixture('schema-v2-representative.sqlite'), before = digestOf(file);
    const broken = [...MIGRATIONS.slice(0, 2), {...MIGRATIONS[2], up: (db: Parameters<typeof MIGRATIONS[2]['up']>[0]) => {MIGRATIONS[2].up(db); throw new Error('Injected after migration SQL');}}];
    const error = failed(await openStorage(ws.options({path: file, migrations: broken})), 'MIGRATION_FAILED');
    expect(digestOf(file)).toEqual(before); expect(error.backupFileName).toBeTruthy(); const backupFiles = files(ws.backups);
    const storage = await ws.open({path: file}); expect(storage.summary.schemaVersion).toBe(3); expect(storage.summary.backupFileName).toBe(error.backupFileName); storage.close();
    expect(files(ws.backups)).toEqual(backupFiles);
  });
  it('keeps INTEGER boolean and bounded valid JSON constraints in SQLite STRICT', async () => {
    const file = ws.copyFixture('schema-v2-representative.sqlite'); (await ws.open({path: file})).close();
    // Constraint attempts run against the closed isolated fixture copy, never historical source bytes.
    const Database = (await import('better-sqlite3')).default, db = new Database(file);
    try {
      expect(() => db.prepare('UPDATE trips SET is_hard_mode = 2').run()).toThrow();
      expect(() => db.prepare('UPDATE trips SET hard_mode_details = ?').run('not json')).toThrow();
      expect(() => db.prepare('UPDATE trips SET hard_mode_details = ?').run(JSON.stringify({x: 'x'.repeat(17000)}))).toThrow();
    } finally {db.close();}
  });
});
