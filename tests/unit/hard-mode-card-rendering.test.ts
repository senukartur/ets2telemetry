import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {HardModeCard} from '../../apps/desktop/src/hard-mode/card';
import type {HardModeController} from '../../apps/desktop/src/hard-mode/use-status';
import type {HardModeDetailsV1, HardModeVerification} from '../../packages/contracts/src/hard-mode';
import {evaluateHardMode, newHardModeDetails, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

/** The profile was verified; an unknown rule then means missing settings, not an unverified profile. */
const VERIFIED: HardModeVerification = {state: 'verified', reason: null, checking: false, lastCheck: null};
const makeController = (overrides?: Partial<HardModeController>): HardModeController => ({
  status: {
    assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture'),
    trip: null,
    verification: VERIFIED,
  },
  now: 1000,
  busy: false,
  error: false,
  loaded: true,
  check: () => undefined,
  ...overrides,
});

describe('HardModeCard rendering (REG-009, REG-010)', () => {
  it('renders active state with badge-ok, 12 of 12 progress, and all rows passing in EN and RU', () => {
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController(),
        })
      );
      expect(html).toContain('data-testid="hard-mode-card"');
      expect(html).toContain('badge-ok');
      expect(html).toContain(language === 'en' ? 'Hard Mode settings active · 12 of 12' : 'Настройки Hard Mode активны · 12 из 12');
      expect(html).toContain('data-testid="hard-mode-details"');
      expect(html).not.toContain('data-testid="hard-mode-fix"');
      expect(html).not.toContain('data-testid="hard-mode-loss"');

      // 12 rule items present
      for (const id of ['fuel', 'air', 'police', 'fatigue', 'limiter', 'truck', 'trailer', 'parking', 'rain', 'events', 'braking', 'traffic']) {
        expect(html).toContain(`data-testid="hard-mode-rule-${id}"`);
        expect(html).toContain(`data-testid="hard-mode-name-${id}"`);
      }
    }
  });

  it('renders inactive state with badge-warn, fix banner, and failing rule detail in EN and RU', () => {
    const failingConfig = HARD_MODE_CONFIG.replace('g_fuel_simulation "1"', 'g_fuel_simulation "0"');
    const assessment = evaluateHardMode(parseHardModeConfig(failingConfig), 1000, 'fixture');
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({status: {assessment, trip: null, verification: VERIFIED}}),
        })
      );
      expect(html).toContain('badge-warn');
      expect(html).toContain(language === 'en' ? 'Hard Mode not active · 11 of 12' : 'Hard Mode не активен · 11 из 12');
      expect(html).toContain('data-testid="hard-mode-fix"');
      expect(html).toContain('data-testid="hard-mode-detail-rule-fuel"');
      expect(html).not.toContain('data-testid="hard-mode-detail-rule-police"');
    }
  });

  it('renders lost state with badge-error and loss notification alert', () => {
    const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture');
    const lossTrip: HardModeDetailsV1 = {
      version: 1,
      binding: null,
      opening: assessment,
      latest: assessment,
      firstLoss: {
        rule: 'police',
        reason: 'outside-limit',
        values: [0],
        atUtcMs: 1700000000000,
      },
      manualDelivery: null,
    };
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({status: {assessment, trip: lossTrip, verification: VERIFIED}}),
        })
      );
      expect(html).toContain('badge-error');
      expect(html).toContain(language === 'en' ? 'Hard Mode lost for this trip' : 'Hard Mode потерян для этого рейса');
      expect(html).toContain('data-testid="hard-mode-loss"');
    }
  });

  it('renders both loss notification and in-game fix banner when trip is lost and settings fail', () => {
    const failingConfig = HARD_MODE_CONFIG.replace('g_fuel_simulation "1"', 'g_fuel_simulation "0"');
    const assessment = evaluateHardMode(parseHardModeConfig(failingConfig), 1000, 'fixture');
    const lossTrip: HardModeDetailsV1 = {
      version: 1,
      binding: null,
      opening: assessment,
      latest: assessment,
      firstLoss: {
        rule: 'police',
        reason: 'outside-limit',
        values: [0],
        atUtcMs: 1700000000000,
      },
      manualDelivery: null,
    };
    const html = renderToStaticMarkup(
      React.createElement(HardModeCard, {
        language: 'en',
        controller: makeController({status: {assessment, trip: lossTrip, verification: VERIFIED}}),
      })
    );
    expect(html).toContain('data-testid="hard-mode-loss"');
    expect(html).toContain('data-testid="hard-mode-fix"');
  });

  it('renders unknown state showing Unknown values and ? mark without pass or fail classification', () => {
    const assessment = unknownHardMode(1000, 'missing');
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({status: {assessment, trip: null, verification: VERIFIED}}),
        })
      );
      expect(html).toContain('data-state="unknown"');
      expect(html).toContain('badge-neutral');
      expect(html).toContain(language === 'en' ? 'Hard Mode unknown' : 'Hard Mode не определён');
      expect(html).not.toMatch(/Hard Mode (unknown|не определён) ·/);
      expect(html).toContain(language === 'en' ? 'Unknown' : 'Неизвестно');
      expect(html).not.toContain('data-state="pass"');
      expect(html).not.toContain('data-state="fail"');
      for (const id of ['fuel', 'air', 'police', 'fatigue', 'limiter', 'truck', 'trailer', 'parking', 'rain', 'events', 'braking', 'traffic']) {
        expect(html).toContain(`data-testid="hard-mode-rule-${id}" data-state="unknown"`);
      }
      expect(html).toContain('<span class="yu-hard-mode-mark" aria-hidden="true">?</span>');
      expect(html).not.toContain('<span class="yu-hard-mode-mark" aria-hidden="true">✓</span>');
      expect(html).not.toContain('<span class="yu-hard-mode-mark" aria-hidden="true">✕</span>');
    }
  });

  it('renders neutral badge and reading text when not loaded', () => {
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({loaded: false}),
        })
      );
      expect(html).toContain('badge-neutral');
      expect(html).toContain(language === 'en' ? 'Reading settings…' : 'Чтение настроек…');
      expect(html).not.toMatch(/· \d+ of 12|· \d+ из 12/);
    }
  });

  it('renders neutral badge and unavailable notice when error occurs', () => {
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({error: true}),
        })
      );
      expect(html).toContain('badge-neutral');
      expect(html).toContain(language === 'en' ? 'Settings could not be read. Required evidence is unknown.' : 'Не удалось прочитать настройки. Необходимые данные неизвестны.');
    }
  });

  it('preserves full RU/EN parity and leaks no forbidden English tokens on Russian pages', () => {
    const ruHtml = renderToStaticMarkup(
      React.createElement(HardModeCard, {
        language: 'ru',
        controller: makeController(),
      })
    );
    const enHtml = renderToStaticMarkup(
      React.createElement(HardModeCard, {
        language: 'en',
        controller: makeController(),
      })
    );
    // Concrete Russian texts rendered
    expect(ruHtml).toContain('Текущие настройки');
    expect(ruHtml).toContain('Проверить снова');
    expect(ruHtml).toContain('Все 12 условий должны выполняться одновременно');
    expect(ruHtml).toContain('Проверяются только сохранённые настройки профиля');
    expect(ruHtml).toContain('В игре:');
    expect(ruHtml).toContain('Нужно:');

    // Concrete English texts rendered
    expect(enHtml).toContain('Current settings');
    expect(enHtml).toContain('Check again');
    expect(enHtml).toContain('All 12 must hold at the same time');
    expect(enHtml).toContain('Only saved profile settings are read');
    expect(enHtml).toContain('In game:');
    expect(enHtml).toContain('Required:');

    // Smoke test assertion against leaking forbidden English tokens
    expect(ruHtml).not.toMatch(/Detected:|Required:|Reason:|Check again|Current settings|Read-only/);
  });

  it('maintains complete key parity between en and ru for all hm keys', async () => {
    const {EN_DICTIONARY} = await import('../../apps/desktop/src/i18n/en');
    const {RU_DICTIONARY} = await import('../../apps/desktop/src/i18n/ru');
    const enHmKeys = Object.keys(EN_DICTIONARY).filter(k => k.startsWith('hm.')).sort();
    const ruHmKeys = Object.keys(RU_DICTIONARY).filter(k => k.startsWith('hm.')).sort();
    expect(enHmKeys).toEqual(ruHmKeys);
  });

  it('never promises or claims finished trip qualification', () => {
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController(),
        })
      );
      expect(html).not.toMatch(/will count as Hard Mode|будет засчитан как Hard Mode/i);
    }
  });
});

describe('ET-112d profile verification on the Hard Mode page (REG-009, REG-010)', () => {
  const unknown = unknownHardMode(1000, 'source-unproven');
  const lastCheck = {atUtcMs: 7000, state: 'unverified', reason: 'game-log'} as const;
  const unverified: HardModeVerification = {state: 'unverified', reason: 'game-log', checking: false, lastCheck: null};
  const render = (language: 'en' | 'ru', status: HardModeController['status'], overrides: Partial<HardModeController> = {}) =>
    renderToStaticMarkup(React.createElement(HardModeCard, {language, controller: makeController({status, now: 10_000, ...overrides})}));
  const TEXT = {
    en: {unable: 'Unable to verify profile', log: 'the game log does not belong to this game session', waiting: 'Waiting for game telemetry', unknown: 'Hard Mode unknown',
      checking: 'Checking…', result: 'Last check 3 s ago: Unable to verify profile — the game log does not belong to this game session',
      ratio: 'Trip checks: 178/178 passing (100%). Required: ≥95%. Unknown: 74 (excluded).'},
    ru: {unable: 'Не удалось проверить профиль', log: 'журнал игры не относится к этому игровому сеансу', waiting: 'Ожидание телеметрии игры', unknown: 'Hard Mode не определён',
      checking: 'Проверка…', result: 'Последняя проверка 3 с назад: Не удалось проверить профиль — журнал игры не относится к этому игровому сеансу',
      ratio: 'Проверки рейса: 178/178 успешных (100%). Порог: ≥95%. Неизвестно: 74 (вне расчёта).'}
  } as const;
  it.each(['en', 'ru'] as const)('says the profile cannot be verified, with its reason, apart from a failing rule (%s)', language => {
    const html = render(language, {assessment: unknown, trip: null, verification: unverified}), text = TEXT[language];
    expect(html).toMatch(new RegExp(`<span>${text.unable}</span>`));
    expect(html).toContain(`data-testid="hard-mode-verification" data-state="unverified" data-reason="game-log"`);
    expect(html).toMatch(new RegExp(`data-testid="hard-mode-verification"[^>]*>${text.unable}: ${text.log}</p>`));
    expect(html).not.toContain('data-testid="hard-mode-fix"'); expect(html).not.toContain(text.unknown);
  });
  it.each(['en', 'ru'] as const)('waits for game telemetry without claiming an unverified profile (%s)', language => {
    const html = render(language, {assessment: unknown, trip: null, verification: {state: 'waiting', reason: 'no-game', checking: false, lastCheck: null}});
    expect(html).toContain(`<span>${TEXT[language].waiting}</span>`);
    expect(html).not.toContain('data-testid="hard-mode-verification"'); expect(html).not.toContain(TEXT[language].unable);
  });
  it.each(['en', 'ru'] as const)('keeps the fix banner for a failing rule of a verified profile, without a verification line (%s)', language => {
    const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), 1000, 'fixture');
    const html = render(language, {assessment, trip: null, verification: VERIFIED});
    expect(html).toContain('data-testid="hard-mode-fix"'); expect(html).not.toContain('data-testid="hard-mode-verification"');
  });
  it.each(['en', 'ru'] as const)('shows a running check on the button and the last result once it ends (%s)', language => {
    const text = TEXT[language];
    const running = render(language, {assessment: unknown, trip: null, verification: {...unverified, checking: true, lastCheck}});
    expect(running).toMatch(new RegExp(`data-testid="hard-mode-refresh"[^>]*>${text.checking}</button>`));
    expect(running).not.toContain('data-testid="hard-mode-check-result"');
    const done = render(language, {assessment: unknown, trip: null, verification: {...unverified, lastCheck}});
    expect(done).not.toMatch(new RegExp(`data-testid="hard-mode-refresh"[^>]*>${text.checking}</button>`));
    expect(done).toMatch(new RegExp(`data-testid="hard-mode-check-result"[^>]*>${text.result}</p>`));
  });
  it.each(['en', 'ru'] as const)('shows the joined trip ratio separately from an unverified current profile (%s)', language => {
    const trip = {...newHardModeDetails(unknown, null), passingChecks: 178, failingChecks: 0, unknownChecks: 74};
    const html = render(language, {assessment: unknown, trip, verification: unverified});
    expect(html).toContain(TEXT[language].ratio); expect(html).toContain('data-testid="hard-mode-verification"');
  });
});
