// Scripted protocol v1 contract client for the simulator (ET-005b). It is built only from the unchanged ET-002b helpers
// (FrameDecoder, V1Consumer, DurableAckCursor, computeClockMapping) plus an in-memory CommitLedger that stands in for the
// storage transaction (CD-6). It is a test client: it opens no database and writes no history.
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ClientMessage, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
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

/** One client connection: hello, decode and order every server message, commit coverage, then ACK by policy. */
export class ScriptedClient {
  private decoder = new FrameDecoder('server'); readonly consumer: V1Consumer; private cursor?: DurableAckCursor;
  private acksDelivered = 0; private probeSent?: {id: string; atNs: bigint};
  readonly mappings: MappingResult[] = []; readonly received: ServerMessage[] = [];
  constructor(private readonly ledger: CommitLedger, private readonly policy: ClientPolicy, readonly clientInstanceId: string, private readonly clientClockId: string,
    private readonly cursors: Map<string, DurableAckCursor>) {
    this.consumer = new V1Consumer(policy.durable);
  }
  hello(): ClientOutput {
    return this.send([{version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: this.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: this.policy.durable}}]);
  }
  private send(messages: ClientMessage[], crashed = false): ClientOutput { return {messages, frames: messages.map(m => encodeFrame(m)), crashed}; }
  /** Registers one probe; the consumer allows at most one outstanding. */
  probe(probeId: string, clientNs: bigint): ClientOutput {
    this.consumer.expectClockReply(probeId); this.probeSent = {id: probeId, atNs: clientNs};
    return this.send([{version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId}}]);
  }
  /** Applies server frames synchronously: decode, V1Consumer, cursor receipt, commit policy, cursor commit and ACK. */
  receive(frame: Uint8Array, clientNs: bigint): ClientOutput {
    const out: ClientMessage[] = []; let crashed = false;
    this.decoder.push(frame, m => {
      if (crashed) return;
      if (m.kind === 'hello' || m.kind === 'ack' || m.kind === 'clock.probe') throw new Error('Client message from server');
      // The simulator emits only synthetic or replay origins; a game origin is never accepted here (CD-4).
      if (m.source.origin === 'game') throw new Error('Simulator client requires a synthetic or replay source');
      const applied = this.consumer.accept(m); this.received.push(m);
      const session = m.source.pluginSessionId;
      if (m.kind === 'welcome' && this.policy.durable) {
        let cursor = this.cursors.get(session);
        if (!cursor) { cursor = new DurableAckCursor(session, this.ledger.through(session).toString()); this.cursors.set(session, cursor); }
        this.cursor = cursor;
      }
      if (m.kind === 'checkpoint' && this.cursor) this.cursor.beginConnection(m.data.status.delivery.ackedThroughEventSeq);
      if (m.kind === 'clock.reply' && this.probeSent) {
        this.mappings.push({probeId: this.probeSent.id, mapping: computeClockMapping({reply: m, probeId: this.probeSent.id, clientClockId: this.clientClockId,
          probeSentNs: this.probeSent.atNs.toString(), replyReceivedNs: clientNs.toString()}) ?? null});
        this.probeSent = undefined;
      }
      if (!applied.coverage || !this.cursor) return;
      const first = BigInt(applied.coverage.firstEventSeq), last = BigInt(applied.coverage.lastEventSeq), p = this.policy.commit;
      this.cursor.received(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
      const covers = (p.kind === 'failAt' || p.kind === 'crashAfterCommit') && first <= p.eventSeq && p.eventSeq <= last;
      if (p.kind === 'failAt' && covers) { crashed = true; return; }
      if (p.kind !== 'none') {
        this.ledger.commit(session, first, last, m.kind === 'event' ? m : undefined);
        this.cursor.commit(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
      }
      if (p.kind === 'crashAfterCommit' && covers) { crashed = true; return; }
      // The cursor may still acknowledge earlier commits once their range is received again (§10 consumer rule).
      const a = this.policy.ack; if (a.kind === 'withhold') return;
      const ack = this.cursor.ack(); if (!ack) return;
      // A dropped ACK left the client (the cursor counts it as sent) but never reaches the producer.
      if (a.kind === 'dropAfter' && this.acksDelivered >= a.count) return;
      this.acksDelivered++; out.push(ack);
    });
    return this.send(out, crashed);
  }
}
