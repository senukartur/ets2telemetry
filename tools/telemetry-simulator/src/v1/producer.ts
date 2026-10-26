// Protocol v1 producer endpoint model (ET-005b): the transport worker of the native ET-004b plugin without pipe I/O.
// It drains the adapter's event channel into the event store in the documented caller sequence (steps 2-6 of
// docs/native-transport-v1.md#caller-sequence), answers one client at a time and builds every server message through the
// unchanged ET-002b encoder, AckValidator and FrameDecoder. Every time is an explicit source-clock argument.
import {
  FrameDecoder, PROTOCOL_V1, V1_LIMITS, decodePayload, encodeFrame, negotiateV1, ProtocolError,
  type Available, type DeliveryStatus, type EndData, type GapData, type ServerMessage, type SourceIdentity, type SourceStatus, type Uint64, type V1Minor
} from '../../../../packages/contracts/src/protocol-v1';
import {AckValidator} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {EventStore, wireCounts, type EndCursor, type GapRange, type LossCause, type Outbound, type StoreStatus, type StoredEvent} from './store';
import {type AdapterModel} from './source';

export interface Out {message: ServerMessage; frame: Uint8Array}
const U64_MAX = (2n ** 64n - 1n).toString();
const SNAPSHOT_INTERVAL_NS = BigInt(V1_LIMITS.snapshotIntervalMs) * 1_000_000n;
const RUN_ORDER: readonly LossCause[] = ['offline', 'noDurableConsumer', 'queueCount'];
const time = (ns: bigint | undefined): Available<Uint64> => ns === undefined ? {available: false, reason: 'not-observed'} : {available: true, value: ns.toString()};
const max = (...values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));

/**
 * Measures one event once with the worst-case envelope: the maximum `seq` and capture time and `redelivered: false`,
 * which is one byte longer than `true` (OD-5 S3). A record the contract rejects, or one over 16,384 bytes, is unsendable.
 */
export function measureEvent(source: SourceIdentity, captureClockId: string, e: StoredEvent): number | undefined {
  try {
    return encodeFrame({version: PROTOCOL_V1, kind: 'event', source, seq: U64_MAX, capture: {clockId: captureClockId, monotonicNs: U64_MAX},
      data: {eventSeq: e.eventSeq.toString(), redelivered: false, occurred: e.occurred, record: e.record}}).length - 4;
  } catch { return undefined; }
}

/** Wire `gap.data` of one store range (§9). */
export function gapData(r: GapRange, redelivered: boolean): GapData {
  return {firstEventSeq: r.first.toString(), lastEventSeq: r.last.toString(), causes: wireCounts(r.causes), firstLostMonotonicNs: time(r.firstLostNs), lastLostMonotonicNs: time(r.lastLostNs), redelivered};
}
/** Wire `end.data` from the store's end cursor (§9, OD-5 S5). */
export function endData(reason: EndData['reason'], e: EndCursor): EndData {
  return {reason, nextEventSeq: e.nextEventSeq.toString(), ackedThroughEventSeq: e.ackedThroughEventSeq.toString(), retainedUnacked: e.retainedUnacked.toString()};
}
/** Wire `status.delivery` from the store status (§7). */
export function deliveryStatus(s: StoreStatus, durable: boolean): DeliveryStatus {
  return {durable, ackedThroughEventSeq: s.ackedThroughEventSeq.toString(), nextEventSeq: s.nextEventSeq.toString(), retainedEvents: s.retainedEntries, retainedBytes: s.retainedBytes, oldestRetainedMonotonicNs: time(s.oldestRetainedNs)};
}

interface Connection {
  /** `minor` is the negotiated minor (ET-050b B1), 0 until the hello; the decoder exists from then on. */
  phase: 'hello' | 'live' | 'closed'; durable: boolean; minor: V1Minor; decoder?: FrameDecoder; validator?: AckValidator;
  /** The hello read so far, at most one 4,096-byte frame and its prefix. */
  helloBytes: Uint8Array;
  lastCapture: bigint; lastStateNs: bigint; pendingDueNs?: bigint; lastProbe: bigint;
  /** The highest eventSeq written on this connection; starts at the checkpoint's acknowledged point. */
  sentThrough: bigint;
}

/** The producer of one plugin session. Store misuse is an invariant violation and throws (the native retires the session). */
export class V1Producer {
  readonly store: EventStore;
  /** Set once the session has ended; later connections receive welcome then `end` in place of a checkpoint. */
  retired?: EndData['reason'];
  private seq = 0n; private coalesced = 0n; private conn?: Connection;
  constructor(readonly adapter: AdapterModel, readonly source: SourceIdentity, readonly captureClockId: string) {
    this.store = new EventStore(adapter.config.startEventSeq);
  }
  get connected(): boolean { return this.conn?.phase === 'live'; }
  /** A live durable connection's accepted ACK point and the highest eventSeq written to it; undefined otherwise. */
  ackState(): {acked: bigint; sent: bigint} | undefined {
    const c = this.conn; if (c?.phase !== 'live' || !c.durable) return undefined;
    return {acked: BigInt(c.validator!.ackedThroughEventSeq ?? '0'), sent: c.sentThrough};
  }
  /** A client opened the pipe. One client per endpoint; the caller refuses a second one. */
  open(): void {
    if (this.conn) throw new Error('A client is already connected');
    this.conn = {phase: 'hello', durable: false, minor: 0, helloBytes: new Uint8Array(0), sentThrough: 0n, lastCapture: 0n, lastStateNs: 0n, lastProbe: 0n};
  }
  /** The client is gone: the gate closes first, then a durable connection starts the store's retention window. */
  close(nowNs: bigint): void {
    const c = this.conn; if (!c) return;
    this.conn = undefined; this.adapter.channel.gate = 'none';
    if (c.durable && c.phase !== 'hello') this.store.disconnect(nowNs);
  }

  /** Step 3: drains the channel; each loss run is split by cause in a fixed order, then the copied record is ingested. */
  drain(nowNs: bigint): void {
    for (const slot of this.adapter.channel.drain()) {
      const run = slot.lossBefore;
      if (run) for (const cause of RUN_ORDER) {
        const n = run.counts[cause as keyof typeof run.counts]; if (!n) continue;
        const first = this.store.nextEventSeq;
        if (!this.store.lose(first, first + n - 1n, cause, run.firstNs, run.lastNs, nowNs)) throw new Error('Producer invariant violation: loss run');
      }
      if (slot.event) this.ingest({eventSeq: slot.event.eventSeq, occurred: slot.event.occurred, record: slot.event.record}, nowNs);
    }
  }
  private ingest(e: StoredEvent, nowNs: bigint): void {
    if (this.store.exhausted || !this.store.everConnectedDurably || e.eventSeq !== this.store.nextEventSeq) throw new Error('Producer invariant violation: event');
    const bytes = measureEvent(this.source, this.captureClockId, e);
    const m = e.occurred.monotonicNs, observed = m.available ? BigInt(m.value) : undefined;
    const ok = bytes === undefined ? this.store.lose(e.eventSeq, e.eventSeq, 'encodingFailed', observed, observed, nowNs) : this.store.admit(e, bytes, nowNs) !== 'rejected';
    if (!ok) throw new Error('Producer invariant violation: admission');
  }
  expire(nowNs: bigint): void { this.store.expire(nowNs); }
  /** Scheduled source-clock times: the pending snapshot and the retention expiry. */
  dueNs(): {snapshot?: bigint; expiry?: bigint} {
    return {snapshot: this.conn?.phase === 'live' ? this.conn.pendingDueNs : undefined, expiry: this.store.connected ? undefined : this.store.retentionDeadlineNs};
  }

  // Step 5: capture = max(now, last capture on the connection, every source-clock time the message carries).
  private envelope<K extends ServerMessage['kind']>(kind: K, data: Extract<ServerMessage, {kind: K}>['data'], nowNs: bigint, carried: (bigint | undefined)[] = []): Out {
    const c = this.conn!, capture = max(nowNs, c.lastCapture, ...carried.filter((t): t is bigint => t !== undefined));
    c.lastCapture = capture; this.seq++;
    // Every message of the connection carries its negotiated minor (B1).
    const message = {version: {major: 1, minor: c.minor}, kind, source: this.source, seq: this.seq.toString(), capture: {clockId: this.captureClockId, monotonicNs: capture.toString()}, data} as ServerMessage;
    return {message, frame: encodeFrame(message, {maxMinor: c.minor})};
  }
  private stateData(): {data: {state: Extract<ServerMessage, {kind: 'snapshot'}>['data']['state']; status: SourceStatus; continuity: {coalescedSnapshots: Uint64; offlineTransitions: Uint64}}; oldest?: bigint} {
    const s = this.store.status(), p = this.adapter.published;
    return {oldest: s.oldestRetainedNs, data: {
      // B1, ET-052: `state.gearbox` from minor 1 and `state.nextMandatoryBreak` exactly on a minor-2 connection; a lower
      // minor never carries the extra key.
      state: {...structuredClone(p.state), window: {available: false, reason: 'not-supported'}, ...(this.conn!.minor >= 1 ? {gearbox: structuredClone(p.gearbox)} : {}),
        ...(this.conn!.minor >= 2 ? {nextMandatoryBreak: structuredClone(p.nextMandatoryBreak)} : {})},
      status: {gameMode: this.adapter.gameMode, eventLoss: wireCounts(s.eventLoss), delivery: deliveryStatus(s, this.conn!.durable)},
      continuity: {coalescedSnapshots: this.coalesced.toString(), offlineTransitions: p.offlineTransitions.toString()}
    }};
  }
  private outbound(o: Outbound, nowNs: bigint): Out {
    if (!o.gap) {
      const m = o.event.occurred.monotonicNs;
      return this.envelope('event', {eventSeq: o.event.eventSeq.toString(), redelivered: o.redelivered, occurred: o.event.occurred, record: o.event.record}, nowNs, [m.available ? BigInt(m.value) : undefined]);
    }
    return this.envelope('gap', gapData(o.range, o.redelivered), nowNs, [o.range.firstLostNs, o.range.lastLostNs]);
  }
  private end(reason: EndData['reason'], nowNs: bigint): Out | undefined {
    this.retired = reason;
    if (!this.conn || this.conn.phase === 'closed') return undefined;
    const out = this.envelope('end', endData(reason, this.store.endCursor()), nowNs);
    this.conn.phase = 'closed'; return out;
  }

  /**
   * Client bytes that arrived together, as one read. Steps 2 and 6: the hello is read as the native endpoint reads it
   * (the 4,096-byte bound at the prefix, a byte beyond the hello in the same read rejected, any other first message
   * rejected, OD-5 S6); afterwards only `ack` (through AckValidator, then release) and `clock.probe`. A violation throws
   * ProtocolError before anything of this read is written; the caller then closes the connection without an error frame.
   */
  receive(bytes: Uint8Array, nowNs: bigint): Out[] {
    const c = this.conn; if (!c || c.phase === 'closed') throw new Error('No open connection');
    if (c.phase === 'hello') return this.hello(c, bytes, nowNs);
    const out: Out[] = []; let probe: {id: string} | undefined;
    c.decoder!.push(bytes, m => {
      if (m.kind === 'ack') {
        const through = c.validator!.accept(m);
        if (through !== undefined && this.store.release(BigInt(through)) === undefined) throw new Error('Producer invariant violation: release');
      } else if (m.kind === 'clock.probe') {
        // AckValidator.probe requires the checkpoint and the connection's minor (B1), as the native endpoint does. OD-5
        // S6: probe IDs strictly increase, and no probe may arrive while the reply to the previous one is unsent.
        const probeId = c.validator!.probe(m), id = BigInt(probeId); if (id <= c.lastProbe || probe) throw new ProtocolError('Clock probe order');
        c.lastProbe = id; probe = {id: probeId};
      } else throw new ProtocolError('Only ack and clock.probe follow the checkpoint');
    });
    // The reply is built after the whole read was accepted, so a rejected read consumes no message seq.
    if (probe) out.push(this.envelope('clock.reply', {probeId: probe.id, receivedMonotonicNs: nowNs.toString(), sentMonotonicNs: nowNs.toString()}, nowNs));
    return out;
  }
  private hello(c: Connection, bytes: Uint8Array, nowNs: bigint): Out[] {
    const buffer = new Uint8Array(c.helloBytes.length + bytes.length); buffer.set(c.helloBytes); buffer.set(bytes, c.helloBytes.length); c.helloBytes = buffer;
    if (buffer.length < 4) return [];
    const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, true);
    if (!length || length > V1_LIMITS.clientFrameBytes) throw new ProtocolError('Client frame size rejected');
    if (buffer.length > length + 4) throw new ProtocolError('Client bytes beyond the hello before the checkpoint');
    if (buffer.length < length + 4) return [];
    // Another major, another envelope minor or any other kind closes the connection without an error frame (§2).
    const m = decodePayload(buffer.subarray(4), 'client'); c.helloBytes = new Uint8Array(0);
    if (m.kind !== 'hello') throw new ProtocolError('Hello expected');
    // B1, ET-052: the simulator selects min(hello maxMinor, its highest minor); a hello offering only minor 0 or 1, or a
    // simulated older plugin (`highestMinor`), gets the original minor-0 or minor-1 bytes. The default highest minor is the
    // literal 2, not V1_MAX_MINOR, so a future contract minor is never served before the simulator models it.
    const negotiated = negotiateV1(m, {allowDurable: true, maxMinor: this.adapter.config.highestMinor ?? 2});
    c.durable = negotiated.durableEvents; c.minor = negotiated.minor; c.phase = 'live';
    // Client frames after the hello carry the connection's minor; the decoder and the validator refuse any other.
    c.decoder = new FrameDecoder('client', {maxMinor: c.minor});
    const out: Out[] = [this.envelope('welcome', {minor: c.minor, durableEvents: c.durable, limits: {...V1_LIMITS}, capabilities: {gameplayEvents: this.adapter.config.gameplayEvents, eventTypes: this.adapter.eventTypes()},
      versions: structuredClone(this.adapter.config.versions), gameMode: this.adapter.gameMode}, nowNs)];
    c.validator = new AckValidator(this.source.pluginSessionId, c.durable, c.minor);
    if (this.retired) { out.push(this.end(this.retired, nowNs)!); return out; }
    // Connect the store before the gate opens, so that every record copied for this consumer is retained.
    if (c.durable) this.store.connect();
    this.adapter.channel.gate = c.durable ? 'durable' : 'live';
    const {data, oldest} = this.stateData();
    out.push(this.envelope('checkpoint', {boundarySeq: (this.seq + 1n).toString(), ...data}, nowNs, [oldest]));
    c.validator.checkpoint(data.status.delivery.ackedThroughEventSeq); c.sentThrough = BigInt(data.status.delivery.ackedThroughEventSeq); c.lastStateNs = BigInt(out.at(-1)!.message.capture.monotonicNs);
    return out;
  }
  /** Fault-injection control: the next written message skips one `seq`, which a consumer accepts (§5). */
  skipSeq(): void { this.seq++; }

  /** Step 5: the next coverage item for a durable consumer, or `end` once the sequence is exhausted. */
  pump(nowNs: bigint): Out | undefined {
    if (this.retired) return undefined;
    const c = this.conn;
    if (c?.phase === 'live' && c.durable) {
      const item = this.store.nextOutbound();
      if (item) {
        const out = this.outbound(item, nowNs), last = item.gap ? item.range.last : item.event.eventSeq;
        c.validator!.sent(last.toString()); if (last > c.sentThrough) c.sentThrough = last; return out;
      }
    }
    return this.store.exhausted ? this.end('sequence-exhausted', nowNs) : undefined;
  }
  /** A new state slot was published: send it now, or keep one replaceable unsent snapshot at most every 50 ms. */
  publication(nowNs: bigint): Out | undefined {
    const c = this.conn; if (c?.phase !== 'live') return undefined;
    const due = c.lastStateNs + SNAPSHOT_INTERVAL_NS;
    if (c.pendingDueNs !== undefined) this.coalesced++;
    if (nowNs < due) { c.pendingDueNs = due; return undefined; }
    return this.snapshot(nowNs);
  }
  /** The pending snapshot's interval has elapsed. */
  fireSnapshot(nowNs: bigint): Out | undefined { return this.conn?.phase === 'live' && this.conn.pendingDueNs !== undefined ? this.snapshot(nowNs) : undefined; }
  private snapshot(nowNs: bigint): Out {
    const c = this.conn!, {data, oldest} = this.stateData();
    const out = this.envelope('snapshot', data, nowNs, [oldest]); c.pendingDueNs = undefined; c.lastStateNs = BigInt(out.message.capture.monotonicNs); return out;
  }
  /** Shutdown or retirement: a best-effort `end` (D14); a loss run still open is plugin-exit loss without a gap (S11). */
  shutdown(reason: 'plugin-shutdown' | 'source-retired', nowNs: bigint): Out | undefined { return this.retired ? undefined : this.end(reason, nowNs); }
}
