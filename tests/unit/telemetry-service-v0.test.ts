import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {TelemetryIngestion, TEST_PIPE_PATTERN, initialLive, sourceSelection} from '../../apps/desktop/src/telemetry-ingestion';
import {LiveSubscriptions, type LivePort} from '../../apps/desktop/src/live-subscriptions';
import {ServiceSupervisor} from '../../apps/desktop/src/service-supervisor';
import type {ProbeDependencies} from '../../apps/desktop/src/service-probe';
import {FrameDecoder, encodeFrame} from '../../packages/contracts/src/protocol-v0';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry} from '../../packages/contracts/src';
import type {V1IngestionOptions, V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import type {BrokerConfiguration} from '../../apps/desktop/src/native-pipe-client';
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
beforeEach(() => {expect(loadingService.size, 'a previous case left telemetry-service loading').toBe(0);});
afterEach(async () => {
  await Promise.allSettled(loadingService); await new Promise(resolve => realSetImmediate(resolve));
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
  vi.doMock('../../apps/desktop/src/diagnostics', () => ({createDiagnostics: () => vi.fn()}));
  // Isolate the existing storage probe; exercise the actual service handlers and ingestion.
  vi.doMock('../../apps/desktop/src/service-probe', () => ({ServiceProbe: class {
    constructor(private readonly dependencies: ProbeDependencies) {}
    start() {this.dependencies.report({type: 'ready'}); return Promise.resolve();}
    stop() {this.dependencies.report({type: 'stopped'}); return Promise.resolve();}
  }}));
  // The history database is opened by its own worker; never touch the real LOCALAPPDATA from a Node unit test.
  vi.doMock('../../apps/desktop/src/history-storage', () => ({HISTORY_CLOSE_BUDGET_MS: 1000, historyWorker: vi.fn(), HistoryStorage: class {start() {} close() {return Promise.resolve();}}}));
  const command = (type: string, ports: TestPort[] = []) => parent.emit('message', {data: {type, source: 'synthetic'}, ports});
  try {
    await loadService();
    expect(parent.postMessage).toHaveBeenCalledWith({type: 'ready'}); expect(connect).not.toHaveBeenCalled();
    for (const broker of [null, [], {executable: 123, discoveryDirectory: 'isolated'}, {executable: 'isolated', discoveryDirectory: []}]) {
      parent.emit('message', {data: {type: 'select', source: 'synthetic', broker}, ports: []});
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
async function stoppedService(stopProbe: (report: ProbeDependencies['report']) => Promise<void>, closeHistory: () => Promise<void> = () => Promise.resolve()) {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const previousPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const parent = Object.assign(new EventEmitter(), {postMessage: vi.fn()});
  Object.defineProperty(process, 'parentPort', {configurable: true, value: parent});
  const log = vi.fn();
  vi.doMock('../../apps/desktop/src/diagnostics', () => ({createDiagnostics: () => log}));
  let probeReport: ProbeDependencies['report'] = () => undefined;
  vi.doMock('../../apps/desktop/src/service-probe', () => ({ServiceProbe: class {
    constructor(private readonly dependencies: ProbeDependencies) {probeReport = message => dependencies.report(message);}
    start() {this.dependencies.report({type: 'ready'}); return Promise.resolve();}
    stop() {return stopProbe(message => this.dependencies.report(message));}
  }}));
  const history = {start: vi.fn(), close: vi.fn(closeHistory)};
  vi.doMock('../../apps/desktop/src/history-storage', () => ({HISTORY_CLOSE_BUDGET_MS: 1000, historyWorker: vi.fn(), HistoryStorage: class {start() {history.start();} close() {return history.close();}}}));
  // The protocol v1 ingestion (ET-006b) is replaced like the history database: its options and calls are recorded.
  const v1 = {options: [] as V1IngestionOptions[], configureBroker: vi.fn<(configuration: BrokerConfiguration | undefined) => void>(),
    select: vi.fn<(selection: string, endpoint?: string) => void>(), stop: vi.fn(() => Promise.resolve())};
  vi.doMock('../../apps/desktop/src/v1-ingestion', () => ({V1Ingestion: class {
    constructor(options: V1IngestionOptions) {v1.options.push(options);}
    configureBroker(configuration: BrokerConfiguration | undefined) {v1.configureBroker(configuration);}
    select(selection: string, endpoint?: string) {v1.select(selection, endpoint);}
    stop() {return v1.stop();}
  }}));
  await loadService();
  const restore = () => {
    if (previousPort) Object.defineProperty(process, 'parentPort', previousPort); else Reflect.deleteProperty(process, 'parentPort');
    exit.mockRestore(); vi.doUnmock('../../apps/desktop/src/diagnostics'); vi.doUnmock('../../apps/desktop/src/service-probe'); vi.doUnmock('../../apps/desktop/src/history-storage');
    vi.doUnmock('../../apps/desktop/src/v1-ingestion'); vi.resetModules();
  };
  const stops = () => parent.postMessage.mock.calls.map(call => call[0] as {type: string}).filter(message => message.type === 'stopped');
  const steps = () => log.mock.calls.filter(call => call[0] === 'SHUTDOWN_STEP').map(call => call[2] as Record<string, unknown>);
  return {exit, parent, log, history, v1, restore, stops, steps, probeReport: (message: Parameters<ProbeDependencies['report']>[0]) => probeReport(message),
    stop: () => parent.emit('message', {data: {type: 'stop'}, ports: []})};
}
it('runs the ordered shutdown once and reports exactly one clean stopped message before exit 0', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    f.stop(); f.stop(); await vi.advanceTimersByTimeAsync(0);
    expect(f.stops()).toEqual([{type: 'stopped', clean: true}]);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    // ET-013 adds the history database close beside the probe in the storage phase, and ET-006b the v1 ingestion beside
    // the v0 ingestion and capture in the intake phase; steps of one phase finish in any order.
    const steps = f.steps().map(step => [step.phase, step.name, step.outcome]);
    expect(steps.slice(0, 3).sort()).toEqual([['intake', 'capture', 'ok'], ['intake', 'ingestion', 'ok'], ['intake', 'v1-ingestion', 'ok']]);
    expect(steps.slice(3).sort()).toEqual([['storage', 'history-storage', 'ok'], ['storage', 'storage-probe', 'ok']]);
    expect(f.history.start).toHaveBeenCalledOnce(); expect(f.history.close).toHaveBeenCalledOnce(); expect(f.v1.stop).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith('SERVICE_REPORT', {type: 'stopped', clean: true});
    expect(vi.getTimerCount()).toBe(0);
  } finally {f.restore();}
});
it('runs protocol v1 beside v0 without a durable sink, following each selection with the v1 fixture endpoint and the derived broker directory', async () => {
  const v1Endpoint = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-123-' + randomUUID();
  vi.stubEnv('ETS2TELEMETRY_SOURCE_PIPE_V1', v1Endpoint);
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  const select = (source: string, broker?: BrokerConfiguration) => f.parent.emit('message', {data: {type: 'select', source, broker}, ports: []});
  try {
    // E2: live-only. No sink means a durableEvents false hello, no ACK and no history row.
    expect(f.v1.options).toHaveLength(1);
    expect(Object.keys(f.v1.options[0]).sort()).toEqual(['connectGame', 'diagnose', 'onState']);
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
    select('synthetic');
    expect(f.parent.postMessage).not.toHaveBeenCalledWith({type: 'failed', code: 'INVALID_SOURCE_COMMAND'}); expect(f.log).toHaveBeenCalledWith('V1_SELECT_REJECTED');
    expect(f.v1.select).toHaveBeenCalledTimes(4);
    // An invalid selection is rejected before either ingestion sees it.
    select('C:\\untrusted'); expect(f.parent.postMessage).toHaveBeenLastCalledWith({type: 'failed', code: 'INVALID_SOURCE_COMMAND'}); expect(f.v1.select).toHaveBeenCalledTimes(4);
    // Only fixed status codes are logged, on a change of status, at occurrences 1, 2, 4, 8, ... of each status.
    const state = (status: V1SourceState['status']): V1SourceState => ({selection: 'ets2', status, reason: 'fixed', fresh: false, durable: {state: 'off'}});
    for (const status of ['waiting', 'connected', 'connected', 'disconnected', 'waiting', 'disconnected', 'waiting', 'disconnected', 'waiting'] as const) f.v1.options[0].onState!(state(status));
    expect(f.log.mock.calls.filter(call => call[0] === 'V1_SOURCE_STATUS').map(call => call[2] as Record<string, unknown>)).toEqual([
      {status: 'waiting', selection: 'ets2', durable: 'off', count: 1}, {status: 'connected', selection: 'ets2', durable: 'off', count: 1},
      {status: 'disconnected', selection: 'ets2', durable: 'off', count: 1}, {status: 'waiting', selection: 'ets2', durable: 'off', count: 2},
      {status: 'disconnected', selection: 'ets2', durable: 'off', count: 2}, {status: 'waiting', selection: 'ets2', durable: 'off', count: 4}
    ]);
    f.v1.options[0].diagnose!('V1_DURABLE_UNAVAILABLE', {code: 'WORKER_FAILED'});
    expect(f.log).toHaveBeenLastCalledWith('V1_DURABLE_UNAVAILABLE', undefined, {code: 'WORKER_FAILED'});
  } finally {f.stop(); await vi.advanceTimersByTimeAsync(0); f.restore(); vi.unstubAllEnvs();}
});
it('bounds the v1 ingestion stop by its 1,000 ms intake budget and reports a late stop as unclean', async () => {
  const f = await stoppedService(report => {report({type: 'stopped'}); return Promise.resolve();});
  try {
    f.v1.stop.mockImplementation(() => new Promise<void>(() => undefined));
    f.stop(); await vi.advanceTimersByTimeAsync(999);
    expect(f.stops()).toEqual([]); expect(f.history.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.steps().find(step => step.name === 'v1-ingestion')).toMatchObject({phase: 'intake', outcome: 'timeout'});
    expect(f.stops()).toEqual([{type: 'stopped', clean: false}]); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
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
    f.stop(); await vi.advanceTimersByTimeAsync(mode === 'hanging' ? 999 : 0);
    if (mode === 'hanging') {expect(f.stops()).toEqual([]); await vi.advanceTimersByTimeAsync(1);}
    else expect(f.parent.postMessage).toHaveBeenCalledWith({type: 'failed', code: 'SERVICE_STOP_FAILED'});
    expect(f.stops()).toEqual([{type: 'stopped', clean: false}]);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.steps().find(step => step.name === 'storage-probe')).toMatchObject({outcome: mode === 'hanging' ? 'timeout' : 'failed'});
  } finally {f.restore();}
});
