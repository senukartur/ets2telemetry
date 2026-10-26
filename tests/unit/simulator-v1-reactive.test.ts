import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {describe, expect, it} from 'vitest';
import {FrameDecoder, PROTOCOL_V1, V1_MAX_MINOR, encodeFrame as encodeAnyMinor, type ProtocolMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
// ET-050b: these raw clients offer the contract's highest minor (2 since ET-052). The simulator producer is pinned to
// minor 1 until ET-052 PR-4, so their connections are minor 1 and every frame after the hello carries {1,1}.
const M1 = {major: 1, minor: 1} as const;
const encodeFrame = (message: ProtocolMessage) => encodeAnyMinor(message, {maxMinor: V1_MAX_MINOR});
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {rawFrame} from '../../tools/telemetry-simulator/src/v1/faults';
import {reactiveConflicts, reactiveDifferences, runIndependentClient, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {scenarioPath} from '../shared/simulator-v1-expected';

type Json = Record<string, unknown>;
const load = (id: string) => readFixtureFile(scenarioPath(id)) as Json;
const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
const inline = (steps: Json[], transport: Json[]): Json => ({format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id: 'reactive-test', purpose: 'Reactive test', reg: ['REG-011'],
  origin: 'synthetic', game: 'ets2', seed: 'reactive-test', provenance: null, source: SOURCE, steps, transport});
/** A hello from a client instance the simulator has never seen. */
const hello = (durableEvents: boolean) => encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: V1_MAX_MINOR, durableEvents}});
function rawClient(endpoint: string, first?: Uint8Array) {
  const socket = net.connect(endpoint), decoder = new FrameDecoder('server', {maxMinor: V1_MAX_MINOR}), messages: ServerMessage[] = [];
  let bytes = 0;
  const closed = new Promise<{bytes: number; messages: ServerMessage[]}>(resolve => {
    socket.on('data', chunk => { bytes += chunk.length; decoder.push(chunk, m => messages.push(m as ServerMessage)); });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve({bytes, messages}));
  });
  socket.on('connect', () => { if (first) socket.write(first); });
  return {socket, messages, closed};
}
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const start = performance.now();
  while (!check()) { if (performance.now() - start > ms) throw new Error('Condition deadline'); await new Promise(r => setTimeout(r, 5)); }
}

describe('simulator v1 reactive serving for any contract consumer', () => {
  // An independent consumer: its own client instance IDs, its own seeded random delay before every write and one clock
  // probe per connection, following only each scripted connection's durability, commit and ACK policy. The server's
  // events, gaps, checkpoints and `end` must equal replay-v1 except the message seq, its snapshots must equal in state
  // and continuity, and the consumer's ledger must equal the replay's.
  const ids = ['normal-delivery', 'reconnect-lost-ack', 'ack-inside-gap', 'queue-count-overflow', 'crash-before-commit', 'crash-after-commit', 'sequence-exhausted', 'pipe-reconnect'];
  // Paced, and unpaced: then steps follow each other without real time between them, and only the bounded quiesce
  // before each source step, before `end` and at each scripted disconnect aligns the client's ACKs and crashes with them.
  for (const scale of [1, 0]) ids.forEach((id, i) => it(`serves ${id} to an independent consumer as replayed (scale ${scale})`, async () => {
    const input = load(id), replay = replayV1(input), server = await serveV1Reactive(input, {scale});
    try {
      const [client, report] = await Promise.all([runIndependentClient(server.endpoint, input, {seed: 1_000 + i, maxDelayMs: 5, probe: true}), server.done]);
      expect(reactiveDifferences(replay, report)).toEqual([]);
      expect(client.ledger).toEqual(replay.ledger);
      expect(report.connections.map(c => c.clientInstanceId)).not.toContain(seededId(input.seed as string, 'client-instance-1'));
      for (const s of client.sessions) expect(s.replies).toBeLessThanOrEqual(s.probes);
    } finally { await server.stop(); }
  }, 60_000));

  it('detects a consumer whose ACKs differ from the scripted policy', async () => {
    const input = load('reconnect-lost-ack'), replay = replayV1(input), server = await serveV1Reactive(input, {scale: 1});
    // The consumer acknowledges everything where the scenario loses its later ACKs, so nothing is redelivered.
    const acksAll = structuredClone(input); ((acksAll.transport as Json[])[0].client as Json).ack = 'each';
    try {
      const [, report] = await Promise.all([runIndependentClient(server.endpoint, acksAll, {seed: 7}), server.done]);
      expect(reactiveDifferences(replay, report).length).toBeGreaterThan(0);
    } finally { await server.stop(); }
  }, 60_000);

  it('answers a client clock probe at the paced scenario time', async () => {
    const s = inline([{atMs: 10, action: 'lifecycle', event: 'simulation.started'}], [{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 60_000, action: 'disconnect'}]);
    const server = await serveV1Reactive(s, {scale: 1});
    try {
      const client = rawClient(server.endpoint, hello(false));
      await until(() => client.messages.length === 2);
      client.socket.write(encodeFrame({version: M1, kind: 'clock.probe', data: {probeId: '1'}}));
      await until(() => client.messages.some(m => m.kind === 'clock.reply'));
      await server.stop();
      const {messages} = await client.closed, consumer = new V1Consumer(false, {maxMinor: V1_MAX_MINOR});
      for (const m of messages) { if (m.kind === 'clock.reply') consumer.expectClockReply('1'); consumer.accept(m); }
      const reply = messages.find(m => m.kind === 'clock.reply')!;
      if (reply.kind !== 'clock.reply') throw new Error('reply');
      // received = sent, within the paced segment: after the checkpoint at 0 ms and before the disconnect at 60 s.
      const at = BigInt(reply.data.receivedMonotonicNs) - 1_000_000_000_000n;
      expect(reply.data.sentMonotonicNs).toBe(reply.data.receivedMonotonicNs);
      expect(at >= 0n && at < 60_000_000_000n).toBe(true);
      expect(messages.at(-1)?.kind).toBe('end');
    } finally { await server.stop(); }
  }, 60_000);

  it('accepts any client instance, refuses a second client at once and keeps the first', async () => {
    const s = inline([{atMs: 10, action: 'frame', channels: {speed: 1}}, {atMs: 300, action: 'frame', channels: {speed: 2}}],
      [{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 600_000, action: 'disconnect'}]);
    const server = await serveV1Reactive(s, {scale: 1});
    try {
      // The first connection stays open for ten minutes of scenario time, so the second client always meets it.
      const first = rawClient(server.endpoint, hello(false));
      await until(() => first.messages.length >= 2);
      const second = rawClient(server.endpoint, hello(false));
      expect(await second.closed).toEqual({bytes: 0, messages: []});
      await until(() => first.messages.length >= 4);
      await server.stop();
      const {messages} = await first.closed;
      expect(messages.map(m => m.kind === 'snapshot' && m.data.state.speed.available ? m.data.state.speed.value : m.kind)).toEqual(['welcome', 'checkpoint', 1, 2, 'end']);
      const report = await server.done;
      expect([report.refusedClients, report.cancelled, report.connections.map(c => c.closedBy)]).toEqual([1, true, ['end']]);
    } finally { await server.stop(); }
  }, 60_000);

  // A client crash on the last item of a step, with a snapshot due before the next step and a reconnection exactly at
  // the replay's retention deadline: the crashed client gets no snapshot, and the connection is closed at the crash's
  // own scenario time (30 ms), so the retained event has expired when the next client connects.
  for (const scale of [1, 0]) it(`closes a crashed client at its step and writes it no pending snapshot (scale ${scale})`, async () => {
    const s = inline([{atMs: 10, action: 'lifecycle', event: 'simulation.started'}, {atMs: 20, action: 'frame', channels: {speed: 1}}, {atMs: 30, action: 'lifecycle', event: 'simulation.paused'}],
      [{atMs: 0, action: 'connect', client: {durable: true, commit: 'failAt:2'}}, {atMs: 100, action: 'disconnect'}, {atMs: 300_030, action: 'connect', client: {durable: true}}, {atMs: 300_100, action: 'disconnect'}]);
    const replay = replayV1(s);
    expect(replay.transcript.filter(l => l.connection === 1 && l.message.kind === 'snapshot')).toHaveLength(0);
    expect(replay.store.eventLoss.retentionExpired).toBe('1');
    const server = await serveV1Reactive(s, {scale});
    try {
      const [client, report] = await Promise.all([runIndependentClient(server.endpoint, s, {seed: 11}), server.done]);
      expect(reactiveDifferences(replay, report)).toEqual([]);
      expect(client.ledger).toEqual(replay.ledger);
      expect(report.connections.map(c => c.closedBy)).toEqual(['client', 'disconnect']);
    } finally { await server.stop(); }
  }, 60_000);

  it('rejects scenarios whose client reactions inside one action change the outcome', async () => {
    const tollgates = (repeat: number) => ({atMs: 10, action: 'gameplay', id: 'player.tollgate.paid', attributes: [{name: 'pay.amount', sdkType: 's64', value: '1'}], repeat});
    // (A) Releases between the writes of one step keep 300 events within the 256-entry store bound in the replay only.
    const bound = inline([tollgates(300)], [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 100, action: 'disconnect'}]);
    expect(replayV1(bound).store.eventLoss.queueCount).toBe('0');
    expect(reactiveConflicts(bound).join()).toMatch(/store bound \(A\)/);
    await expect(serveV1Reactive(bound)).rejects.toThrow(/lockstep mode.*\(A\)/);
    // (B) A crash on the first of two events of one step, and a crash on the first redelivered of three.
    const midStep = inline([tollgates(2)], [{atMs: 0, action: 'connect', client: {durable: true, commit: 'failAt:1'}}, {atMs: 100, action: 'disconnect'}]);
    expect(reactiveConflicts(midStep).join()).toMatch(/\(B\)/);
    await expect(serveV1Reactive(midStep)).rejects.toThrow(/lockstep mode.*\(B\)/);
    const redelivery = inline([tollgates(3)], [{atMs: 0, action: 'connect', client: {durable: true, ack: 'withhold'}}, {atMs: 100, action: 'disconnect'},
      {atMs: 200, action: 'connect', client: {durable: true, commit: 'failAt:1'}}, {atMs: 300, action: 'disconnect'}]);
    expect(reactiveConflicts(redelivery).join()).toMatch(/\(B\)/);
    // Every corpus scenario the reactive tests run is accepted.
    for (const id of ids) expect(reactiveConflicts(load(id))).toEqual([]);
  });

  it('ends a rejected hello attempt only, and requires the scripted durability', async () => {
    const s = inline([], [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 10, action: 'disconnect'}]);
    const server = await serveV1Reactive(s, {scale: 0});
    try {
      const bad = rawClient(server.endpoint, rawFrame('{"version":'));
      expect(await bad.closed).toEqual({bytes: 0, messages: []});
      const good = rawClient(server.endpoint, hello(true));
      expect((await good.closed).messages.map(m => m.kind)).toEqual(['welcome', 'checkpoint']);
      expect((await server.done).connections).toMatchObject([{rejectedAttempts: 1, closedBy: 'disconnect'}]);
    } finally { await server.stop(); }
    const strict = await serveV1Reactive(s, {scale: 0});
    try {
      rawClient(strict.endpoint, hello(false));
      await expect(strict.done).rejects.toThrow(/expects a durable client/);
    } finally { await strict.stop(); }
  }, 60_000);

  // A consumer that follows the script but commits slower than the quiesce bound, as the real storage worker on a
  // stalled host did (ET-006b storage suite, October 15, 2026): with `awaitScriptedAcks` its late ACK is still awaited
  // and recorded before the scripted disconnect, a client that neither acknowledges nor leaves fails the run, and a
  // connection scripted to withhold its ACKs keeps the bounded wait.
  it('awaits a scripted ACK slower than the quiesce bound when asked to', async () => {
    const steps = [{atMs: 10, action: 'lifecycle', event: 'simulation.started'}];
    const s = inline(steps, [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 100, action: 'disconnect'}]);
    const ack = (welcome: ServerMessage) => encodeFrame({version: M1, kind: 'ack', data: {pluginSessionId: welcome.source.pluginSessionId, throughEventSeq: '1'}});
    const slow = await serveV1Reactive(s, {scale: 0, quiesceMs: 20, awaitScriptedAcks: true});
    try {
      const client = rawClient(slow.endpoint, hello(true));
      await until(() => client.messages.some(m => m.kind === 'event'));
      // Ten quiesce bounds after the event was written.
      await new Promise(resolve => setTimeout(resolve, 200));
      client.socket.write(ack(client.messages[0]));
      const report = await slow.done;
      expect(report.transcript.filter(l => l.direction === 'client' && l.message.kind === 'ack').map(l => l.message.kind === 'ack' && l.message.data.throughEventSeq)).toEqual(['1']);
      expect(report.connections.map(c => c.closedBy)).toEqual(['disconnect']);
      expect(reactiveDifferences(replayV1(s), report)).toEqual([]);
    } finally { await slow.stop(); }
    const silent = await serveV1Reactive(s, {scale: 0, awaitScriptedAcks: true, settleTimeoutMs: 100});
    try {
      rawClient(silent.endpoint, hello(true));
      await expect(silent.done).rejects.toThrow(/Connection 1: the client neither acknowledged everything written to it nor left within 100 ms/);
    } finally { await silent.stop(); }
    const withheld = inline(steps, [{atMs: 0, action: 'connect', client: {durable: true, ack: 'withhold'}}, {atMs: 100, action: 'disconnect'}]);
    const bounded = await serveV1Reactive(withheld, {scale: 0, quiesceMs: 20, awaitScriptedAcks: true, settleTimeoutMs: 1});
    try {
      rawClient(bounded.endpoint, hello(true));
      expect((await bounded.done).connections.map(c => c.closedBy)).toEqual(['disconnect']);
    } finally { await bounded.stop(); }
    await expect(serveV1Reactive(s, {settleTimeoutMs: 0})).rejects.toThrow(/Invalid settle timeout/);
  }, 60_000);

  it('runs only scenarios whose client is not scripted', async () => {
    await expect(serveV1Reactive(load('wire-faults'))).rejects.toThrow(/lockstep/);
    await expect(serveV1Reactive(load('pipe-stalled-reader'))).rejects.toThrow(/lockstep/);
  });
});
