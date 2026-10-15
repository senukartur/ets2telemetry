// V1Ingestion over actual Windows named pipes against the reactive protocol v1 simulator (ET-006b; REG-003, REG-005,
// REG-011). The ingestion is the production consumer: its own client instance, hello, clock probes, backoff and
// ACK pipeline. The durable sink is an in-memory stand-in built on the simulator's CommitLedger, never storage; real
// commits are in tests/storage/v1-durable-ingestion.test.ts. A scenario's scripted ACK and commit policies are applied
// around the ingestion (lost ACKs are dropped on the way to the pipe, a client that never commits holds its commits),
// so the served stream must equal replay-v1 (`reactiveDifferences`) and the ledger the hand-written expectation.
import net from 'node:net';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {FrameDecoder, decodePayload, type ClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {CommitResult, Result} from '../../packages/storage/src/api';
import {storageError} from '../../packages/storage/src/errors';
import type {CoverageMessage, DurableSink, WelcomeMessage} from '../../apps/desktop/src/durable-sink';
import {TEST_PIPE_PATTERN_V1, V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {CommitLedger, type ClientPolicy} from '../../tools/telemetry-simulator/src/v1/client';
import {TEST_PIPE_PATTERN_V1 as SIMULATOR_PATTERN} from '../../tools/telemetry-simulator/src/v1/pipe-host';
import {reactiveConflicts, reactiveDifferences, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {expectedPath, scenarioPath} from '../shared/simulator-v1-expected';

type Json = Record<string, unknown>;
const load = (id: string) => readFixtureFile(scenarioPath(id)) as Json;
const expectedLedger = (id: string) => (JSON.parse(readFileSync(expectedPath(id), 'utf8')) as {ledger: Json}).ledger;
const SCENARIOS = ['normal-delivery', 'pipe-reconnect', 'reconnect-lost-ack', 'app-absent-hydration', 'live-only', 'retention-expired', 'shutdown-end', 'sequence-exhausted'];

/** The in-memory durable sink: CommitLedger rows keyed by eventSeq, with the scripted commit policy of each connection. */
class LedgerSink implements DurableSink {
  constructor(readonly ledger: CommitLedger, private readonly run: Run) {}
  openSession(welcome: WelcomeMessage): Promise<Result<{committedThroughEventSeq: string}>> {
    return Promise.resolve({ok: true, value: {committedThroughEventSeq: this.ledger.through(welcome.source.pluginSessionId).toString()}});
  }
  async commit(m: CoverageMessage): Promise<Result<CommitResult>> {
    const connection = this.run.current();
    // A client that never commits: hold the command until its connection is gone, then fail it as retryable.
    if (connection?.policy.commit.kind === 'none') { await connection.closed; return {ok: false, error: storageError('DISK_FULL')}; }
    const session = m.source.pluginSessionId, first = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.firstEventSeq), last = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.lastEventSeq);
    const status = this.ledger.commit(session, first, last, m.kind === 'event' ? m : undefined);
    return {ok: true, value: {status, committedThroughEventSeq: this.ledger.through(session).toString()}};
  }
}

interface Connection {policy: ClientPolicy; acksPassed: number; acksDropped: number; closed: Promise<void>}
/** Numbers the welcomed connections in order and applies each scripted connection's ACK policy on the way to the pipe. */
class Run {
  readonly connections: Connection[] = [];
  constructor(private readonly policies: ClientPolicy[], private readonly onClosed: (index: number) => void) {}
  current(): Connection | undefined { return this.connections.at(-1); }
  connect = (endpoint: string) => {
    const socket = net.connect(endpoint), write = socket.write.bind(socket), decoder = new FrameDecoder('server');
    let connection: Connection | undefined, index = -1;
    // Registered before the ingestion's listeners, so a welcome is numbered before the ingestion applies it.
    socket.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk, m => {
          if (m.kind !== 'welcome' || connection) return;
          index = this.connections.length;
          const policy = this.policies[index]; if (!policy) throw new Error(`Unscripted connection ${index + 1}`);
          let close!: () => void;
          connection = {policy, acksPassed: 0, acksDropped: 0, closed: new Promise<void>(r => { close = r; })};
          this.connections.push(connection);
          socket.once('close', () => { close(); this.onClosed(index); });
        });
      } catch { /* the ingestion's own decoder reports the violation */ }
    });
    socket.write = ((bytes: Uint8Array, ...rest: unknown[]) => {
      const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage;
      if (m.kind === 'ack' && connection) {
        const ack = connection.policy.ack;
        const lost = ack.kind === 'withhold' || (ack.kind === 'dropAfter' && connection.acksPassed >= ack.count);
        if (lost) { connection.acksDropped++; return true; }
        connection.acksPassed++;
      }
      return (write as (...args: unknown[]) => boolean)(bytes, ...rest);
    });
    return socket;
  };
}

/**
 * Serves one scenario reactively and runs ingestions against it: one with the ledger sink for durable connections,
 * one without a sink for live-only ones (each new ingestion is a new service instance). An ingestion is stopped when
 * the last scripted connection it owns closes, so it never connects to a finished scenario.
 */
async function runScenario(id: string, scale: number) {
  const input = load(id), replay = replayV1(input);
  const sessions = replay.connections.filter(c => !c.helloFault), policies = sessions.map(c => c.policy!);
  const ledger = new CommitLedger(), source = scenarioSource(replay.scenario);
  if (replay.scenario.source.startEventSeq > 1n) ledger.seed(source.pluginSessionId, replay.scenario.source.startEventSeq - 1n);
  const server = await serveV1Reactive(input, {scale});
  const states: V1SourceState[] = [];
  let ingestion: V1Ingestion | undefined, finished!: () => void;
  const allClosed = new Promise<void>(r => { finished = r; });
  const run: Run = new Run(policies, index => {
    const owner = ingestion, next = policies[index + 1];
    // A stopped ingestion never connects again: its pending reconnection checks that it was stopped.
    if (!next) { void owner?.stop(); finished(); return; }
    if (next.durable !== policies[index].durable) { void owner?.stop(); ingestion = start(next.durable); }
  });
  const start = (durable: boolean) => {
    const next = new V1Ingestion({connect: run.connect, sink: durable ? new LedgerSink(ledger, run) : undefined, onState: s => states.push(s)});
    next.select('synthetic', server.endpoint); return next;
  };
  try {
    ingestion = start(policies[0].durable);
    const report = await server.done;
    await allClosed;
    return {replay, report, ledger, states, run};
  } finally { await ingestion?.stop(); await server.stop(); }
}

describe('ET-006b ingestion over actual pipes with the reactive v1 simulator', () => {
  it('uses the simulator endpoint pattern and only scenarios that reactive serving reproduces', () => {
    expect(TEST_PIPE_PATTERN_V1.source).toBe(SIMULATOR_PATTERN.source);
    for (const id of SCENARIOS) expect(reactiveConflicts(load(id)), id).toEqual([]);
  });

  const runs: [string, number][] = [...SCENARIOS.map(id => [id, 0] as [string, number]), ['normal-delivery', 1], ['pipe-reconnect', 1]];
  for (const [id, scale] of runs) it(`ingests ${id} as replayed, with the hand-written ledger (scale ${scale})`, async () => {
    const {replay, report, ledger, states, run} = await runScenario(id, scale);
    expect(reactiveDifferences(replay, report)).toEqual([]);
    const session = scenarioSource(replay.scenario).pluginSessionId;
    expect({committedThroughEventSeq: ledger.through(session).toString(), committedEvents: ledger.committedEvents, committedGapMarkers: ledger.committedGapMarkers.toString(), duplicates: ledger.duplicates})
      .toMatchObject(expectedLedger(id));
    expect(run.connections).toHaveLength(replay.connections.filter(c => !c.helloFault).length);
    // The ingestion never rejected the simulator's stream and never lost durable delivery.
    expect(states.filter(s => s.status === 'incompatible')).toEqual([]);
    expect(states.filter(s => s.durable.state === 'failed')).toEqual([]);
  }, 60_000);

  it('acknowledges in the replayed order on a connection whose later ACKs are lost', async () => {
    const {report, run} = await runScenario('reconnect-lost-ack', 0);
    const acks = (connection: number) => report.transcript.filter(l => l.connection === connection && l.direction === 'client' && l.message.kind === 'ack')
      .map(l => (l.message as Extract<ClientMessage, {kind: 'ack'}>).data.throughEventSeq);
    // Hand-written from reconnect-lost-ack.expected.json: the first connection's ACK of 1 arrives, the later ones are lost;
    // the second connection receives 2 and 3 again and acknowledges 2, 3 and then the offline gap 4.
    expect([acks(1), acks(2)]).toEqual([['1'], ['2', '3', '4']]);
    expect(run.connections.map(c => c.acksDropped)).toEqual([2, 0]);
    const served = report.transcript.filter(l => l.connection === 2 && l.direction === 'server' && (l.message.kind === 'event' || l.message.kind === 'gap')).map(l => l.message as ServerMessage);
    expect(served.map(m => m.kind === 'event' ? `${m.data.eventSeq}${m.data.redelivered ? 'r' : ''}` : m.kind === 'gap' ? `gap ${m.data.firstEventSeq}-${m.data.lastEventSeq}` : '')).toEqual(['2r', '3r', 'gap 4-4']);
  }, 60_000);
});
