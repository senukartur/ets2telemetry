// Verified backups through SQLite's online backup API, never a file copy: the copy is made by the writer connection
// under its exclusive lock, so it is a consistent snapshot even with an active WAL. See docs/storage.md, "Backups".
import {createHash} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {Purpose} from '../api';
import {classifyError, fail, StorageFailure} from '../errors';
import {backupsToDelete, type BackupEntry} from '../retention';
import {contentDigest, type ContentDigest} from './digest';
import {APPLICATION_ID, checkIntegrity} from './migrations';

export interface BackupHooks {
  /** Free bytes reported for the backup directory, replacing statfs. */
  freeBytes?: (directory: string) => number;
  /** Runs after the copy is written and before it is verified, to prove that a damaged copy is refused. */
  afterCopy?: (partialPath: string) => void;
  /** Runs after the verified backup copy is renamed to .sqlite and before its manifest is renamed. */
  afterBackupRename?: (backupPath: string) => void;
}
/** Written last, after the verified backup file is in place; a backup without it is never trusted or deleted. */
export interface BackupManifest {
  format: 'ets2telemetry-backup-1'; databaseUuid: string; fromVersion: number; fileName: string; fileSha256: string; size: number;
  rowCounts: Record<string, number>; logicalDigest: string; createdUtcMs: number; appVersion: string; reason: 'pre-migration';
}
const FREE_SPACE_FACTOR = 1.1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function fileSha256(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1 << 20), fd = openSync(file, 'r');
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest('hex');
}
function fsyncFile(file: string) { const fd = openSync(file, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
const sizeOf = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
function removeQuietly(...files: string[]) { for (const file of files) { try { rmSync(file, {force: true}); } catch { /* best effort */ } } }

function isForeignManifest(manifestPath: string, databaseUuid: string): boolean {
  const manifest = readManifest(manifestPath);
  if (manifest) return manifest.databaseUuid !== databaseUuid;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {databaseUuid?: unknown};
    return typeof raw.databaseUuid === 'string' && raw.databaseUuid !== databaseUuid;
  } catch { return false; }
}

/**
 * Removes partial backup files and unmanifested orphan backups or manifests a writer left behind when it was
 * terminated during a pre-migration backup of this database: `telemetry-<uuid8>-v<n>-<timestamp>.sqlite.partial`
 * with its `-journal`, `-wal` and `-shm` files, `telemetry-<uuid8>-v<n>-<timestamp>.json.partial`, unmanifested orphan
 * `.sqlite` backup files (with lingering sidecars) left when terminated between renames, and orphan `.json` manifests
 * lacking a matching `.sqlite` backup. Call it only while holding the database's exclusive lock, so no other writer can
 * own them. Existing backup pairs (where both `.sqlite` and `.json` exist), files belonging to other database UUIDs and
 * anything else are never touched. Best effort: a missing directory or a failed removal is skipped and retried at the
 * next open. Returns the number of files removed.
 */
export function sweepStalePartials(directory: string, databaseUuid: string): number {
  const uuid8 = databaseUuid.slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(uuid8)) return 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  let removed = 0;

  const partialPattern = new RegExp(String.raw`^telemetry-${uuid8}-v[0-9]+-[0-9]{8}T[0-9]{9}Z\.(sqlite\.partial(-journal|-wal|-shm)?|json\.partial)$`);
  for (const name of names.filter(entry => partialPattern.test(entry))) {
    const file = path.join(directory, name);
    try { if (!lstatSync(file).isFile()) continue; rmSync(file); removed++; } catch { /* best effort */ }
  }

  const candidatePattern = new RegExp(String.raw`^(telemetry-${uuid8}-v[0-9]+-[0-9]{8}T[0-9]{9}Z)\.(sqlite(-journal|-wal|-shm)?|json)$`);
  const stems = new Set<string>();
  for (const name of names) {
    const match = name.match(candidatePattern);
    if (match) stems.add(match[1]);
  }

  for (const stem of stems) {
    const sqlitePath = path.join(directory, `${stem}.sqlite`);
    const manifestPath = path.join(directory, `${stem}.json`);
    const sqliteExists = existsSync(sqlitePath) && (() => { try { return lstatSync(sqlitePath).isFile(); } catch { return false; } })();
    const manifestExists = existsSync(manifestPath) && (() => { try { return lstatSync(manifestPath).isFile(); } catch { return false; } })();

    if (sqliteExists && manifestExists) {
      // Both files exist: a completed backup pair, never a rename-window orphan. Always preserve.
      continue;
    } else if (sqliteExists && !manifestExists) {
      // Unmanifested orphan backup left by a crash during rename: remove .sqlite and any sidecars.
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const sidecar = path.join(directory, `${stem}.sqlite${suffix}`);
        try { if (existsSync(sidecar) && lstatSync(sidecar).isFile()) { rmSync(sidecar); removed++; } } catch { /* best effort */ }
      }
    } else if (!sqliteExists && manifestExists) {
      // Manifest lacking a matching backup file: remove if it does not belong to another database.
      if (!isForeignManifest(manifestPath, databaseUuid)) {
        try { rmSync(manifestPath); removed++; } catch { /* best effort */ }
      }
    } else {
      // Lingering sidecars without base files.
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const sidecar = path.join(directory, `${stem}.sqlite${suffix}`);
        try { if (existsSync(sidecar) && lstatSync(sidecar).isFile()) { rmSync(sidecar); removed++; } } catch { /* best effort */ }
      }
    }
  }

  return removed;
}

/**
 * Verifies a database file read-only against an expected digest: integrity_check, foreign keys, header versions,
 * database UUID, per-table row counts and the logical digest. The file must be in rollback-journal mode, so the
 * read-only connection creates no sidecar files.
 */
export function verifyCopy(file: string, expected: Pick<ContentDigest, 'rowCounts' | 'logicalDigest'> & {userVersion: number}, databaseUuid: string, purpose?: Purpose): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true});
    checkIntegrity(db, 'integrity_check');
    const actual = contentDigest(db);
    const uuid = db.prepare('SELECT database_uuid FROM database_info WHERE id = 1').pluck().get();
    if (actual.applicationId !== APPLICATION_ID || actual.userVersion !== expected.userVersion || uuid !== databaseUuid ||
      actual.logicalDigest !== expected.logicalDigest || JSON.stringify(actual.rowCounts) !== JSON.stringify(expected.rowCounts)) throw new Error('Backup content differs');
    if (purpose !== undefined && db.prepare('SELECT purpose FROM database_info WHERE id = 1').pluck().get() !== purpose) fail('PURPOSE_MISMATCH');
  } finally { db?.close(); }
}

/** Copies `source` into a new file and converts the copy to rollback-journal mode, so it is one self-contained file. */
async function copyDatabase(source: Database.Database, target: string): Promise<void> {
  await source.backup(target);
  // The copy keeps the source's WAL flag; switching it to DELETE mode lets read-only checks run without -wal/-shm files.
  const copy = new Database(target, {fileMustExist: true});
  try { if (copy.pragma('journal_mode = DELETE', {simple: true}) !== 'delete') throw new Error('Backup journal mode not converted'); } finally { copy.close(); }
}

/**
 * Takes the pre-migration backup: reuses an intact backup of exactly this content when one exists (a migration that
 * failed earlier), otherwise checks free space, copies through the backup API, verifies the copy against the source
 * digest, syncs and renames it, then writes the manifest last. Any failure removes the partial copy and is
 * BACKUP_FAILED; the caller then migrates nothing.
 */
export async function backupBeforeMigration(db: Database.Database, context: {file: string; backupsDirectory: string; databaseUuid: string; fromVersion: number; now: () => number; appVersion: string; hooks?: BackupHooks}): Promise<{fileName: string; sha256: string}> {
  const {backupsDirectory: directory} = context;
  const createdUtcMs = context.now();
  const fileName = `telemetry-${context.databaseUuid.slice(0, 8)}-v${context.fromVersion}-${new Date(createdUtcMs).toISOString().replace(/[-:.]/g, '')}.sqlite`;
  const finalPath = path.join(directory, fileName), partial = `${finalPath}.partial`, manifestPath = finalPath.replace(/\.sqlite$/, '.json');
  try { mkdirSync(directory, {recursive: true}); if (!statSync(directory).isDirectory()) throw new Error('not a directory'); } catch (error) {
    fail('BACKUP_FAILED', {cause: classifyError(error, 'DATA_PATH_INVALID').code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'DATA_PATH_INVALID'});
  }
  const source = contentDigest(db);
  // A migration that fails the same way on every open must not leave a new full-size copy each time.
  const existing = reusableBackup(directory, context.databaseUuid, context.fromVersion, source);
  if (existing) return existing;
  const needed = (sizeOf(context.file) + sizeOf(`${context.file}-wal`)) * FREE_SPACE_FACTOR;
  let free: number;
  try { free = context.hooks?.freeBytes ? context.hooks.freeBytes(directory) : (({bavail, bsize}) => Number(bavail) * Number(bsize))(statfsSync(directory)); } catch (error) { fail('BACKUP_FAILED', {cause: classifyError(error).code}); }
  if (free < needed) fail('BACKUP_FAILED', {cause: 'DISK_FULL'});
  if ([finalPath, partial, manifestPath].some(existsSync)) fail('BACKUP_FAILED', {cause: 'DATA_PATH_INVALID'});
  try {
    await copyDatabase(db, partial);
    context.hooks?.afterCopy?.(partial);
    verifyCopy(partial, source, context.databaseUuid);
    fsyncFile(partial);
    const sha256 = fileSha256(partial), size = statSync(partial).size;
    const manifest: BackupManifest = {format: 'ets2telemetry-backup-1', databaseUuid: context.databaseUuid, fromVersion: context.fromVersion, fileName, fileSha256: sha256, size,
      rowCounts: source.rowCounts, logicalDigest: source.logicalDigest, createdUtcMs, appVersion: context.appVersion, reason: 'pre-migration'};
    writeFileSync(`${manifestPath}.partial`, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    fsyncFile(`${manifestPath}.partial`);
    renameSync(partial, finalPath);
    context.hooks?.afterBackupRename?.(finalPath);
    renameSync(`${manifestPath}.partial`, manifestPath);
    return {fileName, sha256};
  } catch (error) {
    removeQuietly(partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`, `${manifestPath}.partial`);
    if (!existsSync(manifestPath)) removeQuietly(finalPath);
    const classified = classifyError(error, 'DATABASE_CORRUPT');
    fail('BACKUP_FAILED', {cause: classified.code, ...(classified.sqliteCode ? {sqliteCode: classified.sqliteCode} : {})});
  }
}

/**
 * An existing pre-migration backup of exactly this content: same database, source version, logical digest and row
 * counts, with a backup file whose size and SHA-256 still match its manifest. A damaged or partial backup is never reused.
 */
function reusableBackup(directory: string, databaseUuid: string, fromVersion: number, source: ContentDigest): {fileName: string; sha256: string} | undefined {
  for (const name of readdirSync(directory).filter(entry => entry.endsWith('.json')).sort()) {
    const manifest = readManifest(path.join(directory, name)), backup = manifest && path.join(directory, manifest.fileName);
    if (!manifest || !backup || manifest.databaseUuid !== databaseUuid || manifest.fromVersion !== fromVersion || manifest.logicalDigest !== source.logicalDigest ||
      JSON.stringify(manifest.rowCounts) !== JSON.stringify(source.rowCounts) || sizeOf(backup) !== manifest.size) continue;
    try { if (fileSha256(backup) === manifest.fileSha256) return {fileName: manifest.fileName, sha256: manifest.fileSha256}; } catch { /* unreadable: not reusable */ }
  }
  return undefined;
}

/** Parses a manifest strictly; anything else is not a backup of this application. */
export function readManifest(manifestPath: string): BackupManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BackupManifest>;
    const valid = m.format === 'ets2telemetry-backup-1' && m.reason === 'pre-migration' && typeof m.databaseUuid === 'string' && UUID.test(m.databaseUuid) &&
      typeof m.fileName === 'string' && m.fileName === `${path.basename(manifestPath, '.json')}.sqlite` && /^[0-9a-f]{64}$/.test(String(m.fileSha256)) &&
      Number.isSafeInteger(m.size) && Number.isSafeInteger(m.fromVersion) && Number.isSafeInteger(m.createdUtcMs) && /^[0-9a-f]{64}$/.test(String(m.logicalDigest)) &&
      typeof m.rowCounts === 'object' && m.rowCounts !== null && typeof m.appVersion === 'string';
    return valid ? m as BackupManifest : undefined;
  } catch { return undefined; }
}

/**
 * Keeps the newest verified pre-migration backups of one database after the new backup's migration committed. Only
 * files described by a valid manifest whose backup file has the recorded size are considered; others are left alone.
 * Failures are ignored: pruning never fails an open.
 */
export function pruneBackups(directory: string, databaseUuid: string, latestFileName: string): void {
  try {
    const entries: BackupEntry[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const manifest = readManifest(path.join(directory, name));
      if (!manifest) continue;
      entries.push({fileName: manifest.fileName, databaseUuid: manifest.databaseUuid, createdUtcMs: manifest.createdUtcMs, verified: sizeOf(path.join(directory, manifest.fileName)) === manifest.size && manifest.size > 0});
    }
    for (const fileName of backupsToDelete(entries, databaseUuid, {fileName: latestFileName, verified: true, migrationCommitted: true})) {
      // The backup first, the manifest last: an interrupted deletion never leaves a backup without its manifest.
      rmSync(path.join(directory, fileName), {force: true});
      rmSync(path.join(directory, fileName.replace(/\.sqlite$/, '.json')), {force: true});
    }
  } catch { /* retention is best effort */ }
}

/**
 * Restores a verified backup into a new file: checks the manifest, the file hash, integrity and that the backup holds
 * data of the requested purpose, and only then creates the target directory, copies the backup through the backup API
 * into `<target>.partial`, verifies the copy and renames it. The caller checks the target path first. The target and its
 * sidecars must not exist; in-place replacement of a live database is deferred to ET-018. The caller then opens the
 * target normally.
 */
export async function restoreCopy(manifestPath: string, target: string, purpose: Purpose): Promise<void> {
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(target)) fail('DATA_PATH_INVALID');
  if (['', '-wal', '-shm', '-journal', '.partial'].some(suffix => existsSync(target + suffix))) fail('DATA_PATH_INVALID');
  const manifest = readManifest(manifestPath);
  if (!manifest) fail('BACKUP_FAILED', {cause: 'DATABASE_UNRECOGNIZED'});
  const backupPath = path.join(path.dirname(manifestPath), manifest.fileName), partial = `${target}.partial`;
  try {
    if (statSync(backupPath).size !== manifest.size || fileSha256(backupPath) !== manifest.fileSha256) throw new Error('Backup file hash differs');
    verifyCopy(backupPath, {...manifest, userVersion: manifest.fromVersion}, manifest.databaseUuid, purpose);
  } catch (error) {
    const classified = classifyError(error, 'DATABASE_CORRUPT');
    if (classified.code === 'PURPOSE_MISMATCH') throw new StorageFailure(classified);
    fail('BACKUP_FAILED', {cause: classified.code});
  }
  try { mkdirSync(path.dirname(target), {recursive: true}); } catch { fail('DATA_PATH_INVALID'); }
  let source: Database.Database | undefined;
  try {
    source = new Database(backupPath, {readonly: true, fileMustExist: true});
    await copyDatabase(source, partial);
    verifyCopy(partial, {...manifest, userVersion: manifest.fromVersion}, manifest.databaseUuid);
    fsyncFile(partial);
    renameSync(partial, target);
  } catch (error) {
    removeQuietly(partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`);
    fail('BACKUP_FAILED', {cause: classifyError(error, 'DATABASE_CORRUPT').code});
  } finally { source?.close(); }
}
