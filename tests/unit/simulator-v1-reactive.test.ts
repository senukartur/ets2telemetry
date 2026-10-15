import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {describe, expect, it} from 'vitest';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {rawFrame} from '../../tools/telemetry-simulator/src/v1/faults';
import {reactiveDifferences, runIndependentClient, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {scenarioPath} from '../shared/simulator-v1-expected';

type Json = Record<string, unknown>;
const load = (id: string) => readFixtureFile(scenarioPath(id)) as Json;
const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
const inline = (steps: Json[], transport: Json[]): Json => ({format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id: 'reactive-test', purpose: 'Reactive test', reg: ['REG-011'],
  origin: 'synthetic', game: 'ets2', seed: 'reactive-test', provenance: null, source: SOURCE, steps, transport});
/** A hello from a client instance the simulator has never seen. */
const hello = (durableEvents: boolean) => encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents}});
function rawClient(endpoint: string, first?: Uint8Array) {
  const socket = net.connect(endpoint), decoder = new FrameDecoder('server'), messages: ServerMessage[] = [];
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
  const ids = ['normal-delivery', 'reconnect-lost-ack', 'ack-inside-gap', 'queue-count-overflow', 'crash-after-commit', 'pipe-reconnect'];
  ids.forEach((id, i) => it(`serves ${id} to an independent consumer as replayed`, async () => {
    const input = load(id), replay = replayV1(input), server = await serveV1Reactive(input, {scale: 1});
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
      client.socket.write(encodeFrame({version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: '1'}}));
      await until(() => client.messages.some(m => m.kind === 'clock.reply'));
      await server.stop();
      const {messages} = await client.closed, consumer = new V1Consumer(false);
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
      [{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 400, action: 'disconnect'}]);
    const server = await serveV1Reactive(s, {scale: 1});
    try {
      const first = rawClient(server.endpoint, hello(false));
      await until(() => first.messages.length >= 2);
      const second = rawClient(server.endpoint, hello(false));
      expect(await second.closed).toEqual({bytes: 0, messages: []});
      const {messages} = await first.closed;
      expect(messages.map(m => m.kind === 'snapshot' && m.data.state.speed.available ? m.data.state.speed.value : m.kind)).toEqual(['welcome', 'checkpoint', 1, 2]);
      const report = await server.done;
      expect([report.refusedClients, report.connections.map(c => c.closedBy)]).toEqual([1, ['disconnect']]);
    } finally { await server.stop(); }
  }, 60_000);

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

  it('runs only scenarios whose client is not scripted', async () => {
    await expect(serveV1Reactive(load('wire-faults'))).rejects.toThrow(/lockstep/);
    await expect(serveV1Reactive(load('pipe-stalled-reader'))).rejects.toThrow(/lockstep/);
  });
});
