// Persisted-settings evidence only. No paths, profile names or raw configuration crosses this contract.
export const HARD_MODE_RULE_IDS = ['fuel', 'air', 'police', 'fatigue', 'limiter', 'truck', 'trailer', 'parking', 'rain', 'events', 'braking', 'traffic'] as const;
export type HardModeRuleId = typeof HARD_MODE_RULE_IDS[number];
export type HardModeReason = 'compliant' | 'outside-limit' | 'missing' | 'malformed' | 'conflicting' | 'source-unproven' | 'interrupted' | 'historical' | 'source-changed' | 'parking-unproven';
export interface HardModeRule {id: HardModeRuleId; state: 'pass' | 'fail' | 'unknown'; values: (number | null)[]; reason: HardModeReason}
export interface HardModeAssessment {
  observedUtcMs: number; state: 'pass' | 'fail' | 'unknown'; source: 'local' | 'cloud' | 'fixture' | 'unknown'; rules: HardModeRule[];
}
export interface HardModeDetailsV1 {
  version: 1; binding: string | null; opening: HardModeAssessment; latest: HardModeAssessment;
  firstLoss: {atUtcMs: number; reason: HardModeReason; rule: HardModeRuleId | null; values: (number | null)[] | null} | null;
  manualDelivery: boolean | null;
}
export const HARD_MODE_DIAGNOSTIC_CODES = ['settings-changing', 'settings-unavailable', 'profile-verification', 'source-changed', 'guard-deadline', 'session-transition', 'storage-failure', 'rule-failed'] as const;
export type HardModeDiagnosticCode = typeof HARD_MODE_DIAGNOSTIC_CODES[number];
export interface HardModeDiagnostic {atUtcMs: number; code: HardModeDiagnosticCode; rule: HardModeRuleId | null; values: (number | null)[] | null}
export interface HardModeCounts {passingChecks: number; failingChecks: number; unknownChecks: number}
/** Cumulative producer totals scoped to one recording member. Retried checkpoints have no additional weight. */
export interface HardModeCheckBatch extends HardModeCounts {tripUuid: string; producer: string; sequence: number}
export interface HardModeDetailsV2 extends HardModeCounts {
  version: 2; binding: string | null; opening: HardModeAssessment; latest: HardModeAssessment;
  firstLoss: null; manualDelivery: null; checkpoint: HardModeCheckBatch | null;
  firstDiagnostic: HardModeDiagnostic | null; latestDiagnostic: HardModeDiagnostic | null;
}
export type HardModeDetails = HardModeDetailsV1 | HardModeDetailsV2;
/**
 * Why the current profile is or is not verified, in fixed words: `waiting` while no game is connected or a check is
 * still running, `unverified` when the profile check failed. Reader codes, paths and identities never cross.
 */
export const HARD_MODE_VERIFICATION_REASONS = ['no-game', 'checking', 'game-process', 'game-log', 'profile-selection', 'profile-files', 'settings-read', 'timeout'] as const;
export type HardModeVerificationReason = typeof HARD_MODE_VERIFICATION_REASONS[number];
export interface HardModeVerificationResult {state: 'verified' | 'waiting' | 'unverified'; reason: HardModeVerificationReason | null}
/** The current verification, whether a manual check runs now, and the result of the last completed manual check. */
export interface HardModeVerification extends HardModeVerificationResult {checking: boolean; lastCheck: (HardModeVerificationResult & {atUtcMs: number}) | null}
export interface HardModeStatus {assessment: HardModeAssessment; trip: HardModeDetails | null; verification: HardModeVerification}
// Internal evidence: digest binds process/session/profile/log generation without retaining names or absolute paths.
// Accumulated checks retain their source session even when current assessment proof becomes unavailable.
export interface HardModeObservation {assessment: HardModeAssessment; binding: string | null; pluginSessionId: string | null; sourceMonotonicNs: string | null; check?: {producer: string; sequence: number}; batch?: HardModeCheckBatch; batchSessionId?: string; diagnostic?: HardModeDiagnosticCode; member?: string; diagnostics?: HardModeDiagnostic[]}
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
function isHardModeDetailsV1(v: unknown): v is HardModeDetailsV1 {
  if (!exact(v, ['version', 'binding', 'opening', 'latest', 'firstLoss', 'manualDelivery']) || v.version !== 1 || !(v.binding === null || typeof v.binding === 'string' && /^[0-9a-f]{64}$/.test(v.binding)) || !isHardModeAssessment(v.opening) || !isHardModeAssessment(v.latest)
    || !(v.manualDelivery === null || typeof v.manualDelivery === 'boolean')) return false;
  return v.firstLoss === null || exact(v.firstLoss, ['atUtcMs', 'reason', 'rule', 'values']) && time(v.firstLoss.atUtcMs) && reasons.includes(v.firstLoss.reason)
    && v.firstLoss.reason !== 'compliant' && (v.firstLoss.rule === null || HARD_MODE_RULE_IDS.includes(v.firstLoss.rule as HardModeRuleId))
    && (v.firstLoss.values === null || Array.isArray(v.firstLoss.values) && v.firstLoss.values.length === (v.firstLoss.rule === 'parking' ? 2 : 1) && v.firstLoss.values.every((n: unknown) => n === null || typeof n === 'number' && Number.isFinite(n)));
}
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const counts = (v: Record<string, unknown>) => ['passingChecks', 'failingChecks', 'unknownChecks'].every(k => time(v[k]))
  && Number.isSafeInteger(Number(v.passingChecks) + Number(v.failingChecks) + Number(v.unknownChecks));
export function isHardModeCheckBatch(v: unknown): v is HardModeCheckBatch {
  return exact(v, ['tripUuid', 'producer', 'sequence', 'passingChecks', 'failingChecks', 'unknownChecks']) && uuid(v.tripUuid) && uuid(v.producer)
    && time(v.sequence) && Number(v.sequence) > 0 && counts(v) && v.sequence === Number(v.passingChecks) + Number(v.failingChecks) + Number(v.unknownChecks);
}
function diagnostic(v: unknown): v is HardModeDiagnostic | null {
  return v === null || exact(v, ['atUtcMs', 'code', 'rule', 'values']) && time(v.atUtcMs) && HARD_MODE_DIAGNOSTIC_CODES.includes(v.code as HardModeDiagnosticCode)
    && (v.rule === null || HARD_MODE_RULE_IDS.includes(v.rule as HardModeRuleId))
    && (v.values === null ? v.rule === null : v.rule !== null && Array.isArray(v.values) && v.values.length === (v.rule === 'parking' ? 2 : 1)
      && v.values.every((n: unknown) => n === null || typeof n === 'number' && Number.isFinite(n)));
}
export function isHardModeDetails(v: unknown): v is HardModeDetails {
  if (record(v) && v.version === 1) return isHardModeDetailsV1(v);
  return exact(v, ['version', 'binding', 'opening', 'latest', 'firstLoss', 'manualDelivery', 'passingChecks', 'failingChecks', 'unknownChecks', 'checkpoint', 'firstDiagnostic', 'latestDiagnostic'])
    && v.version === 2 && (v.binding === null || typeof v.binding === 'string' && /^[0-9a-f]{64}$/.test(v.binding))
    && isHardModeAssessment(v.opening) && isHardModeAssessment(v.latest) && v.firstLoss === null && v.manualDelivery === null && counts(v)
    && (v.checkpoint === null || isHardModeCheckBatch(v.checkpoint) && v.checkpoint.passingChecks <= Number(v.passingChecks)
      && v.checkpoint.failingChecks <= Number(v.failingChecks) && v.checkpoint.unknownChecks <= Number(v.unknownChecks))
    && diagnostic(v.firstDiagnostic) && diagnostic(v.latestDiagnostic) && (v.firstDiagnostic === null) === (v.latestDiagnostic === null);
}
/** Verified has no reason; waiting is no-game or checking; unverified names one of the six failure reasons. */
function verificationResult(v: Record<string, unknown>): boolean {
  if (v.state === 'verified') return v.reason === null;
  if (v.state === 'waiting') return v.reason === 'no-game' || v.reason === 'checking';
  return v.state === 'unverified' && HARD_MODE_VERIFICATION_REASONS.includes(v.reason as HardModeVerificationReason) && v.reason !== 'no-game' && v.reason !== 'checking';
}
export function isHardModeVerification(v: unknown): v is HardModeVerification {
  return exact(v, ['state', 'reason', 'checking', 'lastCheck']) && verificationResult(v) && typeof v.checking === 'boolean'
    && (v.lastCheck === null || exact(v.lastCheck, ['atUtcMs', 'state', 'reason']) && time(v.lastCheck.atUtcMs) && verificationResult(v.lastCheck));
}
/** Settings evidence is shown only from a verified profile, so a known assessment requires verified. */
export function isHardModeStatus(v: unknown): v is HardModeStatus {
  return exact(v, ['assessment', 'trip', 'verification']) && isHardModeAssessment(v.assessment) && (v.trip === null || isHardModeDetails(v.trip))
    && isHardModeVerification(v.verification) && (v.assessment.state === 'unknown' || v.verification.state === 'verified');
}
export function isHardModeObservation(v: unknown): v is HardModeObservation {
  return record(v) && exact(v, ['assessment', 'binding', 'pluginSessionId', 'sourceMonotonicNs', ...('check' in v ? ['check'] : []), ...('batch' in v ? ['batch'] : []), ...('batchSessionId' in v ? ['batchSessionId'] : []), ...('diagnostic' in v ? ['diagnostic'] : []), ...('member' in v ? ['member'] : []), ...('diagnostics' in v ? ['diagnostics'] : [])])
    && (!('check' in v) || exact(v.check, ['producer', 'sequence']) && uuid(v.check.producer) && time(v.check.sequence) && Number(v.check.sequence) > 0)
    && (!('diagnostics' in v) || Array.isArray(v.diagnostics) && v.diagnostics.length > 0 && v.diagnostics.length <= 2 && v.diagnostics.every(d => d !== null && diagnostic(d)))
    && (!('batchSessionId' in v) || uuid(v.batchSessionId) && 'batch' in v)
    && (!('member' in v) || uuid(v.member)) && (!('member' in v) || !('batch' in v) || record(v.batch) && v.batch.tripUuid === v.member) && (!('batch' in v) || isHardModeCheckBatch(v.batch)) && (!('diagnostic' in v) || HARD_MODE_DIAGNOSTIC_CODES.includes(v.diagnostic as HardModeDiagnosticCode)) && isHardModeAssessment(v.assessment)
    && (v.binding === null || typeof v.binding === 'string' && /^[0-9a-f]{64}$/.test(v.binding))
    && (v.pluginSessionId === null || typeof v.pluginSessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.pluginSessionId))
    && (v.sourceMonotonicNs === null || typeof v.sourceMonotonicNs === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v.sourceMonotonicNs) && BigInt(v.sourceMonotonicNs) <= 18446744073709551615n);
}
