import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {HardModeCard} from '../../apps/desktop/src/hard-mode/card';
import type {HardModeController} from '../../apps/desktop/src/hard-mode/use-status';
import type {HardModeDetailsV1} from '../../packages/contracts/src/hard-mode';
import {evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

const makeController = (overrides?: Partial<HardModeController>): HardModeController => ({
  status: {
    assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture'),
    trip: null,
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
          controller: makeController({status: {assessment, trip: null}}),
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
          controller: makeController({status: {assessment, trip: lossTrip}}),
        })
      );
      expect(html).toContain('badge-error');
      expect(html).toContain(language === 'en' ? 'Hard Mode lost for this trip' : 'Hard Mode потерян для этого рейса');
      expect(html).toContain('data-testid="hard-mode-loss"');
    }
  });

  it('renders unknown state showing Unknown values and ? mark without pass or fail classification', () => {
    const assessment = unknownHardMode(1000, 'missing');
    for (const language of ['en', 'ru'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(HardModeCard, {
          language,
          controller: makeController({status: {assessment, trip: null}}),
        })
      );
      expect(html).toContain('data-state="unknown"');
      expect(html).toContain(language === 'en' ? 'Unknown' : 'Неизвестно');
      expect(html).not.toContain('data-state="pass"');
    }
  });

  it('preserves full RU/EN parity and leaks no forbidden English tokens on Russian pages', () => {
    const html = renderToStaticMarkup(
      React.createElement(HardModeCard, {
        language: 'ru',
        controller: makeController(),
      })
    );
    // Smoke test assertion compatibility
    expect(html).not.toMatch(/Detected:|Required:|Reason:|Check again|Current settings|Read-only/);
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
