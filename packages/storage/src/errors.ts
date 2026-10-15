// Maps SQLite and operating-system failures to stable storage error codes. Node-safe: it inspects only the `code`
// strings that better-sqlite3 (SqliteError) and Node (errno) attach, so it never loads native SQLite.
import type {StorageError, StorageErrorCode} from './api';

/** Fixed, path-free text per code. SQLite and OS messages can contain paths, so they are never copied. */
export const ERROR_MESSAGES: Readonly<Record<StorageErrorCode, string>> = {
  DATABASE_LOCKED: 'The database is locked by another connection.',
  PERMISSION_DENIED: 'The database or its directory cannot be written.',
  DISK_FULL: 'The disk or the database size limit is full.',
  IO_ERROR: 'A disk input/output error occurred.',
  DATABASE_CORRUPT: 'The database file is damaged or is not a database.',
  CONSTRAINT_VIOLATION: 'The change violates a database constraint.',
  INVALID_INPUT: 'The command input is invalid.',
  UNKNOWN_SESSION: 'The plugin session is not stored.',
  UNKNOWN_TRIP: 'The trip is not stored.',
  SESSION_CONFLICT: 'The plugin session identity differs from the stored session.',
  VALUE_OUT_OF_RANGE: 'A value is outside the range that can be stored exactly.',
  STORAGE_CLOSED: 'The storage connection is closed.',
  STORAGE_BUSY: 'Too many storage commands are queued.',
  WORKER_FAILED: 'The storage worker failed.',
  TIMEOUT: 'The storage command did not finish in time.',
  DATA_PATH_INVALID: 'The database path is not a valid location for this database.',
  DATABASE_UNRECOGNIZED: 'The file is not a database created by this application.',
  SCHEMA_NEWER: 'The database was created by a newer version of this application.',
  PURPOSE_MISMATCH: 'The database holds a different kind of data than requested.',
  DURABILITY_UNVERIFIED: 'The required durability settings could not be verified.',
  BACKUP_FAILED: 'A verified backup could not be created or read.',
  MIGRATION_FAILED: 'The database schema could not be upgraded; the database is unchanged.',
  INTERNAL: 'An unexpected storage failure occurred.'
};
/** Codes that a caller may retry unchanged after the condition clears. */
const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set(['DATABASE_LOCKED', 'DISK_FULL', 'IO_ERROR', 'STORAGE_BUSY', 'TIMEOUT']);

export function storageError(code: StorageErrorCode, extra: Pick<StorageError, 'sqliteCode' | 'cause' | 'backupFileName'> = {}): StorageError {
  const error: StorageError = {code, retryable: RETRYABLE.has(code), message: ERROR_MESSAGES[code]};
  if (extra.sqliteCode !== undefined) error.sqliteCode = extra.sqliteCode;
  if (extra.cause !== undefined) error.cause = extra.cause;
  if (extra.backupFileName !== undefined) error.backupFileName = extra.backupFileName;
  return error;
}

/** Thrown inside the storage core and converted to a result at the public boundary. Its message is the fixed text. */
export class StorageFailure extends Error {
  constructor(readonly error: StorageError) { super(error.message); this.name = 'StorageFailure'; }
}
export function fail(code: StorageErrorCode, extra?: Pick<StorageError, 'sqliteCode' | 'cause' | 'backupFileName'>): never {
  throw new StorageFailure(storageError(code, extra));
}

const SQLITE_PREFIXES: [string, StorageErrorCode][] = [
  ['SQLITE_BUSY', 'DATABASE_LOCKED'], ['SQLITE_LOCKED', 'DATABASE_LOCKED'],
  ['SQLITE_READONLY', 'PERMISSION_DENIED'], ['SQLITE_PERM', 'PERMISSION_DENIED'], ['SQLITE_AUTH', 'PERMISSION_DENIED'],
  // The path and its directory are validated before opening, so a refused open is an access failure.
  ['SQLITE_CANTOPEN', 'PERMISSION_DENIED'],
  ['SQLITE_FULL', 'DISK_FULL'], ['SQLITE_IOERR', 'IO_ERROR'],
  ['SQLITE_CORRUPT', 'DATABASE_CORRUPT'], ['SQLITE_NOTADB', 'DATABASE_CORRUPT'],
  ['SQLITE_CONSTRAINT', 'CONSTRAINT_VIOLATION'], ['SQLITE_RANGE', 'INVALID_INPUT'], ['SQLITE_MISMATCH', 'INVALID_INPUT']
];
const ERRNO: Readonly<Record<string, StorageErrorCode>> = {
  EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED', EROFS: 'PERMISSION_DENIED',
  ENOSPC: 'DISK_FULL', EDQUOT: 'DISK_FULL', EBUSY: 'DATABASE_LOCKED',
  ENOTDIR: 'DATA_PATH_INVALID', EISDIR: 'DATA_PATH_INVALID', ENOENT: 'DATA_PATH_INVALID', EEXIST: 'DATA_PATH_INVALID', ENAMETOOLONG: 'DATA_PATH_INVALID', EINVAL: 'DATA_PATH_INVALID',
  EIO: 'IO_ERROR'
};

/**
 * Classifies any thrown value without leaking its message. A failure that is neither a known SQLite result code nor a
 * known operating-system error is a defect in the storage code (for example a TypeError, or a RangeError that
 * better-sqlite3 throws for a wrong parameter count): it becomes the non-retryable INTERNAL unless the caller names a
 * more specific fallback. Inputs are validated before they reach SQLite, so a range problem is never inferred here.
 */
export function classifyError(error: unknown, fallback: StorageErrorCode = 'INTERNAL'): StorageError {
  if (error instanceof StorageFailure) return error.error;
  const code = typeof error === 'object' && error !== null && typeof (error as {code?: unknown}).code === 'string' ? (error as {code: string}).code : undefined;
  if (code?.startsWith('SQLITE_')) {
    const match = SQLITE_PREFIXES.find(([prefix]) => code === prefix || code.startsWith(`${prefix}_`));
    return storageError(match ? match[1] : fallback, {sqliteCode: code});
  }
  if (code && ERRNO[code]) return storageError(ERRNO[code]);
  return storageError(fallback);
}
