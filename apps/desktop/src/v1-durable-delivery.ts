// The storage-commit ACK pipeline of protocol v1 ingestion (ET-006b, E5-E8; ET-015a, R5, R8, R9). Received events and
// gap markers, and each durable connection's checkpoint and snapshots (readings), enter one FIFO shared by every
// connection in stream order; one sink command runs at a time; an ACK is built from DurableAckCursor only after the sink
// reported the commit, and is written only to the connection that received the coverage while it is still current.
// Receipt, parsing or validation is never grounds for an ACK (docs/protocol/v1.md §10).
// Node-safe: no storage, Electron or I/O beyond the link the ingestion supplies. See docs/telemetry-service-v1.md.
import {encodeFrame, type Uint64} from '../../../packages/contracts/src/protocol-v1';
import {DurableAckCursor} from '../../../packages/contracts/src/protocol-v1-delivery';
import {isUint64} from '../../../packages/contracts/src/protocol-v0';
import type {CommitResult} from '../../../packages/storage/src/api';
import type {DiagnosticFacts} from './diagnostics';
import {failureClass, type CoverageMessage, type DurableSink, type ReadingMessage, type SinkError, type SinkResult, type WelcomeMessage} from './durable-sink';

/** E5: coverage items queued or in flight across every connection. One more closes its connection as retryable. */
export const MAX_PENDING_COMMITS = 256;
/**
 * R5: snapshot readings queued or in flight across every connection, counted apart from the coverage items: more than
 * 25 s at 20 Hz, above the 10 s storage deadline that fails the worker. One more closes its connection as retryable.
 */
export const MAX_PENDING_READINGS = 512;
type CheckpointMessage = Extract<ReadingMessage, {kind: 'checkpoint'}>;
type SnapshotMessage = Extract<ReadingMessage, {kind: 'snapshot'}>;
/** Fixed codes of failures that do not come from the sink. */
export type DeliveryFailureCode = 'COVERAGE_MISMATCH' | 'ACK_AHEAD_OF_STORAGE' | 'BACKLOG_FULL';
/**
 * `off`: no sink, or this connection is live-only. `pending`: a durable connection waits for its session to open, or
 * reconnects after a retryable failure. `active`: the current session's cursor is open. `failed`: durable delivery is
 * unavailable for the service lifetime, or (ACK_AHEAD_OF_STORAGE) for one plugin session.
 */
export type DurableStatus = {state: 'off'} | {state: 'pending'; retryCode?: string} | {state: 'active'} | {state: 'failed'; code: string};
/**
 * How the pipeline ends a connection. `retryable`: reconnect durable on the normal backoff (the producer redelivers).
 * `unavailable`: reconnect live-only for the service lifetime. `ack-ahead`: reconnect live-only while the plugin session
 * whose producer acknowledged beyond storage is current.
 */
export type DurableCloseKind = 'retryable' | 'unavailable' | 'ack-ahead';

/** The connection that received coverage, as the pipeline sees it. */
export interface DurableLink {
  /** True only while this connection is the current one, open and before `end` (E8). */
  current(): boolean;
  /** Writes one encoded client frame on this connection. Called only while `current()` is true. */
  write(bytes: Uint8Array): void;
  /** Ends this connection when it is still current; a no-op otherwise. */
  close(kind: DurableCloseKind, code: string): void;
  /** Optional: called after each successful commit result of this connection while it is current, before its ACK. */
  committed?(): void;
}
export interface DurableDeliveryOptions {
  maxPendingCommits?: number;
  maxPendingReadings?: number;
  /** Fixed codes and numbers only; never message contents. */
  log?: (event: string, facts?: DiagnosticFacts) => void;
  /** Called after every status change. */
  onStatus?: (status: DurableStatus) => void;
}

type Op = {connection: DurableConnection} & (
  {kind: 'open'; welcome: WelcomeMessage} |
  {kind: 'checkpoint'; message: CheckpointMessage} |
  {kind: 'snapshot'; message: SnapshotMessage} |
  {kind: 'item'; first: Uint64; last: Uint64; message: CoverageMessage; receivedUtcMs: number});
const COMMIT_STATUSES = new Set<CommitResult['status']>(['committed', 'duplicate', 'conflict', 'covered']);
const internal = (): SinkError => ({code: 'INTERNAL', retryable: false, message: 'An unexpected storage failure occurred.'});

/** One durable connection's handle: its plugin session, its cursor once storage opened it, and its ordered work. */
export class DurableConnection {
  /** Set once the connection's remaining work must not run: it failed, overflowed or the pipeline stopped. */
  dropped = false;
  cursor?: DurableAckCursor;
  constructor(private readonly delivery: DurableDelivery, readonly pluginSessionId: string, readonly link: DurableLink) {}
  /**
   * Queues the connection's checkpoint. Its `ackedThroughEventSeq` A starts the cursor for this connection (E6); then
   * the sink observes it as hydration and as the connection's first reading (R5).
   */
  checkpoint(message: CheckpointMessage): void { this.delivery.push({connection: this, kind: 'checkpoint', message}); }
  /**
   * Queues one snapshot for the sink's `observe`, in stream order with the items (R5); nothing is queued for a sink
   * without it. Returns false when the readings bound was reached: the connection was closed as retryable.
   */
  snapshot(message: SnapshotMessage): boolean { return this.delivery.pushReading({connection: this, kind: 'snapshot', message}); }
  /**
   * Queues one received event or gap with the consumer's UTC label at its receipt (R8). Returns false when the backlog
   * bound was reached: the connection was closed as retryable and the item was not queued (the producer redelivers it).
   */
  enqueue(coverage: {firstEventSeq: Uint64; lastEventSeq: Uint64}, message: CoverageMessage, receivedUtcMs: number): boolean {
    return this.delivery.pushItem({connection: this, kind: 'item', first: coverage.firstEventSeq, last: coverage.lastEventSeq, message, receivedUtcMs});
  }
}

/**
 * E5-E8. Per welcome, after earlier queued commits drain, `openSession` returns storage coverage C and a new
 * DurableAckCursor(pluginSessionId, C) starts; the checkpoint's A begins the connection, and A > C disables durable
 * delivery for that plugin session (ACK_AHEAD_OF_STORAGE) once the sink's `restoreLoss` recorded the loss (R9). After
 * every commit the storage coverage must equal the cursor's (COVERAGE_MISMATCH otherwise). Readings run through the
 * sink's `observe` at their place in the FIFO (R5). Sink failures follow the E7 table in durable-sink.ts.
 */
export class DurableDelivery {
  private readonly queue: Op[] = [];
  private running?: Promise<void>;
  private pendingItems = 0;
  private pendingReadings = 0;
  private failedCode?: string;
  private blockedSession?: string;
  private latest?: DurableConnection;
  private current: DurableStatus = {state: 'pending'};
  private conflicts = 0;
  private retries = new Map<string, number>();
  private stopped = false;
  private readonly maxPending: number;
  private readonly maxReadings: number;
  constructor(private readonly sink: DurableSink, private readonly options: DurableDeliveryOptions = {}) {
    this.maxPending = options.maxPendingCommits ?? MAX_PENDING_COMMITS;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new Error('Invalid pending commit bound');
    this.maxReadings = options.maxPendingReadings ?? MAX_PENDING_READINGS;
    if (!Number.isSafeInteger(this.maxReadings) || this.maxReadings < 1) throw new Error('Invalid pending reading bound');
  }
  get status(): DurableStatus { return this.current; }
  /** Coverage items queued or in flight. */
  get pending(): number { return this.pendingItems; }
  /** Snapshot readings queued or in flight. */
  get pendingReadingCount(): number { return this.pendingReadings; }
  /** Whether the next hello may request durable delivery; `pluginSessionId` is the session when it is already known. */
  durableAllowed(pluginSessionId?: string): boolean {
    if (this.failedCode !== undefined || this.stopped) return false;
    return this.blockedSession === undefined || (pluginSessionId !== undefined && pluginSessionId !== this.blockedSession);
  }
  /**
   * A live-only welcome after ACK_AHEAD_OF_STORAGE. Returns true when it names another plugin session, which lifts the
   * block: the caller then reconnects durable.
   */
  observeLiveOnly(pluginSessionId: string): boolean {
    if (this.failedCode !== undefined || this.blockedSession === undefined || pluginSessionId === this.blockedSession) return false;
    this.blockedSession = undefined; this.setStatus({state: 'pending'}); return true;
  }
  /** Starts a durable connection at its welcome. Its session opens in FIFO order after earlier queued work. */
  connect(welcome: WelcomeMessage, link: DurableLink): DurableConnection {
    const connection = this.latest = new DurableConnection(this, welcome.source.pluginSessionId, link);
    if (this.failedCode !== undefined || this.stopped) { connection.dropped = true; link.close('unavailable', this.failedCode ?? 'INTERNAL'); return connection; }
    this.setStatus({state: 'pending'});
    this.push({connection, kind: 'open', welcome});
    return connection;
  }
  /** Resolves when no work is queued or in flight. */
  async idle(): Promise<void> { while (this.running) await this.running; }
  /** Drops queued work and waits for the one command in flight; nothing is written afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const op of this.queue.splice(0)) { op.connection.dropped = true; this.release(op); }
    await this.idle();
  }

  /** @internal */
  push(op: Op): void {
    if (op.connection.dropped || this.stopped) return;
    this.queue.push(op);
    // Started on a later microtask, so a push from inside a running command never starts a second pump.
    this.running ??= Promise.resolve().then(() => this.pump());
  }
  /** @internal */
  pushItem(op: Op & {kind: 'item'}): boolean {
    if (op.connection.dropped || this.stopped) return true;
    if (this.pendingItems >= this.maxPending) { this.overflow(op.connection); return false; }
    this.pendingItems++;
    this.push(op);
    return true;
  }
  /** @internal */
  pushReading(op: Op & {kind: 'snapshot'}): boolean {
    if (op.connection.dropped || this.stopped || !this.sink.observe) return true;
    if (this.pendingReadings >= this.maxReadings) { this.overflow(op.connection); return false; }
    this.pendingReadings++;
    this.push(op);
    return true;
  }
  /** E5, R5: a bound is full. The producer retains and redelivers, so this connection's queued work is dropped too. */
  private overflow(connection: DurableConnection): void {
    this.drop(connection);
    this.retry('BACKLOG_FULL');
    connection.link.close('retryable', 'BACKLOG_FULL');
  }
  /** Releases the bound an op counted against once it leaves the queue. */
  private release(op: Op): void {
    if (op.kind === 'item') this.pendingItems--;
    else if (op.kind === 'snapshot') this.pendingReadings--;
  }
  private drop(connection: DurableConnection): void {
    connection.dropped = true;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].connection !== connection) continue;
      this.release(this.queue[i]);
      this.queue.splice(i, 1);
    }
  }
  private async pump(): Promise<void> {
    for (let op = this.queue.shift(); op; op = this.queue.shift()) {
      try { if (!op.connection.dropped) await this.run(op); }
      // A defect in a link or sink callback must not stall the queue; it fails durable delivery closed.
      catch { try { this.unavailable(op.connection, 'INTERNAL'); } catch { /* the link failed again; delivery is already failed */ } }
      finally { this.release(op); }
    }
    this.running = undefined;
  }
  private async call<T>(command: () => Promise<SinkResult<T>>): Promise<SinkResult<T>> {
    try {
      const result = await command();
      return result && typeof result === 'object' && typeof result.ok === 'boolean' ? result : {ok: false, error: internal()};
    } catch { return {ok: false, error: internal()}; }
  }
  private async run(op: Op): Promise<void> {
    const connection = op.connection;
    if (op.kind === 'open') {
      const result = await this.call(() => this.sink.openSession(op.welcome));
      // A session that opens after stop() or after its connection was dropped changes nothing.
      if (connection.dropped || this.stopped) return;
      if (!result.ok) { this.failure(connection, result.error); return; }
      const through = result.value?.committedThroughEventSeq;
      if (!isUint64(through)) { this.failure(connection, internal()); return; }
      connection.cursor = new DurableAckCursor(connection.pluginSessionId, through);
      if (connection === this.latest && !connection.dropped) this.setStatus({state: 'active'});
      return;
    }
    const cursor = connection.cursor;
    if (!cursor) { this.failure(connection, internal()); return; }
    if (op.kind === 'checkpoint') {
      const acked = op.message.data.status.delivery.ackedThroughEventSeq, stored = cursor.throughEventSeq;
      try { cursor.beginConnection(acked); } catch {
        // E6: the producer released events that storage does not hold (for example a restored database). This plugin
        // session continues live-only; R9: the sink first records the released range as a restore-loss interval.
        this.drop(connection);
        this.blockedSession = connection.pluginSessionId;
        this.options.log?.('V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'});
        this.setStatus({state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'});
        const restoreLoss = this.sink.restoreLoss?.bind(this.sink);
        if (restoreLoss && isUint64(acked) && BigInt(acked) > BigInt(stored)) {
          const recorded = await this.call(() => restoreLoss(connection.pluginSessionId, stored, acked));
          // A failure to record it is logged and does not unblock the session.
          this.options.log?.('V1_DURABLE_RESTORE_LOSS', {code: recorded.ok ? 'RECORDED' : recorded.error.code});
        }
        connection.link.close('ack-ahead', 'ACK_AHEAD_OF_STORAGE');
        return;
      }
      this.observe(connection, op.message);
      return;
    }
    if (op.kind === 'snapshot') { this.observe(connection, op.message); return; }
    try { cursor.received(op.first, op.last); } catch { this.failure(connection, internal()); return; }
    const result = await this.call(() => this.sink.commit(op.message, {receivedUtcMs: op.receivedUtcMs}));
    if (connection.dropped || this.stopped) return;
    if (!result.ok) { this.failure(connection, result.error); return; }
    const value = result.value;
    if (!value || !COMMIT_STATUSES.has(value.status) || !isUint64(value.committedThroughEventSeq)) { this.failure(connection, internal()); return; }
    if (value.status === 'conflict') {
      // §9: the stored row is kept and its key counts as committed. Logged at counts 1, 2, 4, 8, ...
      this.conflicts++;
      if ((this.conflicts & (this.conflicts - 1)) === 0) this.options.log?.('V1_EVENT_CONFLICT', {count: this.conflicts});
    }
    try { cursor.commit(op.first, op.last); } catch { this.failure(connection, internal()); return; }
    if (value.committedThroughEventSeq !== cursor.throughEventSeq) { this.unavailable(connection, 'COVERAGE_MISMATCH'); return; }
    // E8: only the connection that received the coverage, while current, open and before `end`.
    if (!connection.link.current()) return;
    connection.link.committed?.();
    const ack = cursor.ack();
    if (ack) connection.link.write(encodeFrame(ack));
  }
  /** R5: one reading at its place in the FIFO. A failure result stops durable delivery like a failed commit. */
  private observe(connection: DurableConnection, message: ReadingMessage): void {
    if (!this.sink.observe) return;
    const result = this.sink.observe(message);
    if (!result.ok) this.failure(connection, result.error);
  }
  private failure(connection: DurableConnection, error: Pick<SinkError, 'code'>): void {
    if (failureClass(error) === 'retryable') {
      this.drop(connection);
      this.retry(error.code);
      connection.link.close('retryable', error.code);
    } else this.unavailable(connection, error.code);
  }
  private retry(code: string): void {
    // Repeated identical retryable failures are logged at occurrences 1, 2, 4, 8, ...
    const count = (this.retries.get(code) ?? 0) + 1; this.retries.set(code, count);
    if ((count & (count - 1)) === 0) this.options.log?.('V1_DURABLE_RETRY', {code, count});
    if (this.failedCode === undefined) this.setStatus({state: 'pending', retryCode: code});
  }
  private unavailable(connection: DurableConnection, code: string): void {
    if (this.failedCode === undefined) {
      this.failedCode = code;
      this.options.log?.('V1_DURABLE_UNAVAILABLE', {code});
      this.setStatus({state: 'failed', code});
    }
    for (const op of this.queue.splice(0)) { op.connection.dropped = true; this.release(op); }
    connection.dropped = true;
    connection.link.close('unavailable', code);
    if (this.latest && this.latest !== connection) { this.latest.dropped = true; this.latest.link.close('unavailable', code); }
  }
  private setStatus(status: DurableStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status; this.options.onStatus?.(status);
  }
}
