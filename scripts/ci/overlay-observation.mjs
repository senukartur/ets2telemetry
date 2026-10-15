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
  // ET-012a DOM contract: the visible layout root carries the source, origin, status and freshness as data attributes;
  // speed and fuel keep their number and unit in separate elements whatever the layout.
  const root = read('overlay-root'), speed = read('overlay-speed'), fuel = read('overlay-fuel');
  const speedUnit = read('overlay-speed-unit'), fuelUnit = read('overlay-fuel-unit');
  if (!root || !speed || !fuel || !speedUnit || !fuelUnit) return false;
  const observation = {source: root.getAttribute('data-source'), origin: root.getAttribute('data-origin'), status: root.getAttribute('data-status'),
    freshness: root.getAttribute('data-freshness'), speed: speed.innerText, fuel: fuel.innerText, speedUnit: speedUnit.innerText, fuelUnit: fuelUnit.innerText};
  if (Object.values(observation).some(value => typeof value !== 'string')) return false;
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
  await overlay.getByTestId('overlay-root').waitFor({state: 'attached', timeout: 10000});
  const read = () => {
    const document = globalThis.document;
    const style = node => globalThis.getComputedStyle(node);
    const card = document.querySelector('[data-slot="card"]');
    // ET-012a: the overlay root is transparent; each layout's first visible surface paints the background.
    const widget = document.querySelector('.overlay-surface');
    return {htmlBackground: style(document.documentElement).backgroundColor,
      bodyBackground: style(document.body).backgroundColor,
      themeBackground: style(document.documentElement).getPropertyValue('--background').trim(),
      fontFaces: Array.from(document.fonts).map(font => font.family),
      stylesheets: Array.from(document.styleSheets).map(sheet => sheet.href),
      cardBackground: card ? style(card).backgroundColor : null,
      widgetBackground: widget ? style(widget).backgroundColor : null,
      widgetBackdropFilter: widget ? style(widget).backdropFilter : null};
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
  assert.equal(overlayStyles.widgetBackdropFilter, 'none', 'Overlay must not blur the game behind it');
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
  const windows = await application.evaluate(({BrowserWindow, session}) => BrowserWindow.getAllWindows().map(window => {
    const preferences = window.webContents.getLastWebPreferences();
    return {url: window.webContents.mainFrame.url, rendererPid: window.webContents.getOSProcessId(),
      isDefaultSession: window.webContents.session === session.defaultSession,
      isOverlaySession: window.webContents.session === session.fromPartition('ets2telemetry-overlay'),
      sessionPersistent: window.webContents.session.getStoragePath() !== null,
      sandbox: preferences.sandbox, isolation: preferences.contextIsolation,
      node: preferences.nodeIntegration, visible: window.isVisible(), focusable: window.isFocusable(),
      // On Windows, Chromium derives this from the HWND's actual WS_EX_TOPMOST style, not a cached flag.
      alwaysOnTop: window.isAlwaysOnTop()};
  }));
  assert.equal(windows.length, 2, 'Exactly the dashboard and overlay must exist');
  for (const window of windows) assert.deepEqual({sandbox: window.sandbox, isolation: window.isolation, node: window.node}, {sandbox: true, isolation: true, node: false});
  for (const window of windows) assert.ok(Number.isSafeInteger(window.rendererPid) && window.rendererPid > 0, 'Actual renderer PID must be available');
  const overlay = windows.filter(window => new URL(window.url).search === '?view=overlay');
  assert.equal(overlay.length, 1); assert.equal(overlay[0].visible, false); assert.equal(overlay[0].focusable, false);
  // The hidden overlay already holds WS_EX_TOPMOST; Electron's `floating` level could lose it behind the taskbar.
  assert.equal(overlay[0].alwaysOnTop, true, 'Overlay window must be topmost');
  const dashboard = windows.filter(window => new URL(window.url).search === '');
  assert.equal(dashboard.length, 1); assert.equal(dashboard[0].alwaysOnTop, false, 'Dashboard must not be topmost');
  assert.notEqual(overlay[0].rendererPid, dashboard[0].rendererPid, 'Overlay and dashboard must use independent renderer processes');
  assert.deepEqual([overlay[0].isDefaultSession, overlay[0].isOverlaySession, overlay[0].sessionPersistent], [false, true, false]);
  assert.deepEqual([dashboard[0].isDefaultSession, dashboard[0].isOverlaySession, dashboard[0].sessionPersistent], [true, false, true]);
  return windows;
}

// The owned renderer is held at a DevTools `debugger` statement. While paused, its main thread runs no
// page tasks (port messages, credits, timers or rendering) and burns no CPU, so the capped Job cannot starve
// the independent renderer, service, main process or observer. A CPU-spinning stall did exactly that on a
// hosted runner (run 38314471366): the reading reached the independent DOM during the stall, but its polled
// receipt arrived after the spin. Receiving Debugger.paused for our marker frame is the start barrier.
// Only this observer resumes the renderer, so an observation received before resume is definitely pending.
// Runtime callers use the defaults; the receipt validator independently requires 6000 ms. Tests may inject
// the driver's high-resolution clock to prove the hold does not trust millisecond timer granularity.
export async function proveIndependentDuringStall(page, kind, independentObservation, source, proof,
  {requestedMilliseconds = 6000, now = () => performance.now()} = {}) {
  const marker = `ETS2TELEMETRY_${kind.toUpperCase()}_STALL_${randomUUID()}`;
  Object.assign(proof, {kind, marker, requestedMilliseconds, stallMethod: 'debugger-pause', started: false, completed: false});
  const session = await page.context().newCDPSession(page);
  let completed = false, resumed = false, resumeTimer, pauseTimer;
  // Only the deliberate hold records resumeRequestedObserverMonotonicMs. A failure-path cleanup resume is
  // recorded separately so retained partial evidence never implies a hold that did not happen.
  const sendResume = field => {
    if (resumed) return Promise.resolve();
    resumed = true; proof[field] = now();
    return session.send('Debugger.resume');
  };
  const resume = () => sendResume('resumeRequestedObserverMonotonicMs');
  let execution = Promise.resolve();
  try {
    const paused = new Promise((resolve, reject) => {
      pauseTimer = setTimeout(() => reject(new Error('EXPECTED_RENDERER_PAUSE_WITHIN_10_SECONDS')), 10000);
      session.on('Debugger.paused', event => {clearTimeout(pauseTimer); resolve(event);});
    });
    void paused.catch(() => {});
    await session.send('Debugger.enable');
    execution = session.send('Runtime.evaluate', {returnByValue: true, expression: `(() => {
      const marker = ${JSON.stringify(marker)}, rendererStartedMonotonicMs = performance.now();
      debugger; // controlled owned renderer stall
      return {marker, rendererStartedMonotonicMs, rendererCompletedMonotonicMs: performance.now()};
    })()`}).then(response => {
      if (response.exceptionDetails || response.result?.value?.marker !== marker) throw new Error('Renderer stall evaluation failed');
      const {rendererStartedMonotonicMs, rendererCompletedMonotonicMs} = response.result.value;
      completed = true;
      Object.assign(proof, {rendererStartedMonotonicMs, rendererCompletedMonotonicMs, completed: true, completedObserverMonotonicMs: now()});
    });
    void execution.catch(() => {});
    const event = await paused;
    const frame = event.callFrames?.[0]?.callFrameId;
    const barrier = frame === undefined ? undefined : await session.send('Debugger.evaluateOnCallFrame',
      {callFrameId: frame, returnByValue: true, expression: '({marker, rendererStartedMonotonicMs})'});
    assert.equal(event.reason, 'other', 'Renderer paused for an unexpected reason');
    assert.equal(barrier?.result?.value?.marker, marker, 'Renderer paused outside the owned stall frame');
    const rendererStart = barrier.result.value.rendererStartedMonotonicMs;
    assert.ok(Number.isFinite(rendererStart) && rendererStart >= 0, 'Invalid renderer stall-start barrier');
    Object.assign(proof, {started: true, pauseReason: event.reason, rendererStartBarrierMonotonicMs: rendererStart, startedObserverMonotonicMs: now()});
    assert.equal(completed, false, 'Renderer completed before its start barrier was observed');
    // Hold the pause for the requested duration whether or not the observation arrives. Timers have
    // millisecond granularity and may fire just before the high-resolution deadline, so recheck it.
    const resumeAt = proof.startedObserverMonotonicMs + requestedMilliseconds;
    const held = (async () => {
      while (now() < resumeAt) await new Promise(resolve => {resumeTimer = setTimeout(resolve, Math.ceil(resumeAt - now()) + 1);});
      await resume();
    })();
    void held.catch(() => {});
    source.setReading(20, 71); proof.readingChangedObserverMonotonicMs = now();
    proof.independentObservation = await independentObservation();
    proof.observedObserverMonotonicMs = now();
    proof.readingObservedObserverMonotonicMs = proof.independentObservation.reading.observedObserverMonotonicMs;
    assert.ok(proof.readingChangedObserverMonotonicMs < proof.readingObservedObserverMonotonicMs &&
      proof.readingObservedObserverMonotonicMs <= proof.observedObserverMonotonicMs, 'Changed DOM reading must precede its window metadata receipt');
    proof.sourceAtObservation = source.statistics(); proof.pendingAtObservation = !resumed && !completed;
    assert.equal(proof.pendingAtObservation, true, 'Independent reading arrived after the stalled renderer completed');
    assert.equal(proof.sourceAtObservation.connections, 1, 'Independent observation reconnected the source');
    assert.equal(proof.sourceAtObservation.activeClients, 1);
    await held; await execution;
    assert.equal(proof.rendererStartBarrierMonotonicMs, proof.rendererStartedMonotonicMs);
    assert.ok(proof.rendererCompletedMonotonicMs - proof.rendererStartedMonotonicMs >= requestedMilliseconds);
    assert.ok(proof.resumeRequestedObserverMonotonicMs - proof.startedObserverMonotonicMs >= requestedMilliseconds);
    assert.ok(proof.startedObserverMonotonicMs <= proof.readingChangedObserverMonotonicMs &&
      proof.readingChangedObserverMonotonicMs < proof.observedObserverMonotonicMs && proof.observedObserverMonotonicMs < proof.resumeRequestedObserverMonotonicMs &&
      proof.resumeRequestedObserverMonotonicMs <= proof.completedObserverMonotonicMs);
  } finally {
    // Never leave an owned renderer paused: resume, then detach (detaching also releases any pause
    // and rejects a still-pending evaluation instead of waiting on it).
    clearTimeout(pauseTimer); clearTimeout(resumeTimer);
    await sendResume('cleanupResumeObserverMonotonicMs').catch(() => {}); await session.detach().catch(() => {}); await execution.catch(() => {});
  }
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
  // ET-012a: a saved layout reaches the overlay document through main. The settings file lives in the run's isolated
  // LOCALAPPDATA. Recorded for review only; RuntimeReceipt.ps1 does not validate this field.
  const deadline = performance.now() + 10000;
  while (!(await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.writable) {
    if (performance.now() >= deadline) throw new Error('EXPECTED_WRITABLE_SETTINGS_WITHIN_10_SECONDS');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const saved = await dashboard.evaluate(() => globalThis.desktop.setOverlayLayout('card'));
  assert.equal(saved.overlay.layout, 'card');
  const rendered = await overlay.waitForFunction(() => {
    const roots = globalThis.document.querySelectorAll('[data-testid="overlay-root"]');
    return roots.length === 1 && roots[0].getAttribute('data-layout') === 'card' ? roots[0].getAttribute('data-layout') : false;
  }, undefined, {timeout: 10000, polling: 50});
  try {result.layoutSwitch = {requested: 'card', saved: saved.overlay.layout, rendered: await rendered.jsonValue()};} finally {await rendered.dispose();}
  result.editMode = await runEditStep(application, dashboard, overlay);
  return result;
}

// Self-contained browser callback: the overlay root's edit marker and the styles that make it a visible drag region.
function overlayEditing(expected) {
  const roots = globalThis.document.querySelectorAll('[data-testid="overlay-root"]');
  if (roots.length !== 1 || roots[0].getAttribute('data-editing') !== expected) return false;
  const style = globalThis.getComputedStyle(roots[0]);
  return {editing: expected, cursor: style.cursor, outlineStyle: style.outlineStyle, pointerEvents: style.pointerEvents};
}
async function waitForEditing(page, expected) {
  const handle = await page.waitForFunction(overlayEditing, expected, {timeout: 10000, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
async function zoomFactors(application) {
  const windows = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(window =>
    ({url: window.webContents.mainFrame.url, zoom: window.webContents.getZoomFactor()})));
  const of = search => windows.filter(window => new URL(window.url).search === search).map(window => window.zoom);
  return {overlay: of('?view=overlay'), dashboard: of('')};
}

// ET-012b edit mode (REG-016, REG-017). The synthetic source has no game window, so edit mode waits for the game: the
// overlay never shows, never becomes focusable and stays topmost while its document is marked as editing. A saved scale
// reaches only the overlay's zoom factor; the dashboard keeps 1 in its own session. Recorded for review only;
// RuntimeReceipt.ps1 does not validate this field.
async function runEditStep(application, dashboard, overlay) {
  const step = {};
  step.zoomBefore = await zoomFactors(application);
  assert.deepEqual(step.zoomBefore, {overlay: [1], dashboard: [1]});
  step.begun = await dashboard.evaluate(() => globalThis.desktop.beginOverlayEdit());
  assert.deepEqual(step.begun, {active: true, layout: 'card', scale: 1, placement: 'waiting-for-game'});
  step.renderedWhileEditing = await waitForEditing(overlay, 'true');
  assert.deepEqual(step.renderedWhileEditing, {editing: 'true', cursor: 'move', outlineStyle: 'dashed', pointerEvents: 'auto'});
  // windowSecurity requires the overlay hidden, not focusable and topmost.
  step.windowsWhileEditing = await windowSecurity(application);
  await assert.rejects(dashboard.evaluate(() => globalThis.desktop.setOverlayLayout('hud')), /cannot change while its position is edited/);
  step.layoutLocked = true;
  step.scaled = await dashboard.evaluate(() => globalThis.desktop.setOverlayEditScale(1.5));
  assert.deepEqual(step.scaled, {active: true, layout: 'card', scale: 1.5, placement: 'waiting-for-game'});
  step.saved = await dashboard.evaluate(() => globalThis.desktop.finishOverlayEdit('save'));
  assert.equal(step.saved.overlay.layout, 'card');
  assert.deepEqual(step.saved.overlay.placements.card, {x: 1, y: 0, scale: 1.5});
  step.renderedAfterSave = await waitForEditing(overlay, 'false');
  assert.equal(step.renderedAfterSave.outlineStyle, 'none');
  step.appState = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).overlayEdit;
  assert.deepEqual(step.appState, {active: false});
  step.windowsAfterSave = await windowSecurity(application);
  step.zoomAfterSave = await zoomFactors(application);
  assert.deepEqual(step.zoomAfterSave, {overlay: [1.5], dashboard: [1]});
  return step;
}
