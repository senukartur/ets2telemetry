// The durable sink of protocol v1 ingestion (ET-006b, E1): where a received event or gap marker is committed before the
// consumer may acknowledge it (docs/protocol/v1.md §10). Node-safe: it talks to storage only through the StorageClient
// interface and never loads native SQLite. Production passes no sink yet, so nothing is recorded or acknowledged until
// ET-015a supplies trip effects; see docs/telemetry-service-v1.md.
import type {ServerMessage, Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CommitResult, Result, StorageError, StorageErrorCode, TripEffect} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';

export type WelcomeMessage = Extract<ServerMessage, {kind: 'welcome'}>;
/** A message that carries eventSeq coverage: one event or one gap marker. */
export type CoverageMessage = Extract<ServerMessage, {kind: 'event' | 'gap'}>;

/**
 * Durable storage as the ingestion sees it. `openSession` stores the plugin session from a validated welcome and
 * returns its contiguous committed coverage C. `commit` stores one event or gap marker in one transaction keyed
 * UNIQUE(plugin_session_id, event_seq) and returns the coverage after it. A rejected promise counts as INTERNAL.
 */
export interface DurableSink {
  openSession(welcome: WelcomeMessage): Promise<Result<{committedThroughEventSeq: Uint64}>>;
  commit(message: CoverageMessage): Promise<Result<CommitResult>>;
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
/** Classifies a sink failure; an unknown code (a sink that is not storage) is never retried. */
export function failureClass(error: Pick<StorageError, 'code'>): 'retryable' | 'unavailable' {
  return Object.hasOwn(STORAGE_FAILURE_CLASS, error.code) ? STORAGE_FAILURE_CLASS[error.code] : 'unavailable';
}

/**
 * Trip effects of one commit (ET-014/ET-015a fill this hook; the default supplies none). `coveredThrough` is the
 * session's committed coverage right before the commit. For a gap, storage applies the effects only when its row is
 * first stored and they must describe only (coveredThrough, lastEventSeq] (docs/storage.md, "Overlapping gap rows").
 */
export type EffectsHook = (message: CoverageMessage, coveredThrough: Uint64) => TripEffect[];
export type DurableStorageClient = Pick<StorageClient, 'upsertSession' | 'commitEvent' | 'commitGap' | 'committedThrough'>;

/** The real sink over the telemetry service's StorageClient. Tests use it only with temporary synthetic databases. */
export class StorageDurableSink implements DurableSink {
  constructor(private readonly client: DurableStorageClient, private readonly effects?: EffectsHook) {}
  async openSession(welcome: WelcomeMessage): Promise<Result<{committedThroughEventSeq: Uint64}>> {
    const result = await this.client.upsertSession({message: welcome});
    return result.ok ? {ok: true, value: {committedThroughEventSeq: result.value.committedThroughEventSeq}} : result;
  }
  async commit(message: CoverageMessage): Promise<Result<CommitResult>> {
    let effects: TripEffect[] | undefined;
    if (this.effects) {
      // The storage caller rule: read the coverage right before committing; the single writer keeps it until the commit.
      const covered = await this.client.committedThrough(message.source.pluginSessionId);
      if (!covered.ok) return covered;
      effects = this.effects(message, covered.value);
    }
    const input = effects?.length ? {message, effects} : {message};
    return message.kind === 'event' ? this.client.commitEvent(input) : this.client.commitGap(input);
  }
}
