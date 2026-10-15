// Self-contained browser callback: Playwright serializes this function without module closures.
export function currentTelemetryObservation() {
  const observation = {};
  for (const [field, testId] of [['status', 'telemetry-status'], ['speed', 'speed'], ['fuel', 'fuel']]) {
    const elements = globalThis.document.querySelectorAll(`[data-testid="${testId}"]`);
    if (elements.length !== 1) return false;
    const element = elements[0], bounds = element.getBoundingClientRect();
    if (globalThis.getComputedStyle(element).visibility !== 'visible' || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= globalThis.innerHeight || bounds.left >= globalThis.innerWidth) return false;
    observation[field] = element.innerText;
  }
  return /^connected:/.test(observation.status) && observation.speed === 'Speed: 90.0 km/h' && observation.fuel === 'Fuel: 73.0 L' ? observation : false;
}

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
export function notCurrentLiveObservation({values, status, hidden}) {
  const read = (id, viewport) => {
    const elements = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    if (elements.length !== 1) return undefined;
    const element = elements[0], bounds = element.getBoundingClientRect();
    if (globalThis.getComputedStyle(element).visibility !== 'visible' || bounds.width <= 0 || bounds.height <= 0) return undefined;
    if (viewport && (bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= globalThis.innerHeight || bounds.left >= globalThis.innerWidth)) return undefined;
    return element.innerText;
  };
  const observation = {status: read('telemetry-status', true), speed: read('speed', true), fuel: read('fuel', true)};
  if (!new RegExp(status).test(observation.status ?? '') || observation.speed !== 'Speed: unavailable' || observation.fuel !== 'Fuel: unavailable') return false;
  for (const id of values) {
    if (read(id, false) !== 'unavailable' || read(`${id}-reason`, false) !== 'not current') return false;
    observation[id] = 'unavailable';
  }
  for (const id of hidden) if (globalThis.document.querySelectorAll(`[data-testid="${id}"]`).length) return false;
  return observation;
}

export async function waitForCompleteLive(page, rows = SYNTHETIC_V0_LIVE_ROWS, hidden = SYNTHETIC_V0_HIDDEN_ROWS) {
  const handle = await page.waitForFunction(completeLiveObservation, {rows, hidden}, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
export async function waitForNotCurrentLive(page, values, status, hidden = []) {
  const handle = await page.waitForFunction(notCurrentLiveObservation, {values, status, hidden}, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
