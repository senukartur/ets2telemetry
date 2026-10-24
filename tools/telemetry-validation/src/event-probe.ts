import {createHash} from 'node:crypto';
import {closeSync, fsyncSync, openSync, writeSync} from 'node:fs';
import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import {validateServerMessage, type ClientMessage, type ServerMessage} from '../../../packages/contracts/src/protocol-v1';
import {DurableAckCursor, V1Consumer} from '../../../packages/contracts/src/protocol-v1-delivery';
import {canonicalJson} from '../../../packages/telemetry-core/src/trips/identity';

export interface ProbeLog {append(record: unknown, durable: boolean): void}

/** Diagnostic evidence only. No database, trip recorder, application settings or history API. */
export class EvidenceLog implements ProbeLog {
  private readonly fd: number;
  private bytes = 0;
  private closed = false;
  constructor(file: string, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid evidence bound');
    this.fd = openSync(file, 'wx', 0o600);
  }
  append(record: unknown, durable: boolean): void {
    if (this.closed) throw new Error('Evidence already closed');
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > 128 * 1024 || this.bytes + bytes.length > this.maxBytes) throw new Error('Evidence byte bound reached');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(this.fd, bytes, written, bytes.length - written);
      if (!count) throw new Error('Evidence write made no progress');
      written += count;
    }
    this.bytes += bytes.length;
    if (durable) fsyncSync(this.fd);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {fsyncSync(this.fd);} finally {closeSync(this.fd);}
  }
}

function identity(source: SourceIdentity): string {
  return JSON.stringify([source.game, source.origin, source.processId, source.windowsSessionId, source.processInstanceId, source.pluginSessionId]);
}
interface Session {
  identity: string; cursor: DurableAckCursor; baseline: string;
  fingerprints: Map<string, string>; events: number; duplicates: number; gaps: number;
}

/** Validates a broker-authorized stream and fsyncs evidence BEFORE advancing/sending an ACK. */
export class EventProbe {
  private readonly sessions = new Map<string, Session>();
  private consumer?: V1Consumer;
  private authority?: SourceIdentity;
  private session?: Session;
  private snapshotAt?: bigint;
  private connection = 0;
  private ended = false;
  private failed = false;
  private acknowledge = true;
  readonly counts: Partial<Record<ServerMessage['kind'], number>> = {};
  constructor(private readonly log: ProbeLog) {}

  connect(authority: SourceIdentity): void {
    if (this.failed) throw new Error('Probe failed; no reconnection allowed');
    if (this.consumer) throw new Error('Previous connection must close first');
    if (authority.origin !== 'game') throw new Error('Native game authority required');
    if (++this.connection > 64) throw new Error('Connection bound reached');
    this.log.append({type: 'connection', connection: this.connection, authority}, true);
    this.authority = authority; this.consumer = new V1Consumer(true); this.session = undefined;
    this.ended = false; this.snapshotAt = undefined;
  }

  accept(input: unknown, nowNs: bigint): ClientMessage[] {
    try {
      if (this.failed || !this.consumer || !this.authority) throw new Error('No active authorized connection');
      const message = validateServerMessage(input);
      if (identity(message.source) !== identity(this.authority)) throw new Error('Broker/source identity mismatch');
      const applied = this.consumer.accept(message);
      if (message.kind === 'welcome' && !message.data.durableEvents) throw new Error('Event delivery was not granted');
      this.counts[message.kind] = (this.counts[message.kind] ?? 0) + 1;
      if (message.kind === 'snapshot') {
        // All snapshots are validated; only a diagnostic sample per second is saved.
        if (this.snapshotAt === undefined || nowNs - this.snapshotAt >= 1_000_000_000n) {
          this.log.append({type: 'server', connection: this.connection, receivedNs: nowNs.toString(), message}, false);
          this.snapshotAt = nowNs;
        }
      } else {
        this.log.append({type: 'server', connection: this.connection, receivedNs: nowNs.toString(), message}, true);
      }
      if (message.kind === 'checkpoint') {
        const key = message.source.pluginSessionId, boundary = message.data.status.delivery.ackedThroughEventSeq;
        let session = this.sessions.get(key);
        if (!session) {
          if (this.sessions.size >= 16) throw new Error('Plugin-session bound reached');
          // This is an explicitly recorded pre-existing producer boundary, not locally captured events.
          session = {identity: identity(message.source), cursor: new DurableAckCursor(key, boundary), baseline: boundary,
            fingerprints: new Map(), events: 0, duplicates: 0, gaps: 0};
          this.sessions.set(key, session);
        }
        if (session.identity !== identity(message.source)) throw new Error('Plugin-session identity changed');
        session.cursor.beginConnection(boundary); this.session = session;
      }
      if (applied.coverage) {
        const session = this.session;
        if (!session) throw new Error('Coverage before checkpoint');
        if (message.kind === 'event') {
          const digest = createHash('sha256').update(canonicalJson({occurred: message.data.occurred, record: message.data.record})).digest('hex');
          const prior = session.fingerprints.get(message.data.eventSeq);
          if (prior && prior !== digest) throw new Error('Redelivered event changed');
          if (!prior) {
            if (session.fingerprints.size >= 10000) throw new Error('Event-count bound reached');
            session.fingerprints.set(message.data.eventSeq, digest); session.events++;
          } else session.duplicates++;
        } else session.gaps++;
        // append(..., true) above must finish successfully before this commit or any ACK.
        session.cursor.received(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
        session.cursor.commit(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
        const ack = this.acknowledge ? session.cursor.ack() : undefined;
        if (ack) {this.log.append({type: 'send', connection: this.connection, message: ack}, true); return [ack];}
      }
      if (message.kind === 'end') this.ended = true;
      return [];
    } catch (error) {this.failed = true; throw error;}
  }

  expectClock(probeId: string): void {
    if (!this.consumer || this.failed) throw new Error('No active consumer');
    this.consumer.expectClockReply(probeId);
  }
  setAcknowledging(enabled: boolean): ClientMessage[] {
    this.log.append({type: 'ack-policy', enabled}, true); this.acknowledge = enabled;
    const ack = enabled && !this.failed ? this.session?.cursor.ack() : undefined;
    if (ack) {this.log.append({type: 'send', connection: this.connection, message: ack}, true); return [ack];}
    return [];
  }
  disconnect(reason: string): void {
    this.log.append({type: 'connection-closed', connection: this.connection, reason, endPacketObserved: this.ended}, true);
    this.consumer = undefined; this.authority = undefined; this.session = undefined;
  }
  summary() {
    return {connections: this.connection, failed: this.failed, counts: {...this.counts}, sessions: [...this.sessions.entries()].map(([pluginSessionId, s]) =>
      ({pluginSessionId, priorProducerAckBoundary: s.baseline, evidenceThrough: s.cursor.throughEventSeq, events: s.events, duplicates: s.duplicates, gapMessages: s.gaps}))};
  }
}
