import {describe, expect, it} from 'vitest';
import {EN_DICTIONARY} from '../../apps/desktop/src/i18n/en';
import {RU_DICTIONARY} from '../../apps/desktop/src/i18n/ru';
import {formatLocalizedBoolean, formatLocalizedDate, formatLocalizedDeadline, formatLocalizedGameDuration, formatLocalizedGameTime, interpolate, t} from '../../apps/desktop/src/i18n';
import type {I18nKey} from '../../apps/desktop/src/i18n/types';

describe('i18n dictionary completeness and parity', () => {
  const enKeys = Object.keys(EN_DICTIONARY) as I18nKey[];
  const ruKeys = Object.keys(RU_DICTIONARY) as I18nKey[];

  it('every English key exists in the Russian dictionary', () => {
    for (const key of enKeys) {
      expect(RU_DICTIONARY[key], `Missing Russian translation for key: ${key}`).toBeDefined();
      expect(RU_DICTIONARY[key].trim().length, `Empty Russian translation for key: ${key}`).toBeGreaterThan(0);
    }
  });

  it('every Russian key exists in the English dictionary', () => {
    for (const key of ruKeys) {
      expect(EN_DICTIONARY[key], `Missing English translation for key: ${key}`).toBeDefined();
      expect(EN_DICTIONARY[key].trim().length, `Empty English translation for key: ${key}`).toBeGreaterThan(0);
    }
  });

  it('both dictionaries have the exact same count of keys', () => {
    expect(enKeys.length).toBe(ruKeys.length);
  });

  it('placeholder variables match between English and Russian for every key', () => {
    const extractPlaceholders = (text: string) => {
      const matches = text.match(/\{(\w+)\}/g) ?? [];
      return [...matches].sort();
    };

    for (const key of enKeys) {
      const enVars = extractPlaceholders(EN_DICTIONARY[key]);
      const ruVars = extractPlaceholders(RU_DICTIONARY[key]);
      expect(ruVars, `Placeholders mismatch for key: ${key}`).toEqual(enVars);
    }
  });

  it('t() interpolates variables in both languages correctly', () => {
    expect(t('chip.plugin', {n: 2, m: 2}, 'en')).toBe('Plugin 2/2');
    expect(t('chip.plugin', {n: 2, m: 2}, 'ru')).toBe('Плагин 2/2');

    expect(t('live.planned', {v: '120 km'}, 'en')).toBe('planned 120 km');
    expect(t('live.planned', {v: '120 км'}, 'ru')).toBe('по заказу 120 км');
  });

  it('interpolate preserves unmatched placeholders', () => {
    expect(interpolate('Hello {name}, {missing}', {name: 'Driver'})).toBe('Hello Driver, {missing}');
  });

  it('formats dates in both languages according to spec', () => {
    const date = new Date(2026, 9, 15, 9, 14); // Oct 15, 2026, 09:14
    expect(formatLocalizedDate(date, 'en')).toBe('Oct 15, 09:14');
    expect(formatLocalizedDate(date, 'ru')).toBe('15 окт, 09:14');
  });

  it('formats game time in both languages', () => {
    expect(formatLocalizedGameTime(0n, 'en')).toBe('Day 1, 00:00');
    expect(formatLocalizedGameTime(0n, 'ru')).toBe('День 1, 00:00');
    expect(formatLocalizedGameTime(1440n + 540n, 'en')).toBe('Day 2, 09:00');
    expect(formatLocalizedGameTime(1440n + 540n, 'ru')).toBe('День 2, 09:00');
  });

  it('formats game duration in both languages', () => {
    expect(formatLocalizedGameDuration(45n, 'en')).toBe('45 min');
    expect(formatLocalizedGameDuration(45n, 'ru')).toBe('45 мин');
    expect(formatLocalizedGameDuration(125n, 'en')).toBe('2 h 5 min');
    expect(formatLocalizedGameDuration(125n, 'ru')).toBe('2 ч 5 мин');
  });

  it('formats deadlines in both languages', () => {
    expect(formatLocalizedDeadline(90n, 'en')).toBe('in 1 h 30 min');
    expect(formatLocalizedDeadline(90n, 'ru')).toBe('через 1 ч 30 мин');
    expect(formatLocalizedDeadline(-15n, 'en')).toBe('late by 15 min');
    expect(formatLocalizedDeadline(-15n, 'ru')).toBe('опоздание на 15 мин');
  });

  it('formats boolean values in both languages', () => {
    expect(formatLocalizedBoolean(true, 'en')).toBe('yes');
    expect(formatLocalizedBoolean(false, 'en')).toBe('no');
    expect(formatLocalizedBoolean(true, 'ru')).toBe('да');
    expect(formatLocalizedBoolean(false, 'ru')).toBe('нет');
  });
});
