import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {NativePipeClient, BrokerConfiguration} from '../../apps/desktop/src/native-pipe-client';
import type {TelemetryIngestion} from '../../apps/desktop/src/telemetry-ingestion';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {encodeFrame, PROTOCOL_V0, type SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import {replay, type Scenario} from '../../tools/telemetry-simulator/src/scenario';

class Child extends EventEmitter {
  writes: Buffer[] = [];
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({write: (chunk: Buffer, _encoding, callback) => {this.writes.push(Buffer.from(chunk)); callback();}});
  output(bytes: Uint8Array) {this.stdout.write(bytes);}
}
const configuration: BrokerConfiguration = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport'};
const source: SourceIdentity = {game: 'ets2', origin: 'game', processId: 123, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: '22222222-2222-4222-8222-222222222222'};
const authority = () => ({type: 'authority', schemaVersion: 1, source: {...source}, processCreationTime: '123456789', userTag: 'a'.repeat(64)});
function relay(value: unknown): Buffer {const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]);}
const hello = encodeFrame({version: PROTOCOL_V0, kind: 'hello', data: {clientInstanceId: '33333333-3333-4333-8333-333333333333', minMinor: 0, maxMinor: 0, diagnostics: false}});
const scenario: Scenario = {id: 'isolated-adapter-hydration', origin: 'synthetic', game: 'ets2', seed: 'adapter-v0', steps: [
  {action: 'reading', reading: {atMs: 0, speedMps: 25, fuelL: 73, simulation: 'running', revision: '1', truck: 'fixture', gameMinute: '1'}}, {action: 'connect', atMs: 1}
]};
const frames = replay(scenario).map(emission => Buffer.from(encodeFrame({...emission.message, source})));
let children: Child[], clients: NativePipeClient[], ingestions: TelemetryIngestion[];
let spawn: ReturnType<typeof vi.fn>;
let Client: typeof NativePipeClient, Ingestion: typeof TelemetryIngestion;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); children = []; clients = []; ingestions = [];
  spawn = vi.fn(() => {const child = new Child(); children.push(child); return child;});
  vi.doMock('node:child_process', () => ({spawn}));
  ({NativePipeClient: Client} = await import('../../apps/desktop/src/native-pipe-client'));
  ({TelemetryIngestion: Ingestion} = await import('../../apps/desktop/src/telemetry-ingestion'));
});
afterEach(async () => {
  const stops = ingestions.map(ingestion => ingestion.stop()); for (const client of clients) client.destroy();
  for (const child of children) {child.emit('close', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();}
  await Promise.all(stops); vi.clearAllTimers(); vi.useRealTimers(); vi.doUnmock('node:child_process');
});
function fixture() {
  const client = new Client(configuration, 'ets2'); clients.push(client); const child = children.at(-1)!;
  const error = vi.fn(), data = vi.fn(), connect = vi.fn(), end = vi.fn(), waiting = vi.fn();
  client.on('error', error).on('data', data).on('connect', connect).on('end', end).on('waiting', waiting);
  return {client, child, error, data, connect, end, waiting};
}
function ingestion() {
  const publish = vi.fn<(update: LiveTelemetry) => void>(); const service = new Ingestion(publish, {broker: configuration, now: () => performance.now()});
  ingestions.push(service); service.select('ets2'); return {service, publish, child: children.at(-1)!};
}

it('retains process completion until close even after destroy and exit, ignoring late bytes', async () => {
  const f = fixture(); const completed = vi.fn(); void f.client.completion.then(completed);
  expect(spawn).toHaveBeenCalledWith(configuration.executable, ['--game', 'ets2', '--discovery-dir', configuration.discoveryDirectory], {windowsHide: true, stdio: 'pipe'});
  f.client.destroy(); f.child.emit('exit', 0); f.child.output(relay(authority())); await Promise.resolve();
  expect(completed).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.child.stdin.writableEnded).toBe(true);
  f.child.emit('close', 0); await f.client.completion; expect(completed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('assembles fragmented authority/frame bytes and returns one credit only after synchronous acceptance', () => {
  const f = fixture(), receipt = relay(authority());
  for (const part of [receipt.subarray(0, 2), receipt.subarray(2, 9), receipt.subarray(9)]) f.child.output(part);
  expect(f.connect).toHaveBeenCalledOnce(); expect(Object.isFrozen(f.client.authority)).toBe(true);
  f.client.write(hello); expect(f.child.writes).toEqual([Buffer.from(hello), Buffer.from([1])]);
  f.client.on('data', () => expect(f.child.writes).toHaveLength(2));
  f.child.output(frames[0].subarray(0, 3)); expect(f.data).not.toHaveBeenCalled();
  f.child.output(frames[0].subarray(3)); expect(f.data).toHaveBeenCalledExactlyOnceWith(frames[0]);
  expect(f.child.writes).toEqual([Buffer.from(hello), Buffer.from([1]), Buffer.from([1])]);
});
it('rejects a second coalesced frame received before another peer credit can be consumed', () => {
  const f = fixture(); f.child.output(relay(authority())); f.client.write(hello);
  f.child.output(Buffer.concat(frames));
  expect(f.data).toHaveBeenCalledOnce(); expect(f.error).toHaveBeenCalledOnce();
});

it('sends one bounded hello and rejects a duplicate or oversized hello without another credit', () => {
  const f = fixture(); f.child.output(relay(authority())); f.client.write(hello); f.client.write(hello);
  expect(hello.length).toBeLessThanOrEqual(4100); expect(f.child.writes).toHaveLength(2); expect(f.error).toHaveBeenCalledOnce();
  const large = fixture(); large.child.output(relay(authority())); large.client.write(Buffer.alloc(4101));
  expect(large.error).toHaveBeenCalledOnce(); expect(large.child.writes).toEqual([]);
});
it('does not grant a new credit after the owning callback rejects/destroys a frame', () => {
  const f = fixture(); f.child.output(relay(authority())); f.client.write(hello);
  f.client.on('data', () => f.client.destroy()); f.child.output(frames[0]);
  expect(f.data).toHaveBeenCalledOnce(); expect(f.child.writes).toHaveLength(2); expect(f.child.stdin.writableEnded).toBe(true);
});
it.each([0, 3])('classifies exit code %s as EOF only after close and rejects an incomplete relay suffix', code => {
  const clean = fixture(); clean.child.output(relay(authority())); clean.child.emit('exit', code);
  expect(clean.end).not.toHaveBeenCalled(); clean.child.emit('close', code);
  expect(clean.end).toHaveBeenCalledOnce(); expect(clean.error).not.toHaveBeenCalled();
  const partial = fixture(); partial.child.output(relay(authority())); partial.child.output(Buffer.from([1, 2])); partial.child.emit('close', code);
  expect(partial.end).not.toHaveBeenCalled(); expect(partial.error).toHaveBeenCalledOnce();
});

it('rejects partial next-frame bytes without granting a retrospective credit', () => {
  const f = fixture(); f.child.output(relay(authority())); f.client.write(hello);
  f.child.output(Buffer.concat([frames[0], frames[1].subarray(0, 2)]));
  expect(f.data).toHaveBeenCalledOnce(); expect(f.error).toHaveBeenCalledOnce(); expect(f.child.writes).toHaveLength(2);
});
it.each(['complete', 'partial'])('rejects an authority receipt followed by uncredited %s frame bytes before connect', suffix => {
  const f = fixture(); f.client.once('connect', () => f.client.write(hello));
  f.child.output(Buffer.concat([relay(authority()), suffix === 'complete' ? frames[0] : frames[0].subarray(0, 2)]));
  expect(f.error).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled(); expect(f.data).not.toHaveBeenCalled(); expect(f.child.writes).toEqual([]);
});
it('accepts an exact4096-byte authority receipt and continues through separately credited frames', () => {
  const f = fixture(), json = JSON.stringify(authority()), body = Buffer.from(json + ' '.repeat(4096 - Buffer.byteLength(json))), header = Buffer.alloc(4);
  header.writeUInt32LE(4096); f.child.output(Buffer.concat([header, body])); f.client.write(hello);
  f.child.output(frames[0]); f.child.output(frames[1]);
  expect(f.error).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce(); expect(f.data).toHaveBeenCalledTimes(2); expect(f.child.writes).toHaveLength(4);
});
it('accepts waiting code2 without authority but rejects it after an authority receipt', () => {
  const absent = fixture(); absent.child.output(relay({type: 'waiting', schemaVersion: 1})); absent.child.emit('close', 2);
  expect(absent.waiting).toHaveBeenCalledOnce(); expect(absent.error).not.toHaveBeenCalled();
  const contradictory = fixture(); contradictory.child.output(relay(authority())); contradictory.child.emit('close', 2);
  expect(contradictory.waiting).not.toHaveBeenCalled(); expect(contradictory.error).toHaveBeenCalledOnce();
});
const invalidReceipts = [
  ['null receipt', () => null],
  ['array receipt', () => []],
  ['null source', () => ({...authority(), source: null})],
  ['array source', () => ({...authority(), source: []})],
  ['string PID', () => ({...authority(), source: {...source, processId: '123'}})],
  ['numeric user tag', () => ({...authority(), userTag: 1111111111111111})],
  ['coerced process UUID', () => ({...authority(), source: {...source, processInstanceId: [source.processInstanceId]}})],
  ['coerced plugin UUID', () => ({...authority(), source: {...source, pluginSessionId: [source.pluginSessionId]}})],
  ['extra receipt key', () => ({...authority(), path: 'C:\\untrusted'})],
  ['extra source key', () => ({...authority(), source: {...source, path: 'C:\\untrusted'}})],
  ['selected game mismatch', () => ({...authority(), source: {...source, game: 'ats'}})],
  ['fixture origin', () => ({...authority(), source: {...source, origin: 'synthetic'}})],
  ['invalid process UUID', () => ({...authority(), source: {...source, processInstanceId: 'invalid'}})],
  ['uppercase plugin UUID', () => ({...authority(), source: {...source, pluginSessionId: 'ABCDEFAB-1111-4111-8111-111111111111'}})],
  ['zero PID', () => ({...authority(), source: {...source, processId: 0}})],
  ['fractional PID', () => ({...authority(), source: {...source, processId: 1.5}})],
  ['PID overflow', () => ({...authority(), source: {...source, processId: 0x100000000}})],
  ['negative session', () => ({...authority(), source: {...source, windowsSessionId: -1}})],
  ['fractional session', () => ({...authority(), source: {...source, windowsSessionId: 1.5}})],
  ['session overflow', () => ({...authority(), source: {...source, windowsSessionId: 0x100000000}})],
  ['creation time overflow', () => ({...authority(), processCreationTime: '18446744073709551616'})],
  ['invalid user tag', () => ({...authority(), userTag: 'A'.repeat(64)})]
] as const;
it.each(invalidReceipts)('fails closed for %s before connect or any hello', (_label, receipt) => {
  const f = fixture(); f.child.output(relay(receipt()));
  expect(f.error).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled(); expect(f.client.authority).toBeUndefined(); expect(f.child.writes).toEqual([]);
});
it('accepts supported uint32/uint64 boundary identities without confusing session zero with missing', () => {
  const f = fixture(); f.child.output(relay({...authority(), processCreationTime: '18446744073709551615', source: {...source, processId: 0xffffffff, windowsSessionId: 0}}));
  expect(f.error).not.toHaveBeenCalled(); expect(f.client.authority?.windowsSessionId).toBe(0); expect(f.connect).toHaveBeenCalledOnce();
});
it('enforces receipt4096/frame65536/buffer65540 bounds while relaying opaque credited bytes', () => {
  const receipt = fixture(), head = Buffer.alloc(4); head.writeUInt32LE(4097); receipt.child.output(head); expect(receipt.error).toHaveBeenCalledOnce();
  const frame = fixture(); frame.child.output(relay(authority())); frame.client.write(hello); head.writeUInt32LE(65537); frame.child.output(head); expect(frame.error).toHaveBeenCalledOnce();
  const overflow = fixture(); overflow.child.output(Buffer.alloc(65541)); expect(overflow.error).toHaveBeenCalledOnce();
  const exact = fixture(); exact.child.output(relay(authority())); exact.client.write(hello);
  const body = Buffer.alloc(65536), header = Buffer.alloc(4); header.writeUInt32LE(body.length); exact.child.output(Buffer.concat([header, body]));
  // This adapter relays opaque bytes; schema validation remains in the owning ingestion.
  expect(exact.data.mock.lastCall?.[0].length).toBe(65540); expect(exact.error).not.toHaveBeenCalled();
  const uncredited = fixture(); uncredited.child.output(relay(authority())); uncredited.child.output(frames[0]);
  expect(uncredited.data).not.toHaveBeenCalled(); expect(uncredited.error).toHaveBeenCalledOnce();
});
it('bounds silent authority startup at5s, cancels once, and leaves completion pending until close', async () => {
  const f = fixture(); const done = vi.fn(); void f.client.completion.then(done);
  await vi.advanceTimersByTimeAsync(4999); expect(f.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.error).toHaveBeenCalledOnce(); expect(f.child.stdin.writableEnded).toBe(true); expect(done).not.toHaveBeenCalled();
  f.child.output(relay(authority())); await vi.advanceTimersByTimeAsync(5000); expect(f.error).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled();
  f.child.emit('close', 1); await f.client.completion; expect(done).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('routes native waiting2 to automatic ingestion retry after owned close and the bounded backoff', async () => {
  const f = ingestion(); f.child.output(relay({type: 'waiting', schemaVersion: 1})); f.child.emit('exit', 2);
  await vi.advanceTimersByTimeAsync(4000); expect(spawn).toHaveBeenCalledOnce();
  f.child.emit('close', 2); expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'waiting', fresh: false});
  await vi.advanceTimersByTimeAsync(249); expect(spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(spawn).toHaveBeenCalledTimes(2);
});
it('does not overlap a new broker when handshake retirement/backoff precedes delayed child close', async () => {
  const f = ingestion(); f.child.output(relay({type: 'waiting', schemaVersion: 1})); f.child.emit('exit', 2);
  await vi.advanceTimersByTimeAsync(9000); expect(f.child.stdin.writableEnded).toBe(true); expect(spawn).toHaveBeenCalledOnce();
  f.child.emit('close', 2); await vi.advanceTimersByTimeAsync(0); expect(spawn).toHaveBeenCalledTimes(2);
});
it.each(['native hard1', 'source mismatch', 'duplicate welcome'])('keeps %s incompatible without automatic game retries', async failure => {
  const f = ingestion();
  if (failure === 'native hard1') f.child.emit('close', 1);
  else {
    f.child.output(relay(authority()));
    if (failure === 'source mismatch') {
      const welcome = replay(scenario)[0].message; f.child.output(encodeFrame({...welcome, source: {...source, processId: source.processId + 1}}));
    } else {f.child.output(frames[0]); f.child.output(frames[0]);}
  }
  expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'incompatible', fresh: false});
  f.child.emit('close', 1); await vi.advanceTimersByTimeAsync(10000); expect(spawn).toHaveBeenCalledOnce();
});
it('hydrates only after checkpoint and reports disconnect3 as unknown before reconnect', async () => {
  const f = ingestion(); f.child.output(relay(authority())); f.child.output(frames[0]);
  expect(f.publish.mock.lastCall?.[0].fresh).toBe(false);
  f.child.output(frames[1]); expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'connected', fresh: true, observation: {state: {speed: {available: true, value: 25}, fuel: {available: true, value: 73}}}});
  f.child.emit('close', 3); expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'disconnected', fresh: false, coverage: 'unknown'});
  await vi.advanceTimersByTimeAsync(250); expect(spawn).toHaveBeenCalledTimes(2);
});
it('retains latest manual selection and stop completion while cancelled child close is delayed', async () => {
  const f = ingestion(); f.service.select('ats'); f.child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(6000); expect(spawn).toHaveBeenCalledOnce();
  f.child.emit('close', 0); await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledTimes(2); expect(spawn.mock.lastCall?.[1]).toEqual(['--game', 'ats', '--discovery-dir', configuration.discoveryDirectory]);
  const stopped = vi.fn(); const stopping = f.service.stop().then(stopped); const second = children[1]; second.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(6000); expect(stopped).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledTimes(2);
  second.emit('close', 0); await stopping; expect(stopped).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
