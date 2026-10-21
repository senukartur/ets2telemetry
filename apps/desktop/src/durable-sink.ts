// The durable sink of protocol v1 ingestion (ET-006b, E1; ET-015a, R2): where a received event or gap marker is
// committed before the consumer may acknowledge it (docs/protocol/v1.md §10). Node-safe: it talks to storage only
// through the StorageClient interface and never loads native SQLite. `StorageDurableSink` commits messages without trip
// effects; the trip recorder (trip-recorder.ts) commits them with their ET-014 effects. Production passes no sink yet,
// so nothing is recorded or acknowledged; see docs/telemetry-service-v1.md.
import type {HardModeObservation} from '../../../packages/contracts/src/hard-mode';
import type {ServerMessage, Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CommitResult, SampleAppendResult, StorageError, StorageErrorCode} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
// A type-only import: the ingestion and the ACK pipeline still never load telemetry-core or the reducer at runtime.
import type {ReadingMessage} from '../../../packages/telemetry-core/src/history-samples';

export type WelcomeMessage = Extract<ServerMessage, {kind: 'welcome'}>;
/** A message that carries eventSeq coverage: one event or one gap marker. */
export type CoverageMessage = Extract<ServerMessage, {kind: 'event' | 'gap'}>;
/** A message that carries a reading of current state: the connection's checkpoint or a snapshot (the sampler's type). */
export type {ReadingMessage};

/**
 * R7: the trip recorder's fixed sink codes for a reducer result `ok: false`. They are contract defects between the
 * stream, storage and the reducer (T5 says fail closed), never retried. They live here, not in trip-recorder.ts, so the
 * ingestion and the ACK pipeline never load the reducer.
 */
export type RecorderErrorCode = 'TRIP_ORDER_VIOLATION' | 'TRIP_COVERAGE_MISMATCH' | 'TRIP_UNKNOWN_SESSION';
/** Every recorder code is `unavailable`: durable delivery stops for the service lifetime and the ingestion goes live-only. */
export const RECORDER_FAILURE_CLASS: Readonly<Record<RecorderErrorCode, 'unavailable'>> = {
  TRIP_ORDER_VIOLATION: 'unavailable', TRIP_COVERAGE_MISMATCH: 'unavailable', TRIP_UNKNOWN_SESSION: 'unavailable'
};
/** Every code a sink may fail with: the storage codes and the trip recorder's own codes (R7). */
export type SinkErrorCode = StorageErrorCode | RecorderErrorCode;
export type SinkError = Omit<StorageError, 'code'> & {code: SinkErrorCode};
export type SinkResult<T> = {ok: true; value: T} | {ok: false; error: SinkError};
/**
 * R8, H13: the consumer's UTC label, captured when the frame was decoded, never when its commit or observation runs.
 * Every event, gap, checkpoint and snapshot of a durable connection carries one.
 */
/** Bounded per-coverage intake evidence; the recorder may only latch the first later unsafe observation. */
export interface HardModeCapture {game: 'ets2' | 'ats'; observation: HardModeObservation; fresh: boolean; firstUnsafe: HardModeObservation | null}
export interface CommitContext {receivedUtcMs: number; hardModeCapture?: HardModeCapture}

/**
 * ET-015b (H2, H8, H11, H12): the sink's pending one-second samples, written only by DurableDelivery's `samples` op and
 * by its final write at `stop()`; it never produces or advances an ACK.
 * - `pending()`: the rows and the loss intervals (dropped runs) waiting to be written.
 * - `write(maxRows, final?)`: stores the next batch of one plugin session (its ended loss intervals, then at most
 *   `maxRows` rows) and drops them from the pending set only once stored; a failure keeps them. With `final` (the last
 *   write at `stop()`) loss runs that could still grow are written too.
 * - `discard()`: drops everything pending and returns the number of rows dropped.
 * - `dropped()`: rows dropped by the pending bound in the sink's lifetime.
 */
export interface SampleSink {
  pending(): {rows: number; losses: number};
  write(maxRows: number, final?: boolean): Promise<SinkResult<SampleAppendResult>>;
  discard(): number;
  dropped(): number;
}

/** What opening a late-attach trip did: stored it, found it stored already, or found none due. */
export type AttachStatus = 'committed' | 'duplicate' | 'none';
/**
 * ET-016 PR-7 (J9): the sink's late-attach trip, a trip opened from a checkpoint job once the replayed events drained.
 * DurableDelivery asks `due()` after each observed reading and after each successful commit of a connection; when it is
 * true, `open(context)` runs as the very next op of the FIFO, before anything queued behind, with the receipt label of
 * the item that made it due. `open` stores the trip and adopts it; it never changes coverage and never produces an ACK. A
 * failure is handled like a failed commit of that connection.
 */
export interface AttachSink {
  due(): boolean;
  open(context: CommitContext): Promise<SinkResult<{status: AttachStatus}>>;
}

/**
 * Durable storage as the ingestion sees it. `openSession` stores the plugin session from a validated welcome and
 * returns its contiguous committed coverage C. `commit` stores one event or gap marker in one transaction keyed
 * UNIQUE(plugin_session_id, event_seq) and returns the coverage after it. A rejected promise counts as INTERNAL.
 *
 * The optional members are called by DurableDelivery in FIFO order with the commits:
 * - `observe` (R5) receives each durable connection's checkpoint and snapshots with their receipt label (H13),
 *   synchronously at the head of the FIFO; a failure result fails durable delivery like a failed commit. Without it,
 *   snapshots are not queued.
 * - `restoreLoss` (R9) records that the producer released (storedThrough, ackedThrough] beyond storage, before the
 *   ACK_AHEAD_OF_STORAGE connection closes.
 * - `samples` (ET-015b) holds the rows `observe` sampled; DurableDelivery schedules their writes.
 * - `attach` (ET-016 PR-7) opens a late-attach trip at its place in the FIFO (AttachSink).
 */
export interface DurableSink {
  /** Synchronous, bounded intake capture; released when its queued/in-flight item leaves the delivery FIFO. */
  capture?(message: CoverageMessage): HardModeCapture | undefined;
  releaseCapture?(capture: HardModeCapture): void;
  openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>>;
  commit(message: CoverageMessage, context: CommitContext): Promise<SinkResult<CommitResult>>;
  observe?(message: ReadingMessage, context: CommitContext): SinkResult<undefined>;
  restoreLoss?(pluginSessionId: string, storedThroughEventSeq: Uint64, ackedThroughEventSeq: Uint64): Promise<SinkResult<undefined>>;
  readonly samples?: SampleSink;
  readonly attach?: AttachSink;
}

/**
 * E7: what a failed sink command means for the ingestion. `retryable`: no ACK, close the connection and reconnect on the
 * normal backoff, while the producer retains what it has not seen acknowledged (5 minutes). `unavailable`: durable
 * delivery stops for the rest of the service lifetime and the ingestion reconnects live-only.
 *
 * Every storage error code is listed, so a new code fails to compile until it is classified. Storage itself marks
 * TIMEOUT retryable, but a missed deadline fails the StorageClient closed (every later command gets WORKER_FAILED),
 * so here it is `unavailable`. STORAGE_BUSY is retryable: it refuses only one command while the queue is full.
 */
export const STORAGE_FAILURE_CLASS: Readonly<Record<StorageErrorCode, 'retryable' | 'unavailable'>> = {
  DISK_FULL: 'retryable', IO_ERROR: 'retryable', DATABASE_LOCKED: 'retryable', STORAGE_BUSY: 'retryable',
  WORKER_FAILED: 'unavailable', TIMEOUT: 'unavailable', CONSTRAINT_VIOLATION: 'unavailable', SESSION_CONFLICT: 'unavailable',
  INVALID_INPUT: 'unavailable', INTERNAL: 'unavailable', PERMISSION_DENIED: 'unavailable', DATABASE_CORRUPT: 'unavailable',
  UNKNOWN_SESSION: 'unavailable', UNKNOWN_TRIP: 'unavailable', VALUE_OUT_OF_RANGE: 'unavailable', STORAGE_CLOSED: 'unavailable',
  DATA_PATH_INVALID: 'unavailable', DATABASE_UNRECOGNIZED: 'unavailable', SCHEMA_NEWER: 'unavailable', PURPOSE_MISMATCH: 'unavailable',
  DURABILITY_UNVERIFIED: 'unavailable', BACKUP_FAILED: 'unavailable', MIGRATION_FAILED: 'unavailable'
};
/**
 * Classifies a sink failure: a storage code by STORAGE_FAILURE_CLASS, a trip recorder code by RECORDER_FAILURE_CLASS
 * (always unavailable). An unknown code (a sink that is neither) is never retried.
 */
export function failureClass(error: Pick<SinkError, 'code'>): 'retryable' | 'unavailable' {
  if (Object.hasOwn(STORAGE_FAILURE_CLASS, error.code)) return STORAGE_FAILURE_CLASS[error.code as StorageErrorCode];
  return Object.hasOwn(RECORDER_FAILURE_CLASS, error.code) ? RECORDER_FAILURE_CLASS[error.code as RecorderErrorCode] : 'unavailable';
}

export type DurableStorageClient = Pick<StorageClient, 'upsertSession' | 'commitEvent' | 'commitGap'>;

/**
 * Commits messages without trip effects over the telemetry service's StorageClient. Tests use it only with temporary
 * synthetic databases; the trip recorder replaces it wherever trips are recorded.
 */
export class StorageDurableSink implements DurableSink {
  constructor(private readonly client: DurableStorageClient) {}
  async openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>> {
    const result = await this.client.upsertSession({message: welcome});
    return result.ok ? {ok: true, value: {committedThroughEventSeq: result.value.committedThroughEventSeq}} : result;
  }
  commit(message: CoverageMessage): Promise<SinkResult<CommitResult>> {
    return message.kind === 'event' ? this.client.commitEvent({message}) : this.client.commitGap({message});
  }
}
