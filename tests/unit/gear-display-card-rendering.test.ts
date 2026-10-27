import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {GearDisplayCard} from '../../apps/desktop/src/gear-display-card';
import {DEFAULT_OVERLAY_SETTINGS} from '../../apps/desktop/src/overlay-sections';
import {getSettingsSaveErrorText, getUnitGameText} from '../../apps/desktop/src/strings';
import {t} from '../../apps/desktop/src/i18n';
import type {AppLanguage, GearDisplayModes, LiveTelemetry, SettingsView} from '../../packages/contracts/src';
import {gearboxFixture, gearboxPair} from '../shared/live-v1-fixtures';

// ET-050: the gear display card on Settings > Units. Substitute only the shadcn primitives; the card's labels, ids,
// committed state, locks and error rules remain real. Expected texts are the hand-written EN/RU copy.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
// The variant and size props style the shadcn button; they are left out of the markup.
vi.mock('@/components/ui/button', () => ({Button: (props: Record<string, unknown>) =>
  React.createElement('button', Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'variant' && key !== 'size')))}));
vi.mock('@/components/ui/radio-group', () => ({
  // The change handler is not a DOM attribute; it is left out of the markup.
  RadioGroup: ({value, disabled, children, ...props}: {value: string; disabled?: boolean; children?: React.ReactNode; onValueChange?: unknown}) =>
    React.createElement('div', {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'onValueChange')), role: 'radiogroup', 'data-value': value,
      'aria-disabled': disabled ? 'true' : undefined}, children),
  RadioGroupItem: ({value, ...props}: {value: string}) => React.createElement('button', {...props, role: 'radio', value})
}));

const settings = (language: AppLanguage, gearDisplay: GearDisplayModes = {ets2: 'automatic', ats: 'automatic'}, patch: Partial<SettingsView> = {}): SettingsView => ({
  language, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay, gearboxGearDisplay: {ets2: [], ats: []}, overlay: DEFAULT_OVERLAY_SETTINGS, state: 'loaded', writable: true, saveError: null, ...patch});
const render = (view: SettingsView | undefined, showSaveError?: boolean, live?: LiveTelemetry) =>
  renderToStaticMarkup(React.createElement(GearDisplayCard, {settings: view, live, onSaved: vi.fn(), onRequest: vi.fn(), showSaveError}));
const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const group = (html: string, game: string) => html.match(new RegExp('<div[^>]*data-testid="gear-display-' + game + '"[^>]*>'))?.[0] ?? '';

const COPY = {
  en: {title: 'Gear display', automatic: 'Automatic (1, 2, 3)', manual: 'Manual range-splitter (1L, 1H, 2L…)',
    crawler: {ets2: 'Crawler first (C, 1, 2, 3…)', ats: 'Crawler first (L, 1, 2, 3…)'},
    failed: 'The gear display change was not saved; the previous setting stays in use.'},
  ru: {title: 'Отображение передач', automatic: 'Автоматическая (1, 2, 3)', manual: 'Механическая с делителем (1L, 1H, 2L…)',
    crawler: {ets2: 'С ползучей (C, 1, 2, 3…)', ats: 'С ползучей (L, 1, 2, 3…)'},
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
    // ET-050b owner option B: the third option names the game's own crawler.
    expect(html).toContain(`id="gear-display-${game}-crawler"`);
    expect(html).toContain(`<label for="gear-display-${game}-crawler">${escaped(COPY[language].crawler[game])}</label>`);
    expect(html.match(new RegExp(`<button[^>]*id="gear-display-${game}-`, 'g'))).toHaveLength(3);
    // Review finding: three options stack in one column instead of wrapping into the two-column segmented grid.
    expect(group(html, game)).toContain('class="yu-segmented yu-segmented-stacked"');
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toContain('data-testid="gear-display-error"');
});
it('shows only the committed mode of each game, and automatic before the settings arrive', () => {
  const html = render(settings('en', {ets2: 'manual', ats: 'automatic'}));
  expect(group(html, 'ets2')).toContain('data-value="manual"');
  expect(group(html, 'ats')).toContain('data-value="automatic"');
  const crawler = render(settings('en', {ets2: 'crawler', ats: 'manual'}));
  expect(group(crawler, 'ets2')).toContain('data-value="crawler"');
  expect(group(crawler, 'ats')).toContain('data-value="manual"');
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

// ET-050b per-gearbox modes (settings v12). The current gearbox is the fixture pair's ETS2 12-speed (12 forward, 4 reverse) on
// 'truck.volvo', "Synthetic Brand Synthetic Truck"; the expected texts are the hand-written EN/RU copy.
const GEARBOX_COPY = {
  en: {current: 'Current truck: Synthetic Brand Synthetic Truck, 12 forward and 4 reverse gears', game: 'As for the game: Manual range-splitter (1L, 1H, 2L…)',
    none: "The current truck's gearbox is not known yet: it appears here while this game sends live data with this version's plugin.",
    saved: 'Gearboxes with their own mode in Euro Truck Simulator 2', reset: "Use the game's mode",
    resetNamed: "Use the game's mode for Synthetic Brand Synthetic Truck, 12 forward and 4 reverse gears"},
  ru: {current: 'Текущий грузовик: Synthetic Brand Synthetic Truck, передач вперёд: 12, назад: 4', game: 'Как для игры: Механическая с делителем (1L, 1H, 2L…)',
    none: 'Коробка текущего грузовика пока не известна: она появится здесь, пока игра передаёт данные через плагин этой версии.',
    saved: 'Коробки со своим режимом в Euro Truck Simulator 2', reset: 'Режим игры',
    resetNamed: 'Вернуть режим игры для Synthetic Brand Synthetic Truck, передач вперёд: 12, назад: 4'}
} as const;
const live = () => gearboxPair(3, {gearbox: gearboxFixture('checkpoint')});
const SAVED = {model: 'truck.volvo', forwardGears: 12, reverseGears: 4, label: 'Synthetic Brand Synthetic Truck', mode: 'crawler'} as const;
const gearboxGroup = (html: string, game: string) => html.match(new RegExp('<div[^>]*data-testid="gear-display-' + game + '-gearbox-mode"[^>]*>'))?.[0] ?? '';
it.each(['en', 'ru'] as const)('explains per game that the current gearbox is not known yet in %s', language => {
  const html = render(settings(language));
  for (const game of ['ets2', 'ats']) {
    expect(html).toContain(`data-testid="gear-display-${game}-gearbox-none">${escaped(GEARBOX_COPY[language].none)}</p>`);
    expect(html).not.toContain(`data-testid="gear-display-${game}-gearbox"`);
    expect(html).not.toContain(`data-testid="gear-display-${game}-gearboxes"`);
  }
});
it.each(['en', 'ru'] as const)('offers the current gearbox "as for the game" or one of the modes under its game only in %s', language => {
  const html = render(settings(language, {ets2: 'manual', ats: 'automatic'}), undefined, live());
  expect(html).toContain(`<p id="gear-display-ets2-gearbox-label">${escaped(GEARBOX_COPY[language].current)}</p>`);
  expect(gearboxGroup(html, 'ets2')).toContain('aria-labelledby="gear-display-ets2-gearbox-label"');
  expect(gearboxGroup(html, 'ets2')).toContain('data-value="game"');
  expect(html).toContain(`<label for="gear-display-ets2-gearbox-game">${escaped(GEARBOX_COPY[language].game)}</label>`);
  for (const mode of ['automatic', 'manual'] as const) expect(html).toContain(`<label for="gear-display-ets2-gearbox-${mode}">${escaped(COPY[language][mode])}</label>`);
  expect(html).toContain(`<label for="gear-display-ets2-gearbox-crawler">${escaped(COPY[language].crawler.ets2)}</label>`);
  expect(html.match(/<button[^>]*id="gear-display-ets2-gearbox-/g)).toHaveLength(4);
  expect(html).toContain('data-testid="gear-display-ats-gearbox-none"');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
});
it.each(['en', 'ru'] as const)('shows the own mode of a saved gearbox and lists it with a named button back to the game mode in %s', language => {
  const view = settings(language, {ets2: 'manual', ats: 'automatic'}, {gearboxGearDisplay: {ets2: [SAVED], ats: []}});
  const html = render(view, undefined, live());
  expect(gearboxGroup(html, 'ets2')).toContain('data-value="crawler"');
  expect(html).toContain(`aria-label="${escaped(GEARBOX_COPY[language].saved)}" data-testid="gear-display-ets2-gearboxes"`);
  expect(html).toContain(`aria-label="${escaped(GEARBOX_COPY[language].resetNamed)}">${escaped(GEARBOX_COPY[language].reset)}</button>`);
  expect(html).not.toContain('data-testid="gear-display-ats-gearboxes"');
  // The list stays without a current truck.
  expect(render(view)).toContain('data-testid="gear-display-ets2-gearboxes"');
});
it('locks the gearbox group and the list buttons while the settings are read-only', () => {
  const html = render(settings('en', undefined, {state: 'newer-version', writable: false, gearboxGearDisplay: {ets2: [SAVED], ats: []}}), undefined, live());
  expect(gearboxGroup(html, 'ets2')).toContain('aria-disabled="true"');
  expect(html).toMatch(/<button disabled=""[^>]*aria-label="Use the game&#x27;s mode for/);
});
