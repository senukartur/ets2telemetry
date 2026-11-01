// Serves the protocol v1 simulator on a real Windows named pipe in REACTIVE mode (ET-005b), for any consumer of the
// production transport contract, such as the desktop telemetry service (ET-006b).
//
// The server drives the adapter model and the producer through the scenario's source steps in scenario time (paced in
// real time while a client is connected, fast-forwarded offline) and reacts to whatever the connected client actually
// sends: any valid hello whose durability matches the scripted connection, ACKs through AckValidator as they arrive,
// clock probes, EOF. At a scripted disconnect it waits a bounded time for the client to acknowledge what was written,
// then closes. It compares nothing itself; `reactiveDifferences` compares its transcript with `replay-v1` as plan item 7
// claims: events, gaps, checkpoints and `end` byte-identical except the message `seq` (a client's own clock probes add
// replies), snapshots equal in state and continuity. Client faults, wire faults and stalls script a client and exist
// only in lockstep mode (pipe.ts). ET-019 PR-12a adds a soak mode for long generated timelines with bounded memory
// (ReactiveSoakOptions, soak.ts); without it nothing here changes.
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {FrameDecoder, GAP_RECORD_BYTES, ProtocolError, V1_LIMITS, V1_MAX_MINOR, type ProtocolMessage, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type ClientPolicy} from './client';
import {Cancelled, Link, PipeHost, REPLY_DEADLINE_MS, TEST_PIPE_PATTERN_V1, bounded} from './pipe-host';
import {V1Producer, type Out} from './producer';
import {timeline, validateScenario, type Scenario, type SourceStep, type TimelineEntry} from './scenario';
import {AdapterModel, ScenarioClock, seededId} from './source';
import {MAX_TRANSCRIPT_MESSAGES, V1Driver, scenarioSource, type ReplayResult, type TranscriptLine} from './replay';

export interface ReactiveServeOptions {
  /** Real milliseconds per scenario millisecond while a client is connected (0 to 10, default 1). */
  scale?: number;
  /** The hello deadline from accepting a connection: 1 to 5,000 ms, default 5,000 (§4). */
  helloTimeoutMs?: number;
  /** The server's write deadline: 1 to 1,000 ms, default 1,000 (§9). */
  writeDeadlineMs?: number;
  /** How long a scripted disconnect waits for the client to acknowledge what was written: 0 to 5,000 ms, default 1,000. */
  quiesceMs?: number;
  /**
   * For a consumer that follows the script (default false). A connection whose scripted client commits and acknowledges
   * every item (`ack: each`, any commit policy but `none`) is then waited for at each quiesce point until it has
   * acknowledged everything written to it or has left. A `dropAfter:n` policy waits the same way until its first n
   * ACKs arrive; its intentionally dropped tail and other connections keep the `quiesceMs` bound. Missing a promised
   * ACK within `settleTimeoutMs` fails the run instead of pacing on.
   */
  awaitScriptedAcks?: boolean;
  /** Liveness bound of an `awaitScriptedAcks` wait: 1 to 600,000 ms, default 30,000. */
  settleTimeoutMs?: number;
  /** How long a scripted connect waits for a client: 1 to 600,000 ms, default 30,000. */
  connectTimeoutMs?: number;
  /** Soak mode (ET-019 PR-12a, soak.ts); see ReactiveSoakOptions. Off by default. */
  soak?: ReactiveSoakOptions;
  signal?: AbortSignal;
}
/**
 * Soak mode serves a generated timeline instead of the scenario's steps, for runs far beyond the scenario bounds
 * (MAX_STEPS, MAX_TRANSCRIPT_MESSAGES). Memory stays bounded: the entries are read one at a time and dropped, no transcript
 * is kept, only counters (`SoakStatus`). `reactiveConflicts` is not run over the generated timeline; a test runs it on a
 * reduced-frame cycle. A live-only hello for a durable scripted connection ends that attempt and is counted
 * (`refusedLiveOnly`) instead of failing the run, as the desktop service sends one while its storage opens (R10).
 */
export interface ReactiveSoakOptions {
  /** Time-ordered entries, each already checked by the per-step validators; the scenario's own steps must be empty. */
  entries: Iterable<TimelineEntry>;
}
/** The counters of a soak run; eventSeqs are decimal strings, `0` before the first. */
export interface SoakStatus {
  scenarioMs: number; lastEventSeq: string; maxAckThroughEventSeq: string; ackCount: number; snapshots: number; connections: number; refusedLiveOnly: number;
  /** Written messages by kind, server and client direction. */
  messages: {server: Record<string, number>; client: Record<string, number>};
}
export type ReactiveClosedBy = 'disconnect' | 'client' | 'end' | 'serverRejected' | 'writeDeadline' | 'open';
export interface ReactiveConnection {connection: number; durable: boolean; clientInstanceId: string; closedBy: ReactiveClosedBy; rejectedAttempts: number}
/** In soak mode `transcript` stays empty and `soak` carries the counters. */
export interface ReactiveReport {scenario: Scenario; transcript: TranscriptLine[]; connections: ReactiveConnection[]; refusedClients: number; cancelled: boolean; soak?: SoakStatus}
/** `status` reads the counters of a soak run while it is served; it exists only in soak mode. */
export interface ReactivePipeServer {endpoint: string; done: Promise<ReactiveReport>; stop: () => Promise<void>; status?: () => SoakStatus}

class Reactive extends PipeHost {
  readonly scenario: Scenario; private readonly clock = new ScenarioClock(); private readonly producer: V1Producer;
  private readonly transcript: TranscriptLine[] = []; private readonly connections: ReactiveConnection[] = [];
  private pending: Link[] = []; private live?: {link: Link; record: ReactiveConnection; policy: ClientPolicy; recorder: FrameDecoder; helloDone: boolean; endWritten: boolean; acknowledgements: number};
  // `unsettled`: an event or gap was written since the last quiesce, so a client reaction (ACK, crash) may be pending.
  private unsettled = false;
  private refused = 0; private atMs = 0; private target = 0; private segment?: {realMs: number; atMs: number};
  private readonly scale: number; private readonly helloMs: number; private readonly writeMs: number; private readonly quiesceMs: number; private readonly connectMs: number;
  private readonly awaitScriptedAcks: boolean; private readonly settleMs: number;
  // Soak mode only: the generated entries and the counters that replace the transcript.
  private readonly soak?: ReactiveSoakOptions;
  private readonly counts = {server: {} as Record<string, number>, client: {} as Record<string, number>};
  private lastEventSeq = 0n; private maxAck = 0n; private refusedLiveOnly = 0;
  /** The client instance of the latest hello, which the welcome that answers it records. */
  private lastHelloInstance = '';
  constructor(input: unknown, options: ReactiveServeOptions) {
    super();
    const s = this.scenario = validateScenario(input);
    if (options.soak !== undefined) {
      if (!options.soak || typeof options.soak.entries?.[Symbol.iterator] !== 'function') throw new Error('Invalid soak entries');
      if (s.steps.length || s.transport.length) throw new Error('A soak run takes its steps from the generated entries only');
      this.soak = options.soak;
    }
    const scripted = s.transport.find(t => t.action === 'clientFault' || t.action === 'wireFault' || t.action === 'writeDeadline');
    if (scripted) throw new Error(`Reactive serving cannot run ${scripted.action} steps, which script the client; use lockstep mode`);
    // A soak timeline is checked on a reduced-frame cycle by its test instead (ReactiveSoakOptions).
    const conflicts = this.soak ? [] : reactiveConflicts(input);
    if (conflicts.length) throw new Error(`Reactive serving cannot reproduce this scenario; use lockstep mode: ${conflicts.join('; ')}`);
    this.producer = new V1Producer(new AdapterModel({game: s.game, seed: s.seed, ...s.source}, this.clock), scenarioSource(s), seededId(s.seed, 'capture-clock'));
    this.scale = bounded(options.scale, 1, 0, 10, 'scale', false);
    this.helloMs = bounded(options.helloTimeoutMs, V1_LIMITS.helloTimeoutMs, 1, V1_LIMITS.helloTimeoutMs, 'hello timeout');
    this.writeMs = bounded(options.writeDeadlineMs, V1_LIMITS.writeDeadlineMs, 1, V1_LIMITS.writeDeadlineMs, 'write deadline');
    this.quiesceMs = bounded(options.quiesceMs, 1_000, 0, 5_000, 'quiesce bound');
    this.connectMs = bounded(options.connectTimeoutMs, 30_000, 1, 600_000, 'connect timeout');
    if (options.awaitScriptedAcks !== undefined && typeof options.awaitScriptedAcks !== 'boolean') throw new Error('Invalid scripted ACK wait');
    this.awaitScriptedAcks = options.awaitScriptedAcks ?? false;
    this.settleMs = bounded(options.settleTimeoutMs, 30_000, 1, 600_000, 'settle timeout');
  }
  private ns(atMs: number): bigint { return this.clock.sourceNs(atMs); }
  /** The scenario time a paced segment has reached: between the last action and the one it is waiting for. */
  private progressAtMs(): number {
    if (!this.segment || this.scale === 0) return this.atMs;
    return Math.floor(Math.min(this.target, Math.max(this.atMs, this.segment.atMs + (performance.now() - this.segment.realMs) / this.scale)));
  }
  private line(atMs: number, direction: 'server' | 'client', message: ProtocolMessage): void {
    if (direction === 'client' && message.kind === 'hello') this.lastHelloInstance = message.data.clientInstanceId;
    if (this.soak) { this.count(direction, message); return; }
    if (this.transcript.length >= MAX_TRANSCRIPT_MESSAGES) throw new Error('Simulator transcript limit exceeded');
    this.transcript.push({scenario: this.scenario.id, origin: this.scenario.origin, connection: this.live?.record.connection ?? 0, atMs, direction, message});
  }
  /** Soak mode: counters in place of the transcript line, so nothing grows with the number of messages. */
  private count(direction: 'server' | 'client', message: ProtocolMessage): void {
    const kinds = this.counts[direction]; kinds[message.kind] = (kinds[message.kind] ?? 0) + 1;
    if (message.kind === 'event' && BigInt(message.data.eventSeq) > this.lastEventSeq) this.lastEventSeq = BigInt(message.data.eventSeq);
    if (message.kind === 'gap' && BigInt(message.data.lastEventSeq) > this.lastEventSeq) this.lastEventSeq = BigInt(message.data.lastEventSeq);
    if (message.kind === 'ack' && BigInt(message.data.throughEventSeq) > this.maxAck) this.maxAck = BigInt(message.data.throughEventSeq);
  }
  /** The counters of a soak run (SoakStatus). */
  soakStatus(): SoakStatus {
    return {scenarioMs: this.progressAtMs(), lastEventSeq: this.lastEventSeq.toString(), maxAckThroughEventSeq: this.maxAck.toString(), ackCount: this.counts.client.ack ?? 0,
      snapshots: this.counts.server.snapshot ?? 0, connections: this.connections.length, refusedLiveOnly: this.refusedLiveOnly,
      messages: {server: {...this.counts.server}, client: {...this.counts.client}}};
  }

  // One client at a time: a client arriving while another is connected is refused at once, never displacing it (§4).
  protected connection(link: Link): void {
    if (this.live && !this.live.link.gone) { link.socket.destroy(); this.refused++; return; }
    this.pending.push(link);
  }
  private write(out: Out, atMs: number): void {
    const l = this.live; if (!l) throw new Error('Server message without a client');
    this.line(atMs, 'server', out.message); l.link.write(out.frame, () => this.changed());
    if (out.message.kind === 'end') l.endWritten = true;
    if (out.message.kind === 'event' || out.message.kind === 'gap') this.unsettled = true;
  }
  private closeLive(closedBy: ReactiveClosedBy, graceful: boolean): void {
    const l = this.live; if (!l) return;
    // The replay closes at the action that caused the closure; the server is still at that action until it paces on.
    this.producer.close(this.ns(this.atMs));
    l.record.closedBy = closedBy; this.live = undefined; this.segment = undefined;
    if (graceful) l.link.socket.end(); else l.link.socket.destroy();
  }
  /** Client bytes as they arrive, one read at a time, exactly as the native endpoint receives them. */
  private receive(chunk: Buffer): void {
    try { this.read(chunk); }
    // A model defect fails the run visibly instead of escaping from a socket callback.
    catch (error) { this.failure ??= error instanceof Error ? error : new Error('Reactive server failed'); this.changed(); }
  }
  private read(chunk: Buffer): void {
    const l = this.live; if (!l) return;
    // After `end` the connection only drains toward its close; like the native endpoint, nothing more is read from it.
    if (l.endWritten) return;
    // The hello is handled at the connect step's own time; afterwards a reply carries the paced segment's progress.
    const at = l.helloDone ? this.progressAtMs() : this.atMs;
    let outs: Out[];
    try { outs = this.producer.receive(chunk, this.ns(at)); }
    catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // A rejected client ends only its connection, without an error frame. Before its hello the scenario's connection
      // is still waiting for a valid client.
      if (!l.helloDone) { l.record.rejectedAttempts++; this.live = undefined; l.link.socket.destroy(); return; }
      this.closeLive('serverRejected', false); return;
    }
    l.recorder.push(chunk, m => { if (m.kind === 'ack') l.acknowledgements++; this.line(at, 'client', m); });
    for (const out of outs) {
      if (out.message.kind === 'welcome') {
        // Soak mode: a live-only hello for a durable connection ends only that attempt, before anything is written; the
        // accept loop then closes the producer's connection and waits for the next client (ReactiveSoakOptions).
        if (this.soak && l.record.durable && !out.message.data.durableEvents) { this.refusedLiveOnly++; this.live = undefined; l.link.socket.destroy(); return; }
        l.helloDone = true;
        if (out.message.data.durableEvents !== l.record.durable) this.failure ??= new Error(`Connection ${l.record.connection} expects a ${l.record.durable ? 'durable' : 'live-only'} client`);
        l.record.clientInstanceId = this.lastHelloInstance;
        this.segment = {realMs: performance.now(), atMs: this.atMs};
      }
      this.write(out, at);
    }
  }
  private pumpAll(atMs: number): void { for (let out = this.producer.pump(this.ns(atMs)); out; out = this.producer.pump(this.ns(atMs))) this.write(out, atMs); }
  /**
   * Drain and write. Once the eventSeq space is exhausted, each further write first lets the client acknowledge what it
   * received, so the `end` that follows carries the same release point as in the replay. Until then nothing awaits, so no
   * ACK can be read between the writes of one step, as in the replay.
   */
  private async settle(atMs: number): Promise<void> {
    this.producer.drain(this.ns(atMs));
    for (;;) {
      if (this.producer.store.exhausted && this.live?.helloDone) await this.quiesce();
      const out = this.producer.pump(this.ns(atMs)); if (!out) return;
      this.write(out, atMs);
    }
  }
  private async apply(step: SourceStep): Promise<void> {
    const at = step.atMs, adapter = this.producer.adapter;
    switch (step.action) {
      case 'capture': { adapter.capture(step, at); await this.settle(at); const out = this.producer.publication(this.ns(at)); if (out) this.write(out, at); break; }
      case 'configuration': case 'gameplay': for (let i = 0; i < step.repeat; i++) { adapter[step.action](step.id, step.attributes, step.list, at); await this.settle(at); } break;
      case 'lifecycle': adapter.lifecycle(step.event, at); await this.settle(at); break;
      case 'frame': { adapter.frame(step.timerRestart, step.channels, at); await this.settle(at); const out = this.producer.publication(this.ns(at)); if (out) this.write(out, at); break; }
      case 'gameMode': adapter.determineGameMode(step.mode, at); await this.settle(at); break;
      case 'encodingFailure': for (let i = 0; i < step.count; i++) { adapter.unencodable(1, at); await this.settle(at); } break;
      case 'handoff': adapter.channel.full = step.full; break;
      case 'utcJump': this.clock.utcJump(step.deltaMs); break;
      case 'suspend': this.clock.suspend(at, step.durationMs, step.sourceClockAdvances); break;
      case 'shutdown': {
        // `end` carries the release point, so the client may first acknowledge what it received (bounded), as at a disconnect.
        await this.settle(at); if (this.live?.helloDone) await this.quiesce();
        const out = this.producer.shutdown(step.reason, this.ns(at)); if (out && this.live) this.write(out, at); break; }
    }
  }
  private async pace(atMs: number): Promise<void> {
    this.target = atMs;
    if (this.segment && this.scale > 0) {
      const delay = this.segment.realMs + (atMs - this.segment.atMs) * this.scale - performance.now();
      if (delay > 0) await this.wait(() => false, delay);
    }
    this.atMs = atMs;
  }
  /** End of an action: writes complete within the write deadline, else the connection ends; `end` closes it. */
  private async flush(): Promise<void> {
    const l = this.live; if (!l) return;
    const done = await this.wait(() => l.link.pendingWrites === 0 || l.link.writeError !== undefined || l.link.closed, this.writeMs);
    if (this.live !== l) return;
    if (!done) this.closeLive('writeDeadline', false);
    else if (l.endWritten) this.closeLive('end', true);
  }
  private async fireTimers(untilMs: number): Promise<void> {
    for (;;) {
      const due = this.producer.dueNs(), expiryAt = due.expiry === undefined ? Infinity : this.clock.atMsFor(due.expiry), snapshotAt = due.snapshot === undefined ? Infinity : this.clock.atMsFor(due.snapshot);
      const at = Math.min(expiryAt, snapshotAt); if (at > untilMs) return;
      await this.pace(at);
      if (expiryAt === at) this.producer.expire(this.ns(at));
      else { const out = this.producer.fireSnapshot(this.ns(at)); if (out) this.write(out, at); await this.flush(); await this.quiesce(); }
    }
  }
  /** A scripted connect: the next client with a valid hello, any client instance, within the connect timeout. */
  private async accept(connection: number, policy: ClientPolicy): Promise<void> {
    const record: ReactiveConnection = {connection, durable: policy.durable, clientInstanceId: '', closedBy: 'open', rejectedAttempts: 0};
    this.connections.push(record);
    const deadline = performance.now() + this.connectMs;
    while (!this.live?.helloDone) {
      if (!await this.wait(() => this.pending.length > 0, Math.max(0, deadline - performance.now()))) throw new Error(`No client completed a hello for connection ${connection}`);
      const link = this.pending.shift()!; if (link.gone) continue;
      const l = this.live = {link, record, policy, recorder: new FrameDecoder('client', {maxMinor: V1_MAX_MINOR}), helloDone: false, endWritten: false, acknowledgements: 0};
      this.producer.open();
      const buffered = link.inbound; link.inbound = Buffer.alloc(0); link.onData = chunk => { if (this.live?.link === link) this.receive(chunk); };
      if (buffered.length) this.receive(buffered);
      if (this.live === l && !l.helloDone) {
        const ok = await this.wait(() => l.helloDone || link.gone || this.live !== l, this.helloMs);
        // A missing, late or rejected hello ends only that attempt (§4); the connection waits for the next client.
        if (this.live === l && !l.helloDone) { if (!ok || link.gone) record.rejectedAttempts++; this.producer.close(this.ns(this.atMs)); this.live = undefined; link.socket.destroy(); }
      }
      if (this.live !== l) { this.producer.close(this.ns(this.atMs)); continue; }
    }
    this.pumpAll(this.atMs);
  }
  /**
   * Waits up to the quiesce bound until the live client has acknowledged everything written to it, or has left. With
   * `awaitScriptedAcks`, promised ACKs (including a dropAfter prefix) use the liveness bound instead. The intentionally
   * dropped tail remains bounded, so a missing ACK in that tail never prevents the scripted disconnect.
   */
  private async quiesce(): Promise<void> {
    const l = this.live; if (!l || !this.unsettled) return;
    this.unsettled = false;
    const settled = () => this.live !== l || l.link.gone || ((s => s === undefined || s.acked >= s.sent)(this.producer.ackState()));
    const prefix = l.policy.ack.kind === 'dropAfter' ? l.policy.ack.count : Infinity;
    if (!this.awaitScriptedAcks || !l.policy.durable || l.policy.ack.kind === 'withhold' || l.policy.commit.kind === 'none' || l.acknowledgements >= prefix) { await this.wait(settled, this.quiesceMs); return; }
    if (!await this.wait(() => settled() || l.acknowledgements >= prefix, this.settleMs)) throw new Error(`Connection ${l.record.connection}: the client neither acknowledged everything written to it nor left within ${this.settleMs} ms`);
    if (!settled()) await this.wait(settled, this.quiesceMs);
  }
  /** A scripted disconnect: wait (see quiesce) for the ACKs of everything written, then a graceful close. */
  private async disconnect(): Promise<void> {
    const l = this.live; if (!l) return;
    await this.quiesce();
    if (this.live === l) this.closeLive('disconnect', true);
  }
  private clientGone(): void { const l = this.live; if (l?.helloDone && l.link.gone) this.closeLive('client', false); }
  protected changed(): void { this.clientGone(); super.changed(); }

  async run(): Promise<ReactiveReport> {
    // A soak run reads its generated entries one at a time; nothing keeps them (ReactiveSoakOptions).
    const entries: Iterable<TimelineEntry> = this.soak ? this.soak.entries : timeline(this.scenario.steps, this.scenario.transport).filter(e => e.lane !== 'probe');
    let lastAtMs: number | undefined;
    try {
      for (const e of entries) {
        if (e.lane === 'probe') continue;
        if (lastAtMs !== undefined && e.atMs < lastAtMs) throw new Error('Timeline entries must be ordered by atMs');
        lastAtMs = e.atMs;
        await this.fireTimers(e.atMs);
        await this.pace(e.atMs);
        if (this.stopError) throw this.stopError;
        if (e.lane === 'source') await this.apply(e.step);
        else if (e.lane === 'transport') {
          // A second client needs no action here: arrivals are refused while a client is connected.
          if (e.step.action === 'connect') await this.accept(e.connection, e.step.client);
          else if (e.step.action === 'disconnect') await this.disconnect();
        }
        await this.flush();
        // After an action that wrote an event or gap, the client may first acknowledge it, or leave (bounded), before the
        // server paces on, so ACKs and client closes take effect at the same action boundaries as in the replay.
        await this.quiesce();
        if (this.failure) throw this.failure;
      }
      if (lastAtMs !== undefined) await this.fireTimers(lastAtMs);
      this.closeLive('open', true);
      for (const p of this.pending.splice(0)) p.socket.destroy();
      for (const l of this.links) await this.wait(() => l.closed, REPLY_DEADLINE_MS);
      return this.report(false);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      // Cancellation: a live connection receives `end` with plugin-shutdown at the segment's progress (D14).
      const l = this.live;
      if (l?.helloDone && this.producer.connected) {
        const at = this.progressAtMs(), out = this.producer.shutdown('plugin-shutdown', this.ns(at));
        if (out) {
          this.write(out, at);
          await this.wait(() => l.link.pendingWrites === 0 || l.link.closed, this.writeMs, false).catch(() => false);
          l.record.closedBy = 'end'; this.live = undefined; l.link.socket.end();
          await this.wait(() => l.link.closed, this.writeMs, false).catch(() => false);
        }
      }
      return this.report(true);
    } finally { await this.teardown(); }
  }
  private report(cancelled: boolean): ReactiveReport {
    return {scenario: this.scenario, transcript: this.transcript, connections: this.connections, refusedClients: this.refused, cancelled, ...(this.soak ? {soak: this.soakStatus()} : {})};
  }
}

/**
 * Why reactive serving cannot reproduce a scenario, or an empty list. Reactive mode lets a client react (ACK release,
 * crash) only at action boundaries, while the replay applies each reaction right after the message that caused it. The
 * two agree unless, inside one action (a step, a timer or a connect), (A) a release the replay performs changes whether
 * a later event of the same action is admitted at the 256-entry or 1 MiB store bound, or (B) a client crashes on an item
 * while the store already holds later eventSeqs or the same action assigns more, which reactive mode would still write
 * to the departing client. Both are detected conservatively by stepping the replay driver.
 */
export function reactiveConflicts(input: unknown): string[] {
  const driver = new V1Driver(input), run = driver.run(), out: string[] = [], store = driver.producer.store, channel = driver.producer.adapter.channel;
  let atMs = 0, startEntries = 0, startBytes = 0, newEntries = 0, newBytes = 0, acked = false, admittedAfterAck = false, crashChannel: bigint | undefined;
  const begin = (at: number) => { const st = store.status(); atMs = at; startEntries = st.retainedEntries; startBytes = st.retainedBytes; newEntries = 0; newBytes = 0; acked = false; admittedAfterAck = false; crashChannel = undefined; };
  const end = () => {
    // Only an admission after a release can differ: without releases both sides hold the same entries.
    if (admittedAfterAck && (startEntries + newEntries + 1 >= V1_LIMITS.retainedEntries || startBytes + newBytes + GAP_RECORD_BYTES > V1_LIMITS.retainedBytes))
      out.push(`An ACK at ${atMs} ms releases entries the same action may need at the store bound (A)`);
    if (crashChannel !== undefined && channel.nextEventSeq !== crashChannel) out.push(`A client crash at ${atMs} ms is followed by more events of the same action (B)`);
  };
  const seen = new Set<number>();
  for (let r = run.next(); !r.done; r = run.next()) {
    const e = r.value, last = driver.transcript.at(-1)?.message;
    if (e.kind === 'time') { end(); begin(e.atMs); }
    else if (e.kind === 'write' && e.message && last && (last.kind === 'event' || last.kind === 'gap') && !last.data.redelivered) {
      // A worst-case measure exceeds the written frame by less than 64 bytes; a new gap entry reserves 1,024.
      newEntries++; newBytes += last.kind === 'gap' ? GAP_RECORD_BYTES : e.bytes.length + 64; if (acked) admittedAfterAck = true;
    } else if (e.kind === 'expect' && last?.kind === 'ack') acked = true;
    else if (e.kind === 'close' && e.by === 'client') {
      const record = driver.connections.find(c => c.closedBy === 'crash' && !seen.has(c.connection));
      if (!record) continue;
      seen.add(record.connection);
      const item = [...driver.transcript].reverse().find(l => l.connection === record.connection && l.direction === 'server' && (l.message.kind === 'event' || l.message.kind === 'gap'))?.message;
      const through = item?.kind === 'event' ? BigInt(item.data.eventSeq) : item?.kind === 'gap' ? BigInt(item.data.lastEventSeq) : 0n;
      if (store.nextEventSeq - 1n > through) out.push(`A client crash at ${atMs} ms leaves later eventSeqs the reactive server would still write to it (B)`);
      crashChannel = channel.nextEventSeq;
    }
  }
  end();
  return [...new Set(out)];
}

/** Serves one scenario in reactive mode; see the module comment. */
export async function serveV1Reactive(input: unknown, options: ReactiveServeOptions = {}): Promise<ReactivePipeServer> {
  const server = new Reactive(input, options);
  await server.listen();
  const done = server.run(); void done.catch(() => undefined);
  const stop = async () => { server.stop(); await done.catch(() => undefined); };
  options.signal?.addEventListener('abort', () => void stop(), {once: true});
  if (options.signal?.aborted) void stop();
  return {endpoint: server.endpoint, done, stop, ...(options.soak ? {status: () => server.soakStatus()} : {})};
}

/** A message in comparable form: kind, source, capture and data, without the message seq. */
function comparable(m: ServerMessage): string {
  const data = m.kind === 'checkpoint' ? (({boundarySeq: _b, ...rest}) => { void _b; return rest; })(m.data) : m.data;
  return JSON.stringify({kind: m.kind, source: m.source, capture: m.capture, data});
}
/**
 * Differences between a reactive run and `replay-v1` for plan item 7: per connection, the events, gaps, checkpoints and
 * `end` equal the replay's except the message seq (and the checkpoint's boundarySeq, which equals it); snapshots equal
 * in number, state and continuity. Clock replies and client messages are not compared; they depend on the client.
 */
export function reactiveDifferences(replay: ReplayResult, served: ReactiveReport): string[] {
  const out: string[] = [], sessions = replay.connections.filter(c => !c.helloFault);
  if (served.connections.length !== sessions.length) out.push(`${served.connections.length} connections served, ${sessions.length} replayed`);
  sessions.forEach((r, i) => {
    const c = served.connections[i]; if (!c) return;
    const pick = (lines: readonly TranscriptLine[], connection: number, kinds: string[]) => lines.filter(l => l.connection === connection && l.direction === 'server' && kinds.includes(l.message.kind)).map(l => l.message as ServerMessage);
    const durable = ['checkpoint', 'event', 'gap', 'end'];
    const a = pick(replay.transcript, r.connection, durable).map(comparable), b = pick(served.transcript, c.connection, durable).map(comparable);
    if (a.length !== b.length) out.push(`connection ${c.connection}: ${b.length} checkpoint/event/gap/end messages served, ${a.length} replayed`);
    a.forEach((m, j) => { if (b[j] !== m) out.push(`connection ${c.connection}: ${(JSON.parse(m) as {kind: string}).kind} ${j} differs`); });
    const state = (m: ServerMessage) => m.kind === 'snapshot' ? JSON.stringify({state: m.data.state, continuity: m.data.continuity}) : '';
    const sa = pick(replay.transcript, r.connection, ['snapshot']).map(state), sb = pick(served.transcript, c.connection, ['snapshot']).map(state);
    if (JSON.stringify(sa) !== JSON.stringify(sb)) out.push(`connection ${c.connection}: snapshot state or continuity differs`);
  });
  return out;
}

/**
 * An independent consumer for reactive mode: not driven by the replay. It follows each scripted connection's durability,
 * commit and ACK policy with its own client instance IDs (fresh after a crash), its own seeded random delay before each
 * write, an optional clock probe per connection, and retries a refused or rejected attempt. It is built only from
 * ScriptedClient, i.e. the ET-002b helpers and the in-memory ledger.
 */
export async function runIndependentClient(endpoint: string, input: unknown, options: {seed?: number; maxDelayMs?: number; probe?: boolean; signal?: AbortSignal} = {}) {
  if (!TEST_PIPE_PATTERN_V1.test(endpoint)) throw new Error('Private synthetic v1 endpoint required');
  const s = validateScenario(input), ledger = new CommitLedger(), maxDelay = bounded(options.maxDelayMs, 5, 0, 1_000, 'client delay');
  if (s.source.startEventSeq > 1n) ledger.seed(scenarioSource(s).pluginSessionId, s.source.startEventSeq - 1n);
  let state = (options.seed ?? 1) >>> 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
  let instance = randomUUID(), cursors = new Map<string, DurableAckCursor>(), attempts = 0;
  const sessions: {received: ServerMessage[]; ended: 'eof' | 'crash'; probes: number; replies: number}[] = [];
  for (const step of s.transport) {
    if (step.action !== 'connect') continue;
    for (;;) {
      if (options.signal?.aborted) throw new Error('Independent client cancelled');
      const result = await new Promise<{welcomed: boolean; crashed: boolean; client: ScriptedClient}>((resolve, reject) => {
        const socket = net.connect(endpoint), client = new ScriptedClient(ledger, step.client, instance, randomUUID(), cursors, s.origin);
        let settled = false, crashed = false, probed = false, writing = false; attempts++;
        // Writes leave strictly in order, one at a time, each after its own random delay, as a storage-paced consumer sends
        // them. ACKs are cumulative: a new ACK replaces one still waiting behind it, so a burst costs one ACK, not one each.
        const pending: {ack: boolean; bytes: Uint8Array | (() => Uint8Array[])}[] = [], idle: (() => void)[] = [];
        const enqueue = (bytes: Uint8Array | (() => Uint8Array[]), ack = false) => {
          if (ack && pending.at(-1)?.ack) pending[pending.length - 1] = {ack, bytes}; else pending.push({ack, bytes});
          if (writing) return;
          writing = true;
          const next = () => {
            const item = pending.shift();
            if (!item) { writing = false; for (const f of idle.splice(0)) f(); return; }
            setTimeout(() => {
              if (!socket.destroyed) for (const b of typeof item.bytes === 'function' ? item.bytes() : [item.bytes]) socket.write(b);
              next();
            }, random() * maxDelay);
          };
          next();
        };
        socket.on('error', () => undefined);
        socket.on('connect', () => { for (const f of client.hello().frames) enqueue(f); });
        socket.on('data', chunk => {
          if (crashed) return;
          let out;
          try { out = client.receive(chunk, () => process.hrtime.bigint()); } catch (error) { settled = true; socket.destroy(); reject(error instanceof Error ? error : new Error('Client failed')); return; }
          // ScriptedClient.receive returns only ACK frames.
          for (const f of out.frames) enqueue(f, true);
          if (options.probe && !probed && client.received.some(m => m.kind === 'checkpoint')) { probed = true; enqueue(() => client.probe('1', process.hrtime.bigint()).frames); }
          // A crash loses nothing already queued: earlier writes leave first.
          if (out.crashed) { crashed = true; if (writing) idle.push(() => socket.destroy()); else socket.destroy(); }
        });
        socket.on('close', () => {
          if (settled) return; settled = true;
          if (!crashed) try { client.end(); } catch (error) { reject(error instanceof Error ? error : new Error('Truncated')); return; }
          resolve({welcomed: client.received.length > 0, crashed, client});
        });
      });
      if (!result.welcomed) { await new Promise(r => setTimeout(r, 20)); if (attempts > 1_000) throw new Error('Too many refused attempts'); continue; }
      const replies = result.client.received.filter(m => m.kind === 'clock.reply').length;
      sessions.push({received: result.client.received, ended: result.crashed ? 'crash' : 'eof', probes: options.probe ? 1 : 0, replies});
      if (result.crashed) { instance = randomUUID(); cursors = new Map(); }
      break;
    }
  }
  const through = ledger.through(scenarioSource(s).pluginSessionId);
  return {sessions, attempts, ledger: {committedThroughEventSeq: through.toString(), committedEvents: ledger.committedEvents, committedGapMarkers: ledger.committedGapMarkers.toString(), duplicates: ledger.duplicates}};
}
export type IndependentClientRun = Awaited<ReturnType<typeof runIndependentClient>>;
