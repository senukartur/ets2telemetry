import {describe, expect, it} from 'vitest';
import {JOURNAL_GAME_MODE_TEXT, PLUGIN_REASON_TEXT, UNINSTALL_REASON_TEXT} from '../../apps/desktop/src/strings';
import {t} from '../../apps/desktop/src/i18n';

describe('ET-062 HaulMP strings and localization', () => {
  it('declares HaulMP in JOURNAL_GAME_MODE_TEXT', () => {
    expect(JOURNAL_GAME_MODE_TEXT.haulmp).toBe('HaulMP');
    expect(JOURNAL_GAME_MODE_TEXT.truckersmp).toBe('TruckersMP');
    expect(JOURNAL_GAME_MODE_TEXT['single-player']).toBe('Single-player');
    expect(JOURNAL_GAME_MODE_TEXT.unknown).toBe('Unknown');
    expect(JOURNAL_GAME_MODE_TEXT.convoy).toBe('Convoy');
  });

  it('declares HAULMP_RUNNING blocking text in PLUGIN_REASON_TEXT and UNINSTALL_REASON_TEXT', () => {
    expect(PLUGIN_REASON_TEXT.HAULMP_RUNNING).toBe('HaulMP is running; the plugin is changed after you close it.');
    expect(UNINSTALL_REASON_TEXT.HAULMP_RUNNING).toBe('HaulMP is running. Close it, then try again.');
  });

  it('provides English and Russian translations for HaulMP copy keys', () => {
    expect(t('mode.haulmp', undefined, 'en')).toBe('HaulMP');
    expect(t('mode.haulmp', undefined, 'ru')).toBe('HaulMP');

    expect(t('copy.haulmp-is-running-the-plugin-is-changed-after-you-close-it', undefined, 'en')).toBe('HaulMP is running; the plugin is changed after you close it.');
    expect(t('copy.haulmp-is-running-the-plugin-is-changed-after-you-close-it', undefined, 'ru')).toBe('HaulMP запущен; плагин будет изменён после его закрытия.');

    expect(t('copy.haulmp-is-running-close-it-then-try-again', undefined, 'en')).toBe('HaulMP is running. Close it, then try again.');
    expect(t('copy.haulmp-is-running-close-it-then-try-again', undefined, 'ru')).toBe('HaulMP запущен. Закройте его и повторите.');
  });
});
