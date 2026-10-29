import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {NativePipeClient, NativeClientError, BrokerConfiguration, BrokerDiagnostic} from '../../apps/desktop/src/native-pipe-client';
import type {TelemetryIngestion} from '../../apps/desktop/src/telemetry-ingestion';
import type {V1Ingestion} from '../../apps/desktop/src/v1-ingestion';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {encodeFrame, PROTOCOL_V0, type SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import {decodePayload, encodeFrame as encodeV1Frame, PROTOCOL_V1, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {readFileSync} from 'node:fs';
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
let children: Child[], clients: NativePipeClient[], ingestions: TelemetryIngestion[], v1Ingestions: V1Ingestion[];
let spawn: ReturnType<typeof vi.fn>;
let Client: typeof NativePipeClient, Ingestion: typeof TelemetryIngestion, V1: typeof V1Ingestion;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); children = []; clients = []; ingestions = []; v1Ingestions = [];
  spawn = vi.fn(() => {const child = new Child(); children.push(child); return child;});
  vi.doMock('node:child_process', () => ({spawn}));
  ({NativePipeClient: Client} = await import('../../apps/desktop/src/native-pipe-client'));
  ({TelemetryIngestion: Ingestion} = await import('../../apps/desktop/src/telemetry-ingestion'));
  ({V1Ingestion: V1} = await import('../../apps/desktop/src/v1-ingestion'));
});
afterEach(async () => {
  const stops = [...ingestions, ...v1Ingestions].map(ingestion => ingestion.stop()); for (const client of clients) client.destroy();
  for (const child of children) {child.emit('close', 0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();}
  await Promise.all(stops); vi.clearAllTimers(); vi.useRealTimers(); vi.doUnmock('node:child_process');
});
function fixture(diagnose?: (diagnostic: BrokerDiagnostic) => void) {
  const client = new Client(configuration, 'ets2', diagnose); clients.push(client); const child = children.at(-1)!;
  const error = vi.fn(), data = vi.fn(), connect = vi.fn(), end = vi.fn(), waiting = vi.fn();
  client.on('error', error).on('data', data).on('connect', connect).on('end', end).on('waiting', waiting);
  return {client, child, error, data, connect, end, waiting};
}
function ingestion(diagnose?: (diagnostic: BrokerDiagnostic) => void) {
  const publish = vi.fn<(update: LiveTelemetry) => void>(); const service = new Ingestion(publish, {broker: configuration, now: () => performance.now(), diagnose});
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
const failure = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[0]?.[0] as NativeClientError | undefined;
it('classifies broker contention4 before authority as transient and logs only its fixed diagnostic codes', () => {
  const diagnose = vi.fn(), f = fixture(diagnose);
  f.child.stderr.write('diag1 policy-publish 5 172 policy-write 172\n'); f.child.emit('close', 4);
  expect(failure(f.error)).toMatchObject({transient: true, outcome: 'busy'}); expect(f.waiting).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled();
  expect(diagnose).toHaveBeenCalledExactlyOnceWith({outcome: 'busy', exitCode: 4, serviceMs: 0, stage: 'policy-publish', win32Error: 5, elapsedMs: 172, slowStage: 'policy-write', slowMs: 172});
  const late = fixture(); late.child.output(relay(authority())); late.child.emit('close', 4);
  expect(failure(late.error)).toMatchObject({transient: false, outcome: 'rejected'});
});
it('keeps authority exit1 hard while recording its stage, and never logs routine waiting or owner cancellation', () => {
  const diagnose = vi.fn(), hard = fixture(diagnose);
  hard.child.stderr.write('diag1 server-image 5 40 discovery 30\n'); hard.child.emit('close', 1);
  expect(failure(hard.error)).toMatchObject({transient: false, outcome: 'rejected'});
  expect(diagnose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outcome: 'rejected', exitCode: 1, stage: 'server-image', win32Error: 5}));
  const waiting = fixture(diagnose); waiting.child.output(relay({type: 'waiting', schemaVersion: 1})); waiting.child.stderr.write('diag1 discovery 0 20 policy-write 15\n'); waiting.child.emit('close', 2);
  const cancelled = fixture(diagnose); cancelled.client.destroy(); cancelled.child.emit('close', 3);
  expect(diagnose).toHaveBeenCalledOnce();
});
it('bounds and sanitizes broker stderr to fixed stage codes and numbers', () => {
  const diagnose = vi.fn();
  const path = fixture(diagnose); path.child.stderr.write('C:\\Users\\private\\eurotrucks2.exe ' +'x'.repeat(10000) + '\ndiag1 policy-lock 80 3 own-image 2\n'); path.child.emit('close', 4);
  const unknown = fixture(diagnose); unknown.child.stderr.write('diag1 private-stage 1 2 another-stage 4\n'); unknown.child.emit('close', 1);
  const missing = fixture(diagnose); missing.child.stderr.write('C:\\Users\\private\\eurotrucks2.exe\n'); missing.child.emit('close', 1);
  expect(diagnose.mock.calls.map(call => call[0] as BrokerDiagnostic)).toEqual([
    {outcome: 'busy', exitCode: 4, serviceMs: 0, stage: 'policy-lock', win32Error: 80, elapsedMs: 3, slowStage: 'own-image', slowMs: 2},
    {outcome: 'rejected', exitCode: 1, serviceMs: 0, stage: 'unrecognized', win32Error: 1, elapsedMs: 2, slowStage: 'unrecognized', slowMs: 4},
    {outcome: 'rejected', exitCode: 1, serviceMs: 0, stage: 'unreported', win32Error: null, elapsedMs: null, slowStage: 'unreported', slowMs: null}
  ]);
  expect(JSON.stringify(diagnose.mock.calls)).not.toMatch(/private|eurotrucks2|Users/);
});
it('treats the5s startup deadline as transient and logs the broker stage once it actually exits', async () => {
  const diagnose = vi.fn(), f = fixture(diagnose);
  await vi.advanceTimersByTimeAsync(5000); expect(failure(f.error)).toMatchObject({transient: true, outcome: 'startup-deadline'}); expect(diagnose).not.toHaveBeenCalled();
  // serviceMs also covers launch time that the broker's own clock cannot see.
  await vi.advanceTimersByTimeAsync(10000); f.child.stderr.write('diag1 hello 0 7300 policy-write 6900\n'); f.child.emit('close', 3);
  expect(diagnose).toHaveBeenCalledExactlyOnceWith({outcome: 'startup-deadline', exitCode: 3, serviceMs: 15000, stage: 'hello', win32Error: 0, elapsedMs: 7300, slowStage: 'policy-write', slowMs: 6900});
});
it.each(['contention4', 'deadline'])('retries a transient %s game failure on the normal backoff after actual broker exit instead of becoming incompatible', async trigger => {
  const diagnose = vi.fn(), f = ingestion(diagnose);
  if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(5000); else f.child.emit('close', 4);
  expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'waiting', reason: 'Native authority check did not complete; retrying', fresh: false});
  if (trigger === 'deadline') {await vi.advanceTimersByTimeAsync(10000); expect(spawn).toHaveBeenCalledOnce(); f.child.emit('close', 3); await vi.advanceTimersByTimeAsync(0);}
  else {await vi.advanceTimersByTimeAsync(249); expect(spawn).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1);}
  expect(spawn).toHaveBeenCalledTimes(2);
  // A second transient failure keeps the existing exponential backoff; a later hard rejection stays final.
  children[1].emit('close', 4); await vi.advanceTimersByTimeAsync(499); expect(spawn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(spawn).toHaveBeenCalledTimes(3);
  children[2].emit('close', 1); expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'incompatible', fresh: false});
  await vi.advanceTimersByTimeAsync(20000); expect(spawn).toHaveBeenCalledTimes(3);
  expect(diagnose.mock.calls.map(call => (call[0] as BrokerDiagnostic).outcome)).toEqual([trigger === 'deadline' ? 'startup-deadline' : 'busy', 'busy', 'rejected']);
});
it('coalesces a repeating identical broker failure at power-of-two occurrences so retries cannot fill the bounded log', async () => {
  const {coalesceBrokerDiagnostics} = await import('../../apps/desktop/src/native-pipe-client');
  const record = vi.fn(), diagnose = coalesceBrokerDiagnostics(record);
  const busy: BrokerDiagnostic = {outcome: 'busy', exitCode: 4, serviceMs: 20, stage: 'policy-publish', win32Error: 5, elapsedMs: 15, slowStage: 'policy-write', slowMs: 15};
  for (let i = 0; i < 9; i++) diagnose(busy);
  diagnose({...busy, outcome: 'rejected', exitCode: 1}); diagnose(busy); diagnose({...busy, win32Error: 32});
  expect(record.mock.calls.map(call => [(call[0] as BrokerDiagnostic).outcome, (call[0] as {repeats: number}).repeats])).toEqual([['busy', 1], ['busy', 2], ['busy', 4], ['busy', 8], ['rejected', 1], ['busy', 1], ['busy', 1]]);
});

// ET-006b PR-3: the broker's protocol v1 mode (docs/telemetry-service-v0.md, Protocol v1 mode).
const v1Configuration: BrokerConfiguration = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\ETS2Telemetry\\transport\\v1'};
const v1Fixture = (name: string) => decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/${name}.json`)), 'server') as ServerMessage;
/** The broker reports the plugin's identity with origin game; the shared fixture source is used so envelopes can match. */
const v1Source = {...v1Fixture('welcome-live').source, origin: 'game' as const};
const v1Authority = () => ({type: 'authority', schemaVersion: 1, protocolMajor: 1, source: {...v1Source}, processCreationTime: '123456789', userTag: 'a'.repeat(64)});
const asGame = (name: string) => Buffer.from(encodeV1Frame({...v1Fixture(name), source: v1Source}));
const helloV1 = Buffer.from(encodeV1Frame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: '33333333-3333-4333-8333-333333333333', minMinor: 0, maxMinor: 0, durableEvents: false}}));
const ackV1 = Buffer.from(encodeV1Frame({version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: v1Source.pluginSessionId, throughEventSeq: '1'}}));
function fixtureV1(diagnose?: (diagnostic: BrokerDiagnostic) => void) {
  const client = new Client(v1Configuration, 'ets2', diagnose, 'v1'); clients.push(client); const child = children.at(-1)!;
  const error = vi.fn(), data = vi.fn(), connect = vi.fn(), end = vi.fn();
  client.on('error', error).on('data', data).on('connect', connect).on('end', end);
  return {client, child, error, data, connect, end};
}
it('spawns the v1 broker mode, sends the hello raw and tags every later client frame 0x02 apart from 0x01 credits', () => {
  const f = fixtureV1();
  expect(spawn).toHaveBeenCalledWith(v1Configuration.executable, ['--game', 'ets2', '--discovery-dir', v1Configuration.discoveryDirectory, '--protocol', 'v1'], {windowsHide: true, stdio: 'pipe'});
  f.child.output(relay(v1Authority())); expect(f.connect).toHaveBeenCalledOnce(); expect(f.client.authority).toEqual(v1Source);
  f.client.write(helloV1); expect(f.child.writes).toEqual([helloV1, Buffer.from([1])]);
  f.child.output(asGame('welcome-live')); expect(f.data).toHaveBeenCalledOnce();
  f.client.write(ackV1);
  // Tag, then the frame unchanged: its own u32 little-endian length prefix and payload.
  expect(f.child.writes).toEqual([helloV1, Buffer.from([1]), Buffer.from([1]), Buffer.concat([Buffer.from([2]), ackV1])]);
  expect(f.child.writes[3].readUInt32LE(1)).toBe(ackV1.length - 4);
  expect(f.error).not.toHaveBeenCalled();
});
const mismatchedReceipts = [
  ['a five-key v0 receipt in v1 mode', 'v1', () => authority()],
  ['protocolMajor 0 in v1 mode', 'v1', () => ({...v1Authority(), protocolMajor: 0})],
  ['protocolMajor 2 in v1 mode', 'v1', () => ({...v1Authority(), protocolMajor: 2})],
  ['a string protocolMajor in v1 mode', 'v1', () => ({...v1Authority(), protocolMajor: '1'})],
  ['a CAP0 evidence marker in v1 mode', 'v1', () => ({...authority(), evidence: 'cap0'})],
  ['a six-key v1 receipt in v0 mode', 'v0', () => ({...authority(), protocolMajor: 1})]
] as const;
it.each(mismatchedReceipts)('fails closed for %s before connect or any hello', (_label, mode, receipt) => {
  const f = mode === 'v1' ? fixtureV1() : fixture(); f.child.output(relay(receipt()));
  expect(f.error).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled(); expect(f.client.authority).toBeUndefined(); expect(f.child.writes).toEqual([]);
});
const invalidClientFrames = [
  ['a frame without a length prefix', () => Buffer.from([1, 0, 0])],
  ['an empty payload', () => Buffer.alloc(4)],
  ['a 4,097-byte payload', () => {const bytes = Buffer.alloc(4101); bytes.writeUInt32LE(4097); return bytes;}],
  ['a prefix longer than the payload', () => {const bytes = Buffer.from(ackV1); bytes.writeUInt32LE(ackV1.length - 3); return bytes;}],
  ['a prefix shorter than the payload', () => Buffer.concat([ackV1, Buffer.from([0x20])])]
] as const;
it.each(invalidClientFrames)('rejects %s after the v1 hello without writing it', (_label, bytes) => {
  const f = fixtureV1(); f.child.output(relay(v1Authority())); f.client.write(helloV1);
  f.client.write(bytes());
  expect((f.error.mock.calls[0]?.[0] as NativeClientError | undefined)?.outcome).toBe('client-frame-rejected');
  expect(f.child.writes).toEqual([helloV1, Buffer.from([1])]); expect(f.child.stdin.writableEnded).toBe(true);
});
it('accepts a 4,096-byte client payload and still rejects a second hello-sized write in v0 mode', () => {
  const f = fixtureV1(); f.child.output(relay(v1Authority())); f.client.write(helloV1);
  const largest = Buffer.alloc(4100); largest.writeUInt32LE(4096); f.client.write(largest);
  expect(f.error).not.toHaveBeenCalled(); expect(f.child.writes.at(-1)).toEqual(Buffer.concat([Buffer.from([2]), largest]));
  const v0 = fixture(); v0.child.output(relay(authority())); v0.client.write(hello); v0.client.write(ackV1);
  expect((v0.error.mock.calls[0]?.[0] as NativeClientError | undefined)?.outcome).toBe('hello-rejected'); expect(v0.child.writes).toEqual([Buffer.from(hello), Buffer.from([1])]);
});
it('recognizes the v1 broker stages client-frame and client-write in exit diagnostics', () => {
  const diagnose = vi.fn();
  const frame = fixtureV1(diagnose); frame.child.output(relay(v1Authority())); frame.client.write(helloV1);
  frame.child.stderr.write('diag1 client-frame 0 40 hello 12\n'); frame.child.emit('close', 1);
  const write = fixtureV1(diagnose); write.child.output(relay(v1Authority())); write.client.write(helloV1);
  write.child.stderr.write('diag1 client-write 232 900 policy-write 30\n'); write.child.emit('close', 3);
  expect(diagnose.mock.calls.map(call => call[0] as BrokerDiagnostic)).toEqual([
    {outcome: 'rejected', exitCode: 1, serviceMs: 0, stage: 'client-frame', win32Error: 0, elapsedMs: 40, slowStage: 'hello', slowMs: 12},
    {outcome: 'ended', exitCode: 3, serviceMs: 0, stage: 'client-write', win32Error: 232, elapsedMs: 900, slowStage: 'policy-write', slowMs: 30}
  ]);
});
it.each([
  ['C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v0', 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v1'],
  ['C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v0\\', 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\transport\\v1'],
  ['C:\\isolated\\transport', undefined],
  ['C:\\isolated\\transport\\v1', undefined],
  ['C:\\isolated\\other\\v0', undefined],
  ['C:\\isolated\\transport\\V0', undefined],
  ['transport\\v0', undefined]
] as const)('derives the v1 discovery directory from the v0 directory %s (E12)', async (v0Directory, expected) => {
  const {v1BrokerConfiguration} = await import('../../apps/desktop/src/native-pipe-client');
  expect(v1BrokerConfiguration({executable: 'C:\\fixed\\telemetry-pipe-client.exe', discoveryDirectory: v0Directory}))
    .toEqual(expected === undefined ? undefined : {executable: 'C:\\fixed\\telemetry-pipe-client.exe', discoveryDirectory: expected});
  expect(v1BrokerConfiguration(undefined)).toBeUndefined();
});
it('connects V1Ingestion live-only through the v1 broker: a durableEvents false hello, tagged clock probes, credits and never an ACK', () => {
  const states: string[] = [];
  const service = new V1({now: () => 0, nowNs: () => 1_000_000_000n, connectGame: (configuration, game) => new Client(configuration, game, undefined, 'v1'), broker: v1Configuration,
    onState: state => states.push(state.status)});
  v1Ingestions.push(service); service.select('ets2');
  expect(spawn).toHaveBeenCalledExactlyOnceWith(v1Configuration.executable, ['--game', 'ets2', '--discovery-dir', v1Configuration.discoveryDirectory, '--protocol', 'v1'], {windowsHide: true, stdio: 'pipe'});
  const child = children[0]; child.output(relay(v1Authority()));
  expect(child.writes).toHaveLength(2); expect(child.writes[1]).toEqual(Buffer.from([1]));
  // ET-050b B1, ET-052: the hello offers minor 2; this broker relays a minor-0 plugin, so the probe below is {1,0}.
  expect(decodePayload(child.writes[0].subarray(4), 'client')).toEqual({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: service.clientInstanceId, minMinor: 0, maxMinor: 2, durableEvents: false}});
  child.output(asGame('welcome-live')); child.output(asGame('checkpoint-live')); child.output(asGame('snapshot-live'));
  // The welcome's credit; the checkpoint's probe goes out tagged before that frame's credit; the snapshot's credit.
  expect(child.writes.slice(1).map(bytes => bytes[0])).toEqual([1, 1, 2, 1, 1]);
  const probe = child.writes[3];
  expect(probe.readUInt32LE(1)).toBe(probe.length - 5);
  expect(decodePayload(probe.subarray(5), 'client')).toEqual({version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: '1'}});
  expect(service.current).toMatchObject({status: 'connected', fresh: true, durable: {state: 'off'}});
  // Every observation publishes; the status only ever went from waiting to connected.
  expect([...new Set(states)]).toEqual(['waiting', 'connected']);
});
it('relays a minor-1 plugin through the v1 broker: the tagged clock probe carries {1,1} and the observation its gearbox (ET-050b)', () => {
  const minor1 = (name: string) => decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/minor1/${name}.json`)), 'server', {maxMinor: 1}) as ServerMessage;
  const welcome = minor1('welcome'), checkpoint = minor1('checkpoint'), source = {...welcome.source, origin: 'game' as const};
  if (welcome.kind !== 'welcome' || checkpoint.kind !== 'checkpoint') throw new Error('fixture');
  const service = new V1({now: () => 0, nowNs: () => 1_000_000_000n, connectGame: (configuration, game) => new Client(configuration, game, undefined, 'v1'), broker: v1Configuration});
  v1Ingestions.push(service); service.select('ets2');
  const child = children[0]; child.output(relay({...v1Authority(), source}));
  // The fixtures grant durable delivery, which a live-only hello never accepts: the plugin answers this one live-only.
  welcome.data.durableEvents = false; checkpoint.data.status.delivery.durable = false;
  for (const message of [welcome, checkpoint]) child.output(Buffer.from(encodeV1Frame({...message, source}, {maxMinor: 1})));
  const probe = child.writes.find(bytes => bytes[0] === 2)!;
  expect(decodePayload(probe.subarray(5), 'client', {maxMinor: 1})).toEqual({version: {major: 1, minor: 1}, kind: 'clock.probe', data: {probeId: '1'}});
  expect(service.current).toMatchObject({status: 'connected', fresh: true});
  expect(service.current.observation?.state.gearbox).toEqual(checkpoint.data.state.gearbox);
});

it('relays a minor-2 plugin through the v1 broker: the tagged clock probe carries {1,2} and the observation its next mandatory break (ET-052)', () => {
  const minor2 = (name: string) => decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/minor2/${name}.json`)), 'server', {maxMinor: 2}) as ServerMessage;
  const welcome = minor2('welcome'), checkpoint = minor2('checkpoint'), source = {...welcome.source, origin: 'game' as const};
  if (welcome.kind !== 'welcome' || checkpoint.kind !== 'checkpoint') throw new Error('fixture');
  const service = new V1({now: () => 0, nowNs: () => 1_000_000_000n, connectGame: (configuration, game) => new Client(configuration, game, undefined, 'v1'), broker: v1Configuration});
  v1Ingestions.push(service); service.select('ets2');
  const child = children[0]; child.output(relay({...v1Authority(), source}));
  // The offer is minor 2; a live-only hello is answered live-only.
  expect(decodePayload(child.writes[0].subarray(4), 'client')).toMatchObject({kind: 'hello', data: {maxMinor: 2, durableEvents: false}});
  welcome.data.durableEvents = false; checkpoint.data.status.delivery.durable = false;
  for (const message of [welcome, checkpoint]) child.output(Buffer.from(encodeV1Frame({...message, source}, {maxMinor: 2})));
  const probe = child.writes.find(bytes => bytes[0] === 2)!;
  expect(decodePayload(probe.subarray(5), 'client', {maxMinor: 2})).toEqual({version: {major: 1, minor: 2}, kind: 'clock.probe', data: {probeId: '1'}});
  expect(service.current).toMatchObject({status: 'connected', fresh: true});
  expect(service.current.observation?.state.nextMandatoryBreak).toEqual({available: true, value: 95, unit: 'min'});
  expect(service.current.observation?.state.gearbox).toEqual(checkpoint.data.state.gearbox);
});

it('identifies crash exit codes correctly', async () => {
  const {isCrashExitCode} = await import('../../apps/desktop/src/native-pipe-client');
  expect(isCrashExitCode(null)).toBe(true);
  expect(isCrashExitCode(-1073741819)).toBe(true); // 0xC0000005 as signed int32
  expect(isCrashExitCode(0xC0000005)).toBe(true); // unsigned int32
  expect(isCrashExitCode(-1)).toBe(true);
  expect(isCrashExitCode(5)).toBe(true);
  expect(isCrashExitCode(0)).toBe(false);
  expect(isCrashExitCode(1)).toBe(false);
  expect(isCrashExitCode(2)).toBe(false);
  expect(isCrashExitCode(3)).toBe(false);
  expect(isCrashExitCode(4)).toBe(false);
});

it('classifies mid-session exit 1 with stage unreported as retryable transient rejection', () => {
  const diagnose = vi.fn(), f = fixture(diagnose);
  f.child.output(relay(authority()));
  f.child.emit('close', 1);
  expect(failure(f.error)).toMatchObject({transient: true, outcome: 'rejected', message: 'Native broker exited unexpectedly'});
  expect(diagnose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outcome: 'rejected', exitCode: 1, stage: 'unreported'}));
});

it('classifies mid-session cut frame with stage unreported as retryable transient incomplete-frame', () => {
  const diagnose = vi.fn(), f = fixture(diagnose);
  f.child.output(relay(authority()));
  f.child.output(Buffer.from([1, 2]));
  f.child.emit('close', 1);
  expect(failure(f.error)).toMatchObject({transient: true, outcome: 'incomplete-frame', message: 'Incomplete native relay frame'});
  expect(diagnose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outcome: 'incomplete-frame', exitCode: 1, stage: 'unreported'}));
});

it.each([-1073741819, 0xC0000005, null, 5])('classifies mid-session abnormal exit code %s as transient retryable', code => {
  const f = fixture();
  f.child.output(relay(authority()));
  f.child.emit('close', code);
  expect(failure(f.error)).toMatchObject({transient: true, outcome: 'rejected'});
});

it('keeps diagnosed exit 1 after authority receipt final and non-transient', () => {
  const diagnose = vi.fn(), f = fixture(diagnose);
  f.child.output(relay(authority()));
  f.child.stderr.write('diag1 retained-authority 5 40 relay 30\n');
  f.child.emit('close', 1);
  expect(failure(f.error)).toMatchObject({transient: false, outcome: 'rejected', message: 'Native authority or connection rejected'});
  expect(diagnose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({outcome: 'rejected', exitCode: 1, stage: 'retained-authority'}));
});

it.each([
  ['unreported', ''],
  ['diagnosed', 'diag1 discovery 5 40 policy-write 30\n']
])('keeps pre-receipt exit 1 (%s) non-transient', (_kind, stderr) => {
  const f = fixture();
  if (stderr) f.child.stderr.write(stderr);
  f.child.emit('close', 1);
  expect(failure(f.error)).toMatchObject({transient: false, outcome: 'rejected'});
});

it('transitions TelemetryIngestion to disconnected and reconnects on mid-session transient exit, while diagnosed exit remains incompatible', async () => {
  const f = ingestion();
  f.child.output(relay(authority()));
  f.child.output(frames[0]); f.child.output(frames[1]);
  expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'connected', fresh: true});

  // Mid-session unexpected exit 1 (unreported) -> disconnected, retries after 250ms backoff
  f.child.emit('close', 1);
  expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'disconnected', reason: 'Native broker exited unexpectedly; reconnecting', fresh: false});
  await vi.advanceTimersByTimeAsync(249);
  expect(spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(spawn).toHaveBeenCalledTimes(2);

  // Replacement broker connects, then encounters a diagnosed authority failure -> incompatible, no reconnect
  const second = children[1];
  second.output(relay(authority()));
  second.stderr.write('diag1 retained-authority 5 40 relay 30\n');
  second.emit('close', 1);
  expect(f.publish.mock.lastCall?.[0]).toMatchObject({status: 'incompatible', reason: 'Native source authority or transport failed', fresh: false});
  await vi.advanceTimersByTimeAsync(10000);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('transitions V1Ingestion to disconnected and reconnects on mid-session transient exit, while diagnosed exit remains incompatible', async () => {
  const states: string[] = [];
  const service = new V1({now: () => 0, nowNs: () => 1_000_000_000n, connectGame: (configuration, game) => new Client(configuration, game, undefined, 'v1'), broker: v1Configuration,
    onState: state => states.push(state.status)});
  v1Ingestions.push(service); service.select('ets2');
  const first = children[0];
  first.output(relay(v1Authority()));
  // Mid-session killed broker (exit 1 unreported) -> disconnected with reconnect
  first.emit('close', 1);
  expect(service.current).toMatchObject({status: 'disconnected', reason: 'Native broker exited unexpectedly; reconnecting'});
  await vi.advanceTimersByTimeAsync(249);
  expect(spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(spawn).toHaveBeenCalledTimes(2);

  // Replacement broker encounters diagnosed exit 1 -> incompatible
  const second = children[1];
  second.output(relay(v1Authority()));
  second.stderr.write('diag1 retained-authority 5 40 relay 30\n');
  second.emit('close', 1);
  expect(service.current).toMatchObject({status: 'incompatible', reason: 'Native source authority or transport failed'});
  await vi.advanceTimersByTimeAsync(10000);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it.each(['v0', 'v1'] as const)('pins every %s target component before connect/hello or a durable request', protocol => {
  const expected = {source: {...source}, processCreationTime: '123456789', userTag: 'a'.repeat(64)};
  for (const field of ['processId', 'windowsSessionId', 'processInstanceId', 'pluginSessionId', 'processCreationTime', 'userTag'] as const) {
    const client = new Client(configuration, 'ets2', undefined, protocol, expected); clients.push(client);
    const child = children.at(-1)!, connect = vi.fn(), error = vi.fn(); client.on('connect', connect).on('error', error);
    const record = {...authority(), ...(protocol === 'v1' ? {protocolMajor: 1} : {})};
    if (field === 'processCreationTime') record.processCreationTime = '123456790';
    else if (field === 'userTag') record.userTag = 'b'.repeat(64);
    else if (field === 'processId') record.source.processId++;
    else if (field === 'windowsSessionId') record.source.windowsSessionId++;
    else record.source[field] = '33333333-3333-4333-8333-333333333333';
    child.output(relay(record));
    expect(connect, field).not.toHaveBeenCalled(); expect(error, field).toHaveBeenCalledOnce(); expect(child.writes, field).toEqual([]);
  }
  const client = new Client(configuration, 'ets2', undefined, protocol, expected); clients.push(client);
  const child = children.at(-1)!, connect = vi.fn(); client.on('connect', connect).on('error', () => undefined);
  child.output(relay({...authority(), ...(protocol === 'v1' ? {protocolMajor: 1} : {})}));
  expect(connect).toHaveBeenCalledOnce(); expect(client.target).toEqual(expected);
});
