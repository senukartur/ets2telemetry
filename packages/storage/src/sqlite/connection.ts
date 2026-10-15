// Opens the one writer connection of a database file. Every open, including reopen, post-migration and post-restore,
// runs the same sequence: validate the path, inspect an existing file read-only, then open read-write and set and read
// back the durability settings before any write (docs/storage.md, "Durability"). A mismatch closes the connection.
import {randomUUID} from 'node:crypto';
import {accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {ACCEPTED_ORIGIN, type Durability, type OpenSummary, type Purpose} from '../api';
import {classifyError, fail, StorageFailure} from '../errors';
import {backupBeforeMigration, pruneBackups, type BackupHooks} from './backup';
import {applySteps, APPLICATION_ID, checkIntegrity, MIGRATIONS, supportedVersion, type Migration} from './migrations';

export const BUSY_TIMEOUT_MS = 2_000;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
/** The production history file. Synthetic and replay databases may never use it. */
const PRODUCTION_HISTORY = /[\\/]ETS2Telemetry[\\/]data[\\/]telemetry\.sqlite$/i;

export interface OpenOptions {
  /** Absolute path of the database file; its directory is created when missing. */
  path: string; purpose: Purpose;
  /** Directory of pre-migration backups for this database; created only when a backup is taken. */
  backupsDirectory: string; appVersion: string;
  now?: () => number;
  /** In-process tests only; production always uses MIGRATIONS. */
  migrations?: readonly Migration[];
  testHooks?: OpenTestHooks;
}
export interface OpenTestHooks extends BackupHooks {
  /** Replaces a durability read-back value before it is compared, to prove that a mismatch is refused. */
  readBack?: (pragma: 'locking_mode' | 'journal_mode' | 'synchronous' | 'foreign_keys', value: unknown) => unknown;
  /** Runs after the read-only inspection and before the writer takes its lock, to simulate a concurrent change. */
  afterInspect?: (file: string) => void;
}

const DURABILITY: Durability = Object.freeze({journalMode: 'wal', synchronous: 'full', lockingMode: 'exclusive', foreignKeys: true});

/** The verified writer connection. Writes go through `writer()`, which refuses a closed or unverified connection. */
export class StorageConnection {
  #db: Database.Database | undefined;
  constructor(db: Database.Database, readonly durability: Durability | undefined, readonly summary: OpenSummary, readonly now: () => number) { this.#db = db; }
  get closed(): boolean { return this.#db === undefined; }
  writer(): Database.Database {
    if (!this.#db) fail('STORAGE_CLOSED');
    if (this.durability !== DURABILITY) fail('DURABILITY_UNVERIFIED');
    return this.#db;
  }
  reader(): Database.Database { if (!this.#db) fail('STORAGE_CLOSED'); return this.#db; }
  /** Closes the connection; SQLite checkpoints the WAL into the main file and removes it. */
  close(): void { const db = this.#db; this.#db = undefined; db?.close(); }
}

/** Checks a database path for a purpose without touching the filesystem. */
export function checkPath(file: string, purpose: Purpose): void {
  if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file) || path.resolve(file) !== path.normalize(file) || file.startsWith('file:')) fail('DATA_PATH_INVALID');
  if (purpose !== 'history' && PRODUCTION_HISTORY.test(path.normalize(file))) fail('DATA_PATH_INVALID');
}
function validatePath(file: string, purpose: Purpose): void {
  checkPath(file, purpose);
  try { mkdirSync(path.dirname(file), {recursive: true}); } catch (error) { fail(classifyError(error, 'DATA_PATH_INVALID').code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'DATA_PATH_INVALID'); }
  if (!statSync(path.dirname(file)).isDirectory()) fail('DATA_PATH_INVALID');
}

interface Inspection {fresh: boolean; version: number}
const SIDECARS = ['-wal', '-journal', '-shm'];

function readHeader(file: string): Buffer {
  const header = Buffer.alloc(100), fd = openSync(file, 'r');
  try { return header.subarray(0, readSync(fd, header, 0, 100, 0)); } finally { closeSync(fd); }
}

/**
 * Classifies an existing file without writing to it. Without sidecar files the header bytes are authoritative, so a
 * foreign or newer file is refused without opening SQLite at all. Otherwise a read-only connection reads it; SQLite may
 * then create a `-shm` (and an empty `-wal`) beside a WAL file, which are removed afterwards when this check created them.
 */
function inspect(file: string, purpose: Purpose, supported: number): Inspection {
  let size: number;
  try { const stat = statSync(file); if (!stat.isFile()) fail('DATA_PATH_INVALID'); size = stat.size; } catch (error) {
    if (error instanceof StorageFailure) throw error;
    if ((error as {code?: string}).code === 'ENOENT') return {fresh: true, version: 0};
    throw new StorageFailure(classifyError(error));
  }
  const present = SIDECARS.filter(suffix => existsSync(file + suffix));
  if (size === 0 && !present.length) return {fresh: true, version: 0};
  if (!present.some(suffix => suffix !== '-shm')) {
    const header = readHeader(file);
    if (header.length < 100 || !header.subarray(0, 16).equals(SQLITE_MAGIC)) fail('DATABASE_UNRECOGNIZED');
    const applicationId = header.readInt32BE(68), userVersion = header.readUInt32BE(60);
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) fail('DATABASE_UNRECOGNIZED');
    if (applicationId === APPLICATION_ID && userVersion > supported) fail('SCHEMA_NEWER');
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(file, {readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS});
    const applicationId = Number(db.pragma('application_id', {simple: true})), userVersion = Number(db.pragma('user_version', {simple: true}));
    const tables = Number(db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").pluck().get());
    // New means an empty SQLite file: no application id, no user tables and no user version, as the locked re-check requires.
    if (applicationId !== APPLICATION_ID) { if (applicationId === 0 && tables === 0 && userVersion === 0) return {fresh: true, version: 0}; fail('DATABASE_UNRECOGNIZED'); }
    if (userVersion === 0) fail('DATABASE_UNRECOGNIZED');
    if (userVersion > supported) fail('SCHEMA_NEWER');
    const stored = db.prepare("SELECT purpose FROM database_info WHERE id = 1").pluck().get();
    if (stored === undefined) fail('DATABASE_UNRECOGNIZED');
    if (stored !== purpose) fail('PURPOSE_MISMATCH');
    return {fresh: false, version: userVersion};
  } catch (error) {
    const classified = classifyError(error);
    if (classified.sqliteCode?.startsWith('SQLITE_NOTADB') || classified.sqliteCode === 'SQLITE_ERROR') fail('DATABASE_UNRECOGNIZED', {sqliteCode: classified.sqliteCode});
    throw new StorageFailure(classified);
  } finally {
    db?.close();
    // Only transient files this read-only check created; the database and an existing WAL are never touched.
    for (const suffix of ['-shm', '-wal']) {
      if (present.includes(suffix)) continue;
      try { if (suffix === '-shm' || statSync(file + suffix).size === 0) rmSync(file + suffix, {force: true}); } catch { /* absent */ }
    }
  }
}

/**
 * Repeats the inspection's classification on the locked writer connection, before any write. Another process could
 * have changed the file between the read-only inspection and the lock; the locked values are authoritative.
 */
function recheck(db: Database.Database, inspection: Inspection, supported: number): void {
  const applicationId = Number(db.pragma('application_id', {simple: true})), userVersion = Number(db.pragma('user_version', {simple: true}));
  const tables = Number(db.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").pluck().get());
  if (applicationId === APPLICATION_ID && userVersion > supported) fail('SCHEMA_NEWER');
  if (inspection.fresh ? applicationId !== 0 || userVersion !== 0 || tables !== 0 : applicationId !== APPLICATION_ID || userVersion !== inspection.version) fail('DATABASE_UNRECOGNIZED');
}

/** Sets and reads back every durability setting on a new read-write connection; any mismatch is refused. */
function openWriter(file: string, hooks: OpenTestHooks | undefined, check: (db: Database.Database) => void): Database.Database {
  // SQLite silently falls back to a read-only handle for a read-only file and fails only at the first lock or write,
  // with a misleading I/O code. Checking write access first reports the actual cause.
  try { accessSync(file, constants.W_OK); } catch (error) { if ((error as {code?: string}).code !== 'ENOENT') fail('PERMISSION_DENIED'); }
  let db: Database.Database;
  try { db = new Database(file, {timeout: BUSY_TIMEOUT_MS}); } catch (error) { throw new StorageFailure(classifyError(error)); }
  try {
    if (db.readonly) fail('PERMISSION_DENIED');
    const read = (name: Parameters<NonNullable<OpenTestHooks['readBack']>>[0], value: unknown) => hooks?.readBack ? hooks.readBack(name, value) : value;
    // Exclusive locking before the first WAL access: one writer, and no shared-memory (-shm) index at all.
    if (read('locking_mode', db.pragma('locking_mode = EXCLUSIVE', {simple: true})) !== 'exclusive') fail('DURABILITY_UNVERIFIED');
    // In exclusive mode this first read takes the file lock and keeps it, so the values cannot change again.
    check(db);
    if (read('journal_mode', db.pragma('journal_mode = WAL', {simple: true})) !== 'wal') fail('DURABILITY_UNVERIFIED');
    // Set after WAL on purpose: better-sqlite3 13.0.3 compiles SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 (NORMAL), which can
    // lose the last commits on power loss. FULL (2) syncs the WAL on every commit.
    db.pragma('synchronous = FULL');
    if (Number(read('synchronous', db.pragma('synchronous', {simple: true}))) !== 2) fail('DURABILITY_UNVERIFIED');
    db.pragma('foreign_keys = ON');
    if (Number(read('foreign_keys', db.pragma('foreign_keys', {simple: true}))) !== 1) fail('DURABILITY_UNVERIFIED');
    // Takes and, in exclusive mode, keeps the file lock, so a second writer fails here rather than later.
    db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT');
    db.defaultSafeIntegers(true);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof StorageFailure) throw error;
    throw new StorageFailure(classifyError(error));
  }
}

/**
 * Opens (creating or migrating when needed) a database for one purpose. A new or empty file gets every migration in one
 * transaction without a backup. An older schema is backed up and verified first, then migrated in one transaction.
 */
export async function openConnection(options: OpenOptions): Promise<StorageConnection> {
  const now = options.now ?? Date.now, migrations = options.migrations ?? MIGRATIONS, supported = supportedVersion(migrations);
  if (!(options.purpose in ACCEPTED_ORIGIN) || typeof options.appVersion !== 'string' || !options.appVersion || options.appVersion.length > 64) fail('INVALID_INPUT');
  validatePath(options.path, options.purpose);
  if (typeof options.backupsDirectory !== 'string' || !path.isAbsolute(options.backupsDirectory)) fail('DATA_PATH_INVALID');
  const inspection = inspect(options.path, options.purpose, supported);
  options.testHooks?.afterInspect?.(options.path);
  const db = openWriter(options.path, options.testHooks, locked => recheck(locked, inspection, supported));
  try {
    let migratedFrom: number | undefined, backupFileName: string | undefined;
    if (inspection.fresh) {
      db.transaction(() => {
        db.pragma(`application_id = ${APPLICATION_ID}`);
        applySteps(db, migrations, {nowMs: now(), appVersion: options.appVersion});
        db.prepare('INSERT INTO database_info (id, database_uuid, purpose, accepted_origin, created_utc_ms, created_app_version) VALUES (1, ?, ?, ?, ?, ?)')
          .run(randomUUID(), options.purpose, ACCEPTED_ORIGIN[options.purpose], now(), options.appVersion);
        checkIntegrity(db);
      }).immediate();
    } else if (inspection.version < supported) {
      const databaseUuid = String(db.prepare('SELECT database_uuid FROM database_info WHERE id = 1').pluck().get());
      const backup = await backupBeforeMigration(db, {file: options.path, backupsDirectory: options.backupsDirectory, databaseUuid, fromVersion: inspection.version, now, appVersion: options.appVersion, hooks: options.testHooks});
      const pending = migrations.slice(inspection.version), foreignKeysOff = pending.some(step => step.foreignKeysOff);
      try {
        if (foreignKeysOff) db.pragma('foreign_keys = OFF');
        db.transaction(() => { applySteps(db, pending, {nowMs: now(), appVersion: options.appVersion, backup}); checkIntegrity(db); }).immediate();
      } catch (error) {
        fail('MIGRATION_FAILED', {backupFileName: backup.fileName, cause: classifyError(error, 'MIGRATION_FAILED').code});
      } finally {
        if (foreignKeysOff) { db.pragma('foreign_keys = ON'); if (Number(db.pragma('foreign_keys', {simple: true})) !== 1) fail('DURABILITY_UNVERIFIED'); }
      }
      migratedFrom = inspection.version; backupFileName = backup.fileName;
      pruneBackups(options.backupsDirectory, databaseUuid, backup.fileName);
    }
    const info = db.prepare('SELECT database_uuid, purpose FROM database_info WHERE id = 1').get() as {database_uuid: string; purpose: Purpose} | undefined;
    if (!info) fail('DATABASE_UNRECOGNIZED');
    if (info.purpose !== options.purpose) fail('PURPOSE_MISMATCH');
    const summary: OpenSummary = {schemaVersion: supported, created: inspection.fresh, databaseUuid: info.database_uuid, purpose: info.purpose};
    if (migratedFrom !== undefined) { summary.migratedFrom = migratedFrom; summary.backupFileName = backupFileName; }
    return new StorageConnection(db, DURABILITY, summary, now);
  } catch (error) {
    db.close();
    if (error instanceof StorageFailure) throw error;
    throw new StorageFailure(classifyError(error));
  }
}
