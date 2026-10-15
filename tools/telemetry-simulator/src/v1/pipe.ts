// Serves the protocol v1 simulator on a real Windows named pipe, and the scripted pipe client (ET-005b).
//
// The server runs the replay driver (replay.ts) and answers its transport effects with real I/O in lockstep: after each
// server frame it waits for exactly the bytes the scenario's scripted client sends in reply, compares them and only then
// lets the producer process them. The producer's source clock is scenario time, so the server's transcript is
// byte-identical to `replay-v1` by construction; real time only paces connected segments (offline segments are
// fast-forwarded). The client is built from the same ScriptedClient, i.e. only the ET-002b FrameDecoder, V1Consumer,
// DurableAckCursor and computeClockMapping plus the in-memory CommitLedger.
//
// Node is only a synthetic test server: it has no protected DACL, no peer authentication and no discovery record or
// service policy. Native endpoint security belongs to ET-004b and is not evidenced here.
import net, {type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {V1_LIMITS, encodeFrame, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type AfterMessage, type ClientPolicy, type MappingResult} from './client';
import {helloFaultBytes, hex, liveFaultBytes, type HelloFault} from './faults';
import {V1Driver, foreignSession, orderedLines, replayV1, scenarioSource, type ClientAction, type ClosedBy, type Effect, type ReplayResult} from './replay';

export const TEST_PIPE_PREFIX_V1 = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-';
/** The only endpoints the simulator serves or connects to: `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}`. */
export const TEST_PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Liveness bound for a cooperative client's scripted reply, connection or close; only a broken client reaches it. */
export const REPLY_DEADLINE_MS = 5_000;
// Client bytes the script has not consumed yet; a scripted client never has more than a few frames in flight.
const MAX_INBOUND_BYTES = 65_536;

export interface V1ServeOptions {
  /** Real milliseconds per scenario millisecond while a client is connected; 0 replays without pacing. Default 1. */
  scale?: number;
  /** The hello deadline from the scenario's connect point: 1 to 5,000 ms, default 5,000 (§4). Tests inject a shorter one. */
  helloTimeoutMs?: number;
  /** The server's write deadline: 1 to 1,000 ms, default 1,000 (§9). */
  writeDeadlineMs?: number;
  /** See REPLY_DEADLINE_MS: 1 to 60,000 ms. */
  replyDeadlineMs?: number;
  signal?: AbortSignal;
}
export interface V1ServeReport {result: ReplayResult; cancelled: boolean; refusedClients: number}
export interface V1PipeServer {endpoint: string; done: Promise<V1ServeReport>; stop(): Promise<void>}

class Cancelled extends Error {}
function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string, integer = true): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) throw new Error(`Invalid ${name}`);
  return v;
}

/** One accepted pipe connection and its unread client bytes. */
class Link {
  inbound = Buffer.alloc(0); ended = false; closed = false; pendingWrites = 0; writeError?: Error;
  /** Expected to end (closed, stalled or failing); a client arriving meanwhile is queued, not refused. */
  ending = false; overflow = false;
  constructor(readonly socket: Socket, changed: () => void) {
    socket.on('data', chunk => {
      this.inbound = Buffer.concat([this.inbound, chunk]);
      if (this.inbound.length > MAX_INBOUND_BYTES) { this.overflow = true; socket.pause(); }
      changed();
    });
    socket.on('end', () => { this.ended = true; changed(); });
    socket.on('close', () => { this.closed = true; changed(); });
    // A departed client is observed through close and failed writes.
    socket.on('error', () => undefined);
  }
}

/** The lockstep server of one scenario run. */
class Server {
  readonly endpoint = TEST_PIPE_PREFIX_V1 + String(process.pid) + '-' + randomUUID();
  private readonly server = net.createServer(socket => this.connection(socket));
  private readonly links = new Set<Link>(); private pending: Link[] = []; private active?: Link;
  private refused = 0; private refusalsExpected = 0; private readonly listeners = new Set<() => void>();
  private stopError?: Error; private stopping = false; private failure?: Error;
  private atMs = 0; private segment?: {realMs: number; atMs: number}; private helloDeadline?: number;
  private readonly scale: number; private readonly helloMs: number; private readonly writeMs: number; private readonly replyMs: number;
  constructor(private readonly driver: V1Driver, options: V1ServeOptions) {
    this.scale = bounded(options.scale, 1, 0, 10, 'scale', false);
    this.helloMs = bounded(options.helloTimeoutMs, V1_LIMITS.helloTimeoutMs, 1, V1_LIMITS.helloTimeoutMs, 'hello timeout');
    this.writeMs = bounded(options.writeDeadlineMs, V1_LIMITS.writeDeadlineMs, 1, V1_LIMITS.writeDeadlineMs, 'write deadline');
    this.replyMs = bounded(options.replyDeadlineMs, REPLY_DEADLINE_MS, 1, 60_000, 'reply deadline');
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.endpoint, () => { this.server.removeListener('error', reject); resolve(); }); });
    this.server.on('error', error => { this.failure ??= error; this.changed(); });
  }
  private changed(): void { for (const check of [...this.listeners]) check(); }
  /**
   * Resolves true once `ready` holds, or false at the deadline. A deadline is judged only after one more I/O poll
   * (setImmediate after the timer), so a completion that was already queued when a starved process woke still counts.
   */
  private wait(ready: () => boolean, ms: number, abortable = true): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const finish = (f: () => void) => { clearTimeout(timer); this.listeners.delete(check); f(); };
      const check = () => {
        if (abortable && this.stopError) finish(() => reject(this.stopError!));
        else if (this.failure) finish(() => reject(this.failure!));
        else if (ready()) finish(() => resolve(true));
      };
      this.listeners.add(check);
      const timer = setTimeout(() => setImmediate(() => { if (!this.listeners.has(check)) return; check(); if (this.listeners.has(check)) finish(() => resolve(false)); }), ms);
      check();
    });
  }
  private connection(socket: Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    const link = new Link(socket, () => this.changed()); this.links.add(link);
    // One client at a time: a second client is refused while the first continues (§4).
    if (this.active && !this.active.ending) { socket.destroy(); this.refused++; }
    else this.pending.push(link);
    this.changed();
  }
  private drained(link: Link): void {
    if (link.overflow || link.inbound.length) throw new Error('The client sent bytes its script does not contain');
  }

  private async effect(e: Effect): Promise<void> {
    switch (e.kind) {
      case 'time': {
        this.atMs = e.atMs;
        // Connected segments are paced from their start, so wait and write latency do not accumulate.
        if (this.segment && this.scale > 0) {
          const delay = this.segment.realMs + (e.atMs - this.segment.atMs) * this.scale - performance.now();
          if (delay > 0) await this.wait(() => false, delay);
        }
        return;
      }
      case 'accept':
        if (!await this.wait(() => this.pending.length > 0, this.replyMs)) throw new Error(`No client connected for connection ${e.connection}`);
        this.active = this.pending.shift(); this.helloDeadline = performance.now() + this.helloMs; return;
      case 'expect': {
        const link = this.active!, n = e.bytes.length, hello = this.helloDeadline !== undefined;
        const ms = hello ? Math.max(0, this.helloDeadline! - performance.now()) : this.replyMs;
        if (!await this.wait(() => link.inbound.length >= n || link.ended || link.closed || link.overflow, ms)) throw new Error(hello ? 'Hello deadline exceeded' : 'Client reply deadline exceeded');
        if (link.inbound.length < n) throw new Error('The client left before sending its scripted bytes');
        if (!link.inbound.subarray(0, n).equals(e.bytes)) throw new Error('Client bytes differ from its script');
        link.inbound = link.inbound.subarray(n);
        if (hello) { this.helloDeadline = undefined; this.segment = {realMs: performance.now(), atMs: this.atMs}; }
        if (e.endsInput) {
          if (!await this.wait(() => link.ended || link.closed, this.replyMs)) throw new Error('The client did not end its side');
          this.drained(link);
        }
        return;
      }
      case 'helloTimeout': {
        const link = this.active!;
        if (await this.wait(() => link.inbound.length > 0 || link.ended || link.closed, Math.max(0, this.helloDeadline! - performance.now()))) throw new Error('A silent client sent bytes or left before the hello deadline');
        this.helloDeadline = undefined; return;
      }
      case 'write': {
        const link = this.active!; link.pendingWrites++;
        link.socket.write(e.bytes, error => { link.pendingWrites--; if (error) link.writeError ??= error; this.changed(); });
        return;
      }
      case 'stall': this.active!.ending = true; return;
      case 'secondClient':
        this.refusalsExpected++;
        if (!await this.wait(() => this.refused >= this.refusalsExpected, this.replyMs)) throw new Error('No second client was refused');
        return;
      case 'flush': {
        const link = this.active; if (!link) return;
        const done = await this.wait(() => link.pendingWrites === 0 || link.writeError !== undefined || link.closed, this.writeMs);
        if (e.expectDeadline) { if (done) throw new Error('The stalled client did not block the server writes'); return; }
        if (!done) throw new Error('Write deadline exceeded');
        if (link.writeError || link.closed) throw new Error('The client left during a write');
        return;
      }
      case 'close': {
        const link = this.active!; this.active = undefined; this.segment = undefined; this.helloDeadline = undefined; link.ending = true;
        if (e.by === 'client') {
          if (!await this.wait(() => link.ended || link.closed, this.replyMs)) throw new Error('The client did not close its connection');
          this.drained(link); link.socket.destroy();
        } else if (e.graceful) {
          // end() returns only after the client has read every written byte (Windows FlushFileBuffers in libuv).
          this.drained(link); link.socket.end();
        } else link.socket.destroy();
        return;
      }
    }
  }
  /** Runs the scenario; on stop, a live connection receives `end` with reason plugin-shutdown (D14). */
  async run(): Promise<V1ServeReport> {
    const run = this.driver.run();
    try {
      for (let r = run.next(); ; r = run.next()) {
        if (this.stopError) throw this.stopError;
        if (r.done) { await this.finish(); return {result: r.value, cancelled: false, refusedClients: this.refused}; }
        await this.effect(r.value);
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      await this.cancel();
      return {result: this.driver.result(), cancelled: true, refusedClients: this.refused};
    } finally { await this.teardown(); }
  }
  private async finish(): Promise<void> {
    const link = this.active;
    if (link) { this.active = undefined; link.ending = true; this.drained(link); link.socket.end(); }
    if (this.pending.length) throw new Error('A client connected that the scenario does not contain');
    for (const l of this.links) if (!await this.wait(() => l.closed, this.replyMs)) throw new Error('A client did not close its connection');
  }
  private async cancel(): Promise<void> {
    this.stopping = true;
    const out = this.driver.cancel(), link = this.active;
    if (!out || !link) return;
    link.pendingWrites++;
    link.socket.write(out.frame, error => { link.pendingWrites--; if (error) link.writeError ??= error; this.changed(); });
    // Best effort within the write deadline; never waits for an ACK.
    await this.wait(() => link.pendingWrites === 0 || link.closed, this.writeMs, false).catch(() => false);
    link.socket.end();
    await this.wait(() => link.closed, this.writeMs, false).catch(() => false);
  }
  private async teardown(): Promise<void> {
    this.stopping = true;
    for (const l of this.links) l.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  stop(): void { this.stopError ??= new Cancelled('Simulator pipe cancelled'); this.changed(); }
}

/**
 * Serves one scenario on a new synthetic endpoint. The scenario's transport steps script the client: a client that
 * deviates (other bytes, other timing of connections) fails the run visibly. Faults injected by the scenario close
 * connections as the native endpoint would, without an error frame.
 */
export async function serveV1(input: unknown, options: V1ServeOptions = {}): Promise<V1PipeServer> {
  if (process.platform !== 'win32') throw new Error('The v1 pipe simulator requires actual Windows named pipes');
  const server = new Server(new V1Driver(input), options);
  await server.listen();
  const done = server.run(); void done.catch(() => undefined);
  const stop = async () => { server.stop(); await done.catch(() => undefined); };
  options.signal?.addEventListener('abort', () => void stop(), {once: true});
  if (options.signal?.aborted) void stop();
  return {endpoint: server.endpoint, done, stop};
}

/** One connection of the client script, derived from the deterministic replay. */
export interface PlannedConnection {
  connection: number; openedAtMs: number; clientInstanceId: string; clientClockId: string; closedBy: ClosedBy;
  helloFault?: HelloFault; policy?: ClientPolicy; actions: ClientAction[];
}
export interface V1ClientPlan {scenario: string; origin: 'synthetic'; pluginSessionId: string; foreignSessionId: string; ledgerSeedThrough: bigint; connections: PlannedConnection[]}
/**
 * The client's script: per connection its policy or hello fault, and the actions it takes after a given server message
 * (probes, live faults, second clients). Taken from the replay, because a probe or fault belongs to a point of the
 * server stream that only the scenario timeline defines.
 */
export function clientPlan(replay: ReplayResult): V1ClientPlan {
  const s = replay.scenario;
  return {scenario: s.id, origin: s.origin, pluginSessionId: scenarioSource(s).pluginSessionId, foreignSessionId: foreignSession(s.seed),
    ledgerSeedThrough: s.source.startEventSeq - 1n,
    connections: replay.connections.map(c => ({connection: c.connection, openedAtMs: c.openedAtMs, clientInstanceId: c.clientInstanceId, clientClockId: c.clientClockId, closedBy: c.closedBy,
      helloFault: c.helloFault, policy: c.policy, actions: c.actions}))};
}

export interface ClientConnectionResult {
  connection: number; closedBy: ClosedBy;
  /** Every byte unit this client wrote, in order (lowercase hex). */
  sentHex: string[];
  /**
   * Server messages the client's V1Consumer accepted, in order, and the arrival times (ms since the client run started)
   * of those it went on to process; a crash or a stall ends the arrivals one message early or stops them.
   */
  received: ServerMessage[]; arrivalsMs: number[];
  /** Clock mappings from real client time (process.hrtime); `roundTripNs` is null for a late reply, which yields no mapping. */
  mappings: (MappingResult & {roundTripNs: string | null})[]; rejection?: string; refusedClients: number;
}
export interface V1ClientRun {connections: ClientConnectionResult[]; ledger: {committedThroughEventSeq: string; committedEvents: number; committedGapMarkers: string; duplicates: number}}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}
/** A second client while one is connected: the server must close it without sending a byte. */
function refusedAttempt(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint); let bytes = 0;
    socket.on('data', chunk => { bytes += chunk.length; });
    socket.on('error', () => undefined);
    socket.on('close', () => { if (bytes) reject(new Error('A refused client received data')); else resolve(); });
  });
}

/**
 * Runs the scripted client of a plan against a synthetic endpoint: one connection after another, each a fresh
 * ScriptedClient over the shared CommitLedger and per-instance ACK cursors, exactly as in the replay.
 */
export async function runV1PipeClient(endpoint: string, plan: V1ClientPlan, options: {scale?: number; signal?: AbortSignal} = {}): Promise<V1ClientRun> {
  if (!TEST_PIPE_PATTERN_V1.test(endpoint)) throw new Error('Private synthetic v1 endpoint required');
  const scale = bounded(options.scale, 1, 0, 10, 'scale', false);
  const ledger = new CommitLedger(); if (plan.ledgerSeedThrough > 0n) ledger.seed(plan.pluginSessionId, plan.ledgerSeedThrough);
  const start = performance.now(), results: ClientConnectionResult[] = [], refusals: Promise<void>[] = [], stalled: Socket[] = [];
  let cursors = new Map<string, DurableAckCursor>(), instance = '';
  const releaseStalled = () => { for (const s of stalled.splice(0)) s.destroy(); };
  try {
    for (const c of plan.connections) {
      if (options.signal?.aborted) throw new Error('Simulator pipe client cancelled');
      if (c.clientInstanceId !== instance) { instance = c.clientInstanceId; cursors = new Map(); }
      const socket = await connect(endpoint);
      const result: ClientConnectionResult = {connection: c.connection, closedBy: c.closedBy, sentHex: [], received: [], arrivalsMs: [], mappings: [], refusedClients: 0};
      results.push(result);
      const write = (bytes: Uint8Array) => { result.sentHex.push(hex(bytes)); if (bytes.length) socket.write(bytes); };
      await new Promise<void>((resolve, reject) => {
        let settled = false, received = 0, ended = false, rejected = false, crashed = false;
        const done = (error?: Error) => { if (settled) return; settled = true; if (error) { socket.destroy(); reject(error); } else resolve(); };
        socket.on('error', () => undefined);
        if (c.helloFault) {
          // A failed attempt: the server must close it without writing a byte.
          socket.on('data', chunk => { received += chunk.length; });
          socket.on('close', () => done(received ? new Error(`Hello fault ${c.helloFault} received server bytes`) : undefined));
          const {bytes, endsInput} = helloFaultBytes(c.helloFault, {clientInstanceId: c.clientInstanceId, pluginSessionId: plan.pluginSessionId});
          write(bytes); if (endsInput) socket.end();
          return;
        }
        const client = new ScriptedClient(ledger, c.policy!, c.clientInstanceId, c.clientClockId, cursors, plan.origin); result.received = client.received;
        const now = () => process.hrtime.bigint(), probeTimes: bigint[] = [];
        let next = 0, probeId = 0, endInput = false, stall = false, pacedFrom = 0;
        // The server paces a connection from its hello; a probe is sent at its own scenario time on that schedule, so
        // its measured round trip does not include the wait for the server's timeline (the server holds early bytes).
        const sendProbe = () => { if (settled) return; probeTimes.push(now()); for (const f of client.probe(String(++probeId), probeTimes.at(-1)!).frames) write(f); };
        const after: AfterMessage = (m, frames) => {
          result.arrivalsMs.push(performance.now() - start);
          if (result.arrivalsMs.length === 1) { releaseStalled(); pacedFrom = performance.now(); }
          for (; next < c.actions.length && c.actions[next].afterSeq === m.seq; next++) {
            const a = c.actions[next];
            if (a.action === 'probe') {
              // A probe is the last action at its point of the stream: its reply follows before any later action.
              const delay = pacedFrom + (a.atMs - c.openedAtMs) * scale - performance.now();
              if (delay > 0) setTimeout(sendProbe, delay); else { probeTimes.push(now()); frames.push(...client.probe(String(++probeId), probeTimes.at(-1)!).frames); }
            }
            else if (a.action === 'secondClient') { result.refusedClients++; refusals.push(refusedAttempt(endpoint)); }
            else {
              const {bytes, endsInput} = liveFaultBytes(a.fault!, client.faultContext(plan.foreignSessionId));
              if (a.fault === 'stallRead') { stall = true; result.sentHex.push(''); return false; }
              frames.push(bytes); endInput ||= endsInput;
            }
          }
          return true;
        };
        socket.on('data', chunk => {
          if (settled || stall) return;
          let out;
          try { out = client.receive(chunk, now, after); }
          catch (error) {
            // A wire fault must be rejected by the contract decoder or consumer; anything else fails the run.
            if (c.closedBy !== 'clientRejected') { done(error instanceof Error ? error : new Error('Client failed')); return; }
            rejected = true; result.rejection = error instanceof Error ? error.message : 'rejected'; socket.destroy(); done(); return;
          }
          for (const f of out.frames) write(f);
          if (endInput) socket.end();
          if (out.crashed) { crashed = true; socket.destroy(); done(c.closedBy === 'crash' ? undefined : new Error('Unexpected client crash')); return; }
          // A stalled client keeps its pipe open and unread; the server ends it at its write deadline, which this
          // client learns from the next connection's first message.
          if (stall) { socket.pause(); stalled.push(socket); done(c.closedBy === 'writeDeadline' ? undefined : new Error('Unexpected stall')); }
        });
        socket.on('end', () => {
          ended = true;
          try { client.end(); }
          catch (error) {
            if (c.closedBy === 'clientRejected') { rejected = true; result.rejection = error instanceof Error ? error.message : 'rejected'; }
            else { done(error instanceof Error ? error : new Error('Truncated stream')); return; }
          }
          socket.end();
        });
        socket.on('close', () => {
          result.mappings = client.mappings.map((x, i) => ({...x, roundTripNs: x.mapping ? (BigInt(x.mapping.measuredAtClientNs) - probeTimes[i]).toString() : null}));
          const last = result.received.at(-1)?.kind;
          const observed: ClosedBy | 'eof' = crashed ? 'crash' : rejected ? 'clientRejected' : last === 'end' ? 'end' : 'eof';
          const expectedEof = ['disconnect', 'open', 'serverRejected', 'clientEof', 'helloTimeout'].includes(c.closedBy);
          if (!ended && !crashed && !rejected) { done(new Error('The server closed the connection abruptly')); return; }
          done(observed === c.closedBy || (observed === 'eof' && expectedEof) ? undefined : new Error(`Connection ${c.connection} ended as ${observed}, expected ${c.closedBy}`));
        });
        for (const f of client.hello().frames) write(f);
      });
    }
    await Promise.all(refusals);
  } finally { releaseStalled(); }
  const through = ledger.through(plan.pluginSessionId);
  return {connections: results, ledger: {committedThroughEventSeq: through.toString(), committedEvents: ledger.committedEvents, committedGapMarkers: ledger.committedGapMarkers.toString(), duplicates: ledger.duplicates}};
}

/**
 * Differences between a pipe run and the deterministic replay: the server transcript and fault lines byte for byte,
 * each connection's outcome, every byte the client wrote, every message it applied, and the client's ledger.
 */
export function pipeDifferences(replay: ReplayResult, served: ReplayResult, client: V1ClientRun): string[] {
  const out: string[] = [];
  const a = orderedLines(replay).map(l => JSON.stringify(l)), b = orderedLines(served).map(l => JSON.stringify(l));
  if (a.length !== b.length) out.push(`transcript: ${b.length} lines served, ${a.length} replayed`);
  a.forEach((line, i) => { if (b[i] !== line) out.push(`transcript line ${i} differs`); });
  const outcome = (r: ReplayResult) => JSON.stringify(r.connections.map(c => [c.connection, c.closedBy, c.refusedClients, c.rejection ?? null]));
  if (outcome(served) !== outcome(replay)) out.push('connection outcomes differ');
  if (JSON.stringify(client.ledger) !== JSON.stringify(replay.ledger)) out.push(`client ledger ${JSON.stringify(client.ledger)} differs from ${JSON.stringify(replay.ledger)}`);
  if (client.connections.length !== replay.connections.length) out.push('connection count differs');
  for (const c of client.connections) {
    const lines = orderedLines(replay).filter(l => l.connection === c.connection);
    const sent = lines.filter(l => l.direction === 'client').map(l => 'message' in l ? Buffer.from(encodeFrame(l.message)).toString('hex') : l.bytesHex).join('');
    if (c.sentHex.join('') !== sent) out.push(`connection ${c.connection}: client bytes differ`);
    const server = lines.flatMap(l => l.direction === 'server' && 'message' in l ? [JSON.stringify(l.message)] : []), got = c.received.map(m => JSON.stringify(m));
    // A rejecting client may also have applied a valid message inside the injected bytes (frameAfterEnd); a stalled
    // client stops reading. Every message it applied must still be the served one, in order.
    const prefix = c.closedBy === 'clientRejected' ? got.slice(0, server.length) : got;
    const expected = c.closedBy === 'writeDeadline' ? server.slice(0, got.length) : server;
    if (JSON.stringify(prefix) !== JSON.stringify(expected)) out.push(`connection ${c.connection}: applied messages differ`);
    const record = replay.connections.find(r => r.connection === c.connection);
    if (record?.refusedClients !== c.refusedClients) out.push(`connection ${c.connection}: second clients differ`);
    if (c.closedBy === 'clientRejected' && c.rejection === undefined) out.push(`connection ${c.connection}: the client did not reject the wire fault`);
  }
  return out;
}

/** Serves a scenario and runs its scripted client against it in this process; returns all three views. */
export async function pipeRoundTrip(input: unknown, options: V1ServeOptions = {}): Promise<{replay: ReplayResult; served: V1ServeReport; client: V1ClientRun; differences: string[]}> {
  const replay = replayV1(input), server = await serveV1(input, options);
  try {
    const [client, served] = await Promise.all([runV1PipeClient(server.endpoint, clientPlan(replay), {scale: options.scale, signal: options.signal}), server.done]);
    return {replay, served, client, differences: pipeDifferences(replay, served.result, client)};
  } finally { await server.stop(); }
}
