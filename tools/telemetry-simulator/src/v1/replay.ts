// Deterministic protocol v1 replay (ET-005b): drives the adapter model, the producer and the scripted client on one
// virtual clock and returns the ordered wire transcript. Each server message is applied by the client synchronously and
// each client reply is processed by the producer before the next action, so two runs are byte-identical.
//
// The driver is a generator of transport effects. `replayV1` answers every effect at once; the named-pipe server
// (pipe.ts) answers them with real I/O in lockstep, so both produce the same transcript.
import {ProtocolError, type ProtocolMessage, type ServerMessage, type SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type ClientOutput, type ClientPolicy, type MappingResult} from './client';
import {endData, V1Producer, type Out} from './producer';
import {timeline, validateScenario, type Scenario, type SourceStep, type TransportStep} from './scenario';
import {AdapterModel, ScenarioClock, seededId} from './source';
import {wireCounts} from './store';
import {helloFaultBytes, hex, isHelloFault, liveFaultBytes, wireFaultBytes, type ClientFault, type HelloFault, type LiveFault, type WireFault} from './faults';

export const MAX_TRANSCRIPT_MESSAGES = 20_000;
/** The scripted client's own monotonic clock, with an origin independent of the source clock (§11). */
export const CLIENT_BASE_NS = 5_000_000_000_000n;
type LineBase = {scenario: string; origin: 'synthetic'; connection: number; atMs: number; direction: 'server' | 'client'};
/** One valid wire message. */
export type TranscriptLine = LineBase & {message: ProtocolMessage};
/**
 * Injected fault bytes (lowercase hex, empty for a fault that sends nothing). `beforeLine` is the number of transcript
 * messages written before it, which places it in the combined output of `replay-v1`.
 */
export type FaultLine = LineBase & {fault: ClientFault | WireFault; bytesHex: string; beforeLine: number};
export type ClosedBy = 'disconnect' | 'crash' | 'end' | 'open' | 'serverRejected' | 'clientRejected' | 'clientEof' | 'helloTimeout' | 'writeDeadline';
/** A client action at a point of the server stream: after the server message with this `seq` on the connection. */
export interface ClientAction {afterSeq: string; action: 'probe' | 'fault' | 'secondClient'; fault?: LiveFault}
export interface ConnectionRecord {
  connection: number; durableRequested: boolean; clientInstanceId: string; closedBy: ClosedBy; mappings: MappingResult[];
  /** The scripted policy of a session, or the fault of a connection attempt that never completed its hello. */
  policy?: ClientPolicy; helloFault?: HelloFault;
  /** Client actions in stream order, the second clients refused while this connection was open, and a client rejection. */
  actions: ClientAction[]; refusedClients: number; rejection?: string;
}
export interface ReplayResult {
  scenario: Scenario; transcript: TranscriptLine[]; faults: FaultLine[]; connections: ConnectionRecord[];
  ledger: {committedThroughEventSeq: string; committedEvents: number; committedGapMarkers: string; duplicates: number};
  store: {ackedThroughEventSeq: string; nextEventSeq: string; retainedEntries: number; eventLoss: Record<string, string>}; retired: string | null;
}

/**
 * Transport effects of one run. `time`: the driver acts at this scenario time. `accept`: a connection attempt begins.
 * `expect`: the client's next bytes, read as one unit (with `endsInput`, the client then ends its side). `helloTimeout`:
 * the attempt sends nothing within the hello deadline. `write`: server bytes (with `endsOutput`, the server then closes).
 * `stall`: the client stopped reading. `secondClient`: one more client is refused while this one stays connected.
 * `flush`: the end of a timeline entry; written bytes must complete within the write deadline, or, with
 * `expectDeadline`, must not. `close`: the connection ends, by the server or by the client.
 */
export type Effect =
  {kind: 'time'; atMs: number} | {kind: 'accept'; connection: number} | {kind: 'expect'; bytes: Uint8Array; endsInput: boolean} | {kind: 'helloTimeout'} |
  {kind: 'write'; bytes: Uint8Array; endsOutput: boolean} | {kind: 'stall'} | {kind: 'secondClient'} | {kind: 'flush'; expectDeadline: boolean} |
  {kind: 'close'; by: 'server' | 'client'; graceful: boolean};

/** The fixed synthetic source identity of a scenario; every identifier derives from its seed. */
export function scenarioSource(s: Pick<Scenario, 'game' | 'seed'>): SourceIdentity {
  return {game: s.game, pluginSessionId: seededId(s.seed, 'plugin-session'), processInstanceId: seededId(s.seed, 'process-instance'), processId: 1, windowsSessionId: 0, origin: 'synthetic'};
}
/** The plugin session a client fault or a wire fault may name instead of the real one. */
export const foreignSession = (seed: string) => seededId(seed, 'foreign-plugin-session');

interface Open {client: ScriptedClient; record: ConnectionRecord; stalled: boolean; last?: ServerMessage; lastState?: ServerMessage; lastEvent?: ServerMessage}

/** One run of a scenario: the model, the transcript and the effect generator. */
export class V1Driver {
  readonly scenario: Scenario; readonly clock = new ScenarioClock(); readonly producer: V1Producer; readonly ledger = new CommitLedger();
  readonly transcript: TranscriptLine[] = []; readonly faults: FaultLine[] = []; readonly connections: ConnectionRecord[] = [];
  /** The scenario time of the current action. */
  atMs = 0;
  private open?: Open; private instance = 0; private newInstance = true; private cursors = new Map<string, DurableAckCursor>(); private probeId = 0;
  constructor(input: unknown) {
    const s = this.scenario = validateScenario(input), adapter = new AdapterModel({game: s.game, seed: s.seed, ...s.source}, this.clock);
    const source = scenarioSource(s); this.producer = new V1Producer(adapter, source, seededId(s.seed, 'capture-clock'));
    if (s.source.startEventSeq > 1n) this.ledger.seed(source.pluginSessionId, s.source.startEventSeq - 1n);
  }
  private ns(atMs: number): bigint { return this.clock.sourceNs(atMs); }
  private line(atMs: number, direction: LineBase['direction'], body: {message: ProtocolMessage} | {fault: ClientFault | WireFault; bytesHex: string}, connection = this.open?.record.connection ?? 0): void {
    if (this.transcript.length + this.faults.length >= MAX_TRANSCRIPT_MESSAGES) throw new Error('Simulator transcript limit exceeded');
    const base = {scenario: this.scenario.id, origin: this.scenario.origin, connection, atMs, direction};
    if ('message' in body) this.transcript.push({...base, message: body.message}); else this.faults.push({...base, ...body, beforeLine: this.transcript.length});
  }
  private lastSeq(): string { const o = this.open!; if (!o.last) throw new Error('A client action needs a server message on its connection'); return o.last.seq; }

  private *closeClient(atMs: number, closedBy: ClosedBy, by: 'server' | 'client', graceful: boolean): Generator<Effect, void, void> {
    const o = this.open!; this.producer.close(this.ns(atMs));
    o.record.closedBy = closedBy; o.record.mappings = o.client.mappings;
    if (closedBy === 'crash') this.newInstance = true;
    this.open = undefined;
    yield {kind: 'close', by, graceful: graceful && !o.stalled};
  }
  // Client messages reach the producer before anything else happens; its replies go back the same way.
  private *fromClient(output: ClientOutput, atMs: number): Generator<Effect, void, void> {
    for (let i = 0; i < output.messages.length; i++) {
      this.line(atMs, 'client', {message: output.messages[i]});
      yield {kind: 'expect', bytes: output.frames[i], endsInput: false};
      for (const out of this.producer.receive(output.frames[i], this.ns(atMs))) yield* this.deliver(out, atMs);
    }
    if (output.crashed && this.open) yield* this.closeClient(atMs, 'crash', 'client', false);
  }
  private *deliver(out: Out, atMs: number): Generator<Effect, void, void> {
    this.line(atMs, 'server', {message: out.message});
    const o = this.open; if (!o) throw new Error('Server message without a client');
    o.last = out.message;
    if (out.message.kind === 'checkpoint' || out.message.kind === 'snapshot') o.lastState = out.message;
    if (out.message.kind === 'event') o.lastEvent = out.message;
    yield {kind: 'write', bytes: out.frame, endsOutput: false};
    // A stalled client reads nothing more; its connection ends at the scripted write deadline.
    if (!o.stalled) yield* this.fromClient(o.client.receive(out.frame, CLIENT_BASE_NS + BigInt(atMs) * 1_000_000n), atMs);
    if (out.message.kind === 'end' && this.open === o) yield* this.closeClient(atMs, 'end', 'server', true);
  }
  private *pumpAll(atMs: number): Generator<Effect, void, void> {
    for (let out = this.producer.pump(this.ns(atMs)); out; out = this.producer.pump(this.ns(atMs))) yield* this.deliver(out, atMs);
  }
  private *settle(atMs: number): Generator<Effect, void, void> { this.producer.drain(this.ns(atMs)); yield* this.pumpAll(atMs); }
  private *flush(): Generator<Effect, void, void> { if (this.open && !this.open.stalled) yield {kind: 'flush', expectDeadline: false}; }
  // Timers fire at their own scenario time, before any step at or after it; a retention expiry before a snapshot.
  private *fireTimers(untilMs: number): Generator<Effect, void, void> {
    for (;;) {
      const due = this.producer.dueNs(), expiryAt = due.expiry === undefined ? Infinity : this.clock.atMsFor(due.expiry), snapshotAt = due.snapshot === undefined ? Infinity : this.clock.atMsFor(due.snapshot);
      const at = Math.min(expiryAt, snapshotAt); if (at > untilMs) return;
      this.atMs = at; yield {kind: 'time', atMs: at};
      if (expiryAt === at) this.producer.expire(this.ns(at));
      else { const out = this.producer.fireSnapshot(this.ns(at)); if (out) { yield* this.deliver(out, at); yield* this.flush(); } }
    }
  }
  private *apply(step: SourceStep): Generator<Effect, void, void> {
    const at = step.atMs, adapter = this.producer.adapter;
    switch (step.action) {
      case 'configuration': case 'gameplay':
        for (let i = 0; i < step.repeat; i++) { adapter[step.action](step.id, step.attributes, step.list, at); yield* this.settle(at); } break;
      case 'lifecycle': adapter.lifecycle(step.event, at); yield* this.settle(at); break;
      case 'frame': {
        adapter.frame(step.timerRestart, step.channels, at); yield* this.settle(at);
        const out = this.producer.publication(this.ns(at)); if (out) yield* this.deliver(out, at); break;
      }
      case 'gameMode': adapter.determineGameMode(step.mode, at); yield* this.settle(at); break;
      case 'encodingFailure': for (let i = 0; i < step.count; i++) { adapter.unencodable(1, at); yield* this.settle(at); } break;
      case 'handoff': adapter.channel.full = step.full; break;
      case 'utcJump': this.clock.utcJump(step.deltaMs); break;
      case 'suspend': this.clock.suspend(at, step.durationMs, step.sourceClockAdvances); break;
      case 'shutdown': {
        yield* this.settle(at); const out = this.producer.shutdown(step.reason, this.ns(at));
        if (out) yield* this.deliver(out, at); else if (this.open) yield* this.closeClient(at, 'end', 'server', true);
        break;
      }
    }
  }
  private beginAttempt(): string {
    if (this.newInstance) { this.instance++; this.cursors = new Map(); this.newInstance = false; }
    return seededId(this.scenario.seed, `client-instance-${this.instance}`);
  }
  private *connect(atMs: number, connection: number, policy: ClientPolicy): Generator<Effect, void, void> {
    const clientInstanceId = this.beginAttempt();
    const client = new ScriptedClient(this.ledger, policy, clientInstanceId, seededId(this.scenario.seed, `client-clock-${this.instance}`), this.cursors);
    const record: ConnectionRecord = {connection, durableRequested: policy.durable, clientInstanceId, closedBy: 'open', mappings: client.mappings, policy, actions: [], refusedClients: 0};
    this.connections.push(record); this.open = {client, record, stalled: false}; this.probeId = 0;
    this.producer.open(); yield {kind: 'accept', connection};
    yield* this.fromClient(client.hello(), atMs);
    if (this.open) yield* this.pumpAll(atMs);
  }
  // A connection attempt whose hello never completes: the producer opens no v1 connection (gate, store and seq unchanged).
  private *helloFault(atMs: number, connection: number, fault: HelloFault): Generator<Effect, void, void> {
    const clientInstanceId = this.beginAttempt();
    const record: ConnectionRecord = {connection, durableRequested: true, clientInstanceId, closedBy: 'open', mappings: [], helloFault: fault, actions: [], refusedClients: 0};
    this.connections.push(record);
    const {bytes, endsInput} = helloFaultBytes(fault, {clientInstanceId, pluginSessionId: this.producer.source.pluginSessionId});
    this.line(atMs, 'client', {fault, bytesHex: hex(bytes)}, connection);
    this.producer.open(); yield {kind: 'accept', connection};
    if (fault === 'helloTimeout') { yield {kind: 'helloTimeout'}; record.closedBy = 'helloTimeout'; }
    else {
      yield {kind: 'expect', bytes, endsInput};
      try { if (this.producer.receive(bytes, this.ns(atMs)).length) throw new Error(`Hello fault ${fault} was answered by the producer`); }
      catch (error) { if (!(error instanceof ProtocolError)) throw error; record.closedBy = 'serverRejected'; }
      if (record.closedBy !== 'serverRejected') { if (!endsInput) throw new Error(`Hello fault ${fault} was accepted by the producer`); record.closedBy = 'clientEof'; }
    }
    this.producer.close(this.ns(atMs));
    yield {kind: 'close', by: record.closedBy === 'clientEof' ? 'client' : 'server', graceful: false};
  }
  private *liveFault(atMs: number, fault: LiveFault): Generator<Effect, void, void> {
    const o = this.open; if (!o) throw new Error(`Client fault ${fault} needs an open connection`);
    o.record.actions.push({afterSeq: this.lastSeq(), action: 'fault', fault});
    const {bytes, endsInput} = liveFaultBytes(fault, o.client.faultContext(foreignSession(this.scenario.seed)));
    this.line(atMs, 'client', {fault, bytesHex: hex(bytes)});
    if (fault === 'stallRead') { o.stalled = true; yield {kind: 'stall'}; return; }
    yield {kind: 'expect', bytes, endsInput};
    let outs: Out[];
    try { outs = this.producer.receive(bytes, this.ns(atMs)); }
    catch (error) { if (!(error instanceof ProtocolError)) throw error; yield* this.closeClient(atMs, 'serverRejected', 'server', false); return; }
    for (const out of outs) yield* this.deliver(out, atMs);
    if (endsInput && this.open === o) yield* this.closeClient(atMs, 'clientEof', 'client', false);
  }
  private *wireFault(atMs: number, fault: WireFault): Generator<Effect, void, void> {
    const o = this.open; if (!o || o.stalled) throw new Error(`Wire fault ${fault} needs an open, reading connection`);
    if (fault === 'seqSkip') { this.producer.skipSeq(); this.line(atMs, 'server', {fault, bytesHex: ''}); return; }
    if (!o.last || !o.lastState) throw new Error(`Wire fault ${fault} needs a checkpoint on its connection`);
    const {bytes, endsOutput} = wireFaultBytes(fault, {last: o.last, lastState: o.lastState, lastEvent: o.lastEvent, nextEventSeq: BigInt(o.client.consumer.nextEventSeq),
      end: endData('plugin-shutdown', this.producer.store.endCursor()), foreignSessionId: foreignSession(this.scenario.seed)});
    this.line(atMs, 'server', {fault, bytesHex: hex(bytes)});
    yield {kind: 'write', bytes, endsOutput};
    // The client's FrameDecoder or V1Consumer must reject the fault: at once, or at the EOF that follows a cut frame.
    try { o.client.receive(bytes, CLIENT_BASE_NS + BigInt(atMs) * 1_000_000n); if (endsOutput) o.client.end(); }
    catch (error) { o.record.rejection = error instanceof Error ? error.message : 'rejected'; }
    if (o.record.rejection === undefined) throw new Error(`Wire fault ${fault} was accepted by the client`);
    yield* this.closeClient(atMs, 'clientRejected', endsOutput ? 'server' : 'client', endsOutput);
  }
  private *transport(atMs: number, step: TransportStep, connection: number): Generator<Effect, void, void> {
    switch (step.action) {
      case 'connect': yield* this.connect(atMs, connection, step.client); break;
      case 'disconnect': if (this.open) yield* this.closeClient(atMs, 'disconnect', 'server', true); break;
      case 'clientFault': yield* isHelloFault(step.fault) ? this.helloFault(atMs, connection, step.fault) : this.liveFault(atMs, step.fault as LiveFault); break;
      case 'wireFault': yield* this.wireFault(atMs, step.fault); break;
      case 'secondClient': {
        const o = this.open; if (!o || o.stalled) throw new Error('A second client needs an open, reading connection');
        o.record.actions.push({afterSeq: this.lastSeq(), action: 'secondClient'}); o.record.refusedClients++;
        yield {kind: 'secondClient'}; break;
      }
      case 'writeDeadline': {
        const o = this.open; if (!o?.stalled) throw new Error('A write deadline needs a stalled connection');
        yield {kind: 'flush', expectDeadline: true}; yield* this.closeClient(atMs, 'writeDeadline', 'server', false); break;
      }
    }
  }

  /** The transport effects of the whole scenario; returns the result. */
  *run(): Generator<Effect, ReplayResult, void> {
    const s = this.scenario, entries = timeline(s.steps, s.transport);
    for (const e of entries) {
      yield* this.fireTimers(e.atMs);
      this.atMs = e.atMs; yield {kind: 'time', atMs: e.atMs};
      if (e.lane === 'source') yield* this.apply(e.step);
      else if (e.lane === 'probe') {
        const o = this.open;
        if (o?.record.connection === e.connection && !o.stalled) {
          o.record.actions.push({afterSeq: this.lastSeq(), action: 'probe'});
          yield* this.fromClient(o.client.probe(String(++this.probeId), CLIENT_BASE_NS + BigInt(e.atMs) * 1_000_000n), e.atMs);
        }
      } else yield* this.transport(e.atMs, e.step, e.connection);
      yield* this.flush();
    }
    if (entries.length) yield* this.fireTimers(entries.at(-1)!.atMs);
    return this.result();
  }
  /**
   * Cancellation of a pipe run: a live connection receives `end` with reason plugin-shutdown at the current scenario
   * time (D14). Returns the frame to write, if any.
   */
  cancel(): Out | undefined {
    const o = this.open; if (!o || !this.producer.connected) return undefined;
    const out = this.producer.shutdown('plugin-shutdown', this.ns(this.atMs)); if (!out) return undefined;
    this.line(this.atMs, 'server', {message: out.message}); o.record.closedBy = 'end'; o.record.mappings = o.client.mappings; this.open = undefined;
    return out;
  }
  /** The result so far: the transcript, the connections, the ledger and the producer store. */
  result(): ReplayResult {
    const st = this.producer.store.status(), session = this.producer.source.pluginSessionId;
    return {scenario: this.scenario, transcript: this.transcript, faults: this.faults, connections: this.connections,
      ledger: {committedThroughEventSeq: this.ledger.through(session).toString(), committedEvents: this.ledger.committedEvents, committedGapMarkers: this.ledger.committedGapMarkers.toString(), duplicates: this.ledger.duplicates},
      store: {ackedThroughEventSeq: st.ackedThroughEventSeq.toString(), nextEventSeq: st.nextEventSeq.toString(), retainedEntries: st.retainedEntries, eventLoss: {...wireCounts(st.eventLoss)}},
      retired: this.producer.retired ?? null};
  }
}

/** Deterministic replay: every transport effect completes at once. */
export function replayV1(input: unknown): ReplayResult {
  const run = new V1Driver(input).run();
  for (let r = run.next(); ; r = run.next()) if (r.done) return r.value;
}

/** JSON lines of the transcript with each fault line at its place, as written by `cli.cjs replay-v1`. */
export function transcriptLines(result: ReplayResult): string[] {
  const out: string[] = []; let f = 0;
  const faults = (written: number) => {
    for (; f < result.faults.length && result.faults[f].beforeLine === written; f++) { const {beforeLine: _b, ...line} = result.faults[f]; void _b; out.push(JSON.stringify(line)); }
  };
  result.transcript.forEach((l, i) => { faults(i); out.push(JSON.stringify(l)); });
  faults(result.transcript.length);
  return out;
}
