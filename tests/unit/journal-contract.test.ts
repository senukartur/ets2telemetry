// ET-016 PR-3 (J4, J10, J11): the journal query contract between the dashboard, main and the telemetry service. Main parses
// every invoke with exact argument counts and fixes the page size; the service parses main's query again; main accepts
// a service reply only when it answers the request exactly. Expected values are written by hand from the journal
// contract and J5/J10/J11 (REG-014).
import {describe, expect, it} from 'vitest';
import {copyTripsQuery, journalRequest, parseJournalQuery, parseJournalReply, type JournalQuery} from '../../apps/desktop/src/journal-contract';
import {changed, DETAIL, EVENT, EVENT_PAGE, INTERVAL, INTERVAL_PAGE, LIST_ITEM, numbered, SAMPLE, SAMPLE_PAGE, TRIP, TRIP_PAGE} from '../shared/journal-replies';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

const OTHER_TRIP = '7a000000-0000-4000-8000-000000000002';
const MAX_ROW = '9223372036854775807', MAX_EVENT = '18446744073709551614';
const LIST_CURSOR = 'l5:00000000-0000-4000-8000-000000000001:5:9:any.any.any.unknown.other';

describe('main parses each journal invoke with its exact argument count and fixes the page size (J10)', () => {
  it.each<[string, Parameters<typeof journalRequest>[0], unknown[], JournalQuery]>([
    ['list-trips without a filter', 'trips', [{}], {kind: 'trips', query: {}}],
    ['list-trips with every filter', 'trips', [{cursor: MAX_ROW, game: 'ats', outcome: 'none', completeness: 'unknown'}],
      {kind: 'trips', query: {cursor: MAX_ROW, game: 'ats', outcome: 'none', completeness: 'unknown'}}],
    ['list-trips with an undefined filter field', 'trips', [{game: undefined, outcome: 'open'}], {kind: 'trips', query: {outcome: 'open'}}],
    ['list-trips with mode and job type', 'trips', [{mode: 'convoy', jobType: 'world-of-trucks'}], {kind: 'trips', query: {mode: 'convoy', jobType: 'world-of-trucks'}}],
    ['list-trips with a list cursor', 'trips', [{cursor: LIST_CURSOR, mode: 'unknown', jobType: 'other'}], {kind: 'trips', query: {cursor: LIST_CURSOR, mode: 'unknown', jobType: 'other'}}],
    ['get-trip', 'trip', [TRIP], {kind: 'trip', tripUuid: TRIP}],
    ['list-events, first page', 'events', [TRIP, null], {kind: 'events', tripUuid: TRIP, page: {limit: 100}}],
    ['list-events after the last eventSeq', 'events', [TRIP, MAX_EVENT], {kind: 'events', tripUuid: TRIP, page: {cursor: MAX_EVENT, limit: 100}}],
    ['list-intervals after an interval', 'intervals', [TRIP, '7'], {kind: 'intervals', tripUuid: TRIP, page: {cursor: '7', limit: 100}}],
    ['list-samples, first page', 'samples', [TRIP, null], {kind: 'samples', tripUuid: TRIP, page: {limit: 300}}],
    ['list-samples after the largest row id', 'samples', [TRIP, MAX_ROW], {kind: 'samples', tripUuid: TRIP, page: {cursor: MAX_ROW, limit: 300}}]
  ])('accepts %s', (_name, kind, args, expected) => {
    expect(journalRequest(kind, args)).toEqual(expected);
  });

  it.each<[string, Parameters<typeof journalRequest>[0], unknown[]]>([
    ['list-trips without an argument', 'trips', []],
    ['list-trips with two arguments', 'trips', [{}, {}]],
    ['list-trips with a page size', 'trips', [{limit: 51}]],
    ['list-trips with an unlisted game', 'trips', [{game: 'ets'}]],
    ['list-trips with an unlisted outcome', 'trips', [{outcome: 'open,delivered'}]],
    ['list-trips with an unlisted completeness', 'trips', [{completeness: 'full'}]],
    ['list-trips with an unlisted mode', 'trips', [{mode: 'coop'}]],
    ['list-trips with an unlisted job type', 'trips', [{jobType: 'external_market'}]],
    ['list-trips with a retired l4 cursor', 'trips', [{cursor: 'l4:00000000-0000-4000-8000-000000000001:5:9:any.any.any'}]],
    ['list-trips with cursor 0', 'trips', [{cursor: '0'}]],
    ['list-trips with a cursor beyond 2^63 - 1', 'trips', [{cursor: '9223372036854775808'}]],
    ['list-trips with a numeric cursor', 'trips', [{cursor: 5}]],
    ['list-trips with a filter array', 'trips', [['ets2']]],
    ['list-trips with a null filter', 'trips', [null]],
    ['get-trip without an argument', 'trip', []],
    ['get-trip with two arguments', 'trip', [TRIP, null]],
    ['get-trip with an upper-case UUID', 'trip', [TRIP.toUpperCase()]],
    ['get-trip with a path', 'trip', ['C:\\Users\\owner\\telemetry.sqlite']],
    ['get-trip with a braced UUID', 'trip', [`{${TRIP}}`]],
    ['list-events with one argument', 'events', [TRIP]],
    ['list-events with an undefined cursor', 'events', [TRIP, undefined]],
    ['list-events with three arguments', 'events', [TRIP, null, 500]],
    ['list-events beyond the last eventSeq', 'events', [TRIP, '18446744073709551615']],
    ['list-events with cursor 0', 'events', [TRIP, '0']],
    ['list-intervals with a cursor beyond 2^63 - 1', 'intervals', [TRIP, '9223372036854775808']],
    ['list-intervals with a leading zero', 'intervals', [TRIP, '07']],
    ['list-samples with an invalid UUID', 'samples', ['7a000000-0000-4000-8000-00000000000', null]],
    ['list-samples with a numeric cursor', 'samples', [TRIP, 11]],
    ['list-samples with a private export flag', 'samples', [TRIP, null, {includeExcluded: true}]],
    ['list-samples with a private export cursor object', 'samples', [TRIP, {includeExcluded: true}]]
  ])('refuses %s', (_name, kind, args) => {
    expect(journalRequest(kind, args)).toBeUndefined();
  });

  it('reads only own listed filter fields, each once, into a fresh copy', () => {
    const inherited = Object.assign(Object.create({cursor: '5', game: 'ats'}) as object, {outcome: 'delivered'});
    expect(copyTripsQuery(inherited)).toEqual({outcome: 'delivered'});
    const original = {game: 'ets2'}, copy = copyTripsQuery(original);
    expect(copy).toEqual({game: 'ets2'});
    expect(copy).not.toBe(original);
    expect(copyTripsQuery(undefined)).toEqual({});
    expect(copyTripsQuery({path: 'C:\\'})).toBeUndefined();
  });
});

describe('the service parses the query main sent (J4)', () => {
  it('copies the explicit private sample mode and refuses it on other queries or in renderer arguments', () => {
    const query = {kind: 'samples', tripUuid: TRIP, includeExcluded: true, page: {limit: 300}};
    const parsed = parseJournalQuery(query); expect(parsed).toEqual(query); expect(parsed).not.toBe(query);
    expect((parsed as {page: object}).page).not.toBe(query.page);
    expect(parseJournalQuery({...query, includeExcluded: 'true'})).toBeUndefined();
    expect(parseJournalQuery({...query, kind: 'events'})).toBeUndefined();
    expect(parseJournalQuery({...query, page: {...query.page, includeExcluded: true}})).toBeUndefined();
    expect(journalRequest('samples', [TRIP, null])).toEqual({kind: 'samples', tripUuid: TRIP, page: {limit: 300}});
  });
  it('accepts the dashboard and export page sizes of each read', () => {
    for (const query of [{kind: 'events', tripUuid: TRIP, page: {limit: 500, cursor: '9'}}, {kind: 'intervals', tripUuid: TRIP, page: {limit: 500}},
      {kind: 'samples', tripUuid: TRIP, page: {limit: 3_600, cursor: '1'}}, {kind: 'trips', query: {completeness: 'partial'}}, {kind: 'trip', tripUuid: TRIP}]) {
      expect(parseJournalQuery(query)).toEqual(query);
    }
  });
  it.each([
    ['an unknown kind', {kind: 'export', tripUuid: TRIP}],
    ['a database query with a trip', {kind: 'database', tripUuid: TRIP}],
    ['a trip page size', {kind: 'trips', query: {limit: 50}}],
    ['an events page of 51', {kind: 'events', tripUuid: TRIP, page: {limit: 51}}],
    ['an events page of 300', {kind: 'events', tripUuid: TRIP, page: {limit: 300}}],
    ['a samples page of 500', {kind: 'samples', tripUuid: TRIP, page: {limit: 500}}],
    ['a page with an extra field', {kind: 'intervals', tripUuid: TRIP, page: {limit: 100, after: '1'}}],
    ['a query with an extra field', {kind: 'trip', tripUuid: TRIP, path: 'C:\\'}],
    ['a missing page', {kind: 'samples', tripUuid: TRIP}],
    ['an event cursor beyond the last eventSeq', {kind: 'events', tripUuid: TRIP, page: {limit: 100, cursor: '18446744073709551615'}}],
    ['not an object', 'trips']
  ])('refuses %s', (_name, query) => {
    expect(parseJournalQuery(query)).toBeUndefined();
  });
});

const TRIPS: JournalQuery = {kind: 'trips', query: {}};
const DETAIL_QUERY: JournalQuery = {kind: 'trip', tripUuid: TRIP};
const EVENTS: JournalQuery = {kind: 'events', tripUuid: TRIP, page: {limit: 100}};
const INTERVALS: JournalQuery = {kind: 'intervals', tripUuid: TRIP, page: {cursor: '6', limit: 100}};
const SAMPLES: JournalQuery = {kind: 'samples', tripUuid: TRIP, page: {cursor: '10', limit: 300}};
/** A whole reply in a refusal table, instead of a value wrapped as {ok: true, value}. */
class Raw {constructor(readonly reply: unknown) {}}
const raw = (reply: unknown) => new Raw(reply);
/** A cargo name of 257 UTF-8 bytes, one over the protocol's NAME_BYTES. */
const LONG_NAME = 'é'.repeat(128) + 'x';
/** A job market of 129 UTF-8 bytes, one over the protocol's ID_BYTES (ET-072). */
const LONG_MARKET = 'é'.repeat(64) + 'x';

describe('the export header read (ET-016 PR-5)', () => {
  const DATABASE_UUID = 'f0000000-0000-4000-8000-000000000001', INFO = {database: {purpose: 'history', schemaVersion: 2}, databaseUuid: DATABASE_UUID};
  it('is a query of exactly its kind', () => {
    expect(parseJournalQuery({kind: 'database'})).toEqual({kind: 'database'});
  });
  it('forwards exactly the database purpose, schema version and UUID', () => {
    expect(parseJournalReply({kind: 'database'}, {ok: true, value: INFO})).toEqual({ok: true, value: INFO});
    expect(parseJournalReply({kind: 'database'}, {ok: false, code: 'DATABASE_OPENING'})).toEqual({ok: false, code: 'DATABASE_OPENING'});
  });
  it.each<[string, unknown]>([
    ['an extra path', {...INFO, path: 'C:\\Users\\owner\\telemetry.sqlite'}],
    ['an upper-case UUID', {...INFO, databaseUuid: DATABASE_UUID.toUpperCase()}],
    ['no UUID', {database: INFO.database}],
    ['an unlisted purpose', {...INFO, database: {purpose: 'test', schemaVersion: 2}}],
    ['schema version 0', {...INFO, database: {purpose: 'history', schemaVersion: 0}}],
    ['an extra database field', {...INFO, database: {...INFO.database, file: 'telemetry.sqlite'}}]
  ])('refuses an answer with %s', (_name, value) => {
    expect(parseJournalReply({kind: 'database'}, {ok: true, value})).toBeUndefined();
  });
});

describe('main accepts a service reply only when it answers the request exactly (J10, J11)', () => {
  it('accepts qualified delivered trips with null compatibility evidence, while retaining outcome and loss checks', () => {
    const details = advanceHardMode(null, evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture'));
    const item = {...LIST_ITEM, isHardMode: true, hardModeDetails: details, outcome: 'delivered', closeReason: 'outcome', endedUtcMs: LIST_ITEM.startedUtcMs + 1000};
    const reply = {ok: true, value: {...TRIP_PAGE, trips: [item]}};
    expect(details.manualDelivery).toBeNull(); expect(parseJournalReply(TRIPS, reply)).toEqual(reply);
    const legacy = {...reply, value: {...reply.value, trips: [{...item, hardModeDetails: {...details, manualDelivery: true}}]}};
    expect(parseJournalReply(TRIPS, legacy)).toEqual(legacy);
    const contradictory = {...item, hardModeDetails: {...details, manualDelivery: false}};
    expect(parseJournalReply(TRIPS, {...reply, value: {...reply.value, trips: [contradictory]}})).toBeUndefined();
    const unqualified = {...reply, value: {...reply.value, trips: [{...contradictory, isHardMode: false}]}};
    expect(parseJournalReply(TRIPS, unqualified)).toEqual(unqualified);
    for (const outcome of ['open', 'cancelled']) {
      const other = {...item, outcome, ...(outcome === 'open' ? {closeReason: null, endedUtcMs: null} : {})};
      expect(parseJournalReply(TRIPS, {...reply, value: {...reply.value, trips: [{...other, isHardMode: false}]}})).toBeDefined();
      expect(parseJournalReply(TRIPS, {...reply, value: {...reply.value, trips: [other]}})).toBeUndefined();
    }
    const firstLoss = {atUtcMs: 1000, reason: 'parking-unproven', rule: null, values: null};
    expect(parseJournalReply(TRIPS, {...reply, value: {...reply.value, trips: [{...item, hardModeDetails: {...details, firstLoss}}]}})).toBeUndefined();
    expect(parseJournalReply(TRIPS, {...reply, value: {...reply.value, trips: [{...item, hardModeDetails: null}]}})).toBeUndefined();
  });
  it.each<[string, JournalQuery, unknown]>([
    ['a trip page', TRIPS, TRIP_PAGE],
    ['a filtered trip page', {kind: 'trips', query: {game: 'ets2', outcome: 'open', completeness: 'partial', cursor: '9'}}, TRIP_PAGE],
    ['a full trip page whose cursor is below the requested one', {kind: 'trips', query: {cursor: '60'}}, {...TRIP_PAGE, trips: Array(50).fill(LIST_ITEM), nextCursor: '10'}],
    ['a trip detail', DETAIL_QUERY, DETAIL],
    ['an event page', EVENTS, EVENT_PAGE],
    ['a full event page', EVENTS, {...EVENT_PAGE, events: numbered(EVENT, 'eventSeq', 100), nextCursor: '100'}],
    ['an interval page', INTERVALS, INTERVAL_PAGE],
    // An interval's detail is an open record: its cause-specific keys are forwarded as stored (docs/journal.md).
    ['an interval whose detail carries cause-specific keys', INTERVALS, changed(INTERVAL_PAGE, p => {
      p.intervals[0].detail = {cause: 'truck-change', annotation: true, atEventSeq: '2', count: 3} as typeof INTERVAL.detail; })],
    ['a sample page', SAMPLES, SAMPLE_PAGE],
    ['a full sample page', SAMPLES, {...SAMPLE_PAGE, samples: numbered(SAMPLE, 'id', 300, 11), nextCursor: '310'}],
    ['an empty sample page', SAMPLES, {...SAMPLE_PAGE, samples: []}],
    // ET-072: the job summary's market is forwarded raw, up to the protocol's id bound; an unknown value is not refused.
    ['a trip whose job market is 128 bytes', TRIPS, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: true, value: 'é'.repeat(64)}; })],
    ['a trip of an unknown job market without a special-job flag', TRIPS, changed(TRIP_PAGE, p => {
      p.trips[0].job.market = {available: true, value: 'future_market'}; p.trips[0].job.isSpecialJob = {available: false, reason: 'not-supported'} as never; })],
    // ET-076: every row answers the mode and job type filter; an unavailable or unlisted market is `other`.
    ['a trip of the filtered mode', {kind: 'trips', query: {mode: 'unknown'}}, TRIP_PAGE],
    ['a trip of the filtered job type', {kind: 'trips', query: {jobType: 'freight-market'}}, TRIP_PAGE],
    ['an unavailable market under the other job type', {kind: 'trips', query: {jobType: 'other'}}, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: false, reason: 'not-supported'} as never; })],
    ['an unlisted market under the other job type', {kind: 'trips', query: {jobType: 'other'}}, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: true, value: 'foo_market'}; })],
    ['an external market under World of Trucks', {kind: 'trips', query: {jobType: 'world-of-trucks'}}, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: true, value: 'external_market'}; })],
    ['a first page with totals', TRIPS, {...TRIP_PAGE, totals: {trips: 1, recordedSeconds: 3_600}}],
    ['a full first page whose totals count more trips', TRIPS, {...TRIP_PAGE, trips: Array(50).fill(LIST_ITEM), nextCursor: '10', totals: {trips: 130, recordedSeconds: 0}}]
  ])('forwards %s unchanged', (_name, query, value) => {
    expect(parseJournalReply(query, {ok: true, value})).toEqual({ok: true, value});
  });

  it.each(['SERVICE_UNAVAILABLE', 'DATABASE_OPENING', 'BUSY', 'TIMEOUT', 'NOT_FOUND', 'FAILED'])('forwards the refusal %s', code => {
    expect(parseJournalReply(TRIPS, {ok: false, code})).toEqual({ok: false, code});
  });
  it('forwards DATABASE_UNAVAILABLE with its storage code', () => {
    expect(parseJournalReply(EVENTS, {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'PERMISSION_DENIED'}))
      .toEqual({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'PERMISSION_DENIED'});
  });

  it.each<[string, JournalQuery, unknown]>([
    // Refusals: exactly a listed code, and a storage code only with DATABASE_UNAVAILABLE.
    ['an unlisted code', TRIPS, raw({ok: false, code: 'JOURNAL_ANSWER_INVALID'})],
    ['a refusal with a message', TRIPS, raw({ok: false, code: 'FAILED', message: 'C:\\Users\\owner\\telemetry.sqlite is locked'})],
    ['DATABASE_UNAVAILABLE without its storage code', TRIPS, raw({ok: false, code: 'DATABASE_UNAVAILABLE'})],
    ['DATABASE_UNAVAILABLE with a recorder code', TRIPS, raw({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'BACKLOG_FULL'})],
    ['a storage code on another refusal', TRIPS, raw({ok: false, code: 'BUSY', storageCode: 'STORAGE_BUSY'})],
    ['a success without a value', TRIPS, raw({ok: true})],
    ['a success with an extra field', TRIPS, raw({ok: true, value: TRIP_PAGE, error: null})],
    ['a reply that is not an object', TRIPS, raw('ok')],
    ['a missing value', DETAIL_QUERY, undefined],
    // Pages larger than requested, or not tied to the request.
    ['51 trips on a page', TRIPS, changed(TRIP_PAGE, p => { p.trips = Array<typeof LIST_ITEM>(51).fill(LIST_ITEM); })],
    ['a trip of another game than the filter', {kind: 'trips', query: {game: 'ats'}}, TRIP_PAGE],
    ['a trip of another outcome than the filter', {kind: 'trips', query: {outcome: 'delivered'}}, TRIP_PAGE],
    ['a trip of another completeness than the filter', {kind: 'trips', query: {completeness: 'complete'}}, TRIP_PAGE],
    ['a trip of another mode than the filter', {kind: 'trips', query: {mode: 'truckersmp'}}, TRIP_PAGE],
    ['a trip of another job type than the filter', {kind: 'trips', query: {jobType: 'quick-job'}}, TRIP_PAGE],
    ['an unavailable market under World of Trucks', {kind: 'trips', query: {jobType: 'world-of-trucks'}}, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: false, reason: 'not-supported'} as never; })],
    ['an unlisted market under a listed job type', {kind: 'trips', query: {jobType: 'freight-market'}}, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: true, value: 'foo_market'}; })],
    ['totals on a later page', {kind: 'trips', query: {cursor: '60'}}, {...TRIP_PAGE, totals: {trips: 1, recordedSeconds: 0}}],
    ['totals below the page size', TRIPS, {...TRIP_PAGE, trips: Array(2).fill(LIST_ITEM), totals: {trips: 1, recordedSeconds: 0}}],
    ['totals other than the rows of the last page', TRIPS, {...TRIP_PAGE, totals: {trips: 2, recordedSeconds: 0}}],
    ['a fractional totals count', TRIPS, {...TRIP_PAGE, totals: {trips: 1, recordedSeconds: 0.5}}],
    ['totals with an extra key', TRIPS, {...TRIP_PAGE, totals: {trips: 1, recordedSeconds: 0, hours: 0}}],
    ['a next trip cursor at the requested one', {kind: 'trips', query: {cursor: '60'}}, {...TRIP_PAGE, trips: Array(50).fill(LIST_ITEM), nextCursor: '60'}],
    ['a trip row with a process id', TRIPS, changed(TRIP_PAGE, p => { (p.trips[0] as Record<string, unknown>).processId = 4242; })],
    ['a trip row with a path', TRIPS, changed(TRIP_PAGE, p => { (p as Record<string, unknown>).path = 'C:\\Users\\owner'; })],
    ['a cargo name over the protocol name bound', TRIPS, changed(TRIP_PAGE, p => { p.trips[0].job.cargo = {available: true, value: LONG_NAME} as never; })],
    // ET-072: the job market and special-job flag of the job summary.
    ['a job summary without its market', TRIPS, changed(TRIP_PAGE, p => { delete (p.trips[0].job as {market?: unknown}).market; })],
    ['a job summary without its special-job flag', TRIPS, changed(TRIP_PAGE, p => { delete (p.trips[0].job as {isSpecialJob?: unknown}).isSpecialJob; })],
    ['a numeric job market', TRIPS, changed(TRIP_PAGE, p => { (p.trips[0].job as {market: unknown}).market = {available: true, value: 1}; })],
    ['a numeric special-job flag', TRIPS, changed(TRIP_PAGE, p => { (p.trips[0].job as {isSpecialJob: unknown}).isSpecialJob = {available: true, value: 0}; })],
    ['a job market over the protocol id bound', TRIPS, changed(TRIP_PAGE, p => { p.trips[0].job.market = {available: true, value: LONG_MARKET}; })],
    ['a detail whose job summary market is over the protocol id bound', DETAIL_QUERY, changed(DETAIL, p => { p.trip.job.market = {available: true, value: LONG_MARKET}; })],
    ['an unavailable distance without its reason', TRIPS, changed(TRIP_PAGE, p => { (p.trips[0] as {observedDistanceM: unknown}).observedDistanceM = {available: false}; })],
    ['the detail of another trip', {kind: 'trip', tripUuid: OTHER_TRIP}, DETAIL],
    ['a detail with a Windows session id', DETAIL_QUERY, changed(DETAIL, p => { (p.trip as Record<string, unknown>).windowsSessionId = 1; })],
    ['101 events for a page of 100', EVENTS, {...EVENT_PAGE, events: numbered(EVENT, 'eventSeq', 101), nextCursor: '101'}],
    ['events out of order', EVENTS, changed(EVENT_PAGE, p => { p.events.reverse(); })],
    ['an event at the requested cursor', {kind: 'events', tripUuid: TRIP, page: {cursor: '3', limit: 100}}, EVENT_PAGE],
    ['a full event page whose cursor is not its last event', EVENTS, {...EVENT_PAGE, events: numbered(EVENT, 'eventSeq', 100), nextCursor: '99'}],
    ['an event record over the protocol name bound', EVENTS, changed(EVENT_PAGE, p => { (p.events[0].record as {cargo: unknown}).cargo = {available: true, value: LONG_NAME}; })],
    ['an interval detail whose cause disagrees with the interval', INTERVALS, changed(INTERVAL_PAGE, p => { p.intervals[0].detail.cause = 'refuel'; })],
    ['an interval detail that is not an object', INTERVALS, changed(INTERVAL_PAGE, p => { (p.intervals[0] as {detail: unknown}).detail = 'C:\\Users\\owner'; })],
    ['an interval at the requested cursor', {kind: 'intervals', tripUuid: TRIP, page: {cursor: '7', limit: 100}}, INTERVAL_PAGE],
    ['101 intervals for a page of 100', INTERVALS, {...INTERVAL_PAGE, intervals: numbered(INTERVAL, 'id', 101, 7), total: 101, nextCursor: '107'}],
    ['301 samples for a page of 300', SAMPLES, {...SAMPLE_PAGE, samples: numbered(SAMPLE, 'id', 301, 11), nextCursor: '311'}],
    ['a full sample page without a cursor', SAMPLES, {...SAMPLE_PAGE, samples: numbered(SAMPLE, 'id', 300, 11)}],
    ['a cursor on a short sample page', SAMPLES, {...SAMPLE_PAGE, nextCursor: '11'}],
    ['a sample of another trip', SAMPLES, changed(SAMPLE_PAGE, p => { p.samples[0].tripUuid = OTHER_TRIP; })],
    ['a sample without a trip', SAMPLES, changed(SAMPLE_PAGE, p => { (p.samples[0] as {tripUuid: unknown}).tripUuid = null; })],
    ['a sample at the requested cursor', {kind: 'samples', tripUuid: TRIP, page: {cursor: '11', limit: 300}}, SAMPLE_PAGE],
    ['samples out of order', SAMPLES, {...SAMPLE_PAGE, samples: [{...SAMPLE, id: '12'}, SAMPLE]}],
    ['a sample with a process id', SAMPLES, changed(SAMPLE_PAGE, p => { (p.samples[0] as Record<string, unknown>).processId = 4242; })],
    ['an unavailable sample value read as zero without a reason', SAMPLES, changed(SAMPLE_PAGE, p => { (p.samples[0] as {fuel: unknown}).fuel = {available: false, value: 0}; })],
    ['a sample value that is not finite', SAMPLES, changed(SAMPLE_PAGE, p => { p.samples[0].speed = {available: true, value: Number.NaN}; })],
    ['negative game minutes', SAMPLES, changed(SAMPLE_PAGE, p => { p.samples[0].gameTime.minutes = {available: true, value: -1}; })],
    ['a position without z', SAMPLES, changed(SAMPLE_PAGE, p => { (p.samples[0].position as {value: unknown}).value = {x: 1, y: 2}; })],
    ['an upper-case clock id', SAMPLES, changed(SAMPLE_PAGE, p => { p.samples[0].sourceClockId = p.samples[0].sourceClockId.toUpperCase(); })],
    ['a sample page of another database purpose', SAMPLES, changed(SAMPLE_PAGE, p => { p.database.purpose = 'game'; })],
    ['a sample page without its database', SAMPLES, {samples: [SAMPLE], nextCursor: null}]
  ])('refuses %s', (_name, query, value) => {
    const reply = value instanceof Raw ? value.reply : {ok: true, value};
    expect(parseJournalReply(query, reply)).toBeUndefined();
  });
});

it('REG-010/014 accepts exactly ordered bounded sync rows and rejects malformed owner, version, row state and private facts', () => {
  const owner = {origin: 'https://dashboard.example', accountId: 'a', companyId: 'c', identityEpoch: 'e'};
  const sync = {owner, connectionVersion: '2', rows: [{tripUuid: TRIP, state: 'sent', materialVersion: '3', latestRevision: 1, lastDurableUploadUtcMs: 5000, reason: null}]};
  const value = {...TRIP_PAGE, database: {purpose: 'history', schemaVersion: 6}, sync}, query = {kind: 'trips', query: {}} as const;
  expect(parseJournalReply(query, {ok: true, value})).toEqual({ok: true, value});
  for (const change of [
    {sync: {...sync, credentialGeneration: 'private'}}, {sync: {...sync, owner: {...owner, token: 'private'}}}, {sync: {...sync, connectionVersion: '02'}},
    {sync: {...sync, connectionVersion: '18446744073709551616'}}, {sync: {...sync, rows: []}}, {sync: {...sync, rows: [...sync.rows, ...sync.rows]}},
    {sync: {...sync, rows: [{...sync.rows[0], tripUuid: OTHER_TRIP}]}}, {sync: {...sync, rows: [{...sync.rows[0], state: 'accepted'}]}},
    {sync: {...sync, rows: [{...sync.rows[0], lastDurableUploadUtcMs: null}]}}, {sync: {...sync, rows: [{...sync.rows[0], state: 'queued'}]}},
    {sync: {...sync, rows: [{...sync.rows[0], materialVersion: '0'}]}},
    {sync: {...sync, rows: [{...sync.rows[0], state: 'sending', latestRevision: null, lastDurableUploadUtcMs: null}]}}, {database: {purpose: 'synthetic', schemaVersion: 6}}
  ]) expect(parseJournalReply(query, {ok: true, value: {...value, ...change}}), JSON.stringify(change)).toBeUndefined();
  expect(journalRequest('trips', [{owner}])).toBeUndefined(); expect(journalRequest('trips', [{}, owner])).toBeUndefined();
});

describe('ET-112e quantity provenance and the pending profile check on list rows and the detail (REG-010, REG-014)', () => {
  // LIST_ITEM's distance is 0 m, a value, and its fuel used is unavailable; the closed variant has no outcome.
  const CLOSED = {outcome: 'none', closeReason: 'restart', endedUtcMs: LIST_ITEM.startedUtcMs + 1000};
  const ACCOUNTING = {engine: 1, distance: {status: 'partial', breaks: ['position-jump', 'recording-gap'], quality: ['bridged', 'restored']},
    fuel: {status: 'unavailable', breaks: ['unsupported'], quality: ['refuel-excluded']}};
  const replies = (item: Record<string, unknown>): [JournalQuery, unknown][] => [[TRIPS, {ok: true, value: {...TRIP_PAGE, trips: [{...LIST_ITEM, ...CLOSED, ...item}]}}],
    [DETAIL_QUERY, {ok: true, value: {...DETAIL, trip: {...DETAIL.trip, ...CLOSED, ...item}}}]];
  it.each<[string, Record<string, unknown>]>([
    ['a partial distance and unavailable fuel with their reasons', {accounting: ACCOUNTING}],
    ['complete distance and unavailable fuel without a reason', {accounting: {engine: 1, distance: {status: 'complete', breaks: [], quality: []}, fuel: {status: 'unavailable', breaks: [], quality: []}}}],
    ['the pending profile check', {membership: 'pending'}],
    ['both', {accounting: ACCOUNTING, membership: 'pending'}]
  ])('forwards %s unchanged', (_name, item) => {
    for (const [query, reply] of replies(item)) expect(parseJournalReply(query, reply), query.kind).toEqual(reply);
  });
  const distance = (status: string, breaks: string[], quality: string[] = []) => ({accounting: {...ACCOUNTING, distance: {status, breaks, quality}}});
  it.each<[string, Record<string, unknown>]>([
    ['an unknown accounting key', {accounting: {...ACCOUNTING, flags: 8}}],
    ['an unknown provenance key', {accounting: {...ACCOUNTING, distance: {...ACCOUNTING.distance, flags: 8}}}],
    ['an unknown break', distance('partial', ['teleport'])],
    ['a fuel break for distance', distance('partial', ['recording-boundary'])],
    ['a quality note as a break', distance('partial', ['bridged'])],
    ['a duplicate break', distance('partial', ['reading-hole', 'reading-hole'])],
    ['breaks out of order', distance('partial', ['reading-hole', 'truck-change'])],
    ['quality out of order', distance('partial', ['reading-hole'], ['restored', 'bridged'])],
    ['engine 0', {accounting: {...ACCOUNTING, engine: 0}}],
    ['complete with a break', distance('complete', ['transfer'])],
    ['partial without a break', distance('partial', [])],
    ['unavailable for an available distance', distance('unavailable', ['unsupported'])],
    ['complete for an unavailable fuel used', {accounting: {...ACCOUNTING, fuel: {status: 'complete', breaks: [], quality: []}}}],
    ['a raw flag integer', {accounting: 8}],
    ['a null accounting', {accounting: null}],
    ['a decided membership', {membership: 'joined'}],
    ['a null membership', {membership: null}]
  ])('refuses %s', (_name, item) => {
    for (const [query, reply] of replies(item)) expect(parseJournalReply(query, reply), query.kind).toBeUndefined();
  });
});
