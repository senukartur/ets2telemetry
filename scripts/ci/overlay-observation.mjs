import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';

// Playwright serializes this callback. Each accepted state is one coherent DOM read.
// DOM layout inside the hidden renderer is not evidence of an OS-visible overlay.
export function overlayObservation(expected) {
  const read = id => {
    const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    if (nodes.length !== 1) return undefined;
    const node = nodes[0], bounds = node.getBoundingClientRect();
    if (globalThis.getComputedStyle(node).visibility !== 'visible' || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= globalThis.innerHeight || bounds.left >= globalThis.innerWidth) return undefined;
    return node;
  };
  const status = read('overlay-status'), speed = read('overlay-speed'), fuel = read('overlay-fuel');
  if (!status || !speed || !fuel) return false;
  const fields = status.innerText.split(' · ');
  if (fields.length !== 4) return false;
  const observation = {source: fields[0], origin: fields[1], status: fields[2], freshness: fields[3],
    speed: speed.innerText, fuel: fuel.innerText,
    speedUnit: speed.parentElement?.lastElementChild?.innerText, fuelUnit: fuel.parentElement?.lastElementChild?.innerText};
  return Object.entries(expected).every(([key, value]) => key === 'statuses' ? value.includes(observation.status) : observation[key] === value) ? observation : false;
}

export async function waitForOverlay(page, expected) {
  // Observe DOM delivery independently of Chromium's animation-frame scheduling.
  const handle = await page.waitForFunction(overlayObservation, expected, {timeout: 10000, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// Inspect the CSS actually loaded by each isolated renderer, including dynamic Vite chunks.
// A hidden DOM check protects style isolation; it does not establish real game visibility.
export async function verifyRendererStyles(dashboard, overlay) {
  await overlay.getByTestId('overlay-status').waitFor({state: 'attached', timeout: 10000});
  const read = () => {
    const document = globalThis.document;
    const style = node => globalThis.getComputedStyle(node);
    const card = document.querySelector('[data-slot="card"]');
    const widget = document.querySelector('.overlay');
    return {htmlBackground: style(document.documentElement).backgroundColor,
      bodyBackground: style(document.body).backgroundColor,
      themeBackground: style(document.documentElement).getPropertyValue('--background').trim(),
      fontFaces: Array.from(document.fonts).map(font => font.family),
      stylesheets: Array.from(document.styleSheets).map(sheet => sheet.href),
      cardBackground: card ? style(card).backgroundColor : null,
      widgetBackground: widget ? style(widget).backgroundColor : null};
  };
  const mainStyles = await dashboard.evaluate(read);
  const overlayStyles = await overlay.evaluate(read);
  assert.ok(mainStyles.themeBackground && mainStyles.cardBackground && mainStyles.cardBackground !== 'rgba(0, 0, 0, 0)', 'Dashboard shadcn theme and Card must be styled');
  assert.ok(mainStyles.fontFaces.some(family => family.includes('Geist')), 'Dashboard must retain the configured Geist font');
  assert.equal(overlayStyles.htmlBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(overlayStyles.bodyBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(overlayStyles.themeBackground, '', 'Overlay must not load the main theme');
  assert.deepEqual(overlayStyles.fontFaces, [], 'Overlay must not load main-window font faces');
  assert.equal(overlayStyles.widgetBackground, 'rgba(10, 17, 24, 0.88)');
  assert.ok(mainStyles.stylesheets.length > 0 && overlayStyles.stylesheets.length > 0);
  assert.ok(overlayStyles.stylesheets.every(href => href && !mainStyles.stylesheets.includes(href)), 'Renderer CSS assets must be separate');
  return {dashboard: mainStyles, overlay: overlayStyles};
}

export async function rendererPages(application) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const pages = application.windows();
    const dashboard = pages.filter(page => page.url().startsWith('file:') && /\/renderer\/index\.html$/.test(new URL(page.url()).pathname) && new URL(page.url()).search === '');
    const overlay = pages.filter(page => page.url().startsWith('file:') && /\/renderer\/index\.html$/.test(new URL(page.url()).pathname) && new URL(page.url()).search === '?view=overlay');
    if (dashboard.length === 1 && overlay.length === 1 && pages.length === 2) return {dashboard: dashboard[0], overlay: overlay[0]};
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('EXPECTED_EXACT_DASHBOARD_AND_OVERLAY_URLS_WITHIN_10_SECONDS');
}

export async function windowSecurity(application) {
  const windows = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(window => {
    const preferences = window.webContents.getLastWebPreferences();
    return {url: window.webContents.mainFrame.url, sandbox: preferences.sandbox, isolation: preferences.contextIsolation,
      node: preferences.nodeIntegration, visible: window.isVisible(), focusable: window.isFocusable()};
  }));
  assert.equal(windows.length, 2, 'Exactly the dashboard and overlay must exist');
  for (const window of windows) assert.deepEqual({sandbox: window.sandbox, isolation: window.isolation, node: window.node}, {sandbox: true, isolation: true, node: false});
  const overlay = windows.filter(window => new URL(window.url).search === '?view=overlay');
  assert.equal(overlay.length, 1); assert.equal(overlay[0].visible, false); assert.equal(overlay[0].focusable, false);
  return windows;
}

// The owned renderer emits the unique console marker immediately before blocking.
// Receiving it is the start barrier; awaiting evaluate later is the completion barrier.
export async function proveIndependentDuringStall(page, kind, independentObservation, source, proof) {
  const marker = `ETS2TELEMETRY_${kind.toUpperCase()}_STALL_${randomUUID()}`;
  Object.assign(proof, {kind, marker, requestedMilliseconds: 6000, started: false, completed: false});
  let completed = false;
  const started = page.waitForEvent('console', {predicate: message => message.text().startsWith(`${marker} `), timeout: 10000});
  void started.catch(() => {});
  const execution = page.evaluate(({marker}) => {
    const rendererStartedMonotonicMs = performance.now();
    console.log(`${marker} ${rendererStartedMonotonicMs}`);
    const until = rendererStartedMonotonicMs + 6000;
    while (performance.now() < until) { /* controlled owned renderer stall */ }
    return {rendererStartedMonotonicMs, rendererCompletedMonotonicMs: performance.now()};
  }, {marker}).then(timing => {
    completed = true;
    Object.assign(proof, timing, {completed: true, completedObserverMonotonicMs: performance.now()});
  });
  void execution.catch(() => {});
  try {
    const event = await started;
    const rendererStart = Number(event.text().slice(marker.length + 1));
    assert.ok(Number.isFinite(rendererStart) && rendererStart >= 0, 'Invalid renderer stall-start barrier');
    Object.assign(proof, {started: true, rendererStartBarrierMonotonicMs: rendererStart, startedObserverMonotonicMs: performance.now()});
    assert.equal(completed, false, 'Renderer completed before its start barrier was observed');
    source.setReading(20, 71); proof.readingChangedObserverMonotonicMs = performance.now();
    proof.independentObservation = await independentObservation();
    proof.observedObserverMonotonicMs = performance.now();
    proof.readingObservedObserverMonotonicMs = proof.independentObservation.reading.observedObserverMonotonicMs;
    assert.ok(proof.readingChangedObserverMonotonicMs < proof.readingObservedObserverMonotonicMs &&
      proof.readingObservedObserverMonotonicMs <= proof.observedObserverMonotonicMs, 'Changed DOM reading must precede its window metadata receipt');
    proof.sourceAtObservation = source.statistics(); proof.pendingAtObservation = !completed;
    assert.equal(proof.pendingAtObservation, true, 'Independent reading arrived after the stalled renderer completed');
    assert.equal(proof.sourceAtObservation.connections, 1, 'Independent observation reconnected the source');
    assert.equal(proof.sourceAtObservation.activeClients, 1);
    await execution;
    assert.equal(proof.rendererStartBarrierMonotonicMs, proof.rendererStartedMonotonicMs);
    assert.ok(proof.rendererCompletedMonotonicMs - proof.rendererStartedMonotonicMs >= 6000);
    assert.ok(proof.startedObserverMonotonicMs <= proof.readingChangedObserverMonotonicMs &&
      proof.readingChangedObserverMonotonicMs < proof.observedObserverMonotonicMs && proof.observedObserverMonotonicMs < proof.completedObserverMonotonicMs);
  } finally {await execution;}
}

export async function runOverlaySmoke(application, dashboard, overlay, source, result) {
  Object.assign(result, {scope: 'hidden synthetic renderer; OS visibility, focus and input unverified', origin: 'synthetic', recording: false,
    observations: [], windows: []});
  const expected = {source: 'ETS2', origin: 'synthetic', statuses: ['connected'], freshness: 'current', speed: '90.0', fuel: '73.0', speedUnit: 'km/h', fuelUnit: 'L'};
  const observe = async (phase, change = {}) => {
    const observation = {phase, ...await waitForOverlay(overlay, {...expected, ...change}), observedObserverMonotonicMs: performance.now()};
    result.observations.push(observation);
    result.windows.push({phase, windows: await windowSecurity(application)});
    return observation;
  };
  const dashboardReading = async (speed, fuel) => {
    const handle = await dashboard.waitForFunction(({speed, fuel}) => {
      const read = id => {const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`); return nodes.length === 1 ? nodes[0].innerText : undefined;};
      const observation = {status: read('telemetry-status'), speed: read('speed'), fuel: read('fuel')};
      return /^connected:/.test(observation.status ?? '') && observation.speed === `Speed: ${speed} km/h` && observation.fuel === `Fuel: ${fuel} L` ? observation : false;
    }, {speed, fuel}, {timeout: 10000, polling: 50});
    try {const observation = await handle.jsonValue(); assert.ok(observation); return {...observation, observedObserverMonotonicMs: performance.now()};} finally {await handle.dispose();}
  };
  result.bridge = await overlay.evaluate(() => ({require: typeof globalThis.require, process: typeof globalThis.process,
    desktop: typeof globalThis.desktop, keys: Object.getOwnPropertyNames(globalThis.overlay), frozen: Object.isFrozen(globalThis.overlay)}));
  assert.deepEqual(result.bridge, {require: 'undefined', process: 'undefined', desktop: 'undefined', keys: ['subscribeOverlay'], frozen: true});
  await observe('initial'); result.sourceBefore = source.statistics();
  source.setReading(20, 71); await observe('changed', {speed: '72.0', fuel: '71.0'}); await dashboardReading('72.0', '71.0');
  result.changedReading = {speedKmh: 72, fuelL: 71};
  source.setUnavailable(); await observe('missing', {speed: '—', fuel: '—'});
  result.missingDistinctFromZero = true;
  source.setReading(0, 0); await observe('zero', {speed: '0.0', fuel: '0.0'});
  source.setReading(25, 73); await observe('restored');
  source.hold(); await observe('silent-open-stale', {statuses: ['stale'], freshness: 'stale', speed: '—', fuel: '—'});
  result.silentOpenSource = source.statistics();
  assert.equal(result.silentOpenSource.activeClients, 1); assert.equal(result.silentOpenSource.connections, 1); assert.equal(result.silentOpenSource.held, true);
  result.silentOpenStale = true;
  source.resume(); await observe('resumed'); result.resumeRecovered = true;
  await overlay.reload({timeout: 10000}); await observe('overlay-reload'); await dashboardReading('90.0', '73.0');
  result.stylesAfterOverlayReload = await verifyRendererStyles(dashboard, overlay);
  assert.equal(source.statistics().connections, 1); result.overlayReloadIndependent = true;
  result.overlayStallProof = {};
  await proveIndependentDuringStall(overlay, 'overlay', async () => ({reading: await dashboardReading('72.0', '71.0'),
    windows: await windowSecurity(application)}), source, result.overlayStallProof);
  await observe('overlay-credit-recovery', {speed: '72.0', fuel: '71.0'}); await dashboardReading('72.0', '71.0');
  assert.equal(source.statistics().connections, 1); result.overlayCreditRecovered = true; result.overlayStallMilliseconds = 6000;
  await dashboard.reload({timeout: 10000}); await dashboardReading('72.0', '71.0'); await observe('dashboard-reload', {speed: '72.0', fuel: '71.0'});
  assert.equal(source.statistics().connections, 1); result.dashboardReloadIndependent = true;
  source.setReading(25, 73); await observe('before-dashboard-stall');
  result.dashboardStallProof = {};
  await proveIndependentDuringStall(dashboard, 'dashboard', async () => ({reading: await observe('during-dashboard-stall', {speed: '72.0', fuel: '71.0'}),
    windows: await windowSecurity(application)}), source, result.dashboardStallProof);
  await dashboardReading('72.0', '71.0'); await observe('dashboard-credit-recovery', {speed: '72.0', fuel: '71.0'});
  assert.equal(source.statistics().connections, 1); result.dashboardCreditIndependent = true; result.dashboardStallMilliseconds = 6000;
  await source.stop(); await observe('disconnected', {statuses: ['disconnected', 'waiting'], freshness: 'unavailable', speed: '—', fuel: '—'});
  result.disconnectUnavailable = true; result.sourceAfter = source.statistics();
  assert.equal(result.sourceAfter.connections, 1); assert.equal(result.sourceAfter.activeClients, 0); assert.equal(result.sourceAfter.stopped, true);
  assert.deepEqual(result.sourceBefore.identity, result.sourceAfter.identity);
  result.sourceIdentityPreserved = true;
  return result;
}
