// History repair tool (ET-112g): `npm run history:repair -- <copy|dry-run|apply> ...` under the checkout's Electron in
// Node mode. See docs/storage.md, "History repair". It never resolves a data folder: every path is an argument.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {applyHistoryRepair, copyHistory, dryRunHistoryRepair, type RepairOutcome} from '../../../packages/storage/src/index';
import {checkConfirmation, parseArguments, UsageError} from './arguments';
import {planLines, resultLines} from './summary';

const APP_VERSION = `history-repair ${process.env.npm_package_version ?? 'unknown'}`.slice(0, 64);
/** The checkout root, from this script's location (tools/history-repair/dist/cli.cjs); no path argument may lie inside it. */
const CHECKOUT = path.resolve(__dirname, '..', '..', '..');
/** The one recovery guidance of an apply that did not finish; docs/storage.md, "History repair", says the same. */
const unfinished = (backup: string) => `The repair did not finish; the actions before this point are committed, each on its own. Rerun the same apply to
finish an interrupted run (applied actions report already-applied); if an action was stale, differs or refused, make a new
dry run instead. To undo, exit the app and restore the backup ${backup} (docs/storage.md, "History repair").`;

function failure(result: Extract<RepairOutcome<unknown>, {ok: false}>, backups?: string): never {
  const error = result.error;
  if (error.code === 'DATABASE_LOCKED') throw new UsageError('The database is in use. Exit Yukon Union Telemetry first (tray icon, Exit), then retry.');
  const cause = 'cause' in error && error.cause ? ` (${error.cause})` : '';
  const message = error.code === 'REPAIR_REFUSED' ? error.message : `${error.code}${cause}: ${error.message}`;
  throw new UsageError(backups && error.backupFileName ? `${message}\n${unfinished(path.join(backups, error.backupFileName))}` : message);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2), CHECKOUT);
  if (args.command === 'copy') {
    const result = await copyHistory({from: args.from, to: args.to});
    if (!result.ok) failure(result);
    console.log(`Verified copy written to ${args.to}: database ${result.value.databaseUuid}, schema ${result.value.schemaVersion}, ${result.value.size} bytes, SHA-256 ${result.value.fileSha256}.`);
    return;
  }
  if (args.command === 'dry-run') {
    const result = await dryRunHistoryRepair({database: args.database, out: args.out, attest: args.attest, appVersion: APP_VERSION});
    if (!result.ok) failure(result);
    for (const line of planLines(result.value)) console.log(line);
    console.log(`Plan written to ${args.out}. The input database was not changed.`);
    return;
  }
  let planText: string;
  try { planText = readFileSync(args.plan, 'utf8'); } catch { throw new UsageError('The plan file cannot be read.'); }
  checkConfirmation(planText, args.confirm);
  const result = await applyHistoryRepair({database: args.database, plan: args.plan, confirm: args.confirm, workingHistory: args.workingHistory,
    ...(args.backups ? {backupsDirectory: args.backups} : {}), appVersion: APP_VERSION});
  const backups = args.backups ?? path.join(path.dirname(args.database), 'repair-backups');
  if (!result.ok) failure(result, backups);
  for (const line of resultLines(result.value)) console.log(line);
  if (result.value.actions.some(action => action.status !== 'applied' && action.status !== 'already-applied')) {
    console.error(unfinished(path.join(backups, result.value.backupFileName)));
    process.exitCode = 1;
  }
}
void main().catch((error: unknown) => { console.error(error instanceof UsageError ? error.message : `History repair failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
