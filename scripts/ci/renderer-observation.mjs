import {dashboardObservation} from './dashboard-observation.mjs';
// Self-contained browser callback: Playwright serializes this function without module closures.
export const currentTelemetryObservation = dashboardObservation;

export async function waitForCurrentTelemetry(page) {
  const handle = await page.waitForFunction(currentTelemetryObservation, undefined, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// ET-010b live telemetry card. Expected texts are written by hand from tests/fixtures/protocol-v0/checkpoint.json with
// the live smoke source's speed 25 m/s and fuel 73 L, in the ETS2 metric profile; live-dashboard-text.test.ts ties
// them to the card builder. Each entry is [data-testid, exact innerText]; a row lists its value, then its reason and note.
export const SYNTHETIC_V0_LIVE_ROWS = Object.freeze([
  ['live-gear', 'R1'],
  ['live-engine-rpm', '600 rpm'],
  ['live-fuel-capacity', '1000 L'],
  ['live-fuel-level', '7%'],
  ['live-sdk-average-consumption', '25.0 L/100 km'],
  ['live-sdk-average-consumption-note', 'SDK mean, not a trip average'],
  ['live-estimated-range', 'unavailable'],
  ['live-estimated-range-reason', 'not yet observed'],
  ['live-estimated-range-note', "the game's estimate"],
  ['live-odometer', '1234.6 km'],
  ['live-game-time', 'Day 8574, 09:18'],
  ['live-game-time-note', 'game time'],
  ['live-cargo', 'cargo.logs'],
  ['live-destination-city', 'city.warszawa'],
  ['live-planned-distance', '200 km'],
  ['live-planned-distance-note', 'from the job offer, excludes ferries'],
  ['live-expected-income', '9007199254740993.123456 (currency unknown)'],
  ['live-truck', 'truck.volvo']
].map(row => Object.freeze(row)));
/** Value elements of the rows above, without their reason and note elements. */
export const SYNTHETIC_V0_VALUE_IDS = Object.freeze(SYNTHETIC_V0_LIVE_ROWS.map(([id]) => id).filter(id => !/-(reason|note)$/.test(id)));
/** Elements that must not exist for that observation: speed and fuel stay legacy rows, v0 does not carry the rest. */
export const SYNTHETIC_V0_HIDDEN_ROWS = Object.freeze([
  'live-speed', 'live-fuel', 'live-route-remaining', 'live-deadline', 'live-source-city', 'live-source-company', 'live-destination-company',
  'live-cargo-mass', 'live-market', 'live-special-job', 'live-cargo-loaded', 'live-truck-plate', 'live-trailers', 'live-position', 'live-bearing',
  'live-game-mode', 'live-event-loss', 'live-paused', 'live-job-missing'
]);

// Self-contained browser callback. Every expected element exists exactly once, is visible with a non-empty box and has
// the exact text; card rows may lie below the fold, so they need no viewport intersection (decision B6). A value row
// has no reason or note element unless one is expected, and no hidden element exists.
export function completeLiveObservation({rows, hidden}) {
  const observation = {};
  const shown = element => {
    const bounds = element.getBoundingClientRect();
    return globalThis.getComputedStyle(element).visibility === 'visible' && bounds.width > 0 && bounds.height > 0;
  };
  const expected = new Set(rows.map(([id]) => id));
  for (const [id, text] of rows) {
    const elements = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    if (elements.length !== 1 || !shown(elements[0]) || elements[0].innerText !== text) return false;
    observation[id] = text;
    if (/-(reason|note)$/.test(id)) continue;
    for (const extra of [`${id}-reason`, `${id}-note`]) if (!expected.has(extra) && globalThis.document.querySelectorAll(`[data-testid="${extra}"]`).length) return false;
  }
  for (const id of hidden) if (globalThis.document.querySelectorAll(`[data-testid="${id}"]`).length) return false;
  return observation;
}

// Self-contained browser callback for a non-current dashboard: the status matches `status` (a RegExp source), the legacy
// speed and fuel lines read unavailable in the viewport, and every listed value row reads `unavailable` with the reason
// `not current`. No hidden element exists.
export const notCurrentLiveObservation = dashboardObservation;

export async function waitForCompleteLive(page, rows = SYNTHETIC_V0_LIVE_ROWS, hidden = SYNTHETIC_V0_HIDDEN_ROWS) {
  const handle = await page.waitForFunction(completeLiveObservation, {rows, hidden}, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
export async function waitForNotCurrentLive(page, values, status, hidden = []) {
  const handle = await page.waitForFunction(notCurrentLiveObservation, {values, status, hidden}, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// ET-010c protocol v1 rows. Expected texts are written by hand from tests/fixtures/protocol-v1/snapshot-live.json with
// the job's cargo and destination city ids set to the v0 checkpoint's (cargo.logs, city.warszawa), as the v1 smoke source
// serves it, in the ETS2 metric profile: 151000 m remaining, deadline minute 13000 at game minute 12345 (10 h 55 min),
// 18000 kg, plate SYN 0001, an unnamed dryvan trailer, heading 0.25 (bearing 270°) and two events lost without a durable
// consumer. live-dashboard-text.test.ts ties them to the card builder.
export const SYNTHETIC_V1_LIVE_ROWS = Object.freeze([
  ['live-route-remaining', '151.0 km'],
  ['live-deadline', 'in 10 h 55 min'],
  ['live-deadline-note', 'game time'],
  ['live-source-city', 'Synthetic City A'],
  ['live-source-company', 'Synthetic Company A'],
  ['live-destination-company', 'Synthetic Company B'],
  ['live-cargo-mass', '18.0 t'],
  ['live-market', 'freight_market'],
  ['live-special-job', 'no'],
  ['live-truck-plate', 'SYN 0001'],
  ['live-trailers', 'dryvan'],
  ['live-position', 'x -31234.5, y 42.3, z 18800.8'],
  ['live-position-note', 'game-world coordinates, not GPS'],
  ['live-bearing', '270°'],
  ['live-bearing-note', 'game-world coordinates, not GPS'],
  ['live-v1-status', 'connected: Validated current observation'],
  ['live-game-mode', 'single-player (weak evidence, module-scan)'],
  ['live-event-loss', '2'],
  ['live-event-loss-note', 'this version records no gameplay events']
].map(row => Object.freeze(row)));
/** The v1-only value elements above, without reason, note and status elements. */
export const SYNTHETIC_V1_VALUE_IDS = Object.freeze(SYNTHETIC_V1_LIVE_ROWS.map(([id]) => id).filter(id => !/-(reason|note)$/.test(id) && id !== 'live-v1-status'));
/**
 * The card for the v0 smoke checkpoint with that v1 projection (decision F4): rows v0 carries stay v0's, in section
 * order, except that cargo and destination city show v1's names for the same job; the v1 rows follow in their sections
 * and the Protocol v1 source section comes last.
 */
export const SYNTHETIC_V0V1_LIVE_ROWS = Object.freeze([
  ['live-gear', 'R1'],
  ['live-engine-rpm', '600 rpm'],
  ['live-fuel-capacity', '1000 L'],
  ['live-fuel-level', '7%'],
  ['live-sdk-average-consumption', '25.0 L/100 km'],
  ['live-sdk-average-consumption-note', 'SDK mean, not a trip average'],
  ['live-estimated-range', 'unavailable'],
  ['live-estimated-range-reason', 'not yet observed'],
  ['live-estimated-range-note', "the game's estimate"],
  ['live-odometer', '1234.6 km'],
  ['live-route-remaining', '151.0 km'],
  ['live-game-time', 'Day 8574, 09:18'],
  ['live-game-time-note', 'game time'],
  ['live-deadline', 'in 10 h 55 min'],
  ['live-deadline-note', 'game time'],
  ['live-cargo', 'Synthetic Cargo'],
  ['live-source-city', 'Synthetic City A'],
  ['live-source-company', 'Synthetic Company A'],
  ['live-destination-city', 'Synthetic City B'],
  ['live-destination-company', 'Synthetic Company B'],
  ['live-cargo-mass', '18.0 t'],
  ['live-market', 'freight_market'],
  ['live-special-job', 'no'],
  ['live-planned-distance', '200 km'],
  ['live-planned-distance-note', 'from the job offer, excludes ferries'],
  ['live-expected-income', '9007199254740993.123456 (currency unknown)'],
  ['live-truck', 'truck.volvo'],
  ['live-truck-plate', 'SYN 0001'],
  ['live-trailers', 'dryvan'],
  ['live-position', 'x -31234.5, y 42.3, z 18800.8'],
  ['live-position-note', 'game-world coordinates, not GPS'],
  ['live-bearing', '270°'],
  ['live-bearing-note', 'game-world coordinates, not GPS'],
  ['live-v1-status', 'connected: Validated current observation'],
  ['live-game-mode', 'single-player (weak evidence, module-scan)'],
  ['live-event-loss', '2'],
  ['live-event-loss-note', 'this version records no gameplay events']
].map(row => Object.freeze(row)));
/** Elements that must not exist for that pair: the legacy rows, cargo loaded outside the cargo market, no pause, a job. */
export const SYNTHETIC_V0V1_HIDDEN_ROWS = Object.freeze(['live-speed', 'live-fuel', 'live-cargo-loaded', 'live-paused', 'live-job-missing']);

// Self-contained browser callback for a dashboard whose v1 data is not current while v0 still is: the v1 status line
// matches `status` (a RegExp source), the legacy speed line reads exactly `speed` in the viewport, and every listed v1
// value row reads `unavailable` with the reason `not current`.
export const v1NotCurrentObservation = dashboardObservation;
export async function waitForV1NotCurrentLive(page, values, status, speed) {
  const handle = await page.waitForFunction(v1NotCurrentObservation, {values, status, speed, statusId: 'live-v1-status', omitFuel: true}, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// ET-010c overlay sections that need protocol v1, read from the hidden overlay document (the strip by default). Expected
// texts are written by hand from the same pair; a dash is an unavailable section, never zero (REG-009).
export const SYNTHETIC_V1_OVERLAY_CURRENT = Object.freeze({
  'overlay-origin': 'Synthetic City A, Synthetic Company A', 'overlay-distance-remaining': '151.0 km', 'overlay-deadline': 'in 10 h 55 min',
  'overlay-cargo': 'Synthetic Cargo', 'overlay-cargo-detail': '18.0 t', 'overlay-destination': 'Synthetic City B, Synthetic Company B',
  'overlay-speed': '90', 'freshness': 'current'
});
/** The strip sections the pair shows, in canonical order: range stays hidden (its estimate is not observed). */
export const SYNTHETIC_V1_STRIP_SECTIONS = Object.freeze(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'origin', 'destination',
  'distance-remaining', 'deadline', 'expected-income', 'game-time']);
/** v0 not current: every shown section is a dash and no detail remains. */
export const SYNTHETIC_V1_OVERLAY_V0_STALE = Object.freeze({
  'overlay-origin': '—', 'overlay-distance-remaining': '—', 'overlay-deadline': '—', 'overlay-cargo': '—', 'overlay-cargo-detail': null,
  'overlay-destination': '—', 'overlay-speed': '—', 'freshness': 'stale'
});
/** v1 not current while v0 is: the v1 sections are dashes, the mixed sections keep their v0 part (game ids, no mass). */
export const SYNTHETIC_V1_OVERLAY_V1_STALE = Object.freeze({
  'overlay-origin': '—', 'overlay-distance-remaining': '—', 'overlay-deadline': '—', 'overlay-cargo': 'cargo.logs', 'overlay-cargo-detail': null,
  'overlay-destination': 'city.warszawa', 'overlay-speed': '90', 'freshness': 'current'
});
/** Both sources stopped: dashes only; the freshness depends on which status arrives first, so it is not compared. */
export const SYNTHETIC_V1_OVERLAY_STOPPED = Object.freeze({
  'overlay-origin': '—', 'overlay-distance-remaining': '—', 'overlay-deadline': '—', 'overlay-cargo': '—', 'overlay-cargo-detail': null,
  'overlay-destination': '—', 'overlay-speed': '—'
});

// Self-contained browser callback for the overlay document. Each listed element exists once with exactly the expected
// text, or not at all for `null`; `freshness`, when given, is overlay-root's data-freshness. No geometry is required:
// the overlay window is hidden without a game.
export function overlayV1Observation(expected) {
  const observation = {};
  for (const [key, text] of Object.entries(expected)) {
    if (key === 'freshness') {
      const roots = globalThis.document.querySelectorAll('[data-testid="overlay-root"]');
      if (roots.length !== 1 || roots[0].getAttribute('data-freshness') !== text) return false;
      observation.freshness = text;
      continue;
    }
    const elements = globalThis.document.querySelectorAll(`[data-testid="${key}"]`);
    if (text === null ? elements.length !== 0 : elements.length !== 1 || elements[0].textContent !== text) return false;
    observation[key] = text;
  }
  return observation;
}
export async function waitForOverlayV1(page, expected) {
  const handle = await page.waitForFunction(overlayV1Observation, expected, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// Self-contained browser callback, for review only (coordinator decision C3): the sections whose box is not fully inside
// the overlay root, such as strip items wrapped onto its clipped second line, and the sections whose value text is cut
// off inside its own box (an ellipsis in the card or cluster rows).
export function overlayOverflow() {
  const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
  if (!root) return {layout: null, root: null, sections: [], outside: [], truncated: []};
  const bounds = root.getBoundingClientRect(), sections = [], outside = [], truncated = [];
  for (const element of globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]')) {
    const id = element.getAttribute('data-testid').slice('overlay-section-'.length), box = element.getBoundingClientRect();
    sections.push(id);
    if (box.left < bounds.left || box.top < bounds.top || box.right > bounds.right || box.bottom > bounds.bottom) outside.push(id);
    if ([...element.querySelectorAll('.overlay-value')].some(value => value.scrollWidth > value.clientWidth)) truncated.push(id);
  }
  let alignment;
  const content = root.querySelector?.('[data-testid="overlay-content"]');
  if (content) {
    const painted = content.getBoundingClientRect(), fraction = Number(content.getAttribute('data-anchor-y'));
    const expectedTop = bounds.top + (bounds.height - painted.height) * fraction;
    const aligned = Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && Math.abs(painted.top - expectedTop) <= 1;
    alignment = {fraction, capacityHeight: bounds.height, paintedHeight: painted.height, top: painted.top - bounds.top, expectedTop: expectedTop - bounds.top, aligned};
    if (!aligned) outside.push('content-anchor');
  }
  return {...(alignment ? {alignment} : {}), layout: root.getAttribute('data-layout'), root: {width: Math.round(bounds.width), height: Math.round(bounds.height)}, sections, outside, truncated};
}

/** ET-015c PR-4: the recording texts of a service that records nothing (production, GAME_HISTORY_RECORDING false). */
export const RECORDING_DISABLED_TEXT = Object.freeze({headline: 'Off: this version does not record game history', detail: null, losses: null, alert: null,
  notice: 'Prototype live display. No trip recording or durable history.'});

// ET-015c PR-4: the dashboard's recording status (dashboard-renderer.tsx). Self-contained browser callback: the
// headline and the alert as text, the detail and losses as their lines, and the prototype notice. An absent element
// reads null; a duplicated one makes the observation invalid (undefined).
export function recordingTextObservation() {
  const one = id => {
    const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    return nodes.length === 1 ? nodes[0] : nodes.length ? undefined : null;
  };
  const text = id => {const node = one(id); return node ? node.textContent : node;};
  const lines = id => {const node = one(id); return node ? [...node.children].map(child => child.textContent) : node;};
  return {headline: text('health-recording'), detail: lines('health-recording-detail'), losses: lines('health-recording-losses'),
    alert: text('health-recording-alert'), notice: text('prototype-notice')};
}
// Self-contained browser callback: the observation when every key of `expected` matches it exactly, otherwise false.
export function recordingTextMatches(expected) {
  const one = id => {
    const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    return nodes.length === 1 ? nodes[0] : nodes.length ? undefined : null;
  };
  const text = id => {const node = one(id); return node ? node.textContent : node;};
  const lines = id => {const node = one(id); return node ? [...node.children].map(child => child.textContent) : node;};
  const observation = {headline: text('health-recording'), detail: lines('health-recording-detail'), losses: lines('health-recording-losses'),
    alert: text('health-recording-alert'), notice: text('prototype-notice')};
  return Object.keys(expected).every(key => JSON.stringify(observation[key]) === JSON.stringify(expected[key])) ? observation : false;
}
/**
 * Waits until the dashboard shows the expected recording texts (only the keys given); a hang guard only. On expiry it
 * fails with `message` and the last observation.
 */
export async function waitForRecordingText(page, expected, message, timeoutMs = 10000) {
  let handle;
  try {handle = await page.waitForFunction(recordingTextMatches, expected, {timeout: timeoutMs});}
  catch (error) {
    const last = await page.evaluate(recordingTextObservation).catch(() => null);
    throw new Error(`${message} within ${timeoutMs} ms; last ${JSON.stringify(last)}`, {cause: error});
  }
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
/**
 * Starts recording every distinct recording text the dashboard shows, from now until its document is replaced, through a
 * MutationObserver, so a state shorter than any poll is still seen. At most 200 entries.
 */
export async function startRecordingTextLog(page) {
  // Self-contained: the page's CSP forbids building a function from text, so the reader is repeated here.
  await page.evaluate(() => {
    const one = id => {
      const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
      return nodes.length === 1 ? nodes[0] : nodes.length ? undefined : null;
    };
    const text = id => {const node = one(id); return node ? node.textContent : node;};
    const lines = id => {const node = one(id); return node ? [...node.children].map(child => child.textContent) : node;};
    const read = () => ({headline: text('health-recording'), detail: lines('health-recording-detail'), losses: lines('health-recording-losses'),
      alert: text('health-recording-alert'), notice: text('prototype-notice')});
    const entries = globalThis.__ets2telemetryRecordingText = [];
    const note = () => {const value = JSON.stringify(read()); if (entries.at(-1) !== value && entries.length < 200) entries.push(value);};
    note();
    new globalThis.MutationObserver(note).observe(globalThis.document.body, {subtree: true, childList: true, characterData: true});
  });
}
/** The distinct recording texts seen since startRecordingTextLog, in order. */
export async function recordingTextLog(page) {
  return (await page.evaluate(() => globalThis.__ets2telemetryRecordingText ?? [])).map(entry => JSON.parse(entry));
}

export function zeroLiveObservation(language) {
  const read = selector => globalThis.document.querySelector(selector);
  return !read('[data-testid="speed"]') && read('[data-testid="live-speed-number"]')?.textContent === '0' &&
    read('[data-testid="fuel"]')?.innerText === (language === 'en' ? 'Fuel: 0.0 L' : 'Топливо: 0.0 л') &&
    read('.yu-gauge-number')?.textContent === '0' && !read('.yu-gauge-speed') && read('[data-testid="live.instrument.tank"]')?.getAttribute('data-state') === 'value' && !read('.yu-tank-unavailable') && read('.yu-tank i')?.style.height === '0%';
}
