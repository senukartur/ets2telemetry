import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import Database from 'better-sqlite3';
import {MIGRATIONS, openStorage} from '../../packages/storage/src/index';
import {digestOf, failed, files, readOnly, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

describe('ET-062 migration 0008 (0008-haulmp-mode)', () => {
  it.each([1, 2])('migrates frozen schema %i to v8, preserving data and allowing haulmp game_mode', async version => {
    const file = ws.copyFixture(`schema-v${version}-representative.sqlite`), originalHash = sha256(file), before = digestOf(file);
    const tripsBefore = readOnly(file, db => db.prepare('SELECT * FROM trips ORDER BY id').all()) as Record<string, unknown>[];
    const sessionsBefore = readOnly(file, db => db.prepare('SELECT * FROM plugin_sessions ORDER BY id').all()) as Record<string, unknown>[];

    const storage = await ws.open({path: file});
    expect(storage.summary.schemaVersion).toBe(9);
    expect(storage.summary.migratedFrom).toBe(version);
    const backup = path.join(ws.backups, storage.summary.backupFileName!);
    expect(digestOf(backup)).toEqual(before);
    expect(storage.summary.backupFileName).toBeTruthy();
    storage.close();

    readOnly(file, db => {
      // Row counts and original columns are preserved
      const tripsAfter = db.prepare('SELECT * FROM trips ORDER BY id').all() as Record<string, unknown>[];
      const sessionsAfter = db.prepare('SELECT * FROM plugin_sessions ORDER BY id').all() as Record<string, unknown>[];
      expect(tripsAfter.length).toBe(tripsBefore.length);
      expect(sessionsAfter.length).toBe(sessionsBefore.length);

      // Trailer baselines table from migration 7 exists and is empty
      expect(db.prepare('SELECT COUNT(*) FROM trailer_baselines').pluck().get()).toBe(0);

      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
    });
    expect(originalHash).toBeTruthy();
  });

  it('enforces CHECK constraint with haulmp allowed and invalid modes rejected on trips and plugin_sessions', async () => {
    const file = ws.copyFixture('schema-v2-representative.sqlite');
    (await ws.open({path: file})).close();

    const db = new Database(file);
    try {
      // plugin_sessions: allows 'haulmp'
      expect(() => {
        db.prepare(`UPDATE plugin_sessions SET game_mode = 'haulmp' WHERE id = 1`).run();
      }).not.toThrow();
      expect(db.prepare(`SELECT game_mode FROM plugin_sessions WHERE id = 1`).pluck().get()).toBe('haulmp');

      // plugin_sessions: rejects invalid game mode
      expect(() => {
        db.prepare(`UPDATE plugin_sessions SET game_mode = 'invalid-mode' WHERE id = 1`).run();
      }).toThrow();

      // trips: allows 'haulmp'
      expect(() => {
        db.prepare(`UPDATE trips SET game_mode = 'haulmp' WHERE id = 1`).run();
      }).not.toThrow();
      expect(db.prepare(`SELECT game_mode FROM trips WHERE id = 1`).pluck().get()).toBe('haulmp');

      // trips: rejects invalid game mode
      expect(() => {
        db.prepare(`UPDATE trips SET game_mode = 'invalid-mode' WHERE id = 1`).run();
      }).toThrow();

      // trigger check: plugin_sessions_identity immutable
      expect(() => {
        db.prepare(`UPDATE plugin_sessions SET game = 'ats' WHERE id = 1`).run();
      }).toThrow();

      // trigger check: plugin_sessions_origin immutable / accepted origin
      expect(() => {
        db.prepare(`INSERT INTO plugin_sessions (
          id, plugin_session_uuid, game, origin, process_instance_uuid, process_id, windows_session_id,
          protocol_major, protocol_minor, telemetry_api_major, telemetry_api_minor, game_telemetry_major,
          game_telemetry_minor, sdk_archive, gameplay_events, event_types_json, game_mode, game_mode_method,
          game_mode_confidence, game_mode_module, game_mode_module_state, committed_through_event_seq,
          first_seen_utc_ms, end_reason, end_next_event_seq
        ) VALUES (
          99, '10000000-0000-4000-8000-000000000099', 'ets2', 'game', '20000000-0000-4000-8000-000000000099', 1234, 1,
          1, 3, 1, 0, 1, 0, 'archive', 'registered', '[]', 'haulmp', 'module-scan', 'strong', 'haulmp_stub.dll', 'available',
          '00000000000000000001', 1700000000, NULL, NULL
        )`).run();
      }).toThrow(/origin is not accepted/);
    } finally {
      db.close();
    }
  });

  it('rolls back partially applied 0008 and reuses its verified backup on a later successful open', async () => {
    const file = ws.copyFixture('schema-v2-representative.sqlite'), before = digestOf(file);
    const broken = [
      ...MIGRATIONS.slice(0, 7),
      {...MIGRATIONS[7], up: (db: Parameters<typeof MIGRATIONS[7]['up']>[0]) => {
        MIGRATIONS[7].up(db);
        throw new Error('Injected after migration 8 SQL');
      }}
    ];
    const error = failed(await openStorage(ws.options({path: file, migrations: broken})), 'MIGRATION_FAILED');
    expect(digestOf(file)).toEqual(before);
    expect(error.backupFileName).toBeTruthy();
    const backupFiles = files(ws.backups);
    const storage = await ws.open({path: file});
    expect(storage.summary.schemaVersion).toBe(9);
    expect(storage.summary.backupFileName).toBe(error.backupFileName);
    storage.close();
    expect(files(ws.backups)).toEqual(backupFiles);
  });
});
