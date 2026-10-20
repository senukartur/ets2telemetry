// REG-013 and REG-006 at the process boundary (ET-019 PR-2): a telemetry service process terminated while it opens an
// older database, during the pre-migration backup or inside the migration transaction, leaves the version 1 database
// unchanged, and the next open completes the migration with exactly one verified backup and no stale partial file.
//
// Each case runs crash-child.cjs `migrate` on a copy of the immutable version 1 fixture and ends it with TerminateProcess
// at a barrier the child reports, never after a delay. The expected states follow docs/storage.md ("Migrations",
// "Backups and restore") and SQLite's atomic commit: a transaction that never committed is rolled back when the database
// is next opened, and WAL frames without a commit record are ignored (https://www.sqlite.org/atomiccommit.html,
// https://www.sqlite.org/wal.html). The semantic version 2 rows are the hand-written expectations of migrations.test.ts.
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {digestOf, expectMigratedFromVersion1, files, readOnly, readVersion1, REPRESENTATIVE, sha256, STORAGE_FIXTURES, workspace} from './helpers';

const CHILD = path.resolve('tests/storage/fixtures/crash-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
// A child left blocked at its barrier by a failed case is terminated before its workspace is removed.
let running: ChildProcess | undefined;
afterEach(async () => {
  if (running && running.exitCode === null && running.signalCode === null) { const closed = once(running, 'close'); running.kill('SIGKILL'); await closed; }
  running = undefined;
  await ws.dispose();
});
// The committed fixture is only ever copied (tests/fixtures/storage/manifest.txt).
afterAll(() => {
  const listed = readFileSync(path.join(STORAGE_FIXTURES, 'manifest.txt'), 'utf8').split(/\r?\n/).find(line => line.endsWith(` ${REPRESENTATIVE}`));
  expect(sha256(path.join(STORAGE_FIXTURES, REPRESENTATIVE))).toBe(listed?.split(' ')[0]);
});

/** The child's clock is one hour before the workspace clock, the time of the reopen; backup names carry the clock. */
const CHILD_NOW = Date.UTC(2026, 9, 15, 11, 0, 0);
// Backup names written by hand from docs/storage.md: telemetry-<uuid8>-v<from version>-<UTC timestamp>.
const CHILD_BACKUP = 'telemetry-f0000000-v1-20261015T110000000Z';
const REOPEN_BACKUP = 'telemetry-f0000000-v1-20261015T120000000Z';
const pair = (stem: string) => [`${stem}.json`, `${stem}.sqlite`];
const UUID = 'f0000000-0000-4000-8000-000000000001';

type Barrier = 'afterInspect' | 'afterCopy' | 'afterBackupRename' | 'inside0002' | 'afterOpen';

/**
 * Runs the child on `copy` until it reports `barrier`, then terminates it there with TerminateProcess (SIGKILL): no exit
 * handler, SQLite close or checkpoint runs. LOCALAPPDATA points into the workspace. `spill` gives the migrating
 * connection a tiny page cache (inside0002 only). Returns the facts the child reported.
 */
async function killAtBarrier(barrier: Barrier, copy: string, spill = false): Promise<Record<string, unknown>> {
  const config = path.join(ws.directory, `migrate-${barrier}.json`);
  writeFileSync(config, JSON.stringify({open: {path: copy, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}, nowMs: CHILD_NOW, barrier, spill}));
  const child = spawn(process.execPath, [CHILD, 'migrate', config],
    {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: ws.directory}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  running = child;
  // 'close' comes after the process exited and its output ended, so a late error line is always read.
  const closed = once(child, 'close');
  let stdout = '', stderr = '', facts: Record<string, unknown> | undefined;
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    const end = stdout.indexOf('\n');
    if (end < 0 || facts) return;
    const line = stdout.slice(0, end).trim(), prefix = `barrier ${barrier} `;
    if (!line.startsWith(prefix)) { stderr += `unexpected child output: ${line}\n`; return; }
    facts = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    process.kill(child.pid!, 'SIGKILL');
  });
  const [code] = await closed as [number | null];
  expect(stderr).toBe('');
  expect(facts, `barrier ${barrier} reached`).toBeDefined();
  expect(code).not.toBe(0);
  // Only workspace paths were used: no history database under the LOCALAPPDATA the child received.
  expect(existsSync(path.join(ws.directory, 'ETS2Telemetry'))).toBe(false);
  return facts!;
}

/** Files of the backups directory, or null when it was never created. */
const backupFiles = () => existsSync(ws.backups) ? files(ws.backups) : null;
/** The version 1 state read through a separate read-only connection, before any production open. */
const version1State = (file: string) => readOnly(file, db => ({
  userVersion: Number(db.pragma('user_version', {simple: true})),
  versions: (db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all() as number[]),
  tripsOpenedBy: db.prepare("SELECT count(*) FROM pragma_table_info('trips') WHERE name = 'opened_by'").pluck().get(),
  integrity: db.pragma('integrity_check', {simple: true}),
  foreignKeys: db.pragma('foreign_key_check')
}));
const VERSION_1 = {userVersion: 1, versions: [1], tripsOpenedBy: 0, integrity: 'ok', foreignKeys: []};

describe('REG-013 killed open of a version 1 database', () => {
  it('terminated after the read-only inspection, before the writer opens: nothing changed, the next open migrates', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    expect(await killAtBarrier('afterInspect', copy)).toEqual({});
    expect(digestOf(copy)).toEqual(before.original);
    expect(backupFiles()).toBeNull();

    const storage = await ws.open({path: copy});
    expect(storage.summary).toEqual({schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic', migratedFrom: 1, backupFileName: `${REOPEN_BACKUP}.sqlite`});
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, `${REOPEN_BACKUP}.sqlite`));
    expect(backupFiles()).toEqual(pair(REOPEN_BACKUP));
  });

  it('terminated after the backup copy, before it is verified: the next open removes the partial copy and backs up again', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    expect(await killAtBarrier('afterCopy', copy)).toEqual({partial: `${CHILD_BACKUP}.sqlite.partial`});
    // The copy is one self-contained file in rollback-journal mode; the database itself is untouched.
    expect(backupFiles()).toEqual([`${CHILD_BACKUP}.sqlite.partial`]);
    expect(digestOf(copy)).toEqual(before.original);

    const storage = await ws.open({path: copy});
    expect(storage.summary).toEqual({schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic', migratedFrom: 1, backupFileName: `${REOPEN_BACKUP}.sqlite`,
      removedPartialBackups: 1});
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, `${REOPEN_BACKUP}.sqlite`));
    // Exactly one verified backup with its manifest; the stale partial copy is gone and was never trusted.
    expect(backupFiles()).toEqual(pair(REOPEN_BACKUP));
  });

  it('terminated after the backup rename, before its manifest is renamed: the next open removes the orphan backup and backs up again', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    expect(await killAtBarrier('afterBackupRename', copy)).toEqual({backup: `${CHILD_BACKUP}.sqlite`});
    // The backup was renamed to .sqlite, but its manifest was only .json.partial; the database itself is untouched.
    expect(backupFiles()).toEqual([`${CHILD_BACKUP}.json.partial`, `${CHILD_BACKUP}.sqlite`]);
    expect(digestOf(copy)).toEqual(before.original);

    const storage = await ws.open({path: copy});
    expect(storage.summary).toEqual({schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic', migratedFrom: 1, backupFileName: `${REOPEN_BACKUP}.sqlite`,
      removedPartialBackups: 2});
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, `${REOPEN_BACKUP}.sqlite`));
    // Exactly one verified backup with its manifest; the unmanifested backup and stale partial manifest are gone.
    expect(backupFiles()).toEqual(pair(REOPEN_BACKUP));
  });

  // With the production page cache the small fixture's transaction may stay in memory until COMMIT, so the kill leaves no
  // WAL frame. The spill variant makes SQLite write uncommitted 0002 pages to the WAL first: the next reader must ignore
  // frames that are neither a commit frame nor followed by one (https://www.sqlite.org/fileformat2.html#the_write_ahead_log,
  // 4.5 "Reader Algorithm").
  it.each([['the production page cache', false], ['uncommitted pages spilled into the WAL', true]])('terminated inside the 0002 transaction after its SQL ran, with %s: the database is still version 1, the next open reuses the backup', async (_cache, spill) => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    const facts = await killAtBarrier('inside0002', copy, spill);
    // Where the kill landed: the real 0002 statements ran on the migrating connection (trips has opened_by), and the step
    // was not yet recorded (still user_version 1 with only the version 1 row of schema_migrations).
    expect(facts).toMatchObject({userVersion: 1, versions: [1], tripsOpenedBy: 1});
    if (spill) {
      // Uncommitted frames are on disk, and the killed writer left them there.
      expect(facts.walBytes).toBeGreaterThan(0);
      expect(statSync(`${copy}-wal`).size).toBe(facts.walBytes);
    }
    // Read-only, before any production open: the uncommitted transaction is not visible, so the file is the unchanged
    // version 1 database with its version 1 schema.
    expect(version1State(copy)).toEqual(VERSION_1);
    expect(digestOf(copy)).toEqual(before.original);
    // The verified backup and its manifest were complete before the migration began.
    expect(backupFiles()).toEqual(pair(CHILD_BACKUP));

    const storage = await ws.open({path: copy});
    // A backup of exactly this content is reused (docs/storage.md, "Backups and restore", step 2).
    expect(storage.summary).toEqual({schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic', migratedFrom: 1, backupFileName: `${CHILD_BACKUP}.sqlite`});
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, `${CHILD_BACKUP}.sqlite`));
    expect(backupFiles()).toEqual(pair(CHILD_BACKUP));
  });

  it('terminated after the open returned, without a close: the committed migration survives and the next open does not migrate', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE), before = readVersion1(copy);
    const facts = await killAtBarrier('afterOpen', copy);
    expect(facts).toEqual({summary: {schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic', migratedFrom: 1, backupFileName: `${CHILD_BACKUP}.sqlite`}});
    // The committed migration is in the WAL the killed writer never checkpointed.
    expect(digestOf(copy).userVersion).toBe(3);
    expect(backupFiles()).toEqual(pair(CHILD_BACKUP));

    const storage = await ws.open({path: copy});
    expect(storage.summary).toEqual({schemaVersion: 3, created: false, databaseUuid: UUID, purpose: 'synthetic'});
    expectMigratedFromVersion1(storage, copy, before, path.join(ws.backups, `${CHILD_BACKUP}.sqlite`));
    expect(backupFiles()).toEqual(pair(CHILD_BACKUP));
  });
});
