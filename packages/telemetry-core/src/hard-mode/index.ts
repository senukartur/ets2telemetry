import type {HardModeAssessment, HardModeDetails, HardModeReason, HardModeRuleId} from '../../../contracts/src/hard-mode';
export const HARD_MODE_TOLERANCE = 1e-6;
export const HARD_MODE_RULES = [
  {id: 'fuel', label: 'Realistic fuel consumption', keys: ['g_fuel_simulation'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'air', label: 'Air brake simulation', keys: ['g_hardcore_simulation'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'police', label: 'Police offences and fines', keys: ['g_police'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'fatigue', label: 'Driver fatigue', keys: ['g_fatigue'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'limiter', label: 'Speed limiter', keys: ['g_use_speed_limiter'], required: '= 1', limit: 1, op: 'eq'},
  {id: 'truck', label: 'Truck stability', keys: ['g_truck_stability'], required: '≤ 0.5', limit: 0.5, op: 'max'},
  {id: 'trailer', label: 'Trailer stability', keys: ['g_trailer_stability'], required: '≤ 0.5', limit: 0.5, op: 'max'},
  {id: 'parking', label: 'Configured skilled parking', keys: ['g_simple_parking_doubles', 'g_parking_difficulty'], required: '= 0 and = 2; manual delivery required', limit: 0, op: 'parking'},
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
    const pass = !invalid && (rule.op === 'eq' ? value === rule.limit : rule.op === 'parking' ? value === 0 && values[1] === 2
      : rule.op === 'max' ? value <= rule.limit + HARD_MODE_TOLERANCE : value >= rule.limit - HARD_MODE_TOLERANCE);
    return {id: rule.id, state: invalid ? 'unknown' as const : pass ? 'pass' as const : 'fail' as const, values,
      reason: invalid?.reason ?? (pass ? 'compliant' as const : 'outside-limit' as const)};
  });
  return {observedUtcMs, source, rules, state: rules.some(r => r.state === 'unknown') ? 'unknown' : rules.every(r => r.state === 'pass') ? 'pass' : 'fail'};
}
export function unknownHardMode(at: number, reason: HardModeReason = 'source-unproven'): HardModeAssessment {
  return {observedUtcMs: at, state: 'unknown', source: 'unknown', rules: HARD_MODE_RULES.map(({id}) => ({id, state: 'unknown', values: id === 'parking' ? [null, null] : [null], reason}))};
}
export function advanceHardMode(previous: HardModeDetails | null, assessment: HardModeAssessment, loss?: HardModeReason): HardModeDetails {
  const failed = assessment.rules.find(r => r.state !== 'pass');
  const firstLoss = previous?.firstLoss ?? (loss || failed ? {atUtcMs: assessment.observedUtcMs, reason: loss ?? failed!.reason, rule: loss ? null : failed!.id, values: loss ? null : [...failed!.values]} : null);
  return {version: 1, binding: previous?.binding ?? null, opening: previous?.opening ?? assessment, latest: previous && previous.latest.observedUtcMs > assessment.observedUtcMs ? previous.latest : assessment, firstLoss, manualDelivery: previous?.manualDelivery ?? null};
}
export function hardModeLoss(details: HardModeDetails, atUtcMs: number, reason: HardModeReason, rule: HardModeRuleId | null = null): HardModeDetails {
  return {...details, firstLoss: details.firstLoss ?? {atUtcMs, reason, rule, values: rule ? details.latest.rules.find(r => r.id === rule)?.values ?? null : null}};
}
