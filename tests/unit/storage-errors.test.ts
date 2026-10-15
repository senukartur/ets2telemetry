import {describe, expect, it} from 'vitest';
import type {StorageErrorCode} from '../../packages/storage/src/api';
import {classifyError, ERROR_MESSAGES, fail, StorageFailure, storageError} from '../../packages/storage/src/errors';

const ALL: StorageErrorCode[] = ['DATABASE_LOCKED', 'PERMISSION_DENIED', 'DISK_FULL', 'IO_ERROR', 'DATABASE_CORRUPT', 'CONSTRAINT_VIOLATION', 'INVALID_INPUT',
  'UNKNOWN_SESSION', 'UNKNOWN_TRIP', 'SESSION_CONFLICT', 'VALUE_OUT_OF_RANGE', 'STORAGE_CLOSED', 'STORAGE_BUSY', 'WORKER_FAILED', 'TIMEOUT', 'DATA_PATH_INVALID',
  'DATABASE_UNRECOGNIZED', 'SCHEMA_NEWER', 'PURPOSE_MISMATCH', 'DURABILITY_UNVERIFIED', 'BACKUP_FAILED', 'MIGRATION_FAILED'];
const RETRYABLE: StorageErrorCode[] = ['DATABASE_LOCKED', 'DISK_FULL', 'IO_ERROR', 'STORAGE_BUSY', 'TIMEOUT'];
const sqlite = (code: string) => Object.assign(new Error(`SQLite failure at C:\\Users\\someone\\AppData\\Local\\ETS2Telemetry\\data\\telemetry.sqlite`), {code});

describe('storage error codes', () => {
  it('gives every code fixed, path-free text and its retry rule', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ALL].sort());
    for (const code of ALL) {
      const error = storageError(code);
      expect(error).toEqual({code, retryable: RETRYABLE.includes(code), message: ERROR_MESSAGES[code]});
      // One fixed sentence: no drive, backslash or other path syntax ("input/output" is the only slash).
      expect(error.message).toMatch(/^[A-Z][^\\:]*\.$/);
      expect(error.message.replace('input/output', '')).not.toContain('/');
    }
  });
  it('maps SQLite result code families, including extended codes', () => {
    const cases: [string, StorageErrorCode][] = [
      ['SQLITE_BUSY', 'DATABASE_LOCKED'], ['SQLITE_BUSY_SNAPSHOT', 'DATABASE_LOCKED'], ['SQLITE_LOCKED', 'DATABASE_LOCKED'],
      ['SQLITE_READONLY', 'PERMISSION_DENIED'], ['SQLITE_READONLY_DBMOVED', 'PERMISSION_DENIED'], ['SQLITE_PERM', 'PERMISSION_DENIED'], ['SQLITE_CANTOPEN', 'PERMISSION_DENIED'],
      ['SQLITE_FULL', 'DISK_FULL'], ['SQLITE_IOERR', 'IO_ERROR'], ['SQLITE_IOERR_WRITE', 'IO_ERROR'], ['SQLITE_IOERR_FSYNC', 'IO_ERROR'],
      ['SQLITE_CORRUPT', 'DATABASE_CORRUPT'], ['SQLITE_NOTADB', 'DATABASE_CORRUPT'],
      ['SQLITE_CONSTRAINT_UNIQUE', 'CONSTRAINT_VIOLATION'], ['SQLITE_CONSTRAINT_TRIGGER', 'CONSTRAINT_VIOLATION'], ['SQLITE_CONSTRAINT_FOREIGNKEY', 'CONSTRAINT_VIOLATION']
    ];
    for (const [sqliteCode, code] of cases) expect(classifyError(sqlite(sqliteCode)), sqliteCode).toEqual({...storageError(code), sqliteCode});
    // A prefix of another family name is not that family.
    expect(classifyError(sqlite('SQLITE_FULLNESS')).code).toBe('IO_ERROR');
  });
  it('maps operating-system errors and never copies their messages', () => {
    const cases: [string, StorageErrorCode][] = [['EACCES', 'PERMISSION_DENIED'], ['EPERM', 'PERMISSION_DENIED'], ['ENOSPC', 'DISK_FULL'], ['EBUSY', 'DATABASE_LOCKED'],
      ['ENOTDIR', 'DATA_PATH_INVALID'], ['EEXIST', 'DATA_PATH_INVALID'], ['EIO', 'IO_ERROR']];
    for (const [errno, code] of cases) {
      const error = classifyError(Object.assign(new Error(`${errno}: open 'C:\\Users\\someone\\private.sqlite'`), {code: errno}));
      expect(error, errno).toEqual(storageError(code));
      expect(JSON.stringify(error)).not.toContain('someone');
    }
  });
  it('passes typed failures through and classifies unknown failures without leaking them', () => {
    expect(() => fail('SCHEMA_NEWER')).toThrow(StorageFailure);
    try { fail('MIGRATION_FAILED', {backupFileName: 'telemetry-f0000000-v1-20261015T120000000Z.sqlite', cause: 'CONSTRAINT_VIOLATION'}); } catch (error) {
      expect(classifyError(error)).toEqual({...storageError('MIGRATION_FAILED'), backupFileName: 'telemetry-f0000000-v1-20261015T120000000Z.sqlite', cause: 'CONSTRAINT_VIOLATION'});
    }
    expect(classifyError(new Error('C:\\private\\path'))).toEqual(storageError('IO_ERROR'));
    expect(classifyError('string thrown', 'DATABASE_CORRUPT')).toEqual(storageError('DATABASE_CORRUPT'));
    expect(classifyError(new RangeError('BigInt too large'))).toEqual(storageError('VALUE_OUT_OF_RANGE'));
  });
});
