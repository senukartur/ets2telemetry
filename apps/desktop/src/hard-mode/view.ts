import type {HardModeDetails, HardModeDetailsV2, HardModeDiagnostic, HardModeReason, HardModeRuleId, HardModeStatus, HardModeVerification, HardModeVerificationResult} from '../../../../packages/contracts/src/hard-mode';
import {HARD_MODE_RULES} from '../../../../packages/telemetry-core/src/hard-mode';
import {t, type AppLanguage, type I18nKey} from '../i18n';
const LABEL_KEYS: Record<HardModeRuleId, I18nKey> = {fuel: 'hm.c.fuel', air: 'hm.c.airbrake', police: 'hm.c.police', fatigue: 'hm.c.fatigue', limiter: 'hm.c.limiter', truck: 'hm.c.truckstab', trailer: 'hm.c.trailerstab', parking: 'hm.c.parking', rain: 'hm.c.rain', events: 'hm.c.events', braking: 'hm.c.brake', traffic: 'hm.c.traffic'};
export const hardModeState = (state: 'pass' | 'fail' | 'unknown', language: AppLanguage) => t(`hm.state.${state}`, undefined, language);
export const hardModeReason = (reason: HardModeReason, language: AppLanguage) => t(`hm.reason.${reason}`, undefined, language);
export function hardModeLossText(lost: NonNullable<HardModeDetails['firstLoss']>, language: AppLanguage): string {
  return t('hm.loss', {setting: t(lost.rule ? LABEL_KEYS[lost.rule] : 'hm.evidence', undefined, language), reason: hardModeReason(lost.reason, language),
    value: lost.values?.map(v => v === null ? t('hm.value.unknown', undefined, language) : String(v)).join(' / ') ?? t('hm.value.unknown', undefined, language), time: new Date(lost.atUtcMs).toISOString()}, language);
}
export function hardModeRatioText(details: HardModeDetailsV2, language: AppLanguage): string {
  const known = details.passingChecks + details.failingChecks;
  return t('hm.ratio', {pass: details.passingChecks, known, percent: known ? Number(BigInt(details.passingChecks) * 10000n / BigInt(known)) / 100 : '—', unknown: details.unknownChecks}, language);
}
export function hardModeDiagnosticText(diagnostic: HardModeDiagnostic, language: AppLanguage): string {
  return `${t(`hm.diagnostic.${diagnostic.code}`, undefined, language)} · ${new Date(diagnostic.atUtcMs).toISOString()}${diagnostic.rule ? ` · ${t(LABEL_KEYS[diagnostic.rule], undefined, language)}: ${diagnostic.values?.map(v => v ?? '—').join(' / ')}` : ''}`;
}
const BOOLEANS = ['fuel', 'air', 'police', 'fatigue', 'limiter'];
const percentScale = (id: string) => id === 'truck' || id === 'trailer' ? 200 : 100;
/** A setting value; `raw` adds the config value in parentheses (the tooltip), without it the text is the short inline form. */
const valueText = (id: string, value: number | null, index: number, language: AppLanguage, raw = true): string => {
  if (value === null) return t('hm.value.unknown', undefined, language);
  const suffix = raw ? ` (${value})` : '';
  return id === 'parking' && index === 0 ? `${t('hm.value.simpleDoubles', {value: t(value === 1 ? 'val.on' : value === 0 ? 'val.off' : 'hm.value.invalid', undefined, language)}, language)}${suffix}`
    : BOOLEANS.includes(id) ? `${t(value === 1 ? 'val.on' : value === 0 ? 'val.off' : 'hm.value.invalid', undefined, language)}${suffix}`
    : id === 'parking' ? `${t(value === 2 ? 'hm.value.normal' : 'hm.value.other', undefined, language)}${suffix}` : `${Number((value * percentScale(id)).toFixed(6))}%${suffix}`;
};
const requiredText = (rule: typeof HARD_MODE_RULES[number], language: AppLanguage, raw = true): string => rule.op === 'eq' ? `${t('val.on', undefined, language)}${raw ? ' (1)' : ''}`
  : rule.op === 'parking' ? t(raw ? 'hm.required.parking' : 'hm.required.parkingShort', undefined, language) : `${rule.op === 'max' ? '≤' : '≥'} ${rule.limit * percentScale(rule.id)}%${raw ? ` (${rule.limit})` : ''}`;
/** One verification result in words: verified, the waiting text, or "Unable to verify profile" with its reason. */
export function hardModeVerificationText(result: HardModeVerificationResult, language: AppLanguage, separator = ': '): string {
  if (result.state === 'verified') return t('hm.verify.verified', undefined, language);
  const reason = t(`hm.verify.reason.${result.reason ?? 'no-game'}`, undefined, language);
  return result.state === 'waiting' ? reason : `${t('hm.verify.unverified', undefined, language)}${separator}${reason}`;
}
/**
 * ET-112d: the verification parts of the page. `headline` replaces the unknown headline while the profile is not verified,
 * `line` explains an unverified profile, and `checkResult` is the last completed manual check. A status without
 * verification (the chip and older callers) has none of them.
 */
function verificationView(verification: HardModeVerification | undefined, nowUtcMs: number, language: AppLanguage) {
  if (!verification) return {headline: null, line: null, checkResult: null};
  const headline = verification.state === 'verified' ? null : verification.state === 'unverified' ? t('hm.verify.unverified', undefined, language)
    : t(`hm.verify.reason.${verification.reason ?? 'no-game'}`, undefined, language);
  const last = verification.lastCheck;
  return {headline, line: verification.state === 'unverified' ? hardModeVerificationText(verification, language) : null,
    checkResult: last && !verification.checking ? t('hm.check.result', {s: Math.max(0, Math.floor((nowUtcMs - last.atUtcMs) / 1000)), result: hardModeVerificationText(last, language, ' — ')}, language) : null};
}
export function hardModeView(status: Pick<HardModeStatus, 'assessment' | 'trip'> & Partial<Pick<HardModeStatus, 'verification'>>, nowUtcMs: number, language: AppLanguage = 'en') {
  const a = status.assessment, passed = a.rules.filter(r => r.state === 'pass').length, lost = status.trip?.version === 1 ? status.trip.firstLoss : null;
  const audit = status.trip?.version === 2 ? status.trip : null;
  return {verification: verificationView(status.verification, nowUtcMs, language), ratio: audit ? hardModeRatioText(audit, language) : null, diagnostic: audit?.latestDiagnostic ? hardModeDiagnosticText(audit.latestDiagnostic, language) : null, headline: t(lost ? 'hm.status.lost' : `hm.status.${a.state}`, undefined, language), passed,
    source: t(`hm.source.${a.source}`, undefined, language), age: t('hm.age', {s: Math.max(0, Math.floor((nowUtcMs - a.observedUtcMs) / 1000))}, language),
    loss: lost ? hardModeLossText(lost, language) : null,
    rows: a.rules.map((rule, i) => ({...rule, stateText: hardModeState(rule.state, language), reason: hardModeReason(rule.reason, language), label: t(LABEL_KEYS[rule.id], undefined, language), keys: HARD_MODE_RULES[i].keys.join(' + '), required: requiredText(HARD_MODE_RULES[i], language),
      detected: rule.values.map((v, index) => valueText(rule.id, v, index, language)).join(' / '),
      inline: t('hm.now', {detected: rule.values.map((v, index) => valueText(rule.id, v, index, language, false)).join(' / '), required: requiredText(HARD_MODE_RULES[i], language, false)}, language)}))};
}
