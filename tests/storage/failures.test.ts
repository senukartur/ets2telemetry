import {chmodSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openStorage, Storage, type StorageError} from '../../packages/storage/src/index';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {failed, ok, P1, sha256, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
const errors: StorageError[] = [];
const collect = (error: StorageError) => { errors.push(error); return error; };
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

describe('REG-007 visible write failures', () => {
  it('reports a full database as DISK_FULL with no commit result, keeps integrity and commits once after space returns', async () => {
    const connection = await openConnection(ws.options()), storage = new Storage(connection);
    try {
      const worst = v1('event-worst');
      if (worst.kind !== 'event') throw new Error('fixture');
      ok(storage.upsertSession({message: {...v1('welcome'), source: worst.source}}));
      const db = connection.writer(), pages = Number(db.pragma('page_count', {simple: true}));
      // Cap the file at its current size: the next event needs overflow pages that cannot be allocated.
      db.pragma(`max_page_count = ${pages}`);
      const error = collect(failed(storage.commitEvent({message: worst}), 'DISK_FULL'));
      expect(error).toMatchObject({retryable: true, sqliteCode: 'SQLITE_FULL'});
      expect(ok(storage.getEvent(worst.source.pluginSessionId, worst.data.eventSeq))).toBeUndefined();
      expect(ok(storage.committedThrough(worst.source.pluginSessionId))).toBe('0');
      expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
      db.pragma(`max_page_count = ${pages + 1_000}`);
      expect(ok(storage.commitEvent({message: worst}))).toEqual({status: 'committed', committedThroughEventSeq: worst.data.eventSeq === '1' ? '1' : '0'});
      expect(ok(storage.commitEvent({message: worst})).status).toBe('duplicate');
    } finally { connection.close(); }
  });
  it('reports a read-only database file as PERMISSION_DENIED without changing it', async () => {
    ok(await openStorage(ws.options())).close();
    const before = sha256(ws.database);
    chmodSync(ws.database, 0o444);
    try {
      collect(failed(await openStorage(ws.options()), 'PERMISSION_DENIED'));
      expect(sha256(ws.database)).toBe(before);
    } finally { chmodSync(ws.database, 0o666); }
  });
  it('reports a data directory blocked by a file as DATA_PATH_INVALID', async () => {
    const blocker = path.join(ws.directory, 'data');
    writeFileSync(blocker, 'a file where the data directory belongs');
    collect(failed(await openStorage(ws.options({path: path.join(blocker, 'telemetry.sqlite')})), 'DATA_PATH_INVALID'));
  });
  it('reports a second writer as retryable DATABASE_LOCKED while the first keeps its commits', async () => {
    const first = await ws.open();
    ok(first.upsertSession({message: v1('welcome')}));
    ok(first.commitEvent({message: v1('event-job-configured')}));
    expect(collect(failed(await openStorage(ws.options()), 'DATABASE_LOCKED')).retryable).toBe(true);
    expect(ok(first.committedThrough(P1))).toBe('1');
  });
  it('never puts a filesystem path into an error result', () => {
    expect(errors.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(errors);
    for (const fragment of [tmpdir(), 'ets2telemetry-test-', ':\\', '.sqlite']) expect(text).not.toContain(fragment);
  });
});
