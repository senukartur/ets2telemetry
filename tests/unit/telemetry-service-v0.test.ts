import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {SERVICE_REPORT_SETTLE_MS} from '../../apps/desktop/src/diagnostics';
import {SERVICE_EXIT_RESERVE_MS, SERVICE_KILL_DEADLINE_MS} from '../../apps/desktop/src/service-supervisor';
import {TelemetryIngestion, TEST_PIPE_PATTERN, initialLive, sourceSelection} from '../../apps/desktop/src/telemetry-ingestion';
import {LiveSubscriptions, type LivePort} from '../../apps/desktop/src/live-subscriptions';
import {ServiceSupervisor} from '../../apps/desktop/src/service-supervisor';
import type {ProbeDependencies} from '../../apps/desktop/src/service-probe';
import {FrameDecoder, encodeFrame} from '../../packages/contracts/src/protocol-v0';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import {decodePayload as decodePayloadV1, encodeFrame as encodeFrameV1, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import {ETS2_A, Script, r} from '../shared/trip-messages';
import type {LiveTelemetry} from '../../packages/contracts/src';
import type {V1IngestionOptions, V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import type {HistoryState, HistoryStorageOptions} from '../../apps/desktop/src/history-storage';
import type {StorageClient} from '../../packages/storage/src/client';
import type {BrokerConfiguration, BrokerDiagnostic} from '../../apps/desktop/src/native-pipe-client';
import {replay, type Scenario} from '../../tools/telemetry-simulator/src/scenario';
import {startPipe} from '../../tools/telemetry-simulator/src/pipe';
import {v1SourceState} from '../shared/live-v1-fixtures';
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
// Every import of the telemetry-service entry point that a case starts. An import that outlives its case (for
// example after a timeout) finishes its startup side effects before the next case starts. The rest of a timed-out
// case body can still resume later; the beforeEach guard only proves no entry-point import is still loading.
const loadingService = new Set<Promise<unknown>>();
function loadService(): Promise<unknown> {
  const loading = import('../../apps/desktop/src/telemetry-service');
  loadingService.add(loading); void loading.finally(() => loadingService.delete(loading)).catch(() => undefined);
  return loading;
}
// Captured before any fake timers are installed; afterEach uses it to cross one real macrotask boundary.
const realSetImmediate = setImmediate;
// One-time module-graph load. The first import of telemetry-service.ts transforms it and its dependencies that
// this file does not import statically; that took up to 4 s of the first case's 5 s timeout when all default
// Vitest workers competed for the transform pipeline on a 24-thread host. Pay it here through one clean stop,
// so no case's own timeout measures module transformation. This budget is a load allowance, not a behaviour bound.
const MODULE_GRAPH_LOAD_BUDGET_MS = 60_000;
beforeAll(async () => {
  // stoppedService replaces the v1 ingestion with a stand-in; transform the real module here too, since the first case loads it.
  await import('../../apps/desktop/src/v1-ingestion');
  const service = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {service.stop(); await vi.advanceTimersByTimeAsync(0);} finally {service.restore(); vi.useRealTimers();}
}, MODULE_GRAPH_LOAD_BUDGET_MS);
// The service entry point registers process crash handlers (SERVICE_UNCAUGHT); each case removes the ones it added.
const crashEvents = ['uncaughtException', 'unhandledRejection'] as const, processEvents = process as unknown as EventEmitter;
let crashListeners = new Map<string, unknown[]>();
beforeEach(() => {
  expect(loadingService.size, 'a previous case left telemetry-service loading').toBe(0);
  crashListeners = new Map(crashEvents.map(name => [name, processEvents.listeners(name)]));
});
afterEach(async () => {
  await Promise.allSettled(loadingService); await new Promise(resolve => realSetImmediate(resolve));
  for (const name of crashEvents) for (const listener of processEvents.listeners(name)) if (!crashListeners.get(name)!.includes(listener)) processEvents.removeListener(name, listener as (...args: unknown[]) => void);
  vi.useRealTimers();
});
it('boots transport only after the parent selection and retains it across renderer subscriptions', async () => {
  vi.useFakeTimers(); const sockets: TestSocket[] = [];
  const connect = vi.spyOn(net, 'connect').mockImplementation(() => {const socket = new TestSocket(); sockets.push(socket); return socket as unknown as net.Socket;});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const parent = Object.assign(new EventEmitter(), {postMessage: vi.fn()});
  Object.defineProperty(process, 'parentPort', {configurable: true, value: parent});
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'synthetic'); vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE', endpoint);
  vi.doMock('../../apps/desktop/src/diagnostics', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/diagnostics')>(),
    createDiagnostics: () => Object.assign(vi.fn(), {flush: vi.fn(() => Promise.resolve(true)), settle: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), finalize: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), drainSync: vi.fn()})}));
  // Isolate the existing storage probe; exercise the actual service handlers and ingestion.
  vi.doMock('../../apps/desktop/src/service-probe', () => ({ServiceProbe: class {
    constructor(private readonly dependencies: ProbeDependencies) {}
    start() {this.dependencies.report({type: 'ready'}); return Promise.resolve();}
    stop() {this.dependencies.report({type: 'stopped'}); return Promise.resolve();}
  }}));
  // The history database is opened by its own worker; never touch the real LOCALAPPDATA from a Node unit test.
  // The recorder game recording builds in production (October 25, 2026) needs the real recorderClient, so the module is kept.
  vi.doMock('../../apps/desktop/src/history-storage', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/history-storage')>(), HISTORY_STORAGE_STEP_NAME: 'history-storage', HISTORY_CLOSE_BUDGET_MS: 1000, HISTORY_CLOSE_GRACE_MS: 800, CLOSE_TERMINATE_RESERVE_MS: 200, historyWorker: vi.fn(), HistoryStorage: class {start() {} close() {return Promise.resolve();}}}));
  const command = (type: string, ports: TestPort[] = []) => parent.emit('message', {data: {type, source: 'synthetic'}, ports});
  try {
    await loadService();
    expect(parent.postMessage).toHaveBeenCalledWith({type: 'ready'}); expect(connect).not.toHaveBeenCalled();
    for (const broker of [null, [], {executable: 123, discoveryDirectory: 'isolated'}, {executable: 'isolated', discoveryDirectory: []}]) {
      parent.emit('message', {data: {type: 'select', source: 'synthetic', broker}, ports: []});
      // Since October 18, 2026 a failure report is posted after the log flush.
      await vi.advanceTimersByTimeAsync(0);
      expect(parent.postMessage).toHaveBeenLastCalledWith({type: 'failed', code: 'INVALID_SOURCE_COMMAND'});
      expect(connect).not.toHaveBeenCalled();
    }
    command('select'); expect(connect).toHaveBeenCalledTimes(1);
    sockets[0].emit('connect'); sockets[0].emit('data', Buffer.concat([emissions[0].frame, emissions[1].frame]));
    for (let reload = 0; reload < 2; reload++) {
      const port = new TestPort(); command('subscribe', [port]);
      expect(port.messages.at(-1)?.update).toMatchObject({selection: 'synthetic', fresh: true});
      command('unsubscribe'); expect(port.closed).toBe(true);
    }
    expect(connect).toHaveBeenCalledTimes(1);
    command('select'); expect(connect).toHaveBeenCalledTimes(2); expect(sockets[0].destroyed).toBe(true);
  } finally {
    command('stop'); await vi.advanceTimersByTimeAsync(0); expect(exit).toHaveBeenCalledWith(0);
    if (previousPort) Object.defineProperty(process, 'parentPort', previousPort); else Reflect.deleteProperty(process, 'parentPort');
    connect.mockRestore(); exit.mockRestore(); vi.unstubAllEnvs();
    vi.doUnmock('../../apps/desktop/src/diagnostics'); vi.doUnmock('../../apps/desktop/src/service-probe'); vi.doUnmock('../../apps/desktop/src/history-storage'); vi.resetModules();
  }
});
function fixture() {
  vi.useFakeTimers(); const updates: LiveTelemetry[] = []; const sockets: TestSocket[] = []; let now = 0;
  const ingestion = new TelemetryIngestion(state => updates.push(state), {now: () => now, connect: () => {const socket = new TestSocket(); sockets.push(socket); return socket;}});
  ingestion.select('synthetic', endpoint);
  return {ingestion, updates, sockets, time: (value: number) => {now = value;}};
}
describe('v0 utility ingestion', () => {
  it('updates window receipts while equal SDK captures expire and only a newer SDK capture restores freshness', async () => {
    const f = fixture(), socket = f.sockets[0]; socket.emit('connect');
    socket.emit('data', Buffer.concat([emissions[0].frame, emissions[1].frame]));
    const checkpoint = f.updates.at(-1)!.observation!;
    const message = structuredClone(emissions[2].message);
    if (message.kind !== 'snapshot') throw new Error('Fixture must be a snapshot');
    message.capture = {...checkpoint.capture}; message.seq = (BigInt(checkpoint.seq) + 1n).toString();
    message.data.state.window = {available: true, value: {handle: '18446744073709551615', x: -400, y: -300, width: 640, height: 480, dpi: 144, foreground: true, minimized: false, displayMode: 'unknown'}};
    for (const now of [100, 400, 600]) {
      f.time(now); socket.emit('data', encodeFrame(message)); message.seq = (BigInt(message.seq) + 1n).toString();
      expect(f.updates.at(-1)?.observation).toMatchObject({receivedMonotonicMs: 0, windowReceivedMonotonicMs: now, windowFresh: true});
    }
    expect(f.updates.at(-1)).toMatchObject({status: 'stale', fresh: false});
    f.time(850); await vi.advanceTimersByTimeAsync(50); expect(f.updates.at(-1)?.observation?.windowFresh).toBe(false);
    message.capture.monotonicNs = (BigInt(checkpoint.capture.monotonicNs) + 1n).toString();
    socket.emit('data', encodeFrame(message)); expect(f.updates.at(-1)?.fresh).toBe(true);
    expect(f.updates.at(-1)?.observation?.receivedMonotonicMs).toBe(850);
    socket.emit('end'); expect(f.updates.at(-1)?.observation?.windowFresh).toBe(false);
    await f.ingestion.stop();
  });
  function delayedBroker() {
    vi.useFakeTimers(); const updates: LiveTelemetry[] = [];
    const sockets: Array<TestSocket & {completion: Promise<void>; finish: () => void; game: 'ets2' | 'ats'}> = [];
    const ingestion = new TelemetryIngestion(update => updates.push(update), {broker: {executable: 'fixed', discoveryDirectory: 'fixed'}, connectGame: (_configuration, game) => {
      let finish!: () => void;
      const socket = Object.assign(new TestSocket(), {game, completion: new Promise<void>(resolve => {finish = resolve;}), finish: () => finish()});
      sockets.push(socket); return socket;
    }});
    ingestion.select('ets2');
    const cleanup = async () => {const stopped = ingestion.stop(); for (const socket of sockets) socket.finish(); await stopped;};
    return {ingestion, updates, sockets, cleanup};
  }
  it.each(['waiting', 'end', 'close', 'deadline'])('gates automatic %s recovery on actual cancelled broker completion', async trigger => {
    const f = delayedBroker();
    try {
      if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(5000); else f.sockets[0].emit(trigger);
      expect(f.sockets[0].destroyed).toBe(true); expect(f.updates.at(-1)?.fresh).toBe(false);
      await vi.advanceTimersByTimeAsync(20000); expect(f.sockets).toHaveLength(1);
      f.sockets[0].finish(); await vi.advanceTimersByTimeAsync(0); expect(f.sockets).toHaveLength(2);
      expect(f.sockets[1].game).toBe('ets2'); expect(f.updates.at(-1)?.fresh).toBe(false);
    } finally {await f.cleanup();}
  });
  it('preserves the automatic backoff when broker completion precedes its deadline', async () => {
    const f = delayedBroker();
    try {
      f.sockets[0].emit('waiting'); f.sockets[0].finish(); await vi.advanceTimersByTimeAsync(249); expect(f.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(f.sockets).toHaveLength(2);
    } finally {await f.cleanup();}
  });
  it.each(['stop', 'selection'])('invalidates pending automatic recovery during %s while completion is delayed', async action => {
    const f = delayedBroker();
    try {
      f.sockets[0].emit('waiting'); await vi.advanceTimersByTimeAsync(250); expect(f.sockets).toHaveLength(1);
      let stopped: Promise<void> | undefined; let stopFinished = false;
      if (action === 'stop') {stopped = f.ingestion.stop().then(() => {stopFinished = true;});} else {f.ingestion.select('ats'); f.ingestion.select('ets2'); f.ingestion.select('ats');}
      await vi.advanceTimersByTimeAsync(10000); expect(f.sockets).toHaveLength(1); expect(stopFinished).toBe(false);
      f.sockets[0].finish(); await vi.advanceTimersByTimeAsync(0); await stopped;
      expect(f.sockets).toHaveLength(action === 'stop' ? 1 : 2);
      if (action === 'selection') {expect(f.sockets[1].game).toBe('ats'); expect(f.updates.at(-1)).toMatchObject({selection: 'ats', fresh: false});}
    } finally {await f.cleanup();}
  });
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
async function stoppedService(stopProbe: (report: ProbeDependencies['report']) => Promise<void>, closeHistory: () => Promise<void> = () => Promise.resolve(), options: {realV1?: boolean} = {}) {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const parent = Object.assign(new EventEmitter(), {postMessage: vi.fn()});
  Object.defineProperty(process, 'parentPort', {configurable: true, value: parent});
  // The log's final flush resolves at once, as with an idle disk.
  const log = Object.assign(vi.fn(), {flush: vi.fn(() => Promise.resolve(true)), settle: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), finalize: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), drainSync: vi.fn()}), diagnostics: unknown[][] = [];
  vi.doMock('../../apps/desktop/src/diagnostics', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/diagnostics')>(),
    createDiagnostics: (...args: unknown[]) => {diagnostics.push(args); return log;}}));
  let probeReport: ProbeDependencies['report'] = () => undefined;
  vi.doMock('../../apps/desktop/src/service-probe', () => ({ServiceProbe: class {
    constructor(private readonly dependencies: ProbeDependencies) {probeReport = message => dependencies.report(message);}
    start() {this.dependencies.report({type: 'ready'}); return Promise.resolve();}
    stop() {return stopProbe(message => this.dependencies.report(message));}
  }}));
  // The history database is replaced too: its constructor options are recorded, and a case sets its state and client.
  const history = {start: vi.fn(), close: vi.fn(closeHistory), options: [] as HistoryStorageOptions[], state: 'idle' as HistoryState, client: undefined as StorageClient | undefined};
  vi.doMock('../../apps/desktop/src/history-storage', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/history-storage')>(), HistoryStorage: class {
    constructor(options: HistoryStorageOptions) {history.options.push(options);}
    get state() {return history.state;}
    get client() {return history.client;}
    // ET-015c: the recording status reads the failure code; the stand-in never fails.
    get failureCode() {return null;}
    start() {history.start();}
    close() {return history.close();}
  }}));
  // The protocol v1 ingestion (ET-006b) is replaced like the history database: its options and calls are recorded.
  const v1 = {options: [] as V1IngestionOptions[], configureBroker: vi.fn<(configuration: BrokerConfiguration | undefined) => void>(),
    select: vi.fn<(selection: string, endpoint?: string) => void>(), stopSource: vi.fn(() => Promise.resolve()), flush: vi.fn(() => Promise.resolve()),
    durableAvailabilityChanged: vi.fn(), current: {selection: 'game', status: 'waiting', reason: 'Select ETS2 or ATS explicitly', fresh: false, durable: {state: 'off'}} as V1SourceState};
  // A case that needs the real ingestion and trip recorder (the flush step) keeps the module.
  if (!options.realV1) vi.doMock('../../apps/desktop/src/v1-ingestion', () => ({V1Ingestion: class {
    constructor(options: V1IngestionOptions) {v1.options.push(options);}
    configureBroker(configuration: BrokerConfiguration | undefined) {v1.configureBroker(configuration);}
    select(selection: string, endpoint?: string) {v1.select(selection, endpoint);}
    stopSource() {return v1.stopSource();}
    flush() {return v1.flush();}
    durableAvailabilityChanged() {v1.durableAvailabilityChanged();}
    // ET-015c: the recording status of a recording target reads the state and the retry code.
    get current() {return v1.current;}
    get durableRetryCode() {return undefined;}
  }}));
  // The native client is replaced by a recorder so the production connectGame closures can be called without a broker.
  const pipeClients: unknown[][] = [];
  vi.doMock('../../apps/desktop/src/native-pipe-client', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/native-pipe-client')>(),
    NativePipeClient: class extends EventEmitter {readonly completion = Promise.resolve(); constructor(...args: unknown[]) {super(); pipeClients.push(args);}}}));
  await loadService();
  const restore = () => {
    if (previousPort) Object.defineProperty(process, 'parentPort', previousPort); else Reflect.deleteProperty(process, 'parentPort');
    exit.mockRestore(); vi.doUnmock('../../apps/desktop/src/diagnostics'); vi.doUnmock('../../apps/desktop/src/service-probe'); vi.doUnmock('../../apps/desktop/src/history-storage');
    vi.doUnmock('../../apps/desktop/src/v1-ingestion'); vi.doUnmock('../../apps/desktop/src/native-pipe-client'); vi.resetModules();
  };
  const stops = () => parent.postMessage.mock.calls.map(call => call[0] as {type: string}).filter(message => message.type === 'stopped');
  const steps = () => log.mock.calls.filter(call => call[0] === 'SHUTDOWN_STEP').map(call => call[2] as Record<string, unknown>);
  return {exit, parent, log, diagnostics, history, v1, pipeClients, restore, stops, steps, probeReport: (message: Parameters<ProbeDependencies['report']>[0]) => probeReport(message),
    stop: () => parent.emit('message', {data: {type: 'stop'}, ports: []})};
}
it.each([false, true])('gates the latency parent command and uses the current service mapping (enabled=%s)', async enabled => {
  vi.stubEnv('ETS2TELEMETRY_OVERLAY_LATENCY', enabled ? '1' : '0');
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated-latency');
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', 'C:\\isolated-profile');
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    const message = decodePayloadV1(new Uint8Array(readFileSync('tests/fixtures/protocol-v1/checkpoint.json')), 'server');
    if (message.kind !== 'checkpoint') throw new Error('Expected checkpoint');
    const capture = {...message.capture, monotonicNs: '1000000000'};
    f.v1.current = {...f.v1.current, selection: message.source.game, status: 'connected', fresh: true,
      observation: {source: message.source, capture} as V1SourceState['observation'],
      clockMapping: {sourceClockId: capture.clockId, clientClockId: 'service', offsetNs: '-9000000000', uncertaintyNs: '2000000', measuredAtClientNs: '10000000000'}};
    const clock = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(10050000000n);
    const transferred = {close: vi.fn()};
    try {f.parent.emit('message', {data: {type: 'overlay-latency', token: 7, source: message.source, capture}, ports: [transferred]});}
    finally {clock.mockRestore();}
    expect(transferred.close).toHaveBeenCalledOnce();
    const replies = f.parent.postMessage.mock.calls.map(call => call[0]).filter((reply: {type: string}) => reply.type === 'overlay-latency-result');
    expect(replies).toEqual(enabled ? [{type: 'overlay-latency-result', token: 7, upperNs: '52000000', uncertaintyNs: '2000000', mappingAgeNs: '50000000'}] : []);
  } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore(); vi.unstubAllEnvs();}
});
it('runs the ordered shutdown once and reports exactly one clean stopped message before exit 0', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    f.stop(); f.stop(); await vi.advanceTimersByTimeAsync(0);
    expect(f.stops()).toEqual([{type: 'stopped', clean: true}]);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    // ET-013 adds the history database close beside the probe in the storage phase, ET-006b the v1 ingestion beside the
    // v0 ingestion and capture in the intake phase, and ET-015a (R14) the recording flush as the only flush step; steps
    // of one phase finish in any order.
    const steps = f.steps().map(step => [step.phase, step.name, step.outcome]);
    expect(steps.slice(0, 3).sort()).toEqual([['intake', 'capture', 'ok'], ['intake', 'ingestion', 'ok'], ['intake', 'v1-ingestion', 'ok']]);
    expect(steps[3]).toEqual(['flush', 'recording-flush', 'ok']);
    expect(steps.slice(4).sort()).toEqual([['storage', 'history-storage', 'ok'], ['storage', 'storage-probe', 'ok']]);
    expect(f.history.start).toHaveBeenCalledOnce(); expect(f.history.close).toHaveBeenCalledOnce();
    // R14: the intake step ends only the source; the flush step then waits for the storage command in flight.
    expect(f.v1.stopSource).toHaveBeenCalledOnce(); expect(f.v1.flush).toHaveBeenCalledOnce();
    expect(f.v1.stopSource.mock.invocationCallOrder[0]).toBeLessThan(f.v1.flush.mock.invocationCallOrder[0]);
    expect(f.v1.flush.mock.invocationCallOrder[0]).toBeLessThan(f.history.close.mock.invocationCallOrder[0]);
    expect(f.log).toHaveBeenCalledWith('SERVICE_REPORT', {type: 'stopped', clean: true});
    expect(vi.getTimerCount()).toBe(0);
  } finally {f.restore();}
});
// Without LOCALAPPDATA the service once logged under TEMP while main logged under userData; it now uses main's root.
it('writes its log in the service subdirectory of the root main passed, also without LOCALAPPDATA', async () => {
  const root = 'C:\\isolated\\user-data\\ETS2Telemetry\\logs';
  vi.stubEnv('LOCALAPPDATA', undefined); vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', undefined); vi.stubEnv('ETS2TELEMETRY_SERVICE_LOG_ROOT', root);
  try {
    const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
    try {
      expect(f.diagnostics[0]).toEqual([`${root}\\service`, false]);
      f.stop(); await vi.advanceTimersByTimeAsync(0); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {f.restore();}
  } finally {vi.unstubAllEnvs();}
});
it('runs protocol v1 beside v0 with the history recorder, following each selection with the v1 fixture endpoint and the derived broker directory', async () => {
  const v1Endpoint = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-123-' + randomUUID();
  vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  const select = (source: string, broker?: BrokerConfiguration) => f.parent.emit('message', {data: {type: 'select', source, broker}, ports: []});
  try {
    // E2, amended by the game recording enablement of October 25, 2026: the default plan gives the ETS2 and ATS selections
    // the history recorder, so their hello asks for durable delivery; the synthetic and replay selections stay live-only.
    expect(f.v1.options).toHaveLength(1);
    expect(Object.keys(f.v1.options[0]).sort()).toEqual(['connectGame', 'diagnose', 'durableReady', 'durableSelections', 'onState', 'sink']);
    expect(f.v1.options[0].durableSelections).toEqual(['ets2', 'ats']);
    expect(f.v1.select).not.toHaveBeenCalled();
    const executable = 'C:\\fixed\\telemetry-pipe-client.exe';
    select('synthetic', {executable, discoveryDirectory: 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v0'});
    expect(f.v1.configureBroker).toHaveBeenLastCalledWith({executable, discoveryDirectory: 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v1'});
    expect(f.v1.select).toHaveBeenLastCalledWith('synthetic', v1Endpoint);
    select('game'); expect(f.v1.configureBroker).toHaveBeenLastCalledWith(undefined); expect(f.v1.select).toHaveBeenLastCalledWith('game', v1Endpoint);
    // An unexpected v0 directory shape gives v1 no broker rather than a guessed directory (E12).
    select('replay', {executable, discoveryDirectory: 'C:\\isolated\\transport'}); expect(f.v1.configureBroker).toHaveBeenLastCalledWith(undefined);
    // A v1 failure never fails the selection the v0 ingestion accepted.
    f.v1.select.mockImplementationOnce(() => {throw new Error('v1 rejected');});
    select('synthetic'); await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith({type: 'failed', code: 'INVALID_SOURCE_COMMAND'}); expect(f.log).toHaveBeenCalledWith('V1_SELECT_REJECTED');
    expect(f.v1.select).toHaveBeenCalledTimes(4);
    // An invalid selection is rejected before either ingestion sees it.
    select('C:\\untrusted'); await vi.advanceTimersByTimeAsync(0); expect(f.parent.postMessage).toHaveBeenLastCalledWith({type: 'failed', code: 'INVALID_SOURCE_COMMAND'}); expect(f.v1.select).toHaveBeenCalledTimes(4);
    // Only fixed status codes are logged, on a change of status, at occurrences 1, 2, 4, 8, ... of each status.
    const state = (status: V1SourceState['status']): V1SourceState => ({selection: 'ets2', status, reason: 'fixed', fresh: false, durable: {state: 'off'}});
    for (const status of ['waiting', 'connected', 'connected', 'disconnected', 'waiting', 'disconnected', 'waiting', 'disconnected', 'waiting'] as const) f.v1.options[0].onState!(state(status));
    expect(f.log.mock.calls.filter(call => call[0] === 'V1_SOURCE_STATUS').map(call => call[2] as Record<string, unknown>)).toEqual([
      {status: 'waiting', selection: 'ets2', durable: 'off', count: 1}, {status: 'connected', selection: 'ets2', durable: 'off', count: 1},
      {status: 'disconnected', selection: 'ets2', durable: 'off', count: 1}, {status: 'waiting', selection: 'ets2', durable: 'off', count: 2},
      {status: 'disconnected', selection: 'ets2', durable: 'off', count: 2}, {status: 'waiting', selection: 'ets2', durable: 'off', count: 4}
    ]);
    // The production closure starts the broker in its v1 mode and reports its exits under the v1 code, not the v0 one.
    const configuration = {executable, discoveryDirectory: 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v1'};
    f.v1.options[0].connectGame!(configuration, 'ats');
    expect(f.pipeClients).toHaveLength(1);
    const [passedConfiguration, game, diagnoseBroker, mode] = f.pipeClients[0];
    expect([passedConfiguration, game, mode]).toEqual([configuration, 'ats', 'v1']);
    const exit: BrokerDiagnostic = {outcome: 'ended', exitCode: 3, serviceMs: 10, stage: 'relay', win32Error: 0, elapsedMs: 5, slowStage: 'relay', slowMs: 5};
    (diagnoseBroker as (diagnostic: BrokerDiagnostic) => void)(exit);
    expect(f.log).toHaveBeenLastCalledWith('NATIVE_BROKER_V1_EXIT', undefined, {...exit, repeats: 1});
    f.v1.options[0].diagnose!('V1_DURABLE_UNAVAILABLE', {code: 'WORKER_FAILED'});
    expect(f.log).toHaveBeenLastCalledWith('V1_DURABLE_UNAVAILABLE', undefined, {code: 'WORKER_FAILED'});
  } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore(); vi.unstubAllEnvs();}
});
// ET-010c decisions F1 and F2: the service attaches the whitelisted v1 projection of the same selection to the live update.
it('publishes the v1 projection of the same selection with the live update and ignores clock-mapping-only changes', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  const port = new TestPort();
  try {
    f.parent.emit('message', {data: {type: 'subscribe'}, ports: [port]}); port.consume();
    f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
    await vi.advanceTimersByTimeAsync(50); port.consume();
    const v0 = port.messages.at(-1)!.update;
    expect(v0).toMatchObject({selection: 'synthetic'}); expect(v0).not.toHaveProperty('v1');
    const onState = f.v1.options[0].onState!;
    const state = v1SourceState();
    onState(state); await vi.advanceTimersByTimeAsync(50); port.consume();
    const update = port.messages.at(-1)!.update;
    expect(update).toMatchObject({selection: 'synthetic', status: v0.status, reason: v0.reason, fresh: v0.fresh,
      v1: {selection: 'synthetic', status: 'connected', fresh: true, observation: {seq: '5', receivedMonotonicMs: 1250}}});
    expect(JSON.stringify(update)).not.toMatch(/clockMapping|65538|"durable"|WORKER_FAILED|lastEnd|continuity/);
    // A new clock mapping or durable status with the same observation changes nothing the projection shows.
    const count = port.messages.length;
    onState({...state, clockMapping: {...state.clockMapping!, offsetNs: '99'}, durable: {state: 'off'}});
    await vi.advanceTimersByTimeAsync(100);
    expect(port.messages).toHaveLength(count);
    // A state of another selection never rides on this selection's update.
    onState(v1SourceState('snapshot-live', {selection: 'ets2'})); await vi.advanceTimersByTimeAsync(50);
    expect(port.messages.at(-1)!.update).not.toHaveProperty('v1');
  } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore();}
});
it('bounds the v1 ingestion stop by its 1,000 ms intake budget and reports a late stop as unclean', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    f.v1.stopSource.mockImplementation(() => new Promise<void>(() => undefined));
    f.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.stops()).toEqual([]); expect(f.history.close).not.toHaveBeenCalled();
    // Requirement change (October 18, 2026): the timeout verdict runs one event-loop turn after the budget, which the
    // fake clock schedules 1 ms later.
    await vi.advanceTimersByTimeAsync(1);
    expect(f.steps().find(step => step.name === 'v1-ingestion')).toMatchObject({phase: 'intake', outcome: 'timeout'});
    expect(f.stops()).toEqual([{type: 'stopped', clean: false}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally {f.restore();}
});
describe('ET-015a recording gate in the service (R3, R10, R14)', () => {
  const stopProbe = (report: ProbeDependencies['report']) => {report({type: 'stopped'}); return Promise.resolve();};
  const v1Endpoint = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-123-' + randomUUID();
  it('builds the default plan: the history database with a trip recorder for ETS2 and ATS only, once the database is open (E2)', async () => {
    const f = await stoppedService(stopProbe);
    try {
      const options = f.v1.options[0];
      expect(Object.keys(options).sort()).toEqual(['connectGame', 'diagnose', 'durableReady', 'durableSelections', 'onState', 'sink']);
      expect(options.durableSelections).toEqual(['ets2', 'ats']);
      expect(options.sink?.constructor.name).toBe('TripRecorderSink');
      expect(f.history.options).toHaveLength(1);
      expect(f.history.options[0].target).toEqual({purpose: 'history'});
      // R10: durable only while the database is open; its open lets a live-only connection reconnect durable.
      for (const [state, ready] of [['idle', false], ['opening', false], ['open', true], ['unavailable', false], ['closed', false]] as const) {
        f.history.state = state; expect(options.durableReady!()).toBe(ready);
      }
      f.history.options[0].onOpened!();
      expect(f.v1.durableAvailabilityChanged).toHaveBeenCalledOnce();
      expect(f.log.mock.calls.map(call => call[0])).not.toContain('RECORDING_TARGET_REJECTED');
    } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore();}
  });
  it('records into the synthetic target only for the synthetic selection, once its database is open', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t');
    const f = await stoppedService(stopProbe);
    try {
      const options = f.v1.options[0];
      expect(Object.keys(options).sort()).toEqual(['connectGame', 'diagnose', 'durableReady', 'durableSelections', 'onState', 'sink']);
      expect(options.durableSelections).toEqual(['synthetic']);
      // A fresh module instance per case, so the recorder is identified by its class name rather than instanceof.
      expect(options.sink?.constructor.name).toBe('TripRecorderSink');
      expect(f.history.options[0].target).toEqual({purpose: 'synthetic', name: 't'});
      // R10: durable only while the database is open; its open lets the live-only connection reconnect durable.
      for (const [state, ready] of [['idle', false], ['opening', false], ['open', true], ['unavailable', false], ['closed', false]] as const) {
        f.history.state = state; expect(options.durableReady!()).toBe(ready);
      }
      expect(f.v1.durableAvailabilityChanged).not.toHaveBeenCalled();
      f.history.options[0].onOpened!();
      expect(f.v1.durableAvailabilityChanged).toHaveBeenCalledOnce();
      expect(f.log.mock.calls.map(call => call[0])).not.toContain('RECORDING_TARGET_REJECTED');
    } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore(); vi.unstubAllEnvs();}
  });
  it.each(['history', 'synthetic:A', 'synthetic:../x', 'game:x'])('rejects ETS2TELEMETRY_RECORDING=%j once and keeps the default plan', async value => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', value);
    const f = await stoppedService(stopProbe);
    try {
      expect(f.log.mock.calls.filter(call => call[0] === 'RECORDING_TARGET_REJECTED')).toEqual([['RECORDING_TARGET_REJECTED']]);
      expect(Object.keys(f.v1.options[0]).sort()).toEqual(['connectGame', 'diagnose', 'durableReady', 'durableSelections', 'onState', 'sink']);
      expect(f.v1.options[0].durableSelections).toEqual(['ets2', 'ats']);
      expect(f.history.options[0].target).toEqual({purpose: 'history'});
      expect(f.history.options[0].onOpened).toBeTypeOf('function');
    } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore(); vi.unstubAllEnvs();}
  });
  it('bounds the stop by 1,000 (intake) + 500 (flush) + 1,000 (storage) = 2,500 ms when every step hangs', async () => {
    const f = await stoppedService(stopProbe, () => new Promise<void>(() => undefined));
    try {
      const hang = () => new Promise<void>(() => undefined);
      f.v1.stopSource.mockImplementation(hang); f.v1.flush.mockImplementation(hang);
      // Requirement change (October 18, 2026): each timeout verdict runs one event-loop turn after its budget (an
      // immediate), which the fake clock schedules 1 ms later; the three phases end at 1,001, 1,502 and 2,503 ms.
      f.stop(); await vi.advanceTimersByTimeAsync(1000); expect(f.v1.flush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.v1.flush).toHaveBeenCalledOnce(); expect(f.history.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500); expect(f.history.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(f.history.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000); expect(f.stops()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.stops()).toEqual([{type: 'stopped', clean: false}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.steps().filter(step => step.outcome !== 'ok').map(step => [step.phase, step.name, step.outcome])).toEqual([
        ['intake', 'v1-ingestion', 'timeout'], ['flush', 'recording-flush', 'timeout'], ['storage', 'history-storage', 'timeout']]);
    } finally {f.restore();}
  });
  it('flushes after the source stopped: waits for the commit in flight, writes no ACK after the stop, then closes the database', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t'); vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
    const sockets: TestSocket[] = [], endpoints: unknown[] = [];
    const connect = vi.spyOn(net, 'connect').mockImplementation((endpoint: unknown) => {endpoints.push(endpoint); const socket = new TestSocket(); sockets.push(socket); return socket as unknown as net.Socket;});
    // The recorder's storage: a session at coverage 0 with no stored trip, and a commit held until `release`.
    let release: (() => void) | undefined;
    const commits: string[] = [];
    const answer = (value: unknown) => Promise.resolve({ok: true, value});
    const client = {
      observeHardMode: () => answer(undefined), getTrip: () => answer(undefined),
      upsertSession: () => answer({created: true, committedThroughEventSeq: '0'}), committedThrough: () => answer('0'),
      listTrips: () => answer({trips: [], nextCursor: null}), getEvent: () => answer(undefined), listEvents: () => answer([]), recordCompleteness: () => answer(undefined),
      commitGap: () => answer({status: 'committed', committedThroughEventSeq: '0'}),
      commitEvent: (input: {message: {data: {eventSeq: string}}}) => {
        commits.push(input.message.data.eventSeq);
        return new Promise(resolve => {release = () => resolve({ok: true, value: {status: 'committed', committedThroughEventSeq: '1'}});});
      }
    } as unknown as StorageClient;
    const f = await stoppedService(stopProbe, undefined, {realV1: true});
    try {
      f.history.state = 'open'; f.history.client = client;
      f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
      expect(endpoints).toEqual([v1Endpoint]);
      const socket = sockets[0], sent = () => socket.writes.map(bytes => decodePayloadV1(bytes.subarray(4), 'client') as ClientMessage);
      socket.emit('connect');
      expect(sent()).toMatchObject([{kind: 'hello', data: {durableEvents: true}}]);
      const s = new Script(ETS2_A);
      for (const message of [s.welcome(), s.checkpoint(null), s.event(r.jobConfigured())]) socket.emit('data', encodeFrameV1(message));
      await vi.advanceTimersByTimeAsync(0);
      expect(commits).toEqual(['1']);
      f.stop(); await vi.advanceTimersByTimeAsync(0);
      // The intake phase ended the source; the flush step waits for the commit in flight and the database stays open.
      expect(socket.destroyed).toBe(true);
      await vi.advanceTimersByTimeAsync(499);
      expect(f.steps().map(step => step.name)).not.toContain('recording-flush'); expect(f.history.close).not.toHaveBeenCalled();
      release!(); await vi.advanceTimersByTimeAsync(0);
      expect(f.steps().find(step => step.name === 'recording-flush')).toMatchObject({phase: 'flush', outcome: 'ok'});
      expect(f.history.close).toHaveBeenCalledOnce();
      expect(f.stops()).toEqual([{type: 'stopped', clean: true}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
      // The commit completed in storage, but nothing was acknowledged after the source stopped; the producer redelivers.
      expect(sent().map(message => message.kind).filter(kind => kind === 'ack')).toEqual([]);
      expect(sockets).toHaveLength(1);
    } finally {connect.mockRestore(); f.restore(); vi.unstubAllEnvs();}
  });
  it('writes the pending one-second samples in the recording-flush step, before the database closes and inside 2,500 ms (ET-015b, H11)', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t'); vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
    const sockets: TestSocket[] = [];
    const connect = vi.spyOn(net, 'connect').mockImplementation(() => {const socket = new TestSocket(); sockets.push(socket); return socket as unknown as net.Socket;});
    const order: string[] = [], appended: unknown[][] = [];
    const answer = (value: unknown) => Promise.resolve({ok: true, value});
    const client = {
      observeHardMode: () => answer(undefined), getTrip: () => answer(undefined),
      upsertSession: () => answer({created: true, committedThroughEventSeq: '0'}), committedThrough: () => answer('0'),
      listTrips: () => answer({trips: [], nextCursor: null}), getEvent: () => answer(undefined), listEvents: () => answer([]), recordCompleteness: () => answer(undefined),
      appendSamples: (session: string, rows: {monotonicNs: string}[], options: unknown) => {
        order.push('appendSamples'); appended.push([session, rows.map(row => row.monotonicNs), options]);
        return answer({appended: rows.length, skipped: 0});
      }
    } as unknown as StorageClient;
    const f = await stoppedService(stopProbe, () => {order.push('history-close'); return Promise.resolve();}, {realV1: true});
    try {
      f.history.state = 'open'; f.history.client = client;
      f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
      const socket = sockets[0];
      socket.emit('connect');
      // The checkpoint is the baseline; two fresh, running snapshots in seconds 1001 and 1002 become pending rows.
      const s = new Script(ETS2_A);
      for (const message of [s.welcome(), s.checkpoint(null), s.snapshot({}, 1_000), s.snapshot({}, 1_000)]) socket.emit('data', encodeFrameV1(message));
      await vi.advanceTimersByTimeAsync(0);
      expect(appended).toEqual([]);
      f.stop(); await vi.advanceTimersByTimeAsync(0);
      // No 5 s timer was needed: the flush step wrote both rows at once, then the storage phase closed the database.
      expect(appended).toEqual([[ETS2_A, ['1001000000000', '1002000000000'], {uniqueSeconds: true}]]);
      expect(order).toEqual(['appendSamples', 'history-close']);
      expect(f.steps().find(step => step.name === 'recording-flush')).toMatchObject({phase: 'flush', outcome: 'ok'});
      expect(f.log.mock.calls.filter(call => call[0] === 'V1_SAMPLES_EXIT').map(call => call[2] as unknown)).toEqual([{rows: 2, losses: 0, code: 'WRITTEN'}]);
      expect(f.stops()).toEqual([{type: 'stopped', clean: true}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {connect.mockRestore(); f.restore(); vi.unstubAllEnvs();}
  });
});
// Final log write (October 18, 2026, dispatch run 39094511631): the service exits only after finalize wrote its final
// rows. The append in flight gets the time the stop left before main's 3,000 ms kill deadline, less the
// SERVICE_EXIT_RESERVE_MS reserve, and nothing once that time has passed.
it('exits after the final log write that follows the stopped report, with the time left before the kill deadline', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    let written!: () => void;
    f.log.finalize.mockImplementation(() => new Promise<void>(resolve => {written = resolve;}));
    f.stop(); await vi.advanceTimersByTimeAsync(0);
    expect(f.stops()).toEqual([{type: 'stopped', clean: true}]);
    expect(f.log.finalize).toHaveBeenCalledExactlyOnceWith(SERVICE_KILL_DEADLINE_MS - SERVICE_EXIT_RESERVE_MS);
    expect(f.log.mock.calls.at(-1)?.[0]).toBe('SERVICE_REPORT');
    expect(f.log.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.log.finalize.mock.invocationCallOrder[0]);
    expect(f.exit).not.toHaveBeenCalled();
    written(); await vi.advanceTimersByTimeAsync(0);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {f.restore();}
});
it('gives the final log write only the time left after a stop that used its whole budget', async () => {
  const hang = () => new Promise<void>(() => undefined);
  const f = await stoppedService(hang, hang);
  try {
    f.v1.stopSource.mockImplementation(hang); f.v1.flush.mockImplementation(hang);
    f.stop(); await vi.advanceTimersByTimeAsync(2503);
    expect(f.stops()).toEqual([{type: 'stopped', clean: false}]);
    // The phases ended at 1,001, 1,502 and 2,503 ms (fake verdict turns of 1 ms): 3,000 - 300 - 2,503 = 197 ms remain.
    const wait = f.log.finalize.mock.calls[0][0];
    expect(wait).toBe(SERVICE_KILL_DEADLINE_MS - SERVICE_EXIT_RESERVE_MS - 2503);
  } finally {f.restore();}
});
// Review round 1 (October 18, 2026): main answers a failure report after readiness by killing the service, so the
// rows that explain it are written before the report is posted.
it.each([
  ['a probe failure report', (f: Awaited<ReturnType<typeof stoppedService>>) => f.probeReport({type: 'failed', code: 'STORAGE_WORKER_FAILED'}), {type: 'failed', code: 'STORAGE_WORKER_FAILED'}],
  ['a rejected selection', (f: Awaited<ReturnType<typeof stoppedService>>) => f.parent.emit('message', {data: {type: 'select', source: 'C:\\untrusted'}, ports: []}),
    {type: 'failed', code: 'INVALID_SOURCE_COMMAND'}]
] as const)('posts %s only after the log flush', async (_name, trigger, message) => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    let written!: () => void;
    f.log.settle.mockImplementation(() => new Promise<void>(resolve => {written = resolve;}));
    const logged = f.log.mock.calls.length;
    trigger(f); await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.postMessage).not.toHaveBeenCalledWith(message);
    expect(f.log.settle).toHaveBeenCalledExactlyOnceWith(SERVICE_REPORT_SETTLE_MS);
    if (message.code === 'STORAGE_WORKER_FAILED') expect(f.log.mock.calls.slice(logged).map(call => call[0])).toEqual(['SERVICE_REPORT']);
    written(); await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.postMessage).toHaveBeenLastCalledWith(message);
  } finally {f.restore();}
});
// Review round 2: an uncaught exception still ends the service with exit 1. An unhandled rejection only warned before (an
// Electron 44.7.0 utilityProcess without a handler keeps running), so the service logs it and keeps running.
it.each([
  ['uncaughtException', 'SERVICE_UNCAUGHT', [1]],
  ['unhandledRejection', 'SERVICE_UNHANDLED_REJECTION', []]
] as const)('on %s logs %s and drains the log synchronously; exit codes %j', async (event, row, exits) => {
  const before = (process as unknown as EventEmitter).listeners(event);
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    const added = (process as unknown as EventEmitter).listeners(event).filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);
    const error = new Error('crash');
    (added[0] as (error: unknown) => void)(error);
    expect(f.log).toHaveBeenLastCalledWith(row, error);
    expect(f.log.drainSync).toHaveBeenCalledOnce();
    expect(f.log.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.log.drainSync.mock.invocationCallOrder[0]);
    expect(f.exit.mock.calls.map(call => call[0])).toEqual(exits);
    if (exits.length) expect(f.log.drainSync.mock.invocationCallOrder[0]).toBeLessThan(f.exit.mock.invocationCallOrder[0]);
    // A service that survived a rejection still stops in order.
    else {f.stop(); await vi.advanceTimersByTimeAsync(0); expect(f.stops()).toEqual([{type: 'stopped', clean: true}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);}
  } finally {f.restore();}
});
it('waits for the history database to close before the single stopped report, and reports a failed close as unclean', async () => {
  let finish!: () => void;
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();}, () => new Promise<void>(resolve => {finish = resolve;}));
  try {
    f.stop(); await vi.advanceTimersByTimeAsync(500);
    expect(f.stops()).toEqual([]); expect(f.exit).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(f.stops()).toEqual([{type: 'stopped', clean: true}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {f.restore();}
  const failed = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();}, () => Promise.reject(new Error('History storage did not close cleanly')));
  try {
    failed.stop(); await vi.advanceTimersByTimeAsync(0);
    expect(failed.stops()).toEqual([{type: 'stopped', clean: false}]); expect(failed.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(failed.steps().find(step => step.name === 'history-storage')).toMatchObject({phase: 'storage', outcome: 'failed'});
  } finally {failed.restore();}
});
it.each([['stopped', 0], ['SERVICE_STOP_FAILED', 1]] as const)('closes the history database before a probe failure ends the service (%s, exit %i)', async (outcome, code) => {
  let finish!: () => void;
  const f = await stoppedService(() => Promise.resolve(), () => new Promise<void>(resolve => {finish = resolve;}));
  try {
    f.probeReport({type: 'failed', code: 'STORAGE_WORKER_FAILED'});
    f.probeReport(outcome === 'stopped' ? {type: 'stopped'} : {type: 'failed', code: 'SERVICE_STOP_FAILED'});
    await vi.advanceTimersByTimeAsync(500);
    expect(f.history.close).toHaveBeenCalledOnce(); expect(f.exit).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(code);
    expect(vi.getTimerCount()).toBe(0);
  } finally {f.restore();}
});
it('exits after a probe failure within the history close budget when the close hangs', async () => {
  const f = await stoppedService(() => Promise.resolve(), () => new Promise<void>(() => undefined));
  try {
    f.probeReport({type: 'failed', code: 'STORAGE_WORKER_FAILED'}); f.probeReport({type: 'stopped'});
    await vi.advanceTimersByTimeAsync(999); expect(f.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {f.restore();}
});
it.each(['hanging', 'failed'])('reports a %s storage step within its budget as an unclean stop and exits 1', async mode => {
  const f = await stoppedService(report => {
    if (mode === 'hanging') return new Promise<void>(() => undefined);
    report({type: 'failed', code: 'SERVICE_STOP_FAILED'}); return Promise.resolve();
  });
  try {
    // Requirement change (October 18, 2026): the timeout verdict runs one event-loop turn after the 1,000 ms budget,
    // which the fake clock schedules 1 ms later.
    f.stop(); await vi.advanceTimersByTimeAsync(mode === 'hanging' ? 1000 : 0);
    if (mode === 'hanging') {expect(f.stops()).toEqual([]); await vi.advanceTimersByTimeAsync(1);}
    else expect(f.parent.postMessage).toHaveBeenCalledWith({type: 'failed', code: 'SERVICE_STOP_FAILED'});
    expect(f.stops()).toEqual([{type: 'stopped', clean: false}]);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.steps().find(step => step.name === 'storage-probe')).toMatchObject({outcome: mode === 'hanging' ? 'timeout' : 'failed'});
  } finally {f.restore();}
});
// ET-015c (G4, G5): the service posts its recording status to main on the parent port. Expected statuses are written by
// hand from G3 and docs/telemetry-service-v1.md#recording-status-et-015c.
describe('ET-015c recording status on the parent port', () => {
  const stopProbe = (report: ProbeDependencies['report']) => {report({type: 'stopped'}); return Promise.resolve();};
  const v1Endpoint = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-123-' + randomUUID();
  const recordingPosts = (parent: {postMessage: ReturnType<typeof vi.fn>}) => parent.postMessage.mock.calls.map(call => call[0] as {type: string; status?: unknown})
    .filter(message => message.type === 'recording');

  it('reports the history database opening once in production while it stays closed, whatever the source does, and nothing after the stop begins', async () => {
    const f = await stoppedService(stopProbe);
    try {
      // Since the game recording enablement of October 25, 2026 production builds the recorder over the history database,
      // so the status is `opening` (G3 rule 2) until the database opens; `disabled` is no longer reported.
      const opening = {type: 'recording', status: {state: 'opening', target: 'history', code: null,
        losses: {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}, trip: null}};
      expect(recordingPosts(f.parent)).toEqual([opening]);
      f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
      const state = (status: V1SourceState['status']): V1SourceState => ({selection: 'synthetic', status, reason: 'fixed', fresh: status === 'connected', durable: {state: 'off'}});
      for (const status of ['waiting', 'connected', 'disconnected'] as const) f.v1.options[0].onState!(state(status));
      await vi.advanceTimersByTimeAsync(1000);
      expect(recordingPosts(f.parent)).toEqual([opening]);
      f.stop(); await vi.advanceTimersByTimeAsync(1000);
      expect(recordingPosts(f.parent)).toHaveLength(1);
      expect([f.exit.mock.calls, vi.getTimerCount()]).toEqual([[[0]], 0]);
    } finally {f.restore();}
  });

  it('reports opening, then waiting, then recording for a synthetic recording target', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t'); vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
    const sockets: TestSocket[] = [];
    const connect = vi.spyOn(net, 'connect').mockImplementation(() => {const socket = new TestSocket(); sockets.push(socket); return socket as unknown as net.Socket;});
    const answer = (value: unknown) => Promise.resolve({ok: true, value});
    const client = {
      observeHardMode: () => answer(undefined), getTrip: () => answer(undefined),
      upsertSession: () => answer({created: true, committedThroughEventSeq: '0'}), committedThrough: () => answer('0'),
      listTrips: () => answer({trips: [], nextCursor: null}), getEvent: () => answer(undefined), listEvents: () => answer([]), recordCompleteness: () => answer(undefined)
    } as unknown as StorageClient;
    const f = await stoppedService(stopProbe, undefined, {realV1: true});
    const zero = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
    const status = (state: string, trip: unknown = null) => ({type: 'recording', status: {state, target: 'synthetic', code: null, losses: zero, trip}});
    try {
      // The database is still opening when the service starts.
      expect(recordingPosts(f.parent)).toEqual([status('opening')]);
      // It opens and the synthetic source is selected in the same turn: one status, sent at the end of the 250 ms interval.
      f.history.state = 'open'; f.history.client = client; f.history.options[0].onStateChange!('open');
      f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
      await vi.advanceTimersByTimeAsync(300);
      expect(recordingPosts(f.parent)).toEqual([status('opening'), status('waiting')]);
      // A durable connection with fresh data and an open session records; the checkpoint's game has no trip yet.
      const socket = sockets[0]; socket.emit('connect');
      const s = new Script(ETS2_A);
      for (const message of [s.welcome(), s.checkpoint(null)]) socket.emit('data', encodeFrameV1(message));
      await vi.advanceTimersByTimeAsync(300);
      expect(recordingPosts(f.parent)).toEqual([status('opening'), status('waiting'), status('recording', {phase: 'idle', completeness: null, untrackedJob: false})]);
      f.stop(); await vi.advanceTimersByTimeAsync(0);
      // The stop ends the source, but no status follows once it began.
      await vi.advanceTimersByTimeAsync(1000);
      expect(recordingPosts(f.parent)).toHaveLength(3);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {connect.mockRestore(); f.restore(); vi.unstubAllEnvs();}
  });

  // Review pass 1, finding 4: a selection whose recorded data was only ever paused was recording too.
  it('reports interrupted, not waiting, when a connection that recorded only paused data is lost', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t'); vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
    const sockets: TestSocket[] = [];
    const connect = vi.spyOn(net, 'connect').mockImplementation(() => {const socket = new TestSocket(); sockets.push(socket); return socket as unknown as net.Socket;});
    const answer = (value: unknown) => Promise.resolve({ok: true, value});
    const client = {
      observeHardMode: () => answer(undefined), getTrip: () => answer(undefined),
      upsertSession: () => answer({created: true, committedThroughEventSeq: '0'}), committedThrough: () => answer('0'),
      listTrips: () => answer({trips: [], nextCursor: null}), getEvent: () => answer(undefined), listEvents: () => answer([]), recordCompleteness: () => answer(undefined)
    } as unknown as StorageClient;
    const f = await stoppedService(stopProbe, undefined, {realV1: true});
    try {
      f.history.state = 'open'; f.history.client = client; f.history.options[0].onStateChange!('open');
      f.parent.emit('message', {data: {type: 'select', source: 'synthetic'}, ports: []});
      await vi.advanceTimersByTimeAsync(300);
      const socket = sockets[0]; socket.emit('connect');
      const s = new Script(ETS2_A);
      for (const message of [s.welcome(), s.checkpoint(null, 0, {simulation: 'paused'})]) socket.emit('data', encodeFrameV1(message));
      await vi.advanceTimersByTimeAsync(300);
      socket.emit('end');
      await vi.advanceTimersByTimeAsync(300);
      expect(recordingPosts(f.parent).map(message => (message.status as {state: string}).state)).toEqual(['opening', 'waiting', 'paused', 'interrupted']);
    } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); connect.mockRestore(); f.restore(); vi.unstubAllEnvs();}
  });

  // Review pass 1, finding 3: the probe-failure exit closes the database without reporting that to main.
  it('posts no recording status once a probe failure begins the exit, so the closing database is never reported', async () => {
    vi.stubEnv('ETS2TELEMETRY_RECORDING', 'synthetic:t');
    const f = await stoppedService(() => Promise.resolve(), () => new Promise<void>(() => undefined));
    try {
      expect(recordingPosts(f.parent).map(message => (message.status as {state: string}).state)).toEqual(['opening']);
      f.probeReport({type: 'failed', code: 'STORAGE_WORKER_FAILED'}); f.probeReport({type: 'stopped'});
      // The database closes while the exit waits for it.
      f.history.state = 'closed'; f.history.options[0].onStateChange!('closed');
      await vi.advanceTimersByTimeAsync(999);
      expect(recordingPosts(f.parent).map(message => (message.status as {state: string}).state)).toEqual(['opening']);
      await vi.advanceTimersByTimeAsync(1); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {f.restore(); vi.unstubAllEnvs();}
  });
});

// ET-036: periodic liveness heartbeat on the parent port (REG-011).
describe('ET-036 telemetry service heartbeat and diagnostic freeze', () => {
  const stopProbe = (report: ProbeDependencies['report']) => {report({type: 'stopped'}); return Promise.resolve();};

  it('emits a heartbeat every 1,000 ms and cleans up all timers upon stop', async () => {
    const f = await stoppedService(stopProbe);
    const heartbeats = () => f.parent.postMessage.mock.calls
      .map(call => call[0] as {type: string})
      .filter(msg => msg.type === 'heartbeat');

    try {
      expect(heartbeats()).toHaveLength(0);

      // Advance by 1,000 ms -> 1 heartbeat
      await vi.advanceTimersByTimeAsync(1000);
      expect(heartbeats()).toHaveLength(1);

      // Advance by another 2,000 ms -> 2 more heartbeats (total 3)
      await vi.advanceTimersByTimeAsync(2000);
      expect(heartbeats()).toHaveLength(3);

      // Stop the service
      f.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);

      // Timer is cleared, no timers remain, no further heartbeats
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(heartbeats()).toHaveLength(3);
    } finally {
      f.restore();
    }
  });

  it('clears the heartbeat timer on probe-failure exit', async () => {
    const f = await stoppedService(() => Promise.resolve(), () => Promise.resolve());
    try {
      await vi.advanceTimersByTimeAsync(1000);
      f.probeReport({type: 'failed', code: 'STORAGE_WORKER_FAILED'});
      f.probeReport({type: 'stopped'});
      await vi.advanceTimersByTimeAsync(0);
      // Wait for probe failure exit
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.exit).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.restore();
    }
  });

  it('synchronously blocks event loop when diagnostic-freeze command is received in smoke mode', async () => {
    vi.stubEnv('ETS2TELEMETRY_LIVE_SMOKE', '1');
    const f = await stoppedService(stopProbe);
    try {
      const waitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      f.parent.emit('message', {data: {type: 'diagnostic-freeze', ms: 500}, ports: []});
      expect(waitSpy).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 500);
      waitSpy.mockRestore();
    } finally {
      f.stop();
      await vi.advanceTimersByTimeAsync(0);
      f.restore();
      vi.unstubAllEnvs();
    }
  });

  it('ignores diagnostic-freeze when ETS2TELEMETRY_LIVE_SMOKE is not 1 even with diagnostic dir', async () => {
    vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\dummy-dir');
    const f = await stoppedService(stopProbe);
    try {
      const waitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      f.parent.emit('message', {data: {type: 'diagnostic-freeze', ms: 500}, ports: []});
      expect(waitSpy).not.toHaveBeenCalled();
      waitSpy.mockRestore();
    } finally {
      f.stop();
      await vi.advanceTimersByTimeAsync(0);
      f.restore();
      vi.unstubAllEnvs();
    }
  });
});
