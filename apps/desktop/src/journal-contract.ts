// The journal query contract between the dashboard, main and the telemetry service (ET-016, J4, J10, J11). It holds the
// fixed IPC channels and UI page sizes, the strict checks of every bridge argument (used by the preload and again by
// main), the query main sends the service and the service parses again, and main's strict check of every service reply
// against the journal contract (packages/contracts/src/journal.ts) and the request it answers. A reply that fails the
// check is never forwarded to the renderer. Renderer-safe: no Node or Electron API, so the sandboxed preload can import
// it. See docs/journal.md#ipc-methods-and-codes-j10-j11.
import type {JournalCallCode, JournalCallResult, JournalSample, JournalStorageCode, JournalTripsQuery} from '../../../packages/contracts/src';
import {
  isJournalEventCursor, isJournalRowCursor, isJournalTripsQuery, isJournalUuid, JOURNAL_EVENT_LIMITS, JOURNAL_INTERVAL_LIMITS, JOURNAL_SAMPLE_LIMITS,
  validateJournalEventPage, validateJournalIntervalPage, validateJournalTripDetail, validateJournalTripPage, type JournalPageQuery, type JournalTripListItem
} from '../../../packages/contracts/src/journal';
import {NAME_BYTES} from '../../../packages/contracts/src/protocol-v1';
import type {SampleRecord, StorageErrorCode} from '../../../packages/storage/src/api';

/** The five fixed invoke channels of the journal reads (J10); the export channel follows in ET-016 PR-5. */
export const JOURNAL_CHANNELS = {
  trips: 'journal:list-trips', trip: 'journal:get-trip', events: 'journal:list-events', intervals: 'journal:list-intervals', samples: 'journal:list-samples'
} as const;
/** Page sizes main sets for the dashboard (J5, J10); the renderer cannot choose them. */
export const JOURNAL_UI_EVENT_LIMIT = JOURNAL_EVENT_LIMITS[0];
export const JOURNAL_UI_INTERVAL_LIMIT = JOURNAL_INTERVAL_LIMITS[0];
export const JOURNAL_UI_SAMPLE_LIMIT = JOURNAL_SAMPLE_LIMITS[0];

/** One journal read, as main sends it to the telemetry service in `{type: 'journal', id, query}`. */
export type JournalQuery =
  | {kind: 'trips'; query: JournalTripsQuery}
  | {kind: 'trip'; tripUuid: string}
  | {kind: 'events' | 'intervals' | 'samples'; tripUuid: string; page: JournalPageQuery};
export type JournalQueryKind = JournalQuery['kind'];
type PageKind = Extract<JournalQuery, {page: JournalPageQuery}>['kind'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const TRIP_FILTERS = ['cursor', 'game', 'outcome', 'completeness'] as const;
const PAGE_LIMITS: Readonly<Record<PageKind, readonly number[]>> = {events: JOURNAL_EVENT_LIMITS, intervals: JOURNAL_INTERVAL_LIMITS, samples: JOURNAL_SAMPLE_LIMITS};
const pageCursor = (kind: PageKind, value: unknown) => kind === 'events' ? isJournalEventCursor(value) : isJournalRowCursor(value);

/**
 * A fresh copy of a `listJournalTrips` filter: only own listed fields are read, each once, and a field whose value is
 * undefined is left out. Undefined (no filter) gives `{}`. Anything else, including an unknown key, an unlisted value or
 * a malformed cursor, gives undefined.
 */
export function copyTripsQuery(value: unknown): JournalTripsQuery | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(key => !(TRIP_FILTERS as readonly string[]).includes(key))) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of TRIP_FILTERS) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (field !== undefined) copy[key] = field;
  }
  return isJournalTripsQuery(copy) ? copy : undefined;
}
/** Whether a bridge argument is a trip UUID and an optional cursor of the page's kind. */
export function isPageArgument(kind: PageKind, tripUuid: unknown, cursor: unknown): cursor is string | undefined {
  return isJournalUuid(tripUuid) && (cursor === undefined || pageCursor(kind, cursor));
}

/**
 * Main's parse of one journal invoke (J10): exactly the channel's argument count, each argument checked again, and the
 * page size main fixes for the dashboard. `list-trips` takes one filter object; `get-trip` one UUID; the page channels a
 * UUID and a cursor or null. Undefined for anything else.
 */
export function journalRequest(kind: JournalQueryKind, args: readonly unknown[]): JournalQuery | undefined {
  if (kind === 'trips') {
    const query = args.length === 1 && isRecord(args[0]) ? copyTripsQuery(args[0]) : undefined;
    return query ? {kind, query} : undefined;
  }
  if (kind === 'trip') return args.length === 1 && isJournalUuid(args[0]) ? {kind, tripUuid: args[0]} : undefined;
  if (args.length !== 2) return undefined;
  const [tripUuid, cursor] = args;
  if (!isJournalUuid(tripUuid) || (cursor !== null && !pageCursor(kind, cursor))) return undefined;
  const limit = kind === 'events' ? JOURNAL_UI_EVENT_LIMIT : kind === 'intervals' ? JOURNAL_UI_INTERVAL_LIMIT : JOURNAL_UI_SAMPLE_LIMIT;
  return {kind, tripUuid, page: cursor === null ? {limit} : {cursor: cursor as string, limit}};
}

/**
 * The service's parse of the query main sent: exactly the listed shape, with a page limit from the read's allowed set
 * (the dashboard's or the export's). Undefined for anything else.
 */
export function parseJournalQuery(value: unknown): JournalQuery | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'trips') {
    const query = hasExactly(value, ['kind', 'query']) && isRecord(value.query) ? copyTripsQuery(value.query) : undefined;
    return query ? {kind: 'trips', query} : undefined;
  }
  if (value.kind === 'trip') return hasExactly(value, ['kind', 'tripUuid']) && isJournalUuid(value.tripUuid) ? {kind: 'trip', tripUuid: value.tripUuid} : undefined;
  const kind = value.kind;
  if ((kind !== 'events' && kind !== 'intervals' && kind !== 'samples') || !hasExactly(value, ['kind', 'tripUuid', 'page']) || !isJournalUuid(value.tripUuid)) return undefined;
  const page = value.page;
  if (!isRecord(page) || !(hasExactly(page, ['limit']) || hasExactly(page, ['cursor', 'limit'])) || !PAGE_LIMITS[kind].includes(page.limit as number)) return undefined;
  if (page.cursor !== undefined && !pageCursor(kind, page.cursor)) return undefined;
  return {kind, tripUuid: value.tripUuid, page: page.cursor === undefined ? {limit: page.limit as number} : {cursor: page.cursor as string, limit: page.limit as number}};
}

/** Compile-time equality of two types. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The contract's storage codes equal the storage error codes; a new storage code fails to compile here until it is listed.
const STORAGE_CODES_MATCH: Same<JournalStorageCode, StorageErrorCode> = true;
// The renderer-safe sample shape equals the storage worker's sample record; a field added, removed or retyped on either
// side fails to compile here, so the reply check below cannot drift from what listSamples returns (PR-3 review).
const SAMPLES_MATCH: Same<JournalSample, SampleRecord> = true;
void STORAGE_CODES_MATCH; void SAMPLES_MATCH;
const STORAGE_CODE_TABLE: Readonly<Record<JournalStorageCode, true>> = {
  DATABASE_LOCKED: true, PERMISSION_DENIED: true, DISK_FULL: true, IO_ERROR: true, DATABASE_CORRUPT: true, CONSTRAINT_VIOLATION: true, INVALID_INPUT: true,
  UNKNOWN_SESSION: true, UNKNOWN_TRIP: true, SESSION_CONFLICT: true, VALUE_OUT_OF_RANGE: true, STORAGE_CLOSED: true, STORAGE_BUSY: true, WORKER_FAILED: true,
  TIMEOUT: true, DATA_PATH_INVALID: true, DATABASE_UNRECOGNIZED: true, SCHEMA_NEWER: true, PURPOSE_MISMATCH: true, DURABILITY_UNVERIFIED: true, BACKUP_FAILED: true,
  MIGRATION_FAILED: true, INTERNAL: true
};
export const isJournalStorageCode = (value: unknown): value is JournalStorageCode => typeof value === 'string' && Object.hasOwn(STORAGE_CODE_TABLE, value);
const CALL_CODE_TABLE: Readonly<Record<JournalCallCode, true>> = {
  SERVICE_UNAVAILABLE: true, DATABASE_OPENING: true, DATABASE_UNAVAILABLE: true, BUSY: true, TIMEOUT: true, NOT_FOUND: true, FAILED: true
};
/** A fixed refusal (J11) without a storage code. */
export const refusal = (code: Exclude<JournalCallCode, 'DATABASE_UNAVAILABLE'>): JournalCallResult<never> => ({ok: false, code});

/** Thrown by the reply checks below; never leaves this module. */
class ReplyError extends Error {}
const bad = (): never => { throw new ReplyError('Invalid journal reply'); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !hasExactly(value, keys)) bad();
  return value as Record<string, unknown>;
}
const encoder = new TextEncoder();
/** Display text of a list row: at most the protocol's NAME_BYTES of UTF-8, as every stored name was when it arrived. */
function name(value: unknown): void { if (typeof value !== 'string' || encoder.encode(value).length > NAME_BYTES) bad(); }
const REASONS: readonly unknown[] = ['not-supported', 'not-observed', 'invalid'];
function available(value: unknown, check: (value: unknown) => void): void {
  if (isRecord(value) && value.available === true) { check(exact(value, ['available', 'value']).value); return; }
  if (!REASONS.includes(exact(value, ['available', 'reason']).reason)) bad();
}
const finite = (value: unknown) => { if (typeof value !== 'number' || !Number.isFinite(value)) bad(); };
const count = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad(); };
const uuid = (value: unknown) => { if (!isJournalUuid(value)) bad(); };
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const uint64 = (value: unknown) => { if (typeof value !== 'string' || !U64.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) bad(); };
const SAMPLE_KEYS = ['id', 'tripUuid', 'utcMs', 'sourceClockId', 'monotonicNs', 'gameTime', 'speed', 'fuel', 'averageConsumption', 'estimatedRange', 'engineRpm', 'gear', 'odometer', 'position'];
const SAMPLE_VALUES = ['speed', 'fuel', 'averageConsumption', 'estimatedRange', 'engineRpm', 'gear', 'odometer'];
/** One stored sample of the requested trip, exactly the JournalSample shape. */
function sample(value: unknown, tripUuid: string): void {
  const o = exact(value, SAMPLE_KEYS);
  if (!isJournalRowCursor(o.id) || o.tripUuid !== tripUuid) bad();
  count(o.utcMs); uuid(o.sourceClockId); uint64(o.monotonicNs);
  if (o.gameTime !== null) { const g = exact(o.gameTime, ['minutes', 'clockId']); available(g.minutes, count); uuid(g.clockId); }
  for (const key of SAMPLE_VALUES) available(o[key], finite);
  available(o.position, position => { const p = exact(position, ['x', 'y', 'z']); finite(p.x); finite(p.y); finite(p.z); });
}
/** Ids (row ids or eventSeqs) strictly increasing and all after the requested cursor. */
function ascending(ids: readonly string[], cursor: string | undefined): void {
  let previous = cursor === undefined ? 0n : BigInt(cursor);
  for (const id of ids) { const next = BigInt(id); if (next <= previous) bad(); previous = next; }
}
/** A page's next cursor is exactly its last id when the page is full, and null otherwise. */
function nextCursor(next: string | null, ids: readonly string[], limit: number): void {
  if (next !== (ids.length === limit ? ids.at(-1) : null)) bad();
}
/** A list row's display texts within the protocol's name bound; the contract validator checked the rest. */
function rowTexts(trip: JournalTripListItem): void {
  for (const field of [trip.job.sourceCity, trip.job.sourceCompany, trip.job.destinationCity, trip.job.destinationCompany, trip.job.cargo]) if (field.available) name(field.value);
}

/** Throws unless `value` answers `query` exactly: the journal contract, the requested page and its filter. */
function checkValue(query: JournalQuery, value: unknown): void {
  switch (query.kind) {
  case 'trips': {
    const page = validateJournalTripPage(value), {cursor, game, outcome, completeness} = query.query;
    for (const trip of page.trips) {
      rowTexts(trip);
      // The filter applies in SQL before the limit; a row that does not match it answers another request.
      if ((game !== undefined && trip.game !== game) || (outcome !== undefined && trip.outcome !== outcome) || (completeness !== undefined && trip.recordingCompleteness !== completeness)) bad();
    }
    // Newest first: the next page starts below this one, which starts below the cursor.
    if (cursor !== undefined && page.nextCursor !== null && BigInt(page.nextCursor) >= BigInt(cursor)) bad();
    return;
  }
  case 'trip': {
    const detail = validateJournalTripDetail(value);
    if (detail.trip.tripUuid !== query.tripUuid) bad();
    rowTexts(detail.trip);
    return;
  }
  case 'events': {
    const page = validateJournalEventPage(value, query.page.limit), ids = page.events.map(event => event.eventSeq);
    ascending(ids, query.page.cursor); nextCursor(page.nextCursor, ids, query.page.limit);
    return;
  }
  case 'intervals': {
    // Each interval's `detail` is an open record checked only as an object whose annotation and cause agree with the
    // interval's flags; its cause-specific keys vary by writer and are forwarded as stored (docs/journal.md).
    const page = validateJournalIntervalPage(value, query.page.limit), ids = page.intervals.map(interval => interval.id);
    ascending(ids, query.page.cursor); nextCursor(page.nextCursor, ids, query.page.limit);
    return;
  }
  case 'samples': {
    const o = exact(value, ['database', 'samples', 'nextCursor']), database = exact(o.database, ['purpose', 'schemaVersion']);
    if (!['history', 'synthetic', 'replay'].includes(database.purpose as string) || !Number.isSafeInteger(database.schemaVersion) || (database.schemaVersion as number) < 1) bad();
    if (!Array.isArray(o.samples) || o.samples.length > query.page.limit) bad();
    const samples = o.samples as unknown[];
    for (const item of samples) sample(item, query.tripUuid);
    const ids = samples.map(item => (item as {id: string}).id);
    if (o.nextCursor !== null && !isJournalRowCursor(o.nextCursor)) bad();
    ascending(ids, query.page.cursor); nextCursor(o.nextCursor as string | null, ids, query.page.limit);
    return;
  }
  }
}

/**
 * Main's check of one service reply (J10): a value that answers the query exactly, or a fixed refusal of exactly
 * `{ok: false, code}` (with `storageCode` for DATABASE_UNAVAILABLE). Undefined for anything else; main then answers
 * FAILED and forwards nothing of the reply.
 */
export function parseJournalReply(query: JournalQuery, result: unknown): JournalCallResult<unknown> | undefined {
  if (!isRecord(result)) return undefined;
  if (result.ok === false) {
    if (result.code === 'DATABASE_UNAVAILABLE') return hasExactly(result, ['ok', 'code', 'storageCode']) && isJournalStorageCode(result.storageCode)
      ? {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: result.storageCode} : undefined;
    return hasExactly(result, ['ok', 'code']) && typeof result.code === 'string' && Object.hasOwn(CALL_CODE_TABLE, result.code)
      ? refusal(result.code as Exclude<JournalCallCode, 'DATABASE_UNAVAILABLE'>) : undefined;
  }
  if (result.ok !== true || !hasExactly(result, ['ok', 'value'])) return undefined;
  // Any throw, from these checks or from the contract validators, is an invalid reply.
  try { checkValue(query, result.value); } catch { return undefined; }
  return {ok: true, value: result.value};
}
