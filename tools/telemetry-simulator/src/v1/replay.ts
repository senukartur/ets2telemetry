// Deterministic protocol v1 replay (ET-005b): drives the adapter model, the producer and the scripted client on one
// virtual clock and returns the ordered wire transcript. Each server message is applied by the client synchronously and
// each client reply is processed by the producer before the next action, so two runs are byte-identical.
import {type ProtocolMessage, type SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type ClientOutput, type MappingResult} from './client';
import {V1Producer, type Out} from './producer';
import {timeline, validateScenario, type Scenario, type SourceStep} from './scenario';
import {AdapterModel, ScenarioClock, seededId} from './source';
import {wireCounts} from './store';

export const MAX_TRANSCRIPT_MESSAGES = 20_000;
/** The scripted client's own monotonic clock, with an origin independent of the source clock (§11). */
export const CLIENT_BASE_NS = 5_000_000_000_000n;
export interface TranscriptLine {scenario: string; origin: 'synthetic'; connection: number; atMs: number; direction: 'server' | 'client'; message: ProtocolMessage}
export interface ConnectionRecord {connection: number; durableRequested: boolean; clientInstanceId: string; closedBy: 'disconnect' | 'crash' | 'end' | 'open'; mappings: MappingResult[]}
export interface ReplayResult {
  scenario: Scenario; transcript: TranscriptLine[]; connections: ConnectionRecord[];
  ledger: {committedThroughEventSeq: string; committedEvents: number; committedGapMarkers: string; duplicates: number};
  store: {ackedThroughEventSeq: string; nextEventSeq: string; retainedEntries: number; eventLoss: Record<string, string>}; retired: string | null;
}
/** The fixed synthetic source identity of a scenario; every identifier derives from its seed. */
export function scenarioSource(s: Pick<Scenario, 'game' | 'seed'>): SourceIdentity {
  return {game: s.game, pluginSessionId: seededId(s.seed, 'plugin-session'), processInstanceId: seededId(s.seed, 'process-instance'), processId: 1, windowsSessionId: 0, origin: 'synthetic'};
}

export function replayV1(input: unknown): ReplayResult {
  const s = validateScenario(input), clock = new ScenarioClock(), adapter = new AdapterModel({game: s.game, seed: s.seed, ...s.source}, clock);
  const source = scenarioSource(s), producer = new V1Producer(adapter, source, seededId(s.seed, 'capture-clock')), ledger = new CommitLedger();
  if (s.source.startEventSeq > 1n) ledger.seed(source.pluginSessionId, s.source.startEventSeq - 1n);
  const transcript: TranscriptLine[] = [], connections: ConnectionRecord[] = [];
  let client: ScriptedClient | undefined, record: ConnectionRecord | undefined, instance = 0, cursors = new Map<string, DurableAckCursor>(), probeId = 0, newInstance = true;

  const line = (atMs: number, direction: TranscriptLine['direction'], message: ProtocolMessage) => {
    if (transcript.length >= MAX_TRANSCRIPT_MESSAGES) throw new Error('Simulator transcript limit exceeded');
    transcript.push({scenario: s.id, origin: s.origin, connection: record?.connection ?? 0, atMs, direction, message});
  };
  const closeClient = (atMs: number, closedBy: ConnectionRecord['closedBy']) => {
    producer.close(clock.sourceNs(atMs));
    if (record) { record.closedBy = closedBy; record.mappings = client!.mappings; }
    if (closedBy === 'crash') newInstance = true;
    client = undefined; record = undefined;
  };
  // Client messages reach the producer before anything else happens; its replies go back the same way.
  const fromClient = (output: ClientOutput, atMs: number) => {
    output.messages.forEach((m, i) => { line(atMs, 'client', m); producer.receive(output.frames[i], clock.sourceNs(atMs)).forEach(out => deliver(out, atMs)); });
    if (output.crashed && client) closeClient(atMs, 'crash');
  };
  function deliver(out: Out, atMs: number): void {
    line(atMs, 'server', out.message);
    if (!client) throw new Error('Server message without a client');
    fromClient(client.receive(out.frame, CLIENT_BASE_NS + BigInt(atMs) * 1_000_000n), atMs);
    if (out.message.kind === 'end' && client) closeClient(atMs, 'end');
  }
  const pumpAll = (atMs: number) => {
    for (let out = producer.pump(clock.sourceNs(atMs)); out; out = producer.pump(clock.sourceNs(atMs))) deliver(out, atMs);
  };
  const settle = (atMs: number) => { producer.drain(clock.sourceNs(atMs)); pumpAll(atMs); };
  // Timers fire at their own scenario time, before any step at or after it; a retention expiry before a snapshot.
  const fireTimers = (untilMs: number) => {
    for (;;) {
      const due = producer.dueNs(), expiryAt = due.expiry === undefined ? Infinity : clock.atMsFor(due.expiry), snapshotAt = due.snapshot === undefined ? Infinity : clock.atMsFor(due.snapshot);
      const at = Math.min(expiryAt, snapshotAt); if (at > untilMs) return;
      if (expiryAt === at) producer.expire(clock.sourceNs(at));
      else { const out = producer.fireSnapshot(clock.sourceNs(at)); if (out) deliver(out, at); }
    }
  };
  const apply = (step: SourceStep) => {
    const at = step.atMs;
    switch (step.action) {
      case 'configuration': case 'gameplay':
        for (let i = 0; i < step.repeat; i++) { adapter[step.action](step.id, step.attributes, step.list, at); settle(at); } break;
      case 'lifecycle': adapter.lifecycle(step.event, at); settle(at); break;
      case 'frame': {
        adapter.frame(step.timerRestart, step.channels, at); settle(at);
        const out = producer.publication(clock.sourceNs(at)); if (out) deliver(out, at); break;
      }
      case 'gameMode': adapter.determineGameMode(step.mode, at); settle(at); break;
      case 'encodingFailure': for (let i = 0; i < step.count; i++) { adapter.unencodable(1, at); settle(at); } break;
      case 'handoff': adapter.channel.full = step.full; break;
      case 'utcJump': clock.utcJump(step.deltaMs); break;
      case 'suspend': clock.suspend(at, step.durationMs, step.sourceClockAdvances); break;
      case 'shutdown': {
        settle(at); const out = producer.shutdown(step.reason, clock.sourceNs(at));
        if (out) deliver(out, at); else if (client) closeClient(at, 'end');
        break;
      }
    }
  };

  const entries = timeline(s.steps, s.transport);
  for (const e of entries) {
    fireTimers(e.atMs);
    if (e.lane === 'source') { apply(e.step); continue; }
    if (e.lane === 'probe') { if (client && record?.connection === e.connection) fromClient(client.probe(String(++probeId), CLIENT_BASE_NS + BigInt(e.atMs) * 1_000_000n), e.atMs); continue; }
    if (e.step.action === 'disconnect') { if (client) closeClient(e.atMs, 'disconnect'); continue; }
    if (newInstance) { instance++; cursors = new Map(); newInstance = false; }
    const clientInstanceId = seededId(s.seed, `client-instance-${instance}`);
    client = new ScriptedClient(ledger, e.step.client, clientInstanceId, seededId(s.seed, `client-clock-${instance}`), cursors);
    record = {connection: e.connection, durableRequested: e.step.client.durable, clientInstanceId, closedBy: 'open', mappings: client.mappings};
    connections.push(record); probeId = 0;
    producer.open(); fromClient(client.hello(), e.atMs);
    if (client) pumpAll(e.atMs);
  }
  if (entries.length) fireTimers(entries.at(-1)!.atMs);
  const st = producer.store.status();
  return {scenario: s, transcript, connections,
    ledger: {committedThroughEventSeq: ledger.through(source.pluginSessionId).toString(), committedEvents: ledger.committedEvents, committedGapMarkers: ledger.committedGapMarkers.toString(), duplicates: ledger.duplicates},
    store: {ackedThroughEventSeq: st.ackedThroughEventSeq.toString(), nextEventSeq: st.nextEventSeq.toString(), retainedEntries: st.retainedEntries, eventLoss: {...wireCounts(st.eventLoss)}},
    retired: producer.retired ?? null};
}

/** JSON lines of the transcript, as written by `cli.cjs replay-v1`. */
export function transcriptLines(result: ReplayResult): string[] { return result.transcript.map(l => JSON.stringify(l)); }
