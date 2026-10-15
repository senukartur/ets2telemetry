// Forward-only schema migrations. Each version is applied once, records itself in `schema_migrations` and sets
// PRAGMA user_version; all pending versions run in one transaction. Released migrations are frozen.
import type Database from 'better-sqlite3';
import {SCHEMA_V1} from './schema-v1';

/** PRAGMA application_id of every database this application creates: the ASCII bytes 'ETS2'. */
export const APPLICATION_ID = 0x45545332;
export interface Migration {
  version: number; name: string; up(db: Database.Database): void;
  /** A table-rebuild step: the framework turns foreign keys off outside the transaction and checks them before commit. */
  foreignKeysOff?: boolean;
}
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({version: 1, name: '0001-initial', up(db: Database.Database) { for (const statement of SCHEMA_V1) db.exec(statement); }})
]);

/** The schema version a migration list produces; versions must be 1, 2, ... without gaps. */
export function supportedVersion(migrations: readonly Migration[]): number {
  migrations.forEach((m, index) => { if (m.version !== index + 1 || !m.name) throw new RangeError('Migrations must be numbered 1, 2, ... without gaps'); });
  if (!migrations.length) throw new RangeError('At least one migration is required');
  return migrations.length;
}

/** Applies steps inside the caller's transaction and records each one with the pre-migration backup, if any. */
export function applySteps(db: Database.Database, steps: readonly Migration[], context: {nowMs: number; appVersion: string; backup?: {fileName: string; sha256: string}}): void {
  for (const step of steps) {
    step.up(db);
    db.pragma(`user_version = ${step.version}`);
    // Prepared after the step: version 1 creates the table itself.
    db.prepare('INSERT INTO schema_migrations (version, name, applied_utc_ms, app_version, backup_file_name, backup_sha256) VALUES (?, ?, ?, ?, ?, ?)').run(step.version, step.name, context.nowMs, context.appVersion, context.backup?.fileName ?? null, context.backup?.sha256 ?? null);
  }
}

/** Fails the surrounding transaction unless foreign keys and the quick integrity check pass. */
export function checkIntegrity(db: Database.Database, check: 'quick_check' | 'integrity_check' = 'quick_check'): void {
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key check failed');
  if (db.pragma(check, {simple: true}) !== 'ok') throw new Error('Integrity check failed');
}
