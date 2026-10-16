// Typed storage commands, results, errors and trip effects. Node-safe: no native SQLite, Electron or filesystem
// access, so the Node-safe test suite and a future worker client can import it. See docs/storage.md.
import type {Available, GameMode, Uint64} from '../../contracts/src/protocol-v1';

export type {Uint64};
/** What a database file holds. History accepts only game data; synthetic and replay data live in separate files. */
export type Purpose = 'history' | 'synthetic' | 'replay';
export type Origin = 'game' | 'synthetic' | 'replay';
/** Each purpose accepts exactly one envelope origin, enforced by a schema trigger as well. */
export const ACCEPTED_ORIGIN: Readonly<Record<Purpose, Origin>> = {history: 'game', synthetic: 'synthetic', replay: 'replay'};

export type StorageErrorCode =
  | 'DATABASE_LOCKED' | 'PERMISSION_DENIED' | 'DISK_FULL' | 'IO_ERROR' | 'DATABASE_CORRUPT' | 'CONSTRAINT_VIOLATION'
  | 'INVALID_INPUT' | 'UNKNOWN_SESSION' | 'UNKNOWN_TRIP' | 'SESSION_CONFLICT' | 'VALUE_OUT_OF_RANGE'
  | 'STORAGE_CLOSED' | 'STORAGE_BUSY' | 'WORKER_FAILED' | 'TIMEOUT' | 'DATA_PATH_INVALID'
  | 'DATABASE_UNRECOGNIZED' | 'SCHEMA_NEWER' | 'PURPOSE_MISMATCH' | 'DURABILITY_UNVERIFIED' | 'BACKUP_FAILED' | 'MIGRATION_FAILED'
  // An unexpected failure inside the storage code itself; never retried automatically.
  | 'INTERNAL';
/**
 * A failed command. `message` is fixed text for the code and never contains a filesystem path or SQLite message.
 * `cause` refines BACKUP_FAILED and MIGRATION_FAILED; `backupFileName` is a bare file name, never a path.
 */
export interface StorageError {
  code: StorageErrorCode; retryable: boolean; message: string;
  sqliteCode?: string; cause?: StorageErrorCode; backupFileName?: string;
}
export type Result<T> = {ok: true; value: T} | {ok: false; error: StorageError};

/** Read back on every writer open; a write is refused unless every value matched. */
export interface Durability {journalMode: 'wal'; synchronous: 'full'; lockingMode: 'exclusive'; foreignKeys: true}
/** `removedPartialBackups` is present only when the open removed stale partial backup files of this database. */
export interface OpenSummary {schemaVersion: number; created: boolean; migratedFrom?: number; backupFileName?: string; databaseUuid: string; purpose: Purpose; removedPartialBackups?: number}

export type SampleField = 'speed' | 'fuel' | 'averageConsumption' | 'estimatedRange' | 'engineRpm' | 'gear' | 'odometer' | 'position' | 'gameTime';
/**
 * One 1 Hz history sample in canonical units: m/s, L, L/100 km, m, rpm, gear index and game-world coordinates.
 * `monotonicNs` is in the source clock `sourceClockId`; `utcMs` is a label only. Game minutes, when present, are in
 * their own game clock. Not observed, not supported and invalid readings stay distinct from zero.
 */
export interface SampleInput {
  tripUuid?: string | null; utcMs: number; sourceClockId: string; monotonicNs: Uint64;
  gameTime: {minutes: Available<number>; clockId: string} | null;
  speed: Available<number>; fuel: Available<number>; averageConsumption: Available<number>; estimatedRange: Available<number>;
  engineRpm: Available<number>; gear: Available<number>; odometer: Available<number>;
  position: Available<{x: number; y: number; z: number}>;
}
export interface SampleRecord extends SampleInput {id: string; tripUuid: string | null}
/**
 * `uniqueSeconds` (ET-015b, H6): keep at most one row per plugin session, source clock and source second, where the
 * source second is floor(monotonicNs / 1e9). Inside the transaction, each row is compared with the session's latest
 * stored row (by insertion order) and with the rows accepted earlier in the same batch: a row whose second is at or below
 * the last accepted second of its own source clock is skipped, and a row on another clock is accepted. Across commands
 * only the latest stored row is read, so a row that returns to a clock after a row on another clock is compared with
 * nothing stored for that clock; a plugin session's capture clock is constant, so the producer never does this. Every
 * row is still validated, including the trip reference of a skipped row, and an invalid row stores none of the batch.
 * A skipped row writes nothing, not even its clock rows.
 */
export interface SampleAppendOptions {uniqueSeconds?: boolean}
/** `skipped` counts the rows `uniqueSeconds` left out; it is 0 without the option. */
export interface SampleAppendResult {appended: number; skipped: number}

export type CompletenessKind = 'event-loss' | 'not-connected' | 'storage-unavailable' | 'sample-loss' | 'discontinuity' | 'restore-loss';
/** A known missing or discontinuous interval. It records the gap; it never fabricates data for it. */
export interface CompletenessInterval {
  tripUuid?: string | null; kind: CompletenessKind;
  startUtcMs?: number; endUtcMs?: number;
  /** Source monotonic bounds, both in `sourceClockId`. */
  startMonotonicNs?: Uint64; endMonotonicNs?: Uint64; sourceClockId?: string;
  firstEventSeq?: Uint64; lastEventSeq?: Uint64; detail?: Record<string, unknown>;
}

export type TripOutcome = 'open' | 'delivered' | 'cancelled' | 'none';
export type CloseReason = 'outcome' | 'configuration-cleared' | 'different-job' | 'restart' | 'discontinuity' | 'gap';
export type RecordingCompleteness = 'complete' | 'partial' | 'unknown';
export type Attribution = 'trip' | 'trip-before-loaded' | 'free-driving' | 'ambiguous';
/** A configuration event of the same plugin session, identified by its eventSeq; or the event being committed. */
export type EventReference = 'this-event' | {eventSeq: Uint64};
/**
 * Trip changes computed by the domain (ET-014) and applied in the same transaction as the event or gap that caused
 * them, only when that event or gap is inserted for the first time. Any failure rolls back the event as well.
 *
 * Every trip reference (trip.update, trip.close, event.attribute, completeness.add and sample tripUuid) must name a
 * trip of the current session's game; otherwise the command is INVALID_INPUT. A trip of an earlier plugin session of
 * the same game is allowed, because a new session closes it with close_reason 'restart'. A closed trip accepts only
 * trip.update of recordingCompleteness and observedDistanceM.
 */
export type TripEffect =
  | {kind: 'trip.open'; tripUuid: string; game: 'ets2' | 'ats'; gameMode: Pick<GameMode, 'mode' | 'method' | 'confidence'>; gameModeAmbiguous?: boolean;
    jobConfiguration: EventReference; truckConfiguration?: EventReference; trailerConfigurations?: EventReference[];
    recordingCompleteness: RecordingCompleteness; startedUtcMs: number}
  | {kind: 'trip.update'; tripUuid: string; set: {recordingCompleteness?: RecordingCompleteness; gameModeAmbiguous?: boolean;
    observedDistanceM?: Available<number>; truckConfiguration?: EventReference; trailerConfigurations?: EventReference[]}}
  | {kind: 'trip.close'; tripUuid: string; outcome: Exclude<TripOutcome, 'open'>; closeReason: CloseReason; outcomeEvent?: EventReference;
    recordingCompleteness: RecordingCompleteness; endedUtcMs: number}
  | {kind: 'event.attribute'; tripUuid: string | null; attribution: Attribution}
  | {kind: 'completeness.add'; interval: CompletenessInterval};
/**
 * A `listTrips` page with an optional filter, applied in SQL before the page limit (ET-015a, R12). `game` and `outcome`
 * narrow the trips; without them every trip is listed. `cursor` is the opaque `nextCursor` of the previous page read
 * with the same filter.
 */
export interface TripPage {cursor?: string; limit?: number; game?: 'ets2' | 'ats'; outcome?: TripOutcome}
export interface TripList {trips: TripRecord[]; nextCursor: string | null}
/**
 * `ifAbsent` (ET-015a, R12): skip the insert when the session already holds an interval with the same trip reference,
 * kind, first and last eventSeq and canonical detail, so a loss recorded again after a service restart adds no second
 * row. Labels and monotonic bounds are not compared. The result is the same whether or not a row was inserted.
 * `ifAbsent` requires both `firstEventSeq` and `lastEventSeq`; without them the command is INVALID_INPUT, because
 * two distinct outages that differ only in their labels would compare equal. It is meant for eventSeq-bounded
 * intervals such as the restore-loss interval (R9).
 */
export interface CompletenessOptions {ifAbsent?: boolean}
export const MAX_EFFECTS = 16;
export const MAX_SAMPLE_BATCH = 3_600;
export const MAX_EVENT_PAGE = 500;
export const MAX_TRIP_PAGE = 100;

export type CommitStatus = 'committed' | 'duplicate' | 'conflict' | 'covered';
/**
 * `committed`: the row and its effects were inserted. `duplicate`: the same key already held an identical payload, and
 * effects were not applied again. `conflict`: the key held a different payload; the stored row is kept (protocol v1 §9).
 * `covered`: a gap whose whole range is already inside committed coverage, such as a merged gap record redelivered
 * after an ACK inside it; nothing is stored and its effects are not applied, because rows for that range already exist.
 * `committedThroughEventSeq` is the session's contiguous coverage after the transaction, the input of DurableAckCursor.
 *
 * Gap rows may overlap other gap rows. The producer extends a retained gap record in place, so after an ACK inside it
 * the record is redelivered with a larger range that contains ranges already stored as separate rows (protocol v1 §9).
 * Each row keeps the cause counts of its own message: counts are per message, not additive across overlapping rows.
 * `previouslyCoveredThrough`, returned for every gap commit, is the coverage before this transaction. A stored gap is
 * new information only for (previouslyCoveredThrough, lastEventSeq]. Caller rule: effects supplied with a gap are
 * applied once, when its row is first stored, so derive them only for that suffix. Read committedThrough() right before
 * committing (the single writer keeps it unchanged until the commit) and check it against previouslyCoveredThrough.
 */
export interface CommitResult {status: CommitStatus; committedThroughEventSeq: Uint64; previouslyCoveredThrough?: Uint64}
/** In-process test hooks of commitEvent, commitGap and appendSamples (ET-015b); never part of a worker message. */
export interface CommitOptions {testHooks?: {beforeCommit?: () => void}}

export interface SessionRecord {
  pluginSessionId: string; game: 'ets2' | 'ats'; origin: Origin; processInstanceId: string; processId: number; windowsSessionId: number;
  protocolMinor: number; telemetryApi: {major: number; minor: number}; gameTelemetry: {major: number; minor: number}; sdkArchive: string;
  gameplayEvents: 'registered' | 'not-supported'; eventTypes: string[]; gameMode: GameMode;
  committedThroughEventSeq: Uint64; firstSeenUtcMs: number;
}
export interface EventRow {
  eventSeq: Uint64; type: string; occurred: unknown; record: unknown; firstRedelivered: boolean; protocolMinor: number; committedUtcMs: number;
}
export interface TripRecord {
  tripUuid: string; pluginSessionId: string; game: 'ets2' | 'ats'; gameMode: Pick<GameMode, 'mode' | 'method' | 'confidence'>; gameModeAmbiguous: boolean;
  jobConfigurationEventSeq: Uint64; truckConfigurationEventSeq: Uint64 | null; trailerConfigurationEventSeqs: Uint64[];
  openedEventSeq: Uint64; outcome: TripOutcome; outcomeEventSeq: Uint64 | null; closeReason: CloseReason | null;
  recordingCompleteness: RecordingCompleteness; startedUtcMs: number; endedUtcMs: number | null; observedDistanceM: Available<number>;
  createdUtcMs: number; updatedUtcMs: number;
}
export interface StorageInfo {
  schemaVersion: number; databaseUuid: string; purpose: Purpose; acceptedOrigin: Origin; durability: Durability;
  pageSize: number; pageCount: number; freelistCount: number;
}
/** Journal reads (ET-016 PR-2, J5): the query and page types live in the shared journal contract. */
export type {
  JournalEventPage, JournalIntervalPage, JournalPageQuery, JournalTripDetail, JournalTripPage, JournalTripsQuery
} from '../../contracts/src/journal';
/**
 * ET-016 review pass 1: the error of one journal command whose well-framed answer broke the journal contract. Only the
 * client produces it, for that command alone, and keeps running. It is not a StorageErrorCode: commits, sample appends,
 * the durable sink and the recording status never see it, and a worker cannot send it.
 */
export interface JournalAnswerError {code: 'JOURNAL_ANSWER_INVALID'; retryable: false; message: string}
export const JOURNAL_ANSWER_INVALID: Readonly<JournalAnswerError> = Object.freeze({code: 'JOURNAL_ANSWER_INVALID', retryable: false,
  message: 'The storage worker returned a journal page that does not match the journal contract.'});
/** The result of a journal command: a storage Result, or JOURNAL_ANSWER_INVALID for a page that broke the contract. */
export type JournalResult<T> = {ok: true; value: T} | {ok: false; error: StorageError | JournalAnswerError};
