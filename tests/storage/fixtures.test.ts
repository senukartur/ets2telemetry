import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {expectRepresentative, failed, files, ok, readOnly, REPRESENTATIVE, sha256, STORAGE_FIXTURES, v1, workspace} from './helpers';

const manifest = readFileSync(path.join(STORAGE_FIXTURES, 'manifest.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(' ') as [string, string]);
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });
// Every test in this suite reads fixtures only through temporary copies.
afterAll(() => { for (const [hash, name] of manifest) expect(sha256(path.join(STORAGE_FIXTURES, name)), name).toBe(hash); });

const schemaOf = (file: string) => readOnly(file, db => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all());

describe('REG-013 immutable storage fixtures', () => {
  it('lists every fixture file with its SHA-256 and nothing else', () => {
    expect(manifest.map(([, name]) => name).sort()).toEqual(files(STORAGE_FIXTURES).filter(name => name !== 'manifest.txt'));
    for (const [hash, name] of manifest) expect(sha256(path.join(STORAGE_FIXTURES, name)), name).toBe(hash);
  });
  it('keeps the frozen version 1 schema: migration 0001 still produces exactly the fixture schema', async () => {
    const storage = await ws.open(); storage.close();
    expect(schemaOf(ws.database)).toEqual(schemaOf(ws.copyFixture(REPRESENTATIVE)));
  });
  it('reads the representative version 1 content from a temporary copy', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    const storage = await ws.open({path: copy});
    expect(storage.summary).toMatchObject({schemaVersion: 1, created: false});
    expect(storage.summary.migratedFrom).toBeUndefined();
    expectRepresentative(storage, copy);
  });
  it('treats a redelivered copy of a stored event as a duplicate, so the stored payload encoding is stable', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    const storage = await ws.open({path: copy});
    // The stored session lists fewer event types than the shared welcome: a changed capability is a conflict.
    failed(storage.upsertSession({message: v1('welcome')}), 'SESSION_CONFLICT');
    expect(ok(storage.commitEvent({message: v1('money-uint64-max')}))).toEqual({status: 'duplicate', committedThroughEventSeq: '6'});
    expect(ok(storage.commitEvent({message: v1('event-job-configured')})).status).toBe('conflict');
  });
});
