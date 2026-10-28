import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {AppLanguage, ApplicationInfo, UpdateFailure, UpdateRefusal, UpdateView} from '../../packages/contracts/src';
import {AboutUpdateCheck, SidebarUpdateControl, VersionLine} from '../../apps/desktop/src/update-control';
import {ABOUT_CHECK_WAIT_MS, aboutCheckReplied, aboutCheckText, updateControlText, versionLineText} from '../../apps/desktop/src/update-control-text';
import {EN_DICTIONARY, RU_DICTIONARY} from '../../apps/desktop/src/i18n';
import {CHANNEL_IDENTITIES, channelCopy} from '../../apps/desktop/src/channel';

// ET-055 UP10 and UP11 (REG-019): the sidebar update control, the version line and the About check. Only the shadcn
// primitives are substituted; the words, attributes and click rules are real. Expected texts are the hand-written,
// owner-approved EN/RU copy of UP10 and UP11, never read back from the dictionaries.
type Props = Record<string, unknown> & {children?: React.ReactNode};
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({children}: Props) => React.createElement(React.Fragment, null, children),
  Tooltip: ({children}: Props) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({children}: Props) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({children, side, align, ...props}: Props) => React.createElement('div', {...props, 'data-side': side, 'data-align': align}, children)
}));
vi.mock('@/components/ui/button', () => ({Button: ({variant, size, ...props}: Props) => React.createElement('button', {type: 'button', ...props, 'data-variant': variant, 'data-size': size})}));
vi.mock('@/components/ui/alert', () => ({
  Alert: (props: Props) => React.createElement('div', {'data-slot': 'alert', role: 'alert', ...props}),
  AlertTitle: (props: Props) => React.createElement('div', props),
  AlertDescription: (props: Props) => React.createElement('div', props)
}));

const view = (patch: Partial<UpdateView>): UpdateView => ({state: 'idle', available: null, progress: null, refusal: null, failure: null, lastCheck: null, ...patch});
const offered = (state: UpdateView['state'], patch: Partial<UpdateView> = {}) => view({state, available: '0.2.0', ...patch});
const render = (update: UpdateView | undefined, language: AppLanguage = 'en', windowFocused = true) =>
  renderToStaticMarkup(React.createElement(SidebarUpdateControl, {view: update, language, windowFocused}));
const escape = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const buttonTag = (html: string) => html.match(/<button[^>]*data-testid="shell\.sidebar\.update"[^>]*>/)?.[0] ?? '';
const statusRegion = (html: string) => html.match(/<div role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-testid="shell\.update\.status">(.*?)<\/div>/)?.[1];

const COPY = {
  en: {available: 'Update to 0.2.0', availableName: 'Update to 0.2.0: download and install the available update', downloading: 'Downloading… 42%',
    installing: 'Installing…', restarting: 'Restarting…', ready: 'Restart to finish', failed: 'Update failed – Retry',
    refusal: {GAME_RUNNING: 'Close the game to update', GAME_CHECK_FAILED: 'Could not check running games', BUSY: 'Another task is running – Retry', EXITING: 'The app is closing'},
    failure: {OFFLINE: 'The update server could not be reached. Check the internet connection.', MANIFEST_INVALID: 'The update description was not valid.',
      SIGNATURE_INVALID: 'The update signature could not be verified.', DOWNLOAD_FAILED: 'The download did not finish.',
      HASH_MISMATCH: 'The downloaded file did not match its checksum.', DISK_FULL: 'There is not enough disk space for the update.',
      APPLY_FAILED: 'The update could not be installed.', APPLY_TIMEOUT: 'Installing the update took too long and was stopped.'},
    downloadingNote: 'Downloading the update…', progressName: 'Update download',
    version: 'Version 0.1.1', staging: 'Version 0.2.0-stg.000042', stagingName: 'Version 0.2.0-stg.000042, staging build', dev: 'Development build',
    devStagingName: 'Development build, staging build', unknown: 'Version unknown',
    check: 'Check for updates', unsupported: 'Updates are checked only in an installed copy of the app.', pending: 'Checking for updates…',
    upToDate: 'You have the latest version.', availableCheck: 'Version 0.2.0 is available. Use the button in the sidebar to install it.', checkFailed: 'Could not check for updates.'},
  ru: {available: 'Обновить до 0.2.0', availableName: 'Обновить до 0.2.0: скачать и установить доступное обновление', downloading: 'Загрузка… 42%',
    installing: 'Установка…', restarting: 'Перезапуск…', ready: 'Перезапустить для завершения', failed: 'Не удалось обновить – Повторить',
    refusal: {GAME_RUNNING: 'Закройте игру, чтобы обновить', GAME_CHECK_FAILED: 'Не удалось проверить запущенные игры', BUSY: 'Выполняется другая задача – Повторить', EXITING: 'Программа закрывается'},
    failure: {OFFLINE: 'Не удалось связаться с сервером обновлений. Проверьте подключение к интернету.', MANIFEST_INVALID: 'Описание обновления недействительно.',
      SIGNATURE_INVALID: 'Не удалось проверить подпись обновления.', DOWNLOAD_FAILED: 'Загрузка не завершилась.',
      HASH_MISMATCH: 'Контрольная сумма скачанного файла не совпала.', DISK_FULL: 'Недостаточно места на диске для обновления.',
      APPLY_FAILED: 'Не удалось установить обновление.', APPLY_TIMEOUT: 'Установка обновления заняла слишком много времени и была остановлена.'},
    downloadingNote: 'Загрузка обновления…', progressName: 'Загрузка обновления',
    version: 'Версия 0.1.1', staging: 'Версия 0.2.0-stg.000042', stagingName: 'Версия 0.2.0-stg.000042, тестовая сборка (staging)', dev: 'Сборка для разработки',
    devStagingName: 'Сборка для разработки, тестовая сборка (staging)', unknown: 'Версия неизвестна',
    check: 'Проверить обновления', unsupported: 'Обновления проверяются только в установленной программе.', pending: 'Проверка обновлений…',
    upToDate: 'Установлена последняя версия.', availableCheck: 'Доступна версия 0.2.0. Установите её кнопкой на боковой панели.', checkFailed: 'Не удалось проверить обновления.'}
} as const;
const LANGUAGES = ['en', 'ru'] as const;

describe('the sidebar update control (UP10)', () => {
  it.each(LANGUAGES)('is hidden while idle, checking or unsupported, or before the first state (%s), keeping an empty polite region', language => {
    for (const update of [undefined, view({state: 'idle'}), view({state: 'checking'}), view({state: 'unsupported'})]) {
      expect(updateControlText(update, language), update?.state).toBeNull();
      const html = render(update, language);
      expect(html).toBe('<div class="yu-update-region" data-testid="shell.update.region"><div role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-testid="shell.update.status"></div></div>');
    }
  });

  it.each(LANGUAGES)('offers the version with its accessible name, an icon and the accent dot (%s)', language => {
    const html = render(offered('available'), language), tag = buttonTag(html);
    expect(tag).toMatch(/^<button type="button" class="yu-update"/);
    expect(tag).toContain(`aria-label="${escape(COPY[language].availableName)}"`);
    expect(tag).not.toContain('aria-disabled');
    expect(tag).not.toContain('disabled=');
    expect(tag).not.toContain('tabindex');
    expect(html).toContain(`data-testid="shell.update.label">${escape(COPY[language].available)}</span>`);
    expect(html).toMatch(/<span class="yu-dot" aria-hidden="true" data-tone="accent" data-motion="calm" data-window-focused="true" data-testid="shell.update.dot"><\/span>/);
    expect(html).toMatch(/<svg[^>]*class="lucide lucide-circle-arrow-up[^"]*"[^>]*aria-hidden="true"/);
    expect(statusRegion(html)).toBe(escape(COPY[language].availableName));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="progressbar"');
  });

  // WCAG 2.5.3 Label in Name: a speech user says what they see, so in every state and language the button's accessible
  // name begins with its visible label.
  it.each(LANGUAGES)('names the button with its visible label first in every state (%s)', language => {
    const states: UpdateView[] = [offered('available'), offered('downloading', {progress: 42}), offered('installing'), offered('restarting'),
      offered('ready'), offered('refused', {refusal: 'GAME_RUNNING'}), offered('failed', {failure: 'OFFLINE'})];
    for (const update of states) {
      const text = updateControlText(update, language)!;
      expect(text.accessibleName.startsWith(text.label), `${update.state}: ${text.accessibleName}`).toBe(true);
    }
  });

  it('stops the dot and the busy icon while the window has no focus', () => {
    expect(render(offered('available'), 'en', false)).toContain('data-window-focused="false" data-testid="shell.update.dot"');
    expect(render(offered('downloading', {progress: 42}), 'en', false)).toMatch(/<svg[^>]*data-motion="spin" data-window-focused="false"/);
  });

  it.each(LANGUAGES)('shows the download as a progressbar and keeps the busy button focusable (%s)', language => {
    const html = render(offered('downloading', {progress: 42}), language), tag = buttonTag(html);
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).not.toContain('disabled=""');
    expect(tag).not.toContain('aria-label');
    expect(html).toContain(`data-testid="shell.update.label">${escape(COPY[language].downloading)}</span>`);
    expect(html).toContain(`<div role="progressbar" class="yu-update-progress" data-testid="shell.update.progress" aria-label="${escape(COPY[language].progressName)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"><i style="width:42%"></i></div>`);
    // The polite region announces the phase, never every percentage.
    expect(statusRegion(html)).toBe(escape(COPY[language].downloadingNote));
    expect(html).toMatch(/<svg[^>]*class="lucide lucide-refresh-cw[^"]*"[^>]*aria-hidden="true"[^>]*data-motion="spin"/);
    expect(html).not.toContain('shell.update.dot');
  });

  it.each(LANGUAGES)('shows installing and restarting as busy, and ready as a click that restarts (%s)', language => {
    for (const [state, text, busy] of [['installing', COPY[language].installing, true], ['restarting', COPY[language].restarting, true], ['ready', COPY[language].ready, false]] as const) {
      const html = render(offered(state), language), tag = buttonTag(html);
      expect(html, state).toContain(`data-testid="shell.update.label">${escape(text)}</span>`);
      expect(tag.includes('aria-disabled="true"'), state).toBe(busy);
      expect(statusRegion(html), state).toBe(escape(text));
      expect(html.includes('shell.update.dot'), state).toBe(!busy);
      expect(html, state).not.toContain('role="progressbar"');
    }
  });

  it.each(LANGUAGES)('shows every refusal with its fixed words and keeps the button enabled to retry (%s)', language => {
    for (const refusal of ['GAME_RUNNING', 'GAME_CHECK_FAILED', 'BUSY', 'EXITING'] as UpdateRefusal[]) {
      const html = render(offered('refused', {refusal}), language), tag = buttonTag(html);
      expect(html, refusal).toContain(`data-testid="shell.update.label">${escape(COPY[language].refusal[refusal])}</span>`);
      expect(tag, refusal).not.toContain('aria-disabled');
      expect(tag, refusal).toContain('data-tone="warn"');
      expect(statusRegion(html), refusal).toBe(escape(COPY[language].refusal[refusal]));
      expect(html, refusal).not.toContain('role="alert"');
    }
    // A restart refused while a game runs keeps `ready` and says what to do.
    expect(render(offered('ready', {refusal: 'GAME_RUNNING'}), language)).toContain(`data-testid="shell.update.label">${escape(COPY[language].refusal.GAME_RUNNING)}</span>`);
  });

  it.each(LANGUAGES)('announces a failure assertively, with a fixed tooltip and description per code (%s)', language => {
    for (const failure of ['OFFLINE', 'MANIFEST_INVALID', 'SIGNATURE_INVALID', 'DOWNLOAD_FAILED', 'HASH_MISMATCH', 'DISK_FULL', 'APPLY_FAILED', 'APPLY_TIMEOUT'] as UpdateFailure[]) {
      const html = render(offered('failed', {failure}), language), tag = buttonTag(html), reason = COPY[language].failure[failure];
      expect(html, failure).toContain(`data-testid="shell.update.label">${escape(COPY[language].failed)}</span>`);
      expect(tag, failure).toContain('aria-describedby="shell-update-failure"');
      expect(tag, failure).not.toContain('aria-disabled');
      expect(tag, failure).toContain('data-tone="error"');
      expect(html, failure).toContain(`<div data-testid="shell.update.hint" data-side="right" data-align="end">${escape(reason)}</div>`);
      expect(html, failure).toContain(`<span id="shell-update-failure" class="sr-only" data-testid="shell.update.failure">${escape(reason)}</span>`);
      expect(html, failure).toContain(`<div role="alert" class="sr-only" data-testid="shell.update.alert">${escape(`${COPY[language].failed}. ${reason}`)}</div>`);
      expect(html.match(/role="alert"/g), failure).toHaveLength(1);
      expect(statusRegion(html), failure).toBe('');
    }
  });
});

/** The native button element SidebarUpdateControl returns (the component is hook-free, so it can be called directly). */
function findButton(node: React.ReactNode): React.ReactElement<{onClick: () => void; type: string}> | undefined {
  if (!React.isValidElement(node)) return Array.isArray(node) ? node.map(findButton).find(Boolean) : undefined;
  const element = node as React.ReactElement<{children?: React.ReactNode; 'data-testid'?: string; onClick: () => void; type: string}>;
  if (element.type === 'button' && element.props['data-testid'] === 'shell.sidebar.update') return element;
  const children = typeof element.type === 'function' ? (element.type as (props: unknown) => React.ReactNode)(element.props) : element.props.children;
  return React.Children.toArray(children).map(findButton).find(Boolean);
}

describe('activating the sidebar update control', () => {
  const press = async (update: UpdateView) => {
    const apply = vi.fn(() => Promise.resolve(offered('downloading', {progress: 0})));
    const button = findButton(SidebarUpdateControl({view: update, language: 'en', windowFocused: true, apply}));
    expect(button?.type).toBe('button');
    // A native <button type="button"> is activated by Enter and Space as a click; nothing else handles keys.
    expect(button?.props.type).toBe('button');
    button?.props.onClick();
    await Promise.resolve(); await Promise.resolve();
    return {apply};
  };
  it('calls updateApplication once with no argument for an offer, a refusal, a failure and ready', async () => {
    for (const update of [offered('available'), offered('refused', {refusal: 'GAME_RUNNING'}), offered('failed', {failure: 'OFFLINE'}), offered('ready')]) {
      const {apply} = await press(update);
      expect(apply, update.state).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0], update.state).toEqual([]);
    }
  });
  it('ignores a click while busy, so the focused button does nothing', async () => {
    for (const update of [offered('downloading', {progress: 5}), offered('installing'), offered('restarting')]) {
      expect((await press(update)).apply, update.state).not.toHaveBeenCalled();
    }
  });
});

describe('the version line (UP11)', () => {
  const info = (patch: Partial<ApplicationInfo>): ApplicationInfo => ({version: '0.1.1', channel: 'production', packaged: true, ...patch});
  const line = (value: ApplicationInfo | undefined, language: AppLanguage) =>
    renderToStaticMarkup(React.createElement(VersionLine, {info: value, language, testId: 'shell.sidebar.version'}));
  it.each(LANGUAGES)('shows a production version without a badge (%s)', language => {
    expect(versionLineText(info({}), language)).toEqual({text: COPY[language].version, badge: null, accessibleName: COPY[language].version});
    expect(line(info({}), language)).toBe(`<p class="yu-version" data-testid="shell.sidebar.version" data-channel="production"><span aria-hidden="true" data-testid="shell.sidebar.version.text">${escape(COPY[language].version)}</span>`
      + `<span class="sr-only" data-testid="shell.sidebar.version.name">${escape(COPY[language].version)}</span></p>`);
  });
  it.each(LANGUAGES)('adds the warn-toned Staging badge and one accessible sentence for a staging build (%s)', language => {
    const staging = info({version: '0.2.0-stg.000042', channel: 'staging'});
    expect(versionLineText(staging, language)).toEqual({text: COPY[language].staging, badge: 'Staging', accessibleName: COPY[language].stagingName});
    const html = line(staging, language);
    expect(html).toContain('data-channel="staging"');
    expect(html).toContain('<span aria-hidden="true" class="yu-version-badge" data-testid="shell.sidebar.version.badge">Staging</span>');
    expect(html).toContain(`<span class="sr-only" data-testid="shell.sidebar.version.name">${escape(COPY[language].stagingName)}</span>`);
  });
  it.each(LANGUAGES)('says Development build for an unpackaged run, and never names the fallback version (%s)', language => {
    expect(versionLineText(info({packaged: false}), language)?.text).toBe(COPY[language].dev);
    expect(versionLineText(info({packaged: false, channel: 'staging'}), language)).toEqual({text: COPY[language].dev, badge: 'Staging', accessibleName: COPY[language].devStagingName});
    expect(versionLineText(info({version: '0.0.0'}), language)?.text).toBe(COPY[language].unknown);
  });
  it('renders nothing before main reports the application', () => {
    expect(versionLineText(undefined, 'en')).toBeNull();
    expect(line(undefined, 'en')).toBe('');
  });
});

describe('the About check', () => {
  const check = (atUtcMs: number, outcome: 'up-to-date' | 'available' | 'failed', failure: UpdateFailure | null = null) => ({outcome, failure, atUtcMs});
  it.each(LANGUAGES)('is disabled with a fixed note where this launch never checks (%s)', language => {
    expect(aboutCheckText(view({state: 'unsupported'}), null, language)).toEqual({button: COPY[language].check, busy: false, unsupported: true, note: COPY[language].unsupported, result: null});
    const html = renderToStaticMarkup(React.createElement(AboutUpdateCheck, {view: view({state: 'unsupported'}), language}));
    expect(html).toMatch(/<button type="button" id="settings-about-update-check" data-testid="settings-about-update-check" disabled="" aria-describedby="settings-about-update-check-note"/);
    expect(html).toContain(`>${escape(COPY[language].check)}</button>`);
    expect(html).toContain(`data-testid="settings-about-update-check-note">${escape(COPY[language].unsupported)}</p>`);
    expect(html).toContain('<div role="status" aria-live="polite" aria-atomic="true"></div>');
  });
  it('is enabled with an empty result region before the first click', () => {
    const html = renderToStaticMarkup(React.createElement(AboutUpdateCheck, {view: view({state: 'idle'}), language: 'en'}));
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('aria-disabled');
    expect(html).toContain('<div data-testid="settings-about-update-check-result-region" class="yu-action-result-region"><div role="status" aria-live="polite" aria-atomic="true"></div></div>');
  });
  it.each(LANGUAGES)('waits for a newer finished check and then answers with fixed text (%s)', language => {
    const before = check(1000, 'up-to-date'), pending = {phase: 'pending', before: 1000} as const;
    expect(aboutCheckText(view({state: 'checking', lastCheck: before}), pending, language)).toMatchObject({busy: true, result: {severity: 'info', message: COPY[language].pending}});
    expect(aboutCheckText(view({state: 'idle', lastCheck: check(2000, 'up-to-date')}), pending, language)).toMatchObject({busy: false, result: {severity: 'success', message: COPY[language].upToDate}});
    expect(aboutCheckText(offered('available', {lastCheck: check(2000, 'available')}), pending, language)).toMatchObject({busy: false, result: {severity: 'info', message: COPY[language].availableCheck}});
    expect(aboutCheckText(view({state: 'idle', lastCheck: check(2000, 'failed', 'OFFLINE')}), pending, language))
      .toMatchObject({result: {severity: 'failed', message: `${COPY[language].checkFailed} ${COPY[language].failure.OFFLINE}`}});
    // A check that did not run (rate limited) leaves lastCheck unchanged; after the wait the latest check answers.
    expect(aboutCheckText(view({state: 'idle', lastCheck: before}), {phase: 'answered', before: 1000}, language)).toMatchObject({busy: false, result: {severity: 'success', message: COPY[language].upToDate}});
    expect(aboutCheckText(view({state: 'idle'}), {phase: 'answered', before: null}, language).result).toBeNull();
    expect(ABOUT_CHECK_WAIT_MS).toBe(30_000);
  });
  it('is busy while an update runs', () => {
    for (const state of ['downloading', 'installing', 'restarting'] as const) expect(aboutCheckText(offered(state, state === 'downloading' ? {progress: 1} : {}), null, 'en').busy, state).toBe(true);
  });
});

describe('staging copy (PR-3 channelCopy)', () => {
  it('leaves every update and version text unchanged in a staging build, so no name is rewritten or extended', () => {
    const keys = Object.keys(EN_DICTIONARY).filter(key => key.startsWith('upd.') || key.startsWith('ver.')) as (keyof typeof EN_DICTIONARY)[];
    expect(keys.length).toBe(34);
    for (const dictionary of [EN_DICTIONARY, RU_DICTIONARY]) {
      for (const key of keys) expect(channelCopy(dictionary[key], CHANNEL_IDENTITIES.staging), key).toBe(dictionary[key]);
    }
  });
});

describe('the About check without a started check', () => {
  const before = {outcome: 'up-to-date' as const, failure: null, atUtcMs: 1000};
  it.each(LANGUAGES)('is busy in ready with a fixed note on finishing the installed update (%s)', language => {
    const note = {en: 'An update is already installed. Finish it with the button in the sidebar.',
      ru: 'Обновление уже установлено. Завершите его кнопкой на боковой панели.'}[language];
    expect(aboutCheckText(offered('ready', {lastCheck: before}), null, language)).toEqual({button: COPY[language].check, busy: true, unsupported: false, note, result: null});
    expect(aboutCheckText(offered('ready', {lastCheck: before}), {phase: 'answered', before: 1000}, language).result).toBeNull();
  });
  it('keeps waiting only when the reply shows a running check', () => {
    const pending = {phase: 'pending', before: 1000} as const;
    expect(aboutCheckReplied(pending, view({state: 'checking', lastCheck: before}))).toBe(pending);
    for (const reply of [view({lastCheck: before}), offered('available'), offered('refused', {refusal: 'BUSY'}), offered('failed', {failure: 'OFFLINE'}), offered('downloading', {progress: 1})]) {
      expect(aboutCheckReplied(pending, reply), reply.state).toEqual({phase: 'answered', before: 1000});
    }
  });
  it.each(LANGUAGES)('answers a rejected call with a fixed failure, not the earlier outcome, until a newer check reports (%s)', language => {
    const rejected = {phase: 'rejected', before: 1000} as const, text = {en: 'Could not start a check. Try again.', ru: 'Не удалось начать проверку. Повторите попытку.'}[language];
    for (const update of [view({lastCheck: before}), offered('available', {lastCheck: before})]) {
      expect(aboutCheckText(update, rejected, language).result, update.state).toMatchObject({severity: 'failed', message: text});
    }
    expect(aboutCheckText(view({lastCheck: {outcome: 'up-to-date', failure: null, atUtcMs: 2000}}), rejected, language).result).toMatchObject({severity: 'success', message: COPY[language].upToDate});
  });
  it('answers a standing offer with its version at once, never pending', () => {
    for (const state of ['available', 'refused', 'failed'] as const) {
      const update = offered(state, {lastCheck: before, ...(state === 'refused' ? {refusal: 'GAME_RUNNING' as const} : state === 'failed' ? {failure: 'OFFLINE' as const} : {})});
      expect(aboutCheckText(update, {phase: 'pending', before: 1000}, 'en'), state).toMatchObject({busy: false, result: {severity: 'info', message: COPY.en.availableCheck}});
    }
  });
});
