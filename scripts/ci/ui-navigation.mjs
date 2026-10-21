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
  await page.waitForFunction(language => globalThis.desktop.getAppState().then(state => state.settings.language === language), value, {timeout: 5000});
}
