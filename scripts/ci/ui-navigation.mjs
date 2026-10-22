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
export async function chooseSource(page, value) {
  await settingsPanel(page, 'data');
  await page.getByTestId('source-select').selectOption(value);
  await screen(page, 'live');
}
export async function chooseLanguage(page, value) {
  await page.getByTestId('shell.language').click({timeout: 5000});
  await page.getByTestId(`shell.language.${value}`).click({timeout: 5000});
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
          const triggers = globalThis.document.querySelectorAll('[data-testid="shell.language"]');
          return {language: state.settings.language, documentLanguage: globalThis.document.documentElement.lang,
            count: triggers.length, label: triggers[0]?.textContent?.trim()};
        }),
        new Promise((_, reject) => {timer = setTimeout(() => reject(expired()), remaining);})
      ]);
    } finally {clearTimeout(timer);}
    const left = deadline - performance.now();
    if (left <= 0) throw expired();
    if (observed.language === value && observed.documentLanguage === value && observed.count === 1 && observed.label === value.toUpperCase()) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, left)));
  }
}
