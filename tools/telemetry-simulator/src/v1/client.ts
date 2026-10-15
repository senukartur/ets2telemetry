// Scripted protocol v1 contract client for the simulator (ET-005b). It is built only from the unchanged ET-002b helpers
// (FrameDecoder, V1Consumer, DurableAckCursor, computeClockMapping) plus an in-memory CommitLedger that stands in for the
// storage transaction (CD-6). It is a test client: it opens no database and writes no history.
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ClientMessage, type ProtocolMessage, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
import {DurableAckCursor, V1Consumer, computeClockMapping, type ClockMapping} from '../../../../packages/contracts/src/protocol-v1-delivery';

/**
 * `each` commits every item; `none` never commits; `failAt` crashes before committing the item that covers the eventSeq
 * (REG-006, before commit); `crashAfterCommit` commits that item, then crashes before its ACK (REG-006, after commit).
 */
export type CommitPolicy = {kind: 'each'} | {kind: 'none'} | {kind: 'failAt'; eventSeq: bigint} | {kind: 'crashAfterCommit'; eventSeq: bigint};
/** `each` delivers every cursor ACK; `withhold` never asks the cursor; `dropAfter` delivers the first n ACKs and loses the rest. */
export type AckPolicy = {kind: 'each'} | {kind: 'withhold'} | {kind: 'dropAfter'; count: number};
export interface ClientPolicy {durable: boolean; commit: CommitPolicy; ack: AckPolicy}

/**
 * In-memory stand-in for storage rows keyed UNIQUE(plugin_session_id, event_seq). Commits within one session form a
 * prefix, so a commit point plus the committed event contents suffice. A redelivered event must equal its committed row.
 */
export class CommitLedger {
  private sessions = new Map<string, {through: bigint; events: Map<bigint, string>}>();
  committedEvents = 0; committedGapMarkers = 0n; duplicates = 0;
  /** A synthetic pre-committed prefix, for scenarios that start a session above eventSeq 1. */
  seed(session: string, through: bigint): void { if (!this.sessions.has(session)) this.sessions.set(session, {through, events: new Map()}); }
  through(session: string): bigint { return this.sessions.get(session)?.through ?? 0n; }
  /** Commits one event or gap marker range; returns whether anything new was inserted. */
  commit(session: string, first: bigint, last: bigint, event?: ServerMessage): 'committed' | 'duplicate' {
    let s = this.sessions.get(session); if (!s) { s = {through: 0n, events: new Map()}; this.sessions.set(session, s); }
    if (event?.kind === 'event') {
      const row = JSON.stringify({occurred: event.data.occurred, record: event.data.record}), seq = BigInt(event.data.eventSeq), committed = s.events.get(seq);
      if (committed !== undefined && committed !== row) throw new Error(`Redelivered event ${seq} differs from its committed row`);
      if (seq > s.through) s.events.set(seq, row);
    }
    if (last <= s.through) { this.duplicates++; return 'duplicate'; }
    if (first > s.through + 1n) throw new Error('Non-contiguous commit');
    if (event) this.committedEvents++; else this.committedGapMarkers += last - s.through;
    s.through = last; return 'committed';
  }
}

export interface ClientOutput {messages: ClientMessage[]; frames: Uint8Array[]; crashed: boolean}
export interface MappingResult {probeId: string; mapping: ClockMapping | null}
/**
 * Called after each server message has been applied and its ACK, if any, queued. It may append frames to send next;
 * returning false stops processing the rest of the read (a stalled reader). Used by the pipe client for scripted actions.
 */
export type AfterMessage = (m: ServerMessage, frames: Uint8Array[]) => boolean;

/** One client connection: hello, decode and order every server message, commit coverage, then ACK by policy. */
export class ScriptedClient {
  private decoder = new FrameDecoder('server'); readonly consumer: V1Consumer; private cursor?: DurableAckCursor;
  private acksDelivered = 0; private probeSent?: {id: string; atNs: bigint};
  // The producer's accepted ACK point as far as this client knows it: the checkpoint's value or the last delivered ACK.
  private acceptedAck = 0n; private lastProbeId = 0n; private stopped = false;
  readonly mappings: MappingResult[] = []; readonly received: ServerMessage[] = [];
  /** `origin` is the one source origin this client accepts; the simulator never accepts `game` (CD-4). */
  constructor(private readonly ledger: CommitLedger, private readonly policy: ClientPolicy, readonly clientInstanceId: string, private readonly clientClockId: string,
    private readonly cursors: Map<string, DurableAckCursor>, private readonly origin: 'synthetic' | 'replay' = 'synthetic') {
    this.consumer = new V1Consumer(policy.durable);
  }
  /** What a live client fault needs to build its bytes (faults.ts). */
  faultContext(foreignSessionId: string) {
    const session = this.consumer.pluginSessionId; if (!session) throw new Error('A client fault needs a welcome');
    return {clientInstanceId: this.clientInstanceId, pluginSessionId: session, durable: this.consumer.durableEvents, acceptedAck: this.acceptedAck,
      nextEventSeq: BigInt(this.consumer.nextEventSeq), lastProbeId: this.lastProbeId, foreignSessionId};
  }
  /** The server closed the pipe: a partial frame left in the decoder is a violation. */
  end(): void { this.decoder.end(); }
  hello(): ClientOutput {
    return this.send([{version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: this.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: this.policy.durable}}]);
  }
  private send(messages: ClientMessage[], crashed = false): ClientOutput { return {messages, frames: messages.map(m => encodeFrame(m)), crashed}; }
  /** Registers one probe; the consumer allows at most one outstanding. */
  probe(probeId: string, clientNs: bigint): ClientOutput {
    this.consumer.expectClockReply(probeId); this.probeSent = {id: probeId, atNs: clientNs}; this.lastProbeId = BigInt(probeId);
    return this.send([{version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId}}]);
  }
  /**
   * Applies server frames synchronously: decode, V1Consumer, cursor receipt, commit policy, cursor commit and ACK.
   * `after` (the pipe client's scripted actions) may append frames after each message and stop the read; `frames`
   * then holds every byte unit in send order, while `messages` keeps only this client's own valid messages.
   */
  receive(frame: Uint8Array, clientNs: bigint | (() => bigint), after?: AfterMessage): ClientOutput {
    const out: ClientMessage[] = [], frames: Uint8Array[] = []; let crashed = false;
    const now = () => typeof clientNs === 'bigint' ? clientNs : clientNs();
    this.decoder.push(frame, m => {
      if (crashed || this.stopped) return;
      const ack = this.apply(m, now);
      if (ack === 'crash') { crashed = true; return; }
      if (ack) { out.push(ack); frames.push(encodeFrame(ack)); }
      if (after && !after(m as ServerMessage, frames)) this.stopped = true;
    });
    return {messages: out, frames, crashed};
  }
  /** One server message: the ACK to send, nothing, or a crash of the commit policy. */
  private apply(m: ProtocolMessage, now: () => bigint): ClientMessage | 'crash' | undefined {
    if (m.kind === 'hello' || m.kind === 'ack' || m.kind === 'clock.probe') throw new Error('Client message from server');
    // The simulator emits only synthetic or replay origins; a game origin is never accepted here (CD-4), and a client
    // accepts only the origin its scenario selected.
    if (m.source.origin !== this.origin) throw new Error(`Simulator client requires origin ${this.origin}`);
    const applied = this.consumer.accept(m); this.received.push(m);
    const session = m.source.pluginSessionId;
    if (m.kind === 'welcome' && this.policy.durable) {
      let cursor = this.cursors.get(session);
      if (!cursor) { cursor = new DurableAckCursor(session, this.ledger.through(session).toString()); this.cursors.set(session, cursor); }
      this.cursor = cursor;
    }
    if (m.kind === 'checkpoint') { this.acceptedAck = BigInt(m.data.status.delivery.ackedThroughEventSeq); this.cursor?.beginConnection(m.data.status.delivery.ackedThroughEventSeq); }
    if (m.kind === 'clock.reply' && this.probeSent) {
      this.mappings.push({probeId: this.probeSent.id, mapping: computeClockMapping({reply: m, probeId: this.probeSent.id, clientClockId: this.clientClockId,
        probeSentNs: this.probeSent.atNs.toString(), replyReceivedNs: now().toString()}) ?? null});
      this.probeSent = undefined;
    }
    if (!applied.coverage || !this.cursor) return undefined;
    const first = BigInt(applied.coverage.firstEventSeq), last = BigInt(applied.coverage.lastEventSeq), p = this.policy.commit;
    this.cursor.received(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
    const covers = (p.kind === 'failAt' || p.kind === 'crashAfterCommit') && first <= p.eventSeq && p.eventSeq <= last;
    if (p.kind === 'failAt' && covers) return 'crash';
    if (p.kind !== 'none') {
      this.ledger.commit(session, first, last, m.kind === 'event' ? m : undefined);
      this.cursor.commit(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
    }
    if (p.kind === 'crashAfterCommit' && covers) return 'crash';
    // The cursor may still acknowledge earlier commits once their range is received again (§10 consumer rule).
    const a = this.policy.ack; if (a.kind === 'withhold') return undefined;
    const ack = this.cursor.ack(); if (!ack) return undefined;
    // A dropped ACK left the client (the cursor counts it as sent) but never reaches the producer.
    if (a.kind === 'dropAfter' && this.acksDelivered >= a.count) return undefined;
    this.acksDelivered++; this.acceptedAck = BigInt(ack.data.throughEventSeq); return ack;
  }
}
