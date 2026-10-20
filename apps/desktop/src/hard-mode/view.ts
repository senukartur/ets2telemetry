import type {HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {HARD_MODE_RULES} from '../../../../packages/telemetry-core/src/hard-mode';
const BOOLEANS = ['fuel', 'air', 'police', 'fatigue', 'limiter'];
const valueText = (id: string, value: number | null, index: number): string => value === null ? 'Unknown' : BOOLEANS.includes(id) || id === 'parking' && index === 0
  ? `${value === 1 ? 'On' : value === 0 ? 'Off' : 'Invalid boolean'} (${value})` : id === 'parking' ? `${value === 2 ? 'Skilled' : 'Other difficulty'} (${value})` : `${Number((value * 100).toFixed(6))}% (${value})`;
const requiredText = (rule: typeof HARD_MODE_RULES[number]): string => rule.op === 'eq' ? 'On (1)' : rule.op === 'parking' ? 'Off (0) and skilled (2); manual delivery required'
  : `${rule.op === 'max' ? '≤' : '≥'} ${rule.limit * 100}% (${rule.limit})`;
export const HARD_MODE_NOTICE = 'Checks observe persisted settings. Unpersisted menu or console changes and transient changes between checks are not verified. Manual delivery is required; actual Expert placement is not verified.';
export function hardModeView(status: HardModeStatus, nowUtcMs: number) {
  const a = status.assessment, passed = a.rules.filter(r => r.state === 'pass').length, lost = status.trip?.firstLoss;
  return {headline: lost ? 'Hard Mode lost for this trip' : a.state === 'pass' ? 'Hard Mode settings active' : a.state === 'unknown' ? 'Hard Mode unknown' : 'Hard Mode not active', passed,
    source: {local: 'Local profile', cloud: 'Steam Cloud profile', fixture: 'Synthetic / replay settings', unknown: 'Source unproven'}[a.source],
    age: `${Math.max(0, Math.floor((nowUtcMs - a.observedUtcMs) / 1000))} s since observation`,
    loss: lost ? `${lost.rule ? HARD_MODE_RULES.find(r => r.id === lost.rule)?.label ?? lost.rule : 'Evidence'}: ${lost.reason}${lost.values ? `; detected ${lost.values.map(v => v === null ? 'Unknown' : String(v)).join(' / ')}` : '; detected Unknown'} at ${new Date(lost.atUtcMs).toISOString()}. Qualification cannot be restored for this trip.` : null,
    rows: a.rules.map((rule, i) => ({...rule, label: HARD_MODE_RULES[i].label, keys: HARD_MODE_RULES[i].keys.join(' + '), required: requiredText(HARD_MODE_RULES[i]),
      detected: rule.values.map((v, index) => valueText(rule.id, v, index)).join(' / ')}))};
}
