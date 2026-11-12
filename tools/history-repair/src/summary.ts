// Text report of a history repair plan and result (ET-112g). Node-safe.
import type {RepairListing, RepairPlan, RepairQuantitiesAction, RepairQuantityListing, RepairResult, RepairSummary} from '../../../packages/storage/src/api';

const value = (reading: {available: true; value: unknown} | {available: false; reason: string}, unit = '') =>
  reading.available ? `${String(reading.value)}${unit}` : reading.reason;
/**
 * One root's values on one line: outcome, recording, sources, quantities (with their engine-1 status), delivery, money
 * totals when incomplete, Hard Mode and upload state.
 */
export function summaryText(s: RepairSummary): string {
  const status = (quantity: 'distance' | 'fuel') => s.accounting ? ` (${s.accounting[quantity]})` : '';
  const hardMode = s.hardMode ? `${s.hardMode.passingChecks}/${s.hardMode.failingChecks}/${s.hardMode.unknownChecks} ${s.hardMode.qualified ? 'qualified' : 'not qualified'}` : 'none';
  const revenue = s.revenue === null ? 'none' : s.revenue.available ? `${s.revenue.value.raw} (${s.revenue.value.sdkType})` : s.revenue.reason;
  const hold = s.upload.holdReason ? `, held (${s.upload.holdReason})` : s.upload.held ? ', held' : '';
  const upload = `${s.upload.bound ? 'bound' : 'unbound'}${hold}${s.upload.identity ? `, identity ${s.upload.identity}` : ''}`;
  return `${s.outcome}, recording ${s.recordingCompleteness}, ${s.sources} ${s.sources === 1 ? 'recording' : 'recordings'}, distance ${value(s.distanceM, ' m')}${status('distance')}, `
    + `fuel ${value(s.fuelUsedL, ' L')}${status('fuel')}, `
    + `game distance ${s.deliveredDistanceM === null ? 'none' : value(s.deliveredDistanceM, ' m')}, revenue ${revenue}${s.moneyIncomplete ? ', money totals incomplete' : ''}, `
    + `Hard Mode ${hardMode}, upload ${upload}`;
}
const SECTIONS: readonly [RepairListing['state'], string][] = [
  ['needs-attestation', 'Join candidates that need your evidence (rerun the dry run with --attest <segment uuid>)'],
  ['reconciliation-required', 'Published separately: reconciliation required, never applied'],
  ['wait', 'Waiting for a pending membership decision'],
  ['not-eligible', 'Not eligible'],
  ['already-joined', 'Already joined'],
  ['unknown-trip', 'Unknown attested trips']
];
const QUANTITY_REASONS: readonly [RepairQuantityListing['reason'], string][] = [
  ['excluded', 'excluded'], ['open-member', 'a recording is still open'], ['too-large', 'too many samples'], ['no-truck-evidence', 'no complete reading'],
  ['unchanged', 'unchanged'], ['not-engine-0', 'engine-1 rows already present'], ['unknown-exclude', '--exclude names no legacy trip']
];
/** A recalculation that turns an available quantity partial or unavailable: worth a look, and `--exclude` keeps the old value. */
function downgrades(action: RepairQuantitiesAction): string[] {
  return (['distance', 'fuel'] as const).filter(quantity => action.before[quantity === 'distance' ? 'distanceM' : 'fuelUsedL'].available
    && action.after.accounting !== undefined && action.after.accounting[quantity] !== 'complete').map(quantity => `${quantity} becomes ${action.after.accounting![quantity]}`);
}
/** The dry run's report of `plan`, one line per entry. */
export function planLines(plan: RepairPlan): string[] {
  const joins = plan.actions.filter(action => action.kind === 'join'), quantities = plan.actions.filter(action => action.kind === 'quantities');
  const lines = [`Database ${plan.databaseUuid}, schema ${plan.schemaVersion}`, `Joins to apply: ${joins.length}`];
  for (const action of joins) {
    lines.push(`  ${action.segmentTripUuid} -> ${action.targetTripUuid}`, `    before, segment: ${summaryText(action.before.segment)}`,
      `    before, target:  ${summaryText(action.before.target)}`, `    after:           ${summaryText(action.after)}`);
  }
  for (const [state, title] of SECTIONS) {
    const entries = plan.listings.filter(listing => listing.state === state);
    if (!entries.length) continue;
    lines.push(`${title}: ${entries.length}`);
    for (const entry of entries) lines.push(`  ${entry.segmentTripUuid}${entry.targetTripUuid ? ` -> ${entry.targetTripUuid}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  // ET-112g2: shown only when the plan recalculates or leaves a legacy root, like the listing sections above.
  if (quantities.length) lines.push(`Distance and fuel recalculations to apply (skip one with --exclude <trip uuid>): ${quantities.length}`);
  for (const action of quantities) {
    lines.push(`  ${action.logicalTripUuid}`, `    before: ${summaryText(action.before)}`, `    after:  ${summaryText(action.after)}`);
    for (const downgrade of downgrades(action)) lines.push(`    DOWNGRADE: ${downgrade}`);
  }
  if (plan.quantityListings.length) lines.push(`Legacy trips whose distance and fuel stay as recorded: ${plan.quantityListings.length}`);
  for (const [reason, text] of QUANTITY_REASONS) for (const entry of plan.quantityListings.filter(listing => listing.reason === reason)) lines.push(`  ${entry.logicalTripUuid} (${text})`);
  lines.push(`Confirmation code: ${plan.confirmation}`);
  return lines;
}
/** The apply report of `result`. */
export function resultLines(result: RepairResult): string[] {
  return [`Database ${result.databaseUuid}, pre-repair backup ${result.backupFileName}`,
    ...result.actions.map(action => 'logicalTripUuid' in action ? `  ${action.logicalTripUuid} distance and fuel: ${action.status}` : `  ${action.segmentTripUuid} -> ${action.targetTripUuid}: ${action.status}`)];
}
