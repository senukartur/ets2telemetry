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
// only in lockstep mode (pipe.ts).
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {FrameDecoder, ProtocolError, V1_LIMITS, type ProtocolMessage, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type ClientPolicy} from './client';
import {Cancelled, Link, PipeHost, REPLY_DEADLINE_MS, TEST_PIPE_PATTERN_V1, bounded} from './pipe-host';
import {V1Producer, type Out} from './producer';
import {timeline, validateScenario, type Scenario, type SourceStep, type TimelineEntry} from './scenario';
import {AdapterModel, ScenarioClock, seededId} from './source';
import {MAX_TRANSCRIPT_MESSAGES, scenarioSource, type ReplayResult, type TranscriptLine} from './replay';

export interface ReactiveServeOptions {
  /** Real milliseconds per scenario millisecond while a client is connected (0 to 10, default 1). */
  scale?: number;
  /** The hello deadline from accepting a connection: 1 to 5,000 ms, default 5,000 (§4). */
  helloTimeoutMs?: number;
  /** The server's write deadline: 1 to 1,000 ms, default 1,000 (§9). */
  writeDeadlineMs?: number;
  /** How long a scripted disconnect waits for the client to acknowledge what was written: 0 to 5,000 ms, default 1,000. */
  quiesceMs?: number;
  /** How long a scripted connect waits for a client: 1 to 600,000 ms, default 30,000. */
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}
export type ReactiveClosedBy = 'disconnect' | 'client' | 'end' | 'serverRejected' | 'writeDeadline' | 'open';
export interface ReactiveConnection {connection: number; durable: boolean; clientInstanceId: string; closedBy: ReactiveClosedBy; rejectedAttempts: number}
export interface ReactiveReport {scenario: Scenario; transcript: TranscriptLine[]; connections: ReactiveConnection[]; refusedClients: number; cancelled: boolean}
export interface ReactivePipeServer {endpoint: string; done: Promise<ReactiveReport>; stop: () => Promise<void>}

class Reactive extends PipeHost {
  readonly scenario: Scenario; private readonly clock = new ScenarioClock(); private readonly producer: V1Producer;
  private readonly transcript: TranscriptLine[] = []; private readonly connections: ReactiveConnection[] = [];
  private pending: Link[] = []; private live?: {link: Link; record: ReactiveConnection; recorder: FrameDecoder; helloDone: boolean; endWritten: boolean};
  private refused = 0; private atMs = 0; private target = 0; private segment?: {realMs: number; atMs: number};
  private readonly scale: number; private readonly helloMs: number; private readonly writeMs: number; private readonly quiesceMs: number; private readonly connectMs: number;
  constructor(input: unknown, options: ReactiveServeOptions) {
    super();
    const s = this.scenario = validateScenario(input);
    const scripted = s.transport.find(t => t.action === 'clientFault' || t.action === 'wireFault' || t.action === 'writeDeadline');
    if (scripted) throw new Error(`Reactive serving cannot run ${scripted.action} steps, which script the client; use lockstep mode`);
    this.producer = new V1Producer(new AdapterModel({game: s.game, seed: s.seed, ...s.source}, this.clock), scenarioSource(s), seededId(s.seed, 'capture-clock'));
    this.scale = bounded(options.scale, 1, 0, 10, 'scale', false);
    this.helloMs = bounded(options.helloTimeoutMs, V1_LIMITS.helloTimeoutMs, 1, V1_LIMITS.helloTimeoutMs, 'hello timeout');
    this.writeMs = bounded(options.writeDeadlineMs, V1_LIMITS.writeDeadlineMs, 1, V1_LIMITS.writeDeadlineMs, 'write deadline');
    this.quiesceMs = bounded(options.quiesceMs, 1_000, 0, 5_000, 'quiesce bound');
    this.connectMs = bounded(options.connectTimeoutMs, 30_000, 1, 600_000, 'connect timeout');
  }
  private ns(atMs: number): bigint { return this.clock.sourceNs(atMs); }
  /** The scenario time a paced segment has reached: between the last action and the one it is waiting for. */
  private progressAtMs(): number {
    if (!this.segment || this.scale === 0) return this.atMs;
    return Math.floor(Math.min(this.target, Math.max(this.atMs, this.segment.atMs + (performance.now() - this.segment.realMs) / this.scale)));
  }
  private line(atMs: number, direction: 'server' | 'client', message: ProtocolMessage): void {
    if (this.transcript.length >= MAX_TRANSCRIPT_MESSAGES) throw new Error('Simulator transcript limit exceeded');
    this.transcript.push({scenario: this.scenario.id, origin: 'synthetic', connection: this.live?.record.connection ?? 0, atMs, direction, message});
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
  }
  private closeLive(closedBy: ReactiveClosedBy, graceful: boolean): void {
    const l = this.live; if (!l) return;
    this.producer.close(this.ns(this.progressAtMs()));
    l.record.closedBy = closedBy; this.live = undefined; this.segment = undefined;
    if (graceful) l.link.socket.end(); else l.link.socket.destroy();
  }
  /** Client bytes as they arrive, one read at a time, exactly as the native endpoint receives them. */
  private receive(chunk: Buffer): void {
    const l = this.live; if (!l) return;
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
    l.recorder.push(chunk, m => this.line(at, 'client', m));
    for (const out of outs) {
      if (out.message.kind === 'welcome') {
        l.helloDone = true;
        if (out.message.data.durableEvents !== l.record.durable) this.failure ??= new Error(`Connection ${l.record.connection} expects a ${l.record.durable ? 'durable' : 'live-only'} client`);
        const hello = [...this.transcript].reverse().find(t => t.direction === 'client' && t.message.kind === 'hello');
        if (hello?.message.kind === 'hello') l.record.clientInstanceId = hello.message.data.clientInstanceId;
        this.segment = {realMs: performance.now(), atMs: this.atMs};
      }
      this.write(out, at);
    }
  }
  private pumpAll(atMs: number): void { for (let out = this.producer.pump(this.ns(atMs)); out; out = this.producer.pump(this.ns(atMs))) this.write(out, atMs); }
  private settle(atMs: number): void { this.producer.drain(this.ns(atMs)); this.pumpAll(atMs); }
  private apply(step: SourceStep): void {
    const at = step.atMs, adapter = this.producer.adapter;
    switch (step.action) {
      case 'configuration': case 'gameplay': for (let i = 0; i < step.repeat; i++) { adapter[step.action](step.id, step.attributes, step.list, at); this.settle(at); } break;
      case 'lifecycle': adapter.lifecycle(step.event, at); this.settle(at); break;
      case 'frame': { adapter.frame(step.timerRestart, step.channels, at); this.settle(at); const out = this.producer.publication(this.ns(at)); if (out) this.write(out, at); break; }
      case 'gameMode': adapter.determineGameMode(step.mode, at); this.settle(at); break;
      case 'encodingFailure': for (let i = 0; i < step.count; i++) { adapter.unencodable(1, at); this.settle(at); } break;
      case 'handoff': adapter.channel.full = step.full; break;
      case 'utcJump': this.clock.utcJump(step.deltaMs); break;
      case 'suspend': this.clock.suspend(at, step.durationMs, step.sourceClockAdvances); break;
      case 'shutdown': { this.settle(at); const out = this.producer.shutdown(step.reason, this.ns(at)); if (out && this.live) this.write(out, at); break; }
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
      else { const out = this.producer.fireSnapshot(this.ns(at)); if (out) this.write(out, at); await this.flush(); }
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
      const l = this.live = {link, record, recorder: new FrameDecoder('client'), helloDone: false, endWritten: false};
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
  /** A scripted disconnect: bounded wait for the ACKs of everything written, then a graceful close. */
  private async disconnect(): Promise<void> {
    const l = this.live; if (!l) return;
    await this.wait(() => this.live !== l || l.link.gone || ((s => s === undefined || s.acked >= s.sent)(this.producer.ackState())), this.quiesceMs);
    if (this.live === l) this.closeLive('disconnect', true);
  }
  private clientGone(): void { const l = this.live; if (l?.helloDone && l.link.gone) this.closeLive('client', false); }
  protected changed(): void { this.clientGone(); super.changed(); }

  async run(): Promise<ReactiveReport> {
    const entries: TimelineEntry[] = timeline(this.scenario.steps, this.scenario.transport).filter(e => e.lane !== 'probe');
    try {
      for (const e of entries) {
        await this.fireTimers(e.atMs);
        await this.pace(e.atMs);
        if (this.stopError) throw this.stopError;
        if (e.lane === 'source') this.apply(e.step);
        else if (e.lane === 'transport') {
          // A second client needs no action here: arrivals are refused while a client is connected.
          if (e.step.action === 'connect') await this.accept(e.connection, e.step.client);
          else if (e.step.action === 'disconnect') await this.disconnect();
        }
        await this.flush();
        if (this.failure) throw this.failure;
      }
      if (entries.length) await this.fireTimers(entries.at(-1)!.atMs);
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
    return {scenario: this.scenario, transcript: this.transcript, connections: this.connections, refusedClients: this.refused, cancelled};
  }
}

/** Serves one scenario in reactive mode; see the module comment. */
export async function serveV1Reactive(input: unknown, options: ReactiveServeOptions = {}): Promise<ReactivePipeServer> {
  const server = new Reactive(input, options);
  await server.listen();
  const done = server.run(); void done.catch(() => undefined);
  const stop = async () => { server.stop(); await done.catch(() => undefined); };
  options.signal?.addEventListener('abort', () => void stop(), {once: true});
  if (options.signal?.aborted) void stop();
  return {endpoint: server.endpoint, done, stop};
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
        const socket = net.connect(endpoint), client = new ScriptedClient(ledger, step.client, instance, randomUUID(), cursors);
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
