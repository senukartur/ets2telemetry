// Harness: REG-003, REG-010, REG-011. The Hard Mode fixture must survive a peer closing during a write without
// allowing callbacks from a retired connection to send frames or alter the current durable connection.
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {V1Ingestion, type V1Observation, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';

const netMock = vi.hoisted(() => ({createServer: vi.fn()}));
vi.mock('node:net', async importOriginal => ({...await importOriginal<typeof import('node:net')>(), createServer: netMock.createServer}));
type Frame = {kind: string; seq: string; data: Record<string, unknown>};
const frame = (kind: string, data: Record<string, unknown>) => {
  const bytes = Buffer.from(JSON.stringify({kind, data})), header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]);
};
class Peer extends EventEmitter {
  destroyed = false;
  frames: Frame[] = [];
  writeError?: string;
  write(bytes: Buffer, callback?: (error?: Error) => void) {
    if (this.writeError) {
      const error = Object.assign(new Error('Injected socket write failure'), {code: this.writeError});
      queueMicrotask(() => {callback?.(error); this.emit('error', error); this.destroy();});
    } else {this.frames.push(JSON.parse(bytes.subarray(4).toString('utf8')) as Frame); callback?.();}
    return true;
  }
  destroy() {if (!this.destroyed) {this.destroyed = true; this.emit('close');} return this;}
  hello(durableEvents: boolean) {this.emit('data', frame('hello', {durableEvents}));}
}
interface Source {
  endpoint: string;
  errors: string[];
  peerDisconnects: {code: string; durable: boolean}[];
  connected(): boolean;
  acked(): string;
  begin(label: string): string;
  stop(): Promise<void>;
}
let start: (config: {checkout: string; localappdata: string; channel: string; appVersion: string}) => Promise<Source>;
let accept: (peer: Peer) => void, directory: string, source: Source;
beforeAll(async () => {
  const url = pathToFileURL(path.resolve('scripts/ci/hard-mode-observation.mjs')).href;
  ({startHardModeSource: start} = await import(url) as {startHardModeSource: typeof start});
});
beforeEach(async () => {
  vi.useFakeTimers();
  netMock.createServer.mockImplementation((listener: typeof accept) => {
    accept = listener;
    return {once() {}, listen(_endpoint: string, ready: () => void) {ready();}, close(done: () => void) {done();}};
  });
  directory = await mkdtemp(path.join(os.tmpdir(), 'hard-mode-peer-'));
  source = await start({checkout: path.resolve('.'), localappdata: directory, channel: 'staging', appVersion: '0.1.0'});
});
afterEach(async () => {await source?.stop(); vi.useRealTimers(); await rm(directory, {recursive: true, force: true});});

it.each([false, true])('records EPIPE as peer closure, then serves a new durable connection (previous durable=%s)', async durable => {
  const previous = new Peer(); accept(previous); previous.hello(durable);
  previous.writeError = 'EPIPE';
  await vi.advanceTimersByTimeAsync(100);
  expect(previous.destroyed).toBe(true);
  expect(source.errors).toEqual([]);
  expect(source.peerDisconnects).toEqual([{code: 'EPIPE', durable}]);
  expect(source.connected()).toBe(false);
  const current = new Peer(); accept(current); current.hello(true);
  expect(current.frames.map(message => [message.kind, message.seq])).toEqual([['welcome', '1'], ['checkpoint', '2']]);
  expect(source.connected()).toBe(true);
  const eventSeq = source.begin('reconnected');
  const event = current.frames.find(message => message.kind === 'event');
  expect(event?.data.eventSeq).toBe('1');
  current.emit('data', frame('ack', {throughEventSeq: eventSeq}));
  expect(source.acked()).toBe('1');
  expect(source.errors).toEqual([]);
});

it.each([false, true])('retires a peer once when both handshake writes fail (durable=%s)', async durable => {
  const peer = new Peer(); peer.writeError = 'EPIPE'; accept(peer); peer.hello(durable);
  await vi.advanceTimersByTimeAsync(0);
  expect(source.errors).toEqual([]);
  expect(source.peerDisconnects).toEqual([{code: 'EPIPE', durable}]);
  expect(peer.destroyed).toBe(true);
  expect(source.connected()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps retired peer data, close and timer callbacks away from the active peer', async () => {
  const retired = new Peer(); accept(retired); retired.hello(false);
  const current = new Peer(); accept(current); current.hello(true);
  const before = current.frames.length;
  retired.emit('data', frame('clock.probe', {probeId: 'retired-probe'}));
  retired.emit('close');
  expect(current.frames).toHaveLength(before);
  expect(source.connected()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(current.frames.map(message => [message.kind, message.seq])).toEqual([['welcome', '1'], ['checkpoint', '2'], ['snapshot', '3']]);
  expect(retired.frames).toHaveLength(2);
});

it('still reports unexpected active write errors once and retires the failed peer', async () => {
  const current = new Peer(); accept(current); current.hello(true); current.writeError = 'EIO';
  await vi.advanceTimersByTimeAsync(100);
  expect(source.errors).toEqual(['EIO']);
  expect(source.peerDisconnects).toEqual([]);
  expect(current.destroyed).toBe(true);
  expect(source.connected()).toBe(false);
});

it.each(['event', 'snapshot'] as const)('fails an EPIPE on %s while a durable event is unacknowledged', async kind => {
  const peer = new Peer(); accept(peer); peer.hello(true);
  if (kind === 'event') peer.writeError = 'EPIPE';
  source.begin('unacknowledged');
  if (kind === 'snapshot') {peer.writeError = 'EPIPE'; await vi.advanceTimersByTimeAsync(100);}
  else await vi.advanceTimersByTimeAsync(0);
  expect(source.errors).toEqual(['EPIPE']);
  expect(source.peerDisconnects).toEqual([]);
  expect(source.acked()).toBe('0');
  expect(source.connected()).toBe(false);
});

it('fails a clean disconnect with an unacknowledged event instead of silently resuming across a gap', () => {
  const peer = new Peer(); accept(peer); peer.hello(true); source.begin('unacknowledged');
  peer.destroy();
  expect(source.errors).toEqual(['UNACKNOWLEDGED_EVENTS']);
  expect(source.acked()).toBe('0');
});

it('tolerates EPIPE after the durable event was acknowledged', async () => {
  const peer = new Peer(); accept(peer); peer.hello(true);
  const eventSeq = source.begin('acknowledged'); peer.emit('data', frame('ack', {throughEventSeq: eventSeq}));
  peer.writeError = 'EPIPE'; await vi.advanceTimersByTimeAsync(100);
  expect(source.errors).toEqual([]);
  expect(source.peerDisconnects).toEqual([{code: 'EPIPE', durable: true}]);
  expect(source.acked()).toBe('1');
});

it('stops idempotently and ignores already queued callbacks from the stopped peer', async () => {
  const current = new Peer(); accept(current); current.hello(true);
  const before = current.frames.length;
  await source.stop(); await source.stop();
  current.emit('data', frame('clock.probe', {probeId: 'after-stop'}));
  await vi.advanceTimersByTimeAsync(100);
  expect(current.frames).toHaveLength(before);
  expect(source.connected()).toBe(false);
  expect(source.errors).toEqual([]);
});

it('reconnects the production v1 consumer over a real pipe after a peer write failure', async () => {
  await source.stop(); vi.useRealTimers();
  const sockets: net.Socket[] = [];
  netMock.createServer.mockImplementation((listener: (socket: net.Socket) => void) => net.createServer(socket => {sockets.push(socket); listener(socket);}));
  source = await start({checkout: path.resolve('.'), localappdata: directory, channel: 'staging', appVersion: '0.1.0'});
  let receive: ((state: V1SourceState) => void) | undefined, guard: ReturnType<typeof setTimeout> | undefined;
  const checkpoint = () => new Promise<V1Observation>((resolve, reject) => {
    // A hang guard for real pipe/process scheduling, never a product timing assertion or polling delay.
    guard = setTimeout(() => reject(new Error('Hard Mode fixture checkpoint hang guard')), 4000);
    receive = state => {
      if (state.status === 'incompatible') {clearTimeout(guard); reject(new Error(state.reason));}
      if (state.status === 'connected' && state.observation?.kind === 'checkpoint') {
        clearTimeout(guard); receive = undefined; resolve(state.observation);
      }
    };
  });
  const ingestion = new V1Ingestion({onState: state => receive?.(state)});
  try {
    const first = checkpoint(); ingestion.select('synthetic', source.endpoint);
    expect(await first).toMatchObject({seq: '2', hydration: true, state: {configuration: {job: {available: false}}}});
    sockets[0].emit('error', Object.assign(new Error('Peer closed during write'), {code: 'EPIPE'}));
    const second = checkpoint(); ingestion.select('synthetic', source.endpoint);
    expect(await second).toMatchObject({seq: '2', hydration: true});
    expect(sockets).toHaveLength(2);
    expect(source.errors).toEqual([]);
    expect(source.peerDisconnects).toEqual([{code: 'EPIPE', durable: false}]);
  } finally {clearTimeout(guard); receive = undefined; await ingestion.stop();}
});
