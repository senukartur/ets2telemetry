// Protocol v1 delivery rules: stream ordering and event coverage on the client, the storage-commit ACK cursor,
// the producer-side ACK validator and clock mapping. No I/O, storage, Electron or Node APIs; see docs/protocol/v1.md.
import {
  PROTOCOL_V1, ProtocolError, validateClientMessage, validateServerMessage,
  type ClientMessage, type Continuity, type EventType, type LossCounts, type ServerMessage, type SourceStatus, type Uint64
} from './protocol-v1';
import {isUint64} from './protocol-v0';

function fail(reason = 'Protocol v1 delivery violation'): never { throw new ProtocolError(reason); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Exact BigInt of a canonical uint64 decimal string; callers never pass JavaScript numbers. */
function uint(v: Uint64, minimum = 0n): bigint { if (!isUint64(v) || BigInt(v) < minimum) fail('Invalid uint64 value'); return BigInt(v); }

export interface V1Applied {
  message: ServerMessage;
  /** True only for the coherent checkpoint. Hydration replaces current state and never applies job, delivery or cancellation effects. */
  hydration: boolean;
  /** Exact message `seq` difference minus one. Coalescing makes skips legal; a skip alone is not lost gameplay data. */
  skippedSequences: Uint64;
  /** eventSeq range of an event (one value) or a gap, in stream order. Feed it to the ACK cursor only after storage commits it. */
  coverage?: {firstEventSeq: Uint64; lastEventSeq: Uint64};
}
const LOSS_KEYS: (keyof LossCounts)[] = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed'];

/**
 * Client-side ordering for one connection: welcome, exactly one checkpoint, then live messages until `end`.
 * It enforces source identity, clock and sequence order, contiguous eventSeq coverage, durable opt-in and a
 * terminal `end`. Any violation closes the consumer; a reconnection needs a new consumer.
 */
export class V1Consumer {
  private phase: 'welcome' | 'checkpoint' | 'live' | 'closed' = 'welcome';
  private identity?: string; private clock?: string; private lastSeq = 0n; private lastCapture = 0n;
  private durable = false; private eventTypes = new Set<EventType>();
  private nextEvent = 1n; private liveFrom = 1n; private eventBoundary = 0n; private eventRevision = 0n; private stateBoundary = 0n;
  private status?: SourceStatus; private continuity?: Continuity; private probe?: bigint; private lastProbe = 0n;
  constructor(private readonly durableRequested: boolean) {}
  /** The connection's plugin session, known after welcome. */
  get pluginSessionId(): string | undefined { return this.identity?.split('|')[1]; }
  /** Durable delivery granted by welcome. */
  get durableEvents(): boolean { return this.durable; }
  /** The next eventSeq this connection must cover. */
  get nextEventSeq(): Uint64 { return this.nextEvent.toString(); }
  /**
   * Registers the one outstanding clock probe before it is sent. Probe IDs increase within a connection; an
   * unsolicited or mismatched reply is a violation. The one-per-second rate and reply deadline belong to the caller.
   */
  expectClockReply(probeId: Uint64): void {
    try {
      const id = uint(probeId, 1n);
      if (this.phase === 'closed' || this.probe !== undefined || id <= this.lastProbe) fail('Clock probe not allowed');
      this.probe = id; this.lastProbe = id;
    } catch (error) { this.phase = 'closed'; throw error; }
  }
  accept(input: unknown): V1Applied {
    try {
      if (this.phase === 'closed') fail('Consumer is closed');
      const m = validateServerMessage(input), seq = BigInt(m.seq), capture = BigInt(m.capture.monotonicNs);
      // Identity comparison does not depend on JSON property order.
      const identity = [m.source.game, m.source.pluginSessionId, m.source.processInstanceId, m.source.processId, m.source.windowsSessionId, m.source.origin].join('|');
      if (this.phase === 'welcome') {
        if (m.kind !== 'welcome' || (m.data.durableEvents && !this.durableRequested)) fail('Welcome expected');
        this.identity = identity; this.clock = m.capture.clockId; this.durable = m.data.durableEvents;
        this.eventTypes = new Set(m.data.capabilities.eventTypes); this.lastSeq = seq; this.lastCapture = capture; this.phase = 'checkpoint';
        return {message: m, hydration: false, skippedSequences: '0'};
      }
      if (identity !== this.identity || m.capture.clockId !== this.clock || seq <= this.lastSeq || capture < this.lastCapture) fail('Source identity, clock or order violation');
      if (m.kind === 'welcome' || (this.phase === 'checkpoint' ? m.kind !== 'checkpoint' && m.kind !== 'end' : m.kind === 'checkpoint')) fail('Unexpected message for phase');
      const result: V1Applied = {message: m, hydration: m.kind === 'checkpoint', skippedSequences: (seq - this.lastSeq - 1n).toString()};
      switch (m.kind) {
        case 'checkpoint': case 'snapshot': {
          const s = m.data.status, boundary = BigInt(m.data.state.boundaryOrder);
          if (s.delivery.durable !== this.durable || boundary < this.stateBoundary) fail('State order violation');
          if (m.kind === 'checkpoint') { this.nextEvent = BigInt(s.delivery.ackedThroughEventSeq) + 1n; this.liveFrom = BigInt(s.delivery.nextEventSeq); }
          this.checkStatus(s, m.data.continuity); this.stateBoundary = boundary; break;
        }
        case 'event': case 'gap': {
          if (!this.durable) fail('Durable stream not granted');
          const first = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.firstEventSeq), last = m.kind === 'event' ? first : BigInt(m.data.lastEventSeq);
          // Coverage is contiguous: a duplicate or a skip within one connection is a violation, never a silent loss.
          if (first !== this.nextEvent || (first >= this.liveFrom && m.data.redelivered)) fail('eventSeq coverage violation');
          if (m.kind === 'event') {
            const boundary = BigInt(m.data.occurred.boundaryOrder), revision = BigInt(m.data.occurred.configurationRevision);
            if (!this.eventTypes.has(m.data.record.type) || boundary < this.eventBoundary || revision < this.eventRevision) fail('Event order violation');
            this.eventBoundary = boundary; this.eventRevision = revision;
          }
          this.nextEvent = last + 1n; result.coverage = {firstEventSeq: first.toString(), lastEventSeq: last.toString()}; break;
        }
        case 'clock.reply':
          if (this.probe === undefined || BigInt(m.data.probeId) !== this.probe) fail('Unsolicited clock reply');
          this.probe = undefined; break;
        case 'end': {
          // Before the checkpoint the delivery cursor is unknown, so only the schema rules apply to an early end.
          const acked = BigInt(m.data.ackedThroughEventSeq);
          if (this.status && (BigInt(m.data.nextEventSeq) < this.nextEvent || acked > this.nextEvent - 1n || acked < BigInt(this.status.delivery.ackedThroughEventSeq))) fail('End marker inconsistent');
          this.lastSeq = seq; this.lastCapture = capture; this.phase = 'closed'; return result;
        }
      }
      this.lastSeq = seq; this.lastCapture = capture; this.phase = 'live'; return result;
    } catch (error) { this.phase = 'closed'; throw error; }
  }
  private checkStatus(s: SourceStatus, continuity: Continuity) {
    const acked = BigInt(s.delivery.ackedThroughEventSeq), previous = this.status;
    // The producer accepts an ACK only for eventSeqs already sent on this connection.
    if (acked > this.nextEvent - 1n) fail('Acknowledged beyond delivered coverage');
    if (previous && (acked < BigInt(previous.delivery.ackedThroughEventSeq) || BigInt(s.delivery.nextEventSeq) < BigInt(previous.delivery.nextEventSeq) ||
      LOSS_KEYS.some(key => BigInt(s.eventLoss[key]) < BigInt(previous.eventLoss[key])))) fail('Status counters regressed');
    if (this.continuity && (BigInt(continuity.coalescedSnapshots) < BigInt(this.continuity.coalescedSnapshots) ||
      BigInt(continuity.offlineTransitions) < BigInt(this.continuity.offlineTransitions))) fail('Continuity counters regressed');
    this.status = s; this.continuity = continuity;
  }
}

/**
 * Client-side cumulative ACK cursor for one plugin session, kept across its connections. `throughEventSeq` is the
 * highest eventSeq T such that storage committed every event and gap marker in [1, T]. Receipt alone never advances it.
 */
export class DurableAckCursor {
  private through: bigint; private receivedThrough: bigint; private lastAck: bigint;
  private pending: [bigint, bigint][] = [];
  /** `committedThroughEventSeq` is the contiguous commit point already in storage for this plugin session. */
  constructor(readonly pluginSessionId: string, committedThroughEventSeq: Uint64 = '0') {
    if (!UUID.test(pluginSessionId)) fail('Invalid plugin session');
    this.through = uint(committedThroughEventSeq); this.receivedThrough = this.through; this.lastAck = this.through;
  }
  get throughEventSeq(): Uint64 { return this.through.toString(); }
  /** Starts a connection from its checkpoint. The producer cannot have acknowledged more than storage committed. */
  beginConnection(ackedThroughEventSeq: Uint64): void {
    const acked = uint(ackedThroughEventSeq);
    if (acked > this.through) fail('Producer acknowledged beyond local commits');
    this.lastAck = acked;
  }
  /** Records coverage delivered by the consumer; commits are allowed only inside received coverage. */
  received(first: Uint64, last: Uint64): void {
    const a = uint(first, 1n), b = uint(last, 1n);
    if (b < a || a > this.receivedThrough + 1n) fail('Received coverage is not contiguous');
    if (b > this.receivedThrough) this.receivedThrough = b;
  }
  isCommitted(eventSeq: Uint64): boolean {
    const n = uint(eventSeq, 1n); return n <= this.through || this.pending.some(([a, b]) => a <= n && n <= b);
  }
  /**
   * Call only after the storage transaction that inserted UNIQUE(plugin_session_id, event_seq) rows (events or gap
   * markers) for [first, last] committed. A redelivered range already committed is a `duplicate`.
   */
  commit(first: Uint64, last: Uint64 = first): 'committed' | 'duplicate' {
    const a = uint(first, 1n), b = uint(last, 1n);
    if (b < a || b > this.receivedThrough) fail('Commit outside received coverage');
    if (b <= this.through || this.pending.some(([x, y]) => x <= a && b <= y)) return 'duplicate';
    const merged: [bigint, bigint][] = [];
    for (const range of [...this.pending, [a > this.through ? a : this.through + 1n, b] as [bigint, bigint]].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
      const top = merged[merged.length - 1];
      if (top && range[0] <= top[1] + 1n) { if (range[1] > top[1]) top[1] = range[1]; } else merged.push([range[0], range[1]]);
    }
    while (merged.length && merged[0][0] <= this.through + 1n) { const [, end] = merged.shift()!; if (end > this.through) this.through = end; }
    this.pending = merged; return 'committed';
  }
  /** The next cumulative ACK, or undefined when it would not advance; an equal ACK is a producer no-op. */
  ack(): ClientMessage | undefined {
    if (this.through <= this.lastAck) return undefined;
    this.lastAck = this.through;
    return {version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: this.pluginSessionId, throughEventSeq: this.through.toString()}};
  }
}

/**
 * Producer-side ACK validation for one connection. It rejects a foreign plugin session, an ACK beyond the highest
 * eventSeq sent on this connection and a regressing ACK, and closes on the first violation. An equal ACK is a no-op.
 */
export class AckValidator {
  private acked: bigint; private sentThrough: bigint; private closed = false;
  constructor(private readonly pluginSessionId: string, ackedThroughEventSeq: Uint64) {
    if (!UUID.test(pluginSessionId)) fail('Invalid plugin session');
    this.acked = uint(ackedThroughEventSeq); this.sentThrough = this.acked;
  }
  get ackedThroughEventSeq(): Uint64 { return this.acked.toString(); }
  /** Records an event or gap written on this connection, covering eventSeqs through `lastEventSeq`. */
  sent(lastEventSeq: Uint64): void { const n = uint(lastEventSeq, 1n); if (n > this.sentThrough) this.sentThrough = n; }
  /** Returns the new acknowledged eventSeq after an advance; the producer then releases those retained entries. */
  accept(input: unknown): Uint64 | undefined {
    try {
      if (this.closed) fail('ACK validator is closed');
      const m = validateClientMessage(input); if (m.kind !== 'ack') fail('ACK expected');
      const through = BigInt(m.data.throughEventSeq);
      if (m.data.pluginSessionId !== this.pluginSessionId) fail('ACK for a foreign plugin session');
      if (through > this.sentThrough) fail('ACK beyond the sent range');
      if (through < this.acked) fail('ACK regressed');
      if (through === this.acked) return undefined;
      this.acked = through; return through.toString();
    } catch (error) { this.closed = true; throw error; }
  }
}

/** Local-only mapping from the source monotonic clock to a client monotonic clock. Never a wire field. */
export interface ClockMapping {sourceClockId: string; clientClockId: string; offsetNs: string; uncertaintyNs: Uint64; measuredAtClientNs: Uint64}
export const CLOCK_REPLY_DEADLINE_NS = 1_000_000_000n;
/**
 * Computes `source ≈ client + offsetNs` from one probe round trip, with exact BigInt arithmetic.
 * t0/t3 are the client's probe send and reply receipt; t1/t2 are the source's receipt and reply send.
 * The offset is rounded down and the uncertainty rounded up, so the true offset lies within ±uncertaintyNs (≥ RTT/2).
 */
export function computeClockMapping(input: {reply: ServerMessage; probeId: Uint64; clientClockId: string; probeSentNs: Uint64; replyReceivedNs: Uint64}): ClockMapping {
  const reply = validateServerMessage(input.reply);
  if (reply.kind !== 'clock.reply' || reply.data.probeId !== input.probeId || !UUID.test(input.clientClockId)) fail('Clock reply mismatch');
  const t0 = uint(input.probeSentNs), t3 = uint(input.replyReceivedNs), t1 = BigInt(reply.data.receivedMonotonicNs), t2 = BigInt(reply.data.sentMonotonicNs);
  if (t3 < t0 || t3 - t0 > CLOCK_REPLY_DEADLINE_NS) fail('Clock reply outside the probe deadline');
  const rtt = (t3 - t0) - (t2 - t1); if (rtt < 0n) fail('Negative clock round trip');
  const sum = (t1 - t0) + (t2 - t3); let offset = sum / 2n; if (sum < 0n && sum % 2n !== 0n) offset -= 1n;
  return {sourceClockId: reply.capture.clockId, clientClockId: input.clientClockId, offsetNs: offset.toString(), uncertaintyNs: ((rtt + 1n) / 2n).toString(), measuredAtClientNs: t3.toString()};
}
/** A mapping is valid only while both clock identities are unchanged; a clockId change invalidates it. */
export function isClockMappingCurrent(mapping: ClockMapping, sourceClockId: string, clientClockId: string): boolean {
  return mapping.sourceClockId === sourceClockId && mapping.clientClockId === clientClockId;
}
