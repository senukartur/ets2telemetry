import {dashboardObservation} from './dashboard-observation.mjs';
// ET-028: bounded visual shards against the production renderer, fixed bridge and isolated synthetic sources.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, writeFile, rename, mkdir, rmdir} from 'node:fs/promises';
import {screen, settingsPanel, chooseLanguage} from './ui-navigation.mjs';
import {until} from './lifecycle-observation.mjs';
import {clusterCentreProbe, overlayOverflow, stripNumberProbe, zeroLiveObservation} from './renderer-observation.mjs';
import {stubSaveDialog} from './journal-observation.mjs';
import {pluginActionResult} from './plugin-fixture.mjs';

export const UI_CASES = ['shell', 'live', 'journal', 'settings', 'overlay'];
const sizes = [{width: 1280, height: 800}, {width: 1100, height: 720}];
const panels = ['general', 'units', 'overlay', 'plugin', 'data', 'about'];
const layouts = ['strip', 'card', 'cluster', 'hud'];
const dimensions = {strip: {width: 1280, height: 116}, card: {width: 300, height: 384}, cluster: {width: 440, height: 267}, hud: {width: 320, height: 354}};
const waitState = (page, state) => until(() => page.getByTestId('telemetry-status').innerText(), value => value.startsWith(`${state}:`), `UI_LIVE_${state}`, 5000);
// A committed main-process value may precede React's rendered switch and pending-save controls.
function waitOverlayVisibility(page, {enabled, writable = true, saveError = null, errorVisible}, message, timeoutMs) {
  return until(() => page.evaluate(async () => {
    const state = await globalThis.desktop.getAppState();
    const switches = globalThis.document.querySelectorAll('[data-testid="overlay-enabled"]'), visibility = switches[0];
    const edit = globalThis.document.querySelector('[data-testid="overlay-edit-start"]');
    const error = globalThis.document.querySelector('[data-testid="overlay-settings-error"]');
    return {state, count: switches.length, rendered: visibility?.getAttribute('data-state'),
      interactable: Boolean(visibility && !visibility.disabled), editEnabled: Boolean(edit && !edit.disabled),
      errorShown: Boolean(error && error.getClientRects().length && globalThis.getComputedStyle(error).visibility === 'visible')};
  }), observed => observed.count === 1 && observed.state.settings.overlay.enabled === enabled && observed.state.settings.writable === writable &&
    observed.state.settings.saveError === saveError && observed.rendered === (enabled ? 'checked' : 'unchecked') &&
    observed.interactable === writable && observed.editEnabled === (writable && enabled) &&
    (errorVisible === undefined || observed.errorShown === errorVisible), message, timeoutMs);
}
async function settled(page) {await page.evaluate(async () => {await globalThis.document.fonts.ready;});}
// Isolated CSS display probe only: it does not exercise committed y, native drag or game authority.
function cssDisplayGeometry() {
  const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
  const content = root.querySelector('[data-testid="overlay-content"]');
  const original = {style: content.getAttribute('style'), anchor: content.getAttribute('data-anchor-y')};
  const capacity = root.getBoundingClientRect(), results = [];
  try {
    for (const y of [0, 0.5, 1]) {
      content.style.top = y * 100 + '%'; content.style.transform = 'translateY(-' + y * 100 + '%)'; content.setAttribute('data-anchor-y', String(y));
      const box = content.getBoundingClientRect(), expected = capacity.top + (capacity.height - box.height) * y;
      results.push({y, capacityHeight: capacity.height, paintedHeight: box.height, top: box.top, expected,
        aligned: box.height > 0 && box.height <= capacity.height && Math.abs(box.top - expected) <= 1});
    }
  } finally {
    if (original.style === null) content.removeAttribute('style'); else content.setAttribute('style', original.style);
    if (original.anchor === null) content.removeAttribute('data-anchor-y'); else content.setAttribute('data-anchor-y', original.anchor);
  }
  return {results, restored: content.getAttribute('style') === original.style && content.getAttribute('data-anchor-y') === original.anchor};
}
// ET-045d stable numbers and Cluster containment. The probes write texts into the rendered overlay and restore them
// (renderer-observation.mjs); the zoom and window frames are the overlay's 50/100/200% scales at the layout's sizes.
const SPEED_UNITS = {en: ['km/h', 'mph'], ru: ['км/ч', 'миль/ч']}, RPM_UNIT = {en: 'rpm', ru: 'об/мин'};
const STRIP_FRAMES = [{zoom: 1, width: 1280, height: 116}, {zoom: 0.5, width: 640, height: 120}, {zoom: 2, width: 1000, height: 720}];
const CLUSTER_FRAMES = [{zoom: 0.5, width: 220, height: 135}, {zoom: 1, width: 440, height: 267}, {zoom: 2, width: 880, height: 534}];
function stripSteps(speedUnit, rpmUnit) {
  return [{speed: '0', speedUnit, gear: 'N', rpm: '0', rpmUnit}, ...['9', '10', '99', '100', '-5', '—'].map(speed => ({speed})),
    ...['1', '9', '10', '12', 'R1'].map(gear => ({gear})), ...['999', '1000', '2528', '9999', '—'].map(rpm => ({rpm}))];
}
function clusterSteps(parts, speedUnit, rpmUnit) {
  const base = {...(parts.includes('speed') ? {speedUnit} : {}), ...(parts.includes('rpm') ? {rpmUnit} : {})}, steps = [];
  if (parts.includes('rpm')) steps.push(...['999', '1000', '2528', '9999'].map(rpm => ({...base, rpm})));
  if (parts.includes('gear')) steps.push(...['N', '12', 'R1'].map(gear => ({...base, gear})));
  if (parts.includes('speed')) steps.push(...['100', '-5', '—'].map(speed => ({...base, speed})));
  if (parts.length === 3) steps.push({...base, speed: '100', gear: '12', rpm: '9999'});
  return steps;
}
async function overlayFrame(application, overlay, frame) {
  await application.evaluate(({BrowserWindow}, {zoom, width, height}) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay'));
    window.webContents.setZoomFactor(zoom); window.setContentSize(width, height);
  }, frame);
  // The CSS viewport times the zoom is the DIP content size; at a fractional device scale Windows may round it by a pixel.
  await overlay.waitForFunction(({zoom, width, height}) => Math.abs(globalThis.innerWidth * zoom - width) <= 1.5 && Math.abs(globalThis.innerHeight * zoom - height) <= 1.5, frame, {timeout: 5000});
  await settled(overlay);
}
/** Self-contained: every strip section's and the strip row's edges in CSS px. */
function stripBoxes() {
  const boxes = {};
  for (const element of globalThis.document.querySelectorAll('[data-testid^="overlay-section-"], .overlay-strip-row')) {
    const box = element.getBoundingClientRect();
    boxes[element.getAttribute('data-testid') ?? 'row'] = [box.left, box.top, box.right, box.bottom];
  }
  return boxes;
}
const movedBoxes = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(id => !before[id] || !after[id] || before[id].some((edge, index) => Math.abs(edge - after[id][index]) > 0.01));
/** Self-contained: the overlay's speed, gear and RPM texts match `expected` exactly. */
function numberTexts(expected) {
  return Object.entries(expected).every(([id, text]) => globalThis.document.querySelector(`[data-testid="overlay-${id}"]`)?.textContent === text);
}
/** Self-contained: the shown section ids, in order. */
function shownSections() {
  return [...globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]')].map(node => node.getAttribute('data-testid').replace('overlay-section-', '')).join(',');
}
/** Self-contained: the shown section ids, in order, are exactly `expected` (comma-separated). */
function sectionsAre(expected) {
  return [...globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]')].map(node => node.getAttribute('data-testid').replace('overlay-section-', '')).join(',') === expected;
}
/**
 * Runs `body`, then always `restore`. A restore failure after a failed body never replaces the body's own error: it is
 * appended to that error's message. After a passing body a restore failure is thrown as it is.
 */
async function withRestore(body, restore) {
  let result;
  try {result = await body();}
  catch (error) {
    try {await restore();}
    catch (restoreError) {
      if (error instanceof Error) error.message += `; restore also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
    }
    throw error;
  }
  await restore();
  return result;
}
/**
 * The strip at 100%, 50% and 200%: every digit-count step in both unit profiles leaves every section and the row in place,
 * then two real source transitions (9 to 100 km/h, gear 9 to 10, 999 to 1000 rpm) do the same end to end.
 */
async function observeStripNumbers({application, overlay, source, language, record}) {
  record.stableNumbers ??= [];
  await withRestore(async () => {
    for (const frame of STRIP_FRAMES) {
      await overlayFrame(application, overlay, frame);
      for (const speedUnit of SPEED_UNITS[language]) {
        const result = await overlay.evaluate(stripNumberProbe, stripSteps(speedUnit, RPM_UNIT[language]));
        const failed = result.steps.filter(step => step.moved.length || step.truncated.length);
        record.stableNumbers.push({language, zoom: frame.zoom, speedUnit, ok: result.ok, restored: result.restored, steps: result.steps.length, failed});
        assert.equal(result.restored, true, `UI_STRIP_NUMBER_PROBE_NOT_RESTORED_${language}_${frame.zoom}`);
        assert.equal(result.ok, true, `UI_STRIP_NUMBERS_UNSTABLE_${language}_${frame.zoom}_${speedUnit}: ${result.reason ?? JSON.stringify(failed)}`);
      }
    }
    await overlayFrame(application, overlay, STRIP_FRAMES[0]);
    source.setReading(2.5, 73); source.setEngine(999, 9);
    await overlay.waitForFunction(numberTexts, {speed: '9', gear: '9', rpm: '999'}, {timeout: 5000});
    const before = await overlay.evaluate(stripBoxes);
    source.setReading(100 / 3.6, 73); source.setEngine(1000, 10);
    await overlay.waitForFunction(numberTexts, {speed: '100', gear: '10', rpm: '1000'}, {timeout: 5000});
    const moved = movedBoxes(before, await overlay.evaluate(stripBoxes));
    record.stableNumbers.push({language, zoom: 1, transition: '9/9/999 to 100/10/1000', moved});
    assert.deepEqual(moved, [], `UI_STRIP_LIVE_TRANSITION_MOVED_${language}`);
  }, async () => {
    source.setReading(25, 73); source.setEngine(600, -1);
    await overlayFrame(application, overlay, STRIP_FRAMES[0]);
  });
  await overlay.waitForFunction(numberTexts, {speed: '90', gear: 'R1', rpm: '600'}, {timeout: 5000});
  record.flags.stableNumbers = true;
}
/**
 * The Cluster at 50%, 100% and 200% with speed, gear and RPM, then at 100% with RPM alone and with speed and RPM: every
 * centre part stays inside the inner ring in both unit profiles. All sections are restored afterwards.
 */
async function observeClusterCentre({application, dashboard, overlay, language, record}) {
  record.clusterCentre ??= [];
  const check = async (frame, parts) => {
    for (const speedUnit of parts.includes('speed') ? SPEED_UNITS[language] : [undefined]) {
      const result = await overlay.evaluate(clusterCentreProbe, clusterSteps(parts, speedUnit, RPM_UNIT[language]));
      const failed = result.steps.filter(step => step.outside.length || step.truncated.length);
      record.clusterCentre.push({language, zoom: frame.zoom, parts, speedUnit: speedUnit ?? null, ok: result.ok, restored: result.restored, ring: result.ring ?? null, steps: result.steps.length, failed});
      assert.equal(result.restored, true, `UI_CLUSTER_PROBE_NOT_RESTORED_${language}_${frame.zoom}`);
      assert.equal(result.ok, true, `UI_CLUSTER_CENTRE_OUTSIDE_RING_${language}_${frame.zoom}_${parts.join('+')}: ${result.reason ?? JSON.stringify(failed)}`);
    }
  };
  const all = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.sections;
  const shown = await overlay.evaluate(shownSections);
  await withRestore(async () => {
    for (const frame of CLUSTER_FRAMES) {await overlayFrame(application, overlay, frame); await check(frame, ['speed', 'gear', 'rpm']);}
    for (const subset of [['rpm'], ['speed', 'rpm']]) {
      await dashboard.evaluate(({all, subset}) => globalThis.desktop.setOverlaySections(Object.fromEntries(Object.keys(all).map(id => [id, subset.includes(id)]))), {all, subset});
      await overlay.waitForFunction(sectionsAre, subset.join(','), {timeout: 5000});
      await overlayFrame(application, overlay, CLUSTER_FRAMES[1]);
      await check(CLUSTER_FRAMES[1], subset);
    }
  }, async () => {
    await dashboard.evaluate(all => globalThis.desktop.setOverlaySections(all), all);
    await overlayFrame(application, overlay, CLUSTER_FRAMES[1]);
  });
  await overlay.waitForFunction(sectionsAre, shown, {timeout: 5000});
  record.flags.clusterRpmContained = true;
}
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
const EXPORT_RESULT = {
  en: {word: 'Information', title: 'Information — Diagnostics export', message: 'Export cancelled. Nothing was written.'},
  ru: {word: 'Информация', title: 'Информация — Экспорт диагностики', message: 'Экспорт отменён. Ничего не записано.'}
};
const dashboardZoom = (application, zoom) => application.evaluate(({BrowserWindow}, zoom) => {
  BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('?view=overlay')).webContents.setZoomFactor(zoom);
}, zoom);
async function observeSettingsNavigation({dashboard, language, size, zoom, record}) {
  const placements = [];
  for (const panel of ['overlay', ...panels.filter(id => id !== 'overlay')]) {
    await dashboard.getByTestId(`settings.nav.${panel}`).click({timeout: 5000});
    assert.equal(await dashboard.getByTestId(`settings.${panel}`).isVisible(), true);
    const placement = await dashboard.getByTestId('settings.screen').evaluate(grid => new Promise(resolve => globalThis.requestAnimationFrame(() => {
      const bounds = grid.getBoundingClientRect(), nav = grid.firstElementChild.getBoundingClientRect(), content = grid.lastElementChild.getBoundingClientRect();
      resolve({columns: globalThis.getComputedStyle(grid).gridTemplateColumns, nav: {left: nav.left - bounds.left, top: nav.top - bounds.top, width: nav.width, height: nav.height},
        content: {left: content.left - bounds.left, top: content.top - bounds.top}, viewportWidth: globalThis.innerWidth});
    })));
    assert.ok(placement.viewportWidth <= 900, 'UI_SETTINGS_RESPONSIVE_BREAKPOINT');
    assert.equal(placement.columns.split(' ').length, 1, `UI_SETTINGS_SINGLE_COLUMN_${panel}`);
    assert.equal(placement.nav.left, placement.content.left);
    assert.ok(placement.content.top >= placement.nav.top + placement.nav.height);
    if (placements.length) assert.deepEqual(placement, placements[0].placement, `UI_SETTINGS_NAVIGATION_JUMP_${language}_${size.width}_${zoom}_${panel}`);
    placements.push({panel, placement});
  }
  await dashboard.getByTestId('settings.nav.overlay').click({timeout: 5000});
  assert.equal(await dashboard.getByTestId('settings.overlay').isVisible(), true);
  (record.settingsNavigation ??= []).push({language, width: size.width, zoom, placements});
}
async function observeUnifiedOverlay({application, dashboard, language, size, record}) {
  assert.deepEqual(await dashboard.getByTestId('settings.nav').locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid'))), panels.map(id => `settings.nav.${id}`));
  assert.equal(await dashboard.getByTestId('settings.sections').count(), 0);
  assert.equal(await dashboard.getByRole('button', {name: /^(Choose sections|Выбрать секции)$/}).count(), 0);
  assert.equal(await dashboard.getByTestId('overlay-settings').count(), 1);
  assert.equal(await dashboard.locator('[data-testid^="overlay-requirement-"]').count(), 0, 'UI_OVERLAY_TECHNICAL_NOTES_ABSENT');
  const visible = await dashboard.getByTestId('overlay-settings').evaluate(card => {
    const ids = ['overlay-enabled', 'overlay-layout', 'overlay-placement', 'overlay-presets', 'overlay-sections'];
    return ids.every(id => card.querySelector(`[data-testid="${id}"]`)?.checkVisibility()) &&
      card.querySelectorAll('[data-testid^="overlay-switch-"]').length === 14 &&
      [...card.querySelectorAll('[data-testid^="overlay-switch-"]')].every(node => node.checkVisibility());
  });
  assert.equal(visible, true, 'UI_OVERLAY_UNIFIED_CONTROLS');
  record.flags.overlayUnified = true;
  for (const zoom of [1, 1.5, 2]) {
    await dashboardZoom(application, zoom);
    try {
      if (zoom > 1) await observeSettingsNavigation({dashboard, language, size, zoom, record});
      await dashboard.getByTestId('overlay-switch-expected-income').focus();
      await dashboard.keyboard.press('Tab');
      assert.equal(await dashboard.getByTestId('overlay-switch-game-time').evaluate(node => node === globalThis.document.activeElement), true);
      const observation = await dashboard.getByTestId('overlay-settings').evaluate(card => new Promise(resolve => globalThis.requestAnimationFrame(() => {
        const scroll = globalThis.document.querySelector('.yu-content'), bounds = scroll.getBoundingClientRect(), focus = globalThis.document.activeElement.getBoundingClientRect();
        const overflow = [scroll, card, ...card.querySelectorAll('section, label, button:not([role="radio"]):not([role="switch"]), p')]
          .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.getAttribute('data-testid') ?? node.tagName);
        // Radix rails/dots intentionally have expanded pseudo-hit areas; check their boxes, not scrollWidth.
        const controlsContained = [...card.querySelectorAll('button')].every(node => {const box = node.getBoundingClientRect(), parent = card.getBoundingClientRect(); return box.left >= parent.left && box.right <= parent.right;});
        resolve({overflow, controlsContained, scrolled: scroll.scrollTop > 0, focusVisible: focus.width > 0 && focus.left >= bounds.left && focus.right <= bounds.right && focus.top >= bounds.top && focus.bottom <= bounds.bottom});
      })));
      assert.deepEqual(observation.overflow, [], `UI_OVERLAY_OVERFLOW_${language}_${size.width}_${zoom}`);
      assert.equal(observation.controlsContained, true); assert.equal(observation.scrolled, true); assert.equal(observation.focusVisible, true);
      (record.overlayScroll ??= []).push({language, width: size.width, zoom, ...observation});
    } finally {await dashboardZoom(application, 1);}
  }
  record.flags.overlayScroll = true;
}
async function observeOverlayEditing({dashboard, config, record}) {
  const file = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json');
  const initial = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay;
  const bytes = await readFile(file);
  const state = () => dashboard.evaluate(() => globalThis.desktop.getAppState());
  const begin = async () => {
    await dashboard.getByTestId('overlay-edit-start').click();
    await until(state, value => value.overlayEdit.active, 'UI_OVERLAY_EDIT_STARTED');
    for (const layout of layouts) assert.equal(await dashboard.locator(`#overlay-layout-${layout}`).isDisabled(), true);
    assert.equal(await dashboard.getByTestId('overlay-preset-driving-only').isEnabled(), true);
    assert.equal(await dashboard.getByTestId('overlay-switch-cargo').isEnabled(), true);
  };
  const scaleUp = async () => {
    const before = (await state()).overlayEdit.scale;
    await dashboard.getByTestId('overlay-scale-up').click();
    return until(state, value => value.overlayEdit.active && value.overlayEdit.scale > before, 'UI_OVERLAY_SCALE_DRAFT');
  };
  await begin(); await scaleUp(); assert.deepEqual(await readFile(file), bytes);
  await dashboard.getByTestId('overlay-placement-reset').click();
  await until(state, value => value.overlayEdit.active && value.overlayEdit.scale === 1, 'UI_OVERLAY_RESET_DRAFT');
  assert.deepEqual(await readFile(file), bytes);
  await scaleUp(); await dashboard.getByTestId('overlay-edit-cancel').click();
  await until(state, value => !value.overlayEdit.active, 'UI_OVERLAY_CANCELLED');
  assert.deepEqual((await state()).settings.overlay.placements, initial.placements); assert.deepEqual(await readFile(file), bytes);
  await begin(); const draft = await scaleUp();
  await dashboard.getByTestId('overlay-preset-driving-only').focus(); await dashboard.keyboard.press('Enter');
  await until(state, value => !value.settings.overlay.sections.cargo, 'UI_OVERLAY_EDIT_PRESET');
  await dashboard.getByTestId('overlay-switch-cargo').focus(); await dashboard.keyboard.press('Space');
  await until(state, value => value.settings.overlay.sections.cargo, 'UI_OVERLAY_EDIT_SECTION');
  assert.deepEqual((await state()).settings.overlay.placements, initial.placements);
  await dashboard.getByTestId('overlay-edit-done').click();
  await until(state, value => !value.overlayEdit.active && value.settings.overlay.placements[initial.layout].scale === draft.overlayEdit.scale, 'UI_OVERLAY_DONE_SAVED');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).overlay.placements[initial.layout].scale, draft.overlayEdit.scale);
  assert.notDeepEqual(await readFile(file), bytes);
  record.flags.overlayEditing = true;
}
/** The export result has no horizontal overflow and its box lies inside the Game plugin card. */
const exportResultContained = page => page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => {
  const body = globalThis.document.querySelector('[data-testid="plugin-export-diagnostics-result"]'), card = globalThis.document.querySelector('[data-testid="plugin-card"]');
  if (!body || !card) {resolve(false); return;}
  const box = body.getBoundingClientRect(), bounds = card.getBoundingClientRect();
  resolve(body.scrollWidth <= body.clientWidth && box.width > 0 && box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5);
}))));
/**
 * ET-045b: "Export diagnostics…" from the keyboard with a cancelled Save dialog answers beside its button as information,
 * in the selected language, keeps focus on the button and fits the card (at 1100×720 also at zoom 1.5). Nothing is written.
 */
async function observeExportResult({application, dashboard, language, size, record}) {
  await stubSaveDialog(application, {canceled: true, filePath: ''});
  await dashboard.getByTestId('plugin-export-diagnostics').focus(); await dashboard.keyboard.press('Enter');
  const expected = EXPORT_RESULT[language];
  const shown = await until(() => pluginActionResult(dashboard, {slot: 'plugin-export-diagnostics', trigger: 'plugin-export-diagnostics'}),
    value => value?.pending === null && value.message === expected.message, `UI_ACTION_RESULT_${language}_${size.width}`, 5000);
  assert.deepEqual({severity: shown.severity, word: shown.word, title: shown.title, message: shown.message, polite: shown.polite, focused: shown.focused, nextToTrigger: shown.nextToTrigger},
    {severity: 'info', ...expected, polite: true, focused: true, nextToTrigger: true});
  assert.equal(await exportResultContained(dashboard), true, `UI_ACTION_RESULT_OVERFLOW_${language}_${size.width}`);
  if (size.width === 1100) {
    await dashboardZoom(application, 1.5);
    try {assert.equal(await exportResultContained(dashboard), true, `UI_ACTION_RESULT_ZOOM_OVERFLOW_${language}`);} finally {await dashboardZoom(application, 1);}
  }
  record.flags.actionResult = true;
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
        for (const route of ['live', 'hardMode', 'journal', 'settings', 'account']) {
          await focusRoute(dashboard, route); await save(route, language, size);
        }
        assert.deepEqual(await dashboard.locator('.yu-sidebar nav button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid'))), ['tab-live', 'tab-hardMode', 'tab-journal', 'tab-settings', 'tab-account']);
        await dashboard.getByTestId('tab-hardMode').focus(); await dashboard.keyboard.press('Enter');
        await dashboard.waitForFunction(() => globalThis.document.activeElement?.getAttribute('data-testid') === 'screen-title');
        assert.equal(await dashboard.getByTestId('hardMode.screen').isVisible(), true);
        assert.equal(await dashboard.getByTestId('hard-mode-drawer').count(), 0);
        await dashboard.getByTestId('shell.content').evaluate(node => {node.scrollTop = node.scrollHeight;});
        assert.ok(await dashboard.getByTestId('shell.content').evaluate(node => node.scrollTop > 0));
        await dashboard.getByTestId('tab-live').click();
        await dashboard.waitForFunction(() => globalThis.document.activeElement?.getAttribute('data-testid') === 'screen-title');
        assert.equal(await dashboard.getByTestId('shell.content').evaluate(node => node.scrollTop), 0, 'UI_ROUTE_RETAINS_HARD_MODE_SCROLL');
        for (const zoom of [1.5, 2]) {
          await application.evaluate(({BrowserWindow}, zoom) => {BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('?view=overlay')).webContents.setZoomFactor(zoom);}, zoom);
          for (const route of ['live', 'hardMode']) {
            await focusRoute(dashboard, route);
            assert.equal(await dashboard.getByTestId('shell.content').evaluate(node => node.scrollWidth <= node.clientWidth), true, `UI_ZOOM_OVERFLOW_${route}_${zoom}`);
          }
        }
        await application.evaluate(({BrowserWindow}) => {BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('?view=overlay')).webContents.setZoomFactor(1);});
        record.flags.hardModePage = true;
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
        assert.ok(await dashboard.evaluate(dashboardObservation, {speed: language === 'en' ? 'Speed: 90 km/h' : 'Скорость: 90 км/ч', fuel: language === 'en' ? 'Fuel: 73.0 L' : 'Топливо: 73.0 л'}));
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
        assert.equal(await dashboard.getByTestId('live.screen').getByTestId('hard-mode-card').count(), 0);
        assert.equal(await dashboard.getByTestId('live.instrument').evaluate(node => Math.abs(node.getBoundingClientRect().width - node.closest('[data-testid="live-telemetry"]').getBoundingClientRect().width) < 1), true);
        record.flags.fullWidthTelemetry = true;
        await focusRoute(dashboard, 'hardMode');
        assert.equal(await dashboard.getByTestId('hard-mode-checklist').count(), 0);
        assert.equal(await dashboard.getByTestId('hard-mode-drawer').count(), 0);
        assert.equal(await dashboard.locator('[data-testid^="hard-mode-detail-rule-"]').count(), 12);
        assert.equal(await dashboard.locator('[data-testid^="hard-mode-name-"]').evaluateAll(nodes => nodes.length === 12 && nodes.every(node => node.getBoundingClientRect().height >= 32 && node.scrollWidth <= node.clientWidth)), true, `UI_HM_NAMES_OVERFLOW_${language}_${size.width}`); record.flags.hmNamesReadable = true;
        await screen(dashboard, 'live');
        assert.equal(await dashboard.getByTestId('live.instrument.tank').getAttribute('data-state'), 'value');
        assert.equal(await dashboard.locator('.yu-tank i').evaluate(node => node.style.height), '7.3%');
        assert.equal(await dashboard.locator('.yu-tank-unavailable').count(), 0);
        await save('current', language, size);
        source.setReading(0, 0); await dashboard.waitForFunction(zeroLiveObservation, language, {timeout: 5000}); await save('zero', language, size);
        source.setReading(25, 73); source.setCapacity(null);
        await dashboard.waitForFunction(language => globalThis.document.querySelector('[data-testid="live.instrument.tank"]')?.getAttribute('data-state') === 'unavailable' && !globalThis.document.querySelector('.yu-tank i') && globalThis.document.querySelector('.yu-tank-unavailable')?.textContent === '—' && globalThis.document.querySelector('[data-testid="fuel"]')?.textContent === (language === 'en' ? 'Fuel: 73.0 L' : 'Топливо: 73.0 л'), language, {timeout: 5000});
        source.setCapacity(1000);
        source.setUnavailable(); await until(() => dashboard.evaluate(dashboardObservation, {speed: language === 'en' ? 'Speed: unavailable' : 'Скорость: недоступно', fuel: language === 'en' ? 'Fuel: unavailable' : 'Топливо: недоступно'}), value => Boolean(value), 'UI_MISSING');
        await dashboard.waitForFunction(() => globalThis.document.querySelector('[data-testid="live.instrument.tank"]')?.getAttribute('data-state') === 'unavailable' && !globalThis.document.querySelector('.yu-tank i') && globalThis.document.querySelector('.yu-tank-unavailable')?.textContent === '—', undefined, {timeout: 5000});
        record.flags.tankUnknownVsZero = true; await save('missing', language, size);
        source.setReading(25, 73); source.setPaused(true); await waitState(dashboard, 'paused');
        assert.equal(await dashboard.getByTestId('live-paused').innerText(), language === 'en' ? 'Game paused' : 'Игра на паузе');
        assert.equal(await dashboard.getByTestId('live-paused').evaluate(node => {
          const box = node.getBoundingClientRect(), outer = node.closest('[data-testid="live.instrument"]').getBoundingClientRect();
          const range = globalThis.document.createRange(); range.selectNodeContents(node); const text = range.getBoundingClientRect();
          return node.scrollWidth <= node.clientWidth && text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom && box.left >= outer.left && box.right <= outer.right && box.top >= outer.top && box.bottom <= outer.bottom;
        }), true, `UI_PAUSE_LABEL_CLIPPED_${language}_${size.width}`);
        await save('paused', language, size);
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
        for (const tab of ['intervals', 'timeline', 'samples']) {await dashboard.getByTestId(`journal-detail-tab-${tab}`).click(); await dashboard.getByTestId(`journal-${tab === 'timeline' ? 'events' : tab}-loading`).waitFor({state: 'detached'}); if (tab !== 'samples') await save(tab, language, size);}
        assert.equal(await dashboard.getByTestId('journal-sample-row').count(), 300);
        assert.equal(await dashboard.getByTestId('trip.chart.segment').count(), 1);
        assert.equal(await dashboard.locator('[data-testid="trip.chart"] circle').count(), 300);
        const signed = await dashboard.getByTestId('trip.chart').evaluate(node => {
          const circles = [...node.querySelectorAll('circle')], zero = Number(node.querySelector('[data-testid="trip.chart.zero"]').getAttribute('y1'));
          return circles.length === 300 && zero === 80 && circles.every((circle, index) => {
            const speed = Number(circle.getAttribute('data-speed')), y = Number(circle.getAttribute('cy'));
            return speed === [-72, 0, 72][index % 3] && y === [130, 80, 30][index % 3] && circle.querySelector('title').textContent.includes(`${speed.toFixed(1)} `);
          });
        });
        assert.equal(signed, true, 'UI_SIGNED_CHART_SVG'); record.flags.signedChart = true;
        await dashboard.getByTestId('trip.chart').scrollIntoViewIfNeeded({timeout: 5000});
        assert.equal(await dashboard.getByTestId('trip.chart').locator('svg').evaluate(node => {const box = node.getBoundingClientRect(); return box.top >= 84 && box.bottom <= globalThis.innerHeight && box.left >= 0 && box.right <= globalThis.innerWidth;}), true, 'UI_SIGNED_CHART_NOT_VISIBLE');
        await save('samples', language, size);

        await dashboard.getByTestId('journal-samples-next').click(); await until(() => dashboard.getByTestId('journal-samples-page').innerText(), text => text.includes('2'), 'UI_SAMPLE_PAGE_TWO');
        assert.equal(await dashboard.locator('[data-testid="trip.chart"] circle').count(), 300);
        await dashboard.getByTestId('journal-back').click();
        Object.assign(record.flags, {syntheticBanner: true, pageReturn: true, chartBounded: true, rawTabs: true, searchPlanned: true, tripRegions: true, tableReadable: true});
      } else if (config.uiCase === 'settings') {
        for (const panel of panels) {
          await settingsPanel(dashboard, panel);
          if (panel === 'general') {
            const state = await dashboard.evaluate(() => globalThis.desktop.getAppState());
            assert.equal(state.autostart, 'not-installed'); assert.equal(state.settings.autostart, false);
            assert.equal(await dashboard.getByTestId('autostart-card').isVisible(), true);
            assert.equal(await dashboard.getByTestId('autostart-toggle').isDisabled(), true);
            assert.equal(await dashboard.getByTestId('autostart-not-installed-note').isVisible(), true);
          }
          if (panel === 'plugin') await observeExportResult({application, dashboard, language, size, record});
          await save(panel, language, size);
        }
        const license = dashboard.getByTestId('settings.about.font-license');
        await license.locator('summary').focus(); await dashboard.keyboard.press('Enter');
        assert.equal(await license.locator('pre').innerText(), await readFile(path.join(config.checkout, 'apps/desktop/src/assets/onest-OFL.txt'), 'utf8'));
        assert.match(await license.locator('pre').getAttribute('data-license-asset'), /onest-OFL[^/]*\.txt$/);
        await dashboard.keyboard.press('Enter'); record.flags.fontLicense = true;
        await settingsPanel(dashboard, 'overlay');
        const visibility = dashboard.getByRole('switch', {name: language === 'en' ? 'Show overlay' : 'Показывать оверлей', exact: true});
        await waitOverlayVisibility(dashboard, {enabled: true}, 'UI_OVERLAY_INITIAL_RENDERED');
        assert.ok((await dashboard.getByTestId('overlay-enabled-help').innerText()).length > 0);
        await visibility.focus(); await dashboard.keyboard.press('Space');
        await waitOverlayVisibility(dashboard, {enabled: false}, 'UI_OVERLAY_DISABLED_SAVED');
        assert.equal(await visibility.getAttribute('data-state'), 'unchecked');
        assert.equal(await dashboard.getByTestId('overlay-edit-start').isDisabled(), true);
        await assert.rejects(dashboard.evaluate(() => globalThis.desktop.beginOverlayEdit()));
        await visibility.focus(); await dashboard.keyboard.press('Space');
        await waitOverlayVisibility(dashboard, {enabled: true}, 'UI_OVERLAY_ENABLED_SAVED');
        assert.equal(await visibility.getAttribute('data-state'), 'checked');
        assert.equal(await dashboard.getByTestId('overlay-edit-start').isEnabled(), true);
        record.flags.overlayVisibility = true;
        await observeUnifiedOverlay({application, dashboard, language, size, record});
        await dashboard.locator('.yu-content').evaluate(node => {node.scrollTop = node.scrollHeight;});
        await save('overlay-sections', language, size);
        if (language === 'en' && size.width === 1280) await observeOverlayEditing({dashboard, config, record});
        assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]').count(), 14);
        await dashboard.getByTestId('overlay-preset-driving-only').focus(); await dashboard.keyboard.press('Enter');
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => !state.settings.overlay.sections.cargo, 'UI_SECTIONS_SAVED');
        const navigationBytes = await readFile(path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json'));
        await settingsPanel(dashboard, 'data'); assert.equal(await dashboard.getByTestId('source-select').isEnabled(), true);
        await settingsPanel(dashboard, 'overlay'); assert.equal(await dashboard.getByTestId('overlay-switch-cargo').getAttribute('data-state'), 'unchecked');
        assert.deepEqual(await readFile(path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json')), navigationBytes);
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
          await settingsPanel(dashboard, 'overlay');
          await dashboard.getByTestId('overlay-enabled').focus(); await dashboard.keyboard.press('Space');
          await waitOverlayVisibility(dashboard, {enabled: true, saveError: 'SETTINGS_WRITE_FAILED', errorVisible: true}, 'UI_OVERLAY_FAILED_SAVE_RENDERED', 5000);
          assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.enabled, true);
          assert.equal(await dashboard.getByTestId('overlay-enabled').getAttribute('data-state'), 'checked');
          assert.equal(await dashboard.getByTestId('overlay-edit-start').isEnabled(), true);
          record.flags.visibilityFailedSave = true;
          await settingsPanel(dashboard, 'units');
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
          const overflow = await overlay.evaluate(overlayOverflow); assert.deepEqual(overflow.outside, []); assert.equal(overflow.alignment?.aligned, true);
          // ET-045d value typography: slightly smaller values, never below the 12 px labels (units 12 px except the 11 px Cluster RPM unit).
          assert.equal(await overlay.getByTestId('overlay-fuel').evaluate(node => globalThis.getComputedStyle(node).fontSize), {strip: '17px', card: '12px', cluster: '12px', hud: '13px'}[layout]);
          assert.equal(await overlay.getByTestId('overlay-speed').evaluate(node => globalThis.getComputedStyle(node).fontSize), {strip: '19px', card: '34px', cluster: '34px', hud: '15px'}[layout]);
          assert.deepEqual(await overlay.evaluate(() => ({html: globalThis.getComputedStyle(globalThis.document.documentElement).backgroundColor, body: globalThis.getComputedStyle(globalThis.document.body).backgroundColor})), {html: 'rgba(0, 0, 0, 0)', body: 'rgba(0, 0, 0, 0)'});
          if (layout === 'card') {assert.equal(await overlay.getByTestId('overlay-card-hero').count(), 1); assert.equal(await overlay.getByTestId('overlay-card-hero').getAttribute('data-count'), '3');}
          if (layout === 'cluster') {assert.equal(await overlay.getByTestId('overlay-rpm-arc').getAttribute('stroke-dasharray'), '50.26548245743669 251.32741228718345');}
          await save(layout, language, size, overlay);
          // ET-045d: stable strip numbers and the Cluster centre, at the first size; screenshots stay as before.
          if (layout === 'strip' && size === sizes[0]) await observeStripNumbers({application, overlay, source, language, record});
          if (layout === 'cluster' && size === sizes[0]) await observeClusterCentre({application, dashboard, overlay, language, record});
          const numberWidths = layout === 'strip' ? await overlay.evaluate(stripBoxes) : undefined;
          {
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
              assert.equal(await overlay.getByTestId('overlay-fuel').textContent(), '—');
              assert.equal(await overlay.getByTestId('overlay-tag-stale').innerText(), language === 'en' ? 'Stale' : 'Устарело');
              assert.equal(await overlay.getByTestId('overlay-tag-no-signal').count(), 0);
              assert.equal(await overlay.getByTestId('overlay-root').evaluate(node => node.classList.contains('is-dim')), true);
              assert.equal(await overlay.getByTestId('overlay-speed').evaluate(node => globalThis.getComputedStyle(node).opacity), '0.5');
              assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, []);
              assert.equal(await overlay.locator('.overlay-tag').evaluateAll(nodes => nodes.length <= 2 && nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
              assert.equal(await overlay.getByTestId('overlay-rpm-arc').count(), 0);
              if (numberWidths) {
                // Dashes keep the current widths of the reserved speed, gear and RPM sections (ET-045d).
                const stale = await overlay.evaluate(stripBoxes), width = box => box[2] - box[0];
                for (const id of ['overlay-section-speed', 'overlay-section-gear', 'overlay-section-rpm'])
                  assert.ok(stale[id] && Math.abs(width(stale[id]) - width(numberWidths[id])) <= 0.01, `UI_STRIP_STALE_WIDTH_CHANGED_${id}_${language}_${size.width}`);
              }
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
        return root?.getAttribute('data-layout') === 'card' && root.getAttribute('data-freshness') === 'current' && [...root.querySelectorAll('[data-testid^="overlay-section-"]')].map(node => node.getAttribute('data-testid').replace('overlay-section-', '')).join(',') === [...expected, 'fuel'].join(',');
      }, selected, {timeout: 5000});
      assert.equal(await overlay.getByTestId('overlay-card-hero').count(), selected.length ? 1 : 0);
      for (const id of ids) assert.equal(await overlay.getByTestId(`overlay-section-${id}`).count(), selected.includes(id) ? 1 : 0);
      assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, []);
      // Establish each enabled subset while current; stale projection must preserve that shape, never add unseen fields.
      source.hold();
      try {
        await overlay.waitForFunction(() => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-freshness') === 'stale', undefined, {timeout: 5000});
        assert.equal(await overlay.getByTestId('overlay-tag-stale').innerText(), 'Устарело');
        assert.deepEqual(await overlay.locator('[data-testid^="overlay-section-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid').replace('overlay-section-', ''))), [...selected, 'fuel']);
        assert.equal(await overlay.locator('.overlay-tag').evaluateAll(nodes => nodes.length <= 2 && nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
        assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, []);
      } finally {source.resume();}
      await overlay.waitForFunction(() => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-freshness') === 'current', undefined, {timeout: 5000});
    }
    await dashboard.evaluate(all => globalThis.desktop.setOverlaySections(all), all);
    record.flags.heroSubsets = true;
    await application.evaluate(({BrowserWindow}, size) => {const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay')); window.setContentSize(size.width, size.height);}, dimensions.card);
    for (const language of ['en', 'ru']) {
      await chooseLanguage(dashboard, language);
      for (const profile of ['metric', 'us-customary']) {
        await dashboard.evaluate(profile => globalThis.desktop.setUnitProfile('ets2', profile), profile);
        const expected = profile === 'metric' ? {speed: '90', fuel: '73.0', speedUnit: language === 'en' ? 'km/h' : 'км/ч', fuelUnit: language === 'en' ? 'L' : 'л'} : {speed: '56', fuel: '19.3', speedUnit: language === 'en' ? 'mph' : 'миль/ч', fuelUnit: language === 'en' ? 'US gal' : 'гал'};
        await overlay.waitForFunction(expected => ['speed', 'fuel'].every(id => globalThis.document.querySelector(`[data-testid="overlay-${id}"]`)?.textContent === expected[id] && globalThis.document.querySelector(`[data-testid="overlay-${id}-unit"]`)?.textContent === expected[`${id}Unit`]), expected, {timeout: 5000});
        assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, []);
      }
    }
    await dashboard.evaluate(() => globalThis.desktop.setUnitProfile('ets2', 'metric')); record.flags.formatterProfiles = true;
    record.cssDisplayGeometry = [];
    for (const layout of layouts) {
      await dashboard.evaluate(layout => globalThis.desktop.setOverlayLayout(layout), layout);
      await application.evaluate(({BrowserWindow}, size) => {BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay')).setContentSize(size.width, size.height);}, dimensions[layout]);
      const bounds = () => application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay')).getBounds());
      const nativeBefore = await bounds();
      for (const sparse of [false, true]) {
        await dashboard.evaluate(({all, sparse}) => globalThis.desktop.setOverlaySections(Object.fromEntries(Object.keys(all).map(id => [id, !sparse || id === 'speed']))), {all, sparse});
        await overlay.waitForFunction(({layout, sparse}) => {
          const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
          const count = root.querySelectorAll('[data-testid^="overlay-section-"]').length;
          return root.getAttribute('data-layout') === layout && (sparse ? count === 1 : count > 1);
        }, {layout, sparse}, {timeout: 5000});
        const production = await overlay.evaluate(overlayOverflow);
        assert.deepEqual(production.outside, []); assert.equal(production.alignment?.aligned, true);
        const probe = await overlay.evaluate(cssDisplayGeometry);
        assert.equal(probe.restored, true); assert.equal(probe.results.length, 3); assert.ok(probe.results.every(row => row.aligned));
        assert.deepEqual(await bounds(), nativeBefore, 'CSS_DISPLAY_PROBE_CHANGED_NATIVE_BOUNDS');
        record.cssDisplayGeometry.push({layout, sparse, ...probe});
      }
      await dashboard.evaluate(all => globalThis.desktop.setOverlaySections(all), all);
    }
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
    await waitOverlayVisibility(dashboard, {enabled: true, writable: false}, 'UI_OVERLAY_READ_ONLY_RENDERED');
    for (const layout of layouts) assert.equal(await dashboard.locator(`#overlay-layout-${layout}`).isDisabled(), true);
    assert.equal(await dashboard.getByTestId('overlay-edit-start').isDisabled(), true);
    assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]:disabled').count(), 14);
    assert.equal(await dashboard.locator('[data-testid^="overlay-preset-"]:disabled').count(), 3);
  }
  const file = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json');
  assert.equal(await readFile(file, 'utf8'), settingsBytes);
  record.readOnly = {state: settings.state, writable: settings.writable, language: settings.language, bytesUnchanged: true};
  record.flags.readOnly = true;
}
