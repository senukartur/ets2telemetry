import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {PROTOCOL_V1, V1_LIMITS, encodeFrame, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {HELLO_FAULTS, LIVE_FAULTS, WIRE_FAULTS, helloFaultBytes, rawFrame, wireFaultBytes, type HelloFault, type LiveFault, type WireFault} from '../../tools/telemetry-simulator/src/v1/faults';
import {V1Producer} from '../../tools/telemetry-simulator/src/v1/producer';
import {replayV1, scenarioSource, type ReplayResult} from '../../tools/telemetry-simulator/src/v1/replay';
import {validateScenario} from '../../tools/telemetry-simulator/src/v1/scenario';
import {AdapterModel, ScenarioClock, seededId} from '../../tools/telemetry-simulator/src/v1/source';

type Json = Record<string, unknown>;
const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
const started = (atMs: number) => ({atMs, action: 'lifecycle', event: 'simulation.started'});
const paused = (atMs: number) => ({atMs, action: 'lifecycle', event: 'simulation.paused'});
function scenario(transport: Json[], extra: Json = {}): Json {
  return {format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id: 'fault-test', purpose: 'Fault test', reg: ['REG-010'], origin: 'synthetic', game: 'ets2', seed: 'fault-test',
    provenance: null, source: SOURCE, steps: [started(10), paused(20), started(150)], transport, ...extra};
}
const serverLines = (r: ReplayResult, connection: number) => r.transcript.filter(l => l.connection === connection && l.direction === 'server').map(l => JSON.stringify(l.message));
const durable = (atMs: number, probes: number[] = []) => ({atMs, action: 'connect', client: {durable: true, probes}});
/** The same session with a plain disconnect where a fault closes the first connection. */
const baseline = (closeAt: number, probes: number[] = []) => replayV1(scenario([durable(0, probes), {atMs: closeAt, action: 'disconnect'}, durable(100), {atMs: 200, action: 'disconnect'}]));

describe('simulator v1 fault bytes', () => {
  const ctx = {clientInstanceId: seededId('fault-test', 'client-instance-1'), pluginSessionId: seededId('fault-test', 'plugin-session')};
  it('enforces the client bound at the prefix and keeps every fault deterministic', () => {
    const oversized = helloFaultBytes('helloOversized', ctx).bytes;
    expect(oversized).toHaveLength(4);
    expect(new DataView(oversized.buffer).getUint32(0, true)).toBe(V1_LIMITS.clientFrameBytes + 1);
    for (const fault of HELLO_FAULTS) expect(helloFaultBytes(fault, ctx)).toEqual(helloFaultBytes(fault, ctx));
    const hello = encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: ctx.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: true}});
    expect(Buffer.from(helloFaultBytes('helloExtraBytes', ctx).bytes).equals(Buffer.concat([hello, Buffer.of(0)]))).toBe(true);
    expect(helloFaultBytes('helloPartialEof', ctx)).toMatchObject({endsInput: true});
    expect(helloFaultBytes('helloTimeout', ctx).bytes).toHaveLength(0);
  });

  it('builds wire faults outside the encoder from the connection state', () => {
    const r = replayV1(scenario([durable(0), {atMs: 100, action: 'disconnect'}]));
    const messages = r.transcript.filter(l => l.direction === 'server').map(l => l.message as ServerMessage), last = messages.at(-1)!, lastState = messages.find(m => m.kind === 'checkpoint')!;
    const c = {last, lastState, lastEvent: last, nextEventSeq: 4n, end: {reason: 'plugin-shutdown' as const, nextEventSeq: '4', ackedThroughEventSeq: '3', retainedUnacked: '0'}, foreignSessionId: seededId('fault-test', 'foreign')};
    const oversized = wireFaultBytes('oversizedPrefix', c).bytes;
    expect(new DataView(oversized.buffer).getUint32(0, true)).toBe(V1_LIMITS.serverFrameBytes + 1);
    const regression = JSON.parse(Buffer.from(wireFaultBytes('seqRegression', c).bytes.subarray(4)).toString('utf8')) as ServerMessage;
    expect([regression.kind, regression.seq]).toEqual(['snapshot', last.seq]);
    expect(wireFaultBytes('partialEof', c).endsOutput).toBe(true);
    expect(wireFaultBytes('seqSkip', c).bytes).toHaveLength(0);
    expect(rawFrame('{}')).toEqual(Uint8Array.of(2, 0, 0, 0, 0x7b, 0x7d));
  });
});

describe('simulator v1 producer hello reading (mirrors the native endpoint)', () => {
  const producer = () => {
    const clock = new ScenarioClock(), s = validateScenario(scenario([durable(0)]));
    const adapter = new AdapterModel({game: 'ets2', seed: 'fault-test', ...s.source}, clock), p = new V1Producer(adapter, scenarioSource(s), seededId('fault-test', 'capture-clock'));
    p.open(); return p;
  };
  const exact = readFileSync('tests/fixtures/protocol-v1/hello-exact.json');
  it('accepts an exactly 4,096-byte hello and a hello split across reads', () => {
    expect(producer().receive(rawFrame(exact), 0n).map(o => o.message.kind)).toEqual(['welcome', 'checkpoint']);
    const p = producer(), frame = rawFrame(exact);
    expect(p.receive(frame.subarray(0, 2), 0n)).toEqual([]);
    expect(p.receive(frame.subarray(2, 100), 0n)).toEqual([]);
    expect(p.receive(frame.subarray(100), 0n).map(o => o.message.kind)).toEqual(['welcome', 'checkpoint']);
  });
  it('rejects a 4,097-byte prefix, a zero prefix and a byte beyond the hello in the same read', () => {
    expect(() => producer().receive(rawFrame(readFileSync('tests/fixtures/protocol-v1/hello-oversized.json')).subarray(0, 4), 0n)).toThrow(/size/);
    expect(() => producer().receive(Uint8Array.of(0, 0, 0, 0), 0n)).toThrow(/size/);
    expect(() => producer().receive(Buffer.concat([rawFrame(exact), Buffer.of(1)]), 0n)).toThrow(/beyond the hello/);
  });
});

describe('simulator v1 client faults', () => {

  it.each(HELLO_FAULTS.map(f => [f]))('%s is closed before any server byte and leaves the producer untouched', (fault: HelloFault) => {
    const r = replayV1(scenario([{atMs: 5, action: 'clientFault', fault}, durable(100), {atMs: 200, action: 'disconnect'}]));
    const plain = replayV1(scenario([durable(100), {atMs: 200, action: 'disconnect'}]));
    expect(serverLines(r, 1)).toEqual([]);
    expect(r.connections[0]).toMatchObject({helloFault: fault, closedBy: fault === 'helloPartialEof' ? 'clientEof' : fault === 'helloTimeout' ? 'helloTimeout' : 'serverRejected'});
    // Same message seq, store, gate and offline coverage as without the attempt.
    expect(serverLines(r, 2)).toEqual(serverLines(plain, 1));
  });

  const closing = LIVE_FAULTS.filter(f => !['ackDuplicate', 'stallRead', 'ackLiveOnly'].includes(f));
  it.each(closing.map(f => [f]))('%s ends only its connection, without an error frame, and changes no state', (fault: LiveFault) => {
    const r = replayV1(scenario([durable(0, [30]), {atMs: 50, action: 'clientFault', fault}, durable(100), {atMs: 200, action: 'disconnect'}])), plain = baseline(50, [30]);
    expect(r.connections[0].closedBy).toBe(fault === 'partialFrameEof' ? 'clientEof' : 'serverRejected');
    // Nothing is written after the fault: the faulty read consumes no message seq, not even for a probe reply.
    expect(serverLines(r, 1)).toEqual(serverLines(plain, 1));
    expect(serverLines(r, 2)).toEqual(serverLines(plain, 2));
    expect(r.store).toEqual(plain.store);
  });

  it('closes a live-only client that acknowledges, and treats an equal ACK as a no-op', () => {
    const live = replayV1(scenario([{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 50, action: 'clientFault', fault: 'ackLiveOnly'}, durable(100), {atMs: 200, action: 'disconnect'}]));
    const livePlain = replayV1(scenario([{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 50, action: 'disconnect'}, durable(100), {atMs: 200, action: 'disconnect'}]));
    expect(live.connections[0].closedBy).toBe('serverRejected');
    expect(serverLines(live, 2)).toEqual(serverLines(livePlain, 2));
    const equal = replayV1(scenario([durable(0), {atMs: 50, action: 'clientFault', fault: 'ackDuplicate'}, {atMs: 200, action: 'disconnect'}]));
    const plain = replayV1(scenario([durable(0), {atMs: 200, action: 'disconnect'}]));
    expect(equal.connections[0].closedBy).toBe('disconnect');
    expect(serverLines(equal, 1)).toEqual(serverLines(plain, 1));
    expect(equal.transcript.filter(l => l.message.kind === 'ack').map(l => l.message.kind === 'ack' && l.message.data.throughEventSeq)).toEqual(['1', '2', '3']);
  });
});

describe('simulator v1 wire faults', () => {
  const rejections: [WireFault, RegExp][] = [
    ['duplicateEventSeq', /eventSeq coverage/], ['skippedEventSeq', /eventSeq coverage/], ['seqRegression', /order violation/], ['captureRegression', /order violation/],
    ['foreignSource', /order violation/], ['malformedJson', /Malformed/], ['oversizedPrefix', /size rejected/], ['partialEof', /Truncated/], ['v0Frame', /Unsupported protocol version/],
    ['frameAfterEnd', /Consumer is closed/]
  ];
  it('covers every rejected wire fault', () => expect(rejections.map(r => r[0]).sort()).toEqual(WIRE_FAULTS.filter(f => f !== 'seqSkip').sort()));
  it.each(rejections)('%s is rejected by the client at the injected bytes; the producer continues the session', (fault, reason) => {
    const r = replayV1(scenario([durable(0), {atMs: 50, action: 'wireFault', fault}, durable(100), {atMs: 200, action: 'disconnect'}], {faultInjection: true})), plain = baseline(50);
    expect(r.connections[0]).toMatchObject({closedBy: 'clientRejected'});
    expect(r.connections[0].rejection).toMatch(reason);
    expect(r.faults.map(f => [f.connection, f.direction, f.fault])).toEqual([[1, 'server', fault]]);
    expect(serverLines(r, 2)).toEqual(serverLines(plain, 2));
  });
  it('accepts a skipped message seq as the legal control', () => {
    const r = replayV1(scenario([durable(0), {atMs: 15, action: 'wireFault', fault: 'seqSkip'}, {atMs: 200, action: 'disconnect'}], {faultInjection: true}));
    const consumer = new V1Consumer(true, {maxMinor: 1}), skipped = r.transcript.filter(l => l.direction === 'server').map(l => consumer.accept(l.message).skippedSequences);
    expect(skipped).toEqual(['0', '0', '0', '1', '0']);
    expect(r.connections[0].closedBy).toBe('disconnect');
  });
});

describe('simulator v1 fault steps in the scenario schema', () => {
  const invalid = (transport: Json[], extra: Json = {}) => () => validateScenario(scenario(transport, extra));
  it('requires explicit fault injection for wire faults and only then', () => {
    expect(invalid([durable(0), {atMs: 50, action: 'wireFault', fault: 'malformedJson'}])).toThrow(/faultInjection/);
    expect(invalid([durable(0)], {faultInjection: true})).toThrow(/only a scenario with wire faults/);
    expect(invalid([durable(0), {atMs: 50, action: 'wireFault', fault: 'nonsense'}], {faultInjection: true})).toThrow(/one of/);
  });
  it('places each fault on a possible connection', () => {
    expect(invalid([{atMs: 50, action: 'clientFault', fault: 'ackDuplicate'}])).toThrow(/clientFault without a connection/);
    expect(invalid([durable(0), {atMs: 50, action: 'clientFault', fault: 'helloMalformed'}])).toThrow(/one client at a time/);
    expect(invalid([durable(0), {atMs: 50, action: 'clientFault', fault: 'ackLiveOnly'}])).toThrow(/live-only/);
    expect(invalid([{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 50, action: 'clientFault', fault: 'ackDuplicate'}])).toThrow(/durable connection/);
    expect(invalid([durable(0), {atMs: 50, action: 'clientFault', fault: 'secondHello'}, {atMs: 60, action: 'disconnect'}])).toThrow(/disconnect without a connection/);
    expect(invalid([durable(0, [1000]), {atMs: 50, action: 'clientFault', fault: 'secondHello'}])).toThrow(/probe needs its connection/);
    expect(invalid([{atMs: 50, action: 'secondClient'}])).toThrow(/without a connection/);
  });
  it('ends a stalled client only at its write deadline, followed by another connection', () => {
    const stall = [durable(0), {atMs: 50, action: 'clientFault', fault: 'stallRead'}];
    expect(invalid([...stall, {atMs: 60, action: 'disconnect'}])).toThrow(/write deadline/);
    expect(invalid([...stall, {atMs: 60, action: 'writeDeadline'}])).toThrow(/another connection follows/);
    expect(invalid([...stall, {atMs: 55, action: 'secondClient'}, {atMs: 60, action: 'writeDeadline'}, durable(100)])).toThrow(/reading connection/);
    expect(invalid([durable(0), {atMs: 60, action: 'writeDeadline'}])).toThrow(/stalled client/);
    expect(validateScenario(scenario([...stall, {atMs: 60, action: 'writeDeadline'}, durable(100)])).transport).toHaveLength(4);
  });
});
