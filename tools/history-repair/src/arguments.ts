// Command-line arguments of the history repair tool (ET-112g, docs/storage.md "History repair"). Node-safe.
import path from 'node:path';
import {parseRepairPlan, repairConfirmationCode} from '../../../packages/storage/src/history-repair-plan';

export const USAGE = `Usage:
  npm run history:repair -- copy --from <database> --to <new file>
  npm run history:repair -- dry-run --database <database> --out <new plan.json> [--attest <trip uuid>]...
  npm run history:repair -- apply --database <database> --plan <plan.json> --confirm <code> [--working-history] [--backups <directory>]
Exit Yukon Union Telemetry first. Every path is explicit and absolute, outside this checkout (npm runs the tool from the
checkout root); there is no default database.`;

export type RepairCommand =
  | {command: 'copy'; from: string; to: string}
  | {command: 'dry-run'; database: string; out: string; attest: string[]}
  | {command: 'apply'; database: string; plan: string; confirm: string; workingHistory: boolean; backups?: string};
export class UsageError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPTIONS: Readonly<Record<RepairCommand['command'], {required: string[]; optional: string[]}>> = {
  copy: {required: ['--from', '--to'], optional: []},
  'dry-run': {required: ['--database', '--out'], optional: ['--attest']},
  apply: {required: ['--database', '--plan', '--confirm'], optional: ['--backups']}
};

/**
 * Parses `argv` (without the node and script paths). A path that is not fully qualified (relative, drive-relative or
 * root-relative) is refused rather than resolved: `npm run` starts the tool in the checkout root, where a plan or copy
 * would put trip data into the repository.
 */
export function parseArguments(argv: readonly string[]): RepairCommand {
  const command = argv[0] as RepairCommand['command'];
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(USAGE);
  const {required, optional} = OPTIONS[command], values: Record<string, string> = {}, attest: string[] = [];
  let workingHistory = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--working-history') {
      if (command !== 'apply') throw new UsageError('--working-history is only valid with apply.');
      if (workingHistory) throw new UsageError(USAGE);
      workingHistory = true;
      continue;
    }
    const value = argv[++i];
    if (![...required, ...optional].includes(key) || value === undefined || value.startsWith('--')) throw new UsageError(USAGE);
    if (key === '--attest') {
      if (!UUID.test(value)) throw new UsageError(`--attest needs a full lowercase trip UUID, as the dry run lists it; got "${value}".`);
      if (!attest.includes(value)) attest.push(value);
      continue;
    }
    if (Object.hasOwn(values, key)) throw new UsageError(USAGE);
    values[key] = value;
  }
  const missing = required.filter(key => values[key] === undefined);
  if (missing.length) throw new UsageError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.\n${USAGE}`);
  const file = (key: string) => {
    const value = values[key];
    if (!path.isAbsolute(value) || path.resolve(value) !== path.normalize(value)) throw new UsageError(`${key} needs an absolute path outside this checkout; got "${value}".`);
    return path.normalize(value);
  };
  if (command === 'copy') return {command, from: file('--from'), to: file('--to')};
  if (command === 'dry-run') return {command, database: file('--database'), out: file('--out'), attest};
  if (!/^[0-9a-f]{8}$/.test(values['--confirm'])) throw new UsageError('--confirm needs the 8-digit code the dry run printed.');
  return {command, database: file('--database'), plan: file('--plan'), confirm: values['--confirm'], workingHistory, ...(values['--backups'] ? {backups: file('--backups')} : {})};
}

/** Refuses a plan text that is not a repair plan or whose confirmation code is not `code`, before any database is opened. */
export function checkConfirmation(planText: string, code: string): void {
  const plan = parseRepairPlan(planText);
  if (!plan) throw new UsageError('The plan file is not a history repair plan.');
  if (plan.confirmation !== repairConfirmationCode(plan.actions) || code !== plan.confirmation) throw new UsageError('The confirmation code does not match the plan; use the code the dry run printed for this plan.');
}
