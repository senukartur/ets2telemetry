// Journal reads (ET-016 PR-2, J5, J7): a newest-first page of trips, one trip's detail, its timeline and its
// completeness intervals, read on the writer connection like every other read. Every page is bounded, filters run in
// SQL before the limit, and each statement is a constant of JOURNAL_QUERIES, so tests prove its query plan with
// EXPLAIN QUERY PLAN. Values keep their availability and exact money; nothing is converted. See docs/journal.md.
import type Database from 'better-sqlite3';
import {
  isJournalPageQuery, isJournalTripsQuery, JOURNAL_DETAIL_INTERVALS, JOURNAL_EVENT_LIMITS, JOURNAL_INTERVAL_LIMITS, JOURNAL_MONEY_AMOUNTS, JOURNAL_TRIP_PAGE,
  type JournalDatabase, type JournalEvent, type JournalEventPage, type JournalInterval, type JournalIntervalPage, type JournalMoneyCategory, type JournalMoneyTotal,
  type JournalMoneyTotals, type JournalMoneyUnavailable, type JournalOutcomeRecord, type JournalPageQuery, type JournalTripDetail, type JournalTripListItem,
  type JournalTripPage, type JournalTripsQuery, type JournalWindow
} from '../../../contracts/src/journal';
import type {EventOccurrence, EventRecord, JobConfiguration, TrailerConfiguration, TruckConfiguration, UnavailableReason} from '../../../contracts/src/protocol-v1';
import type {Purpose} from '../api';
import {fromAvailability, fromU64Key, isUuid, JOB_FIELDS, moneyFromColumns, specRecord, toReal, toSafeNumber, u64Key, type AvailabilityState} from '../codec';
import {fail} from '../errors';
import type {StorageConnection} from './connection';
import {statement} from './writes';

const MAX_ROW_ID = 9_223_372_036_854_775_807n;
const MONEY_TYPES: Readonly<Record<string, JournalMoneyCategory>> = {'player.fined': 'fine', 'player.tollgate.paid': 'toll', 'player.use.ferry': 'ferry', 'player.use.train': 'train'};
const CATEGORY_ORDER: readonly JournalMoneyCategory[] = ['fine', 'toll', 'ferry', 'train'];

/**
 * Every journal statement. Each one reaches its rows through a primary key, the events UNIQUE (session, eventSeq) index,
 * event_attributions_trip, completeness_intervals_trip or samples_trip; tests/storage/journal-scale.test.ts checks that
 * no plan scans events or samples. No index was added for them (J6).
 */
export const JOURNAL_QUERIES = {
  purpose: 'SELECT purpose FROM database_info WHERE id = 1',
  userVersion: 'PRAGMA user_version',
  /** A newest-first trip page: the filter is part of the WHERE clause, so it applies before the LIMIT. */
  tripPage: `SELECT * FROM trips WHERE id < ? AND (? IS NULL OR game = ?) AND (? IS NULL OR outcome = ?) AND (? IS NULL OR recording_completeness = ?)
    ORDER BY id DESC LIMIT ?`,
  tripByUuid: 'SELECT * FROM trips WHERE trip_uuid = ?',
  job: 'SELECT * FROM job_configurations WHERE id = ?',
  session: 'SELECT plugin_session_uuid, committed_through_event_seq FROM plugin_sessions WHERE id = ?',
  eventById: 'SELECT event_seq, type, payload_json FROM events WHERE id = ?',
  eventExists: 'SELECT 1 FROM events WHERE plugin_session_id = ? AND event_seq = ?',
  truck: 'SELECT event_ref FROM truck_configurations WHERE id = ?',
  trailers: `SELECT e.event_seq, e.payload_json FROM trip_trailers x JOIN trailer_configurations c ON c.id = x.trailer_configuration_ref JOIN events e ON e.id = c.event_ref
    WHERE x.trip_ref = ? ORDER BY e.event_seq`,
  /** The trip's attributed money events in event order, one more than the bound so an overflow is detected. */
  amounts: `SELECT e.type, m.amount_raw, m.amount_sdk_type, m.amount_currency_status, m.amount_currency_code, m.amount_currency_source, m.amount_state
    FROM event_attributions a JOIN events e ON e.id = a.event_ref JOIN event_amounts m ON m.event_ref = a.event_ref
    WHERE a.trip_ref = ? AND e.type IN ('player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train') ORDER BY a.event_ref LIMIT ?`,
  intervalPage: 'SELECT * FROM completeness_intervals WHERE trip_ref = ? AND id > ? ORDER BY id LIMIT ?',
  intervalTotal: 'SELECT count(*) AS total, max(id) AS last FROM completeness_intervals WHERE trip_ref = ?',
  clock: 'SELECT clock_uuid FROM clocks WHERE id = ?',
  sampleSummary: 'SELECT count(*) AS total, min(id) AS first, max(id) AS last FROM samples WHERE trip_ref = ?',
  sampleLabel: 'SELECT utc_ms FROM samples WHERE id = ?',
  /** A known window (J7): the trip session's events in (lower, upper], in eventSeq order. */
  windowEvents: `SELECT e.event_seq, e.type, e.payload_json, a.attribution, t.trip_uuid AS attributed_trip FROM events e
    LEFT JOIN event_attributions a ON a.event_ref = e.id LEFT JOIN trips t ON t.id = a.trip_ref
    WHERE e.plugin_session_id = ? AND e.event_seq > ? AND e.event_seq <= ? ORDER BY e.event_seq LIMIT ?`,
  /**
   * An unknown window: the events of the trip's session that are attributed to the trip or referenced by it (its job,
   * truck and trailer configurations, its opening and its outcome), in eventSeq order after the cursor. Named parameters:
   * `trip` (row id), `session` (row id), `after` (eventSeq key) and `limit`. The unary `+` keeps SQLite from walking the
   * session's (session, eventSeq) index range; it looks each referenced event up by its primary key instead, so the
   * cost follows the trip's own events, not the length of its session.
   */
  referencedEvents: `WITH refs (id) AS (
      SELECT event_ref FROM event_attributions WHERE trip_ref = @trip
      UNION SELECT opened_event_ref FROM trips WHERE id = @trip
      UNION SELECT outcome_event_ref FROM trips WHERE id = @trip
      UNION SELECT j.event_ref FROM trips t JOIN job_configurations j ON j.id = t.job_configuration_ref WHERE t.id = @trip
      UNION SELECT k.event_ref FROM trips t JOIN truck_configurations k ON k.id = t.truck_configuration_ref WHERE t.id = @trip
      UNION SELECT c.event_ref FROM trip_trailers x JOIN trailer_configurations c ON c.id = x.trailer_configuration_ref WHERE x.trip_ref = @trip)
    SELECT e.event_seq, e.type, e.payload_json, a.attribution, t.trip_uuid AS attributed_trip FROM events e
    LEFT JOIN event_attributions a ON a.event_ref = e.id LEFT JOIN trips t ON t.id = a.trip_ref
    WHERE e.id IN (SELECT id FROM refs) AND +e.plugin_session_id = @session AND +e.event_seq > @after ORDER BY e.event_seq LIMIT @limit`
} as const;

type Row = Record<string, unknown>;
// Prepared statements are cached per connection by SQL text and shared with the other reads, some of which pluck the
// same text; each call therefore sets the pluck mode it needs.
const get = (db: Database.Database, sql: string, ...params: unknown[]) => statement(db, sql).pluck(false).get(...params) as Row | undefined;
const all = (db: Database.Database, sql: string, ...params: unknown[]) => statement(db, sql).pluck(false).all(...params) as Row[];
const value = (db: Database.Database, sql: string) => statement(db, sql).pluck(true).get();

/** The purpose and schema version of the open database, carried by every journal response (J3). */
function database(db: Database.Database): JournalDatabase {
  return {purpose: value(db, JOURNAL_QUERIES.purpose) as Purpose, schemaVersion: toSafeNumber(value(db, JOURNAL_QUERIES.userVersion), 65_535, 1)};
}
function tripRow(db: Database.Database, tripUuid: unknown): Row {
  if (!isUuid(tripUuid)) fail('INVALID_INPUT');
  const row = get(db, JOURNAL_QUERIES.tripByUuid, tripUuid);
  if (!row) fail('UNKNOWN_TRIP');
  return row;
}
function payloadOf(r: Row): {occurred: EventOccurrence; record: EventRecord} {
  return JSON.parse(String(r.payload_json)) as {occurred: EventOccurrence; record: EventRecord};
}
/** A configuration record without its `type`: the values of a truck or trailer configuration. */
function valuesOf<T>(record: EventRecord): T {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'type')) as T;
}

/** The stored job values in the protocol v1 shape, with the canonical units of the wire. */
function jobValues(job: Row): JobConfiguration {
  const v = specRecord(JOB_FIELDS, job) as Record<string, object>;
  const unit = (field: string, value: string) => ({...v[field], unit: value});
  return {...v, cargoMass: unit('cargoMass', 'kg'), cargoUnitMass: unit('cargoUnitMass', 'kg'), plannedDistance: unit('plannedDistance', 'm'),
    deliveryDeadline: unit('deliveryDeadline', 'min')} as unknown as JobConfiguration;
}
function listItem(db: Database.Database, r: Row): JournalTripListItem {
  const job = get(db, JOURNAL_QUERIES.job, r.job_configuration_ref);
  if (!job) fail('DATABASE_CORRUPT');
  const values = jobValues(job);
  return {
    tripUuid: String(r.trip_uuid), game: r.game as JournalTripListItem['game'],
    gameMode: {mode: r.game_mode, method: r.game_mode_method, confidence: r.game_mode_confidence} as JournalTripListItem['gameMode'],
    gameModeAmbiguous: toSafeNumber(r.game_mode_ambiguous, 1, 0) === 1, outcome: r.outcome as JournalTripListItem['outcome'],
    closeReason: r.close_reason as JournalTripListItem['closeReason'], recordingCompleteness: r.recording_completeness as JournalTripListItem['recordingCompleteness'],
    startedUtcMs: toSafeNumber(r.started_utc_ms, Number.MAX_SAFE_INTEGER, 0), endedUtcMs: r.ended_utc_ms === null ? null : toSafeNumber(r.ended_utc_ms, Number.MAX_SAFE_INTEGER, 0),
    observedDistanceM: fromAvailability(r.observed_distance_m, r.observed_distance_m_state, toReal),
    fuelUsedL: fromAvailability(r.fuel_used_l, r.fuel_used_l_state, toReal),
    job: {source: job.source as 'event' | 'checkpoint', sourceCity: values.sourceCity, sourceCompany: values.sourceCompany, destinationCity: values.destinationCity,
      destinationCompany: values.destinationCompany, cargo: values.cargo, plannedDistance: values.plannedDistance, expectedIncome: values.expectedIncome}
  };
}

/**
 * Trips newest first, at most JOURNAL_TRIP_PAGE per page. The optional game, outcome and completeness filter is part of
 * the SQL WHERE clause, so a page is full whenever more matching trips exist; a full page always has a cursor.
 */
export function journalTrips(conn: StorageConnection, query: JournalTripsQuery = {}): JournalTripPage {
  if (!isJournalTripsQuery(query)) fail('INVALID_INPUT');
  const db = conn.reader(), q = query ?? {};
  const game = q.game ?? null, outcome = q.outcome ?? null, completeness = q.completeness ?? null;
  const before = q.cursor === undefined ? MAX_ROW_ID : BigInt(q.cursor);
  const rows = all(db, JOURNAL_QUERIES.tripPage, before, game, game, outcome, outcome, completeness, completeness, JOURNAL_TRIP_PAGE);
  return {database: database(db), trips: rows.map(r => listItem(db, r)), nextCursor: rows.length === JOURNAL_TRIP_PAGE ? String(rows[rows.length - 1].id) : null};
}

interface Window {dto: JournalWindow; session: bigint; from: bigint; through: bigint | null}
/**
 * The trip's timeline window (J7). It starts at the earlier of the opening event and the job configuration (its event,
 * or the checkpoint's nextEventSeq) and ends at the close carrier: through an event of the trip's own session, before a
 * gap's first newly covered eventSeq, or at the end of the session when another plugin session closed it. An open trip
 * has no end. A closed trip without a carrier (closed before schema version 2) has no known window.
 */
function windowOf(db: Database.Database, trip: Row): Window {
  const session = trip.plugin_session_ref as bigint;
  const pluginSessionId = String(get(db, JOURNAL_QUERIES.session, session)?.plugin_session_uuid);
  const job = get(db, JOURNAL_QUERIES.job, trip.job_configuration_ref);
  if (!job) fail('DATABASE_CORRUPT');
  const opened = BigInt(fromU64Key(get(db, JOURNAL_QUERIES.eventById, trip.opened_event_ref)?.event_seq));
  const configured = job.source === 'event' ? BigInt(fromU64Key(get(db, JOURNAL_QUERIES.eventById, job.event_ref)?.event_seq)) : BigInt(fromU64Key(job.checkpoint_next_event_seq));
  const from = configured < opened ? configured : opened;
  const known = (end: 'open' | 'close-event' | 'close-gap' | 'end-of-session', through: bigint | null): Window =>
    ({dto: {known: true, pluginSessionId, fromEventSeq: from.toString(), throughEventSeq: through === null ? null : through.toString(), end}, session, from, through});
  if (trip.outcome === 'open') return known('open', null);
  if (trip.closed_by_session_ref === null) return {dto: {known: false, pluginSessionId}, session, from, through: null};
  if (trip.closed_by_session_ref !== session) return known('end-of-session', null);
  const carrier = BigInt(fromU64Key(trip.closed_by_event_seq));
  // An event row at the carrier means an event closed the trip and belongs to its window; otherwise a gap closed it,
  // and the window ends before the gap's first newly covered eventSeq.
  return get(db, JOURNAL_QUERIES.eventExists, session, trip.closed_by_event_seq) ? known('close-event', carrier) : known('close-gap', carrier - 1n);
}

function journalEvent(r: Row): JournalEvent {
  const {occurred, record} = payloadOf(r);
  const attribution = r.attribution === null || r.attribution === undefined ? null
    : {kind: r.attribution as NonNullable<JournalEvent['attribution']>['kind'], tripUuid: r.attributed_trip === null ? null : r.attributed_trip as string};
  return {eventSeq: fromU64Key(r.event_seq), type: String(r.type) as JournalEvent['type'], occurred, record, attribution};
}
/**
 * One page of the trip's timeline in eventSeq order, `limit` 100 (UI) or 500 (export). `cursor` is the eventSeq of the
 * last event of the previous page. Only events of the trip's own plugin session are listed.
 */
export function journalEvents(conn: StorageConnection, tripUuid: string, page: JournalPageQuery): JournalEventPage {
  if (!isJournalPageQuery(page, JOURNAL_EVENT_LIMITS, 'event')) fail('INVALID_INPUT');
  const db = conn.reader(), trip = tripRow(db, tripUuid), window = windowOf(db, trip);
  const cursor = page.cursor === undefined ? 0n : BigInt(page.cursor);
  let rows: Row[];
  if (window.dto.known) {
    const lower = window.from - 1n > cursor ? window.from - 1n : cursor;
    rows = all(db, JOURNAL_QUERIES.windowEvents, window.session, u64Key(lower), window.through === null ? u64Key(18_446_744_073_709_551_615n) : u64Key(window.through), page.limit);
  } else rows = all(db, JOURNAL_QUERIES.referencedEvents, {trip: trip.id, session: window.session, after: u64Key(cursor), limit: page.limit});
  return {database: database(db), window: window.dto, events: rows.map(journalEvent), nextCursor: rows.length === page.limit ? fromU64Key(rows[rows.length - 1].event_seq) : null};
}

function interval(db: Database.Database, r: Row): JournalInterval {
  const optional = <T>(value: unknown, map: (value: unknown) => T): T | null => value === null ? null : map(value);
  const detail = optional(r.detail_json, value => JSON.parse(String(value)) as Record<string, unknown>);
  return {
    id: String(r.id), kind: r.kind as JournalInterval['kind'], annotation: detail?.annotation === true, cause: typeof detail?.cause === 'string' ? detail.cause : null,
    startUtcMs: optional(r.start_utc_ms, value => toSafeNumber(value, Number.MAX_SAFE_INTEGER, 0)), endUtcMs: optional(r.end_utc_ms, value => toSafeNumber(value, Number.MAX_SAFE_INTEGER, 0)),
    startMonotonicNs: optional(r.start_monotonic_ns, fromU64Key), endMonotonicNs: optional(r.end_monotonic_ns, fromU64Key),
    sourceClockId: optional(r.source_clock_ref, ref => String(get(db, JOURNAL_QUERIES.clock, ref)?.clock_uuid)),
    firstEventSeq: optional(r.first_event_seq, fromU64Key), lastEventSeq: optional(r.last_event_seq, fromU64Key), detail
  };
}
function intervalPage(db: Database.Database, trip: bigint, cursor: string | undefined, limit: number) {
  const rows = all(db, JOURNAL_QUERIES.intervalPage, trip, cursor === undefined ? 0n : BigInt(cursor), limit);
  const totals = get(db, JOURNAL_QUERIES.intervalTotal, trip)!;
  return {items: rows.map(r => interval(db, r)), total: toSafeNumber(totals.total, Number.MAX_SAFE_INTEGER, 0),
    last: totals.last === null ? null : (totals.last as bigint).toString(), nextCursor: rows.length === limit ? String(rows[rows.length - 1].id) : null};
}
/** One page of the trip's completeness intervals in insertion order, `limit` 100 (UI) or 500 (export), with the trip's total. */
export function journalIntervals(conn: StorageConnection, tripUuid: string, page: JournalPageQuery): JournalIntervalPage {
  if (!isJournalPageQuery(page, JOURNAL_INTERVAL_LIMITS, 'row')) fail('INVALID_INPUT');
  const db = conn.reader(), trip = tripRow(db, tripUuid);
  const result = intervalPage(db, trip.id as bigint, page.cursor, page.limit);
  return {database: database(db), intervals: result.items, total: result.total, nextCursor: result.nextCursor};
}

/**
 * Exact money totals of the trip's attributed fines, tolls and transfers, per category, SDK type and currency basis
 * (J5). At most JOURNAL_MONEY_AMOUNTS amounts are summed with BigInt; with more, nothing is summed and the totals are
 * marked incomplete, so a partial sum is never reported as a total. Unavailable amounts are counted by reason.
 */
function moneyTotals(db: Database.Database, trip: bigint): JournalMoneyTotals {
  const rows = all(db, JOURNAL_QUERIES.amounts, trip, JOURNAL_MONEY_AMOUNTS + 1);
  if (rows.length > JOURNAL_MONEY_AMOUNTS) return {incomplete: true, totals: [], unavailable: []};
  const totals = new Map<string, JournalMoneyTotal & {sum: bigint}>(), unavailable = new Map<string, JournalMoneyUnavailable>();
  for (const r of rows) {
    const category = MONEY_TYPES[String(r.type)];
    const amount = moneyFromColumns({raw: r.amount_raw as string | null, sdkType: r.amount_sdk_type as 's64' | 'u64' | null,
      currencyStatus: r.amount_currency_status as 'unknown' | 'sdk-documented' | null, currencyCode: r.amount_currency_code as string | null,
      currencySource: r.amount_currency_source as string | null, state: r.amount_state as AvailabilityState});
    if (!amount.available) {
      const key = `${category}|${amount.reason}`, entry = unavailable.get(key);
      if (entry) entry.count++; else unavailable.set(key, {category, reason: amount.reason, count: 1});
      continue;
    }
    const m = amount.value, currency = m.currency.status === 'sdk-documented' ? `0|${m.currency.code}|${m.currency.source}` : '1';
    const key = `${category}|${m.sdkType}|${currency}`, entry = totals.get(key);
    if (entry) { entry.sum += BigInt(m.raw); entry.count++; } else totals.set(key, {category, sdkType: m.sdkType, currency: m.currency, raw: '', count: 1, sum: BigInt(m.raw)});
  }
  // Fixed order: category, then SDK-documented currencies by code and source, then an unknown currency, then SDK type.
  const order = (category: JournalMoneyCategory) => CATEGORY_ORDER.indexOf(category);
  const sorted = [...totals.entries()].sort(([a, x], [b, y]) => order(x.category) - order(y.category) || (a < b ? -1 : a > b ? 1 : 0));
  const reasons: readonly UnavailableReason[] = ['not-observed', 'not-supported', 'invalid'];
  return {incomplete: false, totals: sorted.map(([, {sum, ...total}]) => ({...total, raw: sum.toString()})),
    unavailable: [...unavailable.values()].sort((a, b) => order(a.category) - order(b.category) || reasons.indexOf(a.reason) - reasons.indexOf(b.reason))};
}

/**
 * One trip's detail: the summary, the job, truck and trailers, the outcome event, exact money totals, the timeline
 * window, the first JOURNAL_DETAIL_INTERVALS completeness intervals with their total, the sample count with the first
 * and last UTC labels, and the export bounds fixed at this read (J17). An unknown trip is UNKNOWN_TRIP.
 */
export function journalTrip(conn: StorageConnection, tripUuid: string): JournalTripDetail {
  const db = conn.reader(), trip = tripRow(db, tripUuid), id = trip.id as bigint;
  const session = get(db, JOURNAL_QUERIES.session, trip.plugin_session_ref)!;
  const event = (ref: unknown) => { const r = get(db, JOURNAL_QUERIES.eventById, ref); if (!r) fail('DATABASE_CORRUPT'); return r; };
  const job = get(db, JOURNAL_QUERIES.job, trip.job_configuration_ref)!;
  const truckRef = trip.truck_configuration_ref === null ? undefined : get(db, JOURNAL_QUERIES.truck, trip.truck_configuration_ref)?.event_ref;
  const truck = truckRef === undefined ? null : event(truckRef);
  const outcome = trip.outcome_event_ref === null ? null : event(trip.outcome_event_ref);
  const closedBy = trip.closed_by_session_ref === null ? null
    : {pluginSessionId: String(get(db, JOURNAL_QUERIES.session, trip.closed_by_session_ref)?.plugin_session_uuid), eventSeq: fromU64Key(trip.closed_by_event_seq)};
  const intervals = intervalPage(db, id, undefined, JOURNAL_DETAIL_INTERVALS);
  const samples = get(db, JOURNAL_QUERIES.sampleSummary, id)!;
  const label = (ref: unknown) => ref === null ? null : toSafeNumber(get(db, JOURNAL_QUERIES.sampleLabel, ref)?.utc_ms, Number.MAX_SAFE_INTEGER, 0);
  return {
    database: database(db),
    trip: {...listItem(db, trip), pluginSessionId: String(session.plugin_session_uuid), openedEventSeq: fromU64Key(event(trip.opened_event_ref).event_seq),
      outcomeEventSeq: outcome === null ? null : fromU64Key(outcome.event_seq), closedBy},
    job: {source: job.source as 'event' | 'checkpoint', eventSeq: job.source === 'event' ? fromU64Key(event(job.event_ref).event_seq) : null,
      checkpointNextEventSeq: job.source === 'checkpoint' ? fromU64Key(job.checkpoint_next_event_seq) : null, values: jobValues(job)},
    truck: truck === null ? null : {eventSeq: fromU64Key(truck.event_seq), values: valuesOf<TruckConfiguration>(payloadOf(truck).record)},
    trailers: all(db, JOURNAL_QUERIES.trailers, id).map(r => ({eventSeq: fromU64Key(r.event_seq), values: valuesOf<TrailerConfiguration>(payloadOf(r).record)})),
    outcomeDetails: outcome === null ? null : {eventSeq: fromU64Key(outcome.event_seq), record: payloadOf(outcome).record as JournalOutcomeRecord},
    money: moneyTotals(db, id),
    window: windowOf(db, trip).dto,
    intervals: {items: intervals.items, total: intervals.total, nextCursor: intervals.nextCursor},
    samples: {count: toSafeNumber(samples.total, Number.MAX_SAFE_INTEGER, 0), firstUtcMs: label(samples.first), lastUtcMs: label(samples.last)},
    exportBounds: {committedThroughEventSeq: fromU64Key(session.committed_through_event_seq), lastSampleId: samples.last === null ? null : (samples.last as bigint).toString(), lastIntervalId: intervals.last}
  };
}
