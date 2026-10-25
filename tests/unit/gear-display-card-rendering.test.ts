import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {GearDisplayCard} from '../../apps/desktop/src/gear-display-card';
import {DEFAULT_OVERLAY_SETTINGS} from '../../apps/desktop/src/overlay-sections';
import {getSettingsSaveErrorText, getUnitGameText} from '../../apps/desktop/src/strings';
import {t} from '../../apps/desktop/src/i18n';
import type {AppLanguage, GearDisplayModes, SettingsView} from '../../packages/contracts/src';

// ET-050: the gear display card on Settings > Units. Substitute only the shadcn primitives; the card's labels, ids,
// committed state, locks and error rules remain real. Expected texts are the hand-written EN/RU copy.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
vi.mock('@/components/ui/radio-group', () => ({
  // The change handler is not a DOM attribute; it is left out of the markup.
  RadioGroup: ({value, disabled, children, ...props}: {value: string; disabled?: boolean; children?: React.ReactNode; onValueChange?: unknown}) =>
    React.createElement('div', {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'onValueChange')), role: 'radiogroup', 'data-value': value,
      'aria-disabled': disabled ? 'true' : undefined}, children),
  RadioGroupItem: ({value, ...props}: {value: string}) => React.createElement('button', {...props, role: 'radio', value})
}));

const settings = (language: AppLanguage, gearDisplay: GearDisplayModes = {ets2: 'automatic', ats: 'automatic'}, patch: Partial<SettingsView> = {}): SettingsView => ({
  language, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay, overlay: DEFAULT_OVERLAY_SETTINGS, state: 'loaded', writable: true, saveError: null, ...patch});
const render = (view: SettingsView | undefined, showSaveError?: boolean) =>
  renderToStaticMarkup(React.createElement(GearDisplayCard, {settings: view, onSaved: vi.fn(), onRequest: vi.fn(), showSaveError}));
const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const group = (html: string, game: string) => html.match(new RegExp('<div[^>]*data-testid="gear-display-' + game + '"[^>]*>'))?.[0] ?? '';

const COPY = {
  en: {title: 'Gear display', automatic: 'Automatic (1, 2, 3)', manual: 'Manual range-splitter (LL, 1L, 1H…)',
    failed: 'The gear display change was not saved; the previous setting stays in use.'},
  ru: {title: 'Отображение передач', automatic: 'Автоматическая (1, 2, 3)', manual: 'Механическая с делителем (LL, 1L, 1H…)',
    failed: 'Изменение отображения передач не сохранено; действует прежняя настройка.'}
} as const;

it.each(['en', 'ru'] as const)('renders one labelled, described group per game with unique ids in %s', language => {
  const html = render(settings(language));
  expect(html).toContain(escaped(COPY[language].title));
  expect(t('s.gear', undefined, language)).toBe(COPY[language].title);
  expect(html).toContain(`id="gear-display-description"`);
  expect(html).toContain(escaped(t('s.gear.d', undefined, language)));
  for (const game of ['ets2', 'ats'] as const) {
    expect(html.match(new RegExp(`data-testid="gear-display-${game}"`, 'g'))).toHaveLength(1);
    expect(html).toContain(`<p id="gear-display-${game}-label">${escaped(getUnitGameText(game, language))}</p>`);
    expect(group(html, game)).toContain(`aria-labelledby="gear-display-${game}-label"`);
    expect(group(html, game)).toContain('aria-describedby="gear-display-description"');
    for (const mode of ['automatic', 'manual'] as const) {
      expect(html).toContain(`id="gear-display-${game}-${mode}"`);
      expect(html).toContain(`<label for="gear-display-${game}-${mode}">${escaped(COPY[language][mode])}</label>`);
    }
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toContain('data-testid="gear-display-error"');
});
it('shows only the committed mode of each game, and automatic before the settings arrive', () => {
  const html = render(settings('en', {ets2: 'manual', ats: 'automatic'}));
  expect(group(html, 'ets2')).toContain('data-value="manual"');
  expect(group(html, 'ats')).toContain('data-value="automatic"');
  const none = render(undefined);
  expect(group(none, 'ets2')).toContain('data-value="automatic"');
  expect(group(none, 'ats')).toContain('data-value="automatic"');
  expect(group(none, 'ets2')).toContain('aria-disabled="true"');
});
it('disables both groups while the settings are read-only and enables them while writable', () => {
  const readOnly = render(settings('en', undefined, {state: 'newer-version', writable: false}));
  for (const game of ['ets2', 'ats']) expect(group(readOnly, game)).toContain('aria-disabled="true"');
  const writable = render(settings('en'));
  for (const game of ['ets2', 'ats']) expect(group(writable, game)).not.toContain('aria-disabled');
});
it.each(['en', 'ru'] as const)('shows main\'s save error only when this card made the last request in %s', language => {
  for (const code of ['SETTINGS_WRITE_FAILED', 'SETTINGS_READ_ONLY'] as const) {
    const view = settings(language, undefined, {saveError: code});
    const own = render(view, true);
    expect(own).toContain('role="status"');
    expect(own).toContain(`data-testid="gear-display-error">${escaped(getSettingsSaveErrorText(code, language))}</p>`);
    expect(render(view, false)).not.toContain('data-testid="gear-display-error"');
    expect(render(view)).not.toContain('data-testid="gear-display-error"');
  }
  expect(t('s.gear.saveFailed', undefined, language)).toBe(COPY[language].failed);
});
