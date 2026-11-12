// Text report of a history repair plan and result (ET-112g). Node-safe.
import type {RepairListing, RepairPlan, RepairResult, RepairSummary} from '../../../packages/storage/src/api';

const value = (reading: {available: true; value: unknown} | {available: false; reason: string}, unit = '') =>
  reading.available ? `${String(reading.value)}${unit}` : reading.reason;
/** One root's values on one line: outcome, recording, sources, quantities, delivery, Hard Mode and upload state. */
export function summaryText(s: RepairSummary): string {
  const hardMode = s.hardMode ? `${s.hardMode.passingChecks}/${s.hardMode.failingChecks}/${s.hardMode.unknownChecks} ${s.hardMode.qualified ? 'qualified' : 'not qualified'}` : 'none';
  const revenue = s.revenue === null ? 'none' : s.revenue.available ? `${s.revenue.value.raw} (${s.revenue.value.sdkType})` : s.revenue.reason;
  const hold = s.upload.holdReason ? `, held (${s.upload.holdReason})` : s.upload.held ? ', held' : '';
  const upload = `${s.upload.bound ? 'bound' : 'unbound'}${hold}${s.upload.identity ? `, identity ${s.upload.identity}` : ''}`;
  return `${s.outcome}, recording ${s.recordingCompleteness}, ${s.sources} ${s.sources === 1 ? 'recording' : 'recordings'}, distance ${value(s.distanceM, ' m')}, fuel ${value(s.fuelUsedL, ' L')}, `
    + `game distance ${s.deliveredDistanceM === null ? 'none' : value(s.deliveredDistanceM, ' m')}, revenue ${revenue}, Hard Mode ${hardMode}, upload ${upload}`;
}
const SECTIONS: readonly [RepairListing['state'], string][] = [
  ['needs-attestation', 'Join candidates that need your evidence (rerun the dry run with --attest <segment uuid>)'],
  ['reconciliation-required', 'Published separately: reconciliation required, never applied'],
  ['wait', 'Waiting for a pending membership decision'],
  ['not-eligible', 'Not eligible'],
  ['already-joined', 'Already joined'],
  ['unknown-trip', 'Unknown attested trips']
];
/** The dry run's report of `plan`, one line per entry. */
export function planLines(plan: RepairPlan): string[] {
  const lines = [`Database ${plan.databaseUuid}, schema ${plan.schemaVersion}`, `Joins to apply: ${plan.actions.length}`];
  for (const action of plan.actions) {
    lines.push(`  ${action.segmentTripUuid} -> ${action.targetTripUuid}`, `    before, segment: ${summaryText(action.before.segment)}`,
      `    before, target:  ${summaryText(action.before.target)}`, `    after:           ${summaryText(action.after)}`);
  }
  for (const [state, title] of SECTIONS) {
    const entries = plan.listings.filter(listing => listing.state === state);
    if (!entries.length) continue;
    lines.push(`${title}: ${entries.length}`);
    for (const entry of entries) lines.push(`  ${entry.segmentTripUuid}${entry.targetTripUuid ? ` -> ${entry.targetTripUuid}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  lines.push(`Confirmation code: ${plan.confirmation}`);
  return lines;
}
/** The apply report of `result`. */
export function resultLines(result: RepairResult): string[] {
  return [`Database ${result.databaseUuid}, pre-repair backup ${result.backupFileName}`,
    ...result.actions.map(action => `  ${action.segmentTripUuid} -> ${action.targetTripUuid}: ${action.status}`)];
}
