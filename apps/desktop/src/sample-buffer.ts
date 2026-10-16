// The trip recorder's pending one-second samples (ET-015b, H2, H8, H9): rows the sampler chose and storage has not
// stored yet, held in memory until DurableDelivery's `samples` op writes them. The buffer is bounded; beyond the bound
// the newest row is dropped (D7), and each contiguous dropped run of a plugin session becomes one session-level
// `sample-loss` interval, written before that session's next rows. Node-safe: no storage, timer or I/O.
// See docs/telemetry-service-v1.md#one-second-samples-et-015b.
import type {CompletenessInterval, SampleInput} from '../../../packages/storage/src/api';

/** H9: rows held while storage is behind, 5 minutes at 1 Hz. One more row is dropped, never an older one. */
export const MAX_PENDING_SAMPLES = 300;

/** One contiguous run of dropped rows of a plugin session on one source clock. `interval` is fixed once the run ended. */
interface LossRun {pluginSessionId: string; first: SampleInput; last: SampleInput; count: number; interval?: CompletenessInterval}
/**
 * What one write stores, for one plugin session: its loss intervals first, then up to `maxRows` of its rows in the order
 * they were sampled. The arrays are the buffer's own objects; `commitLoss` and `commit` remove them once stored.
 */
export interface SampleBatch {pluginSessionId: string; losses: readonly CompletenessInterval[]; rows: readonly SampleInput[]}

/** The `sample-loss` interval of a dropped run: no trip, source-time and UTC bounds of its first and last row, and its size. */
function lossInterval(run: LossRun): CompletenessInterval {
  return {tripUuid: null, kind: 'sample-loss', startUtcMs: run.first.utcMs, endUtcMs: run.last.utcMs, startMonotonicNs: run.first.monotonicNs,
    endMonotonicNs: run.last.monotonicNs, sourceClockId: run.first.sourceClockId, detail: {cause: 'sample-backlog', count: run.count}};
}

/**
 * Pending sample rows of every plugin session, at most MAX_PENDING_SAMPLES. A run of dropped rows ends when a row of its
 * session is accepted again, when a row on another source clock is dropped, or when `nextBatch` takes it; a run still
 * growing while its batch is being written therefore continues as a new run.
 */
export class SampleBuffer {
  readonly #rows: {pluginSessionId: string; row: SampleInput}[] = [];
  #runs: LossRun[] = [];
  #dropped = 0;

  /** Rows and loss intervals waiting to be written. */
  get pending(): number { return this.#rows.length + this.#runs.length; }
  /** Rows waiting to be written. */
  get rowCount(): number { return this.#rows.length; }
  /** Rows dropped by the bound in this buffer's lifetime. */
  get dropped(): number { return this.#dropped; }

  /** Adds one sampled row. Returns false when the bound dropped it; the row then extends its session's loss run. */
  push(pluginSessionId: string, row: SampleInput): boolean {
    const open = this.#runs.find(run => run.pluginSessionId === pluginSessionId && run.interval === undefined);
    if (this.#rows.length < MAX_PENDING_SAMPLES) {
      if (open) open.interval = lossInterval(open);
      this.#rows.push({pluginSessionId, row});
      return true;
    }
    this.#dropped++;
    if (open && open.first.sourceClockId === row.sourceClockId) { open.last = row; open.count++; return false; }
    if (open) open.interval = lossInterval(open);
    this.#runs.push({pluginSessionId, first: row, last: row, count: 1});
    return false;
  }

  /**
   * The next write: the plugin session of the oldest pending row (or, with no row left, of the oldest loss run), every
   * loss run of that session, ended here, and its oldest `maxRows` rows. Undefined when nothing is pending.
   */
  nextBatch(maxRows: number): SampleBatch | undefined {
    const pluginSessionId = this.#rows[0]?.pluginSessionId ?? this.#runs[0]?.pluginSessionId;
    if (pluginSessionId === undefined) return undefined;
    const losses = this.#runs.filter(run => run.pluginSessionId === pluginSessionId).map(run => run.interval ??= lossInterval(run));
    const rows = this.#rows.filter(entry => entry.pluginSessionId === pluginSessionId).slice(0, Math.max(0, maxRows)).map(entry => entry.row);
    return {pluginSessionId, losses, rows};
  }
  /** One loss interval of a batch was stored. */
  commitLoss(interval: CompletenessInterval): void { this.#runs = this.#runs.filter(run => run.interval !== interval); }
  /** The rows of a batch were stored (appended or skipped as already stored); they leave the buffer. */
  commit(batch: SampleBatch): void {
    const stored = new Set(batch.rows);
    for (let i = this.#rows.length - 1; i >= 0; i--) if (stored.has(this.#rows[i].row)) this.#rows.splice(i, 1);
  }
  /** Drops every pending row and loss run; returns the number of rows dropped. */
  discard(): number {
    const count = this.#rows.length;
    this.#rows.length = 0; this.#runs = [];
    return count;
  }
}
