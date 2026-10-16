// ET-015a PR-4: the recording runtime journey's proxy (scripts/ci/recording-proxy.mjs) over actual Windows named pipes.
// It forwards only durable hellos, one admitted connection at a time, never admits a hold older than its limit (so an
// admission cannot be consumed by a connection the service is about to close at its 5 s handshake deadline), applies the
// scripted ACK delivery and records each event's time to its first covering ACK.
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {afterEach, expect, it, vi} from 'vitest';
import type {RecordingProxy, startRecordingProxy as StartRecordingProxy} from '../../scripts/ci/recording-proxy.mjs';

// Runtime helpers are JavaScript outside the application TypeScript project.
const proxyModule = pathToFileURL(path.resolve('scripts/ci/recording-proxy.mjs')).href;
const load = async () => (await import(proxyModule) as {startRecordingProxy: typeof StartRecordingProxy}).startRecordingProxy;

type Message = {kind: string; data: Record<string, unknown>};
const frame = (message: Message) => {
  const payload = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
};
const frames = (bytes: Buffer): Message[] => {
  const out: Message[] = [];
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    out.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString('utf8')) as Message); offset += 4 + length;
  }
  return out;
};
const hello = (durableEvents: boolean) => frame({kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents}});

/** A stand-in for the simulator: records each connection's client bytes and lets the test write server frames. */
async function upstreamServer() {
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  const connections: {socket: net.Socket; received: Buffer}[] = [];
  const server = net.createServer(socket => {
    const connection = {socket, received: Buffer.alloc(0)};
    connections.push(connection);
    socket.on('data', bytes => {connection.received = Buffer.concat([connection.received, bytes]);});
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return {endpoint, connections, close: () => new Promise<void>(resolve => {for (const c of connections) c.socket.destroy(); server.close(() => resolve());})};
}
/** A stand-in for the service's v1 client: connects, writes its hello and records what it receives and whether it closed. */
function client(endpoint: string, first: Buffer) {
  const socket = net.connect(endpoint), state = {received: Buffer.alloc(0), closed: false, socket};
  socket.on('connect', () => socket.write(first));
  socket.on('data', bytes => {state.received = Buffer.concat([state.received, bytes]);});
  socket.on('close', () => {state.closed = true;});
  socket.on('error', () => undefined);
  return state;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function setup(options: {deliveredAcks?: number[]; holdLimitMs?: number; now?: () => number} = {}) {
  const upstream = await upstreamServer(); cleanup.push(upstream.close);
  const proxy: RecordingProxy = await (await load())({upstream: upstream.endpoint, ...options}); cleanup.push(proxy.stop);
  return {upstream, proxy};
}

it('refuses a live-only hello and forwards a durable one only after its admission', async () => {
  const {upstream, proxy} = await setup();
  const liveOnly = client(proxy.endpoint, hello(false));
  await vi.waitFor(() => expect(liveOnly.closed).toBe(true), {timeout: 2000, interval: 10});
  expect(proxy.statistics()).toMatchObject({attempts: 1, refusedLiveOnly: 1, held: false, connections: []});
  const durable = client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(proxy.statistics().held).toBe(true), {timeout: 2000, interval: 10});
  expect(upstream.connections).toHaveLength(0);
  proxy.admit();
  await vi.waitFor(() => expect(frames(upstream.connections[0]?.received ?? Buffer.alloc(0)).map(m => m.kind)).toEqual(['hello']), {timeout: 2000, interval: 10});
  expect(durable.closed).toBe(false);
  expect(proxy.statistics()).toMatchObject({refusedLiveOnly: 1, expiredHolds: 0, admissionsPending: 0, held: false, connections: [{connection: 1, closedBy: null}]});
});

it('destroys a hold at its limit without consuming the admission, and admits the next fresh hello', async () => {
  const {upstream, proxy} = await setup({holdLimitMs: 150});
  const stale = client(proxy.endpoint, hello(true));
  // The service would close this connection at its own deadline; the proxy ends it first, before any admission.
  await vi.waitFor(() => expect(stale.closed).toBe(true), {timeout: 2000, interval: 10});
  expect(proxy.statistics()).toMatchObject({expiredHolds: 1, held: false, connections: []});
  proxy.admit();
  expect(proxy.statistics().admissionsPending).toBe(1);
  const fresh = client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(upstream.connections).toHaveLength(1), {timeout: 2000, interval: 10});
  expect(fresh.closed).toBe(false);
  expect(proxy.statistics()).toMatchObject({expiredHolds: 1, admissionsPending: 0, connections: [{connection: 1}]});
  expect(proxy.statistics().connections[0].heldMs).toBeLessThan(150);
});

it('does not admit a hold that is already older than its limit when the admission arrives', async () => {
  // The hold clock jumps past the limit before the admission; the hold's own timer (10 s) has not run yet.
  let clock = 0;
  const {upstream, proxy} = await setup({holdLimitMs: 10000, now: () => clock});
  const late = client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(proxy.statistics().held).toBe(true), {timeout: 2000, interval: 10});
  clock = 10000;
  proxy.admit();
  await vi.waitFor(() => expect(late.closed).toBe(true), {timeout: 2000, interval: 10});
  expect(upstream.connections).toHaveLength(0);
  expect(proxy.statistics()).toMatchObject({expiredHolds: 1, admissionsPending: 1, connections: []});
  clock = 10001;
  client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(upstream.connections).toHaveLength(1), {timeout: 2000, interval: 10});
  expect(proxy.statistics()).toMatchObject({admissionsPending: 0, connections: [{connection: 1, heldMs: 0}]});
});

it('delivers the scripted number of ACKs, records the lost ones and each event-to-ACK latency, and serves one connection at a time', async () => {
  // The second hello stays held across several waits; a long hold limit keeps this case off the wall clock (cases 2 and 3 cover expiry).
  const {upstream, proxy} = await setup({deliveredAcks: [1], holdLimitMs: 60000});
  proxy.admit(); proxy.admit();
  const first = client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(upstream.connections).toHaveLength(1), {timeout: 2000, interval: 10});
  const server = upstream.connections[0].socket;
  server.write(Buffer.concat([frame({kind: 'checkpoint', data: {status: {delivery: {ackedThroughEventSeq: '0'}}}}),
    frame({kind: 'event', data: {eventSeq: '1', redelivered: false}}), frame({kind: 'event', data: {eventSeq: '2', redelivered: false}})]));
  await vi.waitFor(() => expect(frames(first.received).map(m => m.kind)).toEqual(['checkpoint', 'event', 'event']), {timeout: 2000, interval: 10});
  // A second durable client waits while the first connection is open.
  const second = client(proxy.endpoint, hello(true));
  await vi.waitFor(() => expect(proxy.statistics().held).toBe(true), {timeout: 2000, interval: 10});
  first.socket.write(Buffer.concat([frame({kind: 'ack', data: {throughEventSeq: '1'}}), frame({kind: 'ack', data: {throughEventSeq: '2'}})]));
  await vi.waitFor(() => expect(proxy.statistics().connections[0].acks).toEqual(['1', '2']), {timeout: 2000, interval: 10});
  const record = proxy.statistics().connections[0];
  expect(record).toMatchObject({checkpointAckedThrough: '0', forwardedAcks: ['1'], withheldAcks: ['2'],
    events: [{eventSeq: '1', redelivered: false}, {eventSeq: '2', redelivered: false}]});
  expect(record.ackLatencyMs.map(latency => latency.eventSeq)).toEqual(['1', '2']);
  for (const latency of record.ackLatencyMs) expect(latency.ms).toBeGreaterThanOrEqual(0);
  await vi.waitFor(() => expect(frames(upstream.connections[0].received).map(m => m.kind)).toEqual(['hello', 'ack']), {timeout: 2000, interval: 10});
  expect(upstream.connections).toHaveLength(1);
  // When the first client leaves, the held second connection starts with the remaining admission.
  first.socket.destroy();
  await vi.waitFor(() => expect(upstream.connections).toHaveLength(2), {timeout: 2000, interval: 10});
  expect(second.closed).toBe(false);
  expect(proxy.statistics().connections.map(c => c.closedBy)).toEqual(['client', null]);
});
