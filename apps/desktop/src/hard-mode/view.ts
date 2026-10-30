import type {HardModeDetails, HardModeReason, HardModeRuleId, HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {HARD_MODE_RULES} from '../../../../packages/telemetry-core/src/hard-mode';
import {t, type AppLanguage, type I18nKey} from '../i18n';
const LABEL_KEYS: Record<HardModeRuleId, I18nKey> = {fuel: 'hm.c.fuel', air: 'hm.c.airbrake', police: 'hm.c.police', fatigue: 'hm.c.fatigue', limiter: 'hm.c.limiter', truck: 'hm.c.truckstab', trailer: 'hm.c.trailerstab', parking: 'hm.c.parking', rain: 'hm.c.rain', events: 'hm.c.events', braking: 'hm.c.brake', traffic: 'hm.c.traffic'};
export const hardModeState = (state: 'pass' | 'fail' | 'unknown', language: AppLanguage) => t(`hm.state.${state}`, undefined, language);
export const hardModeReason = (reason: HardModeReason, language: AppLanguage) => t(`hm.reason.${reason}`, undefined, language);
export function hardModeLossText(lost: NonNullable<HardModeDetails['firstLoss']>, language: AppLanguage): string {
  return t('hm.loss', {setting: t(lost.rule ? LABEL_KEYS[lost.rule] : 'hm.evidence', undefined, language), reason: hardModeReason(lost.reason, language),
    value: lost.values?.map(v => v === null ? t('hm.value.unknown', undefined, language) : String(v)).join(' / ') ?? t('hm.value.unknown', undefined, language), time: new Date(lost.atUtcMs).toISOString()}, language);
}
const BOOLEANS = ['fuel', 'air', 'police', 'fatigue', 'limiter'];
/** A setting value; `raw` adds the config value in parentheses (the tooltip), without it the text is the short inline form. */
const valueText = (id: string, value: number | null, index: number, language: AppLanguage, raw = true): string => {
  if (value === null) return t('hm.value.unknown', undefined, language);
  const suffix = raw ? ` (${value})` : '';
  return BOOLEANS.includes(id) || id === 'parking' && index === 0 ? `${t(value === 1 ? 'val.on' : value === 0 ? 'val.off' : 'hm.value.invalid', undefined, language)}${suffix}`
    : id === 'parking' ? `${t(value === 2 ? 'hm.value.skilled' : 'hm.value.other', undefined, language)}${suffix}` : `${Number((value * 100).toFixed(6))}%${suffix}`;
};
const requiredText = (rule: typeof HARD_MODE_RULES[number], language: AppLanguage, raw = true): string => rule.op === 'eq' ? `${t('val.on', undefined, language)}${raw ? ' (1)' : ''}`
  : rule.op === 'parking' ? t(raw ? 'hm.required.parking' : 'hm.required.parkingShort', undefined, language) : `${rule.op === 'max' ? '≤' : '≥'} ${rule.limit * 100}%${raw ? ` (${rule.limit})` : ''}`;
export function hardModeView(status: HardModeStatus, nowUtcMs: number, language: AppLanguage = 'en') {
  const a = status.assessment, passed = a.rules.filter(r => r.state === 'pass').length, lost = status.trip?.firstLoss;
  return {headline: t(lost ? 'hm.status.lost' : `hm.status.${a.state}`, undefined, language), passed,
    source: t(`hm.source.${a.source}`, undefined, language), age: t('hm.age', {s: Math.max(0, Math.floor((nowUtcMs - a.observedUtcMs) / 1000))}, language),
    loss: lost ? hardModeLossText(lost, language) : null,
    rows: a.rules.map((rule, i) => ({...rule, stateText: hardModeState(rule.state, language), reason: hardModeReason(rule.reason, language), label: t(LABEL_KEYS[rule.id], undefined, language), keys: HARD_MODE_RULES[i].keys.join(' + '), required: requiredText(HARD_MODE_RULES[i], language),
      detected: rule.values.map((v, index) => valueText(rule.id, v, index, language)).join(' / '),
      inline: t('hm.now', {detected: rule.values.map((v, index) => valueText(rule.id, v, index, language, false)).join(' / '), required: requiredText(HARD_MODE_RULES[i], language, false)}, language)}))};
}
