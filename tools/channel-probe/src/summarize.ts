// ET-051: statistics over the raw per-frame SDK average consumption that the v0 diagnostics mode copies. Pure: no I/O.

export const CONSUMPTION_CHANNEL = 'truck.fuel.consumption.average';
/** Below this absolute raw speed (m/s) a frame counts as standing. */
export const STANDING_SPEED_MPS = 0.5;

/** A raw channel value of one frame: the SDK number, `unavailable` when the plugin marked it so, null when no callback came. */
export type RawValue = number | 'unavailable' | null;
export type Simulation = 'running' | 'paused' | 'unavailable';
/** One plugin publication (one game frame) that carried a diagnostic batch. */
export interface ProbeFrame {
  /** 1-based connection index; frame intervals and zero runs never span two connections. */
  connection: number;
  /** The plugin's capture clock of the frame, in nanoseconds (decimal text). */
  monotonicNs: string;
  /** From the snapshot with the same capture; null when none preceded the batch. */
  simulation: Simulation | null;
  consumption: RawValue; speed: RawValue; rpm: RawValue; fuel: RawValue;
  /** The plugin's cumulative counters at this frame. */
  coalescedSnapshots: string; lostObservations: string;
}
interface Share { frames: number; zero: number; zeroPercent: number }
type Lengths = Record<'1' | '2' | '3' | '4-10' | '11-60' | '61+', number>;
export interface Distribution { count: number; median: number | null; p10: number | null; p90: number | null; p95: number | null; max: number | null }
export interface ProbeSummary {
  channel: typeof CONSUMPTION_CHANNEL;
  unit: 'L/km (raw SDK float)';
  frames: number;
  connections: number;
  consumption: {
    observed: number; unavailable: number; absent: number; zero: number; negativeZero: number; zeroPercent: number;
    running: Share; paused: Share; standing: Share; moving: Share;
  };
  zeroRuns: {
    count: number;
    /** Runs still open when their connection or the capture ended; their duration is unknown. */
    open: number;
    /** In received frames. */
    lengthFrames: Lengths;
    /** From the first zero frame to the first following frame with a different consumption reading. */
    durationMs: Distribution;
    startIntervalMs: Distribution;
    /** Single-frame zeros whose two neighbours differ by less than 1 % of the earlier one. */
    singleFrameBetweenCloseNeighbours: number;
    /**
     * Run lengths count received frames, and the plugin may coalesce frames between two received ones. These are the closed
     * runs with no coalesced frame from the reading before the run to the reading after it, so their lengths are game frames.
     */
    exact: {count: number; lengthFrames: Lengths; singleFrameBetweenCloseNeighbours: number};
  };
  /** Between received frames: the relay's delivery cadence, not the game's frame rate. */
  frameIntervalMs: Distribution & { receivedPerSecond: number | null };
  /** Received plus coalesced frames over the capture-clock span of each connection: the plugin's publication rate. */
  publishedPerSecond: number | null;
  /**
   * From the plugin's counters. `coalescedSnapshots` counts frames published but not received. `lostObservations` also
   * counts observations v0 cannot carry, such as the world placement in every frame, so it is not a frame count.
   */
  missed: { coalescedSnapshots: string; lostObservations: string };
}

const round = (value: number): number => Math.round(value * 10) / 10;
function distribution(values: number[]): Distribution {
  if (!values.length) return {count: 0, median: null, p10: null, p90: null, p95: null, max: null};
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank.
  const rank = (p: number) => round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
  return {count: sorted.length, median: rank(0.5), p10: rank(0.1), p90: rank(0.9), p95: rank(0.95), max: round(sorted[sorted.length - 1])};
}
const share = (frames: number, zero: number): Share => ({frames, zero, zeroPercent: frames ? round(100 * zero / frames) : 0});
const milliseconds = (fromNs: bigint, toNs: bigint): number => Number(toNs - fromNs) / 1e6;
const emptyLengths = (): Lengths => ({'1': 0, '2': 0, '3': 0, '4-10': 0, '11-60': 0, '61+': 0});
function bucket(length: number): keyof Lengths {
  return length <= 3 ? String(length) as '1' | '2' | '3' : length <= 10 ? '4-10' : length <= 60 ? '11-60' : '61+';
}

/** Accumulates frames in arrival order, so a long capture never has to keep every frame in memory. */
export class ProbeSummarizer {
  private frames = 0;
  private readonly connections = new Set<number>();
  private observed = 0; private unavailable = 0; private absent = 0; private zero = 0; private negativeZero = 0;
  private readonly split = {running: [0, 0], paused: [0, 0], standing: [0, 0], moving: [0, 0]};
  private readonly frameIntervals: number[] = [];
  private readonly runDurations: number[] = [];
  private readonly runStartIntervals: number[] = [];
  private readonly lengths = emptyLengths();
  private readonly exactLengths = emptyLengths();
  private runs = 0; private open = 0; private closeSingles = 0; private exactRuns = 0; private exactCloseSingles = 0;
  private missedCoalesced = 0n; private missedLost = 0n;
  private published = 0n; private spanNs = 0n;
  // Per-connection state.
  private connection = 0;
  private connectionFrames = 0;
  private firstNs?: bigint;
  private previousNs?: bigint;
  private firstCounters?: [bigint, bigint];
  private lastCounters?: [bigint, bigint];
  private lastStartNs?: bigint;
  /** The last numeric reading before the current run with the coalesced counter at it, and the run itself. */
  private before?: {value: number; coalesced: bigint};
  private run?: {startNs: bigint; length: number};

  add(frame: ProbeFrame): void {
    const ns = BigInt(frame.monotonicNs), counters: [bigint, bigint] = [BigInt(frame.coalescedSnapshots), BigInt(frame.lostObservations)];
    if (frame.connection !== this.connection) {this.endConnection(); this.connection = frame.connection; this.firstNs = ns; this.firstCounters = counters;}
    else if (this.previousNs !== undefined && ns > this.previousNs) this.frameIntervals.push(milliseconds(this.previousNs, ns));
    this.frames++; this.connectionFrames++; this.connections.add(frame.connection); this.previousNs = ns; this.lastCounters = counters;
    const value = frame.consumption;
    if (value === null) {this.absent++; return;}
    if (value === 'unavailable') {this.unavailable++; this.endRun(ns, undefined, counters[0]); this.before = undefined; return;}
    this.observed++;
    const isZero = value === 0;
    if (isZero) {this.zero++; if (Object.is(value, -0)) this.negativeZero++;}
    const count = (key: keyof ProbeSummarizer['split']) => {this.split[key][0]++; if (isZero) this.split[key][1]++;};
    if (frame.simulation === 'running') count('running'); else if (frame.simulation === 'paused') count('paused');
    if (typeof frame.speed === 'number') count(Math.abs(frame.speed) < STANDING_SPEED_MPS ? 'standing' : 'moving');
    if (isZero) {
      if (this.run) this.run.length++;
      else {
        this.run = {startNs: ns, length: 1}; this.runs++;
        if (this.lastStartNs !== undefined) this.runStartIntervals.push(milliseconds(this.lastStartNs, ns));
        this.lastStartNs = ns;
      }
      return;
    }
    this.endRun(ns, value, counters[0]); this.before = {value, coalesced: counters[0]};
  }
  private endRun(ns: bigint, after: number | undefined, coalesced: bigint): void {
    if (!this.run) return;
    const before = this.before?.value;
    const close = this.run.length === 1 && before !== undefined && after !== undefined && before !== 0 && Math.abs(after - before) < Math.abs(before) * 0.01;
    this.lengths[bucket(this.run.length)]++; this.runDurations.push(milliseconds(this.run.startNs, ns));
    if (close) this.closeSingles++;
    if (this.before && after !== undefined && coalesced === this.before.coalesced) {this.exactRuns++; this.exactLengths[bucket(this.run.length)]++; if (close) this.exactCloseSingles++;}
    this.run = undefined;
  }
  private endConnection(): void {
    if (this.run) {this.lengths[bucket(this.run.length)]++; this.open++; this.run = undefined;}
    // The counters are cumulative: the delta from the first received frame leaves out what was coalesced before the probe saw any.
    if (this.firstCounters && this.lastCounters) {
      const coalesced = this.lastCounters[0] - this.firstCounters[0];
      this.missedCoalesced += coalesced; this.missedLost += this.lastCounters[1] - this.firstCounters[1];
      if (this.firstNs !== undefined && this.previousNs !== undefined && this.previousNs > this.firstNs) {
        this.spanNs += this.previousNs - this.firstNs; this.published += BigInt(this.connectionFrames - 1) + coalesced;
      }
    }
    this.previousNs = this.firstNs = undefined; this.before = undefined; this.lastStartNs = undefined; this.firstCounters = this.lastCounters = undefined; this.connectionFrames = 0;
  }
  result(): ProbeSummary {
    // Closing the open connection is idempotent for later frames: they always start a new connection index.
    this.endConnection(); this.connection = 0;
    const intervals = distribution(this.frameIntervals);
    return {
      channel: CONSUMPTION_CHANNEL, unit: 'L/km (raw SDK float)', frames: this.frames, connections: this.connections.size,
      consumption: {observed: this.observed, unavailable: this.unavailable, absent: this.absent, zero: this.zero, negativeZero: this.negativeZero,
        zeroPercent: this.observed ? round(100 * this.zero / this.observed) : 0,
        running: share(this.split.running[0], this.split.running[1]), paused: share(this.split.paused[0], this.split.paused[1]),
        standing: share(this.split.standing[0], this.split.standing[1]), moving: share(this.split.moving[0], this.split.moving[1])},
      zeroRuns: {count: this.runs, open: this.open, lengthFrames: {...this.lengths}, durationMs: distribution(this.runDurations),
        startIntervalMs: distribution(this.runStartIntervals), singleFrameBetweenCloseNeighbours: this.closeSingles,
        exact: {count: this.exactRuns, lengthFrames: {...this.exactLengths}, singleFrameBetweenCloseNeighbours: this.exactCloseSingles}},
      frameIntervalMs: {...intervals, receivedPerSecond: intervals.median ? round(1000 / intervals.median) : null},
      publishedPerSecond: this.spanNs ? round(Number(this.published) * 1e9 / Number(this.spanNs)) : null,
      missed: {coalescedSnapshots: this.missedCoalesced.toString(), lostObservations: this.missedLost.toString()}
    };
  }
}
export function summarize(frames: Iterable<ProbeFrame>): ProbeSummary {
  const summarizer = new ProbeSummarizer();
  for (const frame of frames) summarizer.add(frame);
  return summarizer.result();
}
