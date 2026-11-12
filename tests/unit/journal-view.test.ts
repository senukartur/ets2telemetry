import {journalCompletenessText, journalPageBound, journalPageSync, journalSiteFacts, journalSiteRow, journalSiteSaved, journalSyncOwnerCurrent, journalTimelineItems, journalTripSideText} from '../../apps/desktop/src/journal-view';
import {initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {journalTileValues} from '../../apps/desktop/src/screens/journal-tiles';
import {describe, expect, it} from 'vitest';
import type {
  JournalCallCode, JournalEvent, JournalEventPage, JournalInterval, JournalIntervalPage, JournalSample, JournalSamplePage, JournalStorageCode, JournalTripDetail,
  JournalTripListItem, JournalTripPage, UnitProfiles
} from '../../packages/contracts/src';
import type {EventRecord} from '../../packages/contracts/src/protocol-v1';
import {
  journalBannerText, journalDetailText, journalErrorText, journalEventText, journalIntervalText, journalListText, journalRangeText, journalSampleText, journalTotalsText, type JournalSection
} from '../../apps/desktop/src/journal-view';
import {ANCHOR_JOBS, CHANGED_TRUCK, EUR, JOURNAL_TRIPS as T, MIGRATED_V1_SESSION, MIGRATED_V1_TRIP, UNKNOWN_CURRENCY, USD, ZERO_DELIVERY} from '../shared/journal-seed';
import {BASE_UTC, ETS2_A, ETS2_B, ATS_A, job, money, trailer, truck} from '../shared/trip-messages';

// ET-016 PR-4 (J12-J14): the journal's display text. Every expected text below is written by hand from J13/J14, the
// anchor trips of tests/shared/journal-seed.ts and the unit conversions of docs/live-telemetry-fields.md; none is read
// back from journal-view.ts. Times use the fixed zone Europe/Berlin (UTC+2 on 2026-10-11), so a UTC label shows as its
// local clock time; BASE_UTC is 2026-10-11T00:00:00Z.
const ZONE = 'Europe/Berlin';
/** ET-000 defaults: ETS2 metric, ATS US customary. */
const DEFAULT: UnitProfiles = {ets2: 'metric', ats: 'us-customary'};
/** The other profile of each game. */
const SWAPPED: UnitProfiles = {ets2: 'us-customary', ats: 'metric'};
const DATABASE = {purpose: 'synthetic', schemaVersion: 2} as const;
const NO = {available: false, reason: 'not-observed'} as const;
const value = <T>(v: T) => ({available: true as const, value: v});
const MODE = {mode: 'single-player', method: 'module-scan', confidence: 'weak'} as const;
const CLOCK = '2c000000-0000-4000-8000-00000000000a';
/** The job market badge of every anchor: the shared fixture job is a freight market job (ET-072). */
const FREIGHT_BADGE = {kind: 'freight-market', text: 'Freight market'} as const;
/** The Job type column of every anchor's list row (ET-076). */
const FREIGHT_LINE = {...FREIGHT_BADGE, sub: null} as const;

function summary(job: typeof ANCHOR_JOBS.delivered): JournalTripListItem['job'] {
  return {source: 'event', sourceCity: job.sourceCity, sourceCompany: job.sourceCompany, destinationCity: job.destinationCity, destinationCompany: job.destinationCompany,
    cargo: job.cargo, market: job.market, isSpecialJob: job.isSpecialJob, plannedDistance: job.plannedDistance, expectedIncome: job.expectedIncome};
}
// The delivered anchor: ETS2 session A, opened at A4, delivered at A9 with fines, a toll and a ferry in EUR.
const DELIVERED: JournalTripListItem = {isHardMode: false, hardModeDetails: null, tripUuid: T.delivered, game: 'ets2', gameMode: MODE, gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome',
  recordingCompleteness: 'complete', startedUtcMs: BASE_UTC + 4_000, endedUtcMs: BASE_UTC + 9_000, observedDistanceM: value(152_000.5), fuelUsedL: NO,
  job: summary(ANCHOR_JOBS.delivered)};
const DELIVERED_RECORD = {type: 'job.delivered', revenue: money('15000', 's64', EUR), earnedXp: value(250), cargoDamage: {available: true, value: 0.0125, unit: 'fraction'},
  distance: {available: true, value: 151_250.5, unit: 'm'}, deliveryDuration: {available: true, value: '471', unit: 'min'}, autoParkUsed: value(false), autoLoadUsed: value(true)} as const;
const DELIVERED_DETAIL: JournalTripDetail = {database: DATABASE,
  trip: {...DELIVERED, pluginSessionId: ETS2_A, openedBy: 'event', openedEventSeq: '4', outcomeEventSeq: '9', closedBy: {pluginSessionId: ETS2_A, eventSeq: '9'}},
  job: {source: 'event', eventSeq: '4', checkpointNextEventSeq: null, values: ANCHOR_JOBS.delivered}, truck: {eventSeq: '1', values: truck()},
  trailers: {items: [{eventSeq: '2', values: trailer(0)}], total: 1}, outcomeDetails: {eventSeq: '9', record: DELIVERED_RECORD},
  money: {incomplete: false, totals: [
    {category: 'fine', sdkType: 's64', currency: EUR, raw: '401', count: 2}, {category: 'toll', sdkType: 's64', currency: EUR, raw: '35', count: 1},
    {category: 'ferry', sdkType: 's64', currency: EUR, raw: '677', count: 1}], unavailable: []},
  window: {known: true, pluginSessionId: ETS2_A, fromEventSeq: '4', throughEventSeq: '9', end: 'close-event'},
  intervals: {items: [], total: 0, nextCursor: null}, samples: {count: 3, firstUtcMs: BASE_UTC + 5_000, lastUtcMs: BASE_UTC + 8_000},
  exportBounds: {committedThroughEventSeq: '29', lastSampleId: '4', lastIntervalId: null}};
// The zero-values anchor: ATS session C, delivered, with zero values and unavailable values side by side (REG-009).
const ZERO: JournalTripListItem = {isHardMode: false, hardModeDetails: null, tripUuid: T.zeroValues, game: 'ats', gameMode: MODE, gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome',
  recordingCompleteness: 'complete', startedUtcMs: BASE_UTC + 203_000, endedUtcMs: BASE_UTC + 204_000, observedDistanceM: value(0), fuelUsedL: value(0),
  job: summary(ANCHOR_JOBS.zeroValues)};
const ZERO_DETAIL: JournalTripDetail = {...DELIVERED_DETAIL,
  trip: {...ZERO, pluginSessionId: ATS_A, openedBy: 'event', openedEventSeq: '3', outcomeEventSeq: '4', closedBy: {pluginSessionId: ATS_A, eventSeq: '4'}},
  job: {source: 'event', eventSeq: '3', checkpointNextEventSeq: null, values: ANCHOR_JOBS.zeroValues}, outcomeDetails: {eventSeq: '4', record: ZERO_DELIVERY},
  money: {incomplete: false, totals: [], unavailable: []}, window: {known: true, pluginSessionId: ATS_A, fromEventSeq: '3', throughEventSeq: '4', end: 'close-event'},
  samples: {count: 1, firstUtcMs: BASE_UTC + 203_500, lastUtcMs: BASE_UTC + 203_500}};
// The cancelled anchor: EUR fines beyond 2^53 with a negative fine, a fine of unknown currency, a USD toll and an unavailable toll.
const CANCELLED: JournalTripListItem = {...DELIVERED, tripUuid: T.cancelled, outcome: 'cancelled', startedUtcMs: BASE_UTC + 12_000, endedUtcMs: BASE_UTC + 19_000,
  observedDistanceM: NO, job: summary(ANCHOR_JOBS.cancelled)};
const CANCELLED_DETAIL: JournalTripDetail = {...DELIVERED_DETAIL,
  trip: {...CANCELLED, pluginSessionId: ETS2_A, openedBy: 'event', openedEventSeq: '12', outcomeEventSeq: '19', closedBy: {pluginSessionId: ETS2_A, eventSeq: '19'}},
  job: {source: 'event', eventSeq: '12', checkpointNextEventSeq: null, values: ANCHOR_JOBS.cancelled},
  outcomeDetails: {eventSeq: '19', record: {type: 'job.cancelled', penalty: money('12000', 's64', EUR)}},
  money: {incomplete: false, totals: [
    {category: 'fine', sdkType: 's64', currency: EUR, raw: '9007199254741238', count: 3}, {category: 'fine', sdkType: 's64', currency: UNKNOWN_CURRENCY, raw: '50', count: 1},
    {category: 'toll', sdkType: 's64', currency: USD, raw: '20', count: 1}], unavailable: [{category: 'toll', reason: 'not-observed', count: 1}]}};
// The gap-closed anchor: partial, closed by the gap 25-26, with a truck-change annotation and sample-loss and event-loss intervals.
const GAP_CLOSED: JournalTripListItem = {...DELIVERED, tripUuid: T.gapClosed, outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial',
  startedUtcMs: BASE_UTC + 22_000, endedUtcMs: BASE_UTC + 24_000, observedDistanceM: NO, job: summary(ANCHOR_JOBS.gapClosed)};
const GAP_DETAIL: JournalTripDetail = {...DELIVERED_DETAIL,
  trip: {...GAP_CLOSED, pluginSessionId: ETS2_A, openedBy: 'event', openedEventSeq: '22', outcomeEventSeq: null, closedBy: {pluginSessionId: ETS2_A, eventSeq: '25'}},
  job: {source: 'event', eventSeq: '22', checkpointNextEventSeq: null, values: ANCHOR_JOBS.gapClosed}, truck: {eventSeq: '23', values: CHANGED_TRUCK},
  trailers: {items: [], total: 0}, outcomeDetails: null, money: {incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: EUR, raw: '70', count: 1}], unavailable: []},
  window: {known: true, pluginSessionId: ETS2_A, fromEventSeq: '22', throughEventSeq: '24', end: 'close-gap'}, samples: {count: 0, firstUtcMs: null, lastUtcMs: null}};
// The open anchor: ETS2 session B, opened at B1 without a truck or trailer.
const OPEN: JournalTripListItem = {...DELIVERED, tripUuid: T.open, outcome: 'open', closeReason: null, recordingCompleteness: 'unknown', startedUtcMs: BASE_UTC + 101_000,
  endedUtcMs: null, observedDistanceM: NO, job: summary(ANCHOR_JOBS.open)};
const OPEN_DETAIL: JournalTripDetail = {...DELIVERED_DETAIL,
  trip: {...OPEN, pluginSessionId: ETS2_B, openedBy: 'event', openedEventSeq: '1', outcomeEventSeq: null, closedBy: null},
  job: {source: 'event', eventSeq: '1', checkpointNextEventSeq: null, values: ANCHOR_JOBS.open}, truck: null, trailers: {items: [], total: 0}, outcomeDetails: null,
  money: {incomplete: false, totals: [{category: 'toll', sdkType: 's64', currency: EUR, raw: '5', count: 1}], unavailable: []},
  window: {known: true, pluginSessionId: ETS2_B, fromEventSeq: '1', throughEventSeq: null, end: 'open'}, samples: {count: 2, firstUtcMs: BASE_UTC + 101_500, lastUtcMs: BASE_UTC + 102_500}};

const fields = (sections: JournalSection[], id: string) => Object.fromEntries((sections.find(s => s.id === id)?.fields ?? []).map(f => [f.id, f.note ? `${f.value} [${f.note}]` : f.value]));
const notes = (sections: JournalSection[], id: string) => sections.find(s => s.id === id)?.notes;

describe('journal list (J13; REG-014, REG-009)', () => {
  const page = (trips: JournalTripListItem[], nextCursor: string | null = null): JournalTripPage => ({database: DATABASE, trips, nextCursor});
  it('shows each anchor row in its own game profile, with outcome and recording completeness apart', () => {
    const text = journalListText(page([OPEN, ZERO, GAP_CLOSED, CANCELLED, DELIVERED], '42'), {units: DEFAULT, timeZone: ZONE, filtered: false, recording: 'disabled'});
    expect(text.empty).toBeNull(); expect(text.emptyNote).toBeNull(); expect(text.hasNext).toBe(true);
    expect(text.rows).toEqual([
      {mode: {kind: 'single-player', text: 'Single-player', evidence: 'Single-player', tone: 'neutral'}, jobType: FREIGHT_LINE, specialTransport: null, isHardMode: false, tripUuid: T.open, gameId: 'ets2', started: '2026-10-11 02:01:41', game: 'ETS2', route: 'Synthetic City A → Synthetic City B', cargo: 'Synthetic Cargo', companies: 'Synthetic Company A · Synthetic Company B', outcome: 'In progress', outcomeKind: 'open',
        completeness: {text: 'Unknown', variant: 'outline'}, plannedDistance: '152.0 km', plannedOf: 'of 152.0 km', observedDistance: 'unavailable (not observed)',
        expectedIncome: '12345 (currency unknown)'},
      {mode: {kind: 'single-player', text: 'Single-player', evidence: 'Single-player', tone: 'neutral'}, jobType: FREIGHT_LINE, specialTransport: null, isHardMode: false, tripUuid: T.zeroValues, gameId: 'ats', started: '2026-10-11 02:03:23', game: 'ATS', route: '(empty) → unavailable (not provided by the game)', cargo: 'unavailable (not observed)', companies: 'Synthetic Company A · Synthetic Company B',
        outcome: 'Delivered', outcomeKind: 'delivered', completeness: {text: 'Complete', variant: 'secondary'}, plannedDistance: '0.0 mi', plannedOf: 'of 0.0 mi', observedDistance: '0.0 mi',
        expectedIncome: '0 USD (SDK-documented)'},
      {mode: {kind: 'single-player', text: 'Single-player', evidence: 'Single-player', tone: 'neutral'}, jobType: FREIGHT_LINE, specialTransport: null, isHardMode: false, tripUuid: T.gapClosed, gameId: 'ets2', started: '2026-10-11 02:00:22', game: 'ETS2', route: 'Synthetic City A → Synthetic City B', cargo: 'Synthetic Cargo', companies: 'Synthetic Company A · Synthetic Company B',
        outcome: 'No outcome — events were lost', outcomeKind: 'none', completeness: {text: 'Partial', variant: 'destructive'}, plannedDistance: '152.0 km', plannedOf: 'of 152.0 km', observedDistance: 'unavailable (not observed)',
        expectedIncome: '12345 (currency unknown)'},
      {mode: {kind: 'single-player', text: 'Single-player', evidence: 'Single-player', tone: 'neutral'}, jobType: FREIGHT_LINE, specialTransport: null, isHardMode: false, tripUuid: T.cancelled, gameId: 'ets2', started: '2026-10-11 02:00:12', game: 'ETS2', route: 'Synthetic City A → Synthetic City B', cargo: 'Synthetic Cancel Cargo', companies: 'Synthetic Company A · Synthetic Company B',
        outcome: 'Cancelled', outcomeKind: 'cancelled', completeness: {text: 'Complete', variant: 'secondary'}, plannedDistance: '152.0 km', plannedOf: 'of 152.0 km', observedDistance: 'unavailable (not observed)',
        expectedIncome: '12345 (currency unknown)'},
      {mode: {kind: 'single-player', text: 'Single-player', evidence: 'Single-player', tone: 'neutral'}, jobType: FREIGHT_LINE, specialTransport: null, isHardMode: false, tripUuid: T.delivered, gameId: 'ets2', started: '2026-10-11 02:00:04', game: 'ETS2', route: 'Synthetic City A → Synthetic City B', cargo: 'Synthetic Cargo', companies: 'Synthetic Company A · Synthetic Company B',
        outcome: 'Delivered', outcomeKind: 'delivered', completeness: {text: 'Complete', variant: 'secondary'}, plannedDistance: '152.0 km', plannedOf: 'of 152.0 km', observedDistance: '152.0 km',
        expectedIncome: '12345 (currency unknown)'}
    ]);
  });
  it('converts with the other profile of each game', () => {
    const text = journalListText(page([ZERO, DELIVERED]), {units: SWAPPED, timeZone: ZONE, filtered: false});
    expect(text.rows.map(row => [row.plannedDistance, row.observedDistance])).toEqual([['0.0 km', '0.0 km'], ['94.4 mi', '94.4 mi']]);
    expect(text.hasNext).toBe(false);
  });
  it('without settings uses the ET-000 defaults', () => {
    expect(journalListText(page([ZERO]), {filtered: false}).rows[0].plannedDistance).toBe('0.0 mi');
  });
  it('says an empty history is empty and that game recording is off in this version', () => {
    expect(journalListText(page([]), {filtered: false, recording: 'disabled'})).toEqual({rows: [], empty: 'No trips recorded',
      emptyNote: 'Game history recording is off in this version, so no game trips are recorded yet.', hasNext: false});
    expect(journalListText(page([]), {filtered: false, recording: 'recording'})).toMatchObject({empty: 'No trips recorded', emptyNote: null});
    expect(journalListText(page([]), {filtered: true, recording: 'disabled'})).toMatchObject({empty: 'No trips match these filters', emptyNote: null});
  });
  it('says only that no more trips follow on an empty later page, with or without filters (review round 1)', () => {
    // A full page always has a next cursor, so exactly 50 trips give an empty page 2.
    expect(journalListText(page([]), {filtered: false, recording: 'disabled', firstPage: false})).toEqual({rows: [], empty: 'No more trips.', emptyNote: null, hasNext: false});
    expect(journalListText(page([]), {filtered: true, recording: 'disabled', firstPage: false})).toEqual({rows: [], empty: 'No more trips.', emptyNote: null, hasNext: false});
    expect(journalListText(page([]), {filtered: false, recording: 'disabled', firstPage: true})).toMatchObject({empty: 'No trips recorded'});
  });
  it('shows a UTC label outside the Date range as an invalid reading instead of throwing (review round 1)', () => {
    const row = journalListText(page([{...DELIVERED, startedUtcMs: 8_640_000_000_000_001, endedUtcMs: 9_007_199_254_740_991}]), {timeZone: ZONE, filtered: false}).rows[0];
    expect(row.started).toBe('unavailable (invalid reading)');
    const detail = journalDetailText({...DELIVERED_DETAIL, trip: {...DELIVERED_DETAIL.trip, startedUtcMs: 8_640_000_000_000_001, endedUtcMs: 9_007_199_254_740_991}}, {timeZone: ZONE});
    expect(fields(detail.sections, 'trip')).toMatchObject({started: 'unavailable (invalid reading)', ended: 'unavailable (invalid reading)'});
  });
  it('names every close reason of a trip without an outcome', () => {
    const reasons = (['configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap'] as const).map(closeReason =>
      journalListText(page([{...GAP_CLOSED, closeReason}]), {filtered: false}).rows[0].outcome);
    expect(reasons).toEqual(['No outcome — job cleared', 'No outcome — a different job started', 'No outcome — the game or plugin restarted',
      'No outcome — a loaded save or game time change', 'No outcome — events were lost']);
  });
});

describe('test database banner and refusal codes (J3, J11)', () => {
  it('shows a persistent banner for every database that is not history', () => {
    expect(journalBannerText({purpose: 'synthetic', schemaVersion: 2})).toBe('Synthetic test database — never game history');
    expect(journalBannerText({purpose: 'replay', schemaVersion: 2})).toBe('Replay test database — never game history');
    expect(journalBannerText({purpose: 'history', schemaVersion: 2})).toBeNull();
    expect(journalBannerText(undefined)).toBeNull();
  });
  it('turns every refusal code into fixed text without storage error text', () => {
    const codes: [Exclude<JournalCallCode, 'DATABASE_UNAVAILABLE'>, string][] = [
      ['SERVICE_UNAVAILABLE', 'The telemetry service is not available right now. Try again when it is ready.'],
      ['DATABASE_OPENING', 'The database is still opening. Try again in a moment.'], ['BUSY', 'The journal is busy with other requests. Try again.'],
      ['TIMEOUT', 'The journal did not answer in time. Try again.'], ['NOT_FOUND', 'This trip is not in the database.'], ['FAILED', 'The journal could not be read.']];
    for (const [code, text] of codes) expect(journalErrorText({ok: false, code})).toBe(text);
    const storage: [JournalStorageCode, string][] = [['PERMISSION_DENIED', 'The database is unavailable: no permission to write the database.'],
      ['SCHEMA_NEWER', 'The database is unavailable: the database was written by a newer version.'], ['TIMEOUT', 'The database is unavailable: storage did not answer in time.']];
    for (const [storageCode, text] of storage) expect(journalErrorText({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode})).toBe(text);
  });
});

describe('trip detail (J13, J21, J22; REG-014, REG-009)', () => {
  it('shows the delivered anchor in metric', () => {
    const text = journalDetailText(DELIVERED_DETAIL, {units: DEFAULT, timeZone: ZONE});
    expect({title: text.title, outcome: text.outcome, completeness: text.completeness}).toEqual({title: 'ETS2: Synthetic City A → Synthetic City B', outcome: 'Delivered',
      completeness: {text: 'Complete', variant: 'secondary'}});
    expect({jobType: text.jobType, specialTransport: text.specialTransport}).toEqual({jobType: FREIGHT_BADGE, specialTransport: null});
    expect(text.sections.map(s => s.id)).toEqual(['trip', 'distance', 'fuel', 'money', 'job', 'delivery', 'truck', 'trailers', 'samples']);
    expect(fields(text.sections, 'trip')).toEqual({game: 'Euro Truck Simulator 2', gameMode: 'Single-player', outcome: 'Delivered',
      completeness: 'Complete', started: '2026-10-11 02:00:04', ended: '2026-10-11 02:00:09', openedBy: 'job event 4', session: ETS2_A, tripId: T.delivered});
    expect(notes(text.sections, 'trip')).toEqual(['Times are the recorded UTC labels shown in local time.']);
    expect(fields(text.sections, 'distance')).toEqual({plannedDistance: '152.0 km [job offer, excludes ferries]', observedDistance: '152.0 km [odometer while recording]',
      deliveredDistance: '151.3 km [reported by the game]'});
    expect(fields(text.sections, 'fuel')).toEqual({fuelUsed: 'unavailable (not observed) [while recording, refuels excluded]'});
    expect(fields(text.sections, 'money')).toEqual({expectedIncome: '12345 (currency unknown) [job offer]', revenue: '15000 EUR (SDK-documented) [reported by the game]',
      fine: '401 EUR (SDK-documented), 2 amounts', toll: '35 EUR (SDK-documented), 1 amount', ferry: '677 EUR (SDK-documented), 1 amount', train: 'none recorded'});
    expect(notes(text.sections, 'money')).toEqual(['Amounts are the exact game values. They are never converted, netted or added across currencies.']);
    expect(fields(text.sections, 'job')).toEqual({sourceCity: 'Synthetic City A', sourceCompany: 'Synthetic Company A', destinationCity: 'Synthetic City B',
      destinationCompany: 'Synthetic Company B', cargo: 'Synthetic Cargo', cargoMass: '18.0 t', market: 'Freight market', specialJob: 'no', cargoLoaded: 'yes',
      deadline: 'Day 10, 00:40 [game time]', jobSource: 'job event 4'});
    expect(fields(text.sections, 'delivery')).toEqual({earnedXp: '250', cargoDamage: '1%', deliveryDuration: '7 h 51 min [game time]', autoPark: 'no', autoLoad: 'yes'});
    expect(fields(text.sections, 'truck')).toEqual({brand: 'Synthetic Brand', model: 'Synthetic Truck', licensePlate: 'SYN 0001', plateCountry: 'Synthetica', fuelCapacity: '1000.0 L'});
    expect(fields(text.sections, 'trailers')).toEqual({'trailer-0-brand': 'unavailable (not observed)', 'trailer-0-model': 'unavailable (not observed)',
      'trailer-0-body': 'dryvan', 'trailer-0-plate': 'SYN 0002'});
    expect(text.sections.find(s => s.id === 'trailers')?.fields.map(f => f.label)).toEqual(['Trailer 1 brand', 'Trailer 1 model', 'Trailer 1 body type', 'Trailer 1 license plate']);
    expect(fields(text.sections, 'samples')).toEqual({sampleCount: '3', firstSample: '2026-10-11 02:00:05', lastSample: '2026-10-11 02:00:08'});
    // There is no trip average consumption (J21).
    expect(JSON.stringify(text)).not.toMatch(/consumption|L\/100 km|mpg/i);
  });
  it('shows the delivered anchor in US customary', () => {
    const text = journalDetailText(DELIVERED_DETAIL, {units: SWAPPED, timeZone: ZONE});
    expect(fields(text.sections, 'distance')).toEqual({plannedDistance: '94.4 mi [job offer, excludes ferries]', observedDistance: '94.4 mi [odometer while recording]',
      deliveredDistance: '94.0 mi [reported by the game]'});
    expect(fields(text.sections, 'job').cargoMass).toBe('39683 lb');
    expect(fields(text.sections, 'truck').fuelCapacity).toBe('264.2 US gal');
  });
  it('keeps zero values apart from unavailable values in both profiles', () => {
    for (const [units, distance, fuel] of [[DEFAULT, '0.0 mi', '0.0 US gal'], [SWAPPED, '0.0 km', '0.0 L']] as const) {
      const text = journalDetailText(ZERO_DETAIL, {units, timeZone: ZONE});
      expect(fields(text.sections, 'distance')).toEqual({plannedDistance: `${distance} [job offer, excludes ferries]`, observedDistance: `${distance} [odometer while recording]`,
        deliveredDistance: 'unavailable (not provided by the game) [reported by the game]'});
      expect(fields(text.sections, 'fuel')).toEqual({fuelUsed: `${fuel} [while recording, refuels excluded]`});
      expect(fields(text.sections, 'money')).toMatchObject({expectedIncome: '0 USD (SDK-documented) [job offer]', revenue: '0 USD (SDK-documented) [reported by the game]'});
      expect(fields(text.sections, 'job')).toEqual({sourceCity: '(empty)', sourceCompany: 'Synthetic Company A', destinationCity: 'unavailable (not provided by the game)',
        destinationCompany: 'Synthetic Company B', cargo: 'unavailable (not observed)', cargoMass: 'unavailable (not provided by the game)', market: 'Freight market', specialJob: 'no',
        cargoLoaded: 'unavailable (invalid reading)', deadline: 'unavailable (invalid reading) [game time]', jobSource: 'job event 3'});
      expect(fields(text.sections, 'delivery')).toEqual({earnedXp: '0', cargoDamage: '0%', deliveryDuration: 'unavailable (not observed) [game time]', autoPark: 'no',
        autoLoad: 'unavailable (not observed)'});
    }
  });
  it('shows a penalty and exact per-currency totals beyond 2^53, never summed across currencies', () => {
    const text = journalDetailText(CANCELLED_DETAIL, {timeZone: ZONE});
    expect(text.outcome).toBe('Cancelled');
    expect(fields(text.sections, 'money')).toEqual({expectedIncome: '12345 (currency unknown) [job offer]', penalty: '12000 EUR (SDK-documented) [reported by the game]',
      fine: '9007199254741238 EUR (SDK-documented), 3 amounts; 50 (currency unknown), 1 amount', toll: '20 USD (SDK-documented), 1 amount; 1 unavailable (not observed)',
      ferry: 'none recorded', train: 'none recorded'});
    expect(fields(text.sections, 'distance').deliveredDistance).toBe('none (not delivered) [reported by the game]');
    expect(text.sections.map(s => s.id)).not.toContain('delivery');
  });
  it('explains incomplete money totals without guessing an amount count or showing a partial sum', () => {
    const text = journalDetailText({...CANCELLED_DETAIL, money: {incomplete: true, totals: [], unavailable: []}}, {timeZone: ZONE});
    expect(fields(text.sections, 'money')).toEqual({expectedIncome: '12345 (currency unknown) [job offer]', penalty: '12000 EUR (SDK-documented) [reported by the game]'});
    expect(notes(text.sections, 'money')).toEqual(['Complete money totals are unavailable. No partial sum is shown as a total.',
      'Amounts are the exact game values. They are never converted, netted or added across currencies.']);
  });
  it('presents the generic unavailable-money explanation in Russian through the Journal copy mapping', () => {
    const text = journalDetailText({...CANCELLED_DETAIL, money: {incomplete: true, totals: [], unavailable: []}}, {timeZone: ZONE, language: 'ru'});
    expect(notes(text.sections, 'money')).toContain('Полные денежные итоги недоступны. Частичная сумма не выдаётся за полную.');
  });
  it('shows a partial trip closed by lost events with its own outcome', () => {
    const text = journalDetailText(GAP_DETAIL, {timeZone: ZONE});
    expect({outcome: text.outcome, completeness: text.completeness}).toEqual({outcome: 'No outcome — events were lost', completeness: {text: 'Partial', variant: 'destructive'}});
    expect(fields(text.sections, 'trip')).toMatchObject({outcome: 'No outcome — events were lost', completeness: 'Partial', ended: '2026-10-11 02:00:24'});
    expect(fields(text.sections, 'money')).toMatchObject({revenueOrPenalty: 'none (no delivery or cancellation)', fine: '70 EUR (SDK-documented), 1 amount'});
    expect(fields(text.sections, 'truck')).toMatchObject({licensePlate: 'SYN 0003'});
    expect(notes(text.sections, 'trailers')).toEqual(['No trailer was recorded for this trip. A trip whose recording started during the job has no trailer until the game sends it again.']);
    expect(fields(text.sections, 'samples')).toEqual({sampleCount: '0'});
  });
  it('shows an open trip without a truck (J22)', () => {
    const text = journalDetailText(OPEN_DETAIL, {timeZone: ZONE});
    expect(fields(text.sections, 'trip')).toMatchObject({outcome: 'In progress', completeness: 'Unknown', ended: 'not yet (in progress)', session: ETS2_B});
    expect(fields(text.sections, 'money')).toMatchObject({revenueOrPenalty: 'not yet (in progress)', toll: '5 EUR (SDK-documented), 1 amount'});
    expect(fields(text.sections, 'truck')).toEqual({});
    expect(notes(text.sections, 'truck')).toEqual(['No truck was recorded for this trip. A trip whose recording started during the job has no truck until the game sends it again.']);
    expect(fields(text.sections, 'distance').deliveredDistance).toBe('none (not delivered) [reported by the game]');
  });
  it('names a checkpoint-opened trip and its checkpoint job', () => {
    const text = journalDetailText({...OPEN_DETAIL, trip: {...OPEN_DETAIL.trip, openedBy: 'checkpoint', openedEventSeq: null, job: {...OPEN.job, source: 'checkpoint'}},
      job: {source: 'checkpoint', eventSeq: null, checkpointNextEventSeq: '7', values: ANCHOR_JOBS.open}}, {timeZone: ZONE});
    expect(fields(text.sections, 'trip').openedBy).toBe('checkpoint (recording started during the job)');
    expect(fields(text.sections, 'job').jobSource).toBe('checkpoint at eventSeq 7 (recording started during the job)');
  });
  it('states the evidence of every game mode and a mode that changed', () => {
    const mode = (gameMode: JournalTripListItem['gameMode'], ambiguous = false) =>
      fields(journalDetailText({...DELIVERED_DETAIL, trip: {...DELIVERED_DETAIL.trip, gameMode, gameModeAmbiguous: ambiguous}}).sections, 'trip').gameMode;
    expect(mode({mode: 'truckersmp', method: 'process-scan', confidence: 'strong'})).toBe('TruckersMP (strong evidence, process scan)');
    expect(mode({mode: 'haulmp', method: 'module-scan', confidence: 'strong'})).toBe('HaulMP (strong evidence, module scan)');
    expect(mode({mode: 'unknown', method: 'none', confidence: 'none'})).toBe('Unknown');
    expect(mode(MODE, true)).toBe('Single-player; ambiguous evidence');
  });
  it('notes when only the latest trailers are shown', () => {
    const items = Array.from({length: 10}, (_, i) => ({eventSeq: String(i + 1), values: trailer(i % 2)}));
    expect(notes(journalDetailText({...DELIVERED_DETAIL, trailers: {items, total: 12}}).sections, 'trailers'))
      .toEqual(['Showing the latest 10 of 12 trailer configurations.']);
  });
  it('localizes booleans, game time and duration in Russian', () => {
    const text = journalDetailText(DELIVERED_DETAIL, {units: DEFAULT, timeZone: ZONE, language: 'ru'});
    expect(fields(text.sections, 'job')).toMatchObject({
      specialJob: 'нет',
      cargoLoaded: 'да',
      deadline: 'День 10, 00:40 [игровое время]'
    });
    expect(text.sections.find(section => section.id === 'money')?.title).toBe('Деньги');
    expect(fields(text.sections, 'job').cargo).toBe(fields(journalDetailText(DELIVERED_DETAIL).sections, 'job').cargo);
    expect(fields(text.sections, 'delivery')).toMatchObject({
      deliveryDuration: '7 ч 51 мин [игровое время]',
      autoPark: 'нет',
      autoLoad: 'да'
    });
  });
  it('labels known SDK job markets in both languages and keeps unknown, empty and unavailable markets truthful (ET-045a)', () => {
    const withMarket = (market: JournalTripDetail['job']['values']['market']): JournalTripDetail =>
      ({...DELIVERED_DETAIL, job: {...DELIVERED_DETAIL.job, values: {...DELIVERED_DETAIL.job.values, market}}});
    const market = (detail: JournalTripDetail, language: 'en' | 'ru') => fields(journalDetailText(detail, {units: DEFAULT, timeZone: ZONE, language}).sections, 'job').market;
    for (const [raw, en, ru] of [['cargo_market', 'Cargo market', 'Рынок грузов'], ['quick_job', 'Quick job', 'Быстрый заказ'],
      ['freight_market', 'Freight market', 'Грузоперевозки'], ['external_contracts', 'External contracts', 'Внешние контракты'],
      ['external_market', 'External market', 'Внешний рынок']] as const) {
      const detail = withMarket(value(raw));
      expect(market(detail, 'en'), raw).toBe(en); expect(market(detail, 'ru'), raw).toBe(ru);
      expect(detail.job.values.market).toEqual(value(raw));
    }
    for (const raw of ['some_future_market', 'constructor', '__proto__']) expect(market(withMarket(value(raw)), 'ru'), raw).toBe(raw);
    expect(market(withMarket(value('')), 'en')).toBe('(empty)');
    expect(market(withMarket(NO), 'en')).toBe('unavailable (not observed)');
  });
});

describe('the job market badges of the trip header (ET-072; REG-009, REG-014)', () => {
  type Market = JournalTripListItem['job']['market'];
  type Special = JournalTripListItem['job']['isSpecialJob'];
  /** The delivered anchor with one job market and special-job flag in both its list summary and its job values. */
  const withJob = (market: Market, isSpecialJob: Special = value(false)) => {
    const trip = {...DELIVERED_DETAIL.trip, job: {...DELIVERED_DETAIL.trip.job, market, isSpecialJob}};
    return {trip, detail: {...DELIVERED_DETAIL, trip, job: {...DELIVERED_DETAIL.job, values: {...DELIVERED_DETAIL.job.values, market, isSpecialJob}}}};
  };
  /** The trip header's badges; the list's Job type column (ET-076) has its own texts, tested below. */
  const badges = (market: Market, isSpecialJob: Special, language: 'en' | 'ru') => {
    const header = journalDetailText(withJob(market, isSpecialJob).detail, {language});
    return {jobType: header.jobType, specialTransport: header.specialTransport};
  };
  it('names every SDK job market in both languages, the external markets as World of Trucks', () => {
    for (const [raw, kind, en, ru] of [
      ['cargo_market', 'cargo-market', 'Cargo market', 'Рынок грузов'],
      ['freight_market', 'freight-market', 'Freight market', 'Грузоперевозки'],
      ['quick_job', 'quick-job', 'Quick job', 'Быстрый заказ'],
      ['external_contracts', 'world-of-trucks', 'World of Trucks · External contracts', 'World of Trucks · Внешние контракты'],
      ['external_market', 'world-of-trucks', 'World of Trucks · External market', 'World of Trucks · Внешний рынок']
    ] as const) {
      expect(badges(value(raw), value(false), 'en'), raw).toEqual({jobType: {kind, text: en}, specialTransport: null});
      expect(badges(value(raw), value(false), 'ru'), raw).toEqual({jobType: {kind, text: ru}, specialTransport: null});
    }
  });
  it('keeps the Job section unchanged: the plain market label and the special-job flag', () => {
    const {detail} = withJob(value('external_contracts'), value(true));
    expect(fields(journalDetailText(detail, {units: DEFAULT, timeZone: ZONE}).sections, 'job')).toMatchObject({market: 'External contracts', specialJob: 'yes'});
    expect(fields(journalDetailText(detail, {units: DEFAULT, timeZone: ZONE, language: 'ru'}).sections, 'job')).toMatchObject({market: 'Внешние контракты', specialJob: 'да'});
  });
  it('shows any other market verbatim, an empty one as (empty) and an unavailable one with its reason, each named as the job market', () => {
    for (const [raw, en, ru] of [
      ['some_future_market', 'Job market: some_future_market', 'Рынок заказов: some_future_market'],
      ['constructor', 'Job market: constructor', 'Рынок заказов: constructor'],
      ['__proto__', 'Job market: __proto__', 'Рынок заказов: __proto__'],
      ['', 'Job market: (empty)', 'Рынок заказов: (пусто)']
    ] as const) {
      expect(badges(value(raw), value(false), 'en'), raw).toEqual({jobType: {kind: 'other', text: en}, specialTransport: null});
      expect(badges(value(raw), value(false), 'ru'), raw).toEqual({jobType: {kind: 'other', text: ru}, specialTransport: null});
    }
    const missing = {available: false, reason: 'not-supported'} as const;
    expect(badges(missing, value(false), 'en')).toEqual({jobType: {kind: 'unavailable', text: 'Job market: unavailable (not provided by the game)'}, specialTransport: null});
    expect(badges(missing, value(false), 'ru')).toEqual({jobType: {kind: 'unavailable', text: 'Рынок заказов: недоступно (не предоставлено игрой)'}, specialTransport: null});
    // The raw value is never changed.
    const {trip} = withJob(value('constructor'));
    journalListText({database: DATABASE, trips: [trip], nextCursor: null}, {filtered: false});
    expect(trip.job.market).toEqual(value('constructor'));
  });
  it('shows Special transport only when the game marked the job as special', () => {
    expect(badges(value('cargo_market'), value(true), 'en')).toEqual({jobType: {kind: 'cargo-market', text: 'Cargo market'}, specialTransport: 'Special transport'});
    expect(badges(value('cargo_market'), value(true), 'ru')).toEqual({jobType: {kind: 'cargo-market', text: 'Рынок грузов'}, specialTransport: 'Спецтранспорт'});
    expect(badges(NO, value(true), 'en')).toEqual({jobType: {kind: 'unavailable', text: 'Job market: unavailable (not observed)'}, specialTransport: 'Special transport'});
    for (const special of [value(false), NO, {available: false, reason: 'invalid'} as const]) {
      expect(badges(value('cargo_market'), special, 'en').specialTransport).toBeNull();
      expect(badges(value('cargo_market'), special, 'ru').specialTransport).toBeNull();
    }
  });
});

describe('the compact list rows (ET-076; REG-009, REG-014)', () => {
  type Market = JournalTripListItem['job']['market'];
  const rowOf = (trip: JournalTripListItem, language: 'en' | 'ru' = 'en') => journalListText({database: DATABASE, trips: [trip], nextCursor: null}, {filtered: false, language}).rows[0];
  const withMarket = (market: Market, isSpecialJob: JournalTripListItem['job']['isSpecialJob'] = value(false)): JournalTripListItem => ({...DELIVERED, job: {...DELIVERED.job, market, isSpecialJob}});
  it('shows every mode, and an unknown mode never as single-player', () => {
    const mode = (gameMode: JournalTripListItem['gameMode'], ambiguous = false, language: 'en' | 'ru' = 'en') => rowOf({...DELIVERED, gameMode, gameModeAmbiguous: ambiguous}, language).mode.text;
    expect(mode({mode: 'unknown', method: 'none', confidence: 'none'})).toBe('Mode unknown');
    expect(mode({mode: 'unknown', method: 'none', confidence: 'none'}, false, 'ru')).toBe('Режим неизвестен');
    expect(mode({mode: 'unknown', method: 'none', confidence: 'none'}, true)).toBe('Mode unknown · ambiguous evidence');
    expect(mode({mode: 'single-player', method: 'module-scan', confidence: 'weak'})).toBe('Single-player');
    expect(mode({mode: 'single-player', method: 'process-scan', confidence: 'weak'})).toBe('Single-player · unconfirmed');
    expect(mode({mode: 'truckersmp', method: 'process-scan', confidence: 'strong'})).toBe('TruckersMP');
    expect(mode({mode: 'haulmp', method: 'module-scan', confidence: 'strong'})).toBe('HaulMP');
    expect(mode({mode: 'haulmp', method: 'module-scan', confidence: 'strong'}, false, 'ru')).toBe('HaulMP');
    expect(mode({mode: 'haulmp', method: 'module-scan', confidence: 'strong'}, true)).toBe('HaulMP · ambiguous evidence');
    expect(mode({mode: 'convoy', method: 'none', confidence: 'none'})).toBe('Convoy · unconfirmed');
    expect(mode({mode: 'convoy', method: 'none', confidence: 'none'}, false, 'ru')).toBe('Конвой · не подтверждено');
    expect(rowOf({...DELIVERED, gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}}).mode).toMatchObject({kind: 'unknown', tone: 'neutral', evidence: 'Unknown'});
    expect(rowOf({...DELIVERED, gameMode: {mode: 'haulmp', method: 'module-scan', confidence: 'strong'}}).mode).toMatchObject({kind: 'haulmp', tone: 'ok', text: 'HaulMP', evidence: 'HaulMP (strong evidence, module scan)'});
  });
  it('labels every known market, both external markets as World of Trucks with the market name below', () => {
    for (const [raw, kind, en, ruText, enSub, ruSub] of [
      ['cargo_market', 'cargo-market', 'Cargo market', 'Рынок грузов', null, null],
      ['freight_market', 'freight-market', 'Freight market', 'Грузоперевозки', null, null],
      ['quick_job', 'quick-job', 'Quick job', 'Быстрый заказ', null, null],
      ['external_contracts', 'world-of-trucks', 'World of Trucks', 'World of Trucks', 'External contracts', 'Внешние контракты'],
      ['external_market', 'world-of-trucks', 'World of Trucks', 'World of Trucks', 'External market', 'Внешний рынок']
    ] as const) {
      expect(rowOf(withMarket(value(raw))).jobType, raw).toEqual({kind, text: en, sub: enSub});
      expect(rowOf(withMarket(value(raw)), 'ru').jobType, raw).toEqual({kind, text: ruText, sub: ruSub});
    }
  });
  it('shows any other market verbatim, an empty one as (empty) and an unavailable one with its reason', () => {
    expect(rowOf(withMarket(value('foo_market'))).jobType).toEqual({kind: 'other', text: 'foo_market', sub: null});
    expect(rowOf(withMarket(value('constructor'))).jobType).toEqual({kind: 'other', text: 'constructor', sub: null});
    expect(rowOf(withMarket(value(''))).jobType).toEqual({kind: 'other', text: '(empty)', sub: null});
    expect(rowOf(withMarket(value('')), 'ru').jobType).toEqual({kind: 'other', text: '(пусто)', sub: null});
    expect(rowOf(withMarket(NO)).jobType).toEqual({kind: 'unavailable', text: 'unavailable (not observed)', sub: null});
    expect(rowOf(withMarket({available: false, reason: 'not-supported'})).jobType).toEqual({kind: 'unavailable', text: 'unavailable (not provided by the game)', sub: null});
    expect(rowOf(withMarket({available: false, reason: 'invalid'}), 'ru').jobType).toEqual({kind: 'unavailable', text: 'недоступно (некорректное значение)', sub: null});
  });
  it('keeps Special transport apart from the job type line, also with World of Trucks', () => {
    expect(rowOf(withMarket(value('external_market'), value(true)))).toMatchObject({jobType: {text: 'World of Trucks', sub: 'External market'}, specialTransport: 'Special transport'});
    expect(rowOf(withMarket(value('quick_job'), value(false))).specialTransport).toBeNull();
  });
  it('shows the companies and the planned distance line', () => {
    expect(rowOf({...DELIVERED, job: {...DELIVERED.job, sourceCompany: value(''), destinationCompany: NO}})).toMatchObject({companies: '(empty) · unavailable (not observed)'});
    expect(rowOf(DELIVERED)).toMatchObject({observedDistance: '152.0 km', plannedDistance: '152.0 km', plannedOf: 'of 152.0 km'});
    expect(rowOf(DELIVERED, 'ru').plannedOf).toBe('из 152.0 км');
  });
  it.each([
    [0, 0, '0 trips · 0.0 h recorded', '0 рейсов · 0,0 ч записано'],
    [1, 1_440, '1 trip · 0.4 h recorded', '1 рейс · 0,4 ч записано'],
    [2, 35_964, '2 trips · 9.9 h recorded', '2 рейса · 9,9 ч записано'],
    [5, 36_000, '5 trips · 10 h recorded', '5 рейсов · 10 ч записано'],
    [21, 765_720, '21 trips · 212 h recorded', '21 рейс · 212 ч записано']
  ])('writes the totals for %i trips and %i seconds', (trips, recordedSeconds, en, ru) => {
    expect(journalTotalsText({trips, recordedSeconds}, 'en')).toBe(en);
    expect(journalTotalsText({trips, recordedSeconds}, 'ru')).toBe(ru);
  });
  it('states the shown rows of a page', () => {
    expect(journalRangeText(1, 50)).toBe('Showing 1–50');
    expect(journalRangeText(2, 50, 'ru')).toBe('Показано 51–100');
    expect(journalRangeText(3, 7)).toBe('Showing 101–107');
    expect(journalRangeText(4, 0)).toBeNull();
  });
});

describe('completeness intervals and timeline (J7, J13)', () => {
  const interval = (id: string, rest: Partial<JournalInterval>): JournalInterval => ({id, kind: 'discontinuity', annotation: false, cause: null, startUtcMs: null, endUtcMs: null,
    startMonotonicNs: null, endMonotonicNs: null, sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: null, ...rest});
  it('lists the gap-closed anchor intervals with kind, cause, local times and eventSeqs', () => {
    const page: JournalIntervalPage = {database: DATABASE, total: 3, nextCursor: null, intervals: [
      interval('2', {annotation: true, cause: 'truck-change', detail: {cause: 'truck-change', annotation: true, atEventSeq: '23'}}),
      interval('3', {kind: 'sample-loss', cause: 'reading-hole', startUtcMs: BASE_UTC + 23_000, endUtcMs: BASE_UTC + 24_000, detail: {cause: 'reading-hole'}}),
      interval('4', {kind: 'event-loss', cause: 'gap', firstEventSeq: '25', lastEventSeq: '26', detail: {cause: 'gap'}}),
      interval('5', {kind: 'not-connected', cause: 'some-future-cause', detail: {cause: 'some-future-cause'}})]};
    expect(journalIntervalText(page, {timeZone: ZONE})).toEqual({total: 'Completeness intervals recorded for this trip: 3.', empty: null, hasNext: false, rows: [
      {id: '2', kind: 'Discontinuity', cause: 'truck changed (annotation; completeness unchanged)', start: '—', end: '—', events: '—'},
      {id: '3', kind: 'Missing one-second samples', cause: 'readings missing', start: '2026-10-11 02:00:23', end: '2026-10-11 02:00:24', events: '—'},
      {id: '4', kind: 'Lost events', cause: 'lost events', start: '—', end: '—', events: 'eventSeq 25–26'},
      {id: '5', kind: 'Not connected', cause: 'other', start: '—', end: '—', events: '—'}]});
    expect(journalIntervalText({database: DATABASE, total: 0, nextCursor: null, intervals: []})).toMatchObject({empty: 'No completeness intervals were recorded for this trip.'});
    // Review round 1: exactly 100 intervals give an empty page 2, which must not contradict the total.
    expect(journalIntervalText({database: DATABASE, total: 100, nextCursor: null, intervals: []}, {firstPage: false}))
      .toEqual({total: 'Completeness intervals recorded for this trip: 100.', rows: [], empty: 'No more completeness intervals.', hasNext: false});
  });
  const occurred = (utcMs: number | null) => ({monotonicNs: NO, gameTime: {minutes: NO, clockId: CLOCK}, utcUnixMs: utcMs === null ? NO : value(String(utcMs)),
    simulation: 'running' as const, configurationRevision: '1', boundaryOrder: '1'});
  const event = (eventSeq: string, record: EventRecord, attribution: JournalEvent['attribution'], utcMs: number | null = BASE_UTC + Number(eventSeq) * 1_000): JournalEvent =>
    ({eventSeq, type: record.type, occurred: occurred(utcMs), record, attribution});
  it('lists the delivered anchor timeline with its window and the trip each event belongs to', () => {
    const page: JournalEventPage = {database: DATABASE, nextCursor: '9', window: DELIVERED_DETAIL.window, events: [
      event('4', {type: 'job.configured', ...job()}, null),
      event('5', {type: 'player.fined', offence: value('crash'), amount: money('400', 's64', EUR)}, {kind: 'trip', tripUuid: T.delivered}),
      event('6', {type: 'player.tollgate.paid', amount: NO}, {kind: 'trip-before-loaded', tripUuid: T.delivered}),
      event('7', {type: 'player.use.ferry', amount: money('677', 's64', EUR), sourceId: value('a'), sourceName: value('Synthetic Port A'), targetId: value('b'),
        targetName: value('Synthetic Port B')}, {kind: 'trip', tripUuid: T.cancelled}),
      event('8', {type: 'simulation.paused'}, {kind: 'free-driving', tripUuid: null}, null),
      event('9', DELIVERED_RECORD, {kind: 'ambiguous', tripUuid: null})]};
    for (const [units, delivered] of [[DEFAULT, '151.3 km'], [SWAPPED, '94.0 mi']] as const) {
      expect(journalEventText(page, {tripUuid: T.delivered, game: 'ets2'}, {units, timeZone: ZONE})).toEqual({
        window: "Events of the trip's plugin session from eventSeq 4 through 9, the event that closed the trip.", empty: null, hasNext: true, rows: [
          {key:`${ETS2_A}:4`,eventSeq: '4', time: '2026-10-11 02:00:04', type: 'Job configured', detail: 'Synthetic Cargo, Synthetic City A → Synthetic City B', attribution: '—'},
          {key:`${ETS2_A}:5`,eventSeq: '5', time: '2026-10-11 02:00:05', type: 'Fine', detail: 'crash: 400 EUR (SDK-documented)', attribution: 'this trip'},
          {key:`${ETS2_A}:6`,eventSeq: '6', time: '2026-10-11 02:00:06', type: 'Toll', detail: 'unavailable (not observed)', attribution: 'this trip, before the cargo was loaded'},
          {key:`${ETS2_A}:7`,eventSeq: '7', time: '2026-10-11 02:00:07', type: 'Ferry', detail: 'Synthetic Port A → Synthetic Port B: 677 EUR (SDK-documented)', attribution: 'another trip'},
          {key:`${ETS2_A}:8`,eventSeq: '8', time: 'unavailable (not observed)', type: 'Game paused', detail: '', attribution: 'free driving'},
          {key:`${ETS2_A}:9`,eventSeq: '9', time: '2026-10-11 02:00:09', type: 'Delivered', detail: `Revenue 15000 EUR (SDK-documented), delivered distance ${delivered}`, attribution: 'ambiguous'}]});
    }
  });
  it('describes every window kind', () => {
    const windowText = (window: JournalEventPage['window']) => journalEventText({database: DATABASE, window, events: [], nextCursor: null}, {tripUuid: T.open, game: 'ets2'}).window;
    expect(windowText({known: true, pluginSessionId: ETS2_B, fromEventSeq: '1', throughEventSeq: null, end: 'open'}))
      .toBe("Events of the trip's plugin session from eventSeq 1; the trip is in progress.");
    expect(windowText({known: true, pluginSessionId: ETS2_A, fromEventSeq: '22', throughEventSeq: '24', end: 'close-gap'}))
      .toBe("Events of the trip's plugin session from eventSeq 22 through 24; lost events closed the trip.");
    expect(windowText({known: true, pluginSessionId: ETS2_A, fromEventSeq: '28', throughEventSeq: null, end: 'end-of-session'}))
      .toBe("Events of the trip's plugin session from eventSeq 28 to the end of that session; a later session closed the trip.");
    expect(windowText({known: false, pluginSessionId: MIGRATED_V1_SESSION}))
      .toBe('This trip was closed before schema version 2, so its window is unknown. Only the events attributed to it or referenced by it are listed.');
    expect(journalEventText({database: DATABASE, window: {known: false, pluginSessionId: MIGRATED_V1_SESSION}, events: [], nextCursor: null},
      {tripUuid: MIGRATED_V1_TRIP, game: 'ets2'}).empty).toBe('No events in this window.');
    // Review round 1: exactly 100 events give an empty page 2.
    expect(journalEventText({database: DATABASE, window: DELIVERED_DETAIL.window, events: [], nextCursor: null}, {tripUuid: T.delivered, game: 'ets2'}, {firstPage: false}))
      .toEqual({window: "Events of the trip's plugin session from eventSeq 4 through 9, the event that closed the trip.", rows: [], empty: 'No more events in this window.', hasNext: false});
  });
});

describe('one-second samples (J14; REG-009, REG-017)', () => {
  const COLUMNS = [{label: 'Time'}, {label: 'Speed'}, {label: 'Fuel'}, {label: 'Gear'}, {label: 'Engine RPM'}, {label: 'Odometer'}, {label: 'Estimated range'},
    {label: 'SDK average consumption', note: 'SDK mean, not a trip average'}, {label: 'Game time'}, {label: 'World position', note: 'game-world coordinates, not GPS'}];
  const OTHER_CLOCK = '2c000000-0000-4000-8000-00000000000b';
  const sample = (id: string, second: number, rest: Partial<JournalSample> = {}, clock = CLOCK): JournalSample => ({id, tripUuid: T.delivered, utcMs: BASE_UTC + 4_000 + second * 1_000,
    sourceClockId: clock, monotonicNs: (5_000_000_000_000n + BigInt(second) * 1_000_000_000n + 250_000_000n).toString(), gameTime: null, speed: NO, fuel: NO,
    averageConsumption: NO, estimatedRange: NO, engineRpm: NO, gear: NO, odometer: NO, position: NO, ...rest});
  // The delivered anchor's samples (seconds 1, 2 and 4), then a restarted source on another clock.
  const page: JournalSamplePage = {database: DATABASE, nextCursor: '5', samples: [
    sample('2', 1, {speed: value(22.25), fuel: value(410.5), averageConsumption: value(32.5), estimatedRange: value(1_263_000), engineRpm: value(1_450.5), gear: value(12),
      odometer: value(1_234_590), position: value({x: -31_212.25, y: 42.5, z: 18_801.5}), gameTime: {minutes: value(12_345), clockId: CLOCK}}),
    sample('3', 2, {speed: value(0), fuel: {available: false, reason: 'not-supported'}, gear: value(0)}),
    sample('4', 4, {speed: {available: false, reason: 'invalid'}, engineRpm: value(0)}),
    sample('5', 4, {gear: value(-1), averageConsumption: value(0)}, OTHER_CLOCK)]};
  it('shows the samples with a no-samples separator and a source restart in metric', () => {
    expect(journalSampleText(page, 'ets2', {units: DEFAULT, timeZone: ZONE})).toEqual({columns: COLUMNS, empty: null, hasNext: true, rows: [
      {kind: 'sample', key: '2', time: '2026-10-11 02:00:05', speed: '80.1 km/h', fuel: '410.5 L', consumption: '32.5 L/100 km', range: '1263.0 km', rpm: '1451 rpm', gear: '12',
        odometer: '1234.6 km', gameTime: 'Day 9, 13:45', position: 'x -31212.3, y 42.5, z 18801.5'},
      {kind: 'sample', key: '3', time: '2026-10-11 02:00:06', speed: '0.0 km/h', fuel: 'unavailable (not provided by the game)', consumption: 'unavailable (not observed)',
        range: 'unavailable (not observed)', rpm: 'unavailable (not observed)', gear: 'N', odometer: 'unavailable (not observed)', gameTime: 'unavailable (not observed)',
        position: 'unavailable (not observed)'},
      {kind: 'gap', key: 'gap-4', text: 'no samples for 1 s'},
      {kind: 'sample', key: '4', time: '2026-10-11 02:00:08', speed: 'unavailable (invalid reading)', fuel: 'unavailable (not observed)', consumption: 'unavailable (not observed)',
        range: 'unavailable (not observed)', rpm: '0 rpm', gear: 'unavailable (not observed)', odometer: 'unavailable (not observed)', gameTime: 'unavailable (not observed)',
        position: 'unavailable (not observed)'},
      {kind: 'restart', key: 'restart-5', text: 'source restarted'},
      {kind: 'sample', key: '5', time: '2026-10-11 02:00:08', speed: 'unavailable (not observed)', fuel: 'unavailable (not observed)', consumption: '0.0 L/100 km',
        range: 'unavailable (not observed)', rpm: 'unavailable (not observed)', gear: 'R1', odometer: 'unavailable (not observed)', gameTime: 'unavailable (not observed)',
        position: 'unavailable (not observed)'}]});
  });
  it('converts samples to US customary, with no mpg value for zero consumption', () => {
    const rows = journalSampleText(page, 'ets2', {units: SWAPPED, timeZone: ZONE}).rows.filter(row => row.kind === 'sample');
    expect(rows.map(row => [row.speed, row.fuel, row.consumption, row.range, row.odometer])).toEqual([
      ['49.8 mph', '108.4 US gal', '7.2 US mpg', '784.8 mi', '767.1 mi'],
      ['0.0 mph', 'unavailable (not provided by the game)', 'unavailable (not observed)', 'unavailable (not observed)', 'unavailable (not observed)'],
      ['unavailable (invalid reading)', 'unavailable (not observed)', 'unavailable (not observed)', 'unavailable (not observed)', 'unavailable (not observed)'],
      ['unavailable (not observed)', 'unavailable (not observed)', 'no consumption recorded', 'unavailable (not observed)', 'unavailable (not observed)']]);
  });
  it('shows a zero sample as values in ATS and names an empty page', () => {
    const zero = sample('9', 1, {speed: value(0), fuel: value(0), averageConsumption: {available: false, reason: 'not-supported'}, estimatedRange: {available: false, reason: 'invalid'},
      engineRpm: value(0), gear: value(0), position: value({x: 0, y: 0, z: 0}), gameTime: {minutes: value(0), clockId: CLOCK}});
    expect(journalSampleText({database: DATABASE, nextCursor: null, samples: [zero]}, 'ats', {timeZone: ZONE}).rows).toEqual([{kind: 'sample', key: '9',
      time: '2026-10-11 02:00:05', speed: '0.0 mph', fuel: '0.0 US gal', consumption: 'unavailable (not provided by the game)', range: 'unavailable (invalid reading)', rpm: '0 rpm',
      gear: 'N', odometer: 'unavailable (not observed)', gameTime: 'Day 1, 00:00', position: 'x 0.0, y 0.0, z 0.0'}]);
    expect(journalSampleText({database: DATABASE, nextCursor: null, samples: []}, 'ats')).toEqual({columns: COLUMNS, rows: [], empty: 'No one-second samples were recorded for this trip.',
      hasNext: false});
  });
  it('says only that no more samples follow on an empty later page (review round 1)', () => {
    // 3,600 samples fill twelve pages of 300; page 13 is empty while the detail counts 3600.
    expect(journalSampleText({database: DATABASE, nextCursor: null, samples: []}, 'ets2', {firstPage: false}))
      .toEqual({columns: COLUMNS, rows: [], empty: 'No more one-second samples.', hasNext: false});
  });
  it('shows a sample label outside the Date range as an invalid reading (review round 1)', () => {
    const rows = journalSampleText({database: DATABASE, nextCursor: null, samples: [sample('9', 1, {utcMs: -8_640_000_000_000_001})]}, 'ets2', {timeZone: ZONE}).rows;
    expect(rows[0]).toMatchObject({kind: 'sample', time: 'unavailable (invalid reading)'});
  });
  it('localizes sample game time in Russian', () => {
    const rows = journalSampleText(page, 'ets2', {units: DEFAULT, timeZone: ZONE, language: 'ru'}).rows;
    expect(rows[0]).toMatchObject({kind: 'sample', gameTime: 'День 9, 13:45'});
  });
});

it('keeps stored SDK names equal to known UI labels exact in both selected languages', () => {
  const detail = structuredClone(DELIVERED_DETAIL);
  for (const key of ['cargo', 'sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany'] as const) {
    detail.job.values[key] = {available: true, value: key === 'cargo' ? 'Speed' : 'Settings'};
    detail.trip.job[key] = detail.job.values[key];
  }
  for (const language of ['en', 'ru'] as const) {
    const view = journalDetailText(detail, {language});
    expect(fields(view.sections, 'job')).toMatchObject({cargo: 'Speed', sourceCity: 'Settings', sourceCompany: 'Settings', destinationCity: 'Settings', destinationCompany: 'Settings'});
  }
});

it('separates typed hero amounts and missing values from their provenance without converting exact money', () => {
  expect(journalTileValues(DELIVERED_DETAIL, {language: 'ru'})).toEqual({distance: {value: '152.0 км', note: null},
    fuel: {value: '—', note: 'недоступно (не наблюдалось)'}, money: {value: '15000 EUR', note: 'Валюта подтверждена SDK'},
    planned: '152.0 км', gameDistance: '151.3 км', expected: '12345 (валюта неизвестна)',
    // ET-112e: the game's delivery distance is the hero of a delivered trip, and the odometer distance is a separate note.
    distanceTile: {label: 'По данным игры', value: '151.3 км', notes: ['одометр 152.0 км', 'по заказу 152.0 км']}, fuelPartial: null,
    recorded: {value: '3 с', note: 'по сэмплам 1 Гц, без пауз и пропусков; могут входить сэмплы, не учтённые в дистанции и расходе'}, gameTime: '7 ч 51 мин игрового'});
  expect(journalTileValues(ZERO_DETAIL).distance).toEqual({value: '0.0 mi', note: null});
  expect(journalTileValues(ZERO_DETAIL).fuel).toEqual({value: '0.0 US gal', note: null});
  const detail = structuredClone(DELIVERED_DETAIL);
  if (detail.outcomeDetails?.record.type !== 'job.delivered') throw new Error('Delivered fixture unavailable');
  detail.outcomeDetails.record.revenue = money('9007199254740993.123456', 's64', UNKNOWN_CURRENCY);
  expect(journalTileValues(detail).money).toEqual({value: '9007199254740993.123456', note: 'Currency unknown'});
  expect(journalTileValues(CANCELLED_DETAIL).money).toEqual({value: '12000 EUR', note: 'Currency documented by the SDK'});
});


it.each([
  ['SCHEMA_NEWER', 'база данных создана более новой версией'],
  ['DATABASE_LOCKED', 'база данных заблокирована другой программой'],
  ['TIMEOUT', 'хранилище не ответило вовремя'],
  ['DISK_FULL', 'диск заполнен']
] as const)('localizes the fixed journal storage cause %s without changing its code', (storageCode, cause) => {
  const failure = {ok: false as const, code: 'DATABASE_UNAVAILABLE' as const, storageCode};
  expect(journalErrorText(failure, 'ru')).toBe(`База данных недоступна: ${cause}.`);
  expect(failure.storageCode).toBe(storageCode);
});

describe('journal mode badges', () => {
  it('shows ordinary single-player neutrally while preserving other uncertainty and ambiguity in EN/RU', () => {
    const cases = [
      [{mode: 'truckersmp', method: 'module-scan', confidence: 'strong'}, 'TruckersMP', 'TruckersMP', 'ok'],
      [{mode: 'single-player', method: 'module-scan', confidence: 'weak'}, 'Single-player', 'Одиночная игра', 'neutral'],
      [{mode: 'single-player', method: 'process-scan', confidence: 'weak'}, 'Single-player · unconfirmed', 'Одиночная игра · не подтверждено', 'warn'],
      [{mode: 'truckersmp', method: 'process-scan', confidence: 'weak'}, 'TruckersMP · unconfirmed', 'TruckersMP · не подтверждено', 'warn'],
      [{mode: 'unknown', method: 'none', confidence: 'none'}, 'Unknown', 'Неизвестно', 'neutral']
    ] as const;
    for (const [mode, en, ru, tone] of cases) for (const language of ['en', 'ru'] as const) for (const ambiguous of [false, true]) {
      const trip = {...DELIVERED_DETAIL.trip, gameMode: mode, gameModeAmbiguous: ambiguous};
      const before = structuredClone(trip);
      const list = journalListText({database: DATABASE, trips: [trip], nextCursor: null}, {filtered: false, language}).rows[0].mode;
      const detail = journalDetailText({...DELIVERED_DETAIL, trip}, {language}).mode;
      // The list says `Mode unknown` for an unknown mode (ET-076); the trip header keeps `Unknown`.
      const listLabel = mode.mode === 'unknown' ? (language === 'en' ? 'Mode unknown' : 'Режим неизвестен') : language === 'en' ? en : ru;
      expect(list).toEqual({...detail, text: detail.text.replace(language === 'en' ? 'Unknown' : 'Неизвестно', listLabel)});
      expect(list.kind).toBe(before.gameMode.mode);
      expect(list.text).toBe(`${listLabel}${ambiguous ? language === 'en' ? ' · ambiguous evidence' : ' · неоднозначные данные' : ''}`);
      expect(list.tone).toBe(ambiguous ? 'warn' : tone);
      if (mode.mode === 'single-player' && mode.method === 'module-scan') {
        expect(list.evidence).toBe(`${language === 'en' ? en : ru}${ambiguous ? language === 'en' ? '; ambiguous evidence' : '; неоднозначные данные' : ''}`);
      }
      expect(fields(journalDetailText({...DELIVERED_DETAIL, trip}, {language}).sections, 'trip').gameMode).toBe(list.evidence);
      expect(trip).toEqual(before);
    }
  });
});

it('REG-012/014 hides loaded Journal sync facts during verification, disconnection and owner/origin changes', () => {
  const origin = 'https://dashboard.example', owner = {origin, accountId: 'a', companyId: 'c', identityEpoch: 'e'};
  const page: JournalTripPage = {database: {purpose: 'history', schemaVersion: 6}, trips: [], nextCursor: null, sync: {owner, connectionVersion: '1', rows: []}};
  const status = {...initialDashboardUploadStatus(origin), state: 'connected' as const, owner};
  expect(journalPageSync(page, status)).toEqual(page.sync);
  for (const hidden of [null, initialDashboardUploadStatus(null), {...status, state: 'verifying' as const}, {...status, owner: {...owner, identityEpoch: 'other'}}, {...status, origin: 'https://other.example', owner: {...owner, origin: 'https://other.example'}}]) expect(journalPageSync(page, hidden)).toBeUndefined();
});
it('REG-012/014 retains same-owner read-time assessments across connection versions until Refresh supplies a new page', () => {
  const origin = 'https://dashboard.example', owner = {origin, accountId: 'a', companyId: 'c', identityEpoch: 'e'}, status = {...initialDashboardUploadStatus(origin), state: 'connected' as const, owner};
  const previous: JournalTripPage = {database: {purpose: 'history', schemaVersion: 6}, trips: [DELIVERED_DETAIL.trip], nextCursor: null, sync: {owner, connectionVersion: '1', rows: [{tripUuid: DELIVERED_DETAIL.trip.tripUuid, state: 'sent', materialVersion: '1', latestRevision: 1, lastDurableUploadUtcMs: 5000, reason: null}]}};
  const refreshed: JournalTripPage = {...previous, sync: {...previous.sync!, connectionVersion: '3', rows: [{...previous.sync!.rows[0], state: 'pending', materialVersion: '2', lastDurableUploadUtcMs: null}]}};
  expect(journalPageSync(previous, status)).toBe(previous.sync); expect(journalPageSync(refreshed, status)).toBe(refreshed.sync);
  expect(journalPageSync(previous, {...status, owner: {...owner, identityEpoch: 'new'}})).toBeUndefined(); expect(previous.sync?.rows[0].state).toBe('sent');
});

describe('the compact trip page (ET-077; REG-003, REG-009, REG-014)', () => {
  const withSamples = (count: number, firstUtcMs: number | null, lastUtcMs: number | null): JournalTripDetail => ({...DELIVERED_DETAIL, samples: {count, firstUtcMs, lastUtcMs}});
  it('derives recorded time from the sample count and never from the UTC labels', () => {
    // A week between the labels and 13,860 samples: the tile shows the samples.
    const recorded = journalTileValues(withSamples(13_860, BASE_UTC, BASE_UTC + 604_800_000)).recorded;
    expect(recorded).toEqual({value: '3 h 51 min', note: 'from 1 Hz samples, without pauses and gaps; may include samples not counted in distance and fuel'});
    expect(journalTileValues(withSamples(725, BASE_UTC, BASE_UTC + 1)).recorded.value).toBe('12 min 5 s');
    expect(journalTileValues(withSamples(46, null, null)).recorded.value).toBe('46 s');
  });
  it('shows no samples as a dash with its reason, never as zero time', () => {
    expect(journalTileValues(withSamples(0, null, null))).toMatchObject({recorded: {value: '—', note: 'no samples recorded'}});
    expect(journalTileValues(withSamples(0, null, null), {language: 'ru'}).recorded).toEqual({value: '—', note: 'сэмплы не записаны'});
  });
  it('keeps planned, game-reported and observed values under separate labels', () => {
    expect(journalTileValues(DELIVERED_DETAIL)).toMatchObject({distance: {value: '152.0 km'}, planned: '152.0 km', gameDistance: '151.3 km', expected: '12345 (currency unknown)', gameTime: '7 h 51 min game time'});
    expect(journalTileValues(OPEN_DETAIL)).toMatchObject({distance: {value: '—', note: 'unavailable (not observed)'}, gameDistance: null, gameTime: 'game time not available'});
    expect(journalTileValues(CANCELLED_DETAIL)).toMatchObject({gameDistance: null, gameTime: 'game time not available', money: {value: '12000 EUR'}});
  });
  it('keeps an unavailable delivery duration unavailable, and zero is a value', () => {
    const detail = structuredClone(DELIVERED_DETAIL);
    if (detail.outcomeDetails?.record.type !== 'job.delivered') throw new Error('Delivered fixture unavailable');
    detail.outcomeDetails.record.deliveryDuration = {available: false, reason: 'not-observed', unit: 'min'} as never;
    expect(journalTileValues(detail).gameTime).toBe('game time not available');
    expect(journalTileValues(ZERO_DETAIL).fuel).toEqual({value: '0.0 US gal', note: null});
  });

  it('builds the route, the money rows and the vehicle from the detail', () => {
    expect(journalTripSideText(DELIVERED_DETAIL, {timeZone: ZONE})).toEqual({
      route: 'Synthetic City A, Synthetic Company A → Synthetic City B, Synthetic Company B · started 2026-10-11 02:00:04',
      money: {notes: [], rows: [
        {id: 'fine', label: 'Fines', value: '401 EUR (SDK-documented), 2 amounts'}, {id: 'toll', label: 'Tolls', value: '35 EUR (SDK-documented), 1 amount'},
        {id: 'ferry', label: 'Ferries', value: '677 EUR (SDK-documented), 1 amount'}, {id: 'train', label: 'Trains', value: 'none recorded'}]},
      vehicle: {notes: [], rows: [{id: 'truck', label: 'Truck', value: 'Synthetic Brand Synthetic Truck'}, {id: 'trailer-0', label: 'Trailer', value: 'dryvan'}, {id: 'cargoMass', label: 'Cargo mass', value: '18.0 t'}]}
    });
  });
  it('never sums money across categories, and an incomplete total shows only its note', () => {
    expect(journalTripSideText({...DELIVERED_DETAIL, money: {incomplete: true, totals: [], unavailable: []}}).money).toEqual({rows: [], notes: ['Complete money totals are unavailable. No partial sum is shown as a total.']});
    expect(journalTripSideText(CANCELLED_DETAIL).money.rows[0].value).toBe('9007199254741238 EUR (SDK-documented), 3 amounts; 50 (currency unknown), 1 amount');
  });
  it('shows the latest configuration of each trailer slot and says when the vehicle is unknown', () => {
    const items = [{eventSeq: '2', values: trailer(0, {bodyType: value('old')})}, {eventSeq: '3', values: trailer(1, {bodyType: value('dolly')})}, {eventSeq: '4', values: trailer(0, {bodyType: value('curtain')})}];
    const rows = journalTripSideText({...DELIVERED_DETAIL, trailers: {items, total: 3}}).vehicle.rows;
    expect(rows.filter(row => row.id.startsWith('trailer'))).toEqual([{id: 'trailer-0', label: 'Trailer 1', value: 'curtain'}, {id: 'trailer-1', label: 'Trailer 2', value: 'dolly'}]);
    const none = journalTripSideText({...DELIVERED_DETAIL, truck: null, trailers: {items: [], total: 0}}, {language: 'ru'}).vehicle;
    expect(none.rows.map(row => row.id)).toEqual(['cargoMass']);
    expect(none.notes).toHaveLength(2);
  });

  const interval = (id: string, startUtcMs: number | null, changes: Partial<JournalInterval> = {}): JournalInterval => ({id, kind: 'sample-loss', annotation: false, cause: 'reading-hole', startUtcMs, endUtcMs: null,
    startMonotonicNs: null, endMonotonicNs: null, sourceClockId: CLOCK, firstEventSeq: null, lastEventSeq: null, detail: null, ...changes});
  const event = (seq: string, utc: number | null): JournalEvent => ({eventSeq: seq, type: 'simulation.paused', record: {type: 'simulation.paused'},
    occurred: {utcUnixMs: utc === null ? {available: false, reason: 'not-observed'} : value(String(utc))} as JournalEvent['occurred'], attribution: null});
  const trip = {tripUuid: T.delivered, game: 'ets2'} as const;
  const page = (events: JournalEvent[], nextCursor: string | null): JournalEventPage => ({database: DATABASE, window: DELIVERED_DETAIL.window, events, nextCursor});
  const keys = (source: JournalEventPage, intervals: JournalInterval[], after: number | null) => journalTimelineItems(source, journalEventText(source, trip), intervals, {after, through: journalPageBound(source, after)}, 'ets2').map(item => item.key);
  const ids = (items: string[]) => items.filter(key => key.startsWith('interval-'));

  it('places every interval on exactly one page across a page boundary', () => {
    const intervals = [interval('1', 500), interval('2', 1_500), interval('3', 3_000), interval('4', 3_500), interval('5', 6_000), interval('6', null), interval('7', 2_500, {annotation: true, cause: 'refuel', kind: 'discontinuity'})];
    const first = page([event('1', 1_000), event('2', 2_000), event('3', 3_000)], '3'), second = page([event('4', 4_000), event('5', 5_000)], null);
    const pageOne = keys(first, intervals, null), pageTwo = keys(second, intervals, journalPageBound(first, null));
    expect(pageOne).toEqual(['interval-1', `${ETS2_A}:1`, 'interval-2', `${ETS2_A}:2`, 'interval-7', `${ETS2_A}:3`, 'interval-3']);
    expect(pageTwo).toEqual(['interval-4', `${ETS2_A}:4`, `${ETS2_A}:5`, 'interval-5', 'interval-6']);
    expect([...ids(pageOne), ...ids(pageTwo)].sort()).toEqual(['interval-1', 'interval-2', 'interval-3', 'interval-4', 'interval-5', 'interval-6', 'interval-7']);
  });
  it('does not repeat or drop a gap when a label jumps back or a page has no labels', () => {
    const intervals = [interval('1', 2_500)];
    const first = page([event('1', 3_000), event('2', 1_000)], '2'), second = page([event('3', 2_000)], null);
    expect(journalPageBound(first, null)).toBe(3_000);
    expect(ids(keys(first, intervals, null))).toEqual(['interval-1']);
    expect(ids(keys(second, intervals, journalPageBound(first, null)))).toEqual([]);
    const unlabelled = page([event('1', null)], '1'), last = page([], null);
    expect(ids(keys(unlabelled, intervals, null))).toEqual([]);
    expect(ids(keys(last, intervals, journalPageBound(unlabelled, null)))).toEqual(['interval-1']);
  });
  it('lists gaps and refuels but not other annotations, and keeps event order', () => {
    const intervals = [interval('1', 1_500, {annotation: true, cause: 'truck-change', kind: 'discontinuity'}), interval('2', 1_600, {kind: 'event-loss', cause: 'gap', firstEventSeq: '4', lastEventSeq: '6'})];
    const source = page([event('9', 1_000), event('10', 3_000)], null);
    const items = journalTimelineItems(source, journalEventText(source, trip, {timeZone: ZONE}), intervals, {after: null, through: 3_000}, 'ets2', {timeZone: ZONE});
    expect(items.map(item => item.kind)).toEqual(['event', 'gap', 'event']);
    expect(items[0]).toMatchObject({eventSeq: '9', tone: 'neutral'});
    expect(items[1]).toMatchObject({tone: 'warn', type: 'Gap: lost events', detail: 'Lost events · duration unknown', eventSeq: 'eventSeq 4–6', attribution: '—'});
  });
  it('shows a gap length only from monotonic bounds, and refuel litres only when they are a finite number', () => {
    const gap = interval('1', null, {startUtcMs: BASE_UTC, endUtcMs: BASE_UTC + 3_600_000, startMonotonicNs: '1000000000', endMonotonicNs: '47000000000'});
    const utcOnly = interval('2', null, {startUtcMs: BASE_UTC, endUtcMs: BASE_UTC + 3_600_000});
    const source = page([], null), text = journalEventText(source, trip);
    const items = journalTimelineItems(source, text, [gap, utcOnly, interval('3', 1, {annotation: true, cause: 'refuel', kind: 'discontinuity', detail: {addedLiters: 286}}), interval('4', 2, {annotation: true, cause: 'refuel', kind: 'discontinuity', detail: {addedLiters: 'many'}})], {after: null, through: null}, 'ets2', {units: DEFAULT, timeZone: ZONE});
    expect(items.find(item => item.key === 'interval-1')?.detail).toBe('Missing one-second samples · 46 s');
    expect(items.find(item => item.key === 'interval-2')?.detail).toBe('Missing one-second samples · duration unknown');
    expect(items.find(item => item.key === 'interval-3')).toMatchObject({kind: 'refuel', tone: 'ok', type: 'Refuelled', detail: '286.0 L', time: '1970-01-01 01:00:00'});
    expect(items.find(item => item.key === 'interval-4')).toMatchObject({kind: 'refuel', detail: '—'});
    expect(journalTimelineItems(source, text, [interval('3', 1, {annotation: true, cause: 'refuel', kind: 'discontinuity', detail: {addedLiters: 286}})], {after: null, through: null}, 'ats', {units: DEFAULT, timeZone: ZONE})[0].detail).toBe('75.6 US gal');
  });

  it('adds gap lengths as a union of monotonic spans and counts the unknown ones apart', () => {
    const items = [interval('1', 1, {startMonotonicNs: '1000000000', endMonotonicNs: '11000000000'}), interval('2', 2, {startMonotonicNs: '6000000000', endMonotonicNs: '16000000000'}),
      interval('3', 3), interval('4', 4, {annotation: true, cause: 'refuel', kind: 'discontinuity', startMonotonicNs: '1000000000', endMonotonicNs: '91000000000'})];
    const text = journalCompletenessText({...DELIVERED_DETAIL, samples: {count: 13_860, firstUtcMs: null, lastUtcMs: null}, intervals: {items, total: 4, nextCursor: null}});
    expect(text).toMatchObject({recorded: '3 h 51 min', gaps: '15 s · 1 of unknown duration', intervals: '4', partial: null,
      bar: {recordedSeconds: 13_860, gapSeconds: 15, gapCount: 3, label: 'Recorded 3 h 51 min, gaps without samples 15 s · 1 of unknown duration'}});
  });
  it('joins overlapping gaps only within one plugin session and clock', () => {
    const span = (id: string, changes: Partial<JournalInterval>) => interval(id, 1, {startMonotonicNs: '0', endMonotonicNs: '10000000000', ...changes});
    const gaps = (items: JournalInterval[]) => journalCompletenessText({...DELIVERED_DETAIL, intervals: {items, total: items.length, nextCursor: null}}).gaps;
    expect(gaps([span('1', {pluginSessionId: 'a'}), span('2', {pluginSessionId: 'b'})])).toBe('20 s');
    expect(gaps([span('1', {pluginSessionId: 'a'}), span('2', {pluginSessionId: 'a'})])).toBe('10 s');
    expect(gaps([span('1', {}), span('2', {})])).toBe('10 s');
    expect(gaps([span('1', {pluginSessionId: 'a'}), span('2', {})])).toBe('20 s');
    expect(gaps([span('1', {pluginSessionId: 'a', sourceClockId: 'x'}), span('2', {pluginSessionId: 'a', sourceClockId: 'y'})])).toBe('20 s');
  });
  it('draws only the gaps with no samples written in the bar and keeps every gap in the Gaps row', () => {
    const span = (id: string, from: number, to: number, changes: Partial<JournalInterval>) => interval(id, 1, {startMonotonicNs: `${from}000000000`, endMonotonicNs: `${to}000000000`, ...changes});
    const items = [span('1', 1, 11, {}), span('2', 20, 25, {kind: 'not-connected', cause: 'disconnected'}), interval('3', 1, {kind: 'not-connected', cause: 'consumer-restart'}),
      span('4', 30, 60, {kind: 'event-loss', cause: 'gap'}), span('5', 70, 80, {kind: 'discontinuity', cause: 'reload'}), span('6', 100, 120, {detail: {includesReadings: true}}),
      span('7', 130, 140, {kind: 'not-connected', cause: 'gap'}), span('8', 150, 160, {cause: 'sample-backlog'}), span('9', 170, 180, {kind: 'storage-unavailable', cause: null}), interval('10', 1, {kind: 'restore-loss', cause: null}),
      span('11', 200, 290, {kind: 'discontinuity', cause: 'refuel', annotation: true})];
    const text = journalCompletenessText({...DELIVERED_DETAIL, intervals: {items, total: items.length, nextCursor: null}});
    expect(text.gaps).toBe('1 min 45 s · 2 of unknown duration');
    expect(text.bar).toEqual({recordedSeconds: 3, gapSeconds: 15, gapCount: 3, gaps: '15 s · 1 of unknown duration', label: 'Recorded 3 s, gaps without samples 15 s · 1 of unknown duration'});
    const ru = journalCompletenessText({...DELIVERED_DETAIL, intervals: {items: [span('4', 30, 60, {kind: 'event-loss', cause: 'gap'})], total: 1, nextCursor: null}}, 'ru');
    expect(ru).toMatchObject({gaps: '30 с', bar: {gapCount: 0, gapSeconds: 0, gaps: 'нет', label: 'Записано 3 с, пропуски без сэмплов нет'}});
  });
  it('states the limit of the recorded value', () => {
    expect(journalCompletenessText(DELIVERED_DETAIL).recordedNote).toBe('Recorded time may include samples not counted in distance and fuel.');
    expect(journalCompletenessText(DELIVERED_DETAIL, 'ru').recordedNote).toBe('В записанное время могут входить сэмплы, не учтённые в дистанции и расходе.');
  });
  it('says none, says unknown and says when only the first intervals are in the total', () => {
    expect(journalCompletenessText(DELIVERED_DETAIL)).toMatchObject({recorded: '3 s', gaps: 'none', intervals: '0', bar: {gapCount: 0}});
    const utcOnly = interval('1', BASE_UTC, {endUtcMs: BASE_UTC + 3_600_000});
    expect(journalCompletenessText({...DELIVERED_DETAIL, samples: {count: 0, firstUtcMs: null, lastUtcMs: null}, intervals: {items: [utcOnly], total: 1, nextCursor: null}})).toMatchObject({recorded: '—', gaps: '1 of unknown duration', bar: {gapSeconds: 0}});
    expect(journalCompletenessText({...DELIVERED_DETAIL, intervals: {items: [utcOnly], total: 51, nextCursor: '1'}}, 'ru')).toMatchObject({gaps: 'без известной длительности: 1', intervals: '51', partial: 'Итог по пропускам учитывает первые 1 из 51 интервалов.'});
  });

  it.each([['en', 'none in the first 1', 'Recorded 3 s, gaps without samples none in the first 1'], ['ru', 'нет в первых 1', 'Записано 3 с, пропуски без сэмплов нет в первых 1']] as const)('does not say none when later intervals were not read in %s', (language, gaps, label) => {
    const annotation = interval('1', BASE_UTC, {annotation: true, cause: 'refuel', kind: 'discontinuity'});
    expect(journalCompletenessText({...DELIVERED_DETAIL, intervals: {items: [annotation], total: 51, nextCursor: '1'}}, language)).toMatchObject({gaps, bar: {gapCount: 0, label}});
  });

  const origin = 'https://dashboard.example', owner = {origin, accountId: 'a', companyId: 'c', identityEpoch: 'e'};
  it('REG-012/014 keeps an opened trip\'s list row and shows it only while its owner is current', () => {
    const status = {...initialDashboardUploadStatus(origin), state: 'connected' as const, owner};
    const row = {tripUuid: T.delivered, state: 'sent' as const, materialVersion: '1', latestRevision: 3, lastDurableUploadUtcMs: BASE_UTC + 5_000, reason: null};
    const page: JournalTripPage = {database: {purpose: 'history', schemaVersion: 6}, trips: [], nextCursor: null, sync: {owner, connectionVersion: '1', rows: [row]}};
    const hidden = [null, undefined, initialDashboardUploadStatus(origin), initialDashboardUploadStatus(null), {...status, state: 'verifying' as const}, {...status, owner: {...owner, identityEpoch: 'other'}}, {...status, origin: null}];
    const site = journalSiteFacts(page, status, T.delivered);
    expect(site).toEqual({owner, row});
    expect(journalSiteFacts(page, status, 'another-trip')).toBeNull();
    expect(journalSiteFacts(undefined, status, T.delivered)).toBeNull();
    expect(journalSiteFacts({...page, sync: undefined}, status, T.delivered)).toBeNull();
    for (const current of hidden) expect(journalSiteFacts(page, current, T.delivered)).toBeNull();
    expect(journalSiteRow(site, status)).toBe(row);
    expect(journalSiteRow(site, {...status, state: 'paused'})).toBe(row);
    for (const current of hidden) expect(journalSiteRow(site, current)).toBeNull();
    expect(journalSiteRow(null, status)).toBeNull();
  });
  it('REG-012/014 shows a trip\'s site facts only while sync is configured for the same settled owner', () => {
    const status = {...initialDashboardUploadStatus(origin), state: 'connected' as const, owner};
    expect(journalSyncOwnerCurrent(owner, status)).toBe(true);
    expect(journalSyncOwnerCurrent(owner, {...status, state: 'paused'})).toBe(true);
    for (const hidden of [null, undefined, initialDashboardUploadStatus(null), {...status, state: 'verifying' as const}, {...status, owner: {...owner, identityEpoch: 'other'}}, {...status, origin: null}]) expect(journalSyncOwnerCurrent(owner, hidden)).toBe(false);
    expect(journalSyncOwnerCurrent(undefined, status)).toBe(false);
  });
  it('words a durable upload as saved by the site and shows nothing for any other state', () => {
    const row = {tripUuid: T.delivered, state: 'sent' as const, materialVersion: '1', latestRevision: 3, lastDurableUploadUtcMs: BASE_UTC + 5_000, reason: null};
    expect(journalSiteSaved(row, {timeZone: ZONE})).toBe('Saved by the site 2026-10-11 02:00:05 · version 3');
    expect(journalSiteSaved(row, {timeZone: ZONE, language: 'ru'})).toBe('Сохранено сайтом 2026-10-11 02:00:05 · версия 3');
    expect(journalSiteSaved({...row, latestRevision: null}, {timeZone: ZONE})).toBe('Saved by the site 2026-10-11 02:00:05');
    expect(journalSiteSaved({...row, state: 'sending'})).toBeNull();
    expect(journalSiteSaved({...row, lastDurableUploadUtcMs: null})).toBeNull();
  });
});

describe('distance and fuel provenance and the pending profile check (ET-112e; REG-009, REG-014)', () => {
  type Accounting = NonNullable<JournalTripListItem['accounting']>;
  // As Q2 without the recorder link: both quantities keep their subtotal across a reading hole.
  const HOLE: Accounting = {engine: 1, distance: {status: 'partial', breaks: ['reading-hole'], quality: []}, fuel: {status: 'partial', breaks: ['reading-hole'], quality: []}};
  const COMPLETE: Accounting = {engine: 1, distance: {status: 'complete', breaks: [], quality: []}, fuel: {status: 'complete', breaks: [], quality: []}};
  const page = (trips: JournalTripListItem[]): JournalTripPage => ({database: DATABASE, trips, nextCursor: null});
  const row = (trip: JournalTripListItem, language: 'en' | 'ru' = 'en') => journalListText(page([trip]), {units: DEFAULT, timeZone: ZONE, filtered: false, language}).rows[0];
  const detailOf = (base: JournalTripDetail, trip: Partial<JournalTripListItem>): JournalTripDetail => ({...base, trip: {...base.trip, ...trip}});
  const notes = (detail: JournalTripDetail, language: 'en' | 'ru' = 'en') => {
    const sections = journalDetailText(detail, {units: DEFAULT, timeZone: ZONE, language}).sections;
    const note = (section: string, id: string) => sections.find(s => s.id === section)!.fields.find(f => f.id === id)!;
    return {distance: note('distance', 'observedDistance'), fuel: note('fuel', 'fuelUsed')};
  };
  // The delivered anchor with 30 L of fuel used, so both values are available.
  const DELIVERED_FUEL = detailOf(DELIVERED_DETAIL, {fuelUsedL: value(30)});

  it.each([['en', 'partial', '152.0 km'], ['ru', 'частично', '152.0 км']] as const)('marks a partial distance on the list row without changing its value in %s', (language, partial, observed) => {
    const text = row({...DELIVERED, fuelUsedL: value(30), accounting: HOLE}, language);
    expect(text.distancePartial).toBe(partial);
    expect(text.observedDistance).toBe(observed);
  });
  it('marks nothing for a complete zero distance or a trip without provenance', () => {
    const zero = row({...ZERO, accounting: COMPLETE});
    expect(zero.observedDistance).toBe('0.0 mi'); expect(zero).not.toHaveProperty('distancePartial');
    expect(row(DELIVERED)).not.toHaveProperty('distancePartial'); expect(row(DELIVERED)).not.toHaveProperty('membership');
  });
  it.each([['en', 'odometer while recording; partial: readings missing', 'while recording, refuels excluded; partial: readings missing'],
    ['ru', 'одометр во время записи; частично: пропуск показаний', 'во время записи, без заправок; частично: пропуск показаний']] as const)(
    'names the reasons of a partial value in the detail notes and keeps the values in %s', (language, distance, fuel) => {
      const found = notes(detailOf(DELIVERED_FUEL, {accounting: HOLE}), language), plain = notes(DELIVERED_FUEL, language);
      expect([found.distance.note, found.fuel.note]).toEqual([distance, fuel]);
      expect([found.distance.value, found.fuel.value]).toEqual([plain.distance.value, plain.fuel.value]);
    });
  it('adds quality notes, leaves out the refuel the fuel note already states and names the reasons of an unavailable value', () => {
    const quality = notes(detailOf(DELIVERED_FUEL, {accounting: {engine: 1, distance: {status: 'complete', breaks: [], quality: ['bridged', 'restored']},
      fuel: {status: 'complete', breaks: [], quality: ['refuel-excluded']}}}));
    expect([quality.distance.note, quality.fuel.note]).toEqual(['odometer while recording; bridged across missing readings, restored after a save load', 'while recording, refuels excluded']);
    // An unproven rollback (E7): both values unavailable, with the reasons, never zero.
    const unproven = notes(detailOf(DELIVERED_DETAIL, {observedDistanceM: NO, fuelUsedL: NO, accounting: {engine: 1,
      distance: {status: 'unavailable', breaks: ['recording-gap', 'unsupported'], quality: []}, fuel: {status: 'unavailable', breaks: ['recording-boundary', 'unsupported'], quality: []}}}));
    expect(unproven.distance).toMatchObject({value: 'unavailable (not observed)',
      note: 'odometer while recording; gap between recordings, progress could not be matched after a save load or truck change'});
    expect(unproven.fuel).toMatchObject({value: 'unavailable (not observed)',
      note: 'while recording, refuels excluded; not continuous between recordings, progress could not be matched after a save load or truck change'});
    // Unavailable without a reason (no complete reading yet) keeps today's note.
    const none = notes(detailOf(DELIVERED_DETAIL, {observedDistanceM: NO, accounting: {...COMPLETE, distance: {status: 'unavailable', breaks: [], quality: []}}}));
    expect(none.distance).toMatchObject({value: 'unavailable (not observed)', note: 'odometer while recording'});
  });
  it('keeps the notes of a trip without provenance', () => {
    const plain = notes(DELIVERED_FUEL);
    expect([plain.distance.note, plain.fuel.note]).toEqual(['odometer while recording', 'while recording, refuels excluded']);
  });
  it.each([['en', 'Profile check pending'], ['ru', 'Ожидает проверки профиля']] as const)('shows the pending profile check on the row and the detail in %s', (language, text) => {
    expect(row({...DELIVERED, membership: 'pending'}, language).membership).toBe(text);
    expect(journalDetailText(detailOf(DELIVERED_DETAIL, {membership: 'pending'}), {language}).membership).toBe(text);
    expect(journalDetailText(DELIVERED_DETAIL, {language})).not.toHaveProperty('membership');
  });
  it('labels a partial distance on the tile and keeps the odometer distance apart from the game distance', () => {
    expect(journalTileValues(detailOf(DELIVERED_FUEL, {accounting: HOLE}))).toMatchObject({
      distanceTile: {label: 'According to the game', value: '151.3 km', notes: ['odometer 152.0 km · partial', 'planned 152.0 km']}, fuelPartial: 'partial: readings missing'});
    const cancelled = detailOf(CANCELLED_DETAIL, {observedDistanceM: value(152_000.5), fuelUsedL: value(30), accounting: HOLE});
    expect(journalTileValues(cancelled)).toMatchObject({
      distanceTile: {label: 'Distance observed', value: '152.0 km', notes: ['planned 152.0 km', 'partial: readings missing']}, fuelPartial: 'partial: readings missing'});
    expect(journalTileValues(cancelled, {language: 'ru'}).distanceTile).toEqual({label: 'Пройдено по одометру', value: '152.0 км', notes: ['по заказу 152.0 км', 'частично: пропуск показаний']});
    // A delivery without the game's distance keeps the observed hero and names the missing game value.
    expect(journalTileValues(ZERO_DETAIL).distanceTile).toEqual({label: 'Distance observed', value: '0.0 mi', notes: ['planned 0.0 mi', 'game reported unavailable (not provided by the game)']});
    expect(journalTileValues(OPEN_DETAIL).distanceTile).toEqual({label: 'Distance observed', value: '—', notes: ['unavailable (not observed)', 'planned 152.0 km']});
  });
});
