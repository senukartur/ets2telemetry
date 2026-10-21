// ET-028: bounded visual shards against the production renderer, fixed bridge and isolated synthetic sources.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, writeFile, rename, mkdir, rmdir} from 'node:fs/promises';
import {screen, settingsPanel, chooseLanguage} from './ui-navigation.mjs';
import {until} from './lifecycle-observation.mjs';
import {overlayOverflow} from './renderer-observation.mjs';

export const UI_CASES = ['shell', 'live', 'journal', 'settings', 'overlay'];
const sizes = [{width: 1280, height: 800}, {width: 1100, height: 720}];
const panels = ['general', 'units', 'overlay', 'sections', 'plugin', 'data', 'about'];
const layouts = ['strip', 'card', 'cluster', 'hud'];
const dimensions = {strip: {width: 1280, height: 116}, card: {width: 300, height: 384}, cluster: {width: 440, height: 267}, hud: {width: 320, height: 354}};
const waitState = (page, state) => until(() => page.getByTestId('telemetry-status').innerText(), value => value.startsWith(`${state}:`), `UI_LIVE_${state}`, 5000);
async function settled(page) {await page.evaluate(async () => {await globalThis.document.fonts.ready;});}
async function capture({page, application, config, record, name, language, size, overlay = false}) {
  const file = `ui-${config.uiCase}-${name}-${language}-${size.width}x${size.height}.png`;
  await settled(page);
  if (overlay) {
    const png = await application.evaluate(async ({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay'));
      return (await window.webContents.capturePage(undefined, {stayHidden: true, stayAwake: true})).toPNG().toString('base64');
    });
    await writeFile(path.join(config.output, file), Buffer.from(png, 'base64'));
  } else await page.screenshot({path: path.join(config.output, file), timeout: 5000});
  const bytes = await readFile(path.join(config.output, file));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG'); assert.ok(bytes.length > 500);
  record.screenshots.push({file, language, width: size.width, height: size.height, screen: name,
    imageWidth: bytes.readUInt32BE(16), imageHeight: bytes.readUInt32BE(20), bytes: bytes.length});
}
async function resize(page, size) {
  await page.setViewportSize(size);
  assert.deepEqual(await page.evaluate(() => ({width: globalThis.innerWidth, height: globalThis.innerHeight})), size);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, 'UI_SHELL_HORIZONTAL_OVERFLOW');
}
async function focusRoute(page, route) {
  const changed = await page.getByTestId(`tab-${route}`).getAttribute('aria-current') !== 'page';
  await screen(page, route);
  assert.equal(await page.getByTestId(`tab-${route}`).getAttribute('aria-current'), 'page');
  if (changed) await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('data-testid') === 'screen-title', undefined, {timeout: 5000});
}
export async function runUiSmoke({application, dashboard, overlay, source, config, record}) {
  assert.ok(UI_CASES.includes(config.uiCase));
  Object.assign(record, {case: config.uiCase, screenshots: [], languages: [], sizes, flags: {}});
  const save = (name, language, size, page = dashboard) => capture({page, application, config, record, name, language, size, overlay: page === overlay});
  // The source selector remains a working diagnostic control, not an invented reference-screen toolbar.
  if (source) await waitState(dashboard, 'connected');
  for (const language of ['en', 'ru']) {
    await chooseLanguage(dashboard, language); record.languages.push(language);
    assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.language, language);
    for (const size of sizes) {
      await resize(dashboard, size);
      if (config.uiCase === 'shell') {
        for (const route of ['live', 'journal', 'settings', 'account']) {
          await focusRoute(dashboard, route); await save(route, language, size);
        }
        await focusRoute(dashboard, 'live');
        assert.equal(await dashboard.getByTestId('journal').count(), 0);
        const trigger = dashboard.getByTestId('shell.language'); await trigger.focus(); await dashboard.keyboard.press('Enter');
        await dashboard.getByTestId(`shell.language.${language}`).waitFor({state: 'visible'});
        await dashboard.keyboard.press('Escape');
        assert.equal(await trigger.evaluate(node => node === globalThis.document.activeElement), true);
        assert.equal(await dashboard.getByTestId('exit-application').isEnabled(), true);
        Object.assign(record.flags, {navigation: true, headingFocus: true, journalUnmount: true, menuKeyboard: true, exitAvailable: true, laterAccount: true});
      } else if (config.uiCase === 'live') {
        await screen(dashboard, 'live');
        assert.equal(await dashboard.getByTestId('speed').innerText(), language === 'en' ? 'Speed: 90.0 km/h' : 'Скорость: 90.0 км/ч');
        for (const [id, text] of [['cargo', 'Synthetic Cargo'], ['source-city', 'Synthetic City A'], ['source-company', 'Synthetic Company A'], ['destination-city', 'Synthetic City B'], ['destination-company', 'Synthetic Company B'], ['truck', 'truck.volvo']]) {
          assert.equal(await dashboard.getByTestId(`live-${id}`).innerText(), text);
        }
        assert.equal(await dashboard.locator('[data-testid="live.trip"] dd').allTextContents().then(values => values.every(value => value === '—')), true);
        assert.ok(await dashboard.getByTestId('live.instrument.gauge').getByRole('img').getAttribute('aria-label'));
        const jobVisible = await dashboard.evaluate(() => {
          const content = globalThis.document.querySelector('[data-testid="shell.content"]'), outer = content.getBoundingClientRect();
          return ['[data-testid="live.job"] h2', '[data-testid="live.job.origin"]', '[data-testid="live.job.destination"]'].every(selector => {
            const node = globalThis.document.querySelector(selector), box = node.getBoundingClientRect();
            return globalThis.getComputedStyle(node).visibility === 'visible' && box.width > 0 && box.height > 0 && box.top >= outer.top && box.bottom <= Math.min(outer.bottom, globalThis.innerHeight) && box.left >= outer.left && box.right <= outer.right;
          }) && content.scrollTop === 0;
        });
        assert.equal(jobVisible, true, `UI_JOB_NOT_READABLE_WITHOUT_SCROLL_${language}_${size.width}`); record.flags.jobViewport = true;
        assert.equal(await dashboard.locator('[data-testid^="hard-mode-name-"]').evaluateAll(nodes => nodes.length === 12 && nodes.every(node => node.getBoundingClientRect().height >= 32 && node.scrollWidth <= node.clientWidth)), true, `UI_HM_NAMES_OVERFLOW_${language}_${size.width}`); record.flags.hmNamesReadable = true;
        await save('current', language, size);
        source.setReading(0, 0); await until(() => dashboard.getByTestId('speed').innerText(), value => value.includes('0.0'), 'UI_ZERO'); await save('zero', language, size);
        source.setUnavailable(); await until(() => dashboard.getByTestId('speed').innerText(), value => value === (language === 'en' ? 'Speed: unavailable' : 'Скорость: недоступно'), 'UI_MISSING'); await save('missing', language, size);
        source.setReading(25, 73); source.setPaused(true); await waitState(dashboard, 'paused'); await save('paused', language, size);
        source.setPaused(false); await waitState(dashboard, 'connected'); source.hold();
        try {await waitState(dashboard, 'stale'); assert.equal(await dashboard.locator('.yu-gauge-number').textContent(), '—'); await save('stale', language, size);} finally {source.resume();}
        await waitState(dashboard, 'connected');
        Object.assign(record.flags, {numericGauge: true, unavailableVsZero: true, paused: true, staleDashes: true, rawNames: true, unsupportedTrip: true});
      } else if (config.uiCase === 'journal') {
        await screen(dashboard, 'journal');
        await until(() => dashboard.getByTestId('journal-row').count(), count => count === 50, 'UI_JOURNAL_FIRST_PAGE');
        assert.equal(await dashboard.getByTestId('journal-banner').innerText(), language === 'en' ? 'Synthetic test database — never game history' : 'Синтетическая тестовая база — не история игры');
        assert.equal(await dashboard.getByTestId('journal-search-planned').isDisabled(), true);
        assert.ok(await dashboard.getByTestId('journal-row-game').first().evaluate(node => globalThis.getComputedStyle(node).whiteSpace === 'nowrap' && node.getBoundingClientRect().width >= 64));
        await dashboard.locator('[data-testid="journal-table"]').evaluate(node => {node.parentElement.scrollLeft = 0;});
        await save('list', language, size);
        await dashboard.getByTestId('journal-list-next').click(); await until(() => dashboard.getByTestId('journal-list-page').innerText(), text => text.includes('2'), 'UI_JOURNAL_PAGE_TWO');
        const row = dashboard.getByTestId('journal-row').first(), trip = await row.getAttribute('data-trip'); await row.getByTestId('journal-row-open').click();
        await dashboard.getByTestId('journal-detail-title').waitFor({state: 'visible'});
        assert.equal(await dashboard.getByTestId('trip.header').count(), 1); assert.equal(await dashboard.locator('[data-testid="trip.tiles"] > div').count(), 4);
        assert.equal(await dashboard.getByTestId('trip.header.cargo').innerText(), 'Synthetic Cargo');
        await save('trip', language, size);
        await dashboard.getByTestId('journal-back').click(); assert.equal(await dashboard.getByTestId('journal-row').first().getAttribute('data-trip'), trip);
        assert.match(await dashboard.getByTestId('journal-list-page').innerText(), /2/);
        await dashboard.getByTestId('journal-list-previous').click(); await until(() => dashboard.getByTestId('journal-row').first().getAttribute('data-trip'), id => id === '7b000000-0000-4000-8000-000000000001', 'UI_JOURNAL_PAGE_ONE');
        await dashboard.getByTestId('journal-row-open').first().click(); await dashboard.getByTestId('journal-detail-title').waitFor({state: 'visible'});
        for (const tab of ['intervals', 'timeline', 'samples']) {await dashboard.getByTestId(`journal-detail-tab-${tab}`).click(); await dashboard.getByTestId(`journal-${tab === 'timeline' ? 'events' : tab}-loading`).waitFor({state: 'detached'}); await save(tab, language, size);}
        assert.equal(await dashboard.getByTestId('journal-sample-row').count(), 300);
        assert.equal(await dashboard.getByTestId('trip.chart.segment').count(), 1);
        assert.equal(await dashboard.locator('[data-testid="trip.chart"] circle').count(), 300);
        await dashboard.getByTestId('journal-samples-next').click(); await until(() => dashboard.getByTestId('journal-samples-page').innerText(), text => text.includes('2'), 'UI_SAMPLE_PAGE_TWO');
        assert.equal(await dashboard.locator('[data-testid="trip.chart"] circle').count(), 300);
        await dashboard.getByTestId('journal-back').click();
        Object.assign(record.flags, {syntheticBanner: true, pageReturn: true, chartBounded: true, rawTabs: true, searchPlanned: true, tripRegions: true, tableReadable: true});
      } else if (config.uiCase === 'settings') {
        for (const panel of panels) {await settingsPanel(dashboard, panel); await save(panel, language, size);}
        const license = dashboard.getByTestId('settings.about.font-license');
        await license.locator('summary').focus(); await dashboard.keyboard.press('Enter');
        assert.equal(await license.locator('pre').innerText(), await readFile(path.join(config.checkout, 'apps/desktop/src/assets/onest-OFL.txt'), 'utf8'));
        assert.match(await license.locator('pre').getAttribute('data-license-asset'), /onest-OFL[^/]*\.txt$/);
        await dashboard.keyboard.press('Enter'); record.flags.fontLicense = true;
        await settingsPanel(dashboard, 'sections'); assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]').count(), 14);
        await dashboard.getByTestId('overlay-preset-driving-only').click();
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => !state.settings.overlay.sections.cargo, 'UI_SECTIONS_SAVED');
        await settingsPanel(dashboard, 'data'); assert.equal(await dashboard.getByTestId('source-select').isEnabled(), true);
        await settingsPanel(dashboard, 'sections'); assert.equal(await dashboard.getByTestId('overlay-switch-cargo').getAttribute('data-state'), 'unchecked');
        await dashboard.getByTestId('overlay-switch-cargo').focus(); await dashboard.keyboard.press('Space');
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.overlay.sections.cargo, 'UI_SWITCH_KEYBOARD_SAVED');
        if (language === 'en' && size.width === 1280) {
          const sections = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.sections;
          await dashboard.evaluate(sections => globalThis.desktop.setOverlaySections(Object.fromEntries(Object.keys(sections).map(id => [id, id === 'speed']))), sections);
          await until(() => dashboard.getByTestId('overlay-switch-speed').isDisabled(), disabled => disabled, 'UI_LAST_SECTION_DISABLED');
          assert.equal(await dashboard.getByTestId('overlay-switch-speed').getAttribute('data-state'), 'checked');
          assert.equal(await dashboard.getByTestId('overlay-last-section').isVisible(), true);
          assert.equal(await dashboard.getByTestId('overlay-switch-rpm').isEnabled(), true); record.flags.lastEnabled = true;
        }
        await dashboard.getByTestId('overlay-preset-everything').click(); await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => Object.values(state.settings.overlay.sections).every(Boolean), 'UI_ALL_SECTIONS_SAVED');
        // A plain directory at the isolated settings file path deliberately refuses a save; no real settings are touched.
        const settingsFile = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json'), backup = `${settingsFile}.ui-original`;
        assert.ok(!path.relative(config.output, settingsFile).startsWith('..'));
        const bytes = await readFile(settingsFile), before = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.units.ets2;
        const wanted = before === 'metric' ? 'us-customary' : 'metric';
        await rename(settingsFile, backup); await mkdir(settingsFile);
        try {
          await settingsPanel(dashboard, 'units'); await dashboard.locator(`#units-ets2-${wanted}`).focus(); await dashboard.keyboard.press('Space');
          record.flags.controlsKeyboard = true;
          await dashboard.getByTestId('settings-error').waitFor({state: 'visible', timeout: 5000});
          assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.units.ets2, before);
          assert.equal(await dashboard.locator(`#units-ets2-${before}`).getAttribute('aria-checked'), 'true');
          assert.equal(await dashboard.locator(`#units-ets2-${wanted}`).getAttribute('aria-checked'), 'false');
          await save('save-error', language, size);
        } finally {await rmdir(settingsFile); await rename(backup, settingsFile);}
        assert.deepEqual(await readFile(settingsFile), bytes);
        await dashboard.locator(`#units-ets2-${wanted}`).click();
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.units.ets2 === wanted && state.settings.saveError === null, 'UI_SAVE_RECOVERED');
        await dashboard.locator(`#units-ets2-${before}`).click();
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.units.ets2 === before && state.settings.saveError === null, 'UI_PROFILE_RESTORED');
        record.flags.refusedSave = true;
        await settingsPanel(dashboard, 'about'); await dashboard.getByTestId('uninstall-button').click(); await dashboard.getByTestId('uninstall-result').waitFor({state: 'visible'});
        assert.ok((await dashboard.getByTestId('uninstall-result').innerText()).includes(language === 'en' ? 'installed copy' : 'установленной копии'));
        Object.assign(record.flags, {allPanels: true, allSections: true, committedSave: true, sourceSelector: true, uninstallRefusal: true});
      } else {
        for (const layout of layouts) {
          await settingsPanel(dashboard, 'overlay'); await dashboard.locator(`#overlay-layout-${layout}`).click();
          await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.overlay.layout === layout, 'UI_LAYOUT_SAVED');
          await application.evaluate(({BrowserWindow}, size) => {const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay')); window.webContents.setZoomFactor(1); window.setContentSize(size.width, size.height);}, dimensions[layout]);
          await overlay.waitForFunction(layout => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-layout') === layout, layout, {timeout: 5000});
          const overflow = await overlay.evaluate(overlayOverflow); assert.deepEqual(overflow.outside, []);
          assert.deepEqual(await overlay.evaluate(() => ({html: globalThis.getComputedStyle(globalThis.document.documentElement).backgroundColor, body: globalThis.getComputedStyle(globalThis.document.body).backgroundColor})), {html: 'rgba(0, 0, 0, 0)', body: 'rgba(0, 0, 0, 0)'});
          if (layout === 'card') {assert.equal(await overlay.getByTestId('overlay-card-hero').count(), 1); assert.equal(await overlay.getByTestId('overlay-card-hero').getAttribute('data-count'), '3');}
          if (layout === 'cluster') {assert.equal(await overlay.getByTestId('overlay-rpm-arc').getAttribute('stroke-dasharray'), '50.26548245743669 251.32741228718345');}
          await save(layout, language, size, overlay);
          if (size.width === 1280) {
            source.setUnavailable();
            await until(() => overlay.getByTestId('overlay-speed').textContent(), text => text === '—', 'UI_OVERLAY_MISSING');
            await save(`${layout}-missing`, language, size, overlay);
            source.setReading(25, 73); source.setPaused(true); await waitState(dashboard, 'paused');
            await overlay.waitForFunction(() => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-status') === 'paused', undefined, {timeout: 5000});
            await save(`${layout}-paused`, language, size, overlay);
            source.setPaused(false); await waitState(dashboard, 'connected'); source.hold();
            try {
              await overlay.waitForFunction(() => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-freshness') === 'stale', undefined, {timeout: 5000});
              assert.equal(await overlay.getByTestId('overlay-speed').textContent(), '—');
              await save(`${layout}-stale`, language, size, overlay);
            } finally {source.resume();}
            await waitState(dashboard, 'connected');
          }
        }
        Object.assign(record.flags, {fourLayouts: true, transparent: true, contained: true, independentFont: true, missing: true, paused: true, staleDashes: true});
      }
    }
  }
  if (config.uiCase === 'overlay') {
    const all = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.sections;
    await dashboard.evaluate(() => globalThis.desktop.setOverlayLayout('card'));
    await application.evaluate(({BrowserWindow}) => {const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay')); window.setContentSize(300, 360);});
    const ids = ['speed', 'gear', 'rpm'];
    for (let mask = 0; mask < 8; mask++) {
      const selected = ids.filter((_id, index) => (mask & (1 << index)) !== 0);
      await dashboard.evaluate(selected => globalThis.desktop.setOverlaySections(Object.fromEntries(Object.keys(selected.all).map(id => [id, id === 'fuel' || selected.ids.includes(id)]))), {all, ids: selected});
      await overlay.waitForFunction(expected => {
        const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
        return root?.getAttribute('data-layout') === 'card' && [...root.querySelectorAll('[data-testid^="overlay-section-"]')].map(node => node.getAttribute('data-testid').replace('overlay-section-', '')).join(',') === [...expected, 'fuel'].join(',');
      }, selected, {timeout: 5000});
      assert.equal(await overlay.getByTestId('overlay-card-hero').count(), selected.length ? 1 : 0);
      for (const id of ids) assert.equal(await overlay.getByTestId(`overlay-section-${id}`).count(), selected.includes(id) ? 1 : 0);
      assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, []);
    }
    await dashboard.evaluate(all => globalThis.desktop.setOverlaySections(all), all);
    record.flags.heroSubsets = true;
  }
  record.flags.bilingual = true; record.flags.bothSizes = true;
  assert.deepEqual(await dashboard.evaluate(() => ({require: typeof globalThis.require, process: typeof globalThis.process})), {require: 'undefined', process: 'undefined'});
  record.flags.security = true;
  const recording = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).health.recording.state;
  const tone = recording === 'recording' ? 'ok' : ['opening', 'waiting', 'paused'].includes(recording) ? 'warn' : ['interrupted', 'retrying', 'stopped'].includes(recording) ? 'error' : 'neutral';
  assert.equal(await dashboard.getByTestId('shell.recording.indicator').getAttribute('data-tone'), tone);
  record.flags.recordingIndicator = true;
  record.flags.offlineFonts = await dashboard.evaluate(() => [...globalThis.document.fonts].some(font => font.family.includes('Onest')));
  assert.equal(record.flags.offlineFonts, true);
  await chooseLanguage(dashboard, 'en'); await screen(dashboard, 'live');
}

/** Newer-version settings deliberately retain the existing EN fallback; there is no forced language override. */
export async function runUiReadOnly({application, dashboard, config, record, settingsBytes}) {
  const settings = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings;
  assert.equal(settings.state, 'newer-version'); assert.equal(settings.writable, false); assert.equal(settings.language, 'en');
  for (const size of sizes) {
    await resize(dashboard, size);
    await settingsPanel(dashboard, 'general');
    assert.equal(await dashboard.locator('#language-ru').isDisabled(), true);
    await settingsPanel(dashboard, 'units');
    for (const game of ['ets2', 'ats']) for (const profile of ['metric', 'us-customary']) assert.equal(await dashboard.locator(`#units-${game}-${profile}`).isDisabled(), true);
    await capture({page: dashboard, application, config, record, name: 'read-only', language: 'en', size});
    await settingsPanel(dashboard, 'overlay');
    for (const layout of layouts) assert.equal(await dashboard.locator(`#overlay-layout-${layout}`).isDisabled(), true);
    assert.equal(await dashboard.getByTestId('overlay-edit-start').isDisabled(), true);
    await settingsPanel(dashboard, 'sections');
    assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]:disabled').count(), 14);
  }
  const file = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json');
  assert.equal(await readFile(file, 'utf8'), settingsBytes);
  record.readOnly = {state: settings.state, writable: settings.writable, language: settings.language, bytesUnchanged: true};
  record.flags.readOnly = true;
}
