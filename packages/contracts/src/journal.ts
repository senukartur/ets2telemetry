// Trip journal read contract (ET-016, J5, J7, J13). Plain data, fixed bounds and strict validators shared by the storage
// worker, its client and later the telemetry service, main and the preload. Node-safe and renderer-safe: no Node API.
// Every value keeps the protocol v1 availability and money shapes, so zero stays distinct from an unavailable value
// and money stays exact decimal text with its SDK type and currency basis. Every response names the database purpose,
// so synthetic and replay data are never shown as game history. See docs/journal.md.
import {isHardModeDetails, type HardModeDetails} from './hard-mode';
import {isDashboardOwner, type DashboardOwner} from './dashboard-upload';
import {validateServerMessage, type Available, type Currency, type EventOccurrence, type EventRecord, type GameMode, type JobConfiguration, type Money,
  type TrailerConfiguration, type TruckConfiguration, type UnavailableReason, type Uint64} from './protocol-v1';

/** Trips per `journalTrips` page, newest first. The page size is fixed; the caller cannot choose it. */
export const JOURNAL_TRIP_PAGE = 50;
/** Allowed `limit` values of a `journalEvents` page: one page of the timeline in the UI, or one export page. */
export const JOURNAL_EVENT_LIMITS: readonly number[] = Object.freeze([100, 500]);
/** Allowed `limit` values of a `journalIntervals` page: the UI page and the export page. */
export const JOURNAL_INTERVAL_LIMITS: readonly number[] = Object.freeze([100, 500]);
/** Allowed `limit` values of a trip's `listSamples` page: the UI page and the export page. */
export const JOURNAL_SAMPLE_LIMITS: readonly number[] = Object.freeze([300, 3_600]);
/** Completeness intervals included in a trip detail; later ones are read with `journalIntervals` and its cursor. */
export const JOURNAL_DETAIL_INTERVALS = 50;
/**
 * Trailer configurations included in a trip detail: the latest ones in commit order. A trip keeps every trailer
 * configuration it was given, so it can hold more; the detail then still carries the total (review pass 1).
 */
export const JOURNAL_DETAIL_TRAILERS = 10;
/** Money amounts summed for one trip detail; with more, the totals are reported as incomplete instead. */
export const JOURNAL_MONEY_AMOUNTS = 5_000;

export type JournalPurpose = 'history' | 'synthetic' | 'replay';
/** The database a response was read from. Anything but `history` is a synthetic or replay test database. */
export interface JournalDatabase {purpose: JournalPurpose; schemaVersion: number}
export type JournalGame = 'ets2' | 'ats';
export type JournalOutcome = 'open' | 'delivered' | 'cancelled' | 'none';
export type JournalCloseReason = 'outcome' | 'configuration-cleared' | 'different-job' | 'restart' | 'discontinuity' | 'gap';
export type JournalCompleteness = 'complete' | 'partial' | 'unknown';
/** The trip's game-mode evidence. `convoy` is reserved by the schema for a later protocol minor and never written today. */
export interface JournalGameMode {mode: GameMode['mode'] | 'convoy'; method: GameMode['method']; confidence: GameMode['confidence']}
export type JournalAttributionKind = 'trip' | 'trip-before-loaded' | 'free-driving' | 'ambiguous';
export type JournalIntervalKind = 'event-loss' | 'not-connected' | 'storage-unavailable' | 'sample-loss' | 'discontinuity' | 'restore-loss';
export type JournalMoneyCategory = 'fine' | 'toll' | 'ferry' | 'train';

/**
 * A `journalTrips` query. Every filter is applied in SQL before the page limit. `cursor` is the opaque `nextCursor` of
 * the previous page read with the same filter.
 */
export interface JournalTripsQuery {cursor?: string; game?: JournalGame; outcome?: JournalOutcome; completeness?: JournalCompleteness}
/** A page of a trip's timeline or completeness intervals. `limit` must be one of the allowed values of that read. */
export interface JournalPageQuery {cursor?: string; limit: number}

/** The job of a list row: where it goes and what it pays, as the game offered it. */
export interface JournalJobSummary {
  source: 'event' | 'checkpoint';
  sourceCity: Available<string>; sourceCompany: Available<string>; destinationCity: Available<string>; destinationCompany: Available<string>;
  cargo: Available<string>;
  /** Raw SDK `job.market` value (for example `freight_market`), never translated. */
  market: Available<string>;
  /** Whether the game marked the job as special transport. */
  isSpecialJob: Available<boolean>;
  /** Planned distance of the job offer, never the observed or delivered distance. */
  plannedDistance: JobConfiguration['plannedDistance'];
  /** Expected income of the job offer, never the revenue. */
  expectedIncome: Available<Money>;
}
/** One journal list row. Outcome and recording completeness are separate; neither is inferred from the other. */
export interface JournalTripListItem {
  isHardMode: boolean; hardModeDetails: HardModeDetails | null;
  tripUuid: string; game: JournalGame; gameMode: JournalGameMode; gameModeAmbiguous: boolean;
  outcome: JournalOutcome; closeReason: JournalCloseReason | null; recordingCompleteness: JournalCompleteness;
  /** UTC labels in milliseconds; real durations come from monotonic time, never from these labels. */
  startedUtcMs: number; endedUtcMs: number | null;
  /** Odometer distance observed while recording, in metres. */
  observedDistanceM: Available<number>;
  /** Fuel used while recording, in litres (schema version 2, S-1). */
  fuelUsedL: Available<number>;
  job: JournalJobSummary;
}
export interface JournalSyncRow {
  tripUuid: string;
  state: 'unavailable' | 'unbound' | 'identity-pending' | 'pending' | 'queued' | 'sending' | 'held' | 'sent';
  materialVersion: string | null; latestRevision: number | null; lastDurableUploadUtcMs: number | null;
  reason: 'validation' | 'reconciliation' | null;
}
export interface JournalTripSync {owner: DashboardOwner; connectionVersion: string; rows: JournalSyncRow[]}
export interface JournalTripPage {database: JournalDatabase; trips: JournalTripListItem[]; nextCursor: string | null; sync?: JournalTripSync}

/**
 * The trip's timeline window (J7). A known window lists the events of the trip's own plugin session from
 * `fromEventSeq` through `throughEventSeq`. It starts at the earlier of the opening event and the job configuration;
 * for a trip opened from a checkpoint, at the checkpoint's nextEventSeq. `null` means no upper bound: the trip is open, or another plugin session
 * closed it (`end-of-session`). `close-event` includes the event that closed the trip; `close-gap` ends just before
 * the first eventSeq a gap newly covered. A trip closed before schema version 2 recorded no close carrier: its window
 * is unknown, and its timeline lists only the events of its session attributed to it or referenced by it.
 */
export type JournalWindow = (
  | {known: true; pluginSessionId: string; fromEventSeq: Uint64; throughEventSeq: Uint64 | null; end: 'open' | 'close-event' | 'close-gap' | 'close-observation' | 'end-of-session'}
  | {known: false; pluginSessionId: string}) & {sourceCount?:number};

/** One completeness interval of a trip. `annotation` marks a discontinuity that never downgrades completeness. */
export interface JournalInterval {
  pluginSessionId?: string; rawTripUuid?: string;
  id: string; kind: JournalIntervalKind; annotation: boolean; cause: string | null;
  startUtcMs: number | null; endUtcMs: number | null;
  /** Source monotonic bounds, both in `sourceClockId`. */
  startMonotonicNs: Uint64 | null; endMonotonicNs: Uint64 | null; sourceClockId: string | null;
  firstEventSeq: Uint64 | null; lastEventSeq: Uint64 | null;
  detail: Record<string, unknown> | null;
}
export interface JournalRecordingSource {id:string;rawTripUuid:string;pluginSessionId:string;fromEventSeq:Uint64;throughEventSeq:Uint64;lastSampleId:string|null;lastIntervalId:string|null}
export interface JournalIntervalPage {sources?:JournalRecordingSource[];sourceTotal?:number;nextSourceCursor?:string|null;database: JournalDatabase; intervals: JournalInterval[]; total: number; nextCursor: string | null}

/** One timeline event: the stored protocol v1 occurrence and record, and the event's trip attribution, if any. */
export interface JournalEvent {
  id?: string; pluginSessionId?: string; rawTripUuid?: string;
  eventSeq: Uint64; type: EventRecord['type']; occurred: EventOccurrence; record: EventRecord;
  attribution: {kind: JournalAttributionKind; tripUuid: string | null; logicalTripUuid?:string} | null;
}
export interface JournalEventPage {database: JournalDatabase; window: JournalWindow; events: JournalEvent[]; nextCursor: string | null}

/**
 * An exact sum of the trip's attributed amounts of one category, SDK type and currency basis. `raw` is decimal text of
 * the BigInt sum and may exceed the SDK type's range; it is never converted, netted or summed across currencies.
 */
export interface JournalMoneyTotal {category: JournalMoneyCategory; sdkType: 's64' | 'u64'; currency: Currency; raw: string; count: number}
export interface JournalMoneyUnavailable {category: JournalMoneyCategory; reason: UnavailableReason; count: number}
/**
 * Fines, tolls, ferry and train amounts attributed to the trip. With more than JOURNAL_MONEY_AMOUNTS amounts nothing is
 * summed: `incomplete` is true and both lists are empty, so a partial sum is never shown as a total.
 */
export interface JournalMoneyTotals {incomplete: boolean; totals: JournalMoneyTotal[]; unavailable: JournalMoneyUnavailable[]}

export type JournalOutcomeRecord = Extract<EventRecord, {type: 'job.delivered'} | {type: 'job.cancelled'}>;
export interface JournalTripDetail {
  database: JournalDatabase;
  trip: JournalTripListItem & {
    pluginSessionId: string;
    /**
     * How the trip opened (schema version 2): at its `job.configured` event (`openedEventSeq`), or from a checkpoint
     * without an opening event (`openedEventSeq` null). Checkpoint openings are written only from ET-016b PR-7 on.
     */
    openedBy: 'event' | 'checkpoint'; openedEventSeq: Uint64 | null; outcomeEventSeq: Uint64 | null;
    /** The plugin session and eventSeq of the item that closed the trip; null while open and for trips closed before schema version 2. */
    closedBy: {pluginSessionId: string; eventSeq: Uint64} | null;
  };
  /** The job values in canonical units: from its `job.configured` event, or from a checkpoint (`checkpointNextEventSeq`). */
  job: {source: 'event' | 'checkpoint'; eventSeq: Uint64 | null; checkpointNextEventSeq: Uint64 | null; values: JobConfiguration};
  truck: {eventSeq: Uint64; values: TruckConfiguration} | null;
  /**
   * The latest JOURNAL_DETAIL_TRAILERS trailer configurations of the trip in commit order, and how many the trip holds.
   * A trip that was given more (a trailer re-sent or changed while it was open) shows only the latest ones here.
   */
  trailers: {items: {eventSeq: Uint64; values: TrailerConfiguration; pluginSessionId?:string;rawTripUuid?:string}[]; total: number};
  /** The gameplay outcome event with its revenue or penalty; null unless the trip was delivered or cancelled. */
  outcomeDetails: {eventSeq: Uint64; record: JournalOutcomeRecord} | null;
  money: JournalMoneyTotals;
  window: JournalWindow;
  /** The first JOURNAL_DETAIL_INTERVALS intervals, the trip's total and the cursor of the next `journalIntervals` page. */
  intervals: {items: JournalInterval[]; total: number; nextCursor: string | null};
  /** The trip's one-second samples: their number and the UTC labels of the first and the last. */
  samples: {count: number; firstUtcMs: number | null; lastUtcMs: number | null};
  /**
   * Fixed at this read (J17): the trip session's committed coverage and the largest sample and interval ids of the
   * trip. An export of a trip that is still changing stops at them.
   */
  exportBounds: {snapshot?: {events: string; intervals: string; samples: string; sources: string}; sourceTotal?:number; accountingHead?:string|null; sources?: {pluginSessionId: string; committedThroughEventSeq: Uint64}[]; committedThroughEventSeq: Uint64; lastSampleId: string | null; lastIntervalId: string | null};
}

/** A trip, sample or interval cursor: the decimal row id of the last row read, 1 to 2^63 - 1. */
const ROW_CURSOR = /^[1-9][0-9]{0,18}$/;
const MAX_ROW_ID = 9_223_372_036_854_775_807n;
/** An event cursor: the canonical eventSeq of the last event read, 1 to 2^64 - 2. */
const EVENT_CURSOR = /^[1-9][0-9]{0,19}$/;
const MAX_EVENT_SEQ = 18_446_744_073_709_551_614n;
export const isJournalRowCursor = (value: unknown): value is string => typeof value === 'string' && ROW_CURSOR.test(value) && BigInt(value) <= MAX_ROW_ID;
export const isJournalEventCursor = (value: unknown): value is string => typeof value === 'string' && EVENT_CURSOR.test(value) && BigInt(value) <= MAX_EVENT_SEQ;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Versioned source-qualified page token. Numeric row/event cursors remain accepted for legacy pages. */
export const isJournalListCursor = (value: unknown): value is string => typeof value === 'string' && value.length <= 160
  && /^l4:[0-9a-f-]{36}:(0|[1-9][0-9]{0,18}):[1-9][0-9]{0,18}:(ets2|ats|any)\.(open|delivered|cancelled|none|any)\.(complete|partial|unknown|any)$/.test(value)
  && BigInt(value.split(':')[2]) <= MAX_ROW_ID && BigInt(value.split(':')[3]) <= MAX_ROW_ID;
export const isJournalSnapshotCursor = (value: unknown): value is string => typeof value === 'string' && value.length <= 240
  && /^v4:[0-9a-f-]{36}:[0-9a-f-]{36}:[1-9][0-9]{0,18}:[eisr]:(0|[1-9][0-9]{0,18})$/.test(value)
  && BigInt(value.split(':')[3]) <= MAX_ROW_ID && BigInt(value.split(':')[5]) <= MAX_ROW_ID;
export const journalCursorPosition = (value: string) => isJournalSnapshotCursor(value) ? value.split(':')[5] : value;
export const isJournalUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Exactly the listed keys; a key whose value is undefined counts as absent, as after a structured clone of a copied field. */
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.entries(value).every(([key, field]) => keys.includes(key) || field === undefined);
}
const GAMES: readonly unknown[] = ['ets2', 'ats'], OUTCOMES: readonly unknown[] = ['open', 'delivered', 'cancelled', 'none'];
const COMPLETENESS: readonly unknown[] = ['complete', 'partial', 'unknown'];
/** A strict `journalTrips` query: absent, or an object of only the listed filters with listed values and a valid cursor. */
export function isJournalTripsQuery(value: unknown): value is JournalTripsQuery | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKeys(value, ['cursor', 'game', 'outcome', 'completeness'])) return false;
  return (value.cursor === undefined || (isJournalRowCursor(value.cursor) || isJournalListCursor(value.cursor))) && (value.game === undefined || GAMES.includes(value.game))
    && (value.outcome === undefined || OUTCOMES.includes(value.outcome)) && (value.completeness === undefined || COMPLETENESS.includes(value.completeness));
}
/** A strict page query: a `limit` from the allowed set and an optional cursor of the given kind. */
export function isJournalPageQuery(value: unknown, limits: readonly number[], cursor: 'row' | 'event'): value is JournalPageQuery {
  if (!isRecord(value) || !onlyKeys(value, ['cursor', 'limit'])) return false;
  return limits.includes(value.limit as number) && (value.cursor === undefined || (isJournalSnapshotCursor(value.cursor) || (cursor === 'row' ? isJournalRowCursor(value.cursor) : isJournalEventCursor(value.cursor))));
}

/** Thrown by the validators below for any value that is not exactly the documented shape. */
export class JournalContractError extends Error {}
const bad = (): never => { throw new JournalContractError('Invalid journal value'); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) bad();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(key => !Object.hasOwn(o, key))) bad();
  return o;
}
const oneOf = (value: unknown, options: readonly unknown[]) => { if (!options.includes(value)) bad(); };
const nullable = (value: unknown, check: (value: unknown) => void) => { if (value !== null) check(value); };
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown) => { if (!isCount(value)) bad(); };
const utcMs = count;
const boolean = (value: unknown) => { if (typeof value !== 'boolean') bad(); };
const text = (value: unknown) => { if (typeof value !== 'string') bad(); };
const uuid = (value: unknown) => { if (!isJournalUuid(value)) bad(); };
const rowId = (value: unknown) => { if (!isJournalRowCursor(value)) bad(); };
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const uint64 = (value: unknown) => { if (typeof value !== 'string' || !U64.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) bad(); };
const eventSeq = (value: unknown) => { if (!isJournalEventCursor(value)) bad(); };
const positiveUint64 = (value: unknown) => { uint64(value); if (value === '0') bad(); };
const REASONS: readonly unknown[] = ['not-supported', 'not-observed', 'invalid'];
function available(value: unknown, check: (value: unknown) => void): void {
  if (isRecord(value) && value.available === true) { check(exact(value, ['available', 'value']).value); return; }
  oneOf(exact(value, ['available', 'reason']).reason, REASONS);
}
const nonNegative = (value: unknown) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad(); };
/** A protocol v1 measure: an availability object with its fixed `unit`. */
function measure(value: unknown, unit: string, check: (value: unknown) => void): void {
  if (isRecord(value) && value.available === true) { const o = exact(value, ['available', 'value', 'unit']); if (o.unit !== unit) bad(); check(o.value); return; }
  const o = exact(value, ['available', 'reason', 'unit']);
  if (o.unit !== unit) bad();
  oneOf(o.reason, REASONS);
}
function currency(value: unknown): void {
  if (isRecord(value) && value.status === 'unknown') { exact(value, ['status']); return; }
  const o = exact(value, ['status', 'code', 'source']);
  if (o.status !== 'sdk-documented' || typeof o.code !== 'string' || !/^[A-Z]{3}$/.test(o.code) || typeof o.source !== 'string' || o.source.length === 0) bad();
}
function money(value: unknown, sdkType: 's64' | 'u64'): void {
  const o = exact(value, ['raw', 'sdkType', 'currency']);
  if (o.sdkType !== sdkType || typeof o.raw !== 'string' || !(sdkType === 'u64' ? /^(0|[1-9][0-9]{0,19})$/ : /^(0|-?[1-9][0-9]{0,18})$/).test(o.raw)) bad();
  const n = BigInt(o.raw as string);
  if (sdkType === 'u64' ? n > 18_446_744_073_709_551_615n : n < -(2n ** 63n) || n > 2n ** 63n - 1n) bad();
  currency(o.currency);
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const NOT_OBSERVED = {available: false, reason: 'not-observed'};
/** An occurrence with nothing observed, for checking a record that is not a stored event (job, truck and trailer values). */
const NO_OCCURRENCE = {monotonicNs: NOT_OBSERVED, gameTime: {minutes: NOT_OBSERVED, clockId: ZERO_UUID}, utcUnixMs: NOT_OBSERVED, simulation: 'unavailable', configurationRevision: '0', boundaryOrder: '0'};
/**
 * Checks a protocol v1 event record and occurrence with the protocol's own strict validator, wrapped in an event
 * envelope whose source and capture time accept any stored occurrence. Journal records are read back from validated
 * stored payloads, so this only refuses a value that a faulty worker changed.
 */
function protocolRecord(record: unknown, occurred: unknown = NO_OCCURRENCE): void {
  try {
    validateServerMessage({version: {major: 1, minor: 0}, kind: 'event', seq: '1', capture: {clockId: ZERO_UUID, monotonicNs: '18446744073709551615'},
      source: {game: 'ets2', pluginSessionId: ZERO_UUID, processInstanceId: ZERO_UUID, processId: 1, windowsSessionId: 0, origin: 'synthetic'},
      data: {eventSeq: '1', redelivered: false, occurred, record}});
  } catch { bad(); }
}
/** Configuration values: the record fields of their configured event without its `type`. */
function configuration(value: unknown, type: 'job.configured' | 'truck.configured' | 'trailer.configured'): void {
  if (!isRecord(value) || Object.hasOwn(value, 'type')) bad();
  protocolRecord({type, ...(value as Record<string, unknown>)});
}

function database(value: unknown): void {
  const o = exact(value, ['purpose', 'schemaVersion']);
  oneOf(o.purpose, ['history', 'synthetic', 'replay']);
  if (!Number.isSafeInteger(o.schemaVersion) || (o.schemaVersion as number) < 1) bad();
}
function gameMode(value: unknown): void {
  const o = exact(value, ['mode', 'method', 'confidence']);
  oneOf(o.mode, ['single-player', 'truckersmp', 'unknown', 'convoy']); oneOf(o.method, ['module-scan', 'process-scan', 'none']); oneOf(o.confidence, ['strong', 'weak', 'none']);
}
const LIST_KEYS = ['isHardMode', 'hardModeDetails', 'tripUuid', 'game', 'gameMode', 'gameModeAmbiguous', 'outcome', 'closeReason', 'recordingCompleteness', 'startedUtcMs', 'endedUtcMs', 'observedDistanceM', 'fuelUsedL', 'job'];
const CLOSE_REASONS: readonly unknown[] = ['outcome', 'configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap'];
function listItem(o: Record<string, unknown>): void {
  boolean(o.isHardMode); if (o.hardModeDetails !== null && !isHardModeDetails(o.hardModeDetails)) bad();
  // Qualified audits retain legacy true or the current null compatibility value.
  const audit = o.hardModeDetails as HardModeDetails | null;
  if (audit?.version === 2) {
    const known = BigInt(audit.passingChecks) + BigInt(audit.failingChecks);
    if (o.isHardMode !== (o.outcome === 'delivered' && known > 0n && BigInt(audit.passingChecks) * 100n >= known * 95n)) bad();
  } else if (o.isHardMode && (o.outcome !== 'delivered' || audit === null || audit.firstLoss !== null || audit.manualDelivery === false)) bad();
  uuid(o.tripUuid); oneOf(o.game, GAMES); gameMode(o.gameMode); boolean(o.gameModeAmbiguous); oneOf(o.outcome, OUTCOMES);
  nullable(o.closeReason, value => oneOf(value, CLOSE_REASONS)); oneOf(o.recordingCompleteness, COMPLETENESS);
  if ((o.outcome === 'open') !== (o.closeReason === null) || (o.outcome === 'open') !== (o.endedUtcMs === null)) bad();
  utcMs(o.startedUtcMs); nullable(o.endedUtcMs, utcMs);
  available(o.observedDistanceM, nonNegative); available(o.fuelUsedL, nonNegative);
  const job = exact(o.job, ['source', 'sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany', 'cargo', 'market', 'isSpecialJob', 'plannedDistance', 'expectedIncome']);
  oneOf(job.source, ['event', 'checkpoint']);
  for (const key of ['sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany', 'cargo', 'market']) available(job[key], text);
  available(job.isSpecialJob, boolean);
  measure(job.plannedDistance, 'm', nonNegative);
  available(job.expectedIncome, value => money(value, 'u64'));
}
function window(value: unknown): void {
  if(isRecord(value)&&value.sourceCount!==undefined){count(value.sourceCount);if((value.sourceCount as number)<2)bad();}
  if (isRecord(value) && value.known === false) { uuid(exact(value, [...(value.sourceCount!==undefined?['sourceCount']:[]),'known', 'pluginSessionId']).pluginSessionId); return; }
  const o = exact(value, [...(isRecord(value)&&value.sourceCount!==undefined?['sourceCount']:[]),'known', 'pluginSessionId', 'fromEventSeq', 'throughEventSeq', 'end']);
  if (o.known !== true) bad();
  // The window can start at a checkpoint's nextEventSeq, which the schema allows up to 2^64 - 1.
  uuid(o.pluginSessionId); positiveUint64(o.fromEventSeq); nullable(o.throughEventSeq, uint64);
  oneOf(o.end, ['open', 'close-event', 'close-gap','close-observation', 'end-of-session']);
  if ((o.throughEventSeq === null) !== (o.end === 'open' || o.end === 'end-of-session')) bad();
}
const INTERVAL_KINDS: readonly unknown[] = ['event-loss', 'not-connected', 'storage-unavailable', 'sample-loss', 'discontinuity', 'restore-loss'];
function interval(value: unknown): void {
  const o = exact(value, [...(isRecord(value) && value.pluginSessionId !== undefined ? ['pluginSessionId', 'rawTripUuid'] : []), 'id', 'kind', 'annotation', 'cause', 'startUtcMs', 'endUtcMs', 'startMonotonicNs', 'endMonotonicNs', 'sourceClockId', 'firstEventSeq', 'lastEventSeq', 'detail']);
  if (o.pluginSessionId !== undefined) {uuid(o.pluginSessionId); uuid(o.rawTripUuid);}
  rowId(o.id); oneOf(o.kind, INTERVAL_KINDS); boolean(o.annotation); nullable(o.cause, text);
  nullable(o.startUtcMs, utcMs); nullable(o.endUtcMs, utcMs); nullable(o.startMonotonicNs, uint64); nullable(o.endMonotonicNs, uint64); nullable(o.sourceClockId, uuid);
  // Interval eventSeq bounds are any 20-digit key in the schema, so 0 and 2^64 - 1 are accepted here too.
  nullable(o.firstEventSeq, uint64); nullable(o.lastEventSeq, uint64);
  nullable(o.detail, detail => { if (!isRecord(detail)) bad(); });
  // The flags are read from the detail, so they must agree with it.
  const d = o.detail as Record<string, unknown> | null;
  if (o.annotation !== (d?.annotation === true) || o.cause !== (typeof d?.cause === 'string' ? d.cause : null)) bad();
}
const ATTRIBUTIONS: readonly unknown[] = ['trip', 'trip-before-loaded', 'free-driving', 'ambiguous'];
function event(value: unknown): void {
  const o = exact(value, [...(isRecord(value) && value.pluginSessionId !== undefined ? ['id', 'pluginSessionId', 'rawTripUuid'] : []), 'eventSeq', 'type', 'occurred', 'record', 'attribution']);
  if (o.pluginSessionId !== undefined) {rowId(o.id); uuid(o.pluginSessionId); uuid(o.rawTripUuid);}
  eventSeq(o.eventSeq);
  if (!isRecord(o.record) || o.record.type !== o.type) bad();
  protocolRecord(o.record, o.occurred);
  nullable(o.attribution, attribution => {
    const a = exact(attribution, [...(isRecord(attribution)&&attribution.logicalTripUuid!==undefined?['logicalTripUuid']:[]),'kind', 'tripUuid']);
    if(a.logicalTripUuid!==undefined)uuid(a.logicalTripUuid);
    oneOf(a.kind, ATTRIBUTIONS); nullable(a.tripUuid, uuid);
    if ((a.tripUuid === null) !== (a.kind === 'free-driving' || a.kind === 'ambiguous')) bad();
  });
}
const CATEGORIES: readonly unknown[] = ['fine', 'toll', 'ferry', 'train'];
function moneyTotals(value: unknown): void {
  const o = exact(value, ['incomplete', 'totals', 'unavailable']);
  boolean(o.incomplete);
  // Each total and each unavailable count stands for at least one of at most JOURNAL_MONEY_AMOUNTS amounts.
  if (!Array.isArray(o.totals) || !Array.isArray(o.unavailable) || o.totals.length + o.unavailable.length > JOURNAL_MONEY_AMOUNTS) bad();
  const totals = o.totals as unknown[], unavailable = o.unavailable as unknown[];
  if (o.incomplete === true && (totals.length > 0 || unavailable.length > 0)) bad();
  for (const total of totals) {
    const t = exact(total, ['category', 'sdkType', 'currency', 'raw', 'count']);
    oneOf(t.category, CATEGORIES); oneOf(t.sdkType, ['s64', 'u64']); currency(t.currency);
    if (typeof t.raw !== 'string' || !/^(0|-?[1-9][0-9]{0,24})$/.test(t.raw) || !isCount(t.count) || (t.count as number) < 1) bad();
  }
  for (const entry of unavailable) {
    const u = exact(entry, ['category', 'reason', 'count']);
    oneOf(u.category, CATEGORIES); oneOf(u.reason, REASONS);
    if (!isCount(u.count) || (u.count as number) < 1) bad();
  }
}

/**
 * One page of rows: at most `limit` rows, and a next cursor exactly when the page is full, as every journal read
 * builds it. An answer longer than the request is invalid, so a caller can rely on one page (review pass 1).
 */
function page(rows: unknown, limit: number, cursor: unknown, check: (value: unknown) => void): unknown[] {
  if (!Array.isArray(rows) || rows.length > limit) bad();
  const list = rows as unknown[];
  nullable(cursor, check);
  if ((cursor !== null) !== (list.length === limit)) bad();
  return list;
}
/** Validates a `journalTrips` answer exactly; throws JournalContractError otherwise. */
export function validateJournalTripPage(value: unknown): JournalTripPage {
  const o = exact(value, ['database', 'trips', 'nextCursor', ...(isRecord(value) && Object.hasOwn(value, 'sync') ? ['sync'] : [])]);
  database(o.database);
  for (const trip of page(o.trips, JOURNAL_TRIP_PAGE, o.nextCursor, value => {if (!isJournalListCursor(value)) rowId(value);})) listItem(exact(trip, LIST_KEYS));
  if (Object.hasOwn(o, 'sync')) {
    const sync = exact(o.sync, ['owner', 'connectionVersion', 'rows']);
    if (!isDashboardOwner(sync.owner) || (o.database as JournalDatabase).purpose !== 'history') bad();
    uint64(sync.connectionVersion);
    if (!Array.isArray(sync.rows) || sync.rows.length !== (o.trips as JournalTripListItem[]).length) bad();
    const seen = new Set<string>();
    for (const [index, item] of (sync.rows as unknown[]).entries()) {
      const row = exact(item, ['tripUuid', 'state', 'materialVersion', 'latestRevision', 'lastDurableUploadUtcMs', 'reason']);
      uuid(row.tripUuid);
      if (row.tripUuid !== (o.trips as JournalTripListItem[])[index].tripUuid || seen.has(row.tripUuid)) bad();
      seen.add(row.tripUuid as string);
      oneOf(row.state, ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent']);
      nullable(row.materialVersion, positiveUint64); nullable(row.latestRevision, value => {count(value); if (value === 0) bad();});
      nullable(row.lastDurableUploadUtcMs, utcMs); nullable(row.reason, value => oneOf(value, ['validation', 'reconciliation']));
      if (row.state === 'unavailable' || row.state === 'unbound') {
        if (row.materialVersion !== null || row.latestRevision !== null || row.lastDurableUploadUtcMs !== null || row.reason !== null) bad();
      }
      if ((row.reason !== null) !== (row.state === 'held') || row.state === 'sent' && (row.materialVersion === null || row.latestRevision === null || row.lastDurableUploadUtcMs === null)) bad();
      if (['queued', 'sending'].includes(row.state as string) && (row.materialVersion === null || row.latestRevision === null)) bad();
      if (row.state !== 'sent' && row.lastDurableUploadUtcMs !== null) bad();
    }
  }
  return value as JournalTripPage;
}
/**
 * Validates a `journalEvents` answer to a request of `limit` events exactly; throws JournalContractError otherwise.
 * Without a limit the largest allowed page applies.
 */
export function validateJournalEventPage(value: unknown, limit = Math.max(...JOURNAL_EVENT_LIMITS)): JournalEventPage {
  const o = exact(value, ['database', 'window', 'events', 'nextCursor']);
  database(o.database); window(o.window);
  for (const item of page(o.events, limit, o.nextCursor, value => {if (!isJournalSnapshotCursor(value)) eventSeq(value);})) event(item);
  return value as JournalEventPage;
}
/**
 * Validates a `journalIntervals` answer to a request of `limit` intervals exactly; throws JournalContractError otherwise.
 * Without a limit the largest allowed page applies.
 */
export function validateJournalIntervalPage(value: unknown, limit = Math.max(...JOURNAL_INTERVAL_LIMITS)): JournalIntervalPage {
  const o = exact(value, [...(isRecord(value) && value.sources !== undefined ? ['sources','sourceTotal','nextSourceCursor']:[]),'database', 'intervals', 'total', 'nextCursor']);
  if (o.sources !== undefined) {
    count(o.sourceTotal);for(const source of page(o.sources,limit,o.nextSourceCursor,value=>{if(!isJournalSnapshotCursor(value)||value.split(':')[4]!=='r')bad();})) {
      const row=exact(source,['id','rawTripUuid','pluginSessionId','fromEventSeq','throughEventSeq','lastSampleId','lastIntervalId']);
      rowId(row.id);uuid(row.rawTripUuid);uuid(row.pluginSessionId);positiveUint64(row.fromEventSeq);uint64(row.throughEventSeq);nullable(row.lastSampleId,rowId);nullable(row.lastIntervalId,rowId);
    }
    if(!Array.isArray(o.intervals)||o.intervals.length!==0||o.total!==0||o.nextCursor!==null)bad();
  }
  database(o.database); count(o.total);
  const list = page(o.intervals, limit, o.nextCursor, value => {if (!isJournalSnapshotCursor(value)) rowId(value);});
  if (list.length > (o.total as number)) bad();
  for (const item of list) interval(item);
  return value as JournalIntervalPage;
}
/** Validates a `journalTrip` answer exactly; throws JournalContractError otherwise. */
export function validateJournalTripDetail(value: unknown): JournalTripDetail {
  const o = exact(value, ['database', 'trip', 'job', 'truck', 'trailers', 'outcomeDetails', 'money', 'window', 'intervals', 'samples', 'exportBounds']);
  database(o.database);
  const trip = exact(o.trip, [...LIST_KEYS, 'pluginSessionId', 'openedBy', 'openedEventSeq', 'outcomeEventSeq', 'closedBy']);
  listItem(trip); uuid(trip.pluginSessionId); oneOf(trip.openedBy, ['event', 'checkpoint']); nullable(trip.openedEventSeq, eventSeq); nullable(trip.outcomeEventSeq, eventSeq);
  if ((trip.openedBy === 'event') !== (trip.openedEventSeq !== null)) bad();
  if ((trip.outcomeEventSeq === null) !== (trip.outcome !== 'delivered' && trip.outcome !== 'cancelled')) bad();
  nullable(trip.closedBy, closedBy => { const c = exact(closedBy, ['pluginSessionId', 'eventSeq']); uuid(c.pluginSessionId); eventSeq(c.eventSeq); });
  if (trip.outcome === 'open' && trip.closedBy !== null) bad();
  const job = exact(o.job, ['source', 'eventSeq', 'checkpointNextEventSeq', 'values']);
  oneOf(job.source, ['event', 'checkpoint']); nullable(job.eventSeq, eventSeq); nullable(job.checkpointNextEventSeq, uint64);
  if ((job.source === 'event') !== (job.eventSeq !== null) || (job.source === 'checkpoint') !== (job.checkpointNextEventSeq !== null)) bad();
  if (job.source !== (trip.job as Record<string, unknown>).source) bad();
  configuration(job.values, 'job.configured');
  nullable(o.truck, truck => { const t = exact(truck, ['eventSeq', 'values']); eventSeq(t.eventSeq); configuration(t.values, 'truck.configured'); });
  const trailers = exact(o.trailers, ['items', 'total']);
  count(trailers.total);
  if (!Array.isArray(trailers.items) || trailers.items.length !== Math.min(JOURNAL_DETAIL_TRAILERS, trailers.total as number)) bad();
  for (const trailer of trailers.items as unknown[]) {
    const qualified=isRecord(trailer) && trailer.pluginSessionId!==undefined;
    const t = exact(trailer, [...(qualified?['pluginSessionId','rawTripUuid']:[]),'eventSeq', 'values']);
    if(qualified){uuid(t.pluginSessionId);uuid(t.rawTripUuid);}eventSeq(t.eventSeq); configuration(t.values, 'trailer.configured');
  }
  nullable(o.outcomeDetails, details => {
    const d = exact(details, ['eventSeq', 'record']); eventSeq(d.eventSeq);
    if (!isRecord(d.record) || d.record.type !== (trip.outcome === 'delivered' ? 'job.delivered' : 'job.cancelled')) bad();
    protocolRecord(d.record);
  });
  if ((o.outcomeDetails === null) !== (trip.outcomeEventSeq === null)) bad();
  moneyTotals(o.money); window(o.window);
  if ((o.window as Record<string, unknown>).pluginSessionId !== trip.pluginSessionId) bad();
  const intervals = exact(o.intervals, ['items', 'total', 'nextCursor']);
  count(intervals.total);
  const items = page(intervals.items, JOURNAL_DETAIL_INTERVALS, intervals.nextCursor, value => {if (!isJournalSnapshotCursor(value)) rowId(value);});
  if (items.length !== Math.min(JOURNAL_DETAIL_INTERVALS, intervals.total as number)) bad();
  for (const item of items) interval(item);
  const samples = exact(o.samples, ['count', 'firstUtcMs', 'lastUtcMs']);
  count(samples.count); nullable(samples.firstUtcMs, utcMs); nullable(samples.lastUtcMs, utcMs);
  if ((samples.count === 0) !== (samples.firstUtcMs === null) || (samples.firstUtcMs === null) !== (samples.lastUtcMs === null)) bad();
  const bounds = exact(o.exportBounds, [...(isRecord(o.exportBounds) && o.exportBounds.snapshot !== undefined ? ['snapshot', 'sources','sourceTotal','accountingHead'] : []), 'committedThroughEventSeq', 'lastSampleId', 'lastIntervalId']);
  if (bounds.snapshot !== undefined) {
    const tokens = exact(bounds.snapshot, ['events', 'intervals', 'samples','sources']);
    for (const [kind, key] of [['e', 'events'], ['i', 'intervals'], ['s', 'samples'],['r','sources']] as const) if (!isJournalSnapshotCursor(tokens[key]) || String(tokens[key]).split(':')[4] !== kind) bad();
    count(bounds.sourceTotal);nullable(bounds.accountingHead,rowId);
    if (!Array.isArray(bounds.sources) || bounds.sources.length > 256) bad();
    for (const source of bounds.sources as unknown[]) {const row = exact(source, ['pluginSessionId', 'committedThroughEventSeq']); uuid(row.pluginSessionId); uint64(row.committedThroughEventSeq);}
  }
  uint64(bounds.committedThroughEventSeq); nullable(bounds.lastSampleId, rowId); nullable(bounds.lastIntervalId, rowId);
  if ((bounds.lastSampleId === null) !== (samples.count === 0) || (bounds.lastIntervalId === null) !== (intervals.total === 0)) bad();
  return value as JournalTripDetail;
}
