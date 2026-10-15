// Protocol v1 producer event store model (ET-005b). A TypeScript mirror of the native ET-004b EventStore and its
// invariants I1-I8 (docs/native-transport-v1.md#store-rules). Single-threaded and I/O-free; every time is an explicit
// argument in the source monotonic clock (nanoseconds). It is a simulator model, not production code.
import {GAP_RECORD_BYTES, MAX_EVENT_SEQ, V1_LIMITS, type EventOccurrence, type EventRecord, type LossCounts} from '../../../../packages/contracts/src/protocol-v1';

export type LossCause = keyof LossCounts;
/** The six loss causes in wire order. */
export const LOSS_CAUSES: readonly LossCause[] = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed'];
export type Counts = Record<LossCause, bigint>;
export const zeroCounts = (): Counts => ({offline: 0n, noDurableConsumer: 0n, queueCount: 0n, queueBytes: 0n, retentionExpired: 0n, encodingFailed: 0n});
const plus = (a: Counts, b: Counts): Counts => Object.fromEntries(LOSS_CAUSES.map(k => [k, a[k] + b[k]])) as Counts;
const minus = (a: Counts, b: Counts): Counts => Object.fromEntries(LOSS_CAUSES.map(k => [k, a[k] - b[k]])) as Counts;
/** Wire form of loss counts: canonical uint64 strings. */
export const wireCounts = (c: Counts): LossCounts => Object.fromEntries(LOSS_CAUSES.map(k => [k, c[k].toString()])) as unknown as LossCounts;

/** One copied event in wire shape; `eventSeq` is its durable identity. */
export interface StoredEvent {eventSeq: bigint; occurred: EventOccurrence; record: EventRecord}
/** A lost eventSeq range. Lost times are both present or both absent (OD-5 S1). */
export interface GapRange {first: bigint; last: bigint; causes: Counts; firstLostNs?: bigint; lastLostNs?: bigint}
export type Outbound = {gap: false; event: StoredEvent; redelivered: boolean} | {gap: true; range: GapRange; redelivered: boolean};
export type Admission = 'retained' | 'lostQueueCount' | 'lostQueueBytes' | 'lostRetentionExpired' | 'rejected';
export interface StoreStatus {ackedThroughEventSeq: bigint; nextEventSeq: bigint; retainedEntries: number; retainedBytes: number; oldestRetainedNs?: bigint; eventLoss: Counts}
export interface EndCursor {nextEventSeq: bigint; ackedThroughEventSeq: bigint; retainedUnacked: bigint}
export interface EntryView {gap: boolean; first: bigint; last: bigint; bytes: number; sinceNs: bigint; causes: Counts}

export const MAX_SEQ = BigInt(MAX_EVENT_SEQ);
const U64_MAX = 2n ** 64n - 1n;
const RETENTION_NS = BigInt(V1_LIMITS.disconnectRetentionMs) * 1_000_000n;
interface Entry {
  gap: boolean; first: bigint; last: bigint; bytes: number; sinceNs: bigint; event?: StoredEvent;
  causes: Counts; firstLost?: bigint; lastLost?: bigint;
  // Gap records only: the causes already written on this connection and the lost times of the unwritten tail.
  writtenCauses: Counts; tailFirstLost?: bigint; tailLastLost?: bigint;
}
// Merging lost times keeps the earliest first and the latest last observation (OD-5 S1).
function widen(t: {first?: bigint; last?: bigint}, first?: bigint, last?: bigint): void {
  if (first !== undefined) t.first = t.first === undefined || first < t.first ? first : t.first;
  if (last !== undefined) t.last = t.last === undefined || last > t.last ? last : t.last;
}

/**
 * The retained, unacknowledged entries of one plugin session, its loss counters and the outbound cursor.
 * I1 entries cover exactly [A + 1, N); I2 at most 256 entries and 1 MiB with one entry and 1,024 bytes reserved for a
 * trailing gap record; I3 a loss extends a trailing gap record in place; I4 an ACK never splits an entry; I5 retention
 * expiry merges in place; I6 each eventSeq is written once per connection with its redelivered flag; I7 A, N and the
 * counters never decrease; I8 N stops at MAX_EVENT_SEQ + 1. Misuse returns `rejected`, false or undefined with no effect.
 */
export class EventStore {
  private entries: Entry[] = [];
  private bytes = 0; private acked: bigint; private next: bigint; private loss = zeroCounts();
  private connectedFlag = false; private everConnected = false; private deadline?: bigint;
  // Highest eventSeq written on the current connection, and on any connection before it.
  private sentThrough = 0n; private written = 0n; private writtenBefore = 0n;
  /** `startEventSeq` above 1 is a synthetic affordance for exhaustion scenarios: [1, start) counts as acknowledged. */
  constructor(startEventSeq = 1n) {
    if (startEventSeq < 1n || startEventSeq > MAX_SEQ) throw new Error('Invalid start eventSeq');
    this.acked = startEventSeq - 1n; this.next = startEventSeq;
  }
  get exhausted(): boolean { return this.next > MAX_SEQ; }
  get connected(): boolean { return this.connectedFlag; }
  get everConnectedDurably(): boolean { return this.everConnected; }
  get nextEventSeq(): bigint { return this.next; }
  get releasePoint(): bigint { return this.acked; }
  get retentionDeadlineNs(): bigint | undefined { return this.deadline; }
  get entryCount(): number { return this.entries.length; }
  entry(index: number): EntryView {
    const e = this.entries[index]; return {gap: e.gap, first: e.first, last: e.last, bytes: e.bytes, sinceNs: e.sinceNs, causes: {...e.causes}};
  }

  private pushGap(first: bigint, last: bigint, causes: Counts, firstNs: bigint | undefined, lastNs: bigint | undefined, nowNs: bigint): boolean {
    const tail = this.entries.at(-1);
    if (tail?.gap) {
      // A lost range extends the trailing gap record in place; it keeps its entry, its 1,024 bytes and its retention time.
      tail.last = last; tail.causes = plus(tail.causes, causes);
      const all = {first: tail.firstLost, last: tail.lastLost}; widen(all, firstNs, lastNs); tail.firstLost = all.first; tail.lastLost = all.last;
      const t = {first: tail.tailFirstLost, last: tail.tailLastLost}; widen(t, firstNs, lastNs); tail.tailFirstLost = t.first; tail.tailLastLost = t.last;
      return true;
    }
    // The admission rule keeps one entry and GAP_RECORD_BYTES free whenever the trailing entry is an event.
    if (this.entries.length >= V1_LIMITS.retainedEntries || this.bytes + GAP_RECORD_BYTES > V1_LIMITS.retainedBytes) return false;
    this.entries.push({gap: true, first, last, bytes: GAP_RECORD_BYTES, sinceNs: nowNs, causes, firstLost: firstNs, lastLost: lastNs, writtenCauses: zeroCounts()});
    this.bytes += GAP_RECORD_BYTES; return true;
  }
  /**
   * Retains one event measured at admission with the worst-case envelope (OD-5 S3), or records it as lost with
   * queueCount, queueBytes (queueCount wins when both apply) or retentionExpired (stored after its window ended, OD-5 S4).
   */
  admit(event: StoredEvent, encodedBytes: number, nowNs: bigint): Admission {
    if (this.exhausted || !this.everConnected || event.eventSeq !== this.next || !Number.isInteger(encodedBytes) || encodedBytes < 1 || encodedBytes > V1_LIMITS.eventBytes) return 'rejected';
    const m = event.occurred.monotonicNs, observed = m.available ? BigInt(m.value) : undefined;
    let result: Admission, cause: LossCause;
    if (!this.connectedFlag && this.deadline === undefined) { result = 'lostRetentionExpired'; cause = 'retentionExpired'; }
    else if (this.entries.length + 2 > V1_LIMITS.retainedEntries) { result = 'lostQueueCount'; cause = 'queueCount'; }
    else if (this.bytes + encodedBytes + GAP_RECORD_BYTES > V1_LIMITS.retainedBytes) { result = 'lostQueueBytes'; cause = 'queueBytes'; }
    else {
      this.entries.push({gap: false, first: event.eventSeq, last: event.eventSeq, bytes: encodedBytes, sinceNs: nowNs, event, causes: zeroCounts(), writtenCauses: zeroCounts()});
      this.bytes += encodedBytes; this.next = event.eventSeq + 1n; return 'retained';
    }
    return this.lose(event.eventSeq, event.eventSeq, cause, observed, observed, nowNs) ? result : 'rejected';
  }
  /** Records [first, last] lost with one cause. `first` must equal N; lost times are both present (first ≤ last) or absent. */
  lose(first: bigint, last: bigint, cause: LossCause, firstLostNs: bigint | undefined, lastLostNs: bigint | undefined, nowNs: bigint): boolean {
    if (this.exhausted || first !== this.next || last < first || last > MAX_SEQ || (firstLostNs === undefined) !== (lastLostNs === undefined)) return false;
    if (firstLostNs !== undefined && lastLostNs !== undefined && firstLostNs > lastLostNs) return false;
    const causes = zeroCounts(); causes[cause] = last - first + 1n;
    if (!this.pushGap(first, last, causes, firstLostNs, lastLostNs, nowNs)) return false;
    this.loss[cause] += last - first + 1n; this.next = last + 1n; return true;
  }
  /** A durable consumer connected: cancels any retention window and starts the outbound cursor at A. */
  connect(): void {
    this.connectedFlag = true; this.everConnected = true; this.deadline = undefined;
    this.sentThrough = this.acked; this.writtenBefore = this.written;
  }
  /** The durable consumer is gone: the 300,000 ms retention window starts now. */
  disconnect(nowNs: bigint): void {
    if (!this.connectedFlag) return;
    this.connectedFlag = false; this.deadline = nowNs > U64_MAX - RETENTION_NS ? U64_MAX : nowNs + RETENTION_NS;
  }
  /** After the window, every retained event becomes retentionExpired coverage merged into one gap record (OD-5 S2). */
  expire(nowNs: bigint): void {
    if (this.connectedFlag || this.deadline === undefined || nowNs < this.deadline) return;
    this.deadline = undefined;
    if (this.entries.every(e => e.gap)) return;
    let causes = zeroCounts(), expired = 0n; const times: {first?: bigint; last?: bigint} = {};
    for (const e of this.entries) {
      if (e.gap) { causes = plus(causes, e.causes); widen(times, e.firstLost, e.lastLost); continue; }
      expired++;
      const m = e.event!.occurred.monotonicNs; if (m.available) widen(times, BigInt(m.value), BigInt(m.value));
    }
    causes.retentionExpired += expired; this.loss.retentionExpired += expired;
    const first = this.acked + 1n, last = this.next - 1n;
    this.entries = []; this.bytes = 0;
    this.pushGap(first, last, causes, times.first, times.last, nowNs);
  }
  /** The next item after the last one written on this connection; returning it marks it written (OD-5 S9). */
  nextOutbound(): Outbound | undefined {
    if (!this.connectedFlag || this.sentThrough + 1n >= this.next) return undefined;
    const seq = this.sentThrough + 1n, e = this.entries.find(x => x.last >= seq);
    if (!e) return undefined;
    const redelivered = seq <= this.writtenBefore;
    let out: Outbound;
    if (!e.gap) out = {gap: false, event: e.event!, redelivered};
    else {
      // A record written whole before on this connection was extended since: write only the new tail as a delta.
      const whole = seq === e.first;
      out = {gap: true, redelivered, range: whole
        ? {first: seq, last: e.last, causes: {...e.causes}, firstLostNs: e.firstLost, lastLostNs: e.lastLost}
        : {first: seq, last: e.last, causes: minus(e.causes, e.writtenCauses), firstLostNs: e.tailFirstLost, lastLostNs: e.tailLastLost}};
      e.writtenCauses = {...e.causes}; e.tailFirstLost = undefined; e.tailLastLost = undefined;
    }
    this.sentThrough = e.last; if (e.last > this.written) this.written = e.last;
    return out;
  }
  /** Applies a cumulative ACK accepted by AckValidator; never splits an entry. Returns the release point. */
  release(through: bigint): bigint | undefined {
    if (!this.connectedFlag || through > this.sentThrough) return undefined;
    if (through <= this.acked) return this.acked;
    while (this.entries.length && this.entries[0].last <= through) this.bytes -= this.entries.shift()!.bytes;
    // An ACK inside a gap record leaves it whole; the release point becomes that record's first eventSeq - 1.
    const head = this.entries[0];
    this.acked = head && head.first <= through ? head.first - 1n : through;
    return this.acked;
  }
  status(): StoreStatus {
    let oldest: bigint | undefined;
    for (const e of this.entries) if (oldest === undefined || e.sinceNs < oldest) oldest = e.sinceNs;
    return {ackedThroughEventSeq: this.acked, nextEventSeq: this.next, retainedEntries: this.entries.length, retainedBytes: this.bytes, oldestRetainedNs: oldest, eventLoss: {...this.loss}};
  }
  /** `end` fields; retainedUnacked counts retained events, not gap records (OD-5 S5). */
  endCursor(): EndCursor {
    return {nextEventSeq: this.next, ackedThroughEventSeq: this.acked, retainedUnacked: BigInt(this.entries.filter(e => !e.gap).length)};
  }
}
