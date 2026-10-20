// The storage-commit ACK pipeline of protocol v1 ingestion (ET-006b, E5-E8; ET-015a, R5, R8, R9; ET-015b, H8-H13).
// Received events and gap markers, and each durable connection's checkpoint and snapshots (readings), enter one FIFO
// shared by every connection in stream order; one sink command runs at a time; an ACK is built from DurableAckCursor only
// after the sink reported the commit, and is written only to the connection that received the coverage while it is still
// current. Receipt, parsing or validation is never grounds for an ACK (docs/protocol/v1.md §10). The sink's pending
// one-second samples are written by a low-priority `samples` op in the same FIFO, which never produces an ACK.
// Node-safe: no storage, Electron or I/O beyond the link the ingestion supplies. See docs/telemetry-service-v1.md.
import {encodeFrame, type Uint64} from '../../../packages/contracts/src/protocol-v1';
import {DurableAckCursor} from '../../../packages/contracts/src/protocol-v1-delivery';
import {isUint64} from '../../../packages/contracts/src/protocol-v0';
import type {CommitResult} from '../../../packages/storage/src/api';
import type {DiagnosticFacts} from './diagnostics';
import {failureClass, type CoverageMessage, type HardModeCapture, type DurableSink, type ReadingMessage, type SampleSink, type SinkError, type SinkResult, type WelcomeMessage} from './durable-sink';
import {MAX_PENDING_SAMPLES} from './sample-buffer';

/**
 * E5, ET-015c (G11): coverage items queued or in flight across every connection. One more closes its connection as
 * retryable (BACKLOG_FULL). The bound is twice the producer's 256 retained entries (docs/native-transport-v1.md, I2).
 * The leftover items of a connection that has ended were never acknowledged, so they cover entries the producer still
 * retains; the reconnection redelivers those entries, at most 256, and its live items are admitted into the same 256
 * entries until an ACK releases some, which follows commits that have already left the queue. The leftovers of one
 * ended connection plus a full redelivery plus live events therefore fit. A live delta gap item extends the trailing gap
 * record (I3, I6) and takes no new entry, so it fits only while the leftovers and the redelivery stay below 512: after
 * 256 leftover items and a redelivery of all 256 entries, the first delta gap is item 513. The queue can therefore still
 * fill, and a reconnection still be refused for a while (retryable, bounded and draining, never a livelock), when a gap
 * record keeps growing while nothing commits, as in a true storage stall, or when the leftovers of several connections
 * that ended before the queue drained are stacked.
 */
export const MAX_PENDING_COMMITS = 512;
/**
 * R5: snapshot readings queued or in flight across every connection, counted apart from the coverage items: more than
 * 25 s at 20 Hz, above the 10 s storage deadline that fails the worker. One more closes its connection as retryable.
 */
export const MAX_PENDING_READINGS = 512;
/** H8: a `samples` op is queued once pending samples have waited this long; the timer starts when the first row is pending. */
export const SAMPLE_FLUSH_MS = 5000;
/** H8: a `samples` op is queued at once when this many rows are pending, and one op writes at most this many rows. */
export const SAMPLE_BATCH_ROWS = 60;
type CheckpointMessage = Extract<ReadingMessage, {kind: 'checkpoint'}>;
type SnapshotMessage = Extract<ReadingMessage, {kind: 'snapshot'}>;
/** Fixed codes of failures that do not come from the sink. */
export type DeliveryFailureCode = 'COVERAGE_MISMATCH' | 'ACK_AHEAD_OF_STORAGE' | 'BACKLOG_FULL';
/**
 * `off`: no sink, or the current connection did not request durable delivery (its selection is not durable, storage is
 * not ready, or no hello was sent yet); V1Ingestion reports it, the pipeline itself never does. `pending`: a durable
 * connection waits for its session to open, or reconnects after a retryable failure. `active`: the current session's
 * cursor is open. `failed`: durable delivery is unavailable for the service lifetime, or (ACK_AHEAD_OF_STORAGE) for one
 * plugin session; it is reported on the live-only connections that follow as well.
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
  /** Tests only (H8): the sample flush delay and batch size; SAMPLE_FLUSH_MS and SAMPLE_BATCH_ROWS by default. */
  sampleFlushMs?: number;
  sampleBatchRows?: number;
  /** Fixed codes and numbers only; never message contents. */
  log?: (event: string, facts?: DiagnosticFacts) => void;
  /** Called after every status change. */
  onStatus?: (status: DurableStatus) => void;
  /** ET-015c (G9): called after every change of `retryCode`. */
  onRetryCode?: (code: string | undefined) => void;
}

type ConnectionOp = {connection: DurableConnection} & (
  {kind: 'open'; welcome: WelcomeMessage} |
  {kind: 'checkpoint'; message: CheckpointMessage; receivedUtcMs: number} |
  {kind: 'snapshot'; message: SnapshotMessage; receivedUtcMs: number} |
  {kind: 'item'; first: Uint64; last: Uint64; message: CoverageMessage; receivedUtcMs: number; capture?: HardModeCapture} |
  {kind: 'attach'; receivedUtcMs: number});
/** ET-015b: one batch of the sink's pending samples. It belongs to no connection and is never dropped with one. */
type Op = ConnectionOp | {kind: 'samples'};
const COMMIT_STATUSES = new Set<CommitResult['status']>(['committed', 'duplicate', 'conflict', 'covered']);
const internal = (): SinkError => ({code: 'INTERNAL', retryable: false, message: 'An unexpected storage failure occurred.'});
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** A sample write result: non-negative safe integer counts of appended and skipped rows. */
function validCounts(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const counts = value as Partial<Record<'appended' | 'skipped', unknown>>;
  return isCount(counts.appended) && isCount(counts.skipped);
}
/** Rows and loss intervals a sample sink holds. */
function total(samples: SampleSink): number { const pending = samples.pending(); return pending.rows + pending.losses; }
/** Whether a running total that grew from `before` to `after` reached or passed a power of two (1, 2, 4, 8, ...). */
function reachesPowerOfTwo(before: number, after: number): boolean {
  let next = 1;
  while (next <= before) next *= 2;
  return after >= next;
}

/** One durable connection's handle: its plugin session, its cursor once storage opened it, and its ordered work. */
export class DurableConnection {
  /** Set once the connection's remaining work must not run: it failed, overflowed or the pipeline stopped. */
  dropped = false;
  cursor?: DurableAckCursor;
  constructor(private readonly delivery: DurableDelivery, readonly pluginSessionId: string, readonly link: DurableLink) {}
  /**
   * Queues the connection's checkpoint with the consumer's UTC label at its receipt (H13). Its `ackedThroughEventSeq` A
   * starts the cursor for this connection (E6); then the sink observes it as hydration and as the connection's first
   * reading (R5).
   */
  checkpoint(message: CheckpointMessage, receivedUtcMs: number): void { this.delivery.push({connection: this, kind: 'checkpoint', message, receivedUtcMs}); }
  /**
   * Queues one snapshot with its receipt label (H13) for the sink's `observe`, in stream order with the items (R5);
   * nothing is queued for a sink without it. Returns false when the readings bound was reached: the connection was
   * closed as retryable.
   */
  snapshot(message: SnapshotMessage, receivedUtcMs: number): boolean { return this.delivery.pushReading({connection: this, kind: 'snapshot', message, receivedUtcMs}); }
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
 *
 * ET-015b (H8-H12): when the sink has `samples`, a `samples` op joins the FIFO tail once its oldest pending row has
 * waited SAMPLE_FLUSH_MS (a timer armed when rows or loss intervals become pending) or SAMPLE_BATCH_ROWS rows are pending. At most one such op
 * is queued or running, it writes at most SAMPLE_BATCH_ROWS rows of one plugin session, it never counts against the
 * item or reading bounds and it never produces or advances an ACK. A retryable sample failure keeps the rows for the
 * next timer and leaves every connection open; any other failure stops durable delivery for the service lifetime and
 * discards the pending rows. `stop()` writes the rows still pending unless delivery failed.
 *
 * ET-016 PR-7 (J9): when the sink has `attach` and reports a late-attach trip due after a reading or a commit, an
 * `attach` op of that connection goes to the FIFO head, so it runs before anything queued behind. It never produces or
 * advances an ACK, counts against no bound, is dropped with its connection, and fails like a commit of that connection.
 */
export class DurableDelivery {
  private readonly queue: Op[] = [];
  private running?: Promise<void>;
  private stopping?: Promise<void>;
  private pendingItems = 0;
  private pendingReadings = 0;
  private failedCode?: string;
  private blockedSession?: string;
  private latest?: DurableConnection;
  private current: DurableStatus = {state: 'pending'};
  private conflicts = 0;
  private retries = new Map<string, number>();
  private retrying?: string;
  private stopped = false;
  private readonly maxPending: number;
  private readonly maxReadings: number;
  private readonly sampleFlushMs: number;
  private readonly sampleBatchRows: number;
  /** The flush timer of pending samples, armed while rows or loss intervals are pending and no `samples` op is queued or running. */
  private sampleTimer?: ReturnType<typeof setTimeout>;
  /** Whether a `samples` op is queued or running (H8: at most one). */
  private sampleOp = false;
  /** After a retryable sample failure the rows wait for the timer, even when a full batch is pending (H12). */
  private sampleBackoff = false;
  private readonly sampleRetries = new Map<string, number>();
  /** Running totals of rows storage skipped as already stored and of rows the pending bound dropped, for their logs. */
  private sampleSkipped = 0;
  private sampleDropped = 0;
  constructor(private readonly sink: DurableSink, private readonly options: DurableDeliveryOptions = {}) {
    this.maxPending = options.maxPendingCommits ?? MAX_PENDING_COMMITS;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new Error('Invalid pending commit bound');
    this.maxReadings = options.maxPendingReadings ?? MAX_PENDING_READINGS;
    if (!Number.isSafeInteger(this.maxReadings) || this.maxReadings < 1) throw new Error('Invalid pending reading bound');
    this.sampleFlushMs = options.sampleFlushMs ?? SAMPLE_FLUSH_MS;
    if (!Number.isSafeInteger(this.sampleFlushMs) || this.sampleFlushMs < 1) throw new Error('Invalid sample flush delay');
    this.sampleBatchRows = options.sampleBatchRows ?? SAMPLE_BATCH_ROWS;
    if (!Number.isSafeInteger(this.sampleBatchRows) || this.sampleBatchRows < 1 || this.sampleBatchRows > MAX_PENDING_SAMPLES) throw new Error('Invalid sample batch size');
  }
  get status(): DurableStatus { return this.current; }
  /**
   * ET-015c (G9): the code of the latest retryable failure of a commit, a sample write or a backlog bound
   * (BACKLOG_FULL). Unlike the `pending` status's `retryCode`, a reconnection or a session open does not clear it; only
   * the next successful commit or sample write does, so the recording status keeps `retrying` until storage writes again.
   */
  get retryCode(): string | undefined { return this.retrying; }
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
  /**
   * Drops queued work, including a queued `samples` op, and waits for the one command in flight; no commit, observation
   * or ACK follows. Then, unless durable delivery failed, it writes every pending sample row (H11): one write per plugin
   * session of at most MAX_PENDING_SAMPLES rows, its loss intervals first, and logs V1_SAMPLES_EXIT {rows, losses, code} once
   * when anything was pending. A second call returns the first call's promise.
   */
  stop(): Promise<void> { return this.stopping ??= this.stopAll(); }
  private async stopAll(): Promise<void> {
    this.stopped = true;
    this.clearSampleTimer();
    for (const op of this.queue.splice(0)) { if (op.kind !== 'samples') op.connection.dropped = true; this.release(op); }
    await this.idle();
    await this.writeRemainingSamples();
  }

  /** @internal */
  push(op: Op): void {
    if (this.stopped || (op.kind === 'samples' ? this.failedCode !== undefined : op.connection.dropped)) return;
    this.queue.push(op);
    // Started on a later microtask, so a push from inside a running command never starts a second pump.
    this.running ??= Promise.resolve().then(() => this.pump());
  }
  /** @internal */
  pushItem(op: ConnectionOp & {kind: 'item'}): boolean {
    if (op.connection.dropped || this.stopped) return true;
    if (this.pendingItems >= this.maxPending) { this.overflow(op.connection); return false; }
    try {op.capture = this.sink.capture?.(op.message);} catch {this.unavailable(op.connection, 'INTERNAL'); return false;}
    this.pendingItems++;
    this.push(op);
    return true;
  }
  /** @internal */
  pushReading(op: ConnectionOp & {kind: 'snapshot'}): boolean {
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
    if (op.kind === 'item') {this.pendingItems--; if (op.capture) this.sink.releaseCapture?.(op.capture);}
    else if (op.kind === 'snapshot') this.pendingReadings--;
    else if (op.kind === 'samples') this.sampleOp = false;
  }
  /** Drops a connection's queued work; a queued `samples` op belongs to no connection and stays. */
  private drop(connection: DurableConnection): void {
    connection.dropped = true;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const op = this.queue[i];
      if (op.kind === 'samples' || op.connection !== connection) continue;
      this.release(op);
      this.queue.splice(i, 1);
    }
  }
  private async pump(): Promise<void> {
    for (let op = this.queue.shift(); op; op = this.queue.shift()) {
      try {
        if (op.kind === 'samples') await this.writeSamples();
        else if (!op.connection.dropped) await this.run(op);
      }
      // A defect in a link or sink callback must not stall the queue; it fails durable delivery closed.
      catch { try { this.unavailable(op.kind === 'samples' ? undefined : op.connection, 'INTERNAL'); } catch { /* the link failed again; delivery is already failed */ } }
      finally {
        this.release(op);
        // Rows left after a batch: the next batch at once when a full one is pending, otherwise the timer.
        if (op.kind === 'samples') this.scheduleSamples();
      }
    }
    this.running = undefined;
  }
  private async call<T>(command: () => Promise<SinkResult<T>>): Promise<SinkResult<T>> {
    try {
      const result = await command();
      return result && typeof result === 'object' && typeof result.ok === 'boolean' ? result : {ok: false, error: internal()};
    } catch { return {ok: false, error: internal()}; }
  }
  private async run(op: ConnectionOp): Promise<void> {
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
      this.observe(connection, op.message, op.receivedUtcMs);
      return;
    }
    if (op.kind === 'snapshot') { this.observe(connection, op.message, op.receivedUtcMs); return; }
    if (op.kind === 'attach') { await this.attach(connection, op.receivedUtcMs); return; }
    try { cursor.received(op.first, op.last); } catch { this.failure(connection, internal()); return; }
    const result = await this.call(() => this.sink.commit(op.message, {receivedUtcMs: op.receivedUtcMs, ...(op.capture ? {hardModeCapture: op.capture} : {})}));
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
    // G9: storage committed again.
    this.setRetryCode(undefined);
    // J9: a commit that drained the replayed events may make a late-attach trip due; it opens before the next item.
    this.queueAttach(connection, op.receivedUtcMs);
    // E8: only the connection that received the coverage, while current, open and before `end`.
    if (!connection.link.current()) return;
    connection.link.committed?.();
    const ack = cursor.ack();
    if (ack) connection.link.write(encodeFrame(ack));
  }
  /**
   * R5: one reading at its place in the FIFO, with its receipt label (H13). A failure result stops durable delivery like
   * a failed commit. The sink may have sampled it (ET-015b), so the sample schedule is checked afterwards.
   */
  private observe(connection: DurableConnection, message: ReadingMessage, receivedUtcMs: number): void {
    if (!this.sink.observe) return;
    const result = this.sink.observe(message, {receivedUtcMs});
    if (!result.ok) { this.failure(connection, result.error); return; }
    this.queueAttach(connection, receivedUtcMs);
    const samples = this.sink.samples;
    if (!samples) return;
    const dropped = samples.dropped();
    if (reachesPowerOfTwo(this.sampleDropped, dropped)) this.options.log?.('V1_SAMPLES_DROPPED', {count: dropped});
    this.sampleDropped = dropped;
    this.scheduleSamples();
  }

  /**
   * ET-016 PR-7 (J9): when the sink reports a late-attach trip due, its op goes to the FIFO head, so it runs right after
   * the op that made it due and before any item or reading queued behind; at most one is queued. It counts against no
   * bound and belongs to its connection, so it is dropped with the connection's other work.
   */
  private queueAttach(connection: DurableConnection, receivedUtcMs: number): void {
    if (!this.sink.attach || connection.dropped || this.stopped || this.queue.some(op => op.kind === 'attach')) return;
    if (!this.sink.attach.due()) return;
    this.queue.unshift({connection, kind: 'attach', receivedUtcMs});
  }
  /** One late-attach op: no coverage and no ACK; a failure fails the connection like a failed commit. */
  private async attach(connection: DurableConnection, receivedUtcMs: number): Promise<void> {
    const attach = this.sink.attach;
    if (!attach) return;
    const result = await this.call(() => attach.open({receivedUtcMs}));
    if (connection.dropped || this.stopped) return;
    if (!result.ok) { this.failure(connection, result.error); return; }
    if (!['committed', 'duplicate', 'none'].includes(result.value?.status)) { this.failure(connection, internal()); return; }
    if (result.value.status !== 'none') this.setRetryCode(undefined);
  }

  /**
   * H8: queues the `samples` op at once when a full batch is pending (unless a retryable failure is backing off), or arms
   * the flush timer while rows or loss intervals are pending. Nothing happens while a `samples` op is queued or running, after `stop()` or
   * after durable delivery failed.
   */
  private scheduleSamples(): void {
    const samples = this.sink.samples;
    if (!samples || this.sampleOp || this.stopped || this.failedCode !== undefined) return;
    const pending = samples.pending();
    if (pending.rows + pending.losses === 0) { this.clearSampleTimer(); return; }
    if (pending.rows >= this.sampleBatchRows && !this.sampleBackoff) { this.queueSamples(); return; }
    this.sampleTimer ??= setTimeout(() => { this.sampleTimer = undefined; this.sampleBackoff = false; this.queueSamples(); }, this.sampleFlushMs);
  }
  private queueSamples(): void {
    if (!this.sink.samples || this.sampleOp || this.stopped || this.failedCode !== undefined || total(this.sink.samples) === 0) return;
    this.clearSampleTimer();
    this.sampleOp = true;
    this.push({kind: 'samples'});
  }
  private clearSampleTimer(): void { clearTimeout(this.sampleTimer); this.sampleTimer = undefined; }
  /** One `samples` op: at most `sampleBatchRows` rows of one plugin session. */
  private async writeSamples(): Promise<void> {
    const samples = this.sink.samples;
    if (!samples || this.failedCode !== undefined) return;
    const result = await this.call(() => samples.write(this.sampleBatchRows));
    if (this.failedCode !== undefined) return;
    if (!result.ok) { this.sampleFailure(result.error); return; }
    if (!validCounts(result.value)) { this.unavailable(undefined, 'INTERNAL'); return; }
    this.sampleBackoff = false;
    this.setRetryCode(undefined);
    this.countSkipped(result.value.skipped);
  }
  /**
   * H12: a retryable failure keeps the rows for the next timer, leaves every connection open and the durable status
   * unchanged, and logs V1_SAMPLES_RETRY {code, count} at counts 1, 2, 4, ... per code. Any other code stops durable
   * delivery for the service lifetime like a failed commit.
   */
  private sampleFailure(error: Pick<SinkError, 'code'>): void {
    if (failureClass(error) !== 'retryable') { this.unavailable(undefined, error.code); return; }
    const count = (this.sampleRetries.get(error.code) ?? 0) + 1; this.sampleRetries.set(error.code, count);
    if ((count & (count - 1)) === 0) this.options.log?.('V1_SAMPLES_RETRY', {code: error.code, count});
    this.sampleBackoff = true;
    this.setRetryCode(error.code);
  }
  /** Rows storage skipped as already stored (H6); the running total is logged as V1_SAMPLES_SKIPPED when it reaches 1, 2, 4, ... */
  private countSkipped(skipped: number): void {
    const total = this.sampleSkipped + skipped;
    if (reachesPowerOfTwo(this.sampleSkipped, total)) this.options.log?.('V1_SAMPLES_SKIPPED', {count: total});
    this.sampleSkipped = total;
  }
  /** H11: the final write of `stop()`, after the command in flight; nothing when delivery failed or nothing is pending. */
  private async writeRemainingSamples(): Promise<void> {
    const samples = this.sink.samples;
    if (!samples || this.failedCode !== undefined) return;
    const {rows, losses} = samples.pending();
    if (rows + losses === 0) return;
    let code = 'WRITTEN';
    for (let left = rows + losses; left > 0;) {
      const result = await this.call(() => samples.write(MAX_PENDING_SAMPLES, true));
      if (!result.ok) { code = result.error.code; break; }
      if (!validCounts(result.value)) { code = 'INTERNAL'; break; }
      this.setRetryCode(undefined);
      this.countSkipped(result.value.skipped);
      // Each write stores one plugin session's batch; a write that stored nothing would never end.
      const now = total(samples);
      if (now >= left) { code = 'INTERNAL'; break; }
      left = now;
    }
    this.options.log?.('V1_SAMPLES_EXIT', {rows, losses, code});
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
    this.setRetryCode(code);
    if (this.failedCode === undefined) this.setStatus({state: 'pending', retryCode: code});
  }
  private setRetryCode(code: string | undefined): void {
    if (code === this.retrying) return;
    this.retrying = code; this.options.onRetryCode?.(code);
  }
  /**
   * Stops durable delivery for the service lifetime. `connection` is the one whose work failed; a failed `samples` op
   * has none, so the latest connection is closed instead (H12). Pending samples are discarded and counted once.
   */
  private unavailable(connection: DurableConnection | undefined, code: string): void {
    if (this.failedCode === undefined) {
      this.failedCode = code;
      this.options.log?.('V1_DURABLE_UNAVAILABLE', {code});
      this.setStatus({state: 'failed', code});
      this.clearSampleTimer();
      const discarded = this.sink.samples?.discard() ?? 0;
      if (discarded > 0) this.options.log?.('V1_SAMPLES_DISCARDED', {count: discarded});
    }
    for (const op of this.queue.splice(0)) { if (op.kind !== 'samples') op.connection.dropped = true; this.release(op); }
    const target = connection ?? this.latest;
    if (!target) return;
    target.dropped = true;
    target.link.close('unavailable', code);
    if (this.latest && this.latest !== target) { this.latest.dropped = true; this.latest.link.close('unavailable', code); }
  }
  private setStatus(status: DurableStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.current)) return;
    this.current = status; this.options.onStatus?.(status);
  }
}
