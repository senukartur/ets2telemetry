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
export interface OpenSummary {schemaVersion: number; created: boolean; migratedFrom?: number; backupFileName?: string; databaseUuid: string; purpose: Purpose}

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
/** In-process test hooks only; never part of a worker message. */
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
