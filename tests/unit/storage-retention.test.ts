import {describe, expect, it} from 'vitest';
import {backupsToDelete, type BackupEntry} from '../../packages/storage/src/retention';

const DB = 'f0000000-0000-4000-8000-000000000001', OTHER = 'f0000000-0000-4000-8000-000000000002';
const entry = (name: string, createdUtcMs: number, overrides: Partial<BackupEntry> = {}): BackupEntry => ({fileName: `${name}.sqlite`, databaseUuid: DB, createdUtcMs, verified: true, ...overrides});
const latest = (name: string, migrationCommitted = true, verified = true) => ({fileName: `${name}.sqlite`, verified, migrationCommitted});

describe('pre-migration backup retention', () => {
  const entries = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)];
  it('keeps the three newest verified backups, counting the new one', () => {
    expect(backupsToDelete(entries, DB, latest('e')).sort()).toEqual(['a.sqlite', 'b.sqlite']);
    expect(backupsToDelete(entries.slice(0, 3), DB, latest('c'))).toEqual([]);
  });
  it('deletes nothing before the new backup is verified and its migration committed', () => {
    expect(backupsToDelete(entries, DB, latest('e', false))).toEqual([]);
    expect(backupsToDelete(entries, DB, latest('e', true, false))).toEqual([]);
    expect(backupsToDelete(entries, DB, latest('missing'))).toEqual([]);
  });
  it('ignores unverified entries and other databases', () => {
    const mixed = [...entries, entry('foreign-old', 0, {databaseUuid: OTHER}), entry('unverified-old', 0, {verified: false})];
    expect(backupsToDelete(mixed, DB, latest('e')).sort()).toEqual(['a.sqlite', 'b.sqlite']);
  });
  it('requires keeping at least one backup', () => {
    expect(() => backupsToDelete(entries, DB, latest('e'), 0)).toThrow(RangeError);
    expect(backupsToDelete(entries, DB, latest('e'), 1).sort()).toEqual(['a.sqlite', 'b.sqlite', 'c.sqlite', 'd.sqlite']);
  });
});
