import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {builtinModules, createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

// ET-016 PR-4: the journal runtime journey (J12-J14). Run 1 opens the new, empty history database of the isolated
// LOCALAPPDATA and shows the Journal tab's empty state. Between the runs, journal-seed.mjs writes the hand-written anchors,
// fillers and a paging trip into `<isolated LOCALAPPDATA>\ETS2Telemetry\synthetic\journal.sqlite` through the real storage
// code. Run 2 starts with ETS2TELEMETRY_RECORDING=synthetic:journal, so its telemetry service opens that database
// instead of history; the journey walks the list pages and filters, opens every anchor's detail and pages the timeline,
// completeness intervals and samples, all through the dashboard's UI. Every expected text below is written by hand
// from tests/shared/journal-seed.ts and J13/J14; none is read back from journal-view.ts.

export const JOURNAL_TARGET = 'synthetic:journal';
const BASE_UTC = 1_791_676_800_000;
const FAILURE_EVENTS = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
const ROUTE = 'Synthetic City A → Synthetic City B';
const NOT_OBSERVED = 'unavailable (not observed)';
const T = {delivered: '7a000000-0000-4000-8000-000000000001', cancelled: '7a000000-0000-4000-8000-000000000002', differentJob: '7a000000-0000-4000-8000-000000000003',
  gapClosed: '7a000000-0000-4000-8000-000000000004', restartClosed: '7a000000-0000-4000-8000-000000000005', open: '7a000000-0000-4000-8000-000000000006',
  zeroValues: '7a000000-0000-4000-8000-000000000007', manySamples: '7a000000-0000-4000-8000-000000000008', paging: '7b000000-0000-4000-8000-000000000001'};
const filler = index => `7f000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
/** A UTC label as the renderer's local clock time, written independently of journal-view.ts with Date's local getters. */
const local = utcMs => {
  const d = new Date(utcMs), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
/** The anchors on page 3 of the unfiltered list, newest first, with their hand-written row texts (ETS2 metric, ATS US customary). */
const ANCHOR_ROWS = [
  {trip: T.manySamples, started: local(BASE_UTC + 205_000), game: 'ATS', route: ROUTE, outcome: 'In progress', completeness: 'Unknown', observed: NOT_OBSERVED, fuel: NOT_OBSERVED, cargo: 'Synthetic Cargo'},
  {trip: T.zeroValues, started: local(BASE_UTC + 203_000), game: 'ATS', route: '(empty) → unavailable (not provided by the game)', outcome: 'Delivered', completeness: 'Complete',
    observed: '0.0 mi', fuel: NOT_OBSERVED, cargo: NOT_OBSERVED},
  {trip: T.open, started: local(BASE_UTC + 101_000), game: 'ETS2', route: ROUTE, outcome: 'In progress', completeness: 'Unknown', observed: NOT_OBSERVED, fuel: NOT_OBSERVED, cargo: 'Synthetic Cargo'},
  {trip: T.restartClosed, started: local(BASE_UTC + 27_000), game: 'ETS2', route: ROUTE, outcome: 'No outcome — the game or plugin restarted', completeness: 'Partial', observed: NOT_OBSERVED,
    fuel: NOT_OBSERVED, cargo: 'Synthetic Cargo'},
  {trip: T.gapClosed, started: local(BASE_UTC + 22_000), game: 'ETS2', route: ROUTE, outcome: 'No outcome — events were lost', completeness: 'Partial', observed: NOT_OBSERVED, fuel: NOT_OBSERVED,
    cargo: 'Synthetic Cargo'},
  {trip: T.differentJob, started: local(BASE_UTC + 20_000), game: 'ETS2', route: ROUTE, outcome: 'No outcome — a different job started', completeness: 'Partial', observed: NOT_OBSERVED,
    fuel: NOT_OBSERVED, cargo: 'Synthetic Cargo'},
  {trip: T.cancelled, started: local(BASE_UTC + 12_000), game: 'ETS2', route: ROUTE, outcome: 'Cancelled', completeness: 'Complete', observed: NOT_OBSERVED, fuel: NOT_OBSERVED,
    cargo: 'Synthetic Cancel Cargo'},
  {trip: T.delivered, started: local(BASE_UTC + 4_000), game: 'ETS2', route: ROUTE, outcome: 'Delivered', completeness: 'Complete', observed: '152.0 km', fuel: NOT_OBSERVED, cargo: 'Synthetic Cargo'}
];
const NO_TRUCK = 'No truck was recorded for this trip. A trip whose recording started during the job has no truck until the game sends it again.';
const NO_TRAILER = 'No trailer was recorded for this trip.';
/** Each anchor's detail: title, outcome, completeness badge, chosen fields (`<section>-<field>`) and section notes. */
const ANCHOR_DETAILS = [
  {trip: T.delivered, title: `ETS2: ${ROUTE}`, outcome: 'Delivered', completeness: 'Complete', fields: {'distance-plannedDistance': '152.0 km', 'distance-observedDistance': '152.0 km',
    'distance-deliveredDistance': '151.3 km', 'fuel-fuelUsed': NOT_OBSERVED, 'money-expectedIncome': '12345 (currency unknown)', 'money-revenue': '15000 EUR (SDK-documented)',
    'money-fine': '401 EUR (SDK-documented), 2 amounts', 'money-toll': '35 EUR (SDK-documented), 1 amount', 'money-ferry': '677 EUR (SDK-documented), 1 amount',
    'money-train': 'none recorded', 'truck-licensePlate': 'SYN 0001', 'trailers-trailer-0-plate': 'SYN 0002', 'samples-sampleCount': '3'}, notes: {}},
  {trip: T.cancelled, title: `ETS2: ${ROUTE}`, outcome: 'Cancelled', completeness: 'Complete', fields: {'money-penalty': '12000 EUR (SDK-documented)',
    'money-fine': '9007199254741238 EUR (SDK-documented), 3 amounts; 50 (currency unknown), 1 amount', 'money-toll': '20 USD (SDK-documented), 1 amount; 1 unavailable (not observed)',
    'distance-deliveredDistance': 'none (not delivered)', 'samples-sampleCount': '0'}, notes: {}},
  {trip: T.differentJob, title: `ETS2: ${ROUTE}`, outcome: 'No outcome — a different job started', completeness: 'Partial', fields: {'money-toll': '10 EUR (SDK-documented), 1 amount',
    'money-revenueOrPenalty': 'none (no delivery or cancellation)', 'truck-licensePlate': 'SYN 0001'}, notes: {trailers: [NO_TRAILER]}},
  {trip: T.gapClosed, title: `ETS2: ${ROUTE}`, outcome: 'No outcome — events were lost', completeness: 'Partial', fields: {'money-fine': '70 EUR (SDK-documented), 1 amount',
    'truck-licensePlate': 'SYN 0003', 'trip-ended': local(BASE_UTC + 24_000)}, notes: {trailers: [NO_TRAILER]}},
  {trip: T.restartClosed, title: `ETS2: ${ROUTE}`, outcome: 'No outcome — the game or plugin restarted', completeness: 'Partial', fields: {'money-fine': '15 EUR (SDK-documented), 1 amount'},
    notes: {truck: [NO_TRUCK], trailers: [NO_TRAILER]}},
  {trip: T.open, title: `ETS2: ${ROUTE}`, outcome: 'In progress', completeness: 'Unknown', fields: {'trip-ended': 'not yet (in progress)', 'money-revenueOrPenalty': 'not yet (in progress)',
    'money-toll': '5 EUR (SDK-documented), 1 amount', 'samples-sampleCount': '2'}, notes: {truck: [NO_TRUCK], trailers: [NO_TRAILER]}},
  {trip: T.zeroValues, title: 'ATS: (empty) → unavailable (not provided by the game)', outcome: 'Delivered', completeness: 'Complete', fields: {'distance-plannedDistance': '0.0 mi',
    'distance-observedDistance': '0.0 mi', 'distance-deliveredDistance': 'unavailable (not provided by the game)', 'fuel-fuelUsed': NOT_OBSERVED,
    'money-expectedIncome': '0 USD (SDK-documented)', 'money-revenue': '0 USD (SDK-documented)', 'delivery-earnedXp': '0', 'delivery-cargoDamage': '0%',
    'job-cargoMass': 'unavailable (not provided by the game)', 'job-cargoLoaded': 'unavailable (invalid reading)', 'samples-sampleCount': '1'}, notes: {}},
  {trip: T.manySamples, title: `ATS: ${ROUTE}`, outcome: 'In progress', completeness: 'Unknown', fields: {'distance-plannedDistance': '94.4 mi', 'truck-fuelCapacity': '264.2 US gal',
    'samples-sampleCount': '650'}, notes: {trailers: [NO_TRAILER]}}
];

/** Polls a self-contained browser predicate until it returns a value; a hang guard, never a timing assertion. */
async function until(page, predicate, argument, timeout = 10000) {
  const handle = await page.waitForFunction(predicate, argument, {timeout, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
// Self-contained browser callbacks.
function listState(expected) {
  const d = globalThis.document, text = id => d.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  if (d.querySelector('[data-testid="journal-list-loading"]')) return false;
  const rows = [...d.querySelectorAll('[data-testid="journal-list"] [data-testid="journal-row"]')].map(row => {
    const cell = id => row.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    return {trip: row.getAttribute('data-trip'), started: cell('journal-row-started'), game: cell('journal-row-game'), route: cell('journal-row-route'), outcome: cell('journal-row-outcome'),
      completeness: cell('journal-row-completeness'), observed: cell('journal-row-observed'), fuel: cell('journal-row-fuel'), cargo: cell('journal-row-cargo')};
  });
  const state = {page: text('journal-list-page'), error: text('journal-list-error'), empty: text('journal-empty'), emptyNote: text('journal-empty-note'), banner: text('journal-banner'),
    next: d.querySelector('[data-testid="journal-list-next"]')?.disabled === false, previous: d.querySelector('[data-testid="journal-list-previous"]')?.disabled === false, rows};
  if (state.error) return state;
  return state.page?.startsWith(`Page ${expected.page}.`) && (expected.first === undefined || rows[0]?.trip === expected.first) && rows.length === expected.count ? state : false;
}
function detailState(expected) {
  const d = globalThis.document, root = d.querySelector('[data-testid="journal-detail"]');
  if (!root || root.getAttribute('data-trip') !== expected.trip || d.querySelector('[data-testid="journal-summary-loading"]')) return false;
  const text = id => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  const error = text('journal-summary-error');
  if (!error && text('journal-detail-title') === null) return false;
  const fields = Object.fromEntries([...root.querySelectorAll('[data-testid^="journal-field-"]')].map(node => [node.getAttribute('data-testid').slice('journal-field-'.length), node.textContent]));
  const notes = {};
  for (const node of root.querySelectorAll('[data-testid^="journal-section-"][data-testid$="-note"]')) {
    const id = node.getAttribute('data-testid').slice('journal-section-'.length, -'-note'.length);
    (notes[id] ??= []).push(node.textContent);
  }
  return {error, title: text('journal-detail-title'), outcome: text('journal-detail-outcome'), completeness: text('journal-detail-completeness'), fields, notes,
    banner: d.querySelector('[data-testid="journal-banner"]')?.textContent ?? null};
}
function tableState(expected) {
  const d = globalThis.document, root = d.querySelector(`[data-testid="${expected.root}"]`);
  if (!root || root.querySelector(`[data-testid="${expected.prefix}-loading"]`)) return false;
  const text = id => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  const rows = [...root.querySelectorAll(`[data-testid="${expected.row}"]`)].map(row => ({kind: row.getAttribute('data-kind'), eventSeq: row.getAttribute('data-event-seq'),
    cells: [...row.querySelectorAll('td')].map(cell => cell.textContent)}));
  const state = {page: text(`${expected.prefix}-page`), error: text(`${expected.prefix}-error`), header: expected.header ? text(expected.header) : null,
    next: root.querySelector(`[data-testid="${expected.prefix}-next"]`)?.disabled === false, rows};
  if (state.error) return state;
  return state.page?.startsWith(`Page ${expected.page}.`) && rows.length === expected.count ? state : false;
}
/** Self-contained: the bounding boxes of the status, speed and fuel lines against the viewport (B6). */
function liveLinesInViewport() {
  const box = id => {
    const node = globalThis.document.querySelector(`[data-testid="${id}"]`), bounds = node?.getBoundingClientRect();
    return bounds ? {top: Math.round(bounds.top), bottom: Math.round(bounds.bottom), visible: bounds.width > 0 && bounds.height > 0} : null;
  };
  return {innerHeight: globalThis.innerHeight, scrollY: globalThis.scrollY, status: box('telemetry-status'), speed: box('speed'), fuel: box('fuel')};
}

const clickTestId = (page, testId, scope) => (scope ? page.locator(scope).getByTestId(testId) : page.getByTestId(testId)).click({timeout: 5000});

/**
 * Run 1: the empty history. The Live tab is the default, and the status, speed and fuel lines lie inside the 800 x 500
 * window below the tab list (B6). The Journal tab then shows `No trips recorded` with the recording-off note and no
 * test-database banner; back on Live, the speed line is shown again.
 */
export async function runJournalEmpty({dashboard, record}) {
  await dashboard.evaluate(() => globalThis.scrollTo(0, 0));
  const viewport = record.liveViewport = await dashboard.evaluate(liveLinesInViewport);
  for (const line of ['status', 'speed', 'fuel']) {
    assert.ok(viewport[line]?.visible && viewport[line].top >= 0 && viewport[line].bottom <= viewport.innerHeight, `The ${line} line is outside the first viewport`);
  }
  record.liveLinesInViewport = true;
  assert.equal(await dashboard.getByTestId('tab-live').getAttribute('aria-selected'), 'true');
  await clickTestId(dashboard, 'tab-journal');
  const empty = record.emptyHistory = await until(dashboard, listState, {page: 1, count: 0});
  // Only one tab panel is shown: the Live cards are hidden, not stacked above the journal.
  record.liveHiddenInJournal = await dashboard.getByTestId('speed').isHidden() && await dashboard.getByTestId('overlay-settings').isHidden();
  assert.equal(record.liveHiddenInJournal, true, 'The Live panel is shown while the Journal tab is open');
  assert.deepEqual({error: empty.error, empty: empty.empty, emptyNote: empty.emptyNote, banner: empty.banner, next: empty.next, previous: empty.previous},
    {error: null, empty: 'No trips recorded', emptyNote: 'Game history recording is off in this version, so no game trips are recorded yet.', banner: null, next: false, previous: false});
  record.emptyHistoryShown = true; record.recordingOffNoteShown = true;
  await clickTestId(dashboard, 'tab-live');
  await dashboard.getByTestId('speed').waitFor({state: 'visible', timeout: 5000});
  // The closed Journal tab is unmounted and holds no page.
  await dashboard.getByTestId('journal').waitFor({state: 'detached', timeout: 5000});
  record.liveRestored = true;
}

/** Bundles journal-seed.mjs and runs it under the checkout's Electron in Node mode against the isolated LOCALAPPDATA. */
export async function seedJournalDatabase({config, record}) {
  const started = performance.now();
  const database = path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'journal.sqlite');
  const directory = path.join(config.output, 'journal-seed');
  const require = createRequire(path.join(config.checkout, 'package.json'));
  // Loaded here, so the other scenarios never load Vite.
  const {build} = await import('vite');
  // The bundle sits outside node_modules' tree, so better-sqlite3 is required by its absolute package path.
  const sqlite = path.dirname(require.resolve('better-sqlite3/package.json')).replaceAll('\\', '/');
  await build({configFile: false, root: config.checkout, logLevel: 'warn', build: {outDir: directory, emptyOutDir: true, minify: false,
    lib: {entry: path.join(config.checkout, 'scripts/ci/journal-seed.mjs'), formats: ['cjs'], fileName: () => 'journal-seed.cjs'},
    rollupOptions: {external: ['better-sqlite3', ...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: {paths: {'better-sqlite3': sqlite}}}}});
  const bundled = performance.now();
  const electron = require('electron');
  const child = spawn(electron, [path.join(directory, 'journal-seed.cjs'), database], {cwd: config.checkout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata}});
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  let timer;
  const exit = await Promise.race([new Promise(resolve => child.once('exit', code => resolve(code))), new Promise(resolve => {timer = setTimeout(() => resolve('timeout'), 30000);})]);
  clearTimeout(timer);
  if (exit !== 0) {child.kill(); throw new Error(`JOURNAL_SEED_FAILED ${exit}: ${Buffer.concat(stderr).toString().slice(0, 512)}`);}
  const seed = record.seed = {...JSON.parse(Buffer.concat(stdout).toString()), bundleMs: Math.round(bundled - started), totalMs: Math.round(performance.now() - started)};
  assert.deepEqual({trips: seed.trips, fillers: seed.fillers, pagingTolls: seed.pagingTolls, pagingSamples: seed.pagingSamples}, {trips: 119, fillers: 110, pagingTolls: 104, pagingSamples: 3600});
  assert.ok(existsSync(database) && !existsSync(path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'backups')));
  record.seeded = true;
}

const rowSummary = rows => ({count: rows.length, first: rows[0]?.trip ?? null, last: rows.at(-1)?.trip ?? null});
async function openDetail(dashboard, trip) {
  await dashboard.locator(`[data-testid="journal-row"][data-trip="${trip}"]`).getByTestId('journal-row-open').click({timeout: 5000});
  return until(dashboard, detailState, {trip});
}
async function back(dashboard) {
  await clickTestId(dashboard, 'journal-back');
  await dashboard.getByTestId('journal-detail').waitFor({state: 'detached', timeout: 5000});
}
const table = {
  intervals: {tab: 'journal-detail-tab-intervals', root: 'journal-intervals', prefix: 'journal-intervals', row: 'journal-interval-row', header: 'journal-intervals-total'},
  timeline: {tab: 'journal-detail-tab-timeline', root: 'journal-timeline', prefix: 'journal-events', row: 'journal-event-row', header: 'journal-window'},
  samples: {tab: 'journal-detail-tab-samples', root: 'journal-samples', prefix: 'journal-samples', row: 'journal-sample-row', header: null}
};
async function openTable(dashboard, kind, count) {
  await clickTestId(dashboard, table[kind].tab);
  return until(dashboard, tableState, {...table[kind], page: 1, count});
}
async function nextTable(dashboard, kind, page, count, direction = 'next') {
  await clickTestId(dashboard, `${table[kind].prefix}-${direction}`);
  return until(dashboard, tableState, {...table[kind], page, count});
}

/**
 * Run 2: the seeded synthetic database. The banner stays on every view; the unfiltered list has pages of 50, 50 and 19
 * with Previous and Next; two filters narrow it before the limit; every anchor's row and detail show their hand-written
 * texts; the paging trip's timeline (105 events), completeness intervals (104) and samples (3,600) each page forward and
 * back; the delivered anchor's samples show one `no samples for 1 s` row; Back keeps the list page without a new read.
 */
export async function runJournalSeeded({dashboard, record}) {
  const BANNER = 'Synthetic test database — never game history';
  await clickTestId(dashboard, 'tab-journal');
  const pages = record.pages = [];
  const page1 = await until(dashboard, listState, {page: 1, count: 50, first: T.paging});
  assert.equal(page1.banner, BANNER); record.syntheticBannerShown = true;
  assert.equal(await dashboard.getByTestId('speed').isHidden(), true, 'The Live panel is shown while the Journal tab is open');
  pages.push({...rowSummary(page1.rows), next: page1.next, previous: page1.previous});
  await clickTestId(dashboard, 'journal-list-next');
  const page2 = await until(dashboard, listState, {page: 2, count: 50, first: filler(60)});
  pages.push({...rowSummary(page2.rows), next: page2.next, previous: page2.previous});
  await clickTestId(dashboard, 'journal-list-next');
  const page3 = await until(dashboard, listState, {page: 3, count: 19, first: filler(10)});
  pages.push({...rowSummary(page3.rows), next: page3.next, previous: page3.previous});
  assert.deepEqual(pages, [{count: 50, first: T.paging, last: filler(61), next: true, previous: false}, {count: 50, first: filler(60), last: filler(11), next: true, previous: true},
    {count: 19, first: filler(10), last: T.delivered, next: false, previous: true}]);
  await clickTestId(dashboard, 'journal-list-previous');
  await until(dashboard, listState, {page: 2, count: 50, first: filler(60)});
  await clickTestId(dashboard, 'journal-list-next');
  const anchors = await until(dashboard, listState, {page: 3, count: 19, first: filler(10)});
  record.pagesWalked = true;
  record.anchorRows = anchors.rows.slice(11);
  assert.deepEqual(record.anchorRows, ANCHOR_ROWS, 'Anchor rows differ from the hand-written texts');
  record.anchorRowsMatch = true;

  // Every anchor's detail; Back returns to page 3 without reading it again.
  record.anchorDetails = [];
  for (const expected of ANCHOR_DETAILS) {
    const detail = await openDetail(dashboard, expected.trip);
    const actual = {trip: expected.trip, title: detail.title, outcome: detail.outcome, completeness: detail.completeness,
      fields: Object.fromEntries(Object.keys(expected.fields).map(key => [key, detail.fields[key] ?? null])),
      notes: Object.fromEntries(['truck', 'trailers'].filter(id => detail.notes[id]).map(id => [id, detail.notes[id]]))};
    record.anchorDetails.push(actual);
    assert.equal(detail.error, null); assert.equal(detail.banner, BANNER);
    assert.deepEqual(actual, expected, `Detail of ${expected.trip} differs from the hand-written texts`);
    if (expected.trip === T.delivered) {
      // The timeline window and the sample gap row of J14 (seconds 1, 2 and 4).
      const timeline = await openTable(dashboard, 'timeline', 6);
      record.deliveredTimeline = {window: timeline.header, eventSeqs: timeline.rows.map(row => row.eventSeq)};
      assert.deepEqual(record.deliveredTimeline, {window: "Events of the trip's plugin session from eventSeq 4 through 9, the event that closed the trip.",
        eventSeqs: ['4', '5', '6', '7', '8', '9']});
      const samples = await openTable(dashboard, 'samples', 4);
      record.deliveredSamples = samples.rows.map(row => row.kind === 'sample' ? {kind: row.kind, speed: row.cells[1]} : {kind: row.kind, text: row.cells[0]});
      assert.deepEqual(record.deliveredSamples, [{kind: 'sample', speed: '80.1 km/h'}, {kind: 'sample', speed: '0.0 km/h'}, {kind: 'gap', text: 'no samples for 1 s'},
        {kind: 'sample', speed: 'unavailable (invalid reading)'}]);
      record.sampleGapShown = true;
    }
    if (expected.trip === T.gapClosed) {
      const intervals = await openTable(dashboard, 'intervals', 3);
      record.gapIntervals = {total: intervals.header, rows: intervals.rows.map(row => row.cells.slice(0, 2))};
      assert.deepEqual(record.gapIntervals, {total: 'Completeness intervals recorded for this trip: 3.', rows: [['Discontinuity', 'truck changed (annotation; completeness unchanged)'],
        ['Missing one-second samples', 'readings missing'], ['Lost events', 'lost events']]});
    }
    await back(dashboard);
    const kept = await until(dashboard, listState, {page: 3, count: 19, first: filler(10)});
    assert.equal(kept.rows.length, 19);
  }
  record.anchorDetailsMatch = true; record.backKeptPage = true;

  // The paging trip on page 1: timeline, completeness intervals and samples each page forward and back.
  await clickTestId(dashboard, 'journal-list-refresh');
  await until(dashboard, listState, {page: 3, count: 19, first: filler(10)});
  for (let page = 2; page >= 1; page--) {
    await clickTestId(dashboard, 'journal-list-previous');
    await until(dashboard, listState, {page, count: 50, first: page === 1 ? T.paging : filler(60)});
  }
  const paging = await openDetail(dashboard, T.paging);
  record.pagingSummary = {toll: paging.fields['money-toll'] ?? null, samples: paging.fields['samples-sampleCount'] ?? null};
  assert.deepEqual(record.pagingSummary, {toll: '104 EUR (SDK-documented), 104 amounts', samples: '3600'});
  const timeline = await openTable(dashboard, 'timeline', 100);
  const timeline2 = await nextTable(dashboard, 'timeline', 2, 5);
  await nextTable(dashboard, 'timeline', 1, 100, 'previous');
  record.pagingTimeline = {window: timeline.header, first: timeline.rows[0].eventSeq, pageTwo: timeline2.rows.map(row => row.eventSeq), nextOnLast: timeline2.next};
  assert.deepEqual(record.pagingTimeline, {window: "Events of the trip's plugin session from eventSeq 1; the trip is in progress.", first: '1', pageTwo: ['101', '102', '103', '104', '105'],
    nextOnLast: false});
  record.timelinePaged = true;
  const intervals = await openTable(dashboard, 'intervals', 100);
  const intervals2 = await nextTable(dashboard, 'intervals', 2, 4);
  await nextTable(dashboard, 'intervals', 1, 100, 'previous');
  record.pagingIntervals = {total: intervals.header, pageTwo: intervals2.rows.length, nextOnLast: intervals2.next};
  assert.deepEqual(record.pagingIntervals, {total: 'Completeness intervals recorded for this trip: 104.', pageTwo: 4, nextOnLast: false});
  record.intervalsPaged = true;
  const samples = await openTable(dashboard, 'samples', 300);
  const samples2 = await nextTable(dashboard, 'samples', 2, 300);
  await nextTable(dashboard, 'samples', 1, 300, 'previous');
  record.pagingSamples = {kinds: [...new Set([...samples.rows, ...samples2.rows].map(row => row.kind))], firstSpeed: samples.rows[0].cells[1], nextOnSecond: samples2.next};
  assert.deepEqual(record.pagingSamples, {kinds: ['sample'], firstSpeed: '72.0 km/h', nextOnSecond: true});
  record.samplesPaged = true;
  await back(dashboard);

  // Filters apply before the page limit: no outcome is exactly the three anchors closed without one; partial is 3 + 36.
  await dashboard.getByTestId('journal-filter-outcome').selectOption('none');
  const none = await until(dashboard, listState, {page: 1, count: 3, first: T.restartClosed});
  await dashboard.getByTestId('journal-filter-outcome').selectOption('');
  await dashboard.getByTestId('journal-filter-completeness').selectOption('partial');
  const partial = await until(dashboard, listState, {page: 1, count: 39});
  await dashboard.getByTestId('journal-filter-completeness').selectOption('');
  await until(dashboard, listState, {page: 1, count: 50, first: T.paging});
  record.filters = {none: none.rows.map(row => row.trip), noneNext: none.next, partial: partial.rows.length, partialNext: partial.next};
  assert.deepEqual(record.filters, {none: [T.restartClosed, T.gapClosed, T.differentJob], noneNext: false, partial: 39, partialNext: false});
  record.filtersApplied = true;
}

const journalDatabase = config => path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'journal.sqlite');
/**
 * After both runs: run 2 opened only the seeded synthetic database (never history), read it without a failure, closed it
 * cleanly and exited orderly; the file is closed without WAL, shared-memory or journal files.
 */
export async function verifyJournalRun({config, record, restartMainEvents, restartServiceEvents}) {
  for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
    const rows = restartMainEvents.filter(row => row.event === name);
    assert.equal(rows.length, 1); assert.equal(rows[0].detail.code, 0);
  }
  assert.deepEqual(restartServiceEvents.filter(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped').map(row => row.detail), [{type: 'stopped', clean: true}]);
  const steps = restartServiceEvents.filter(row => row.event === 'SHUTDOWN_STEP');
  assert.ok(steps.length >= 3 && steps.every(row => row.facts?.outcome === 'ok'), 'Every service shutdown step must finish cleanly');
  assert.ok(![...restartMainEvents, ...restartServiceEvents].some(row => FAILURE_EVENTS.test(row.event)));
  assert.deepEqual(restartServiceEvents.filter(row => row.event === 'RECORDING_TARGET').map(row => row.facts), [{purpose: 'synthetic'}]);
  assert.deepEqual(restartServiceEvents.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts), [{schemaVersion: 2, created: false, migratedFrom: null}]);
  assert.equal(restartServiceEvents.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length, 1);
  assert.deepEqual(restartMainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['app-quit']);
  const database = journalDatabase(config), header = Buffer.alloc(100), file = await open(database, 'r');
  try {await file.read(header, 0, 100, 0);} finally {await file.close();}
  const files = record.files = {magic: header.subarray(0, 15).toString('latin1'), applicationId: header.readInt32BE(68), userVersion: header.readUInt32BE(60),
    sidecars: ['-wal', '-shm', '-journal'].filter(suffix => existsSync(database + suffix)), syntheticBackups: existsSync(path.join(path.dirname(database), 'backups'))};
  assert.deepEqual(files, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 2, sidecars: [], syntheticBackups: false});
  record.shutdownClean = true;
}
