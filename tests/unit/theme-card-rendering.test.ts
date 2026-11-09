import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {DEFAULT_NOW_PLAYING} from '../../apps/desktop/src/now-playing/contract';
import {DEFAULT_OVERLAY_SETTINGS} from '../../apps/desktop/src/overlay-sections';
import {getSettingsSaveErrorText} from '../../apps/desktop/src/strings';
import {ThemeCard} from '../../apps/desktop/src/theme-card';
import type {AppLanguage, SettingsView, ThemePreference} from '../../packages/contracts/src';

// ET-082: the theme row on Settings > General. Only the shadcn primitives are substituted; the labels, ids, committed value and
// error rules remain real. Expected texts are the hand-written EN/RU copy from the card.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: ({value, disabled, children, ...props}: {value: string; disabled?: boolean; children?: React.ReactNode; onValueChange?: unknown}) =>
    React.createElement('div', {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'onValueChange')), role: 'radiogroup', 'data-value': value,
      'aria-disabled': disabled ? 'true' : undefined}, children),
  RadioGroupItem: ({value, ...props}: {value: string}) => React.createElement('button', {...props, role: 'radio', value})
}));

const settings = (language: AppLanguage, theme: ThemePreference = 'system', patch: Partial<SettingsView> = {}): SettingsView => ({
  nowPlaying: DEFAULT_NOW_PLAYING, language, autostart: false, theme, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'automatic', ats: 'automatic'}, overlay: DEFAULT_OVERLAY_SETTINGS,
  state: 'loaded', writable: true, saveError: null, ...patch});
const render = (view: SettingsView | undefined, showSaveError?: boolean) => renderToStaticMarkup(React.createElement(ThemeCard, {settings: view, onSaved: vi.fn(), onRequest: vi.fn(), showSaveError}));
const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const group = (html: string) => html.match(/<div[^>]*data-testid="theme-select"[^>]*>/)?.[0] ?? '';

it.each([
  ['en', 'Theme', ['Light', 'Dark', 'System'], 'System follows your Windows setting and switches at once, without a restart. The in-game overlay is always dark.'],
  ['ru', 'Тема оформления', ['Светлая', 'Тёмная', 'Как в системе'], '«Как в системе» следует настройке Windows и переключается сразу, без перезапуска. Оверлей в игре всегда тёмный.']
] as const)('labels the row and all three options in %s', (language, title, options, hint) => {
  const html = render(settings(language));
  expect(html).toContain(`id="theme-label" class="yu-setting-label">${title}</span>`);
  expect(html).toContain(`data-testid="theme-hint">${escaped(hint)}</div>`);
  expect([...html.matchAll(/<label for="theme-([a-z]+)">([^<]+)<\/label>/g)].map(match => [match[1], match[2]])).toEqual([['light', options[0]], ['dark', options[1]], ['system', options[2]]]);
});

it.each(['light', 'dark', 'system'] as const)('shows the committed %s theme as the group value', theme => {
  expect(group(render(settings('en', theme)))).toContain(`data-value="${theme}"`);
});

it('shows the default system theme until the settings arrive, and disables the group', () => {
  const html = group(render(undefined));
  expect(html).toContain('data-value="system"');
  expect(html).toContain('aria-disabled="true"');
});

it('disables the group while the settings are read-only', () => {
  expect(group(render(settings('en', 'dark', {writable: false, state: 'newer-version'})))).toContain('aria-disabled="true"');
  expect(group(render(settings('en', 'dark')))).not.toContain('aria-disabled');
});

it.each(['en', 'ru'] as const)('shows main\'s refused save only when this card made the last request (%s)', language => {
  const view = settings(language, 'system', {saveError: 'SETTINGS_WRITE_FAILED'});
  expect(render(view, true)).toContain(`data-testid="theme-save-error">${escaped(getSettingsSaveErrorText('SETTINGS_WRITE_FAILED', language))}</p>`);
  expect(render(view, false)).not.toContain('theme-save-error');
});
