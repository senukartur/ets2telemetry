import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {AppHealth, AppLanguage, AppState, LiveTelemetry, PluginSetupView, SettingsView} from '../../packages/contracts/src';
import {SETTINGS_PANELS, SettingsScreen, type SettingsPanel, type SettingsScreenProps} from '../../apps/desktop/src/settings-screen';
import {DEFAULT_SETTINGS} from '../../apps/desktop/src/settings-schema';
import {initialLive} from '../../apps/desktop/src/live-state';

// ET-078 (mockup T5): the compact Settings screen. Only the shadcn primitives behind the '@' alias and the overlay card
// (ET-079) are substituted; the panels, rows, locks and texts are the real components. Expected texts are written by hand
// from the EN and RU dictionaries and strings.ts.
type Props = Record<string, unknown> & {children?: React.ReactNode};
// Hoisted with the vi.mock factories that use them.
const {without, passthrough} = vi.hoisted(() => ({
  without: (props: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key))),
  passthrough: ({children}: {children?: React.ReactNode}) => children
}));
vi.mock('@/components/ui/alert', () => ({
  Alert: (props: Props) => React.createElement('div', {'data-slot': 'alert', role: 'alert', ...without(props, ['variant'])}),
  AlertTitle: (props: Props) => React.createElement('div', props),
  AlertDescription: (props: Props) => React.createElement('div', props)
}));
vi.mock('@/components/ui/badge', () => ({Badge: (props: Props) => React.createElement('span', {...without(props, ['variant']), 'data-variant': props.variant})}));
vi.mock('@/components/ui/button', () => ({Button: (props: Props) => React.createElement('button', without(props, ['size', 'variant']))}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
vi.mock('@/components/ui/switch', () => ({Switch: (props: Props) => React.createElement('button', {role: 'switch', 'aria-checked': Boolean(props.checked), ...without(props, ['checked', 'onCheckedChange'])})}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: ({value, disabled, children, ...props}: Props & {value: string; disabled?: boolean}) =>
    React.createElement('div', {...without(props, ['onValueChange']), role: 'radiogroup', 'data-value': value, 'aria-disabled': disabled ? 'true' : undefined}, children),
  RadioGroupItem: (props: Props) => React.createElement('button', {...props, role: 'radio'})
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({children, value, disabled}: Props & {value?: string; disabled?: boolean}) => React.createElement('div', {'data-slot': 'select', 'data-value': value, 'data-disabled': disabled ? '' : undefined}, children),
  SelectTrigger: (props: Props) => React.createElement('button', {type: 'button', ...props}),
  SelectValue: () => null,
  SelectContent: passthrough,
  SelectItem: ({value, children, ...props}: Props & {value: string}) => React.createElement('div', {role: 'option', 'data-value': value, ...props}, children)
}));
vi.mock('@/components/ui/tooltip', () => ({TooltipProvider: passthrough, Tooltip: passthrough, TooltipTrigger: passthrough,
  TooltipContent: (props: Props) => React.createElement('div', without(props, ['side', 'align']))}));
vi.mock('../../apps/desktop/src/overlay-settings-card', () => ({OverlaySettingsCard: () => React.createElement('div', {'data-testid': 'overlay-settings'})}));

const plugins: PluginSetupView = {mode: 'test-root', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
  ets2: {excluded: false, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: [{id: 'ets2:steam:0', source: 'steam', ordinal: 0, state: 'installed',
    reason: null, installed: {version: '0.2.0', sha256Prefix: '0123456789ab'}, lastFailure: null}]},
  ats: {excluded: false, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: []}}};
const HEALTH: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
const appState = (language: AppLanguage, patch: Partial<SettingsView> = {}, health: AppHealth = HEALTH): AppState => ({
  settings: {...DEFAULT_SETTINGS, language, state: 'loaded', writable: true, saveError: null, ...patch},
  health, plugins, autostart: 'unregistered', overlayEdit: {active: false},
  nowPlaying: {state: 'no-session', sources: [], selection: {kind: 'automatic'}, error: null, edit: {active: false, placement: 'unavailable'}},
  application: {version: '0.1.4', channel: 'production', packaged: true},
  update: {state: 'unsupported', available: null, progress: null, refusal: null, failure: null, lastCheck: null}
});
const live: LiveTelemetry = {...initialLive('synthetic'), status: 'connected', reason: 'Synthetic fixture connected', fresh: true};
const render = (patch: Partial<SettingsScreenProps> = {}) => renderToStaticMarkup(React.createElement(SettingsScreen, {
  hidden: false, language: 'en', panel: 'general', onPanel: () => undefined, app: appState(patch.language ?? 'en'), live, startup: 'Telemetry service ready; isolated storage probe verified',
  onSaved: () => undefined, lastCard: 'units', onRequest: () => undefined, languageController: {saving: false, failed: false, choose: () => undefined},
  pluginActions: {pending: false, result: null, run: () => null}, onPlugins: () => undefined, onSourceFailed: () => undefined, ...patch
}));
/** The markup of one panel, from its opening tag to the next panel's. */
const panelOf = (html: string, id: SettingsPanel) => {
  const start = html.indexOf(`data-testid="settings.${id}"`), next = SETTINGS_PANELS[SETTINGS_PANELS.indexOf(id) + 1];
  expect(start, id).toBeGreaterThan(-1);
  return html.slice(start, next ? html.indexOf(`data-testid="settings.${next}"`) : undefined);
};
/** The opening tag of the element with a test id or id. */
const tag = (html: string, attribute: string) => html.match(new RegExp(`<[a-z]+ [^>]*${attribute}[^>]*>`))?.[0] ?? '';

const COPY = {
  en: {nav: ['General', 'Overlay', 'Game plugin', 'Diagnostics', 'About'], navLabel: 'Settings sections', general: 'General',
    sub: 'Changes save immediately; a control shows only the saved value.', close: 'Closing the window', closeV: 'Hide to tray', tray: 'Open it again from the tray icon; use Exit to stop it.',
    units: 'Display units', unitsNote: 'Stored data does not change, only the display', gearNow: 'Now: C1, C2, 1L, 1H, 2L, …, 6H', npHint: 'The track title from a Windows player, in its own window over the game.',
    data: 'Diagnostics', status: 'Connected', service: 'ready', storage: 'verified', bundle: 'Diagnostic bundle', about: 'About', updates: 'Updates', font: 'Font', license: 'Show license'},
  ru: {nav: ['Общие', 'Оверлей', 'Плагин игры', 'Диагностика', 'О программе'], navLabel: 'Разделы настроек', general: 'Общие',
    sub: 'Изменения сохраняются сразу; выбранным показывается только сохранённое значение.', close: 'Закрытие окна', closeV: 'Свернуть в трей', tray: 'Откройте его снова из значка в трее',
    units: 'Единицы измерения', unitsNote: 'Сохранённые данные не меняются, меняется только отображение', gearNow: 'Сейчас: C1, C2, 1L, 1H, 2L, …, 6H', npHint: 'Название трека из плеера Windows в отдельном окне поверх игры.',
    data: 'Диагностика', status: 'Подключено', service: 'готово', storage: 'проверено', bundle: 'Пакет диагностики', about: 'О программе', updates: 'Обновления', font: 'Шрифт', license: 'Показать лицензию'}
} as const;

describe.each(['en', 'ru'] as const)('the Settings screen in %s', language => {
  const copy = COPY[language];
  it('keeps the sub-navigation order and marks only the selected panel, hiding the others', () => {
    for (const panel of SETTINGS_PANELS) {
      const html = render({language, panel});
      // React adds a preload link for the About logo before the screen.
      expect(html).toContain('<div class="yu-settings" data-testid="settings.screen"><nav class="yu-settings-nav"');
      expect(html).toContain(`aria-label="${copy.navLabel}" data-testid="settings.nav"`);
      const buttons = [...html.matchAll(/<button type="button"( aria-current="page")? data-testid="settings\.nav\.([a-z]+)">([^<]+)<\/button>/g)];
      expect(buttons.map(match => match[2])).toEqual(['general', 'overlay', 'plugin', 'data', 'about']);
      expect(buttons.map(match => match[3])).toEqual(copy.nav);
      expect(buttons.filter(match => match[1]).map(match => match[2])).toEqual([panel]);
      for (const id of SETTINGS_PANELS) expect(tag(html, `data-testid="settings.${id}"`).includes('hidden=""'), id).toBe(id !== panel);
    }
    expect(render({language, hidden: true})).toContain('<div hidden="" class="yu-settings" data-testid="settings.screen">');
  });
  it('shows General as compact rows: interface, closing the window, units, gear display and Now Playing', () => {
    const html = panelOf(render({language, app: appState(language, {gearDisplay: {ets2: 'manual', ats: 'automatic'}})}), 'general');
    expect(html).toContain(`<div class="yu-settings-head"><h2>${copy.general}</h2><p>${copy.sub}</p></div>`);
    expect(html).not.toContain('data-testid="settings-state"');
    expect(html).toContain(`<span class="yu-setting-label">${copy.close}</span>`);
    expect(html).toMatch(new RegExp(`data-testid="close-to-tray">[^<]*${copy.tray}`));
    expect(html).toContain(`<span class="yu-setting-value">${copy.closeV}</span>`);
    expect(html).toMatch(new RegExp(`data-testid="settings.units"><div class="yu-settings-card-head"><h3 id="[^"]+">${copy.units}</h3><p class="yu-settings-card-note">${copy.unitsNote}</p>`));
    for (const game of ['ets2', 'ats']) {
      expect(tag(html, `data-testid="units-${game}"`)).toContain(`aria-labelledby="units-${game}-label"`);
      expect(html).toContain(`id="units-${game}-metric"`); expect(html).toContain(`id="units-${game}-us-customary"`);
    }
    expect(html).toContain(`data-testid="gear-display-ets2-example">${copy.gearNow}</div>`);
    expect(html).toContain(`<div class="yu-setting-hint">${copy.npHint}</div>`);
    expect(html).toContain('data-testid="language-select"'); expect(html).toContain('data-testid="autostart-toggle"');
  });
  it('locks every General control while the settings are read-only and shows how they were read', () => {
    const html = panelOf(render({language, app: appState(language, {state: 'newer-version', writable: false})}), 'general');
    expect(html).toContain('data-testid="settings-state"');
    for (const group of ['units-ets2', 'units-ats', 'gear-display-ets2', 'gear-display-ats']) expect(tag(html, `data-testid="${group}"`), group).toContain('aria-disabled="true"');
    expect(html).toMatch(/<div data-slot="select" data-value="[a-z]+" data-disabled="">/);
    expect(tag(html, 'data-testid="autostart-toggle"')).toContain('disabled=""');
    expect(tag(html, 'id="now-playing-enabled"')).toContain('disabled=""');
  });
  it('locks the language select while its save is in flight and keeps the other groups enabled', () => {
    const html = panelOf(render({language, languageController: {saving: true, failed: false, choose: () => undefined}}), 'general');
    expect(html).toMatch(/<div data-slot="select" data-value="[a-z]+" data-disabled="">/);
    expect(tag(html, 'data-testid="units-ets2"')).not.toContain('aria-disabled');
    expect(tag(html, 'data-testid="autostart-toggle"')).not.toContain('disabled=""');
  });
  it('shows Diagnostics: the native source select, the state lines and badge, the health list and the export row', () => {
    const html = panelOf(render({language, panel: 'data'}), 'data');
    const select = html.slice(html.indexOf('<select'), html.indexOf('</select>'));
    expect(tag(select, 'data-testid="source-select"')).toContain('id="settings-source-select"');
    expect([...select.matchAll(/<option value="([a-z0-9]+)"( selected="")?>/g)].map(match => match[1])).toEqual(['game', 'ets2', 'ats', 'synthetic', 'replay']);
    expect(select).toContain('<option value="synthetic" selected="">');
    expect(html).toContain('<p data-testid="startup-status">Telemetry service ready; isolated storage probe verified</p>');
    expect(html).toContain('<p class="yu-telemetry-status" data-testid="telemetry-status">connected: Synthetic fixture connected</p>');
    expect(html).toContain(`<span data-testid="settings.data.status" data-variant="ok">${copy.status}</span>`);
    expect(html).toContain(`<dd data-testid="health-service"><span data-variant="ok">${copy.service}</span></dd>`);
    expect(html).toContain(`<dd data-testid="health-storage"><span data-variant="ok">${copy.storage}</span></dd>`);
    expect(html).toContain('data-testid="prototype-notice"');
    expect(html).not.toContain('data-testid="health-alert"');
    expect(html).not.toContain('close-to-tray');
    const bundle = html.slice(html.indexOf('data-testid="settings.data.bundle"'));
    expect(bundle).toContain(`<span class="yu-setting-label">${copy.bundle}</span>`);
    expect(bundle).toMatch(/data-testid="plugin-export-diagnostics"[^>]*>[^<]+<\/button><div data-testid="plugin-export-diagnostics-result-region"/);
  });
  it('lists the last problem only while the service is not failing, and the failure alert otherwise', () => {
    const lastProblem = language === 'en' ? 'Last problem' : 'Последняя ошибка';
    const ready = panelOf(render({language, panel: 'data', app: appState(language, {}, {...HEALTH, lastError: 'STORAGE_FAILED'})}), 'data');
    expect(ready).toContain(`<dt>${lastProblem}</dt>`); expect(ready).not.toContain('data-testid="health-alert"');
    const failed = panelOf(render({language, panel: 'data', app: appState(language, {}, {...HEALTH, service: 'failed', lastError: 'SERVICE_EXITED'})}), 'data');
    expect(failed).not.toContain(`<dt>${lastProblem}</dt>`); expect(failed).toContain('data-testid="health-alert"');
    expect(failed).toContain(`<dd data-testid="health-service"><span data-variant="error">${language === 'en' ? 'failed' : 'ошибка'}</span></dd>`);
    const none = panelOf(render({language, panel: 'data', app: undefined}), 'data');
    expect(none).toContain('<dd data-testid="health-service">—</dd>');
  });
  it('shows About: the brand with its version, the update check, the font licence and the uninstall warning', () => {
    const html = panelOf(render({language, panel: 'about'}), 'about');
    expect(html).toContain(`<div class="yu-settings-head"><h2>${copy.about}</h2></div>`);
    expect(html).toMatch(/data-testid="settings\.about\.brand"><img src="[^"]+" alt="" width="56" height="56"\/><div><h3>Yukon Union Telemetry<\/h3>/);
    expect(html).toContain('data-testid="settings.about.version"');
    expect(html).toContain(`<div class="yu-setting-row yu-about-update"><div class="yu-setting-text"><span class="yu-setting-label">${copy.updates}</span></div><div class="space-y-2" data-testid="settings.about.update">`);
    expect(html).toContain('data-testid="settings-about-update-check"');
    expect(html).toContain(`<details class="yu-font-license" data-testid="settings.about.font-license"><summary><span class="yu-setting-text"><span class="yu-setting-label">${copy.font}</span><span class="yu-setting-hint">Huninn · SIL Open Font License 1.1</span></span><span class="yu-font-license-toggle">${copy.license}</span></summary><pre data-license-asset=`);
    expect(html).toContain('SIL OPEN FONT LICENSE');
    const warning = html.slice(html.indexOf('data-testid="uninstall-warning"'), html.indexOf('</ul>'));
    expect(warning.match(/<li>/g)).toHaveLength(4);
    expect(html).toMatch(/data-testid="uninstall-button">[^<]+<\/button>/);
  });
  it('shows the Game plugin card on its panel and hosts the overlay card unchanged', () => {
    const html = render({language, panel: 'plugin'});
    expect(panelOf(html, 'plugin')).toContain('data-testid="plugin-card"');
    expect(panelOf(html, 'plugin')).not.toContain('plugin-export-diagnostics');
    expect(panelOf(html, 'overlay').startsWith('data-testid="settings.overlay"><div data-testid="overlay-settings"></div></div>')).toBe(true);
  });
});
