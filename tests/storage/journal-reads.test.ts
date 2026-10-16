// ET-016 PR-2: journal reads through the in-process storage core, against temporary synthetic-purpose databases. The
// main database is a copy of the immutable version 1 fixture, migrated to version 2 (its trip is the migrated anchor),
// then seeded with the hand-written anchors and 110 filler trips of tests/shared/journal-seed.ts. Every expected value
// is written by hand from that seed, the version 1 and 2 fixture SQL and J5/J7; none is read back from the code under
// test. Runs under npm run test:storage.
import Database from 'better-sqlite3';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {JOURNAL_DETAIL_INTERVALS, JOURNAL_TRIP_PAGE, validateJournalTripDetail, type JournalTripListItem, type JournalTripsQuery} from '../../packages/contracts/src/journal';
import type {Storage, TripEffect} from '../../packages/storage/src/index';
import {
  ANCHOR_GAME_MODE, ANCHOR_JOBS, CHANGED_TRUCK, EUR, JOURNAL_TRIPS as T, MIGRATED_V1_SESSION, MIGRATED_V1_TRIP, seedJournalAnchors, seedJournalFillers, SESSION_B_UTC,
  SESSION_C_UTC, UNKNOWN_CURRENCY, USD, ZERO_DELIVERY, type FillerTrip
} from '../shared/journal-seed';
import {ATS_A, BASE_UTC, ETS2_A, ETS2_B, job, money, r, Script, trailer, truck} from '../shared/trip-messages';
import {failed, ok, REPRESENTATIVE, workspace} from './helpers';

const DATABASE = {purpose: 'synthetic', schemaVersion: 2};
const NOT_OBSERVED = {available: false, reason: 'not-observed'} as const;
const text = (value: string) => ({available: true as const, value});

let ws: Awaited<ReturnType<typeof workspace>>;
let storage: Storage;
let fillers: FillerTrip[];
beforeAll(async () => {
  ws = await workspace();
  ws.copyFixture(REPRESENTATIVE, ws.database);
  storage = await ws.open();
  expect(storage.summary).toMatchObject({schemaVersion: 2, migratedFrom: 1});
  await seedJournalAnchors(storage);
  fillers = await seedJournalFillers(storage, 110);
}, 120_000);
afterAll(async () => { await ws.dispose(); });

/** The anchors in creation order (the migrated trip is row 1), with the values the seed and the fixture wrote. */
const ANCHORS = [
  {tripUuid: MIGRATED_V1_TRIP, game: 'ets2', outcome: 'cancelled', recordingCompleteness: 'partial'},
  {tripUuid: T.delivered, game: 'ets2', outcome: 'delivered', recordingCompleteness: 'complete'},
  {tripUuid: T.cancelled, game: 'ets2', outcome: 'cancelled', recordingCompleteness: 'complete'},
  {tripUuid: T.differentJob, game: 'ets2', outcome: 'none', recordingCompleteness: 'partial'},
  {tripUuid: T.gapClosed, game: 'ets2', outcome: 'none', recordingCompleteness: 'partial'},
  {tripUuid: T.restartClosed, game: 'ets2', outcome: 'none', recordingCompleteness: 'partial'},
  {tripUuid: T.open, game: 'ets2', outcome: 'open', recordingCompleteness: 'unknown'},
  {tripUuid: T.zeroValues, game: 'ats', outcome: 'delivered', recordingCompleteness: 'complete'},
  {tripUuid: T.manySamples, game: 'ats', outcome: 'open', recordingCompleteness: 'unknown'}
];
/** Every trip that matches the query, newest first: the fillers were created after the anchors. */
function expectedOrder(query: JournalTripsQuery): string[] {
  const match = (t: {game: string; outcome: string; recordingCompleteness: string}) => (query.game === undefined || t.game === query.game)
    && (query.outcome === undefined || t.outcome === query.outcome) && (query.completeness === undefined || t.recordingCompleteness === query.completeness);
  return [...ANCHORS, ...fillers].filter(match).map(t => t.tripUuid).reverse();
}
/** Reads every page of a query, checking each page's size and cursor: a full page has a cursor, the last one none. */
function readAll(query: Omit<JournalTripsQuery, 'cursor'>) {
  const pages: number[] = [], trips: string[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 100; round++) {
    const page = ok(storage.journalTrips({...query, cursor}));
    expect(page.database).toEqual(DATABASE);
    pages.push(page.trips.length);
    trips.push(...page.trips.map(trip => trip.tripUuid));
    if (page.trips.length === JOURNAL_TRIP_PAGE) expect(page.nextCursor).toMatch(/^[1-9][0-9]*$/);
    else expect(page.nextCursor).toBeNull();
    if (page.nextCursor === null) return {pages, trips};
    cursor = page.nextCursor;
  }
  throw new Error('Journal paging did not end within 100 pages');
}
const eventSeqs = (tripUuid: string, cursor?: string) => ok(storage.journalEvents(tripUuid, {limit: 100, cursor})).events.map(event => event.eventSeq);

describe('journal trip list (J5; REG-014)', () => {
  it('lists every trip newest first, 50 per page; a full page has a cursor and the last page has none', () => {
    const {pages, trips} = readAll({});
    expect(fillers).toHaveLength(110);
    expect(pages).toEqual([50, 50, 19]);
    expect(trips).toEqual(expectedOrder({}));
    expect(trips.slice(0, 2)).toEqual([fillers[109].tripUuid, fillers[108].tripUuid]);
    expect(trips.slice(-9)).toEqual([T.manySamples, T.zeroValues, T.open, T.restartClosed, T.gapClosed, T.differentJob, T.cancelled, T.delivered, MIGRATED_V1_TRIP]);
    expect(new Set(trips).size).toBe(119);
  });
  it.each<[string, JournalTripsQuery, number[]]>([
    // 55 ETS2 fillers and 7 ETS2 anchors: a filter applied after the limit would return a short first page.
    ['game ets2', {game: 'ets2'}, [50, 12]],
    ['game ats', {game: 'ats'}, [50, 7]],
    ['outcome open', {outcome: 'open'}, [38]],
    ['outcome none', {outcome: 'none'}, [3]],
    ['completeness partial', {completeness: 'partial'}, [40]],
    ['ets2 and delivered', {game: 'ets2', outcome: 'delivered'}, [20]],
    ['ats, delivered and complete', {game: 'ats', outcome: 'delivered', completeness: 'complete'}, [20]],
    ['completeness unknown and game ats', {completeness: 'unknown', game: 'ats'}, [19]]
  ])('applies the %s filter in SQL before the page limit', (_name, query, pages) => {
    const result = readAll(query);
    expect(result.pages).toEqual(pages);
    expect(result.trips).toEqual(expectedOrder(query));
  });
  it('shows zero apart from unavailable and the trip outcome apart from its completeness in list rows (REG-009, REG-003)', () => {
    const page = ok(storage.journalTrips({game: 'ats', outcome: 'delivered', completeness: 'complete'}));
    const zero = page.trips.at(-1)!;
    expect(zero).toEqual({
      tripUuid: T.zeroValues, game: 'ats', gameMode: ANCHOR_GAME_MODE, gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete',
      startedUtcMs: SESSION_C_UTC + 3_000, endedUtcMs: SESSION_C_UTC + 4_000, observedDistanceM: {available: true, value: 0}, fuelUsedL: NOT_OBSERVED,
      job: {source: 'event', sourceCity: text(''), sourceCompany: text('Synthetic Company A'), destinationCity: {available: false, reason: 'not-supported'},
        destinationCompany: text('Synthetic Company B'), cargo: NOT_OBSERVED, plannedDistance: {available: true, value: 0, unit: 'm'},
        expectedIncome: {available: true, value: {raw: '0', sdkType: 'u64', currency: USD}}}
    } satisfies JournalTripListItem);
    const open = ok(storage.journalTrips({game: 'ets2', outcome: 'open'})).trips.at(-1)!;
    expect(open).toMatchObject({tripUuid: T.open, outcome: 'open', closeReason: null, recordingCompleteness: 'unknown', endedUtcMs: null,
      observedDistanceM: NOT_OBSERVED, fuelUsedL: NOT_OBSERVED, startedUtcMs: SESSION_B_UTC + 1_000});
    // A partial trip stays visible as partial, with its own outcome (REG-003).
    const partial = ok(storage.journalTrips({completeness: 'partial', game: 'ets2', outcome: 'none'})).trips;
    expect(partial.map(trip => [trip.tripUuid, trip.closeReason])).toEqual([[T.restartClosed, 'restart'], [T.gapClosed, 'gap'], [T.differentJob, 'different-job']]);
    const migrated = readAll({outcome: 'cancelled', completeness: 'partial'}).trips.at(-1);
    expect(migrated).toBe(MIGRATED_V1_TRIP);
    expect(ok(storage.journalTrips({cursor: '2'})).trips.map(trip => trip.tripUuid)).toEqual([MIGRATED_V1_TRIP]);
    expect(ok(storage.journalTrips({cursor: '2'})).trips[0]).toEqual({
      tripUuid: MIGRATED_V1_TRIP, game: 'ets2', gameMode: ANCHOR_GAME_MODE, gameModeAmbiguous: false, outcome: 'cancelled', closeReason: 'outcome', recordingCompleteness: 'partial',
      startedUtcMs: 1_791_676_800_000, endedUtcMs: 1_791_677_100_000, observedDistanceM: {available: true, value: 1_500.5}, fuelUsedL: NOT_OBSERVED,
      job: {source: 'event', sourceCity: text('Synthetic City A'), sourceCompany: text('Synthetic Company A'), destinationCity: text('Synthetic City B'),
        destinationCompany: text('Synthetic Company B'), cargo: text('Synthetic Cargo'), plannedDistance: {available: true, value: 152_000, unit: 'm'},
        expectedIncome: {available: true, value: {raw: '18446744073709551615', sdkType: 'u64', currency: UNKNOWN_CURRENCY}}}
    });
  });
});

describe('journal trip detail (J5, J13; REG-009, REG-014)', () => {
  it('returns the delivered trip with its job, truck, trailer, revenue, exact money totals, window, samples and export bounds', () => {
    expect(ok(storage.journalTrip(T.delivered))).toEqual({
      database: DATABASE,
      trip: {
        tripUuid: T.delivered, game: 'ets2', gameMode: ANCHOR_GAME_MODE, gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete',
        startedUtcMs: BASE_UTC + 4_000, endedUtcMs: BASE_UTC + 9_000, observedDistanceM: {available: true, value: 152_000.5}, fuelUsedL: NOT_OBSERVED,
        job: {source: 'event', sourceCity: text('Synthetic City A'), sourceCompany: text('Synthetic Company A'), destinationCity: text('Synthetic City B'),
          destinationCompany: text('Synthetic Company B'), cargo: text('Synthetic Cargo'), plannedDistance: {available: true, value: 152_000, unit: 'm'},
          expectedIncome: {available: true, value: {raw: '12345', sdkType: 'u64', currency: UNKNOWN_CURRENCY}}},
        pluginSessionId: ETS2_A, openedBy: 'event', openedEventSeq: '4', outcomeEventSeq: '9', closedBy: {pluginSessionId: ETS2_A, eventSeq: '9'}
      },
      job: {source: 'event', eventSeq: '4', checkpointNextEventSeq: null, values: job()},
      truck: {eventSeq: '1', values: truck()},
      trailers: {items: [{eventSeq: '2', values: trailer(0)}], total: 1},
      outcomeDetails: {eventSeq: '9', record: {type: 'job.delivered', revenue: money('15000', 's64', EUR), earnedXp: {available: true, value: 250},
        cargoDamage: {available: true, value: 0.0125, unit: 'fraction'}, distance: {available: true, value: 151_250.5, unit: 'm'},
        deliveryDuration: {available: true, value: '471', unit: 'min'}, autoParkUsed: {available: true, value: false}, autoLoadUsed: {available: true, value: true}}},
      money: {incomplete: false, unavailable: [], totals: [
        {category: 'fine', sdkType: 's64', currency: EUR, raw: '401', count: 2},
        {category: 'toll', sdkType: 's64', currency: EUR, raw: '35', count: 1},
        {category: 'ferry', sdkType: 's64', currency: EUR, raw: '677', count: 1}]},
      window: {known: true, pluginSessionId: ETS2_A, fromEventSeq: '4', throughEventSeq: '9', end: 'close-event'},
      intervals: {items: [], total: 0, nextCursor: null},
      // Samples: the fixture holds ids 1–3; the delivered batch is ids 4–7, of which 5–7 belong to the trip.
      samples: {count: 3, firstUtcMs: BASE_UTC + 5_000, lastUtcMs: BASE_UTC + 8_000},
      exportBounds: {committedThroughEventSeq: '29', lastSampleId: '7', lastIntervalId: null}
    });
  });
  it('keeps zero apart from unavailable for every job, outcome and sample value of the zero-values trip (REG-009)', () => {
    expect(ok(storage.journalTrip(T.zeroValues))).toEqual({
      database: DATABASE,
      trip: {
        tripUuid: T.zeroValues, game: 'ats', gameMode: ANCHOR_GAME_MODE, gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete',
        startedUtcMs: SESSION_C_UTC + 3_000, endedUtcMs: SESSION_C_UTC + 4_000, observedDistanceM: {available: true, value: 0}, fuelUsedL: NOT_OBSERVED,
        job: {source: 'event', sourceCity: text(''), sourceCompany: text('Synthetic Company A'), destinationCity: {available: false, reason: 'not-supported'},
          destinationCompany: text('Synthetic Company B'), cargo: NOT_OBSERVED, plannedDistance: {available: true, value: 0, unit: 'm'},
          expectedIncome: {available: true, value: {raw: '0', sdkType: 'u64', currency: USD}}},
        pluginSessionId: ATS_A, openedBy: 'event', openedEventSeq: '3', outcomeEventSeq: '4', closedBy: {pluginSessionId: ATS_A, eventSeq: '4'}
      },
      job: {source: 'event', eventSeq: '3', checkpointNextEventSeq: null, values: ANCHOR_JOBS.zeroValues},
      truck: {eventSeq: '1', values: truck()},
      trailers: {items: [{eventSeq: '2', values: trailer(0)}], total: 1},
      outcomeDetails: {eventSeq: '4', record: ZERO_DELIVERY},
      money: {incomplete: false, totals: [], unavailable: []},
      window: {known: true, pluginSessionId: ATS_A, fromEventSeq: '3', throughEventSeq: '4', end: 'close-event'},
      intervals: {items: [], total: 0, nextCursor: null},
      samples: {count: 1, firstUtcMs: SESSION_C_UTC + 3_500, lastUtcMs: SESSION_C_UTC + 3_500},
      // Sample ids: fixture 1–3, delivered batch 4–7, open trip 8–9, this trip 10.
      exportBounds: {committedThroughEventSeq: '5', lastSampleId: '10', lastIntervalId: null}
    });
    const [sample] = ok(storage.listSamples({tripUuid: T.zeroValues}, {limit: 300}));
    expect(sample).toEqual({id: '10', tripUuid: T.zeroValues, utcMs: SESSION_C_UTC + 3_500, sourceClockId: '30000000-0000-4000-8000-0000000000c3', monotonicNs: '5001000000000',
      gameTime: {minutes: {available: true, value: 0}, clockId: '40000000-0000-4000-8000-000000000001'},
      speed: {available: true, value: 0}, fuel: {available: true, value: 0}, averageConsumption: {available: false, reason: 'not-supported'},
      estimatedRange: {available: false, reason: 'invalid'}, engineRpm: {available: true, value: 0}, gear: {available: true, value: 0}, odometer: NOT_OBSERVED,
      position: {available: true, value: {x: 0, y: 0, z: 0}}});
  });
  it('sums money exactly per category, SDK type and currency, never across currencies, and counts unavailable amounts apart', () => {
    const detail = ok(storage.journalTrip(T.cancelled));
    expect(detail.money).toEqual({incomplete: false,
      totals: [
        // 250 + 9007199254740993 - 5: beyond 2^53, so a float sum would be wrong.
        {category: 'fine', sdkType: 's64', currency: EUR, raw: '9007199254741238', count: 3},
        {category: 'fine', sdkType: 's64', currency: UNKNOWN_CURRENCY, raw: '50', count: 1},
        {category: 'toll', sdkType: 's64', currency: USD, raw: '20', count: 1}],
      unavailable: [{category: 'toll', reason: 'not-observed', count: 1}]});
    // The penalty is the outcome, never part of the totals; the expected income stays the job offer's.
    expect(detail.outcomeDetails).toEqual({eventSeq: '19', record: {type: 'job.cancelled', penalty: money('12000', 's64', EUR)}});
    expect(detail.trip.job.expectedIncome).toEqual({available: true, value: {raw: '12345', sdkType: 'u64', currency: UNKNOWN_CURRENCY}});
    expect(detail.trip.job.cargo).toEqual(text('Synthetic Cancel Cargo'));
  });
  it('reads the gap-closed trip with its changed truck and its intervals with annotation flags (REG-003)', () => {
    const detail = ok(storage.journalTrip(T.gapClosed));
    expect(detail.trip).toMatchObject({outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 24_000, outcomeEventSeq: null,
      closedBy: {pluginSessionId: ETS2_A, eventSeq: '25'}});
    expect(detail.truck).toEqual({eventSeq: '23', values: CHANGED_TRUCK});
    expect(detail.trailers).toEqual({items: [], total: 0});
    expect(detail.outcomeDetails).toBeNull();
    expect(detail.money).toEqual({incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: EUR, raw: '70', count: 1}], unavailable: []});
    // The fixture's interval is id 1; this trip's three intervals are ids 2–4, in insertion order.
    const intervals = [
      {id: '2', kind: 'discontinuity', annotation: true, cause: 'truck-change', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null,
        sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: {cause: 'truck-change', annotation: true, atEventSeq: '23'}},
      {id: '3', kind: 'sample-loss', annotation: false, cause: 'reading-hole', startUtcMs: BASE_UTC + 23_000, endUtcMs: BASE_UTC + 24_000,
        startMonotonicNs: '1023000000000', endMonotonicNs: '1024000000000', sourceClockId: '30000000-0000-4000-8000-0000000000a1', firstEventSeq: null, lastEventSeq: null,
        detail: {cause: 'reading-hole'}},
      {id: '4', kind: 'event-loss', annotation: false, cause: 'gap', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null, sourceClockId: null,
        firstEventSeq: '25', lastEventSeq: '26', detail: {cause: 'gap', firstEventSeq: '25', lastEventSeq: '26'}}];
    expect(detail.intervals).toEqual({items: intervals, total: 3, nextCursor: null});
    expect(detail.exportBounds).toEqual({committedThroughEventSeq: '29', lastSampleId: null, lastIntervalId: '4'});
    expect(ok(storage.journalIntervals(T.gapClosed, {limit: 100}))).toEqual({database: DATABASE, intervals, total: 3, nextCursor: null});
    expect(ok(storage.journalIntervals(T.gapClosed, {limit: 500, cursor: '2'})).intervals.map(i => i.id)).toEqual(['3', '4']);
    expect(ok(storage.journalIntervals(T.delivered, {limit: 100}))).toEqual({database: DATABASE, intervals: [], total: 0, nextCursor: null});
  });
  it('reads the migrated version 1 trip: no close carrier, an unknown window, its penalty and its fixture interval', () => {
    const detail = ok(storage.journalTrip(MIGRATED_V1_TRIP));
    expect(detail.trip).toMatchObject({pluginSessionId: MIGRATED_V1_SESSION, openedBy: 'event', openedEventSeq: '1', outcomeEventSeq: '6', closedBy: null});
    expect(detail.window).toEqual({known: false, pluginSessionId: MIGRATED_V1_SESSION});
    expect(detail.outcomeDetails).toEqual({eventSeq: '6', record: {type: 'job.cancelled',
      penalty: {available: true, value: {raw: '-9223372036854775808', sdkType: 's64', currency: UNKNOWN_CURRENCY}}}});
    expect(detail.money).toEqual({incomplete: false, totals: [], unavailable: []});
    expect(detail.intervals).toEqual({total: 1, nextCursor: null, items: [{id: '1', kind: 'event-loss', annotation: false, cause: null,
      startUtcMs: 1_791_676_804_000, endUtcMs: 1_791_676_805_000, startMonotonicNs: '1000330000000', endMonotonicNs: '1000340000000',
      sourceClockId: '30000000-0000-4000-8000-000000000001', firstEventSeq: '4', lastEventSeq: '5', detail: {causes: ['queueBytes', 'queueCount']}}]});
    expect(detail.samples).toEqual({count: 2, firstUtcMs: 1_791_676_801_000, lastUtcMs: 1_791_676_802_000});
    expect(detail.exportBounds).toEqual({committedThroughEventSeq: '6', lastSampleId: '3', lastIntervalId: '1'});
  });
  it('refuses unknown trips and malformed trip ids', () => {
    failed(storage.journalTrip('7a000000-0000-4000-8000-0000000000ff'), 'UNKNOWN_TRIP');
    failed(storage.journalTrip('not-a-uuid'), 'INVALID_INPUT');
    failed(storage.journalEvents('7a000000-0000-4000-8000-0000000000ff', {limit: 100}), 'UNKNOWN_TRIP');
    failed(storage.journalIntervals('7A000000-0000-4000-8000-000000000001', {limit: 100}), 'INVALID_INPUT');
  });
});

describe('journal timeline window (J7)', () => {
  it.each<[string, string, unknown, string[]]>([
    ['an outcome event closes the delivered trip, inclusive; A10 and A11 after it stay out', T.delivered,
      {known: true, pluginSessionId: ETS2_A, fromEventSeq: '4', throughEventSeq: '9', end: 'close-event'}, ['4', '5', '6', '7', '8', '9']],
    ['the cancelled trip ends at its outcome', T.cancelled,
      {known: true, pluginSessionId: ETS2_A, fromEventSeq: '12', throughEventSeq: '19', end: 'close-event'}, ['12', '13', '14', '15', '16', '17', '18', '19']],
    ['a different job configuration closes it and belongs to its window', T.differentJob,
      {known: true, pluginSessionId: ETS2_A, fromEventSeq: '20', throughEventSeq: '22', end: 'close-event'}, ['20', '21', '22']],
    ['a gap closes it before the gap\'s first new eventSeq; A27 after the gap stays out', T.gapClosed,
      {known: true, pluginSessionId: ETS2_A, fromEventSeq: '22', throughEventSeq: '24', end: 'close-gap'}, ['22', '23', '24']],
    ['a restart from session B ends it at the end of session A', T.restartClosed,
      {known: true, pluginSessionId: ETS2_A, fromEventSeq: '28', throughEventSeq: null, end: 'end-of-session'}, ['28', '29']],
    ['an open trip has no end', T.open, {known: true, pluginSessionId: ETS2_B, fromEventSeq: '1', throughEventSeq: null, end: 'open'}, ['1', '2', '3']],
    ['an ATS trip reads only its own session', T.zeroValues, {known: true, pluginSessionId: ATS_A, fromEventSeq: '3', throughEventSeq: '4', end: 'close-event'}, ['3', '4']],
    ['a migrated version 1 trip lists only its attributed and referenced events', MIGRATED_V1_TRIP, {known: false, pluginSessionId: MIGRATED_V1_SESSION}, ['1', '2', '3', '6']]
  ])('%s', (_name, tripUuid, window, seqs) => {
    const page = ok(storage.journalEvents(tripUuid, {limit: 100}));
    expect(page.database).toEqual(DATABASE);
    expect(page.window).toEqual(window);
    expect(page.events.map(event => event.eventSeq)).toEqual(seqs);
    expect(page.nextCursor).toBeNull();
    expect(ok(storage.journalTrip(tripUuid)).window).toEqual(window);
  });
  it('carries the stored record, occurrence and attribution of each event', () => {
    const events = ok(storage.journalEvents(T.delivered, {limit: 100})).events;
    expect(events.map(event => [event.eventSeq, event.type, event.attribution])).toEqual([
      ['4', 'job.configured', null], ['5', 'player.fined', {kind: 'trip', tripUuid: T.delivered}], ['6', 'player.tollgate.paid', {kind: 'trip', tripUuid: T.delivered}],
      ['7', 'player.use.ferry', {kind: 'trip', tripUuid: T.delivered}], ['8', 'player.fined', {kind: 'trip', tripUuid: T.delivered}],
      ['9', 'job.delivered', {kind: 'trip', tripUuid: T.delivered}]]);
    expect(events[1]).toEqual({eventSeq: '5', type: 'player.fined', record: {type: 'player.fined', offence: text('crash'), amount: money('400', 's64', EUR)},
      occurred: {monotonicNs: {available: true, value: '1004999000000'}, gameTime: {minutes: text('12345'), clockId: '40000000-0000-4000-8000-000000000001'},
        utcUnixMs: text(String(BASE_UTC + 5_000)), simulation: 'running', configurationRevision: '1', boundaryOrder: '6'},
      attribution: {kind: 'trip', tripUuid: T.delivered}});
    expect(ok(storage.journalEvents(T.differentJob, {limit: 100})).events.at(-1)).toMatchObject({eventSeq: '22', type: 'job.configured', attribution: null});
    expect(ok(storage.journalEvents(MIGRATED_V1_TRIP, {limit: 100})).events.map(event => event.attribution)).toEqual([
      null, {kind: 'trip', tripUuid: MIGRATED_V1_TRIP}, {kind: 'trip-before-loaded', tripUuid: MIGRATED_V1_TRIP}, {kind: 'trip', tripUuid: MIGRATED_V1_TRIP}]);
  });
  it('continues after a cursor inside the window', () => {
    expect(eventSeqs(T.delivered, '6')).toEqual(['7', '8', '9']);
    expect(eventSeqs(T.delivered, '9')).toEqual([]);
    expect(eventSeqs(T.delivered, '1')).toEqual(['4', '5', '6', '7', '8', '9']);
    expect(eventSeqs(MIGRATED_V1_TRIP, '2')).toEqual(['3', '6']);
  });
});

describe('journal samples and bounds (J5)', () => {
  it('pages the 650 samples of a trip 300 at a time through listSamples', () => {
    const detail = ok(storage.journalTrip(T.manySamples));
    expect(detail.samples).toEqual({count: 650, firstUtcMs: SESSION_C_UTC + 6_000, lastUtcMs: SESSION_C_UTC + 655_000});
    expect(detail.exportBounds.lastSampleId).toBe('660');
    const pages: number[] = [], ids: string[] = [];
    let afterId: string | undefined;
    for (let round = 0; round < 100; round++) {
      const rows = ok(storage.listSamples({tripUuid: T.manySamples}, {limit: 300, afterId}));
      pages.push(rows.length); ids.push(...rows.map(row => row.id));
      if (rows.length < 300) break;
      afterId = rows.at(-1)!.id;
    }
    expect(pages).toEqual([300, 300, 50]);
    expect(ids).toEqual(Array.from({length: 650}, (_, i) => String(11 + i)));
  });
  it.each<[string, () => unknown]>([
    ['a trip cursor of 0', () => storage.journalTrips({cursor: '0'})],
    ['a trip cursor with a sign', () => storage.journalTrips({cursor: '-1'})],
    ['a trip cursor with a leading zero', () => storage.journalTrips({cursor: '01'})],
    ['a trip cursor above 2^63 - 1', () => storage.journalTrips({cursor: '9223372036854775808'})],
    ['a numeric trip cursor', () => storage.journalTrips({cursor: 5 as unknown as string})],
    ['a page size: the trip page is fixed at 50', () => storage.journalTrips({limit: 51} as unknown as JournalTripsQuery)],
    ['an unknown game', () => storage.journalTrips({game: 'ETS2' as 'ets2'})],
    ['an unknown outcome', () => storage.journalTrips({outcome: 'closed' as 'open'})],
    ['an unknown completeness', () => storage.journalTrips({completeness: 'full' as 'complete'})],
    ['a query that is not an object', () => storage.journalTrips(null as unknown as JournalTripsQuery)],
    ['an event page of 51', () => storage.journalEvents(T.delivered, {limit: 51})],
    ['an event page of 101', () => storage.journalEvents(T.delivered, {limit: 101})],
    ['an event page of 3,600', () => storage.journalEvents(T.delivered, {limit: 3_600})],
    ['an event page without a limit', () => storage.journalEvents(T.delivered, {} as {limit: number})],
    ['an event cursor of 0', () => storage.journalEvents(T.delivered, {limit: 100, cursor: '0'})],
    ['an event cursor above the last eventSeq', () => storage.journalEvents(T.delivered, {limit: 100, cursor: '18446744073709551615'})],
    ['an event page with an unknown key', () => storage.journalEvents(T.delivered, {limit: 100, after: '4'} as {limit: number})],
    ['an interval page of 50', () => storage.journalIntervals(T.gapClosed, {limit: 50})],
    ['an interval page of 300', () => storage.journalIntervals(T.gapClosed, {limit: 300})],
    ['an interval cursor of 0', () => storage.journalIntervals(T.gapClosed, {limit: 100, cursor: '0'})],
    ['an interval page that is not an object', () => storage.journalIntervals(T.gapClosed, 100 as unknown as {limit: number})]
  ])('refuses %s with INVALID_INPUT', (_name, read) => {
    failed(read() as Parameters<typeof failed>[0], 'INVALID_INPUT');
  });
});

describe('journal reads of the version 2 fixture (S-1, J7)', () => {
  it('reads fuel used as a value, zero or unavailable, and the close carriers of an outcome, a gap and a restart', async () => {
    const fixture = await workspace();
    try {
      fixture.copyFixture('schema-v2-representative.sqlite', fixture.database);
      const v2 = await fixture.open();
      const [s1, s2] = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
      const trip = (n: number) => `70000000-0000-4000-8000-00000000000${n}`;
      expect(ok(v2.journalTrips()).trips.map(t => [t.tripUuid, t.fuelUsedL])).toEqual([
        [trip(4), {available: false, reason: 'not-supported'}], [trip(3), {available: true, value: 0}], [trip(2), NOT_OBSERVED], [trip(1), {available: true, value: 42.5}]]);
      const read = (n: number) => { const d = ok(v2.journalTrip(trip(n))); return {closedBy: d.trip.closedBy, window: d.window}; };
      expect(read(1)).toEqual({closedBy: {pluginSessionId: s1, eventSeq: '2'}, window: {known: true, pluginSessionId: s1, fromEventSeq: '1', throughEventSeq: '2', end: 'close-event'}});
      // eventSeq 4 has no event row: the gap closed the trip, so the window ends at 3.
      expect(read(2)).toEqual({closedBy: {pluginSessionId: s1, eventSeq: '4'}, window: {known: true, pluginSessionId: s1, fromEventSeq: '3', throughEventSeq: '3', end: 'close-gap'}});
      expect(read(3)).toEqual({closedBy: {pluginSessionId: s2, eventSeq: '1'}, window: {known: true, pluginSessionId: s1, fromEventSeq: '6', throughEventSeq: null, end: 'end-of-session'}});
      expect(read(4)).toEqual({closedBy: null, window: {known: true, pluginSessionId: s2, fromEventSeq: '1', throughEventSeq: null, end: 'open'}});
      expect(ok(v2.journalEvents(trip(3), {limit: 100})).events.map(e => e.eventSeq)).toEqual(['6']);
      expect(ok(v2.journalTrip(trip(4))).intervals.items.map(i => [i.kind, i.cause, i.annotation])).toEqual([['discontinuity', 'restart', false]]);
    } finally { await fixture.dispose(); }
  });
});

describe('a trip opened from a checkpoint (schema version 2, J7; written only from ET-016b PR-7 on)', () => {
  it('reads it with no opening event, its checkpoint job and a window from the checkpoint\'s nextEventSeq', async () => {
    const cp = await workspace();
    try {
      let st = await cp.open();
      await seedJournalAnchors(st);
      st.close();
      // No write command produces such a trip before ET-016b PR-7, so it is inserted directly: a checkpoint job of
      // session B at nextEventSeq 2 with the open anchor's job values, and an open trip opened by that checkpoint.
      const tripUuid = '7c000000-0000-4000-8000-000000000001';
      const db = new Database(cp.database);
      try {
        const columns = (db.prepare('SELECT name FROM pragma_table_info(\'job_configurations\')').pluck().all() as string[])
          .filter(name => !['id', 'source', 'event_ref', 'checkpoint_next_event_seq'].includes(name));
        const job = db.prepare(`INSERT INTO job_configurations (source, event_ref, checkpoint_next_event_seq, ${columns.join(', ')})
          SELECT 'checkpoint', NULL, '00000000000000000002', ${columns.map(name => `j.${name}`).join(', ')} FROM job_configurations j JOIN events e ON e.id = j.event_ref
          JOIN plugin_sessions s ON s.id = e.plugin_session_id WHERE s.plugin_session_uuid = ? AND e.event_seq = '00000000000000000001'`).run(ETS2_B).lastInsertRowid;
        db.prepare(`INSERT INTO trips (trip_uuid, plugin_session_ref, game, game_mode, game_mode_method, game_mode_confidence, job_configuration_ref, opened_event_ref, opened_by,
          outcome, recording_completeness, started_utc_ms, observed_distance_m_state, created_utc_ms, updated_utc_ms)
          SELECT ?, id, 'ets2', 'unknown', 'none', 'none', ?, NULL, 'checkpoint', 'open', 'partial', ?, 'not-observed', ?, ? FROM plugin_sessions WHERE plugin_session_uuid = ?`)
          .run(tripUuid, job, SESSION_B_UTC + 1_500, SESSION_B_UTC + 1_500, SESSION_B_UTC + 1_500, ETS2_B);
      } finally { db.close(); }
      st = await cp.open();
      const listed = ok(st.journalTrips()).trips[0];
      expect(listed).toMatchObject({tripUuid, outcome: 'open', recordingCompleteness: 'partial', job: {source: 'checkpoint', cargo: text('Synthetic Cargo')}});
      const detail = ok(st.journalTrip(tripUuid));
      // The answer passes the same contract check the storage client applies.
      expect(validateJournalTripDetail(detail)).toBe(detail);
      expect(detail.trip).toMatchObject({openedBy: 'checkpoint', openedEventSeq: null, outcomeEventSeq: null, closedBy: null, pluginSessionId: ETS2_B});
      expect(detail.job).toEqual({source: 'checkpoint', eventSeq: null, checkpointNextEventSeq: '2', values: ANCHOR_JOBS.open});
      expect([detail.truck, detail.trailers, detail.outcomeDetails]).toEqual([null, {items: [], total: 0}, null]);
      const window = {known: true, pluginSessionId: ETS2_B, fromEventSeq: '2', throughEventSeq: null, end: 'open'};
      expect(detail.window).toEqual(window);
      const events = ok(st.journalEvents(tripUuid, {limit: 100}));
      expect(events.window).toEqual(window);
      expect(events.events.map(event => [event.eventSeq, event.attribution])).toEqual([['2', {kind: 'trip', tripUuid: T.open}], ['3', null]]);
      expect(ok(st.journalIntervals(tripUuid, {limit: 100}))).toMatchObject({intervals: [], total: 0, nextCursor: null});
    } finally { await cp.dispose(); }
  });
});

describe('a trip with more than 5,000 money amounts and more than 100 intervals (J5; REG-014)', () => {
  it('pages its events and intervals with cursors and marks its money totals incomplete beyond 5,000 amounts', async () => {
    const big = await workspace();
    try {
      const st = await big.open(), s = new Script(ETS2_A), trip = '7b000000-0000-4000-8000-000000000001';
      ok(st.upsertSession({message: s.welcome()}));
      const commit = (record: Parameters<Script['event']>[0], effects: TripEffect[]) => expect(ok(st.commitEvent({message: s.event(record), effects})).status).toBe('committed');
      commit(r.jobConfigured(), [{kind: 'trip.open', tripUuid: trip, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event',
        recordingCompleteness: 'unknown', startedUtcMs: BASE_UTC}]);
      for (let i = 1; i <= 5_000; i++) {
        commit(r.fined('2'), [{kind: 'event.attribute', tripUuid: trip, attribution: 'trip'},
          ...(i <= 120 ? [{kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss', detail: {cause: 'reading-hole', holes: i}}} as TripEffect] : [])]);
      }
      expect(ok(st.journalTrip(trip)).money).toEqual({incomplete: false, unavailable: [], totals: [{category: 'fine', sdkType: 's64', currency: EUR, raw: '10000', count: 5_000}]});
      commit(r.fined('3'), [{kind: 'event.attribute', tripUuid: trip, attribution: 'trip'}]);
      const detail = ok(st.journalTrip(trip));
      expect(detail.money).toEqual({incomplete: true, totals: [], unavailable: []});
      // The first 50 intervals, the total and the cursor of the next page.
      expect(detail.intervals.items.map(i => i.id)).toEqual(Array.from({length: JOURNAL_DETAIL_INTERVALS}, (_, i) => String(i + 1)));
      expect(detail.intervals).toMatchObject({total: 120, nextCursor: '50'});
      expect(ok(st.journalIntervals(trip, {limit: 100, cursor: '50'}))).toMatchObject({total: 120, nextCursor: null});
      expect(ok(st.journalIntervals(trip, {limit: 100, cursor: '50'})).intervals.map(i => i.id)).toEqual(Array.from({length: 70}, (_, i) => String(i + 51)));
      const first = ok(st.journalIntervals(trip, {limit: 100}));
      expect([first.intervals.length, first.nextCursor]).toEqual([100, '100']);
      expect(ok(st.journalIntervals(trip, {limit: 100, cursor: first.nextCursor!})).intervals).toHaveLength(20);
      // 5,002 events in the open window: ten full export pages with cursors, then two events and no cursor.
      const seen: string[] = [], sizes: number[] = [];
      let cursor: string | undefined;
      for (let round = 0; round < 100; round++) {
        const page = ok(st.journalEvents(trip, {limit: 500, cursor}));
        sizes.push(page.events.length); seen.push(...page.events.map(e => e.eventSeq));
        if (page.events.length === 500) expect(page.nextCursor).toBe(page.events.at(-1)!.eventSeq); else expect(page.nextCursor).toBeNull();
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(sizes).toEqual([...Array(10).fill(500), 2]);
      expect(seen).toEqual(Array.from({length: 5_002}, (_, i) => String(i + 1)));
      const ui = ok(st.journalEvents(trip, {limit: 100}));
      expect([ui.events.length, ui.nextCursor, ui.events[0].eventSeq]).toEqual([100, '100', '1']);
    } finally { await big.dispose(); }
  }, 240_000);
});
