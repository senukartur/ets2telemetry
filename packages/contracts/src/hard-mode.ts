// Persisted-settings evidence only. No paths, profile names or raw configuration crosses this contract.
export const HARD_MODE_RULE_IDS = ['fuel', 'air', 'police', 'fatigue', 'limiter', 'truck', 'trailer', 'parking', 'rain', 'events', 'braking', 'traffic'] as const;
export type HardModeRuleId = typeof HARD_MODE_RULE_IDS[number];
export type HardModeReason = 'compliant' | 'outside-limit' | 'missing' | 'malformed' | 'conflicting' | 'source-unproven' | 'interrupted' | 'historical' | 'source-changed' | 'parking-unproven';
export interface HardModeRule {id: HardModeRuleId; state: 'pass' | 'fail' | 'unknown'; values: (number | null)[]; reason: HardModeReason}
export interface HardModeAssessment {
  observedUtcMs: number; state: 'pass' | 'fail' | 'unknown'; source: 'local' | 'cloud' | 'fixture' | 'unknown'; rules: HardModeRule[];
}
export interface HardModeDetails {
  version: 1; binding: string | null; opening: HardModeAssessment; latest: HardModeAssessment;
  firstLoss: {atUtcMs: number; reason: HardModeReason; rule: HardModeRuleId | null; values: (number | null)[] | null} | null;
  manualDelivery: boolean | null;
}
export interface HardModeStatus {assessment: HardModeAssessment; trip: HardModeDetails | null}
// Internal evidence: digest binds process/session/profile/log generation without retaining names or absolute paths.
export interface HardModeObservation {assessment: HardModeAssessment; binding: string | null; pluginSessionId: string | null; sourceMonotonicNs: string | null}
const reasons: readonly unknown[] = ['compliant', 'outside-limit', 'missing', 'malformed', 'conflicting', 'source-unproven', 'interrupted', 'historical', 'source-changed', 'parking-unproven'];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function isHardModeAssessment(v: unknown): v is HardModeAssessment {
  if (!exact(v, ['observedUtcMs', 'state', 'source', 'rules']) || !time(v.observedUtcMs) || !['pass', 'fail', 'unknown'].includes(v.state as string)
    || !['local', 'cloud', 'fixture', 'unknown'].includes(v.source as string) || !Array.isArray(v.rules) || v.rules.length !== 12) return false;
  if (!v.rules.every((r: unknown, i) => exact(r, ['id', 'state', 'values', 'reason']) && r.id === HARD_MODE_RULE_IDS[i]
    && ['pass', 'fail', 'unknown'].includes(r.state as string) && reasons.includes(r.reason) && Array.isArray(r.values)
    && r.values.length === (r.id === 'parking' ? 2 : 1) && r.values.every((n: unknown) => n === null || typeof n === 'number' && Number.isFinite(n)))) return false;
  const rules = v.rules as HardModeRule[];
  return v.state === (rules.some(r => r.state === 'unknown') ? 'unknown' : rules.every(r => r.state === 'pass') ? 'pass' : 'fail')
    && rules.every(r => r.state === 'pass' ? r.reason === 'compliant' && r.values.every(n => n !== null) : r.state === 'fail' ? r.reason === 'outside-limit' && r.values.every(n => n !== null) : r.reason !== 'compliant' && r.reason !== 'outside-limit');
}
export function isHardModeDetails(v: unknown): v is HardModeDetails {
  if (!exact(v, ['version', 'binding', 'opening', 'latest', 'firstLoss', 'manualDelivery']) || v.version !== 1 || !(v.binding === null || typeof v.binding === 'string' && /^[0-9a-f]{64}$/.test(v.binding)) || !isHardModeAssessment(v.opening) || !isHardModeAssessment(v.latest)
    || !(v.manualDelivery === null || typeof v.manualDelivery === 'boolean')) return false;
  return v.firstLoss === null || exact(v.firstLoss, ['atUtcMs', 'reason', 'rule', 'values']) && time(v.firstLoss.atUtcMs) && reasons.includes(v.firstLoss.reason)
    && v.firstLoss.reason !== 'compliant' && (v.firstLoss.rule === null || HARD_MODE_RULE_IDS.includes(v.firstLoss.rule as HardModeRuleId))
    && (v.firstLoss.values === null || Array.isArray(v.firstLoss.values) && v.firstLoss.values.length === (v.firstLoss.rule === 'parking' ? 2 : 1) && v.firstLoss.values.every((n: unknown) => n === null || typeof n === 'number' && Number.isFinite(n)));
}
export function isHardModeStatus(v: unknown): v is HardModeStatus {
  return exact(v, ['assessment', 'trip']) && isHardModeAssessment(v.assessment) && (v.trip === null || isHardModeDetails(v.trip));
}
export function isHardModeObservation(v: unknown): v is HardModeObservation {
  return exact(v, ['assessment', 'binding', 'pluginSessionId', 'sourceMonotonicNs']) && isHardModeAssessment(v.assessment)
    && (v.binding === null || typeof v.binding === 'string' && /^[0-9a-f]{64}$/.test(v.binding))
    && (v.pluginSessionId === null || typeof v.pluginSessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.pluginSessionId))
    && (v.sourceMonotonicNs === null || typeof v.sourceMonotonicNs === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v.sourceMonotonicNs) && BigInt(v.sourceMonotonicNs) <= 18446744073709551615n);
}
