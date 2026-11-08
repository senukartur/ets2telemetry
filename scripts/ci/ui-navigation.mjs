import {performance} from 'node:perf_hooks';

// All navigation is through the production shell; no bridge or product authority is added.
export async function screen(page, route, left = cap => cap) {
  await page.getByTestId(`tab-${route}`).click({timeout: left(5000)});
  await page.locator('.yu-content').evaluate(node => {node.scrollTop = 0;}, undefined, {timeout: left(5000)});
}
export async function settingsPanel(page, panel, left = cap => cap) {
  await screen(page, 'settings', left);
  await page.getByTestId(`settings.nav.${panel}`).click({timeout: left(5000)});
}
export async function waitForStartup(page, left = cap => cap, readyCap = 10000) {
  await settingsPanel(page, 'data', left);
  await page.getByText('Telemetry service ready; isolated storage probe verified', {exact: true}).waitFor({state: 'visible', timeout: left(readyCap)});
  await screen(page, 'live', left);
}
/**
 * ET-067: Playwright drives the pointer through the renderer, but the dashboard is a real window, so the desktop's own
 * cursor still reaches it, and Windows moves it there whenever a window changes under a resting cursor. One such move
 * between a hover and Radix's 150 ms delayed open leaves a hint closed. Click-through for OS input only, so every pointer
 * event the page sees is the driver's; the overlay keeps its own state. Electron cannot read the setting back, so a
 * caller can only record the call. Returns the dashboard window's id.
 */
export function isolateDashboardPointer(application) {
  return application.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().endsWith('?view=overlay'));
    if (!window) throw new Error('UI_DASHBOARD_WINDOW_MISSING');
    window.setIgnoreMouseEvents(true);
    return window.id;
  });
}
export async function chooseSource(page, value) {
  await settingsPanel(page, 'data');
  await page.getByTestId('source-select').selectOption(value);
  await screen(page, 'live');
}
/**
 * ET-057, ET-073: the language is chosen in Settings > General via a dropdown select (the sidebar menu and radio buttons are gone).
 * The route shown before the choice is shown again afterwards, so callers keep their screen.
 */
export async function chooseLanguage(page, value) {
  const previous = await page.locator('.yu-sidebar .yu-nav-item[aria-current="page"]').getAttribute('data-testid', {timeout: 5000});
  await settingsPanel(page, 'general');
  const trigger = page.getByTestId('language-select');
  if (await trigger.getAttribute('data-value') !== value) {
    await trigger.click({timeout: 5000});
    await page.getByTestId(`language-option-${value}`).click({timeout: 5000});
  }
  // Await IPC in the host and observe the rendered language under one condition deadline.
  const deadline = performance.now() + 5000, expired = () => new Error('UI_LANGUAGE_SAVED within 5000 ms');
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw expired();
    let timer, observed;
    try {
      observed = await Promise.race([
        page.evaluate(async () => {
          const state = await globalThis.desktop.getAppState();
          const triggerEl = globalThis.document.querySelector('[data-testid="language-select"]');
          return {
            language: state.settings.language,
            documentLanguage: globalThis.document.documentElement.lang,
            selected: triggerEl?.getAttribute('data-value')
          };
        }),
        new Promise((_, reject) => {timer = setTimeout(() => reject(expired()), remaining);})
      ]);
    } finally {clearTimeout(timer);}
    const left = deadline - performance.now();
    if (left <= 0) throw expired();
    if (observed.language === value && observed.documentLanguage === value && observed.selected === value) {
      if (previous && previous !== 'tab-settings') await page.getByTestId(previous).click({timeout: Math.max(1, deadline - performance.now())});
      return;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, left)));
  }
}
