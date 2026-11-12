// History repair orchestration (ET-112g, docs/storage.md "History repair"): `copy`, `dry-run` and `apply` of
// tools/history-repair. Every database path is an explicit absolute argument; nothing here knows a default data folder.
// It loads native better-sqlite3 through the storage core, so only the Electron-runtime tool and storage suite import it.
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {REPAIR_PLAN_FORMAT, type Purpose, type RepairOptions, type RepairPlan, type RepairRefusal, type RepairResult, type StorageError} from './api';
import {classifyError, fail} from './errors';
import {isHistoryFile} from './history-file';
import {parseRepairPlan, repairConfirmationCode} from './history-repair-plan';
import {copyVerified, verifiedBackup, type VerifiedCopy} from './sqlite/backup';
import {openConnection, openReadOnly, type StorageConnection} from './sqlite/connection';
import {applyRepairAction, planRepair} from './sqlite/history-repair';
import {APPLICATION_ID, MIGRATIONS, supportedVersion} from './sqlite/migrations';

export type RepairOutcome<T> = {ok: true; value: T} | {ok: false; error: StorageError | RepairRefusal};
const REFUSALS: Readonly<Record<RepairRefusal['reason'], string>> = {
  'plan-invalid': 'The plan file is not a history repair plan.',
  'confirmation-mismatch': 'The confirmation code does not match the plan.',
  'database-mismatch': 'The plan was made for another database.',
  'working-history-flag': 'This is a working history file; pass --working-history to repair it.',
  'working-history-schema': 'The working history has another schema version than this tool; start the matching app version once, exit it, and retry.',
  'path-invalid': 'Every path must be absolute.',
  'target-exists': 'The output file, or a -wal, -shm, -journal or .partial file beside it, already exists; choose a new file name.'
};
class Refused extends Error { constructor(readonly reason: RepairRefusal['reason']) { super(REFUSALS[reason]); } }
function refuse(reason: RepairRefusal['reason']): never { throw new Refused(reason); }
/** A failure after the pre-repair backup was taken: its result carries the backup's file name. */
class AfterBackup extends Error { constructor(readonly backupFileName: string, readonly failure: unknown) { super('History repair failed after its pre-repair backup'); } }
async function outcome<T>(body: () => Promise<T>): Promise<RepairOutcome<T>> {
  try { return {ok: true, value: await body()}; } catch (thrown) {
    const after = thrown instanceof AfterBackup ? thrown : undefined, error = after ? after.failure : thrown;
    const mapped = error instanceof Refused ? {code: 'REPAIR_REFUSED' as const, reason: error.reason, message: error.message} : classifyError(error);
    return {ok: false, error: after ? {...mapped, backupFileName: after.backupFileName} : mapped};
  }
}
const absolute = (...files: string[]) => { if (files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) refuse('path-invalid'); };
/** Refuses an output file that exists, or whose sidecar or partial file does, before anything is opened. */
const unused = (file: string) => { if (['', '-wal', '-shm', '-journal', '.partial'].some(suffix => existsSync(`${file}${suffix}`))) refuse('target-exists'); };

/** Copies `source` read-only into the new file `target` (copyVerified); the source is never written. */
async function copyFile(source: string, target: string): Promise<VerifiedCopy> {
  if (!existsSync(source)) fail('DATA_PATH_INVALID');
  const reader = openReadOnly(source);
  try { return await copyVerified(reader.db, source, target); } finally { reader.close(); }
}

/** `copy --from <file> --to <new file>`: a verified copy that includes committed WAL content. */
export function copyHistory(options: {from: string; to: string}): Promise<RepairOutcome<VerifiedCopy>> {
  return outcome(async () => { absolute(options.from, options.to); unused(path.normalize(options.to)); return copyFile(path.normalize(options.from), path.normalize(options.to)); });
}

export interface DryRunOptions {
  database: string; out: string; attest: readonly string[]; appVersion: string; now?: () => number;
  /** In-process tests only: the parent of the scratch directory instead of the system temporary directory. */
  scratchParent?: string;
  testHooks?: RepairOptions['testHooks'] & {afterScratchOpen?: (scratchDirectory: string) => void};
}
/**
 * `dry-run`: a verified scratch copy of `database` in a new temporary directory, opened with its own purpose and migrated
 * when older; the repair is planned and applied there, the plan is written to the new file `out`, and the scratch
 * directory is removed in every case. The input file is only ever opened read-only.
 */
export function dryRunHistoryRepair(options: DryRunOptions): Promise<RepairOutcome<RepairPlan>> {
  return outcome(async () => {
    absolute(options.database, options.out);
    unused(options.out);
    const now = options.now ?? Date.now, scratch = mkdtempSync(path.join(options.scratchParent ?? tmpdir(), 'ets2telemetry-history-repair-'));
    let conn: StorageConnection | undefined;
    try {
      const file = path.join(scratch, 'scratch.sqlite'), copy = await copyFile(path.normalize(options.database), file);
      conn = await openConnection({path: file, purpose: copy.purpose, backupsDirectory: path.join(scratch, 'backups'), appVersion: options.appVersion, now});
      options.testHooks?.afterScratchOpen?.(scratch);
      const scan = planRepair(conn, options.attest, options);
      const plan: RepairPlan = {format: REPAIR_PLAN_FORMAT, databaseUuid: copy.databaseUuid, schemaVersion: conn.summary.schemaVersion, createdUtcMs: now(), appVersion: options.appVersion,
        attested: [...options.attest], actions: scan.actions, listings: scan.listings, confirmation: repairConfirmationCode(scan.actions)};
      writeFileSync(options.out, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'});
      return plan;
    } finally {
      conn?.close();
      rmSync(scratch, {recursive: true, force: true});
    }
  });
}

export interface ApplyOptions {
  database: string; plan: string; confirm: string; workingHistory?: boolean;
  /** The directory of the pre-repair backup and the result file; default `repair-backups` beside the database. */
  backupsDirectory?: string; appVersion: string; now?: () => number;
  /** In-process tests only: `beforeCommit` runs inside action `index`'s transaction after its join. */
  testHooks?: {beforeCommit?: (index: number) => void};
}
/**
 * `apply`: checks the plan, the confirmation code and the database UUID; a working history file (by the given path or
 * the path it resolves to) needs `workingHistory` and the tool's own schema version, checked read-only before any writer
 * opens, and is never migrated. The writer then holds the exclusive lock, takes a verified pre-repair backup, applies the
 * actions in order, each in its own transaction, stops after the first one that is neither `applied` nor
 * `already-applied`, and writes `<backup>.result.json` beside the backup. Any failure after the backup reports its name.
 */
export function applyHistoryRepair(options: ApplyOptions): Promise<RepairOutcome<RepairResult>> {
  return outcome(async () => {
    absolute(options.database, options.plan, ...(options.backupsDirectory === undefined ? [] : [options.backupsDirectory]));
    const database = path.normalize(options.database), now = options.now ?? Date.now;
    let text: string;
    try { text = readFileSync(options.plan, 'utf8'); } catch { return refuse('plan-invalid'); }
    const plan = parseRepairPlan(text);
    if (!plan) refuse('plan-invalid');
    if (options.confirm !== plan.confirmation || plan.confirmation !== repairConfirmationCode(plan.actions)) refuse('confirmation-mismatch');
    if (!existsSync(database)) fail('DATA_PATH_INVALID');
    // A junction, symbolic link, 8.3 name or substituted drive can reach a history file under another name.
    const history = isHistoryFile(database) || isHistoryFile(realpathSync.native(database));
    if (history && options.workingHistory !== true) refuse('working-history-flag');
    const peek = openReadOnly(database);
    let purpose: Purpose;
    try {
      const db = peek.db;
      if (Number(db.pragma('application_id', {simple: true})) !== APPLICATION_ID) fail('DATABASE_UNRECOGNIZED');
      const info = db.prepare('SELECT database_uuid, purpose FROM database_info WHERE id = 1').get() as {database_uuid: string; purpose: Purpose} | undefined;
      if (!info) fail('DATABASE_UNRECOGNIZED');
      if (info.database_uuid !== plan.databaseUuid) refuse('database-mismatch');
      if (history && Number(db.pragma('user_version', {simple: true})) !== supportedVersion(MIGRATIONS)) refuse('working-history-schema');
      purpose = info.purpose;
    } finally { peek.close(); }
    const backupsDirectory = options.backupsDirectory ?? path.join(path.dirname(database), 'repair-backups');
    const conn = await openConnection({path: database, purpose, backupsDirectory, appVersion: options.appVersion, now});
    try {
      if (conn.summary.databaseUuid !== plan.databaseUuid) refuse('database-mismatch');
      if (history && conn.summary.migratedFrom !== undefined) refuse('working-history-schema');
      const backup = await verifiedBackup(conn.writer(), {file: database, backupsDirectory, databaseUuid: conn.summary.databaseUuid, fromVersion: conn.summary.schemaVersion, now,
        appVersion: options.appVersion}, 'pre-repair');
      try {
        const actions: RepairResult['actions'] = [];
        for (const [index, action] of plan.actions.entries()) {
          const {status} = applyRepairAction(conn, action, {testHooks: {beforeCommit: () => options.testHooks?.beforeCommit?.(index)}});
          actions.push({segmentTripUuid: action.segmentTripUuid, targetTripUuid: action.targetTripUuid, status});
          // The later actions were planned on top of this one.
          if (status !== 'applied' && status !== 'already-applied') break;
        }
        const result: RepairResult = {format: 'ets2telemetry-history-repair-result-1', databaseUuid: conn.summary.databaseUuid, backupFileName: backup.fileName,
          confirmation: plan.confirmation, completedUtcMs: now(), actions};
        writeFileSync(path.join(backupsDirectory, backup.fileName.replace(/\.sqlite$/, '.result.json')), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
        return result;
      } catch (error) { throw new AfterBackup(backup.fileName, error); }
    } finally { conn.close(); }
  });
}
