// A writer that is terminated during a pre-migration backup (for example by the service's bounded shutdown) leaves its
// `.partial` copy behind, or leaves an orphan backup/manifest when killed between renames. The next writer open removes
// exactly those leftovers of its own database, and only after it holds the exclusive lock (PR #60 review, ET-039).
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openStorage} from '../../packages/storage/src/index';
import {sweepStalePartials} from '../../packages/storage/src/sqlite/backup';
import {failed, files, ok, sha256, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const STAMP = '20261015T120000000Z';
/** An existing database and its stale partial backup set, next to files the sweep must never touch. */
async function seeded() {
  const storage = await ws.open();
  const uuid = storage.summary.databaseUuid;
  const uuid8 = uuid.slice(0, 8);
  storage.close();
  mkdirSync(ws.backups, {recursive: true});

  // 1. Valid backup pair of this database: strictly preserved
  const validPair = `telemetry-${uuid8}-v1-${STAMP}`;
  writeFileSync(path.join(ws.backups, `${validPair}.sqlite`), 'fixture:database-copy');
  const validManifest = {
    format: 'ets2telemetry-backup-1', databaseUuid: uuid, fromVersion: 1,
    fileName: `${validPair}.sqlite`, fileSha256: sha256(path.join(ws.backups, `${validPair}.sqlite`)),
    size: 21, rowCounts: {}, logicalDigest: '0'.repeat(64),
    createdUtcMs: Date.parse('2026-10-15T12:00:00.000Z'), appVersion: '0.1.0', reason: 'pre-migration'
  };
  writeFileSync(path.join(ws.backups, `${validPair}.json`), JSON.stringify(validManifest, null, 2) + '\n');

  // 2. Valid backup pair of another database (even with same uuid8 prefix): strictly preserved
  const foreignUuid = `${uuid8}-ffff-4000-8000-000000000000`;
  const foreignPair = `telemetry-${uuid8}-v1-20261015T113000000Z`;
  writeFileSync(path.join(ws.backups, `${foreignPair}.sqlite`), 'fixture:foreign-copy');
  const foreignManifest = {
    format: 'ets2telemetry-backup-1', databaseUuid: foreignUuid, fromVersion: 1,
    fileName: `${foreignPair}.sqlite`, fileSha256: sha256(path.join(ws.backups, `${foreignPair}.sqlite`)),
    size: 20, rowCounts: {}, logicalDigest: '0'.repeat(64),
    createdUtcMs: Date.parse('2026-10-15T11:30:00.000Z'), appVersion: '0.1.0', reason: 'pre-migration'
  };
  writeFileSync(path.join(ws.backups, `${foreignPair}.json`), JSON.stringify(foreignManifest, null, 2) + '\n');

  // 3. Backup pair where the manifest is unrecognized/corrupt: both files exist, never an unmanifested rename orphan, strictly preserved
  const unrecogStem = `telemetry-${uuid8}-v1-20261015T080000000Z`;
  const unrecogSqlite = `${unrecogStem}.sqlite`;
  const unrecogJson = `${unrecogStem}.json`;
  writeFileSync(path.join(ws.backups, unrecogSqlite), 'fixture:existing-backup');
  writeFileSync(path.join(ws.backups, unrecogJson), 'not-valid-manifest-json');

  // 4. Stale partial files of this database: swept
  const own = `telemetry-${uuid8}-v1-20261015T110000000Z`;
  const stale = [
    `${own}.sqlite.partial`, `${own}.sqlite.partial-journal`, `${own}.sqlite.partial-wal`, `${own}.sqlite.partial-shm`,
    `${own}.json.partial`
  ];

  // 5. Unmanifested orphan backup and sidecar of this database (no manifest file at all): swept
  const orphanBackup = `telemetry-${uuid8}-v1-20261015T100000000Z.sqlite`;
  const orphanJournal = `telemetry-${uuid8}-v1-20261015T100000000Z.sqlite-journal`;
  for (const name of [...stale, orphanBackup, orphanJournal]) writeFileSync(path.join(ws.backups, name), `fixture:${name}`);

  // 6. Orphan manifest of this database (no matching .sqlite file): swept
  const orphanManifest = `telemetry-${uuid8}-v1-20261015T090000000Z.json`;
  const orphanManifestContent = {
    format: 'ets2telemetry-backup-1', databaseUuid: uuid, fromVersion: 1,
    fileName: `telemetry-${uuid8}-v1-20261015T090000000Z.sqlite`, fileSha256: 'a'.repeat(64),
    size: 100, rowCounts: {}, logicalDigest: '0'.repeat(64),
    createdUtcMs: Date.parse('2026-10-15T09:00:00.000Z'), appVersion: '0.1.0', reason: 'pre-migration'
  };
  writeFileSync(path.join(ws.backups, orphanManifest), JSON.stringify(orphanManifestContent, null, 2) + '\n');

  // 7. Orphan manifest of a foreign database (same uuid8 prefix, but foreign databaseUuid): preserved
  const foreignOrphanManifest = `telemetry-${uuid8}-v1-20261015T070000000Z.json`;
  const foreignOrphanContent = {
    format: 'ets2telemetry-backup-1', databaseUuid: foreignUuid, fromVersion: 1,
    fileName: `telemetry-${uuid8}-v1-20261015T070000000Z.sqlite`, fileSha256: 'b'.repeat(64),
    size: 100, rowCounts: {}, logicalDigest: '0'.repeat(64),
    createdUtcMs: Date.parse('2026-10-15T07:00:00.000Z'), appVersion: '0.1.0', reason: 'pre-migration'
  };
  writeFileSync(path.join(ws.backups, foreignOrphanManifest), JSON.stringify(foreignOrphanContent, null, 2) + '\n');

  const swept = [...stale, orphanBackup, orphanJournal, orphanManifest];

  // 8. Files the sweep must never touch
  const kept = [
    `telemetry-deadbeef-v1-${STAMP}.sqlite.partial`, // another database's leftover
    `telemetry-deadbeef-v1-${STAMP}.sqlite`, // another database's finished backup
    `${validPair}.sqlite`,
    `${validPair}.json`,
    `${foreignPair}.sqlite`,
    `${foreignPair}.json`,
    unrecogSqlite,
    unrecogJson,
    foreignOrphanManifest,
    `telemetry-${uuid8}-v1-${STAMP}.sqlite.partial.bak`,
    `telemetry-${uuid8}-v1-latest.sqlite.partial`,
    'notes.txt'
  ];
  for (const name of [`telemetry-deadbeef-v1-${STAMP}.sqlite.partial`, `telemetry-deadbeef-v1-${STAMP}.sqlite`, `telemetry-${uuid8}-v1-${STAMP}.sqlite.partial.bak`, `telemetry-${uuid8}-v1-latest.sqlite.partial`, 'notes.txt']) {
    writeFileSync(path.join(ws.backups, name), `fixture:${name}`);
  }

  // A directory that happens to use the partial name is not a file of ours.
  const directoryName = `telemetry-${uuid8}-v2-${STAMP}.sqlite.partial`;
  mkdirSync(path.join(ws.backups, directoryName));
  const hashes = Object.fromEntries(kept.map(name => [name, sha256(path.join(ws.backups, name))]));
  return {swept, kept, directoryName, hashes};
}

describe('stale partial backups', () => {
  it('removes only this database\'s partial backup files, orphan backups and orphan manifests at the next writer open and reports how many', async () => {
    const {swept, kept, directoryName, hashes} = await seeded();
    const storage = await ws.open();
    expect(storage.summary.removedPartialBackups).toBe(swept.length);
    storage.close();
    expect(files(ws.backups)).toEqual([...kept, directoryName].sort());
    for (const name of kept) expect(sha256(path.join(ws.backups, name)), name).toBe(hashes[name]);
    expect(readdirSync(path.join(ws.backups, directoryName))).toEqual([]);
    // Nothing left to remove: the count is omitted.
    const again = await ws.open();
    expect(again.summary.removedPartialBackups).toBeUndefined();
  });
  it('never touches the backups while another writer holds the database', async () => {
    const {swept} = await seeded();
    const holder = await ws.open();
    expect(holder.summary.removedPartialBackups).toBe(swept.length);
    writeFileSync(path.join(ws.backups, swept[0]), 'fixture:new partial of the running writer');
    failed(await openStorage(ws.options()), 'DATABASE_LOCKED');
    expect(existsSync(path.join(ws.backups, swept[0]))).toBe(true);
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
  it('sweepStalePartials handles invalid uuid or missing directory directly', () => {
    expect(sweepStalePartials(ws.backups, 'invalid')).toBe(0);
    expect(sweepStalePartials(path.join(ws.directory, 'nonexistent'), 'f0000000-0000-4000-8000-000000000001')).toBe(0);
  });
});
