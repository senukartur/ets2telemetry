import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {OWNER_PRODUCTION_BUILD_VARIABLE, resolveBuildChannel} from '../build-channel.mjs';

export const UPLOAD_UI_SCREENS = ['no-token', 'confirmation', 'first-upload', 'offline', 'journal'];
export const UPLOAD_UI_FLAGS = ['paste', 'password', 'visibility', 'enter', 'tokenCleared', 'cancelNavigation', 'cancelConfirmation', 'confirmNavigation', 'fixedRefusals', 'progress', 'chipNavigation', 'rowStates', 'headingFocus', 'contained', 'sharedStyles', 'bridgeIsolation'];
export function validateUploadUiConfiguration(config, environment = process.env) {
  assert.equal(config.scenario, 'ui'); assert.equal(config.uiCase, 'shell');
  assert.ok(['development', 'packaged'].includes(config.mode));
  for (const key of ['output', 'checkout', 'profile', 'cwd']) assert.ok(typeof config[key] === 'string' && path.isAbsolute(config[key]), `INVALID_UPLOAD_UI_${key}`);
  assert.equal(path.dirname(config.profile), config.output); assert.equal(path.dirname(config.cwd), config.output);
  assert.notEqual(config.output, config.checkout); assert.notEqual(config.output, path.parse(config.output).root);
  assert.equal(environment[OWNER_PRODUCTION_BUILD_VARIABLE], undefined);
  const callerChannel = resolveBuildChannel(environment);
  if (callerChannel === 'production') {
    assert.equal(environment.GITHUB_REF, 'refs/heads/main');
    assert.ok(['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME));
  }
  return path.join(config.output, 'dashboard-upload-ui-fixture');
}
export function uploadUiBuildInputs(config, environment = process.env) {
  const root = validateUploadUiConfiguration(config, environment);
  return {root, entries: ['main.ts', 'preload.ts', 'renderer.tsx', '.html'].map(suffix => path.join(config.checkout, 'tests/runtime', suffix === '.html' ? 'dashboard-upload-ui.html' : `dashboard-upload-ui-${suffix}`)),
    define: {__ETS2TELEMETRY_BUILD_CHANNEL__: JSON.stringify('staging'), __ETS2TELEMETRY_APP_VERSION__: JSON.stringify('0.0.0')}, alias: {'@': path.join(config.checkout, 'apps/desktop/src')}};
}
/** Checks resolved modules, including imports hidden behind aliases or re-exports, before any fixture is launched. */
export function uploadUiIsolationPlugin(config, checked = () => {}) {
  const uploadModules = new Set(['contract.ts', 'view.ts', 'ui-controller.ts', 'use-dashboard-upload.ts', 'account-screen.tsx', 'sync-chip.tsx', 'journal-sync.tsx']);
  return {name: 'ets2telemetry-upload-ui-isolation', generateBundle() {
    let modules = 0;
    for (const id of this.getModuleIds()) {
      if (id.startsWith('\0')) continue;
      if (['electron', 'node:fs', 'node:path'].includes(id)) {modules++; continue;}
      assert.ok(path.isAbsolute(id), 'UPLOAD_UI_FORBIDDEN_MODULE');
      const relative = path.relative(config.checkout, id.split('?')[0]).replaceAll('\\', '/');
      const app = relative.startsWith('apps/desktop/src/') ? relative.slice('apps/desktop/src/'.length) : null;
      const allowedApp = app !== null && (['channel.ts', 'index.css', 'fonts.css'].includes(app) || ['components/ui/', 'i18n/', 'shell/', 'assets/'].some(prefix => app.startsWith(prefix)) || app.startsWith('dashboard-upload/') && uploadModules.has(app.slice('dashboard-upload/'.length)));
      assert.ok(allowedApp || relative.startsWith('packages/contracts/src/') || relative.startsWith('node_modules/') || ['tests/runtime/dashboard-upload-ui-main.ts', 'tests/runtime/dashboard-upload-ui-preload.ts', 'tests/runtime/dashboard-upload-ui-renderer.tsx', 'tests/runtime/dashboard-upload-ui.html'].includes(relative), 'UPLOAD_UI_FORBIDDEN_MODULE');
      modules++;
    }
    assert.ok(modules > 0, 'UPLOAD_UI_EMPTY_MODULE_GRAPH'); checked(modules);
  }};
}
/** Called only by ui:shell inside the existing bounded runtime Job, before the normal application/source starts. */
export async function runDashboardUploadUiFixture(config, progress) {
  const inputs = uploadUiBuildInputs(config), {build} = await import('vite'), {default: tailwindcss} = await import('@tailwindcss/vite');
  const moduleGraphs = [], isolation = () => uploadUiIsolationPlugin(config, modules => moduleGraphs.push(modules));
  await mkdir(inputs.root); await writeFile(path.join(inputs.root, '.upload-ui-root'), 'ets2telemetry.dashboard-upload.ui.v1\n', {flag: 'wx'});
  for (const name of ['main', 'preload']) await build({configFile: false, root: config.checkout, logLevel: 'silent', define: inputs.define, plugins: [isolation()],
    build: {outDir: inputs.root, emptyOutDir: false, minify: false, lib: {entry: path.join(config.checkout, `tests/runtime/dashboard-upload-ui-${name}.ts`), formats: ['cjs'], fileName: () => `${name}.cjs`}, rollupOptions: {external: ['electron', /^node:/]}}});
  await build({configFile: false, root: config.checkout, base: './', logLevel: 'silent', define: inputs.define, plugins: [tailwindcss(), isolation()], resolve: {alias: inputs.alias},
    build: {outDir: path.join(inputs.root, 'renderer'), emptyOutDir: false, assetsInlineLimit: 0, rollupOptions: {input: inputs.entries[3]}}});
  assert.equal(moduleGraphs.length, 3, 'UPLOAD_UI_UNCHECKED_BUILD');
  const {_electron: electron, expect} = await import('@playwright/test'), require = createRequire(path.join(config.checkout, 'package.json'));
  const env = {...process.env, LOCALAPPDATA: inputs.root, APPDATA: inputs.root, USERPROFILE: inputs.root}; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({executablePath: require('electron'), args: [path.join(inputs.root, 'main.cjs')], cwd: inputs.root, env, timeout: 20000});
  const record = {origin: 'synthetic', passed: false, productionAuthority: false, moduleGraphs, screenshots: [], flags: {}, security: {}, tokenPresentInScreenshots: false};
  let stage = 'startup';
  try {
    const page = await application.firstWindow(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.name));
    stage = 'initial-context-focus';
    await expect(page.getByTestId('screen-title')).toBeFocused();
    await expect(page.getByTestId('account.phase')).toHaveText('Reading connection…');
    assert.equal(await page.getByTestId('account.form').count(), 0);
    await page.getByTestId('fixture.context.release').evaluate(node => node.click());
    await page.getByTestId('account.form').waitFor();
    await expect(page.getByTestId('screen-title')).toBeFocused();
    const styles = await page.evaluate(() => {
      const button = globalThis.getComputedStyle(globalThis.document.querySelector('[data-testid="account.verify"]'));
      const card = globalThis.getComputedStyle(globalThis.document.querySelector('[data-testid="account.token"]'));
      const badge = globalThis.getComputedStyle(globalThis.document.querySelector('[data-slot="badge"]'));
      // Flex-row children blockify inline-flex to flex; shared alignment must still be present.
      const sharedFlex = style => ['inline-flex', 'flex'].includes(style.display) && style.alignItems === 'center' && style.justifyContent === 'center';
      return {buttonFlex: sharedFlex(button), cardFlex: card.display === 'flex', cardOpaque: !['transparent', 'rgba(0, 0, 0, 0)'].includes(card.backgroundColor), badgeFlex: sharedFlex(badge)};
    });
    assert.deepEqual(styles, {buttonFlex: true, cardFlex: true, cardOpaque: true, badgeFlex: true}); record.flags.sharedStyles = true;
    const base = await application.evaluate(() => globalThis.uploadUiFixture.status);
    const owner = await application.evaluate(() => globalThis.uploadUiFixture.owner);
    const candidate = {...base, state: 'confirmation-required', owner, candidateId: '20000000-0000-4000-8000-000000000001'};
    const connected = {...base, state: 'connected', owner, progress: {...base.progress, enumeration: 'complete', distinctSources: 10, deliveredSources: 2, pendingSources: 6, identityPendingSources: 1, heldSources: 1, queuedEvents: 3, lastDurableUploadUtcMs: 5000}};
    const publish = status => application.evaluate((_electron, status) => globalThis.uploadUiFixture.publish(status), status);
    const settle = status => application.evaluate((_electron, status) => globalThis.uploadUiFixture.settle(status), status);
    stage = 'initial-connected-context-focus';
    await publish(connected); await page.reload();
    await expect(page.getByTestId('screen-title')).toBeFocused();
    await expect(page.getByTestId('account.phase')).toHaveText('Reading connection…');
    await page.getByTestId('fixture.context.release').evaluate(node => node.click());
    await page.getByTestId('account.status').waitFor(); await expect(page.getByTestId('screen-title')).toBeFocused();
    stage = 'live-region-identity';
    const liveRegion = await page.locator('.yu-account [role="status"]').elementHandle();
    for (const status of [base, candidate, connected, base]) {
      await publish(status);
      await expect(page.getByTestId('account.phase')).toHaveText(status.state === 'disconnected' ? 'Not connected' : status.state === 'confirmation-required' ? 'Awaiting confirmation' : 'Connected to the Dashboard');
      assert.equal(await page.locator('.yu-account [role="status"]').count(), 1);
      assert.equal(await page.evaluate(node => node.isConnected && node === globalThis.document.querySelector('.yu-account [role="status"]'), liveRegion), true, 'UPLOAD_STATUS_REGION_REPLACED');
    }
    await liveRegion.dispose();
    stage = 'token-interaction';
    const sentinel = `vtc1_10000000-0000-4000-8000-000000000001_${'z'.repeat(43)}`;
    const input = page.getByTestId('account.token.input');
    assert.equal(await input.getAttribute('type'), 'password'); record.flags.password = true;
    // Insert through a paste event, without OS clipboard access or trace recording of the synthetic sentinel.
    await input.evaluate((node, value) => {node.focus(); const data = new globalThis.DataTransfer(); data.setData('text/plain', value); node.dispatchEvent(new globalThis.ClipboardEvent('paste', {clipboardData: data, bubbles: true})); const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value').set; setter.call(node, data.getData('text/plain')); node.dispatchEvent(new globalThis.Event('input', {bubbles: true}));}, sentinel);
    assert.equal((await input.inputValue()) === sentinel, true, 'PASTE_NOT_APPLIED'); record.flags.paste = true;
    await page.getByTestId('account.token.visibility').click(); assert.equal(await input.getAttribute('type'), 'text');
    assert.equal(await page.getByTestId('account.token.visibility').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('account.token.visibility').click(); assert.equal(await input.getAttribute('type'), 'password'); record.flags.visibility = true;
    await input.focus(); await page.keyboard.press('Tab'); await expect(page.getByTestId('account.token.visibility')).toBeFocused();
    assert.equal(await page.getByTestId('account.token.visibility').evaluate(node => globalThis.getComputedStyle(node).outlineStyle !== 'none' || globalThis.getComputedStyle(node).boxShadow !== 'none'), true);
    await page.keyboard.press('Tab'); await expect(page.getByTestId('account.verify')).toBeFocused();
    await input.press('Enter'); await page.getByTestId('account.cancel').waitFor(); record.flags.enter = true;
    assert.deepEqual(await application.evaluate(() => globalThis.uploadUiFixture.counts), {verify: 1, confirm: 0, cancel: 0, disconnect: 0});
    assert.equal(await input.count(), 0); record.flags.tokenCleared = true;
    stage = 'cancel-navigation';
    await page.getByTestId('fixture.journal').click(); await settle(candidate);
    await page.getByTestId('fixture.account').click(); await page.getByTestId('account.form').waitFor();
    assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).cancel, 1); assert.equal((await input.inputValue()) === '', true, 'TOKEN_NOT_CLEARED'); record.flags.cancelNavigation = true;
    stage = 'cancel-confirmation';
    await publish(candidate); await page.getByTestId('account.cancel').click(); await page.getByTestId('account.form').waitFor();
    assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).cancel, 2); record.flags.cancelConfirmation = true;
    stage = 'fixed-refusals';
    for (const error of ['BUSY', 'RETIRED', 'AUTHENTICATION']) {
      await application.evaluate((_electron, error) => globalThis.uploadUiFixture.fail(error), error);
      await input.fill(sentinel); await input.press('Enter'); await page.getByTestId('account.error').waitFor();
      assert.ok(!(await page.getByTestId('account.error').textContent()).includes(sentinel));
      await page.getByTestId('account.form').waitFor(); assert.equal((await input.inputValue()) === '', true, 'TOKEN_NOT_CLEARED');
    }
    record.flags.fixedRefusals = true;
    // Explicit confirmation remains in flight after navigation; no cancellation may undo this authority.
    stage = 'confirm-navigation';
    await input.fill(sentinel); await input.press('Enter'); await page.getByTestId('account.cancel').waitFor(); await settle(candidate);
    await expect(page.locator('#upload-confirm-heading')).toBeFocused();
    assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).confirm, 0);
    assert.equal(await page.getByTestId('account.firstSync').count(), 0);
    await page.keyboard.press('Tab'); await expect(page.getByTestId('account.confirm')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByTestId('account.cancel')).toBeFocused();
    await page.getByTestId('account.confirm').click();
    await expect(page.getByTestId('account.phase')).toHaveText('Finishing connection…');
    assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).confirm, 1);
    await page.getByTestId('fixture.journal').click(); await settle(connected);
    await page.getByTestId('shell.status.sync').click(); await page.getByTestId('account.disconnect').waitFor(); record.flags.chipNavigation = true;
    assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).cancel, 2); record.flags.confirmNavigation = true;
    stage = 'disconnect';
    // ET-110: Disconnect first asks inline; Escape and Cancel close the question without a call and return focus.
    assert.equal(await page.getByTestId('account.form').count(), 0);
    const question = page.locator('#upload-disconnect-question'), disconnectCount = async () => (await application.evaluate(() => globalThis.uploadUiFixture.counts)).disconnect;
    await page.getByTestId('account.disconnect').focus(); await page.keyboard.press('Enter');
    await page.getByTestId('account.disconnect.prompt').waitFor(); await expect(question).toBeFocused();
    await page.keyboard.press('Escape'); await page.getByTestId('account.disconnect.prompt').waitFor({state: 'detached'});
    await expect(page.getByTestId('account.disconnect')).toBeFocused(); assert.equal(await disconnectCount(), 0);
    await page.keyboard.press('Enter'); await expect(question).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByTestId('account.disconnect.confirm')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByTestId('account.disconnect.cancel')).toBeFocused();
    await page.keyboard.press('Enter'); await page.getByTestId('account.disconnect.prompt').waitFor({state: 'detached'});
    await expect(page.getByTestId('account.disconnect')).toBeFocused(); assert.equal(await disconnectCount(), 0);
    await page.keyboard.press('Enter'); await page.getByTestId('account.disconnect.confirm').click();
    await page.getByTestId('account.form').waitFor(); await expect(input).toBeFocused();
    assert.equal(await disconnectCount(), 1);
    assert.equal(await input.inputValue(), ''); assert.equal(await page.getByTestId('account.firstSync').count(), 0);
    stage = 'confirm-notification-before-reply-focus';
    for (const result of [connected, {...connected, state: 'paused', error: 'NETWORK'}]) {
      await publish(candidate); await expect(page.locator('#upload-confirm-heading')).toBeFocused();
      await page.getByTestId('fixture.confirmation.gate').evaluate(node => node.click());
      await page.getByTestId('account.confirm').click(); await expect(page.getByTestId('account.phase')).toHaveText('Finishing connection…');
      await settle(result);
      const resultHeading = page.getByTestId('account.status').locator('h2');
      await expect(resultHeading).toBeFocused(); await expect(page.getByTestId('account.disconnect')).toBeDisabled();
      assert.equal(await page.getByTestId('account.form').count(), 0);
      await page.getByTestId('fixture.confirmation.gate').evaluate(node => node.click());
      // A working connection offers no token entry once the reply settles; focus stays on the result.
      await expect(page.getByTestId('account.disconnect')).toBeEnabled(); await expect(resultHeading).toBeFocused();
      assert.equal(await page.getByTestId('account.form').count(), 0);
    }
    await publish(base); await page.getByTestId('account.form').waitFor();
    stage = 'security';
    record.security = await application.evaluate(({BrowserWindow}) => {const window = BrowserWindow.getAllWindows()[0], p = window.webContents.getLastWebPreferences(); return {sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, persistentSession: window.webContents.session.isPersistent(), localDocument: window.webContents.getURL().startsWith('file:')};});
    assert.deepEqual(record.security, {sandbox: true, contextIsolation: true, nodeIntegration: false, persistentSession: false, localDocument: true});
    assert.equal(await page.evaluate(() => typeof globalThis.require === 'undefined' && typeof globalThis.process === 'undefined'), true);
    assert.deepEqual(await page.evaluate(() => Object.keys(globalThis.uploadUi).sort()), ['cancelDashboardUpload', 'confirmDashboardUpload', 'disconnectDashboardUpload', 'getDashboardUploadContext', 'listJournalTrips', 'subscribeDashboardUpload', 'verifyDashboardUploadToken']);
    assert.equal(await page.evaluate(() => typeof globalThis.desktop === 'undefined'), true); record.flags.bridgeIsolation = true;
    assert.equal(await application.evaluate(async ({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('Notification.requestPermission()', true)), 'denied');
    assert.ok(await application.evaluate(() => globalThis.uploadUiFixture.denied.permissions > 0)); record.security.permissionsDenied = true;
    record.security.remoteFetchDenied = await page.evaluate(async () => {try {await globalThis.fetch('https://example.invalid'); return false;} catch {return true;}});
    assert.equal(record.security.remoteFetchDenied, true);
    for (const language of ['en', 'ru']) {
      if (language === 'ru') await page.getByTestId('fixture.language').click();
      for (const size of [{width: 1280, height: 800}, {width: 1100, height: 720}]) {
        await page.setViewportSize(size);
        for (const screen of UPLOAD_UI_SCREENS) {
          stage = `${screen}-${language}-${size.width}`;
          await page.getByTestId('fixture.account').click();
          await publish(screen === 'no-token' ? base : screen === 'confirmation' ? candidate : screen === 'offline' ? {...connected, state: 'paused', error: 'NETWORK', progress: {...connected.progress, enumeration: 'changing'}} : connected);
          if (screen === 'journal') {await page.getByTestId('fixture.journal').click(); await page.getByTestId('fixture.rows').waitFor(); assert.equal(await page.getByTestId('journal-row-sync').count(), 8); record.flags.rowStates = true;}
          else if (screen === 'confirmation') await page.getByTestId('account.confirmation').waitFor();
          else if (screen === 'no-token') await page.getByTestId('account.form').waitFor();
          else await page.getByTestId('account.firstSync').waitFor();
          // ET-110: a recount in progress ('changing') keeps the last known totals and bar while offline.
          if (screen === 'offline') {
            await expect(page.getByTestId('account.sync.detail')).toContainText(language === 'en' ? 'Sent 2 of 10.' : 'Отправлено 2 из 10.');
            assert.equal(await page.locator('.yu-account progress').getAttribute('value'), '20');
          }
          stage = `${screen}-${language}-${size.width}-token-clear`;
          const token = page.getByTestId('account.token.input');
          if (await token.count()) {assert.equal((await token.inputValue()) === '', true, 'TOKEN_NOT_CLEARED'); assert.equal(await token.getAttribute('type'), 'password');}
          assert.equal(await page.evaluate(value => globalThis.document.body.innerText.includes(value) || [...globalThis.document.querySelectorAll('input')].some(node => node.value.includes(value)), sentinel), false);
          stage = `${screen}-${language}-${size.width}-containment`;
          assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth && [...globalThis.document.querySelectorAll('.yu-account dd, .yu-account button, .yu-account [data-slot="badge"]')].every(node => node.scrollWidth <= node.clientWidth)), true); record.flags.contained = true;
          stage = `${screen}-${language}-${size.width}-capture`;
          await page.getByTestId('fixture.content').evaluate(node => {node.scrollTop = 0;});
          if (screen === 'first-upload') await page.getByTestId('account.firstSync').scrollIntoViewIfNeeded();
          const file = `ui-upload-${screen}-${language}-${size.width}x${size.height}.png`;
          await page.screenshot({path: path.join(config.output, file), timeout: 5000});
          progress('screenshot-saved', file);
          const bytes = await readFile(path.join(config.output, file));
          record.screenshots.push({file, screen, language, ...size, imageWidth: bytes.readUInt32BE(16), imageHeight: bytes.readUInt32BE(20), bytes: bytes.length, tokenCleared: true});
        }
        stage = `additional-states-${language}-${size.width}`;
        await page.getByTestId('fixture.account').click();
        for (const status of [
          {...connected, state: 'paused', progress: {...connected.progress, pressure: true}},
          {...connected, state: 'paused', error: 'AUTHENTICATION'},
          {...base, state: 'connecting', error: 'TIMEOUT', owner, candidateId: candidate.candidateId},
          {...base, state: 'disconnected', error: 'CANCELLED'}
        ]) {
          const auth = status.error === 'AUTHENTICATION';
          await publish(status); await expect(page.getByTestId('account.phase')).toHaveText(status.state === 'connecting' ? (language === 'en' ? 'Connecting…' : 'Подключение…')
            : auth ? (language === 'en' ? 'The token no longer works' : 'Токен больше не действует') : status.state === 'paused' ? (language === 'en' ? 'Connected to the Dashboard' : 'Подключено к Dashboard')
            : (language === 'en' ? 'Not connected' : 'Не подключено'));
          // A connection shows its authentication failure as the state with the replacement field, never a notice.
          if (auth) {await page.getByTestId('account.status').getByTestId('account.form').waitFor(); assert.equal(await page.getByTestId('account.error').count(), 0);}
          else if (status.error) await page.getByTestId('account.error').waitFor();
          if (status.progress.pressure) await expect(page.getByTestId('account.firstSync')).toContainText(language === 'en' ? 'The upload queue is full' : 'Очередь отправки заполнена');
        }
        const longOwner = {...owner, accountId: 'a'.repeat(128), companyId: 'c'.repeat(128), identityEpoch: 'e'.repeat(128)};
        for (const status of [{...candidate, owner: longOwner}, {...connected, owner: longOwner}]) {
          await publish(status);
          // The identifiers of a connection are inside the collapsed details; open them to measure the long values.
          if (!status.candidateId && !(await page.getByTestId('account.details').evaluate(node => node.open))) await page.getByTestId('account.details').locator('summary').click();
          if (!status.candidateId) await expect(page.getByTestId('account.details')).toHaveAttribute('open', '');
          await expect(page.getByTestId('account.owner')).toBeVisible(); await expect(page.getByTestId('account.owner')).toContainText(longOwner.identityEpoch);
          for (const zoom of [1, 1.5, 2]) {
            await application.evaluate(({BrowserWindow}, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
            assert.equal(await page.getByTestId('fixture.content').evaluate(node => node.scrollWidth <= node.clientWidth), true, `UPLOAD_ZOOM_OVERFLOW_${language}_${size.width}_${zoom}`);
            assert.equal(await page.locator('.yu-account dd, .yu-account button, .yu-account p').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true, 'UPLOAD_LONG_VALUE_OVERFLOW');
            if (status.candidateId) {await page.getByTestId('account.cancel').focus(); await expect(page.getByTestId('account.cancel')).toBeFocused();}
            else {await page.getByTestId('account.disconnect').focus(); await expect(page.getByTestId('account.disconnect')).toBeFocused();}
          }
          await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
        }
      }
      // ET-110: the sync button chip is exactly as tall as a production badge chip (24 px) in both themes and at zoom.
      await page.setViewportSize({width: 1280, height: 800}); await page.getByTestId('fixture.account').click();
      for (const status of [connected, {...connected, progress: {...connected.progress, identityPendingSources: 0, heldSources: 0}}, {...connected, state: 'paused', error: 'AUTHENTICATION'}]) {
        await publish(status);
        for (const colorScheme of ['dark', 'light']) {
          stage = `chip-height-${language}-${colorScheme}`;
          await page.emulateMedia({colorScheme}); await page.waitForFunction(dark => globalThis.matchMedia('(prefers-color-scheme: dark)').matches === dark, colorScheme === 'dark', {timeout: 5000});
          for (const zoom of [1, 1.5, 2]) {
            await application.evaluate(({BrowserWindow}, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom);
            const heights = await page.evaluate(() => ['shell.status.sync', 'fixture.chip'].map(id => globalThis.document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().height));
            assert.ok(Math.abs(heights[0] - 24) < 0.05 && Math.abs(heights[0] - heights[1]) < 0.05, `UPLOAD_SYNC_CHIP_HEIGHT_${language}_${colorScheme}_${zoom}_${heights.join('_')}`);
          }
          await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
        }
      }
      await page.emulateMedia({colorScheme: null});
    }
    stage = 'stable-progress';
    await page.getByTestId('fixture.account').click(); await publish(connected); await page.getByTestId('account.firstSync').waitFor();
    assert.equal(await page.locator('progress').getAttribute('value'), '20');
    const progressPalette = await page.locator('progress').evaluate(node => {
      const style = globalThis.getComputedStyle(node), probe = globalThis.document.createElement('span');
      node.parentElement.append(probe);
      probe.style.color = 'var(--yu-accent-light)'; const fill = globalThis.getComputedStyle(probe).color;
      probe.style.color = 'var(--yu-border)'; const track = globalThis.getComputedStyle(probe).color;
      probe.remove();
      return {customAppearance: style.appearance === 'none', fillMatchesToken: style.color === fill, trackMatchesToken: style.backgroundColor === track};
    });
    assert.deepEqual(progressPalette, {customAppearance: true, fillMatchesToken: true, trackMatchesToken: true});
    // ET-110: a recount ('changing') keeps the value and the result; only a first count without totals is indeterminate.
    // Progress notifications never move focus from the details disclosure.
    const summary = page.getByTestId('account.details').locator('summary'), title = await page.getByTestId('account.sync.title').textContent();
    await summary.focus(); await expect(summary).toBeFocused();
    await publish({...connected, progress: {...connected.progress, enumeration: 'changing'}}); await publish({...connected, progress: {...connected.progress, enumeration: 'scanning'}});
    assert.equal(await page.locator('progress').getAttribute('value'), '20'); assert.equal(await page.getByTestId('account.sync.title').textContent(), title);
    await publish({...connected, progress: {...connected.progress, identityPendingSources: 0, heldSources: 0, enumeration: 'calculating', distinctSources: null, deliveredSources: null}});
    await page.waitForFunction(() => {const bar = globalThis.document.querySelector('.yu-account progress'); return !!bar && !bar.hasAttribute('value');}); record.flags.progress = true;
    await expect(summary).toBeFocused();
    assert.equal(await page.getByTestId('account.token.input').count(), 0);
    for (const recoverable of [connected, {...connected, state: 'paused', error: 'NETWORK'}]) {
      await publish(recoverable); await page.getByTestId('account.firstSync').waitFor(); assert.equal(await page.getByTestId('account.token.input').count(), 0);
    }
    for (const connection of ['AUTHENTICATION', 'CREDENTIAL_UNAVAILABLE']) {
      stage = `cancel-held-replacement-${connection}`;
      await publish({...connected, state: 'paused', error: connection}); await page.getByTestId('account.status').getByTestId('account.form').waitFor();
      const before = await application.evaluate(() => ({...globalThis.uploadUiFixture.counts}));
      await page.getByTestId('fixture.verification.gate').evaluate(node => node.click());
      await page.getByTestId('account.token.input').fill(sentinel); await page.getByTestId('account.token.input').press('Enter');
      await expect(page.getByTestId('account.phase')).toHaveText('Проверка токена…');
      await expect(page.getByTestId('account.status')).toBeVisible();
      await expect(page.getByTestId('account.cancel')).toBeEnabled(); await expect(page.getByTestId('account.disconnect')).toBeDisabled();
      assert.equal(await page.getByTestId('account.token.input').count(), 0);
      assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).verify, before.verify);
      await page.getByTestId('account.cancel').click(); await expect(page.getByTestId('account.cancel')).toBeDisabled();
      assert.equal((await application.evaluate(() => globalThis.uploadUiFixture.counts)).cancel, before.cancel);
      await page.getByTestId('fixture.verification.gate').evaluate(node => node.click());
      await expect.poll(() => application.evaluate(() => globalThis.uploadUiFixture.pendingKind), {timeout: 5000}).toBe('verify');
      await settle(candidate); await page.getByTestId('account.form').waitFor();
      const after = await application.evaluate(() => globalThis.uploadUiFixture.counts);
      assert.deepEqual(after, {...before, verify: before.verify + 1, cancel: before.cancel + 1});
      assert.equal(await page.getByTestId('account.confirmation').count(), 0);
      assert.equal(await page.getByTestId('account.token.input').inputValue(), '');
    }
    await publish({...connected, state: 'paused', error: 'AUTHENTICATION'}); await page.getByTestId('account.status').getByTestId('account.form').waitFor();
    stage = 'replacement-token';
    const previousCounts = await application.evaluate(() => ({...globalThis.uploadUiFixture.counts}));
    await page.getByTestId('account.token.input').fill(sentinel); await page.getByTestId('account.token.input').press('Enter');
    await page.getByTestId('account.cancel').waitFor(); await settle(candidate); await page.getByTestId('account.confirmation').waitFor();
    const replacementCounts = await application.evaluate(() => globalThis.uploadUiFixture.counts);
    assert.equal(replacementCounts.verify, previousCounts.verify + 1); assert.equal(replacementCounts.confirm, previousCounts.confirm);
    await page.getByTestId('account.cancel').click(); await page.getByTestId('account.form').waitFor();
    await page.getByTestId('fixture.journal').click(); await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('data-testid') === 'screen-title'); record.flags.headingFocus = true;
    stage = 'navigation-security';
    const beforeUrl = page.url(); await page.evaluate(() => {const a = globalThis.document.createElement('a'); a.href = 'https://example.invalid'; globalThis.document.body.append(a); a.click(); a.remove();});
    await expect.poll(() => application.evaluate(() => globalThis.uploadUiFixture.denied.navigation), {timeout: 5000}).toBe(1);
    assert.equal(page.url(), beforeUrl); record.security.navigationDenied = true;
    await page.evaluate(() => {globalThis.window.open('https://example.invalid');}); await expect.poll(() => application.evaluate(() => globalThis.uploadUiFixture.denied.newWindow), {timeout: 5000}).toBe(1); assert.equal(application.windows().length, 1); record.security.newWindowDenied = true;
    assert.deepEqual(errors, []); for (const flag of UPLOAD_UI_FLAGS) assert.equal(record.flags[flag], true, flag);
    record.passed = true;
    return record;
  } catch (error) {
    const diagnostic = await application.evaluate(() => ({state: globalThis.uploadUiFixture.status.state, pending: globalThis.uploadUiFixture.pendingKind, counts: globalThis.uploadUiFixture.counts})).catch(() => null);
    const page = application.windows()[0];
    const dom = page ? await page.evaluate(() => ({phase: globalThis.document.querySelector('[data-testid="account.phase"]')?.textContent, hasForm: !!globalThis.document.querySelector('[data-testid="account.form"]'), title: globalThis.document.querySelector('[data-testid="screen-title"]')?.textContent})).catch(() => null) : null;
    await writeFile(path.join(config.output, 'upload-ui-diagnostic.json'), JSON.stringify({stage, diagnostic, dom}, null, 2));
    const name = /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error'; throw Error(`UPLOAD_UI_FIXTURE_FAILED_${stage}_${name}`, {cause: error});} finally {await application.close();}
}
