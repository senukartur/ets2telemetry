import type {HardModeAssessment, HardModeDetails, HardModeDetailsV1, HardModeDetailsV2, HardModeCounts, HardModeObservation, HardModeDiagnostic, HardModeReason, HardModeRuleId} from '../../../contracts/src/hard-mode';
export const HARD_MODE_TOLERANCE = 1e-6;
export const HARD_MODE_RULES = [
  {id: 'fuel', label: 'Realistic fuel consumption', keys: ['g_fuel_simulation'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'air', label: 'Air brake simulation', keys: ['g_hardcore_simulation'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'police', label: 'Police offences and fines', keys: ['g_police'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'fatigue', label: 'Driver fatigue', keys: ['g_fatigue'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'limiter', label: 'Speed limiter', keys: ['g_use_speed_limiter'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'truck', label: 'Truck stability', keys: ['g_truck_stability'], required: '≤ 0.25', limit: 0.25, op: 'max'},
  {id: 'trailer', label: 'Trailer stability', keys: ['g_trailer_stability'], required: '≤ 0.25', limit: 0.25, op: 'max'},
  {id: 'parking', label: 'Configured Normal parking', keys: ['g_simple_parking_doubles', 'g_parking_difficulty'], required: '= 0 or 1 and = 2', limit: 0, op: 'parking'},
  {id: 'rain', label: 'Rain probability', keys: ['g_bad_weather_factor'], required: '≥ 0.12', limit: 0.12, op: 'min'},
  {id: 'events', label: 'Random road events', keys: ['g_road_events'], required: '≥ 0.30', limit: 0.30, op: 'min'},
  {id: 'braking', label: 'Braking intensity', keys: ['g_brake_intensity'], required: '≤ 0.75', limit: 0.75, op: 'max'},
  {id: 'traffic', label: 'Traffic density', keys: ['g_traffic'], required: '≥ 1.0', limit: 1, op: 'min'}
] as const;
export type ParsedSetting = {value: number | null; reason: 'compliant' | 'missing' | 'malformed' | 'conflicting'};
export type ParsedSettings = Readonly<Record<string, ParsedSetting>>;
const KEYS = new Set<string>(HARD_MODE_RULES.flatMap(r => [...r.keys]));
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
/** Only allowlisted directives are retained. Malformed relevant lines cannot be hidden by a later valid duplicate. */
export function parseHardModeConfig(text: string): ParsedSettings {
  const result: Record<string, ParsedSetting> = {};
  if (text.length > 256 * 1024 || new TextEncoder().encode(text).byteLength > 256 * 1024 || text.split(/\r?\n/).some(line => line.length > 8192)) return Object.fromEntries([...KEYS].map(k => [k, {value: null, reason: 'malformed'}]));
  for (const line of text.split(/\r?\n/)) {
    const key = /^\s*uset\s+([^\s]+)/.exec(line)?.[1];
    if (!key || !KEYS.has(key)) continue;
    const match = line.length <= 8192 ? /^\s*uset\s+[^\s]+\s+"([^"]*)"\s*(?:(?:#|\/\/).*)?$/.exec(line) : null;
    const number = match && NUMBER.test(match[1]) ? Number(match[1]) : NaN;
    const setting: ParsedSetting = Number.isFinite(number) ? {value: number, reason: 'compliant'} : {value: null, reason: 'malformed'};
    const old = result[key];
    if (!old) result[key] = setting;
    else if (old.reason !== 'compliant' || setting.reason !== 'compliant' || old.value !== setting.value) result[key] = {value: null, reason: old.reason === 'malformed' || setting.reason === 'malformed' ? 'malformed' : 'conflicting'};
  }
  return result;
}
export function evaluateHardMode(settings: ParsedSettings, observedUtcMs: number, source: HardModeAssessment['source']): HardModeAssessment {
  const rules = HARD_MODE_RULES.map(rule => {
    const fields = rule.keys.map(k => settings[k] ?? {value: null, reason: 'missing' as const}), values = fields.map(f => f.value);
    const invalid = fields.find(f => f.reason !== 'compliant');
    const value = values[0]!;
    const pass = !invalid && (rule.op === 'eq' ? value === rule.limit : rule.op === 'parking' ? (value === 0 || value === 1) && values[1] === 2
      : rule.op === 'max' ? value <= rule.limit + HARD_MODE_TOLERANCE : value >= rule.limit - HARD_MODE_TOLERANCE);
    return {id: rule.id, state: invalid ? 'unknown' as const : pass ? 'pass' as const : 'fail' as const, values,
      reason: invalid?.reason ?? (pass ? 'compliant' as const : 'outside-limit' as const)};
  });
  return {observedUtcMs, source, rules, state: rules.some(r => r.state === 'unknown') ? 'unknown' : rules.every(r => r.state === 'pass') ? 'pass' : 'fail'};
}
export function unknownHardMode(at: number, reason: HardModeReason = 'source-unproven'): HardModeAssessment {
  return {observedUtcMs: at, state: 'unknown', source: 'unknown', rules: HARD_MODE_RULES.map(({id}) => ({id, state: 'unknown', values: id === 'parking' ? [null, null] : [null], reason}))};
}
/** Ordered observer offers replace latest; queued intake reapplication only latches loss, independently of UTC labels. */
export function advanceHardMode(previous: HardModeDetailsV1 | null, assessment: HardModeAssessment, loss?: HardModeReason, latest?: 'publication' | 'frozen'): HardModeDetailsV1;
export function advanceHardMode(previous: HardModeDetails, assessment: HardModeAssessment, loss?: HardModeReason, latest?: 'publication' | 'frozen'): HardModeDetails;
export function advanceHardMode(previous: HardModeDetails | null, assessment: HardModeAssessment, loss?: HardModeReason, latest: 'publication' | 'frozen' = 'publication'): HardModeDetails {
  if (previous?.version === 2) return advanceHardModeV2(previous, {assessment, binding: previous.binding, pluginSessionId: null, sourceMonotonicNs: null}, latest);
  const failed = assessment.rules.find(r => r.state !== 'pass');
  const firstLoss = previous?.firstLoss ?? (loss || failed ? {atUtcMs: assessment.observedUtcMs, reason: loss ?? failed!.reason, rule: loss ? null : failed!.id, values: loss ? null : [...failed!.values]} : null);
  return {version: 1, binding: previous?.binding ?? null, opening: previous?.opening ?? assessment, latest: previous && latest === 'frozen' ? previous.latest : assessment, firstLoss, manualDelivery: previous?.manualDelivery ?? null};
}
export function hardModeLoss(details: HardModeDetailsV1, atUtcMs: number, reason: HardModeReason, rule: HardModeRuleId | null = null): HardModeDetailsV1 {
  return {...details, firstLoss: details.firstLoss ?? {atUtcMs, reason, rule, values: rule ? details.latest.rules.find(r => r.id === rule)?.values ?? null : null}};
}

export const emptyHardModeCounts = (): HardModeCounts => ({passingChecks: 0, failingChecks: 0, unknownChecks: 0});
/** Integer arithmetic keeps the inclusive threshold exact even near the safe counter limit. */
export function qualifiesHardMode(counts: HardModeCounts, delivered = true): boolean {
  const known = BigInt(counts.passingChecks) + BigInt(counts.failingChecks);
  return delivered && known > 0n && BigInt(counts.passingChecks) * 100n >= known * 95n;
}
export function deriveTripHardModeResult(isHardMode: boolean): 'qualified' | 'not-qualified' {
  return isHardMode ? 'qualified' : 'not-qualified';
}
export function newHardModeDetails(assessment: HardModeAssessment, binding: string | null): HardModeDetailsV2 {
  return {version: 2, binding, opening: assessment, latest: assessment, firstLoss: null, manualDelivery: null, ...emptyHardModeCounts(), checkpoint: null, firstDiagnostic: null, latestDiagnostic: null};
}
/** Publications update diagnostics; only a designated cumulative batch changes the sampling counts. */
export function advanceHardModeV2(previous: HardModeDetailsV2, observation: HardModeObservation, latest: 'publication' | 'frozen' = 'publication'): HardModeDetailsV2 {
  const next = {...previous, latest: latest === 'publication' ? observation.assessment : previous.latest};
  const ownDiagnostic = hardModeDiagnostic(observation, previous.binding);
  const diagnostics = observation.diagnostics ?? (ownDiagnostic ? [ownDiagnostic] : []);
  if (diagnostics.length) {next.firstDiagnostic ??= diagnostics[0]; if (latest === 'publication' || !next.latestDiagnostic) next.latestDiagnostic = diagnostics[diagnostics.length - 1];}
  const batch = observation.batch, checkpoint = previous.checkpoint;
  if (batch && (checkpoint?.producer !== batch.producer || batch.sequence > checkpoint.sequence)) {
    const before = checkpoint?.producer === batch.producer ? checkpoint : emptyHardModeCounts();
    for (const key of ['passingChecks', 'failingChecks', 'unknownChecks'] as const) {
      if (batch[key] < before[key] || !Number.isSafeInteger(next[key] + batch[key] - before[key])) throw new Error('Invalid Hard Mode checkpoint');
      next[key] += batch[key] - before[key];
    }
    if (!Number.isSafeInteger(next.passingChecks + next.failingChecks + next.unknownChecks)) throw new Error('Hard Mode counter bound');
    next.checkpoint = {...batch};
  }
  return next;
}

export function hardModeDiagnostic(observation: HardModeObservation, binding: string | null = null): HardModeDiagnostic | null {
  const failed = observation.assessment.rules.find(r => r.state === 'fail');
  const code = observation.diagnostic ?? (observation.assessment.state === 'fail' ? 'rule-failed' : observation.assessment.state === 'unknown' ? 'settings-unavailable'
    : binding !== null && observation.binding !== null && binding !== observation.binding ? 'source-changed' : undefined);
  return code ? {atUtcMs: observation.assessment.observedUtcMs, code, rule: failed?.id ?? null, values: failed ? [...failed.values] : null} : null;
}
