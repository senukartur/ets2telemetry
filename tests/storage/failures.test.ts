import {chmodSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openStorage, Storage, type Result, type StorageErrorCode} from '../../packages/storage/src/index';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {failed, ok, P1, sha256, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

/** Expects the failure code and checks, for this very result, that no filesystem path leaked into it. */
function failedWithoutPath<T>(result: Result<T>, code: StorageErrorCode) {
  const error = failed(result, code), text = JSON.stringify(error);
  for (const fragment of [tmpdir(), ws.directory, 'ets2telemetry-test-', ':\\', '.sqlite']) expect(text).not.toContain(fragment);
  return error;
}

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
      const error = failedWithoutPath(storage.commitEvent({message: worst}), 'DISK_FULL');
      expect(error).toMatchObject({retryable: true, sqliteCode: 'SQLITE_FULL'});
      expect(ok(storage.getEvent(worst.source.pluginSessionId, worst.data.eventSeq))).toBeUndefined();
      expect(ok(storage.committedThrough(worst.source.pluginSessionId))).toBe('0');
      expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
      db.pragma(`max_page_count = ${pages + 1_000}`);
      // The fixture's eventSeq is the last assignable one, so contiguous coverage stays 0 after it commits.
      expect(ok(storage.commitEvent({message: worst}))).toEqual({status: 'committed', committedThroughEventSeq: '0'});
      expect(ok(storage.commitEvent({message: worst})).status).toBe('duplicate');
    } finally { connection.close(); }
  });
  it('reports a read-only database file as PERMISSION_DENIED without changing it', async () => {
    ok(await openStorage(ws.options())).close();
    const before = sha256(ws.database);
    chmodSync(ws.database, 0o444);
    try {
      failedWithoutPath(await openStorage(ws.options()), 'PERMISSION_DENIED');
      expect(sha256(ws.database)).toBe(before);
    } finally { chmodSync(ws.database, 0o666); }
  });
  it('reports a data directory blocked by a file as DATA_PATH_INVALID', async () => {
    const blocker = path.join(ws.directory, 'data');
    writeFileSync(blocker, 'a file where the data directory belongs');
    failedWithoutPath(await openStorage(ws.options({path: path.join(blocker, 'telemetry.sqlite')})), 'DATA_PATH_INVALID');
  });
  it('reports a second writer as retryable DATABASE_LOCKED while the first keeps its commits', async () => {
    const first = await ws.open();
    ok(first.upsertSession({message: v1('welcome')}));
    ok(first.commitEvent({message: v1('event-job-configured')}));
    expect(failedWithoutPath(await openStorage(ws.options()), 'DATABASE_LOCKED').retryable).toBe(true);
    expect(ok(first.committedThrough(P1))).toBe('1');
  });
  it('rejects malformed command shapes as INVALID_INPUT, never as an internal failure', async () => {
    const storage = await ws.open();
    ok(storage.upsertSession({message: v1('welcome')}));
    const malformed = (value: unknown) => value as never;
    const results: Result<unknown>[] = [
      storage.upsertSession(malformed(null)), storage.commitEvent(malformed(null)), storage.commitGap(malformed(undefined)),
      storage.appendSamples(P1, malformed(null)), storage.recordCompleteness(P1, malformed(null)), storage.getEvent(P1, malformed(5)),
      storage.listEvents(P1, malformed(null)), storage.listTrips(malformed(null)), storage.listSamples(malformed(null)), storage.listSamples({pluginSessionId: P1}, malformed('page'))
    ];
    for (const result of results) expect(failedWithoutPath(result, 'INVALID_INPUT').retryable).toBe(false);
  });
});
