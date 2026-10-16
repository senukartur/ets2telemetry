// ET-016 PR-2: journal reads at scale (J5, J6, J20). 1,000 generated trips with 360 one-second samples each (360,000
// samples) plus the hand-written anchors are written through the real storage core within an explicit time budget.
// The test proves that paging returns every trip exactly once and that EXPLAIN QUERY PLAN of every journal statement
// uses a primary key or an index and never scans events or samples, which is why schema version 2 adds no index.
// Timings are recorded by npm run measure:storage only, never asserted. Runs under npm run test:storage.
import {performance} from 'node:perf_hooks';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {JOURNAL_TRIP_PAGE, type JournalTripsQuery} from '../../packages/contracts/src/journal';
import {JOURNAL_QUERIES, type Storage} from '../../packages/storage/src/index';
import {JOURNAL_TRIPS, seedJournalAnchors, seedJournalFillers, type FillerTrip} from '../shared/journal-seed';
import {ok, readOnly, workspace} from './helpers';

/** The explicit budget for writing the scale database; the hook fails if it is exceeded. */
const BUILD_BUDGET_MS = 240_000;
const TRIPS = 1_000, SAMPLES_PER_TRIP = 360;

let ws: Awaited<ReturnType<typeof workspace>>;
let storage: Storage;
let fillers: FillerTrip[];
let buildMs = 0;
beforeAll(async () => {
  ws = await workspace();
  storage = await ws.open();
  const started = performance.now();
  await seedJournalAnchors(storage);
  fillers = await seedJournalFillers(storage, TRIPS, {samplesPerTrip: SAMPLES_PER_TRIP});
  buildMs = performance.now() - started;
}, BUILD_BUDGET_MS);
afterAll(async () => { await ws.dispose(); });

function readAll(query: Omit<JournalTripsQuery, 'cursor'>): {pages: number[]; trips: string[]} {
  const pages: number[] = [], trips: string[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 100; round++) {
    const page = ok(storage.journalTrips({...query, cursor}));
    pages.push(page.trips.length); trips.push(...page.trips.map(trip => trip.tripUuid));
    if (page.nextCursor === null) return {pages, trips};
    expect(page.trips).toHaveLength(JOURNAL_TRIP_PAGE);
    cursor = page.nextCursor;
  }
  throw new Error('Journal paging did not end within 100 pages');
}

describe('journal reads at scale (J5; REG-014)', () => {
  it('was written within the budget', () => {
    process.stderr.write(`JOURNAL_SCALE_BUILD_MS ${Math.round(buildMs)}\n`);
    expect(buildMs).toBeLessThan(BUILD_BUDGET_MS);
  });
  it('lists every trip exactly once across newest-first pages, with and without a filter', () => {
    const all = readAll({});
    // 1,008 trips: 20 full pages, then 8 rows.
    expect(all.pages).toEqual([...Array(20).fill(50), 8]);
    expect(new Set(all.trips).size).toBe(TRIPS + 8);
    expect(all.trips.slice(0, TRIPS)).toEqual(fillers.map(trip => trip.tripUuid).reverse());
    expect(all.trips.slice(TRIPS)).toEqual(Object.values(JOURNAL_TRIPS).reverse());
    const ats = readAll({game: 'ats', outcome: 'open'});
    const expected = fillers.filter(trip => trip.game === 'ats' && trip.outcome === 'open').map(trip => trip.tripUuid).reverse();
    expect(ats.trips).toEqual([...expected, JOURNAL_TRIPS.manySamples]);
    expect(new Set(ats.trips).size).toBe(ats.trips.length);
  });
  it('reads a generated trip\'s detail, samples and timeline at this size', () => {
    const trip = fillers[TRIPS - 1].tripUuid, detail = ok(storage.journalTrip(trip));
    expect(detail.samples.count).toBe(SAMPLES_PER_TRIP);
    expect(detail.trip.tripUuid).toBe(trip);
    expect(ok(storage.listSamples({tripUuid: trip}, {limit: 300}))).toHaveLength(300);
    expect(ok(storage.journalEvents(trip, {limit: 100})).events.length).toBeGreaterThan(0);
  });
});


/**
 * Representative parameters for each statement. `PRAGMA user_version` has no plan. The expected plan lines are written
 * from the schema: the table's integer primary key, the UNIQUE (session, eventSeq) index of events, the trip index of
 * attributions, intervals and samples, and the composite primary key of trip_trailers.
 */
const PLANS: Record<Exclude<keyof typeof JOURNAL_QUERIES, 'userVersion'>, {params: unknown[]; uses: string[]}> = {
  purpose: {params: [], uses: ['SEARCH database_info USING INTEGER PRIMARY KEY (rowid=?)']},
  tripPage: {params: [9_223_372_036_854_775_807n, null, null, 'open', 'open', null, null, 50], uses: ['SEARCH trips USING INTEGER PRIMARY KEY (rowid<?)']},
  tripByUuid: {params: [JOURNAL_TRIPS.delivered], uses: ['SEARCH trips USING INDEX sqlite_autoindex_trips_1 (trip_uuid=?)']},
  job: {params: [1n], uses: ['SEARCH job_configurations USING INTEGER PRIMARY KEY (rowid=?)']},
  session: {params: [1n], uses: ['SEARCH plugin_sessions USING INTEGER PRIMARY KEY (rowid=?)']},
  eventById: {params: [1n], uses: ['SEARCH events USING INTEGER PRIMARY KEY (rowid=?)']},
  eventExists: {params: [1n, '00000000000000000001'], uses: ['SEARCH events USING COVERING INDEX sqlite_autoindex_events_1 (plugin_session_id=? AND event_seq=?)']},
  truck: {params: [1n], uses: ['SEARCH truck_configurations USING INTEGER PRIMARY KEY (rowid=?)']},
  trailers: {params: [1n], uses: ['SEARCH x USING COVERING INDEX sqlite_autoindex_trip_trailers_1 (trip_ref=?)', 'SEARCH c USING INTEGER PRIMARY KEY (rowid=?)',
    'SEARCH e USING INTEGER PRIMARY KEY (rowid=?)']},
  amounts: {params: [1n, 5_001], uses: ['SEARCH a USING COVERING INDEX event_attributions_trip (trip_ref=?)', 'SEARCH e USING INTEGER PRIMARY KEY (rowid=?)',
    'SEARCH m USING INTEGER PRIMARY KEY (rowid=?)']},
  intervalPage: {params: [1n, 0n, 100], uses: ['SEARCH completeness_intervals USING INDEX completeness_intervals_trip (trip_ref=? AND rowid>?)']},
  intervalTotal: {params: [1n], uses: ['SEARCH completeness_intervals USING COVERING INDEX completeness_intervals_trip (trip_ref=?)']},
  clock: {params: [1n], uses: ['SEARCH clocks USING INTEGER PRIMARY KEY (rowid=?)']},
  sampleSummary: {params: [1n], uses: ['SEARCH samples USING COVERING INDEX samples_trip (trip_ref=?)']},
  sampleLabel: {params: [1n], uses: ['SEARCH samples USING INTEGER PRIMARY KEY (rowid=?)']},
  windowEvents: {params: [1n, '00000000000000000003', '00000000000000000009', 100],
    uses: ['SEARCH e USING INDEX sqlite_autoindex_events_1 (plugin_session_id=? AND event_seq>? AND event_seq<?)', 'SEARCH a USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN',
      'SEARCH t USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN']},
  referencedEvents: {params: [{trip: 1n, session: 1n, after: '00000000000000000000', limit: 100}],
    uses: ['SEARCH e USING INTEGER PRIMARY KEY (rowid=?)', 'SEARCH event_attributions USING COVERING INDEX event_attributions_trip (trip_ref=?)',
      'SEARCH x USING COVERING INDEX sqlite_autoindex_trip_trailers_1 (trip_ref=?)', 'SEARCH a USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN']}
};

describe('journal query plans (J6: no new index)', () => {
  // The writer holds an exclusive lock, so the plans are read through a separate read-only connection after closing it.
  beforeAll(() => { storage.close(); });
  it('holds 1,008 trips and 360,657 samples', () => {
    // The anchors hold 4 + 2 + 1 + 650 samples; each filler holds 360.
    expect(readOnly(ws.database, db => ({trips: Number(db.prepare('SELECT count(*) FROM trips').pluck().get()), samples: Number(db.prepare('SELECT count(*) FROM samples').pluck().get())})))
      .toEqual({trips: TRIPS + 8, samples: TRIPS * SAMPLES_PER_TRIP + 657});
  });
  it.each(Object.keys(PLANS) as (keyof typeof PLANS)[])('%s uses a key or an index and never scans events or samples', name => {
    const plan = readOnly(ws.database, db => (db.prepare(`EXPLAIN QUERY PLAN ${JOURNAL_QUERIES[name]}`).all(...PLANS[name].params) as {detail: string}[]).map(row => row.detail));
    for (const line of PLANS[name].uses) expect(plan, plan.join('\n')).toContain(line);
    // A full scan of events or samples, under their own name or an alias, would grow with history.
    for (const line of plan) expect(line).not.toMatch(/^SCAN (events|samples|e)\b/);
  });
});
