import {dashboardObservation} from './dashboard-observation.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
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

// ET-012c strip containment. The synthetic checkpoint fixture (tests/fixtures/protocol-v0/checkpoint.json) carries
// current values for these sections, in canonical order; range stays hidden because its estimate is not observed.
export const STRIP_SMOKE_SECTIONS = Object.freeze(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']);
// The hidden overlay window is created at the strip's reserved size for every section at the scale setting 1, 1280 x 82
// DIP at zoom 0.7 (overlay-geometry.ts, ET-045e; ET-052's fifteenth section needs a third row, 56 DIP with two), so its
// CSS viewport is 82 / 0.7 = 117.14 high, within one CSS px of rounding, and up to 1280 / 0.7 = 1828.57 wide. Without a game window main never places it, and Windows limits a window
// to the screen size, so on a narrow screen it is narrower (1024 DIP, about 1462 CSS px, on the hosted runner of CI run
// 38878781715). The height is not limited, and the CSS width must stay within the strip's own limits of 480 to 1829.
// The height may differ by one DIP of physical rounding at a fractional display scale (1 / 0.7 CSS px) plus half a CSS
// px of viewport rounding, the same rule as zoomedViewportTolerance below (ET-045e verifier round 1).
export const STRIP_SMOKE_WINDOW = Object.freeze({innerHeight: 117, heightTolerance: 1 / 0.7 + 0.5, minWidth: 480, maxWidth: 1829});

// Self-contained browser callback: false until exactly one current strip root shows exactly the expected sections, then
// one coherent read of where they lie. `outside` lists sections with an empty box or one not fully inside both the root
// (the window's viewport) and the strip row, which clips its overflow. `uncapped` lists strip items without a maximum
// width. `truncated` (values that end in an ellipsis) and `rows` (distinct section tops) are recorded for review only.
export function stripLayoutObservation(expected) {
  const roots = globalThis.document.querySelectorAll('[data-testid="overlay-root"]');
  if (roots.length !== 1) return false;
  const root = roots[0];
  if (root.getAttribute('data-layout') !== 'strip' || root.getAttribute('data-freshness') !== 'current') return false;
  const nodes = Array.from(root.querySelectorAll('[data-testid^="overlay-section-"]'));
  const sections = nodes.map(node => String(node.getAttribute('data-testid')).slice('overlay-section-'.length));
  if (sections.length !== expected.sections.length || sections.some((id, index) => id !== expected.sections[index])) return false;
  const row = root.querySelector('.overlay-strip-row');
  if (!row) return false;
  const rootBox = root.getBoundingClientRect(), rowBox = row.getBoundingClientRect();
  const within = (box, outer) => box.left >= outer.left && box.top >= outer.top && box.right <= outer.right && box.bottom <= outer.bottom;
  const outside = [], truncated = [], tops = new Set();
  nodes.forEach((node, index) => {
    const box = node.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0) || !within(box, rootBox) || !within(box, rowBox)) outside.push(sections[index]);
    tops.add(Math.round(box.top));
    const value = node.querySelector('.overlay-value');
    if (value && value.scrollWidth > value.clientWidth) truncated.push(sections[index]);
  });
  const uncapped = Array.from(row.children).filter(child => globalThis.getComputedStyle(child).maxWidth === 'none')
    .map(child => child.getAttribute('data-testid') ?? String(child.className));
  return {viewport: {innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight}, sections, outside, uncapped, truncated, rows: tops.size};
}

/**
 * Every shown strip section lies inside the overlay window, every item is capped, and the window has the reserved
 * height with a width the screen may have narrowed. The actual viewport stays in the recorded observation.
 */
export function verifyStripLayout(observation) {
  assert.deepEqual(observation.outside, [], 'Enabled strip sections lie outside the overlay window');
  const {innerWidth, innerHeight} = observation.viewport;
  assert.ok(Number.isFinite(innerHeight) && Math.abs(innerHeight - STRIP_SMOKE_WINDOW.innerHeight) <= STRIP_SMOKE_WINDOW.heightTolerance,
    'The strip overlay window must have its reserved size');
  assert.ok(Number.isFinite(innerWidth) && innerWidth >= STRIP_SMOKE_WINDOW.minWidth && innerWidth <= STRIP_SMOKE_WINDOW.maxWidth,
    `The strip overlay window width must lie between ${STRIP_SMOKE_WINDOW.minWidth} and ${STRIP_SMOKE_WINDOW.maxWidth}`);
  assert.deepEqual(observation.uncapped, [], 'Every strip item must have a maximum width');
  return observation;
}

export async function waitForStripLayout(page, expected) {
  const handle = await page.waitForFunction(stripLayoutObservation, expected, {timeout: 10000, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// ET-012d containment of the card, cluster and HUD (decisions K10 and K11). The telemetry smoke first saves exactly the
// thirteen sections the v0 and v1 pair shows (SYNTHETIC_V1_STRIP_SECTIONS: every section but range and distance driven;
// twelve before ET-052 added the next mandatory break, which the pair's 95-minute break shows), so the window reserves no
// row for a hidden section. Without a game window main never places the hidden overlay, so
// the smoke sizes it to each layout's window for those sections at the scale setting 1 (overlayWindowSize in
// overlay-geometry.ts) at that setting's zoom, overlayZoom(1) = 0.7 (ET-045e). ET-052 re-derived: the card's content is
// 46 + 24 × 13 = 358 CSS px, so ceil(358 × 0.7 + 2) = 253 DIP high (above its nominal floor of 252), 210 wide; the
// cluster's panel holds 10 sections outside the gauge, a reserve of 36 + 21 × 10 = 246 CSS px (content 244), so
// ceil(244 × 0.7 + 2) = 173 high, 308 wide; the HUD's content is 18 + 24 × 13 = 330, so ceil(330 × 0.7) = 231 high (above
// its floor of 224), 224 wide. Their CSS viewports are 300 × 361.43, 440 × 247.14 and 320 × 330. The
// reserved CSS heights are 48 + 24 × 13 = 360, 246 and 18 + 24 × 13 = 330 (layoutReservedCss in overlay-rows.ts). A unit
// test ties these hand-written values to both functions and the zoom to overlayZoom. All three windows are smaller than
// the hosted runner's 1024 x 768 screen, so Windows does not narrow them.
export const LAYOUT_SMOKE_WINDOWS = Object.freeze({
  card: Object.freeze({width: 210, height: 253}),
  cluster: Object.freeze({width: 308, height: 173}),
  hud: Object.freeze({width: 224, height: 231})
});
export const LAYOUT_SMOKE_ZOOM = 0.7;
/**
 * ET-045e verifier round 1: at a fractional display scale Windows applies a window size in whole physical pixels, and
 * `getBounds`/`getContentBounds` convert that back to DIP rounded, so the DIP readback can differ from the CSS viewport
 * by up to one DIP (at 150% the 210 DIP card's bounds read back as 211 while its content and viewport stayed 210 DIP and
 * 300 CSS px; the 159 DIP cluster's content read back as 160, viewport 229 CSS px). The expected CSS viewport is
 * therefore the window's actual content size in DIP (`getContentBounds`) divided by the zoom, within one DIP of
 * rounding (1 / zoom CSS px) plus half a CSS px of the viewport's own rounding. At zoom 0.7 that is 1.93 CSS px, so the
 * ET-045d cluster's 225 px viewport for a 159 DIP window (227.14) and a two-DIP error (2.86) still fail.
 */
export const zoomedViewportTolerance = zoom => 1 / zoom + 0.5;
/**
 * The overlay window Windows applied for a smoke resize: within one DIP below and two DIP above the requested size. Only
 * +1 DIP was observed (150%); the second DIP is a margin for other fractional scales. Containment stays exact against
 * the reserved content height, and the viewport is checked against the actual content size, not the request.
 */
export function verifyAppliedWindow(requested, actual) {
  const near = (value, wanted) => Number.isFinite(value) && value >= wanted - 1 && value <= wanted + 2;
  assert.ok(actual && near(actual.width, requested.width) && near(actual.height, requested.height),
    `The overlay window was not applied at the requested size: ${JSON.stringify(requested)} became ${JSON.stringify(actual)}`);
  return actual;
}
export const LAYOUT_SMOKE_RESERVED_CSS = Object.freeze({card: 360, cluster: 246, hud: 330});
// ET-045e review frames for the UI overlay shard, at the zoom of a scale setting (overlayZoom in overlay-placement.ts).
// SCALE_REFERENCE_FRAMES are the product windows with every section at the new 100% (overlayWindowSize(layout, 1)) and
// the ET-045d strip at its 70% (896 × 82 at zoom 0.7) and 100% (1280 × 116 at zoom 1) for the owner's comparison.
// SCALE_RANGE_FRAMES are the product windows at 50% (zoom 0.35: strip 1280 × 16, card 105 × 145, cluster 154 × 103, HUD
// 112 × 133 with ET-052's fifteen sections; 136, 95 and 124 with fourteen), the strip raised to the 38 DIP minimum height
// that the ET-045c probe measured at 150%. The ET-045e probe at 150% showed Windows accepting the card, cluster and HUD
// within one DIP (106 × 136, 154 × 96, 112 × 124); if a hosted runner refuses a size, the frame wait fails and the
// refusal is recorded. The 100% references are the ET-052 product windows: strip 1280 × 82 (three rows), card 210 × 287,
// cluster 308 × 203 and HUD 224 × 265 (56, 270, 188 and 248 with fourteen sections).
export const SCALE_REFERENCE_FRAMES = Object.freeze([
  Object.freeze({name: 'scale-strip', layout: 'strip', zoom: 0.7, width: 1280, height: 82}),
  Object.freeze({name: 'scale-card', layout: 'card', zoom: 0.7, width: 210, height: 287}),
  Object.freeze({name: 'scale-cluster', layout: 'cluster', zoom: 0.7, width: 308, height: 203}),
  Object.freeze({name: 'scale-hud', layout: 'hud', zoom: 0.7, width: 224, height: 265}),
  Object.freeze({name: 'scale-strip-old70', layout: 'strip', zoom: 0.7, width: 896, height: 82}),
  Object.freeze({name: 'scale-strip-old100', layout: 'strip', zoom: 1, width: 1280, height: 116})
]);
export const SCALE_RANGE_ZOOM = 0.35;
export const SCALE_RANGE_FRAMES = Object.freeze({
  strip: Object.freeze({width: 1280, height: 38}),
  card: Object.freeze({width: 105, height: 145}),
  cluster: Object.freeze({width: 154, height: 103}),
  hud: Object.freeze({width: 112, height: 133})
});

// Self-contained browser callback: false until exactly one current root of the expected layout shows exactly the
// expected sections, then one coherent read of where they lie. `outside` lists sections with an empty box or one not
// fully inside the root (the window's viewport) and every ancestor up to the root that clips its overflow, such as the
// cluster's side panel. `clipped` lists sections whose value box is not vertically inside the section's fixed row.
// `bottom` is the lowest section bottom below the higher of the root's top and the top of the surface that holds the
// rows (the card body, the cluster's side panel or the HUD lines; the root alone for the cluster's gauge sections),
// which the row model's reserve must cover. The surface's top matters for the cluster: its panel is bottom-aligned, so
// space the model does not count grows the panel upwards past the root's top while its lowest row stays where it was.
// The root's top matters for the top-aligned card and HUD: space that pushes their surface down, such as a margin on
// the card body or padding on the root, moves the rows down with it. `surfaces` records each such
// surface's box and whether it lies inside the root. `truncated` (values that end in an ellipsis) is recorded for review
// only. Every comparison allows 0.01 CSS px: Chromium reports a
// box flush with its row's edge with float noise, such as the cluster's RPM value ending at 221.3229217529297 in a row
// ending at 221.32291793823242. That is below one 1/64 px layout unit at display scaling up to 150 % and about 1/50 of a
// device pixel at 200 %, so it never hides a visible overhang.
export function layoutContainmentObservation(expected) {
  const roots = globalThis.document.querySelectorAll('[data-testid="overlay-root"]');
  if (roots.length !== 1) return false;
  const root = roots[0];
  if (root.getAttribute('data-layout') !== expected.layout || root.getAttribute('data-freshness') !== 'current') return false;
  const nodes = Array.from(root.querySelectorAll('[data-testid^="overlay-section-"]'));
  const sections = nodes.map(node => String(node.getAttribute('data-testid')).slice('overlay-section-'.length));
  if (sections.length !== expected.sections.length || sections.some((id, index) => id !== expected.sections[index])) return false;
  const rootBox = root.getBoundingClientRect(), noise = 0.01;
  const within = (box, outer) => box.left >= outer.left - noise && box.top >= outer.top - noise && box.right <= outer.right + noise && box.bottom <= outer.bottom + noise;
  const outside = [], clipped = [], truncated = [], surfaces = [], seen = [];
  let bottom = 0;
  nodes.forEach((node, index) => {
    const box = node.getBoundingClientRect();
    const surface = node.closest('.overlay-card-body, .overlay-panel, .overlay-hud-lines');
    const surfaceBox = surface ? surface.getBoundingClientRect() : rootBox;
    if (surface && !seen.includes(surface)) {
      seen.push(surface);
      surfaces.push({className: String(surface.className), top: surfaceBox.top - rootBox.top, bottom: surfaceBox.bottom - rootBox.top,
        inside: within(surfaceBox, rootBox)});
    }
    bottom = Math.max(bottom, box.bottom - Math.min(surfaceBox.top, rootBox.top));
    let inside = box.width > 0 && box.height > 0 && within(box, rootBox);
    for (let ancestor = node.parentElement; inside && ancestor && ancestor !== root; ancestor = ancestor.parentElement)
      if (globalThis.getComputedStyle(ancestor).overflow !== 'visible' && !within(box, ancestor.getBoundingClientRect())) inside = false;
    if (!inside) outside.push(sections[index]);
    const value = node.querySelector('.overlay-value');
    if (!value) return;
    const valueBox = value.getBoundingClientRect();
    if (valueBox.top < box.top - noise || valueBox.bottom > box.bottom + noise) clipped.push(sections[index]);
    if (value.scrollWidth > value.clientWidth) truncated.push(sections[index]);
  });
  return {layout: expected.layout, viewport: {innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight}, sections, outside, clipped, bottom,
    surfaces, truncated};
}

/**
 * Every shown section lies inside the overlay window and its clipping ancestors, no value is clipped by its row, the one
 * surface holding the rows lies inside the window, the lowest section ends within the CSS height the row model reserves
 * for the shown sections below that surface's top (0.01 px of float noise allowed), and the CSS viewport has the
 * window's DIP size divided by the zoom. At zoom 1 it may be one DIP larger (getBounds can round a window up by one
 * DIP). At another zoom (ET-045e) `window` is the actual content size read back after the resize, and the viewport may
 * differ from it by `zoomedViewportTolerance(zoom)` CSS px either way: one DIP of rounding and half a CSS px of
 * viewport rounding.
 */
export function verifyLayoutContainment(observation, window, reservedCss, zoom = 1) {
  assert.deepEqual(observation.outside, [], 'Enabled overlay sections lie outside the overlay window');
  assert.deepEqual(observation.clipped, [], 'Overlay section values are clipped by their rows');
  assert.ok(Array.isArray(observation.surfaces) && observation.surfaces.length === 1, 'Exactly one overlay surface must hold the rows');
  assert.ok(observation.surfaces[0].inside === true, 'The overlay surface lies outside the overlay window');
  assert.ok(Number.isFinite(observation.bottom) && Number.isFinite(reservedCss) && observation.bottom <= reservedCss + 0.01,
    'Overlay sections extend below the height the row model reserves');
  const {innerWidth, innerHeight} = observation.viewport;
  const reserved = (actual, dip) => Number.isFinite(actual) && Number.isFinite(zoom) && zoom > 0 &&
    (zoom === 1 ? actual >= dip && actual <= dip + 1 : Math.abs(actual - dip / zoom) <= zoomedViewportTolerance(zoom));
  assert.ok(reserved(innerWidth, window.width) && reserved(innerHeight, window.height), 'The overlay window must have the reserved size');
  return observation;
}

export async function waitForLayoutContainment(page, expected) {
  const handle = await page.waitForFunction(layoutContainmentObservation, expected, {timeout: 10000, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// Inspect the CSS actually loaded by each isolated renderer, including dynamic Vite chunks.
// A hidden DOM check protects style isolation; it does not establish real game visibility.
export async function verifyRendererStyles(dashboard, overlay) {
  await overlay.getByTestId('overlay-root').waitFor({state: 'attached', timeout: 10000});
  const read = async () => {
    const document = globalThis.document;
    const loadedFonts = await Promise.all([400, 500, 700].map(async weight => {
      const faces = await document.fonts.load(`${weight} 16px "M PLUS Rounded 1c"`, 'Скорость Ёж 0123456789');
      return {weight, loaded: faces.length >= 2 && faces.every(face => face.status === 'loaded')};
    }));
    const style = node => globalThis.getComputedStyle(node);
    const card = document.querySelector('[data-slot="card"]:not(.yu-instrument)');
    // ET-012a: the overlay root is transparent; each layout's first visible surface paints the background.
    const widget = document.querySelector('.overlay-surface');
    return {htmlBackground: style(document.documentElement).backgroundColor,
      bodyBackground: style(document.body).backgroundColor,
      themeBackground: style(document.documentElement).getPropertyValue('--background').trim(),
      fontFaces: Array.from(document.fonts).map(font => font.family), loadedFonts,
      stylesheets: Array.from(document.styleSheets).map(sheet => sheet.href),
      cardBackground: card ? style(card).backgroundColor : null,
      widgetBackground: widget ? style(widget).backgroundColor : null,
      widgetBackdropFilter: widget ? style(widget).backdropFilter : null};
  };
  const mainStyles = await dashboard.evaluate(read);
  const overlayStyles = await overlay.evaluate(read);
  assert.ok(mainStyles.themeBackground && mainStyles.cardBackground && mainStyles.cardBackground !== 'rgba(0, 0, 0, 0)', 'Dashboard shadcn theme and Card must be styled');
  assert.ok(mainStyles.fontFaces.some(family => family.includes('M PLUS Rounded 1c')), 'Dashboard must retain the configured offline M PLUS Rounded 1c font');
  for (const styles of [mainStyles, overlayStyles]) assert.deepEqual(styles.loadedFonts, [400, 500, 700].map(weight => ({weight, loaded: true})), 'Latin and Cyrillic faces load locally at every configured weight');
  assert.equal(overlayStyles.htmlBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(overlayStyles.bodyBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(overlayStyles.themeBackground, '', 'Overlay must not load the main theme');
  assert.ok(overlayStyles.fontFaces.length > 0 && overlayStyles.fontFaces.every(family => family.includes('M PLUS Rounded 1c')), 'Overlay must bundle its own offline M PLUS Rounded 1c faces');
  assert.equal(overlayStyles.widgetBackground, 'rgba(11, 17, 32, 0.8)');
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
  const expected = {source: 'ETS2', origin: 'synthetic', statuses: ['connected'], freshness: 'current', speed: '90', fuel: '73.0', speedUnit: 'km/h', fuelUnit: 'L'};
  const observe = async (phase, change = {}) => {
    const observation = {phase, ...await waitForOverlay(overlay, {...expected, ...change}), observedObserverMonotonicMs: performance.now()};
    result.observations.push(observation);
    result.windows.push({phase, windows: await windowSecurity(application)});
    return observation;
  };
  const dashboardReading = async (speed, fuel) => {
    const handle = await dashboard.waitForFunction(dashboardObservation, {speed: `Speed: ${speed} km/h`, fuel: `Fuel: ${fuel} L`}, {timeout: 10000, polling: 50});
    try {const observation = await handle.jsonValue(); assert.ok(observation); return {...observation, observedObserverMonotonicMs: performance.now()};} finally {await handle.dispose();}
  };
  result.bridge = await overlay.evaluate(() => ({require: typeof globalThis.require, process: typeof globalThis.process,
    desktop: typeof globalThis.desktop, keys: Object.getOwnPropertyNames(globalThis.overlay), frozen: Object.isFrozen(globalThis.overlay)}));
  assert.deepEqual(result.bridge, {require: 'undefined', process: 'undefined', desktop: 'undefined', keys: ['subscribeOverlay'], frozen: true});
  await observe('initial'); result.sourceBefore = source.statistics();
  // ET-012c (REG-016): every enabled strip section with data lies inside the overlay window. The observation is stored
  // before it is verified, so a failed receipt keeps it. Recorded for review; RuntimeReceipt.ps1 does not validate it.
  verifyStripLayout(result.stripLayout = await waitForStripLayout(overlay, {sections: STRIP_SMOKE_SECTIONS}));
  source.setReading(20, 71); await observe('changed', {speed: '72', fuel: '71.0'}); await dashboardReading('72', '71.0');
  result.changedReading = {speedKmh: 72, fuelL: 71};
  source.setUnavailable(); await observe('missing', {speed: '—', fuel: '—'});
  result.missingDistinctFromZero = true;
  source.setReading(0, 0); await observe('zero', {speed: '0', fuel: '0.0'});
  source.setReading(25, 73); await observe('restored');
  source.hold(); await observe('silent-open-stale', {statuses: ['stale'], freshness: 'stale', speed: '—', fuel: '—'});
  result.silentOpenSource = source.statistics();
  assert.equal(result.silentOpenSource.activeClients, 1); assert.equal(result.silentOpenSource.connections, 1); assert.equal(result.silentOpenSource.held, true);
  result.silentOpenStale = true;
  source.resume(); await observe('resumed'); result.resumeRecovered = true;
  await overlay.reload({timeout: 10000}); await observe('overlay-reload'); await dashboardReading('90', '73.0');
  result.stylesAfterOverlayReload = await verifyRendererStyles(dashboard, overlay);
  assert.equal(source.statistics().connections, 1); result.overlayReloadIndependent = true;
  result.overlayStallProof = {};
  await proveIndependentDuringStall(overlay, 'overlay', async () => ({reading: await dashboardReading('72', '71.0'),
    windows: await windowSecurity(application)}), source, result.overlayStallProof);
  await observe('overlay-credit-recovery', {speed: '72', fuel: '71.0'}); await dashboardReading('72', '71.0');
  assert.equal(source.statistics().connections, 1); result.overlayCreditRecovered = true; result.overlayStallMilliseconds = 6000;
  await dashboard.reload({timeout: 10000}); await dashboardReading('72', '71.0'); await observe('dashboard-reload', {speed: '72', fuel: '71.0'});
  assert.equal(source.statistics().connections, 1); result.dashboardReloadIndependent = true;
  source.setReading(25, 73); await observe('before-dashboard-stall');
  result.dashboardStallProof = {};
  await proveIndependentDuringStall(dashboard, 'dashboard', async () => ({reading: await observe('during-dashboard-stall', {speed: '72', fuel: '71.0'}),
    windows: await windowSecurity(application)}), source, result.dashboardStallProof);
  await dashboardReading('72', '71.0'); await observe('dashboard-credit-recovery', {speed: '72', fuel: '71.0'});
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
// Chromium keeps a zoom level (a power of 1.2) and converts it back, so each factor is compared at six decimals.
async function zoomFactors(application) {
  const windows = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(window =>
    ({url: window.webContents.mainFrame.url, zoom: Math.round(window.webContents.getZoomFactor() * 1e6) / 1e6})));
  const of = search => windows.filter(window => new URL(window.url).search === search).map(window => window.zoom);
  return {overlay: of('?view=overlay'), dashboard: of('')};
}

// The Driving only preset of apps/desktop/src/overlay-sections.ts.
const DRIVING_ONLY_SECTIONS = ['speed', 'gear', 'rpm', 'fuel', 'range'];
// ET-012b edit mode (REG-016, REG-017). The synthetic source has no game window, so edit mode waits for the game: the
// overlay never shows, never becomes focusable and stays topmost while its document is marked as editing. A scale
// reaches only the overlay's zoom factor, overlayZoom(scale) = scale × 0.7 since ET-045e (0.7 at 100%, 2.1 at 300%, 0.35
// at 50%, 1.05 at 150%); the dashboard keeps 1 in its own session. Recorded for review only; RuntimeReceipt.ps1 does
// not validate this field.
async function runEditStep(application, dashboard, overlay) {
  const step = {};
  step.zoomBefore = await zoomFactors(application);
  assert.deepEqual(step.zoomBefore, {overlay: [0.7], dashboard: [1]});
  step.begun = await dashboard.evaluate(() => globalThis.desktop.beginOverlayEdit());
  assert.deepEqual(step.begun, {active: true, layout: 'card', scale: 1, placement: 'waiting-for-game'});
  step.renderedWhileEditing = await waitForEditing(overlay, 'true');
  assert.deepEqual(step.renderedWhileEditing, {editing: 'true', cursor: 'move', outlineStyle: 'dashed', pointerEvents: 'auto'});
  // windowSecurity requires the overlay hidden, not focusable and topmost.
  step.windowsWhileEditing = await windowSecurity(application);
  await assert.rejects(dashboard.evaluate(() => globalThis.desktop.setOverlayLayout('hud')), /cannot change while its position is edited/);
  step.layoutLocked = true;
  // ET-045c: a sections preset saved while editing keeps edit mode, its draft and the window security. The synthetic
  // source has no game window, so this cannot show containment inside a game client; unit tests cover that.
  const original = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.sections;
  const drivingOnly = Object.fromEntries(Object.keys(original).map(id => [id, DRIVING_ONLY_SECTIONS.includes(id)]));
  step.sectionsPreset = await dashboard.evaluate(sections => globalThis.desktop.setOverlaySections(sections), drivingOnly);
  assert.deepEqual(step.sectionsPreset.overlay.sections, drivingOnly);
  step.afterSectionsPreset = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).overlayEdit;
  assert.deepEqual(step.afterSectionsPreset, {active: true, layout: 'card', scale: 1, placement: 'waiting-for-game'});
  step.windowsAfterSectionsPreset = await windowSecurity(application);
  step.sectionsRestored = await dashboard.evaluate(sections => globalThis.desktop.setOverlaySections(sections), original);
  assert.deepEqual(step.sectionsRestored.overlay.sections, original);
  step.largest = await dashboard.evaluate(() => globalThis.desktop.setOverlayEditScale(3));
  assert.deepEqual(step.largest, {active: true, layout: 'card', scale: 3, placement: 'waiting-for-game'});
  step.zoomAtLargest = await zoomFactors(application);
  assert.deepEqual(step.zoomAtLargest, {overlay: [2.1], dashboard: [1]});
  step.smallest = await dashboard.evaluate(() => globalThis.desktop.setOverlayEditScale(0.5));
  assert.deepEqual(step.smallest, {active: true, layout: 'card', scale: 0.5, placement: 'waiting-for-game'});
  step.zoomAtSmallest = await zoomFactors(application);
  assert.deepEqual(step.zoomAtSmallest, {overlay: [0.35], dashboard: [1]});
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
  assert.deepEqual(step.zoomAfterSave, {overlay: [1.05], dashboard: [1]});
  return step;
}

export const HIDDEN_OVERLAY_DOM_FILE = 'hidden-overlay-dom.html';
export const HIDDEN_OVERLAY_SCREENSHOT_FILE = 'hidden-overlay-dom.png';
export const HIDDEN_OVERLAY_SCREENSHOT_TIMEOUT_MS = 5000;
export const HIDDEN_OVERLAY_DOM_TIMEOUT_MS = 10000;

/**
 * Review evidence of the hidden overlay document after every overlay assertion has passed; it asserts nothing about
 * rendering. The serialized DOM is read through the renderer's JavaScript and needs no rendered frame, so it is always
 * written, and a failure to read it fails the run. `page.content()` has no Playwright timeout, so a hung renderer fails
 * after `domTimeout`, well inside the Job's 60 s limit, and result.json keeps the error. The PNG is best effort:
 * Page.captureScreenshot waits for a frame the never-shown overlay window's compositor may stop presenting, and then
 * no capture completed within the observed bounds (8 s, 5 s). Only that bounded Playwright timeout is recorded instead
 * of failing the run; any other screenshot error still fails.
 */
export async function captureHiddenOverlay(overlay, output, {screenshotTimeout = HIDDEN_OVERLAY_SCREENSHOT_TIMEOUT_MS, domTimeout = HIDDEN_OVERLAY_DOM_TIMEOUT_MS} = {}) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HIDDEN_OVERLAY_DOM_NOT_READ_WITHIN_${domTimeout}_MS`)), domTimeout);
  });
  let html;
  try {html = await Promise.race([overlay.content(), expired]);} finally {clearTimeout(timer);}
  // Written before it is checked, so a failed run keeps it.
  await writeFile(path.join(output, HIDDEN_OVERLAY_DOM_FILE), html);
  assert.equal(html.split('data-testid="overlay-root"').length, 2, 'The serialized overlay DOM must hold exactly one overlay root');
  const record = {dom: {file: HIDDEN_OVERLAY_DOM_FILE, bytes: Buffer.byteLength(html)}};
  const start = performance.now();
  try {
    await overlay.screenshot({path: path.join(output, HIDDEN_OVERLAY_SCREENSHOT_FILE), timeout: screenshotTimeout});
    record.screenshot = {captured: true, file: HIDDEN_OVERLAY_SCREENSHOT_FILE, milliseconds: Math.round(performance.now() - start)};
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    record.screenshot = {captured: false, file: null, milliseconds: Math.round(performance.now() - start), timeoutMilliseconds: screenshotTimeout,
      error: {name: error.name, message: String(error.message).split('\n')[0]}};
  }
  return record;
}
