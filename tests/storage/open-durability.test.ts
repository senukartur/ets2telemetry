import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openStorage} from '../../packages/storage/src/index';
import {openConnection, StorageConnection, type OpenTestHooks} from '../../packages/storage/src/sqlite/connection';
import {upsertSession} from '../../packages/storage/src/sqlite/writes';
import {digestOf, failed, ok, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

/** Reads the durability settings back from the live writer connection itself. */
function liveSettings(connection: StorageConnection) {
  const db = connection.reader(), read = (name: string) => db.pragma(name, {simple: true});
  return {lockingMode: read('locking_mode'), journalMode: read('journal_mode'), synchronous: Number(read('synchronous')), foreignKeys: Number(read('foreign_keys'))};
}
const EXPECTED = {lockingMode: 'exclusive', journalMode: 'wal', synchronous: 2, foreignKeys: 1};

describe('durability sequence on every writer open', () => {
  it('reads back exclusive locking, WAL, synchronous FULL and foreign keys on create and on three reopens', async () => {
    for (let open = 0; open < 4; open++) {
      const connection = await openConnection(ws.options());
      expect(connection.summary.created).toBe(open === 0);
      expect(liveSettings(connection)).toEqual(EXPECTED);
      expect(connection.durability).toEqual({journalMode: 'wal', synchronous: 'full', lockingMode: 'exclusive', foreignKeys: true});
      // Exclusive locking was set before the first WAL access, so SQLite never creates a shared-memory index.
      expect(existsSync(`${ws.database}-shm`)).toBe(false);
      connection.close();
    }
  });
  it('needs the explicit FULL setting: a plain connection to the same WAL file reads NORMAL (1)', async () => {
    ok(await openStorage(ws.options())).close();
    const control = new Database(ws.database);
    try {
      expect(control.pragma('journal_mode', {simple: true})).toBe('wal');
      // better-sqlite3 13.0.3 compiles SQLITE_DEFAULT_WAL_SYNCHRONOUS=1.
      expect(control.pragma('synchronous', {simple: true})).toBe(1);
    } finally { control.close(); }
  });
  for (const pragma of ['locking_mode', 'journal_mode', 'synchronous', 'foreign_keys'] as const) {
    it(`refuses the open when the ${pragma} read-back differs, before any write`, async () => {
      ok(await openStorage(ws.options())).close();
      const before = digestOf(ws.database);
      const readBack: OpenTestHooks['readBack'] = (name, value) => name === pragma ? 'mismatch' : value;
      failed(await openStorage(ws.options({testHooks: {readBack}})), 'DURABILITY_UNVERIFIED');
      expect(digestOf(ws.database)).toEqual(before);
      // The refused connection was closed: a normal open succeeds and is not locked out.
      ok(await openStorage(ws.options())).close();
    });
  }
  it('creates no schema in a new file when durability cannot be verified', async () => {
    failed(await openStorage(ws.options({testHooks: {readBack: (name, value) => name === 'synchronous' ? 1 : value}})), 'DURABILITY_UNVERIFIED');
    if (existsSync(ws.database) && statSync(ws.database).size > 0) {
      expect(digestOf(ws.database)).toMatchObject({applicationId: 0, userVersion: 0, rowCounts: {}});
    }
    // The next verified open still treats the file as new.
    expect((await ws.open()).summary.created).toBe(true);
  });
  it('refuses every write on a connection whose durability was not verified', () => {
    const db = new Database(path.join(ws.directory, 'raw.sqlite'));
    const unverified = new StorageConnection(db, undefined, {schemaVersion: 1, created: true, databaseUuid: '00000000-0000-4000-8000-000000000000', purpose: 'synthetic'}, ws.now);
    try {
      expect(() => upsertSession(unverified, {message: v1('welcome')})).toThrow(expect.objectContaining({error: expect.objectContaining({code: 'DURABILITY_UNVERIFIED'})}));
    } finally { unverified.close(); }
  });
  it('refuses in-memory, relative and non-normalized paths and synthetic data at the production history path', async () => {
    for (const bad of [':memory:', 'relative.sqlite', '', 'file:x.sqlite', '\\drive-relative.sqlite']) {
      failed(await openStorage(ws.options({path: bad})), 'DATA_PATH_INVALID');
    }
    const production = path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
    for (const purpose of ['synthetic', 'replay'] as const) failed(await openStorage(ws.options({path: production, purpose})), 'DATA_PATH_INVALID');
    expect(existsSync(production)).toBe(false);
  });
  it('allows one writer: a second open is DATABASE_LOCKED and the first keeps working', async () => {
    const first = await ws.open();
    failed(await openStorage(ws.options()), 'DATABASE_LOCKED');
    expect(ok(first.upsertSession({message: v1('welcome')})).created).toBe(true);
    first.close();
    ok(await openStorage(ws.options())).close();
  });
  it('fails commands after close with STORAGE_CLOSED', async () => {
    const storage = await ws.open(); storage.close();
    failed(storage.upsertSession({message: v1('welcome')}), 'STORAGE_CLOSED');
    failed(storage.storageInfo(), 'STORAGE_CLOSED');
  });
  it('reports the verified durability, schema version and identity', async () => {
    const storage = await ws.open();
    const info = ok(storage.storageInfo());
    expect(info).toMatchObject({schemaVersion: 1, purpose: 'synthetic', acceptedOrigin: 'synthetic', durability: {journalMode: 'wal', synchronous: 'full', lockingMode: 'exclusive', foreignKeys: true}});
    expect(info.databaseUuid).toBe(storage.summary.databaseUuid);
  });
});
