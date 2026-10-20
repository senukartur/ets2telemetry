import type {AppLanguage} from './types';

const MINUTES_PER_DAY = 1440n;
const pad2 = (value: bigint | number) => value.toString().padStart(2, '0');

export const MONTHS: Readonly<Record<AppLanguage, readonly string[]>> = Object.freeze({
  en: Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
  ru: Object.freeze(['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'])
});

/**
 * Replaces `{name}` placeholders with values from `vars`.
 * Unmatched placeholders are preserved as `{name}`.
 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match));
}

/**
 * Formats a Date using the language's month names and order:
 * EN: "Oct 15, 09:14"
 * RU: "15 окт, 09:14"
 */
export function formatLocalizedDate(date: Date, language: AppLanguage): string {
  const month = MONTHS[language][date.getMonth()];
  const day = date.getDate();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return language === 'ru' ? `${day} ${month}, ${time}` : `${month} ${day}, ${time}`;
}

/**
 * Formats game minutes since simulation start:
 * EN: "Day N, HH:MM"
 * RU: "День N, HH:MM"
 */
export function formatLocalizedGameTime(minutes: bigint, language: AppLanguage): string {
  if (minutes < 0n) throw new RangeError('Game time cannot be negative');
  const day = (minutes / MINUTES_PER_DAY + 1n).toString();
  const minuteOfDay = minutes % MINUTES_PER_DAY;
  const time = `${pad2(minuteOfDay / 60n)}:${pad2(minuteOfDay % 60n)}`;
  const label = language === 'ru' ? 'День' : 'Day';
  return `${label} ${day}, ${time}`;
}

/**
 * Formats game-time span:
 * EN: "H h M min" or "M min"
 * RU: "H ч M мин" or "M мин"
 */
export function formatLocalizedGameDuration(minutes: bigint, language: AppLanguage): string {
  const span = minutes < 0n ? -minutes : minutes;
  const hours = span / 60n, rest = span % 60n;
  const hUnit = language === 'ru' ? 'ч' : 'h';
  const mUnit = language === 'ru' ? 'мин' : 'min';
  return hours > 0n ? `${hours.toString()} ${hUnit} ${rest.toString()} ${mUnit}` : `${rest.toString()} ${mUnit}`;
}

/**
 * Formats deadline:
 * EN: "in …" / "late by …"
 * RU: "через …" / "опоздание на …"
 */
export function formatLocalizedDeadline(remainingMinutes: bigint, language: AppLanguage): string {
  const duration = formatLocalizedGameDuration(remainingMinutes, language);
  if (remainingMinutes < 0n) {
    return language === 'ru' ? `опоздание на ${duration}` : `late by ${duration}`;
  }
  return language === 'ru' ? `через ${duration}` : `in ${duration}`;
}

/**
 * Formats boolean:
 * EN: "yes" / "no"
 * RU: "да" / "нет"
 */
export function formatLocalizedBoolean(value: boolean, language: AppLanguage): string {
  if (language === 'ru') return value ? 'да' : 'нет';
  return value ? 'yes' : 'no';
}
