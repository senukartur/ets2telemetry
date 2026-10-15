// Pure retention policy for pre-migration backups (OD-5). Node-safe: it decides which manifest-described backups may be
// deleted; the caller deletes them. Files without a manifest written by this application are never listed here.

export const KEEP_BACKUPS = 3;
/** A pre-migration backup known through its manifest. */
export interface BackupEntry {fileName: string; databaseUuid: string; createdUtcMs: number; verified: boolean}
/** The backup made by the current open: deletion waits until it is verified and its migration has committed. */
export interface NewBackup {fileName: string; verified: boolean; migrationCommitted: boolean}

/**
 * Returns the backup file names to delete for one database: everything older than the newest `keep` verified backups,
 * counting the new one. Nothing is deleted until the new backup is verified and its migration committed, unverified
 * entries are never counted or deleted, and backups of other databases are never touched.
 */
export function backupsToDelete(entries: readonly BackupEntry[], databaseUuid: string, latest: NewBackup, keep = KEEP_BACKUPS): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('At least one backup must be kept');
  if (!latest.verified || !latest.migrationCommitted) return [];
  const own = entries.filter(entry => entry.databaseUuid === databaseUuid && entry.verified);
  if (!own.some(entry => entry.fileName === latest.fileName)) return [];
  const others = own.filter(entry => entry.fileName !== latest.fileName)
    .sort((a, b) => b.createdUtcMs - a.createdUtcMs || (a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0));
  return others.slice(keep - 1).map(entry => entry.fileName);
}
