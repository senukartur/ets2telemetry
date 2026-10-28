import {dashboardObservation} from './dashboard-observation.mjs';
// ET-028: bounded visual shards against the production renderer, fixed bridge and isolated synthetic sources.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, writeFile, rename, mkdir, rmdir} from 'node:fs/promises';
import {screen, settingsPanel, chooseLanguage} from './ui-navigation.mjs';
import {until} from './lifecycle-observation.mjs';
import {clusterCentreProbe, clusterSpeedArcProbe, overlayOverflow, stripNumberProbe, zeroLiveObservation} from './renderer-observation.mjs';
import {SCALE_RANGE_FRAMES, SCALE_RANGE_ZOOM, SCALE_REFERENCE_FRAMES} from './overlay-observation.mjs';
import {stubSaveDialog} from './journal-observation.mjs';
import {pluginActionResult} from './plugin-fixture.mjs';

// ET-049: genuine keyboard and held-pointer gestures; the overlay still uses committed settings.
async function observeOpacityControl({dashboard, config, language, record}) {
  const slider = dashboard.getByRole('slider', {name: language === 'en' ? 'Background opacity' : 'Непрозрачность фона', exact: true});
  const displayed = dashboard.getByTestId('overlay-opacity-value');
  const value = () => dashboard.evaluate(() => globalThis.desktop.getAppState());
  const wait = expected => until(value, state => state.settings.overlay.backgroundOpacity === expected && !state.settings.saveError, 'UI_OPACITY_COMMITTED');
  await slider.focus();
  for (const [key, expected] of [['End', 100], ['Home', 40], ['ArrowRight', 41]]) {
    await dashboard.keyboard.press(key); await wait(expected);
    await until(() => slider.getAttribute('aria-valuenow'), v => v === String(expected), 'UI_OPACITY_THUMB');
    assert.equal(await slider.getAttribute('aria-valuetext'), `${expected}%`);
    assert.equal(await displayed.innerText(), `${expected}%`);
    await until(() => slider.getAttribute('aria-disabled'), value => value === 'false', 'UI_OPACITY_KEYBOARD_COMMIT_SETTLED');
    assert.equal(await slider.evaluate(node => node === globalThis.document.activeElement), true, 'UI_OPACITY_KEYBOARD_FOCUS_LOST');
  }
  await dashboard.evaluate(() => globalThis.desktop.setOverlayBackgroundOpacity(80)); await wait(80);
  const track = await dashboard.getByTestId('overlay-opacity').boundingBox(), thumb = await slider.boundingBox();
  assert.ok(track && thumb); await dashboard.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2); await dashboard.mouse.down();
  try {
    await dashboard.mouse.move(track.x + track.width * 0.3, thumb.y + thumb.height / 2, {steps: 8});
    const candidate = Number(await slider.getAttribute('aria-valuenow')); assert.ok(candidate < 80 && candidate >= 40);
    assert.equal(await displayed.isVisible(), true, 'UI_OPACITY_DRAFT_VALUE_VISIBLE');
    assert.equal(await displayed.innerText(), `${candidate}%`, 'UI_OPACITY_DRAFT_VALUE');
    assert.equal((await value()).settings.overlay.backgroundOpacity, 80, 'Held drag must not write');
    await dashboard.mouse.up(); await wait(candidate);
    assert.equal(await displayed.innerText(), `${candidate}%`);
    assert.equal(JSON.parse(await readFile(path.join(config.localappdata, 'ETS2Telemetry/settings/settings.json'), 'utf8')).overlay.backgroundOpacity, candidate);
  } finally {await dashboard.mouse.up();}
  await dashboard.evaluate(() => globalThis.desktop.setOverlayBackgroundOpacity(80)); await wait(80);
  record.flags.opacityKeyboardFocus = true;
  record.flags.opacityGestures = true;
}
async function observeOpacitySurfaces({dashboard, overlay, layout, language, size, record}) {
  // The four existing language/size cells cover every alpha for every layout, without four redundant saves per cell.
  const value = [40, 65, 80, 100][(language === 'ru' ? 2 : 0) + (size.width === 1100 ? 1 : 0)];
  {
    await dashboard.evaluate(value => globalThis.desktop.setOverlayBackgroundOpacity(value), value);
    await overlay.waitForFunction(alpha => globalThis.getComputedStyle(globalThis.document.querySelector('[data-testid="overlay-content"]')).getPropertyValue('--yu-ov-panel').trim() === `rgba(11, 17, 32, ${alpha})`, value / 100);
    const facts = await overlay.evaluate(() => {
      const style = node => globalThis.getComputedStyle(node);
      const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
      return {rootBackground: style(root).backgroundColor, rootOpacity: style(root).opacity,
        contentOpacity: style(globalThis.document.querySelector('[data-testid="overlay-content"]')).opacity,
        speedOpacity: style(globalThis.document.querySelector('[data-testid="overlay-speed"]')).opacity,
        surfaces: [...globalThis.document.querySelectorAll('.overlay-surface,.overlay-gauge')].map(node => style(node).backgroundColor),
        hud: globalThis.document.querySelector('.overlay-hud-lines') ? style(globalThis.document.querySelector('.overlay-hud-lines')).backgroundColor : null};
    });
    assert.equal(facts.rootBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(facts.rootOpacity, '1'); assert.equal(facts.contentOpacity, '1'); assert.equal(facts.speedOpacity, '1');
    if (layout === 'hud') {assert.equal(facts.hud, 'rgba(0, 0, 0, 0)'); assert.equal(facts.surfaces.length, 0);}
    else {assert.ok(facts.surfaces.length >= (layout === 'cluster' ? 2 : 1)); assert.ok(facts.surfaces.every(color => color === (value === 100 ? 'rgb(11, 17, 32)' : `rgba(11, 17, 32, ${value / 100})`)));}
  }
  await dashboard.evaluate(() => globalThis.desktop.setOverlayBackgroundOpacity(80));
  await overlay.waitForFunction(() => globalThis.getComputedStyle(globalThis.document.querySelector('[data-testid="overlay-content"]')).getPropertyValue('--yu-ov-panel').includes('0.8'));
  record.flags.backgroundOpacityOverlay = true;
}

export const UI_CASES = ['shell', 'live', 'journal', 'settings', 'overlay'];
const sizes = [{width: 1280, height: 800}, {width: 1100, height: 720}];
const panels = ['general', 'units', 'overlay', 'plugin', 'data', 'about'];
const layouts = ['strip', 'card', 'cluster', 'hud'];
// ET-052: the reserved windows at zoom 1 for fifteen sections: the strip is still three rows at 1280 CSS px (116), the card 48 + 24 × 15 = 408,
// the cluster's panel 36 + 21 × 12 = 288 and the HUD 18 + 24 × 15 = 378 (384, 267 and 354 with fourteen).
const dimensions = {strip: {width: 1280, height: 116}, card: {width: 300, height: 408}, cluster: {width: 440, height: 288}, hud: {width: 320, height: 378}};
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
// (renderer-observation.mjs). ET-045e: the zoom and window frames are the zoom factors of the overlay's 100%, 50% and
// 300% settings (overlayZoom: 0.7, 0.35 and 2.1). The 50% probe frames (strip 640 × 60, Cluster 160 × 100) are probe
// sizes with margin, not product windows; Windows accepted the smaller 50% product windows (SCALE_RANGE_FRAMES, Cluster
// 154 × 95) in the fix-round smokes. The first strip frame and the second Cluster frame are
// the 100% ones; the probes restore the layout loop's own frame (`dimensions` at zoom 1) afterwards.
const SPEED_UNITS = {en: ['km/h', 'mph'], ru: ['км/ч', 'миль/ч']}, RPM_UNIT = {en: 'rpm', ru: 'об/мин'};
const STRIP_FRAMES = [{zoom: 0.7, width: 1280, height: 80}, {zoom: 0.35, width: 640, height: 60}, {zoom: 2.1, width: 1000, height: 720}];
// ET-052: the 100% and 300% frames are the product windows with fifteen sections (308 × 203 and 924 × 605; 188 and 561 with fourteen).
const CLUSTER_FRAMES = [{zoom: 0.35, width: 160, height: 100}, {zoom: 0.7, width: 308, height: 203}, {zoom: 2.1, width: 924, height: 605}];
function stripSteps(speedUnit, rpmUnit) {
  return [{speed: '0', speedUnit, gear: 'N', rpm: '0', rpmUnit}, ...['9', '10', '99', '100', '-5', '—'].map(speed => ({speed})),
    // ET-050: the manual range-splitter forms share the gear's mode-independent reserve; ET-050b adds the crawler labels.
    ...['1', '9', '10', '12', 'R1', '1L', '1H', '9H', 'LL', 'LH', 'C1', 'C2'].map(gear => ({gear})), ...['999', '1000', '2528', '9999', '—'].map(rpm => ({rpm}))];
}
function clusterSteps(parts, speedUnit, rpmUnit) {
  const base = {...(parts.includes('speed') ? {speedUnit} : {}), ...(parts.includes('rpm') ? {rpmUnit} : {})}, steps = [];
  if (parts.includes('rpm')) steps.push(...['999', '1000', '2528', '9999'].map(rpm => ({...base, rpm})));
  if (parts.includes('gear')) steps.push(...['N', '12', 'R1', '1L', '1H', '9H', 'LL', 'LH', 'C1', 'C2'].map(gear => ({...base, gear})));
  if (parts.includes('speed')) steps.push(...['100', '-5', '—'].map(speed => ({...base, speed})));
  if (parts.length === 3) steps.push({...base, speed: '100', gear: '12', rpm: '9999'});
  return steps;
}
async function overlayFrame(application, overlay, frame) {
  await application.evaluate(({BrowserWindow}, {zoom, width, height}) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('?view=overlay'));
    window.webContents.setZoomFactor(zoom); window.setContentSize(width, height);
  }, frame);
  // The CSS viewport times the zoom is the DIP content size. At a fractional device scale Windows may round it by about a
  // DIP, and the integer viewport adds up to half a CSS px, `zoom / 2` DIP (ET-045e verifier round 1, the same rule as
  // zoomedViewportTolerance), so the bound is max(1.5, 1 + zoom / 2) DIP.
  await overlay.waitForFunction(({zoom, width, height}) => {
    const tolerance = Math.max(1.5, 1 + zoom / 2);
    return Math.abs(globalThis.innerWidth * zoom - width) <= tolerance && Math.abs(globalThis.innerHeight * zoom - height) <= tolerance;
  }, frame, {timeout: 5000});
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
 * The strip at the zooms of 100%, 50% and 300% (0.7, 0.35, 2.1): every digit-count step in both unit profiles leaves
 * every section and the row in place, then two real source transitions (9 to 100 km/h, gear 9 to 10, 999 to 1000 rpm)
 * do the same end to end.
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
    record.stableNumbers.push({language, zoom: STRIP_FRAMES[0].zoom, transition: '9/9/999 to 100/10/1000', moved});
    assert.deepEqual(moved, [], `UI_STRIP_LIVE_TRANSITION_MOVED_${language}`);
  }, async () => {
    source.setReading(25, 73); source.setEngine(600, -1);
    await overlayFrame(application, overlay, {zoom: 1, ...dimensions.strip});
  });
  await overlay.waitForFunction(numberTexts, {speed: '90', gear: 'R1', rpm: '600'}, {timeout: 5000});
  record.flags.stableNumbers = true;
}
/**
 * ET-050: ETS2's manual gear display chosen by keyboard on Settings > Units, then real source gears on the overlay and the
 * dashboard's Live instrument (3 is 2L, 16 is 8H, reverse R1 and neutral N), and automatic again (3 is 3). The source's
 * gear and the automatic mode are restored afterwards.
 * ET-050b: the v1 source serves the Mack 18F/4R layout with another truck model id, so the steps above prove the formula
 * for a mismatched truck. Then the v1 truck becomes v0's (B6): 1 is C1, 2 C2, 3 1L and 18 8H on the overlay, the Live
 * instrument and the Live details row, because the smoke source is ETS2, which names a crawler C1/C2 (B5 as amended on
 * October 26, 2026); another model id again gives the formula (1 is 1L). The v1 truck id is restored.
 * ET-050b owner option B: the crawler mode then shows 1 as C, 2 as 1 and 14 as 13 in the same three places.
 */
async function observeGearDisplay({dashboard, overlay, source, sourceV1, language, record}) {
  record.gearDisplay ??= [];
  const gearIs = async text => {
    await overlay.waitForFunction(numberTexts, {gear: text}, {timeout: 5000});
    await dashboard.waitForFunction(text => globalThis.document.querySelector('[data-testid="live.instrument.gear"] strong')?.textContent === text, text, {timeout: 5000});
  };
  const choose = async mode => {
    await settingsPanel(dashboard, 'units');
    await dashboard.locator(`#gear-display-ets2-${mode}`).focus(); await dashboard.keyboard.press('Space');
    await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.gearDisplay.ets2 === mode && state.settings.saveError === null,
      `UI_GEAR_DISPLAY_${mode.toUpperCase()}_SAVED`);
    // Main's AppState reports the save before React re-renders the committed radio, so wait for the attribute.
    await dashboard.waitForFunction(id => globalThis.document.getElementById(id)?.getAttribute('aria-checked') === 'true',
      `gear-display-ets2-${mode}`, {timeout: 5000});
  };
  const labelIs = async text => {
    await gearIs(text);
    await dashboard.waitForFunction(text => globalThis.document.querySelector('[data-testid="live-gear"]')?.textContent === text, text, {timeout: 5000});
  };
  await withRestore(async () => {
    await choose('manual');
    for (const [gear, text] of [[3, '2L'], [16, '8H'], [-1, 'R1'], [0, 'N']]) {
      source.setEngine(600, gear); await gearIs(text); record.gearDisplay.push({language, mode: 'manual', gear, text});
    }
    sourceV1.setTruckId('truck.volvo');
    for (const [gear, text] of [[1, 'C1'], [2, 'C2'], [3, '1L'], [18, '8H'], [-1, 'R1']]) {
      source.setEngine(600, gear); await labelIs(text); record.gearDisplay.push({language, mode: 'manual', layout: 'mack', gear, text});
    }
    sourceV1.setTruckId(undefined);
    source.setEngine(600, 1); await labelIs('1L'); record.gearDisplay.push({language, mode: 'manual', layout: 'other-truck', gear: 1, text: '1L'});
    // ET-050b owner option B: the crawler mode needs no layout; the ETS2 source names gear 1 C, as on the Scania G38CMR.
    await choose('crawler');
    for (const [gear, text] of [[1, 'C'], [2, '1'], [14, '13'], [-1, 'R1'], [0, 'N']]) {
      source.setEngine(600, gear); await labelIs(text); record.gearDisplay.push({language, mode: 'crawler', gear, text});
    }
    await choose('automatic');
    source.setEngine(600, 3); await gearIs('3'); record.gearDisplay.push({language, mode: 'automatic', gear: 3, text: '3'});
  }, async () => {
    source.setEngine(600, -1); sourceV1.setTruckId(undefined);
    if ((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.gearDisplay.ets2 !== 'automatic')
      await dashboard.evaluate(() => globalThis.desktop.setGearDisplay('ets2', 'automatic'));
  });
  await overlay.waitForFunction(numberTexts, {gear: 'R1'}, {timeout: 5000});
  record.flags.gearDisplayManual = true;
}
/**
 * ET-050b: in each layout at the first size, ETS2's manual mode with the v1 truck equal to v0's shows the ETS2 crawler
 * label for gear 1 of the Mack layout (C1) in the overlay's gear part (the Card hero, the Cluster badge, the strip and HUD sections), and the
 * shown sections still lie inside the window. The gear, the v1 truck id and the automatic mode are restored afterwards.
 */
async function observeGearboxLabel({dashboard, overlay, source, sourceV1, layout, language, record}) {
  record.gearboxLabels ??= [];
  await withRestore(async () => {
    await dashboard.evaluate(() => globalThis.desktop.setGearDisplay('ets2', 'manual'));
    await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.gearDisplay.ets2 === 'manual' && state.settings.saveError === null,
      'UI_GEARBOX_MANUAL_SAVED');
    sourceV1.setTruckId('truck.volvo'); source.setEngine(600, 1);
    await overlay.waitForFunction(numberTexts, {gear: 'C1'}, {timeout: 5000});
    assert.deepEqual((await overlay.evaluate(overlayOverflow)).outside, [], `UI_GEARBOX_LABEL_OUTSIDE_${layout}_${language}`);
    record.gearboxLabels.push({language, layout, gear: 1, text: 'C1'});
  }, async () => {
    source.setEngine(600, -1); sourceV1.setTruckId(undefined);
    if ((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.gearDisplay.ets2 !== 'automatic')
      await dashboard.evaluate(() => globalThis.desktop.setGearDisplay('ets2', 'automatic'));
  });
  await overlay.waitForFunction(numberTexts, {gear: 'R1'}, {timeout: 5000});
  // Every layout in both languages.
  if (new Set(record.gearboxLabels.map(entry => `${entry.language}:${entry.layout}`)).size === layouts.length * 2) record.flags.gearboxLabels = true;
}
/**
 * The Cluster at the zooms of 50%, 100% and 300% (0.35, 0.7, 2.1) with speed, gear and RPM, then at 100% with RPM alone
 * and with speed and RPM: every centre part stays inside the inner ring in both unit profiles. All sections are restored afterwards.
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
    await overlayFrame(application, overlay, {zoom: 1, ...dimensions.cluster});
  });
  await overlay.waitForFunction(sectionsAre, shown, {timeout: 5000});
  record.flags.clusterRpmContained = true;
}
/**
 * ET-045f: the Cluster speed arc in the real renderer. The arc's dash offset is the unfilled part of the circumference
 * C = 2π × 52, so it is C × (1 − fraction) on the 130 km/h or 80 mph scale: 25 m/s is 90 km/h (9/13, offset C × 4/13) or
 * 55.923 mph (0.6990426), 50 m/s is 180 km/h (capped at 1, offset 0). A displayed 0 (0.1 m/s) and reverse (-1.4 m/s shows
 * -5) draw no arc. The offset eases over 150 ms linear, and not at all under reduced motion. The reading, the ETS2 profile
 * and the media emulation are restored afterwards.
 */
const SPEED_ARC_C = 2 * Math.PI * 52, RPM_ARC_DASHARRAY = '50.26548245743669 251.32741228718345';
const SPEED_ARC_OFFSET_90_KMH = 100.5309649148734, SPEED_ARC_OFFSET_56_MPH = 98.3305007691772;
async function speedArc(overlay, label) {
  const result = await overlay.evaluate(clusterSpeedArcProbe);
  assert.equal(result.ok, true, `UI_CLUSTER_SPEED_ARC_PROBE_${label}: ${result.reason ?? ''}`);
  return result;
}
function assertArcOffset(result, expected, label) {
  assert.ok(result.arc, `UI_CLUSTER_SPEED_ARC_MISSING_${label}`);
  assert.equal(result.arc.r, 52, `UI_CLUSTER_SPEED_ARC_RADIUS_${label}`);
  assert.equal(result.arc.transform, 'rotate(-90 60 60)', `UI_CLUSTER_SPEED_ARC_TRANSFORM_${label}`);
  assert.equal(result.arc.strokeWidth, '6px', `UI_CLUSTER_SPEED_ARC_STROKE_WIDTH_${label}`);
  assert.equal(result.arc.dasharray, `${SPEED_ARC_C} ${SPEED_ARC_C}`, `UI_CLUSTER_SPEED_ARC_DASHARRAY_${label}`);
  assert.ok(Math.abs(result.arc.offset - expected) <= 0.01, `UI_CLUSTER_SPEED_ARC_OFFSET_${label}: ${result.arc.offset} vs ${expected}`);
}
const arcDuration = expected => globalThis.document.querySelector('[data-testid="overlay-speed-arc"]') !== null &&
  globalThis.getComputedStyle(globalThis.document.querySelector('[data-testid="overlay-speed-arc"]')).transitionDuration === expected;
/** Self-contained: whether a loaded stylesheet has `@media (prefers-reduced-motion: reduce)` setting the arc's transition to none. */
function reducedMotionRule() {
  for (const sheet of globalThis.document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const media of rules) {
      if (!(media instanceof globalThis.CSSMediaRule) || !/prefers-reduced-motion:\s*reduce/.test(media.conditionText)) continue;
      for (const rule of media.cssRules) {
        if (rule instanceof globalThis.CSSStyleRule && rule.selectorText === '.overlay-speed-arc'
          && rule.style.getPropertyValue('transition-duration') === '0s' && rule.style.getPropertyValue('transition-property') === 'none') return true;
      }
    }
  }
  return false;
}
async function observeClusterSpeedArc({dashboard, overlay, source, language, record}) {
  record.clusterSpeedArc ??= [];
  const speedIs = speed => overlay.waitForFunction(numberTexts, {speed}, {timeout: 5000});
  await withRestore(async () => {
    source.setReading(25, 73); source.setEngine(600, -1); await speedIs('90');
    const metric = await speedArc(overlay, `metric_${language}`);
    assertArcOffset(metric, SPEED_ARC_OFFSET_90_KMH, `metric_${language}`);
    assert.deepEqual([metric.arc.transitionProperty, metric.arc.transitionDuration, metric.arc.transitionTimingFunction], ['stroke-dashoffset', '0.15s', 'linear'], `UI_CLUSTER_SPEED_ARC_TRANSITION_${language}`);
    assert.equal(metric.arc.stroke, 'rgb(96, 165, 250)', `UI_CLUSTER_SPEED_ARC_STROKE_${language}`);
    assert.deepEqual(metric.rpmArc, {dasharray: RPM_ARC_DASHARRAY, stroke: 'rgb(37, 99, 235)'}, `UI_CLUSTER_RPM_ARC_${language}`);
    record.clusterSpeedArc.push({language, step: 'metric-90', ...metric});
    await dashboard.evaluate(() => globalThis.desktop.setUnitProfile('ets2', 'us-customary')); await speedIs('56');
    const us = await speedArc(overlay, `us_${language}`);
    assertArcOffset(us, SPEED_ARC_OFFSET_56_MPH, `us_${language}`); record.clusterSpeedArc.push({language, step: 'us-56', ...us});
    await dashboard.evaluate(() => globalThis.desktop.setUnitProfile('ets2', 'metric')); await speedIs('90');
    for (const [metersPerSecond, text] of [[0.1, '0'], [-1.4, '-5']]) {
      source.setReading(metersPerSecond, 73); await speedIs(text);
      const none = await speedArc(overlay, `none_${text}_${language}`);
      assert.equal(none.arc, null, `UI_CLUSTER_SPEED_ARC_AT_${text}_${language}`);
      assert.equal(none.track, true, `UI_CLUSTER_SPEED_TRACK_AT_${text}_${language}`);
      assert.ok(none.rpmArc, `UI_CLUSTER_RPM_ARC_AT_${text}_${language}`);
      record.clusterSpeedArc.push({language, step: `none-${text}`, ...none});
    }
    source.setReading(50, 73); await speedIs('180');
    const full = await speedArc(overlay, `full_${language}`);
    assertArcOffset(full, 0, `full_${language}`); record.clusterSpeedArc.push({language, step: 'full-180', ...full});
    // Reduced motion (Windows "Animation effects" off) removes the transition. The loaded stylesheet must hold that rule
    // for the arc. Playwright's `emulateMedia({reducedMotion})` is not used: on GitHub-hosted runners the emulated feature
    // reached the overlay renderer late or not at all (PR #182, runs 40139749258 and 40141031694), although it worked
    // locally, so the computed duration under the emulation is not a stable gate.
    assert.ok(await overlay.evaluate(reducedMotionRule), `UI_CLUSTER_SPEED_ARC_REDUCED_MOTION_RULE_${language}`);
    assert.ok(await overlay.evaluate(arcDuration, '0.15s'), `UI_CLUSTER_SPEED_ARC_DURATION_${language}`);
    record.clusterSpeedArc.push({language, step: 'reduced-motion', rule: true, duration: '0.15s'});
  }, async () => {
    await dashboard.evaluate(() => globalThis.desktop.setUnitProfile('ets2', 'metric'));
    source.setReading(25, 73); source.setEngine(600, -1);
  });
  await speedIs('90');
  assertArcOffset(await speedArc(overlay, `restored_${language}`), SPEED_ARC_OFFSET_90_KMH, `restored_${language}`);
  record.flags.clusterSpeedArc = true;
}
/** Self-contained: the CSS width and text of every overlay value, label and unit box, in document order. */
function textBoxes() {
  return [...globalThis.document.querySelectorAll('.overlay-value, .overlay-label, .overlay-unit')]
    .map(node => ({kind: String(node.className).split(' ')[0], text: node.textContent, width: node.getBoundingClientRect().width}));
}
/**
 * ET-045e (decision Z8): every layout in the selected language at the 50% setting, zoom 0.35, in its product window
 * (SCALE_RANGE_FRAMES; only the strip is raised to the measured 38 DIP minimum height). Every shown section must lie inside the window with the content aligned; this gates the
 * `scaleRange` flag. Chromium applies its minimum font size before the zoom for explicit px sizes, so text should shrink
 * with the zoom: the CSS width of each value, label and unit box with the same text is compared with the 100% product
 * window (zoom 0.7), and a ratio above 1.01 is recorded as an enlargement, never asserted. In English the six
 * owner-comparison references (SCALE_REFERENCE_FRAMES) are captured as extra screenshots. The layout loop's frames are
 * set again by the next layout or size.
 */
async function observeScaleRange({application, dashboard, overlay, language, size, record, save}) {
  record.scaleRange ??= [];
  for (const layout of layouts) {
    await dashboard.evaluate(layout => globalThis.desktop.setOverlayLayout(layout), layout);
    await overlay.waitForFunction(layout => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-layout') === layout, layout, {timeout: 5000});
    const reference = SCALE_REFERENCE_FRAMES.find(frame => frame.layout === layout);
    await overlayFrame(application, overlay, reference);
    const atHundred = await overlay.evaluate(textBoxes);
    const frame = {zoom: SCALE_RANGE_ZOOM, ...SCALE_RANGE_FRAMES[layout]};
    await overlayFrame(application, overlay, frame);
    const overflow = await overlay.evaluate(overlayOverflow), atFifty = await overlay.evaluate(textBoxes);
    const ratios = atFifty.map((box, index) => atHundred[index]?.text === box.text && atHundred[index].width > 0 ? box.width / atHundred[index].width : null)
      .filter(ratio => ratio !== null);
    record.scaleRange.push({language, layout, frame, outside: overflow.outside, aligned: overflow.alignment?.aligned ?? null, boxes: ratios.length,
      maxWidthRatio: ratios.length ? Math.max(...ratios) : null, enlarged: ratios.filter(ratio => ratio > 1.01).length});
    assert.deepEqual(overflow.outside, [], `UI_SCALE_RANGE_OUTSIDE_${language}_${layout}`);
    assert.equal(overflow.alignment?.aligned, true, `UI_SCALE_RANGE_UNALIGNED_${language}_${layout}`);
  }
  if (language === 'en') {
    for (const reference of SCALE_REFERENCE_FRAMES) {
      await dashboard.evaluate(layout => globalThis.desktop.setOverlayLayout(layout), reference.layout);
      await overlay.waitForFunction(layout => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-layout') === layout, reference.layout, {timeout: 5000});
      await overlayFrame(application, overlay, reference);
      await save(reference.name, language, size, overlay);
    }
  }
  record.flags.scaleRange = true;
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
      card.querySelectorAll('[data-testid^="overlay-switch-"]').length === 15 &&
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
        resolve({overflow, controlsContained, focusTop: focus.top, focusBottom: focus.bottom, viewportTop: bounds.top, viewportBottom: bounds.bottom, scrolled: scroll.scrollTop > 0, focusVisible: focus.width > 0 && focus.left >= bounds.left && focus.right <= bounds.right && focus.top >= bounds.top && focus.bottom <= bounds.bottom});
      })));
      assert.deepEqual(observation.overflow, [], `UI_OVERLAY_OVERFLOW_${language}_${size.width}_${zoom}`);
      assert.equal(observation.controlsContained, true, JSON.stringify({language, zoom, ...observation})); assert.equal(observation.scrolled, true, JSON.stringify({language, zoom, ...observation})); assert.equal(observation.focusVisible, true, JSON.stringify({language, zoom, ...observation}));
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
/**
 * ET-052 D3: the Live details row of the next mandatory break. The v1 smoke source serves 95 game minutes ("1 h 35 min", soon):
 * the Coffee icon, the value and an orange "Soon" badge with its icon, word and accessible name. Zero reads "0 min" with the
 * red "Break due" badge, 130 minutes has no badge, and an unavailable reading reads unavailable with its reason and no badge.
 * The source's reading is restored afterwards.
 */
async function observeMandatoryBreak({dashboard, sourceV1, language, record}) {
  record.mandatoryBreak ??= [];
  const en = language === 'en', label = en ? 'Next mandatory break' : 'До обязательного перерыва';
  const read = () => dashboard.evaluate(() => {
    const query = id => globalThis.document.querySelector(`[data-testid="${id}"]`), badge = query('live-mandatory-break-badge');
    return {value: query('live-mandatory-break')?.innerText ?? null, reason: query('live-mandatory-break-reason')?.innerText ?? null, icon: query('live-mandatory-break-icon') !== null,
      badge: badge ? {text: badge.innerText, name: badge.getAttribute('aria-label'), urgency: badge.getAttribute('data-urgency'), variant: badge.getAttribute('data-variant'),
        icon: badge.querySelector('svg') !== null} : null};
  });
  const expectRow = async (name, expected) => {
    await until(read, value => JSON.stringify(value) === JSON.stringify(expected), `UI_MANDATORY_BREAK_${name.toUpperCase()}_${language}`);
    record.mandatoryBreak.push({language, case: name, ...expected});
  };
  const badge = (urgency, word, variant) => ({text: word, name: `${label}: ${word}`, urgency, variant, icon: true});
  await withRestore(async () => {
    await expectRow('soon', {value: en ? '1 h 35 min' : '1 ч 35 мин', reason: null, icon: true, badge: badge('soon', en ? 'Soon' : 'Скоро', 'warn')});
    sourceV1.setBreak({available: true, value: 0, unit: 'min'});
    await expectRow('due', {value: en ? '0 min' : '0 мин', reason: null, icon: true, badge: badge('due', en ? 'Break due' : 'Пора', 'error')});
    sourceV1.setBreak({available: true, value: -30, unit: 'min'});
    await expectRow('overdue', {value: en ? '0 min' : '0 мин', reason: null, icon: true, badge: badge('due', en ? 'Break due' : 'Пора', 'error')});
    sourceV1.setBreak({available: true, value: 130, unit: 'min'});
    await expectRow('normal', {value: en ? '2 h 10 min' : '2 ч 10 мин', reason: null, icon: true, badge: null});
    sourceV1.setBreak({available: false, reason: 'not-observed', unit: 'min'});
    await expectRow('unavailable', {value: en ? 'unavailable' : 'недоступно', reason: en ? 'not yet observed' : 'ещё не наблюдалось', icon: true, badge: null});
  }, async () => { sourceV1.setBreak(undefined); });
  sourceV1.setBreak(undefined);
  await expectRow('restored', {value: en ? '1 h 35 min' : '1 ч 35 мин', reason: null, icon: true, badge: badge('soon', en ? 'Soon' : 'Скоро', 'warn')});
  record.flags.mandatoryBreak = true;
}
export async function runUiSmoke({application, dashboard, overlay, source, sourceV1, config, record}) {
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
        await observeMandatoryBreak({dashboard, sourceV1, language, record});
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
          if (panel === 'about') {
            // ET-055 UP11: About repeats the sidebar version line; a launch that never checks disables Check for updates.
            assert.equal(await dashboard.getByTestId('settings.about.version.name').textContent(), await dashboard.getByTestId('shell.sidebar.version.name').textContent());
            const checkButton = dashboard.getByTestId('settings-about-update-check');
            assert.equal(await checkButton.innerText(), language === 'en' ? 'Check for updates' : 'Проверить обновления');
            assert.equal(await checkButton.isDisabled(), true);
            assert.equal(await dashboard.getByTestId('settings-about-update-check-note').innerText(), language === 'en' ? 'Updates are checked only in an installed copy of the app.' : 'Обновления проверяются только в установленной программе.');
          }
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
        const opacityControl = dashboard.getByRole('slider', {name: language === 'en' ? 'Background opacity' : 'Непрозрачность фона', exact: true});
        assert.equal(await opacityControl.getAttribute('aria-valuemin'), '40');
        assert.equal(await opacityControl.getAttribute('aria-valuemax'), '100');
        assert.equal(await opacityControl.getAttribute('aria-valuenow'), '80');
        assert.equal(await opacityControl.getAttribute('aria-disabled'), 'false');
        record.flags.overlayOpacity = true;
        await observeUnifiedOverlay({application, dashboard, language, size, record});
        await dashboard.locator('.yu-content').evaluate(node => {node.scrollTop = node.scrollHeight;});
        await save('overlay-sections', language, size);
        if (language === 'en' && size.width === 1280) await observeOverlayEditing({dashboard, config, record});
        // ET-045e: after ET-048's editing check, which may have saved another scale.
        if (size === sizes[0]) await observeScaleControl({dashboard, config, language, record});
        assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]').count(), 15);
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
          const opacity = dashboard.getByRole('slider'); await opacity.focus(); await dashboard.keyboard.press('Home');
          await until(() => dashboard.getByRole('slider').getAttribute('aria-valuenow'), value => value === '80', 'UI_OPACITY_FAILED_THUMB');
          await dashboard.getByTestId('overlay-settings-error').waitFor({state: 'visible'});
          assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.backgroundOpacity, 80);
          assert.equal(await dashboard.getByTestId('overlay-opacity-value').innerText(), '80%');
          assert.equal(await opacity.evaluate(node => node === globalThis.document.activeElement), true, 'UI_OPACITY_FAILED_SAVE_FOCUS_LOST');
          record.flags.opacityFailedSave = true;
          // ET-050: a refused gear display save keeps the committed mode selected and reports in its own card.
          await settingsPanel(dashboard, 'units');
          const gearBefore = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.gearDisplay.ets2;
          const gearWanted = gearBefore === 'automatic' ? 'manual' : 'automatic';
          await dashboard.locator(`#gear-display-ets2-${gearWanted}`).focus(); await dashboard.keyboard.press('Space');
          await dashboard.getByTestId('gear-display-error').waitFor({state: 'visible', timeout: 5000});
          assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.gearDisplay.ets2, gearBefore);
          assert.equal(await dashboard.locator(`#gear-display-ets2-${gearBefore}`).getAttribute('aria-checked'), 'true');
          assert.equal(await dashboard.locator(`#gear-display-ets2-${gearWanted}`).getAttribute('aria-checked'), 'false');
          record.flags.gearDisplayFailedSave = true;
        } finally {await rmdir(settingsFile); await rename(backup, settingsFile);}
        assert.deepEqual(await readFile(settingsFile), bytes);
        await dashboard.locator(`#units-ets2-${wanted}`).click();
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.units.ets2 === wanted && state.settings.saveError === null, 'UI_SAVE_RECOVERED');
        await dashboard.locator(`#units-ets2-${before}`).click();
        await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.units.ets2 === before && state.settings.saveError === null, 'UI_PROFILE_RESTORED');
        record.flags.refusedSave = true;
        // ET-050: committed manual, then automatic again, through the Units control; each shows checked only once saved.
        // ET-050b (owner option B): the crawler mode is committed between them the same way.
        for (const mode of ['manual', 'crawler', 'automatic']) {
          await dashboard.locator(`#gear-display-ets2-${mode}`).click();
          await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings.gearDisplay.ets2 === mode && state.settings.saveError === null, `UI_GEAR_DISPLAY_${mode.toUpperCase()}_COMMITTED`);
          await until(() => dashboard.locator(`#gear-display-ets2-${mode}`).getAttribute('aria-checked'), checked => checked === 'true', `UI_GEAR_DISPLAY_${mode.toUpperCase()}_CHECKED`);
          assert.equal(await dashboard.getByTestId('gear-display-error').count(), 0);
        }
        record.flags.gearDisplay = true;
        // Each gear display option opens its own hint on hover and on keyboard focus; neither changes the committed mode.
        const gearHintName = id => dashboard.evaluate(id => globalThis.document.querySelector(`[data-testid="${id}-tooltip"] p`)?.textContent ?? null, id);
        await dashboard.locator('#gear-display-ets2-manual').hover();
        await dashboard.getByTestId('gear-display-ets2-manual-tooltip').waitFor({state: 'visible', timeout: 5000});
        assert.equal(await gearHintName('gear-display-ets2-manual'), language === 'en' ? 'Manual range-splitter' : 'Механическая с делителем');
        await dashboard.keyboard.press('Escape'); await dashboard.mouse.move(0, 0);
        await dashboard.locator('#gear-display-ets2-crawler').focus();
        await dashboard.getByTestId('gear-display-ets2-crawler-tooltip').waitFor({state: 'visible', timeout: 5000});
        assert.equal(await gearHintName('gear-display-ets2-crawler'), language === 'en' ? 'Crawler first' : 'С ползучей');
        await dashboard.screenshot({path: path.join(config.output, `ui-${config.uiCase}-gear-display-hint-${language}.png`), timeout: 5000});
        assert.equal((await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.gearDisplay.ets2, 'automatic');
        await dashboard.keyboard.press('Escape');
        await dashboard.getByTestId('gear-display-ets2-crawler-tooltip').waitFor({state: 'hidden', timeout: 5000});
        record.flags.gearDisplayHints = true;
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
          if (layout === 'strip' && language === 'en' && size === sizes[0]) await observeOpacityControl({dashboard, config, language, record});
          await observeOpacitySurfaces({dashboard, overlay, layout, language, size, record});
          await save(layout, language, size, overlay);
          // ET-045d: stable strip numbers and the Cluster centre, at the first size; screenshots stay as before.
          if (layout === 'strip' && size === sizes[0]) await observeStripNumbers({application, overlay, source, language, record});
          if (layout === 'strip' && size === sizes[0]) await observeGearDisplay({dashboard, overlay, source, sourceV1, language, record});
          // ET-050b: the ETS2 crawler label C1 of the Mack layout in every layout.
          if (size === sizes[0]) await observeGearboxLabel({dashboard, overlay, source, sourceV1, layout, language, record});
          if (layout === 'cluster' && size === sizes[0]) await observeClusterCentre({application, dashboard, overlay, language, record});
          // ET-045f: the Cluster speed arc in both profiles, at 0, in reverse, at full scale and under reduced motion.
          if (layout === 'cluster' && size === sizes[0]) await observeClusterSpeedArc({dashboard, overlay, source, language, record});
          const numberWidths = layout === 'strip' ? await overlay.evaluate(stripBoxes) : undefined;
          {
            source.setUnavailable();
            await until(() => overlay.getByTestId('overlay-speed').textContent(), text => text === '—', 'UI_OVERLAY_MISSING');
            if (layout === 'cluster') assert.equal(await overlay.getByTestId('overlay-speed-arc').count(), 0, `UI_CLUSTER_SPEED_ARC_WHILE_MISSING_${language}_${size.width}`);
            await save(`${layout}-missing`, language, size, overlay);
            source.setReading(25, 73); source.setPaused(true); await waitState(dashboard, 'paused');
            await overlay.waitForFunction(() => globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-status') === 'paused', undefined, {timeout: 5000});
            if (layout === 'cluster') {
              // A paused current game keeps its 90 km/h arc.
              await overlay.waitForFunction(numberTexts, {speed: '90'}, {timeout: 5000});
              assertArcOffset(await speedArc(overlay, `paused_${language}_${size.width}`), SPEED_ARC_OFFSET_90_KMH, `paused_${language}_${size.width}`);
            }
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
              assert.equal(await overlay.getByTestId('overlay-speed-arc').count(), 0);
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
        // ET-045e: the 50% range and, in English, the owner's scale references, at the first size.
        if (size === sizes[0]) await observeScaleRange({application, dashboard, overlay, language, size, record, save});
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
  const motion = ['recording', 'waiting'].includes(recording) ? 'calm' : recording === 'opening' ? 'busy' : ['interrupted', 'retrying'].includes(recording) ? 'urgent' : recording === 'paused' ? 'breathe' : 'still';
  assert.equal(await dashboard.getByTestId('shell.recording.indicator').getAttribute('data-motion'), motion);
  // The dot pulses only while the dashboard window has focus.
  record.windowFocused = await dashboard.evaluate(() => globalThis.document.hasFocus());
  assert.equal(await dashboard.getByTestId('shell.recording.indicator').getAttribute('data-window-focused'), String(record.windowFocused));
  // The sidebar indicator's tooltip opens on hover and on keyboard focus and leads with the status card's headline.
  const indicator = dashboard.getByTestId('shell.sidebar.recording'), hint = dashboard.getByTestId('shell.recording.hint');
  const hintHeadline = () => dashboard.evaluate(() => [globalThis.document.querySelector('[data-testid="shell.recording.hint"] p')?.textContent,
    globalThis.document.querySelector('[data-testid="health-recording"]')?.textContent]);
  await indicator.hover(); await hint.waitFor({state: 'visible'});
  const [hovered, headline] = await hintHeadline(); assert.ok(headline && headline !== '—'); assert.equal(hovered, headline);
  await dashboard.keyboard.press('Escape'); await hint.waitFor({state: 'hidden'}); await dashboard.mouse.move(0, 0);
  await indicator.focus(); await hint.waitFor({state: 'visible'});
  assert.equal((await hintHeadline())[0], headline);
  await dashboard.screenshot({path: path.join(config.output, `ui-${config.uiCase}-recording-hint.png`), timeout: 5000});
  await dashboard.keyboard.press('Escape'); await hint.waitFor({state: 'hidden'});
  record.flags.recordingIndicator = true;
  // ET-055 UP10, UP11: the version line names this build in both languages, a staging build adds its badge, and the
  // update control is hidden while nothing is offered (a packaged run that is not a Squirrel install is unsupported).
  // The shard's language is restored afterwards, so the steps below run as before.
  const shown = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.language, other = shown === 'en' ? 'ru' : 'en';
  await observeVersionAndUpdate(dashboard, config, shown);
  await chooseLanguage(dashboard, other); await observeVersionAndUpdate(dashboard, config, other);
  await chooseLanguage(dashboard, shown);
  record.flags.versionLine = true; record.flags.updateHidden = true;
  record.flags.offlineFonts = await dashboard.evaluate(() => [...globalThis.document.fonts].some(font => font.family.includes('Onest')));
  assert.equal(record.flags.offlineFonts, true);
  await chooseLanguage(dashboard, 'en'); await screen(dashboard, 'live');
}

/** The sidebar version line and the hidden update control (ET-055 UP10, UP11) in `language`, the language shown now. */
async function observeVersionAndUpdate(dashboard, config, language) {
  const state = await dashboard.evaluate(() => globalThis.desktop.getAppState()), en = language === 'en';
  assert.equal(state.settings.language, language);
  assert.equal(state.application.packaged, config.mode !== 'development');
  assert.match(state.application.version, /^\d+\.\d+\.\d+(-stg\.\d{6})?$/);
  assert.ok(['unsupported', 'idle', 'checking'].includes(state.update.state), `UI_UPDATE_STATE_${state.update.state}`);
  if (config.mode !== 'installed') assert.equal(state.update.state, 'unsupported');
  assert.equal(await dashboard.getByTestId('shell.sidebar.update').count(), 0, 'UI_UPDATE_CONTROL_SHOWN');
  assert.equal(await dashboard.getByTestId('shell.update.status').textContent(), '');
  const text = !state.application.packaged ? (en ? 'Development build' : 'Сборка для разработки') : `${en ? 'Version' : 'Версия'} ${state.application.version}`;
  const line = dashboard.getByTestId('shell.sidebar.version');
  assert.equal(await line.isVisible(), true, 'UI_VERSION_LINE_HIDDEN');
  assert.equal(await line.getAttribute('data-channel'), state.application.channel);
  assert.equal(await dashboard.getByTestId('shell.sidebar.version.text').textContent(), text);
  const badge = dashboard.getByTestId('shell.sidebar.version.badge'), staging = state.application.channel === 'staging';
  assert.equal(await badge.count(), staging ? 1 : 0, 'UI_VERSION_BADGE');
  if (staging) assert.equal(await badge.textContent(), 'Staging');
  assert.equal(await dashboard.getByTestId('shell.sidebar.version.name').textContent(), staging ? `${text}, ${en ? 'staging build' : 'тестовая сборка (staging)'}` : text);
}

const SCALE_CONTROL_TEXT = {en: 'Scale', ru: 'Размер'};
/** Self-contained: the edit scale text and whether the Smaller and Larger buttons are disabled. */
function scaleControls() {
  const node = id => globalThis.document.querySelector(`[data-testid="${id}"]`);
  return {text: node('overlay-edit-scale')?.textContent ?? null, smallerDisabled: node('overlay-scale-down')?.disabled ?? null, largerDisabled: node('overlay-scale-up')?.disabled ?? null};
}
/**
 * ET-045e (decision Z7): the existing edit controls step the scale setting in 10% steps within 50-300%. From the saved
 * scale (100% unless ET-048's editing check saved another), Smaller steps down to 50% with Smaller disabled in both
 * languages. In English, Larger 25 times reaches 300% with Larger disabled; in Russian one Larger step shows 60% with both
 * enabled. Cancel discards the draft: the settings file keeps its bytes and the saved scale is unchanged.
 */
async function observeScaleControl({dashboard, config, language, record}) {
  const settingsFile = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json');
  assert.ok(!path.relative(config.output, settingsFile).startsWith('..'));
  const bytes = await readFile(settingsFile), label = SCALE_CONTROL_TEXT[language];
  await settingsPanel(dashboard, 'overlay');
  const overlay = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay, layout = overlay.layout;
  const savedScale = overlay.placements[layout].scale, from = Math.round(savedScale * 100);
  assert.ok(from >= 50 && from <= 300 && from % 10 === 0, `UI_SCALE_CONTROL_SAVED_SCALE_${savedScale}`);
  await dashboard.getByTestId('overlay-edit-start').click();
  // Each click waits for its own 10% step to render, so the next click steps from the scale main pushed.
  const shown = percent => until(() => dashboard.evaluate(scaleControls), value => value.text === `${label}: ${percent}%`, `UI_SCALE_CONTROL_${language}_${percent}`, 5000);
  const step = async (button, from, delta, times) => {
    let value;
    for (let index = 1; index <= times; index++) {await dashboard.getByTestId(button).click(); value = await shown(from + delta * index);}
    return value;
  };
  const start = await shown(from);
  const smallest = (from - 50) / 10 ? await step('overlay-scale-down', from, -10, (from - 50) / 10) : start;
  assert.deepEqual({smaller: smallest.smallerDisabled, larger: smallest.largerDisabled}, {smaller: true, larger: false}, `UI_SCALE_CONTROL_MIN_${language}`);
  // The limits do not depend on the language, so only English steps all the way to 300%; Russian takes one step up from 50%
  // to show its label with both buttons enabled. This keeps the hosted settings shard inside its Job (docs/ci.md).
  const full = language === 'en', largest = await step('overlay-scale-up', 50, 10, full ? 25 : 1);
  assert.deepEqual({smaller: largest.smallerDisabled, larger: largest.largerDisabled}, {smaller: false, larger: full}, `UI_SCALE_CONTROL_${full ? 'MAX' : 'STEP'}_${language}`);
  await dashboard.getByTestId('overlay-edit-cancel').click();
  const saved = await until(() => dashboard.evaluate(() => ({text: globalThis.document.querySelector('[data-testid="overlay-saved-scale"]')?.textContent ?? null})),
    value => value.text !== null, `UI_SCALE_CONTROL_CANCELLED_${language}`, 5000);
  assert.equal(saved.text, `${label}: ${from}%`);
  const state = await dashboard.evaluate(() => globalThis.desktop.getAppState());
  assert.deepEqual(state.overlayEdit, {active: false}); assert.equal(state.settings.overlay.placements[layout].scale, savedScale);
  assert.deepEqual(await readFile(settingsFile), bytes, `UI_SCALE_CONTROL_WROTE_${language}`);
  (record.scaleControl ??= []).push({language, start: start.text, smallest, largest, cancelled: saved.text});
  record.flags.scaleControl = true;
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
    // ET-050: all four gear display radios are disabled while the settings are read-only.
    for (const game of ['ets2', 'ats']) for (const mode of ['automatic', 'manual', 'crawler']) assert.equal(await dashboard.locator(`#gear-display-${game}-${mode}`).isDisabled(), true);
    await capture({page: dashboard, application, config, record, name: 'read-only', language: 'en', size});
    await settingsPanel(dashboard, 'overlay');
    const opacity = dashboard.getByRole('slider');
    assert.equal(await opacity.getAttribute('aria-disabled'), 'true');
    record.flags.opacityReadOnly = true;
    await waitOverlayVisibility(dashboard, {enabled: true, writable: false}, 'UI_OVERLAY_READ_ONLY_RENDERED');
    for (const layout of layouts) assert.equal(await dashboard.locator(`#overlay-layout-${layout}`).isDisabled(), true);
    assert.equal(await dashboard.getByTestId('overlay-edit-start').isDisabled(), true);
    assert.equal(await dashboard.locator('[data-testid^="overlay-switch-"]:disabled').count(), 15);
    assert.equal(await dashboard.locator('[data-testid^="overlay-preset-"]:disabled').count(), 3);
  }
  const file = path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json');
  assert.equal(await readFile(file, 'utf8'), settingsBytes);
  record.readOnly = {state: settings.state, writable: settings.writable, language: settings.language, bytesUnchanged: true};
  record.flags.readOnly = true;
}
