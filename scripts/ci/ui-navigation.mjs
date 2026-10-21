// All navigation is through the production shell; no bridge or product authority is added.
export async function screen(page, route) {
  await page.getByTestId(`tab-${route}`).click({timeout: 5000});
  await page.locator('.yu-content').evaluate(node => {node.scrollTop = 0;});
}
export async function settingsPanel(page, panel) {
  await screen(page, 'settings');
  await page.getByTestId(`settings.nav.${panel}`).click({timeout: 5000});
}
export async function waitForStartup(page) {
  await settingsPanel(page, 'data');
  await page.getByText('Telemetry service ready; isolated storage probe verified', {exact: true}).waitFor({state: 'visible', timeout: 10000});
  await screen(page, 'live');
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
