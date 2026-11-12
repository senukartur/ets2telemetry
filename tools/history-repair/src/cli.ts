// History repair tool (ET-112g): `npm run history:repair -- <copy|dry-run|apply> ...` under the checkout's Electron in
// Node mode. See docs/storage.md, "History repair". It never resolves a data folder: every path is an argument.
import {readFileSync} from 'node:fs';
import {applyHistoryRepair, copyHistory, dryRunHistoryRepair, type RepairOutcome} from '../../../packages/storage/src/index';
import {checkConfirmation, parseArguments, UsageError} from './arguments';
import {planLines, resultLines} from './summary';

const APP_VERSION = `history-repair ${process.env.npm_package_version ?? 'unknown'}`.slice(0, 64);

function failure(result: Extract<RepairOutcome<unknown>, {ok: false}>): never {
  const error = result.error;
  if (error.code === 'DATABASE_LOCKED') throw new UsageError('The database is in use. Exit Yukon Union Telemetry first (tray icon, Exit), then retry.');
  const cause = 'cause' in error && error.cause ? ` (${error.cause})` : '';
  throw new UsageError(error.code === 'REPAIR_REFUSED' ? error.message : `${error.code}${cause}: ${error.message}`);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
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
  if (!result.ok) failure(result);
  for (const line of resultLines(result.value)) console.log(line);
  if (result.value.actions.some(action => action.status !== 'applied' && action.status !== 'already-applied')) {
    console.error('Some actions were not applied. Stop, and redo the repair from a new copy and dry run.');
    process.exitCode = 1;
  }
}
void main().catch((error: unknown) => { console.error(error instanceof UsageError ? error.message : `History repair failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
