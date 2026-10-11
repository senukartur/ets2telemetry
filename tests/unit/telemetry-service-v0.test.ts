import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {TelemetryIngestion, TEST_PIPE_PATTERN, initialLive, sourceSelection} from '../../apps/desktop/src/telemetry-ingestion';
import {LiveSubscriptions, type LivePort} from '../../apps/desktop/src/live-subscriptions';
import {ServiceSupervisor} from '../../apps/desktop/src/service-supervisor';
import {FrameDecoder, encodeFrame} from '../../packages/contracts/src/protocol-v0';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {replay, type Scenario} from '../../tools/telemetry-simulator/src/scenario';
import {startPipe} from '../../tools/telemetry-simulator/src/pipe';
const scenario = JSON.parse(readFileSync('tests/fixtures/simulator-v0/reconnect.json', 'utf8')) as Scenario;
const emissions = replay(scenario);
const endpoint = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-123-' + randomUUID();
class TestSocket extends EventEmitter {
  writes: Uint8Array[] = [];
  destroyed = false;
  write(bytes: Uint8Array): void {this.writes.push(bytes);}
  destroy(): void {this.destroyed = true; this.emit('close');}
}
class TestPort extends EventEmitter implements LivePort {
  messages: Array<{type: string; delivery: number; update: LiveTelemetry}> = [];
  closed = false;
  postMessage(value: unknown): void {this.messages.push(value as typeof this.messages[number]);}
  start(): void {}
  close(): void {if (!this.closed) {this.closed = true; this.emit('close');}}
  consume(): void {this.emit('message', {data: {type: 'consumed', delivery: this.messages.at(-1)!.delivery}});}
}
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers(); const updates: LiveTelemetry[] = []; const sockets: TestSocket[] = []; let now = 0;
  const ingestion = new TelemetryIngestion(state => updates.push(state), {now: () => now, connect: () => {const socket = new TestSocket(); sockets.push(socket); return socket;}});
  ingestion.select('synthetic', endpoint);
  return {ingestion, updates, sockets, time: (value: number) => {now = value;}};
}
describe('v0 utility ingestion', () => {
  it('requires every game envelope to match retained native authority and waits for an old broker to finish before starting another', async () => {
    vi.useFakeTimers(); const updates: LiveTelemetry[] = []; const sockets: Array<TestSocket & {authority: SourceIdentity; completion: Promise<void>}> = [];
    let finish!: () => void;
    const authority: SourceIdentity = {...emissions[0].message.source, game: 'ets2', origin: 'game'};
    const ingestion = new TelemetryIngestion(update => updates.push(update), {broker: {executable: 'fixed', discoveryDirectory: 'fixed'}, connectGame: () => {
      const socket = Object.assign(new TestSocket(), {authority, completion: new Promise<void>(resolve => {finish = resolve;})}); sockets.push(socket); return socket;
    }});
    ingestion.select('ets2'); const first = sockets[0]; first.emit('connect');
    for (const emission of emissions.slice(0, 2)) {const message = structuredClone(emission.message); message.source = {...authority}; first.emit('data', encodeFrame(message));}
    expect(updates.at(-1)?.fresh).toBe(true);
    const changed = structuredClone(emissions[2].message); changed.source = {...authority, processId: authority.processId + 1}; first.emit('data', encodeFrame(changed));
    expect(updates.at(-1)?.status).toBe('incompatible');
    for (let i = 0; i < 1000; i++) ingestion.select(i % 2 ? 'ets2' : 'ats'); expect(sockets).toHaveLength(1);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(sockets).toHaveLength(2); expect(updates.at(-1)?.selection).toBe('ets2');
    const stop = ingestion.stop(); finish(); await stop; expect(vi.getTimerCount()).toBe(0);
  });
  it('sends one hello per connection and waits for checkpoint before marking fresh', async () => {
    const f = fixture(), socket = f.sockets[0]; socket.emit('connect');
    const decoder = new FrameDecoder(); const hello: unknown[] = []; decoder.push(socket.writes[0], value => hello.push(value));
    expect(hello).toMatchObject([{kind: 'hello', data: {diagnostics: false}}]); expect(socket.writes).toHaveLength(1);
    socket.emit('data', emissions[0].frame); expect(f.updates.at(-1)?.fresh).toBe(false); expect(f.updates.at(-1)?.observation).toBeUndefined();
    for (const byte of emissions[1].frame) socket.emit('data', Uint8Array.of(byte));
    expect(f.updates.at(-1)).toMatchObject({status: 'paused', fresh: true, coverage: 'unknown', recording: false, observation: {applied: {hydration: true}, state: {speed: {available: true, value: 0}}}});
    f.time(500); await vi.advanceTimersByTimeAsync(500); expect(f.updates.at(-1)).toMatchObject({status: 'stale', fresh: false});
    await f.ingestion.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['duplicate', 'identity', 'oversize', 'direction', 'origin', 'clock'])('closes %s input without applying later state or reconnecting', async fault => {
    const f = fixture(), socket = f.sockets[0]; socket.emit('connect');
    socket.emit('data', Buffer.concat([emissions[0].frame, emissions[1].frame]));
    let bytes = emissions[1].frame;
    if (fault === 'identity' || fault === 'origin') {const message = structuredClone(emissions[2].message); if (fault === 'identity') message.source.processId++; else message.source.origin = 'game'; bytes = encodeFrame(message);}
    if (fault === 'oversize') bytes = Uint8Array.of(1, 0, 1, 0);
    if (fault === 'direction') bytes = socket.writes[0];
    if (fault === 'clock') {f.time(-1); bytes = emissions[2].frame;}
    socket.emit('data', bytes); const last = f.updates.at(-1); expect(last?.status).toBe('incompatible'); expect(last?.fresh).toBe(false); expect(socket.destroyed).toBe(true);
    socket.emit('data', emissions[2].frame); await vi.advanceTimersByTimeAsync(10000); expect(f.updates.at(-1)).toBe(last); expect(f.sockets).toHaveLength(1);
    await f.ingestion.stop();
  });
  it('reconnects with a fresh handshake and never treats old state as fresh', async () => {
    const f = fixture(), first = f.sockets[0]; first.emit('connect'); first.emit('data', Buffer.concat([emissions[0].frame, emissions[1].frame])); first.emit('end');
    expect(f.updates.at(-1)).toMatchObject({status: 'disconnected', fresh: false});
    const reconnect = emissions.filter(emission => emission.connection === 2);
    await vi.advanceTimersByTimeAsync(250); const second = f.sockets[1]; second.emit('connect'); second.emit('data', reconnect[0].frame);
    expect(f.updates.at(-1)?.fresh).toBe(false);
    second.emit('data', reconnect[1].frame); expect(f.updates.at(-1)).toMatchObject({fresh: true, observation: {applied: {hydration: true}}});
    first.emit('data', emissions[2].frame); expect(f.updates.at(-1)?.observation?.seq).toBe(reconnect[1].message.seq);
    await f.ingestion.stop();
  });
  it('bounds handshake/backoff, rejects broad paths, requires explicit game target and fixture origin', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(5000); expect(f.updates.at(-1)?.status).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(250); expect(f.sockets).toHaveLength(2);
    f.ingestion.select('synthetic', '\\\\.\\pipe\\anything'); expect(f.updates.at(-1)?.status).toBe('unavailable'); expect(TEST_PIPE_PATTERN.test(endpoint)).toBe(true);
    f.ingestion.select('game'); expect(f.updates.at(-1)?.status).toBe('waiting'); f.ingestion.select('ets2'); expect(f.updates.at(-1)?.status).toBe('unavailable');
    expect(() => sourceSelection({path: endpoint})).toThrow(); await f.ingestion.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
describe('bounded live subscription delivery', () => {
  it('coalesces thousands of updates for a slow consumer and limits delivery to 20 Hz', async () => {
    vi.useFakeTimers(); const fanout = new LiveSubscriptions(initialLive()); const port = new TestPort(); fanout.attach(port);
    for (let i = 0; i < 10000; i++) fanout.publish({...initialLive(), reason: String(i)});
    await vi.advanceTimersByTimeAsync(100); expect(port.messages).toHaveLength(1);
    port.consume(); await vi.advanceTimersByTimeAsync(1); expect(port.messages).toHaveLength(2); expect(port.messages[1].update.reason).toBe('9999');
    port.consume(); fanout.publish({...initialLive(), reason: 'next'}); await vi.advanceTimersByTimeAsync(48); expect(port.messages).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2); expect(port.messages).toHaveLength(3); fanout.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('closes excessive subscriptions, invalid/stale credits, nonconsumers and exhausted delivery IDs', async () => {
    vi.useFakeTimers(); const fanout = new LiveSubscriptions(initialLive(), 1, 100); const first = new TestPort(), second = new TestPort();
    expect(fanout.attach(first)).toBe(true); expect(fanout.attach(second)).toBe(false); expect(second.closed).toBe(true);
    first.emit('message', {data: {type: 'consumed', delivery: 999}}); expect(first.closed).toBe(true); expect(fanout.size).toBe(0);
    const stalled = new TestPort(); fanout.attach(stalled); await vi.advanceTimersByTimeAsync(100); expect(stalled.closed).toBe(true);
    const bounded = new LiveSubscriptions(initialLive(), 1, 1000, 1), port = new TestPort(); bounded.attach(port); port.consume(); bounded.publish(initialLive()); await vi.advanceTimersByTimeAsync(50); expect(port.closed).toBe(true);
    fanout.close(); bounded.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retires old ports and permits a fresh renderer subscription', () => {
    const fanout = new LiveSubscriptions(initialLive()); const old = new TestPort(); fanout.attach(old); fanout.close();
    const next = new TestPort(); fanout.attach(next); old.consume(); expect(next.messages).toHaveLength(1); expect(next.closed).toBe(false); fanout.close();
  });
});
it('supervises two service restarts with fresh readiness and exposes exhaustion without restarting forever', async () => {
  vi.useFakeTimers(); const states: string[] = [], restart = vi.fn(), exhausted = vi.fn(), exit = vi.fn();
  const supervisor = new ServiceSupervisor(vi.fn(), exit, {restart, state: state => states.push(state), exhausted});
  const attach = () => {supervisor.attach({postMessage: vi.fn(), kill: () => true}); expect(supervisor.ready()).toBe(true);};
  attach(); supervisor.serviceExited(1); await vi.advanceTimersByTimeAsync(250); expect(restart).toHaveBeenCalledTimes(1);
  attach(); supervisor.serviceExited(1); await vi.advanceTimersByTimeAsync(1000); expect(restart).toHaveBeenCalledTimes(2);
  attach(); supervisor.serviceExited(1); await vi.advanceTimersByTimeAsync(20000); expect(exhausted).toHaveBeenCalledOnce(); expect(states).toEqual(['service-failed', 'restarting', 'service-failed', 'restarting', 'service-failed']); expect(exit).not.toHaveBeenCalled();
  supervisor.stop(); expect(exit).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('ingests the simulator over actual Windows pipes and hydrates after reconnect', async () => {
  const updates: LiveTelemetry[] = []; const run = await startPipe(emissions, {realtime: true, timeoutMs: 5000});
  const ingestion = new TelemetryIngestion(state => updates.push(state));
  try {
    ingestion.select('synthetic', run.endpoint); await run.closed;
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe('disconnected'));
    const observations = updates.filter(update => update.fresh);
    expect(observations.filter(update => update.observation?.applied.hydration)).toHaveLength(2);
    expect(observations.at(-1)?.observation?.state.fuel).toEqual({available: true, value: 0, unit: 'L'});
    expect(updates.every(update => update.recording === false && update.coverage === 'unknown')).toBe(true);
  } finally {await ingestion.stop(); await run.stop();}
});
it('closes malformed input over a real Windows pipe', async () => {
  const pipe = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-' + process.pid + '-' + randomUUID();
  const sockets = new Set<net.Socket>(); const server = net.createServer(socket => {sockets.add(socket); socket.on('error', () => {}); socket.once('data', () => {socket.write(emissions[0].frame.subarray(0, 7)); socket.write(Buffer.concat([emissions[0].frame.subarray(7), Buffer.from([1, 0, 1, 0])]));});});
  await new Promise<void>(resolve => server.listen(pipe, resolve)); const states: LiveTelemetry[] = []; const ingestion = new TelemetryIngestion(state => states.push(state));
  try {ingestion.select('synthetic', pipe); await vi.waitFor(() => expect(states.at(-1)?.status).toBe('incompatible')); expect(states.at(-1)?.fresh).toBe(false);}
  finally {await ingestion.stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
