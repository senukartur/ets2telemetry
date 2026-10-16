// The trip recorder's pending one-second samples (ET-015b, H2, H8, H9): rows the sampler chose and storage has not
// stored yet, held in memory until DurableDelivery's `samples` op writes them. The buffer is bounded; beyond the bound
// the newest row is dropped (D7), and each contiguous dropped run of a plugin session becomes one session-level
// `sample-loss` interval, written before that session's next rows once the run has ended. Node-safe: no storage, timer
// or I/O. See docs/telemetry-service-v1.md#one-second-samples-et-015b.
import type {CompletenessInterval, SampleInput} from '../../../packages/storage/src/api';

/** H9: rows held while storage is behind, 5 minutes at 1 Hz. One more row is dropped, never an older one. */
export const MAX_PENDING_SAMPLES = 300;
/**
 * Pending loss runs per plugin session and source clock. A further run of the same session and clock is merged into
 * the latest one, whose interval then also spans the rows accepted between them; its count stays the dropped rows.
 */
export const MAX_LOSS_RUNS = 16;

/**
 * One run of dropped rows of a plugin session on one source clock. It is `open` while it can still grow: until a row of
 * its session is accepted, a stored batch frees room or a row on another clock is dropped. `taken` is the part a batch
 * holds for writing, and `after` the first row dropped since then, where the remainder starts once that part is stored.
 */
interface LossRun {
  pluginSessionId: string; first: SampleInput; last: SampleInput; count: number; open: boolean;
  taken?: {count: number; interval: CompletenessInterval}; after?: SampleInput;
}
/**
 * What one write stores, for one plugin session: its loss intervals first, then up to `maxRows` of its rows in the order
 * they were sampled. `commitLoss` and `commit` remove exactly what was stored.
 */
export interface SampleBatch {pluginSessionId: string; losses: readonly CompletenessInterval[]; rows: readonly SampleInput[]}

/** The `sample-loss` interval of a dropped run: no trip, source-time and UTC bounds of its first and last row, and its size. */
function lossInterval(run: LossRun): CompletenessInterval {
  return {tripUuid: null, kind: 'sample-loss', startUtcMs: run.first.utcMs, endUtcMs: run.last.utcMs, startMonotonicNs: run.first.monotonicNs,
    endMonotonicNs: run.last.monotonicNs, sourceClockId: run.first.sourceClockId, detail: {cause: 'sample-backlog', count: run.count}};
}

/**
 * Pending sample rows of every plugin session, at most MAX_PENDING_SAMPLES, and the loss runs of rows dropped beyond
 * them. A run is written only once it has ended (or by the final write), so one contiguous outage gives one interval
 * however often its write is retried, and taking a batch never ends a run.
 */
export class SampleBuffer {
  readonly #rows: {pluginSessionId: string; row: SampleInput}[] = [];
  #runs: LossRun[] = [];
  #dropped = 0;

  /** Rows waiting to be written. */
  get rowCount(): number { return this.#rows.length; }
  /** Loss runs waiting to be written, open ones included. */
  get lossCount(): number { return this.#runs.length; }
  /** Rows dropped by the bound in this buffer's lifetime. */
  get dropped(): number { return this.#dropped; }

  /** Adds one sampled row. Returns false when the bound dropped it; the row then extends its session's loss run. */
  push(pluginSessionId: string, row: SampleInput): boolean {
    if (this.#rows.length < MAX_PENDING_SAMPLES) {
      for (const run of this.#runs) if (run.pluginSessionId === pluginSessionId) run.open = false;
      this.#rows.push({pluginSessionId, row});
      return true;
    }
    this.#dropped++;
    const same = this.#runs.filter(run => run.pluginSessionId === pluginSessionId && run.first.sourceClockId === row.sourceClockId), latest = same.at(-1);
    if (latest && (latest.open || same.length >= MAX_LOSS_RUNS)) {
      latest.last = row; latest.count++;
      if (latest.taken) latest.after ??= row;
      return false;
    }
    for (const run of this.#runs) if (run.pluginSessionId === pluginSessionId) run.open = false;
    this.#runs.push({pluginSessionId, first: row, last: row, count: 1, open: true});
    return false;
  }

  /**
   * The next write: the plugin session of the oldest pending row (or, with no row left, of the oldest writable loss run),
   * that session's ended loss runs, every one of them with `final`, and its oldest `maxRows` rows. Undefined when
   * nothing is writable. Taking a batch does not end a run; a run that grows meanwhile keeps the growth for later.
   */
  nextBatch(maxRows: number, final = false): SampleBatch | undefined {
    const writable = (run: LossRun) => final || !run.open;
    const pluginSessionId = this.#rows[0]?.pluginSessionId ?? this.#runs.find(writable)?.pluginSessionId;
    if (pluginSessionId === undefined) return undefined;
    const losses = this.#runs.filter(run => run.pluginSessionId === pluginSessionId && writable(run)).map(run => {
      // A run unchanged since an earlier batch keeps that batch's interval, so either batch may commit it.
      if (run.taken?.count !== run.count) { run.taken = {count: run.count, interval: lossInterval(run)}; run.after = undefined; }
      return run.taken.interval;
    });
    const rows = this.#rows.filter(entry => entry.pluginSessionId === pluginSessionId).slice(0, Math.max(0, maxRows)).map(entry => entry.row);
    return {pluginSessionId, losses, rows};
  }
  /** One loss interval of a batch was stored: its part leaves the run, and rows dropped since the batch was taken remain. */
  commitLoss(interval: CompletenessInterval): void {
    const run = this.#runs.find(candidate => candidate.taken?.interval === interval);
    if (!run?.taken) return;
    if (run.count === run.taken.count || !run.after) this.#runs = this.#runs.filter(candidate => candidate !== run);
    else { run.count -= run.taken.count; run.first = run.after; }
    run.taken = undefined; run.after = undefined;
  }
  /** The rows of a batch were stored (appended or skipped as already stored); they leave the buffer, and the freed room ends every open run. */
  commit(batch: SampleBatch): void {
    const stored = new Set(batch.rows), before = this.#rows.length;
    for (let i = this.#rows.length - 1; i >= 0; i--) if (stored.has(this.#rows[i].row)) this.#rows.splice(i, 1);
    if (this.#rows.length < before) for (const run of this.#runs) run.open = false;
  }
  /** Drops every pending row and loss run; returns the number of rows dropped. */
  discard(): number {
    const count = this.#rows.length;
    this.#rows.length = 0; this.#runs = [];
    return count;
  }
}
