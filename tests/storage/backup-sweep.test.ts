// A writer that is terminated during a pre-migration backup (for example by the service's bounded shutdown) leaves its
// `.partial` copy behind. The next writer open removes exactly those leftovers of its own database, and only after it
// holds the exclusive lock (PR #60 review).
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openStorage} from '../../packages/storage/src/index';
import {failed, files, ok, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const STAMP = '20261015T120000000Z';
/** An existing database and its stale partial backup set, next to files the sweep must never touch. */
async function seeded() {
  const storage = await ws.open();
  const uuid8 = storage.summary.databaseUuid.slice(0, 8);
  storage.close();
  mkdirSync(ws.backups, {recursive: true});
  const own = `telemetry-${uuid8}-v1-${STAMP}`;
  const stale = [`${own}.sqlite.partial`, `${own}.sqlite.partial-journal`, `${own}.sqlite.partial-wal`, `${own}.sqlite.partial-shm`, `${own}.json.partial`];
  const kept = [
    `telemetry-deadbeef-v1-${STAMP}.sqlite.partial`, // another database's leftover
    `${own}.sqlite`, // a finished backup name, even without its manifest
    `${own}.json`,
    `telemetry-${uuid8}-v1-${STAMP}.sqlite.partial.bak`,
    `telemetry-${uuid8}-v1-latest.sqlite.partial`,
    'notes.txt'
  ];
  for (const name of [...stale, ...kept]) writeFileSync(path.join(ws.backups, name), `fixture:${name}`);
  // A directory that happens to use the partial name is not a file of ours.
  const directoryName = `telemetry-${uuid8}-v2-${STAMP}.sqlite.partial`;
  mkdirSync(path.join(ws.backups, directoryName));
  const hashes = Object.fromEntries(kept.map(name => [name, sha256(path.join(ws.backups, name))]));
  return {stale, kept, directoryName, hashes};
}

describe('stale partial backups', () => {
  it('removes only this database\'s partial backup files at the next writer open and reports how many', async () => {
    const {kept, directoryName, hashes} = await seeded();
    const storage = await ws.open();
    expect(storage.summary.removedPartialBackups).toBe(5);
    storage.close();
    expect(files(ws.backups)).toEqual([...kept, directoryName].sort());
    for (const name of kept) expect(sha256(path.join(ws.backups, name)), name).toBe(hashes[name]);
    expect(readdirSync(path.join(ws.backups, directoryName))).toEqual([]);
    // Nothing left to remove: the count is omitted.
    const again = await ws.open();
    expect(again.summary.removedPartialBackups).toBeUndefined();
  });
  it('never touches the backups while another writer holds the database', async () => {
    const {stale} = await seeded();
    const holder = await ws.open();
    expect(holder.summary.removedPartialBackups).toBe(5);
    writeFileSync(path.join(ws.backups, stale[0]), 'fixture:new partial of the running writer');
    failed(await openStorage(ws.options()), 'DATABASE_LOCKED');
    expect(existsSync(path.join(ws.backups, stale[0]))).toBe(true);
    holder.close();
  });
  it('leaves a new database without a sweep and tolerates a missing backups directory', async () => {
    const storage = ok(await openStorage(ws.options()));
    expect(storage.summary.removedPartialBackups).toBeUndefined();
    storage.close();
    const reopened = await ws.open();
    expect(reopened.summary.removedPartialBackups).toBeUndefined();
    expect(existsSync(ws.backups)).toBe(false);
  });
});
