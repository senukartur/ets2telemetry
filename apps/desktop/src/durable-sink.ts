// The durable sink of protocol v1 ingestion (ET-006b, E1; ET-015a, R2): where a received event or gap marker is
// committed before the consumer may acknowledge it (docs/protocol/v1.md §10). Node-safe: it talks to storage only
// through the StorageClient interface and never loads native SQLite. `StorageDurableSink` commits messages without trip
// effects; the trip recorder (trip-recorder.ts) commits them with their ET-014 effects. Production passes no sink yet,
// so nothing is recorded or acknowledged; see docs/telemetry-service-v1.md.
import type {ServerMessage, Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CommitResult, StorageError, StorageErrorCode} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';

export type WelcomeMessage = Extract<ServerMessage, {kind: 'welcome'}>;
/** A message that carries eventSeq coverage: one event or one gap marker. */
export type CoverageMessage = Extract<ServerMessage, {kind: 'event' | 'gap'}>;
/** A message that carries a reading of current state: the connection's checkpoint or a snapshot. */
export type ReadingMessage = Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;

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
/** R8: the consumer's UTC label, captured when the frame was decoded, never when the commit runs. */
export interface CommitContext {receivedUtcMs: number}

/**
 * Durable storage as the ingestion sees it. `openSession` stores the plugin session from a validated welcome and
 * returns its contiguous committed coverage C. `commit` stores one event or gap marker in one transaction keyed
 * UNIQUE(plugin_session_id, event_seq) and returns the coverage after it. A rejected promise counts as INTERNAL.
 *
 * The optional members are called by DurableDelivery in FIFO order with the commits:
 * - `observe` (R5) receives each durable connection's checkpoint and snapshots, synchronously at the head of the FIFO;
 *   a failure result fails durable delivery like a failed commit. Without it, snapshots are not queued.
 * - `restoreLoss` (R9) records that the producer released (storedThrough, ackedThrough] beyond storage, before the
 *   ACK_AHEAD_OF_STORAGE connection closes.
 */
export interface DurableSink {
  openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>>;
  commit(message: CoverageMessage, context: CommitContext): Promise<SinkResult<CommitResult>>;
  observe?(message: ReadingMessage): SinkResult<undefined>;
  restoreLoss?(pluginSessionId: string, storedThroughEventSeq: Uint64, ackedThroughEventSeq: Uint64): Promise<SinkResult<undefined>>;
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
