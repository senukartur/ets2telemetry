import type {AppLanguage, I18nKey, TranslationDictionary} from './types';
import {EN_DICTIONARY} from './en';
import {RU_DICTIONARY} from './ru';
import {interpolate} from './format';

export * from './types';
export * from './format';
export {EN_DICTIONARY} from './en';
export {RU_DICTIONARY} from './ru';

export const I18N_DICTIONARIES: Readonly<Record<AppLanguage, TranslationDictionary>> = Object.freeze({
  en: EN_DICTIONARY,
  ru: RU_DICTIONARY
});

let activeLanguage: AppLanguage = 'en';

export function getActiveLanguage(): AppLanguage {
  return activeLanguage;
}

export function setActiveLanguage(language: AppLanguage): void {
  activeLanguage = language;
}

export function getDictionary(language: AppLanguage = activeLanguage): TranslationDictionary {
  return I18N_DICTIONARIES[language] ?? EN_DICTIONARY;
}

/**
 * Returns the translated string for `key` in `language`, interpolating `{var}` parameters if given.
 * Falls back to English if the key is missing in the chosen language, or `⟦key⟧` if missing completely.
 */
export function t(key: I18nKey, vars?: Record<string, string | number>, language: AppLanguage = activeLanguage): string {
  const dict = I18N_DICTIONARIES[language] ?? EN_DICTIONARY;
  const template = dict[key] ?? EN_DICTIONARY[key];
  if (template === undefined) return `⟦${key}⟧`;
  return interpolate(template, vars);
}

const UNIT_MAP: Readonly<Record<string, I18nKey>> = Object.freeze({
  'km/h': 'u.kmh',
  'mph': 'u.mph',
  'L': 'u.l',
  'gal': 'u.gal',
  'km': 'u.km',
  'mi': 'u.mi',
  'rpm': 'u.rpm',
  't': 'u.t',
  'lb': 'u.lb',
  'L/100 km': 'u.l100',
  'mpg': 'u.mpg'
});

/**
 * Translates a unit such as 'km/h' or key 'kmh' -> localized string ('км/ч' in Russian).
 */
export function translateUnit(unit: string, language: AppLanguage = activeLanguage): string {
  const mappedKey = UNIT_MAP[unit] ?? (unit.startsWith('u.') ? (unit as I18nKey) : (`u.${unit}` as I18nKey));
  const translated = t(mappedKey, undefined, language);
  return translated.startsWith('⟦') ? unit : translated;
}
