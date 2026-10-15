// Deliberately invalid protocol v1 bytes for the simulator's fault steps (ET-005b). Valid messages are always built by
// the unchanged ET-002b encoder; these helpers exist only to break a stream on purpose. Client faults model a misbehaving
// consumer and must close the connection without an error frame (docs/protocol/v1.md §2-§4, §10, §11, OD-5 S6). Wire
// faults model a broken producer: they are written outside the producer and the encoder, and the client's FrameDecoder
// or V1Consumer must reject them. Every function here is pure and deterministic.
import {PROTOCOL_V1, V1_LIMITS, encodeFrame, type ClientMessage, type EndData, type ServerMessage} from '../../../../packages/contracts/src/protocol-v1';
import {PROTOCOL_V0, encodeFrame as encodeV0Frame} from '../../../../packages/contracts/src/protocol-v0';
import {encodeCap0Hello} from '../../../../packages/contracts/src/capture-cap0';

/** Faults of a connection attempt before its hello completes. The producer never opens a v1 connection for them. */
export const HELLO_FAULTS = ['helloOversized', 'helloMalformed', 'helloV0', 'helloCap0', 'helloOtherMajor', 'helloOtherMinor', 'helloUnknownKind', 'ackBeforeHello',
  'helloExtraBytes', 'ackBeforeCheckpoint', 'helloPartialEof', 'helloTimeout'] as const;
/** Faults of a client after its checkpoint. All close the connection except `ackDuplicate` (a no-op) and `stallRead`. */
export const LIVE_FAULTS = ['secondHello', 'ackLiveOnly', 'ackForeignSession', 'ackBeyondSent', 'ackRegressing', 'ackDuplicate', 'probeRepeat', 'probeWhileReplyUnsent',
  'unknownKind', 'oversizedFrame', 'malformedFrame', 'partialFrameEof', 'stallRead'] as const;
/** Server-to-client faults. All are rejected by the client except the legal control `seqSkip`. */
export const WIRE_FAULTS = ['duplicateEventSeq', 'skippedEventSeq', 'seqRegression', 'captureRegression', 'foreignSource', 'malformedJson', 'oversizedPrefix', 'partialEof',
  'v0Frame', 'frameAfterEnd', 'seqSkip'] as const;
export type HelloFault = typeof HELLO_FAULTS[number];
export type LiveFault = typeof LIVE_FAULTS[number];
export type ClientFault = HelloFault | LiveFault;
export type WireFault = typeof WIRE_FAULTS[number];
export const isHelloFault = (f: string): f is HelloFault => (HELLO_FAULTS as readonly string[]).includes(f);
/** Live client faults after which the connection continues. */
export const KEEPS_CONNECTION: readonly LiveFault[] = ['ackDuplicate', 'stallRead'];
/** ACK faults of a durable client; `ackLiveOnly` is the only ACK fault of a live-only client. */
export const DURABLE_ONLY: readonly LiveFault[] = ['ackForeignSession', 'ackBeyondSent', 'ackRegressing', 'ackDuplicate'];

/** The bytes a fault injects. `endsInput` means the client then ends its side of the pipe. */
export interface FaultBytes {bytes: Uint8Array; endsInput: boolean}
const text = new TextEncoder();
/** A length-prefixed frame around any payload, without validation. */
export function rawFrame(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string' ? text.encode(payload) : payload, frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, true); frame.set(bytes, 4); return frame;
}
/** A lone length prefix announcing `length` payload bytes. */
export function prefixOnly(length: number): Uint8Array { const p = new Uint8Array(4); new DataView(p.buffer).setUint32(0, length, true); return p; }
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const half = (frame: Uint8Array) => frame.slice(0, Math.max(1, Math.floor(frame.length / 2)));

function hello(clientInstanceId: string, durableEvents: boolean): ClientMessage {
  return {version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents}};
}
const ack = (pluginSessionId: string, through: bigint): ClientMessage => ({version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId, throughEventSeq: through.toString()}});
const probe = (id: bigint): ClientMessage => ({version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: id.toString()}});

/** What a hello-phase fault knows: the client instance and the plugin session it expects from earlier connections. */
export interface HelloFaultContext {clientInstanceId: string; pluginSessionId: string}
/** Bytes of a hello-phase fault; `helloTimeout` sends nothing. */
export function helloFaultBytes(fault: HelloFault, c: HelloFaultContext): FaultBytes {
  const valid = encodeFrame(hello(c.clientInstanceId, true)), body = {clientInstanceId: c.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: true};
  const done = (bytes: Uint8Array, endsInput = false): FaultBytes => ({bytes, endsInput});
  switch (fault) {
    // The 4,096-byte client bound is enforced at the prefix, before any payload is retained.
    case 'helloOversized': return done(prefixOnly(V1_LIMITS.clientFrameBytes + 1));
    case 'helloMalformed': return done(rawFrame('{"version":'));
    case 'helloV0': return done(encodeV0Frame({version: PROTOCOL_V0, kind: 'hello', data: {clientInstanceId: c.clientInstanceId, minMinor: 0, maxMinor: 0, diagnostics: false}}));
    case 'helloCap0': return done(encodeCap0Hello(c.clientInstanceId));
    case 'helloOtherMajor': return done(rawFrame(JSON.stringify({version: {major: 2, minor: 0}, kind: 'hello', data: body})));
    case 'helloOtherMinor': return done(rawFrame(JSON.stringify({version: {major: 1, minor: 1}, kind: 'hello', data: body})));
    case 'helloUnknownKind': return done(rawFrame(JSON.stringify({version: PROTOCOL_V1, kind: 'subscribe', data: {}})));
    case 'ackBeforeHello': return done(encodeFrame(ack(c.pluginSessionId, 0n)));
    // OD-5 S6: a byte beyond the hello in the same read, or any client message before the checkpoint.
    case 'helloExtraBytes': return done(concat(valid, Uint8Array.of(0)));
    case 'ackBeforeCheckpoint': return done(concat(valid, encodeFrame(ack(c.pluginSessionId, 0n))));
    case 'helloPartialEof': return done(half(valid), true);
    case 'helloTimeout': return done(new Uint8Array(0));
  }
}

/**
 * What a live client fault knows about its connection: the plugin session, the durable grant, the producer's accepted
 * ACK point A' (the checkpoint's value or the last ACK that reached the producer), the next eventSeq the connection must
 * cover and the last probe ID sent.
 */
export interface LiveFaultContext {clientInstanceId: string; pluginSessionId: string; durable: boolean; acceptedAck: bigint; nextEventSeq: bigint; lastProbeId: bigint; foreignSessionId: string}
/** Bytes of a live client fault; `stallRead` sends nothing. Preconditions a fault cannot meet are scenario errors. */
export function liveFaultBytes(fault: LiveFault, c: LiveFaultContext): FaultBytes {
  const need = (ok: boolean, reason: string) => { if (!ok) throw new Error(`Client fault ${fault} needs ${reason}`); };
  if (DURABLE_ONLY.includes(fault)) need(c.durable, 'a durable connection');
  if (fault === 'ackLiveOnly') need(!c.durable, 'a live-only connection');
  const done = (bytes: Uint8Array, endsInput = false): FaultBytes => ({bytes, endsInput});
  switch (fault) {
    case 'secondHello': return done(encodeFrame(hello(c.clientInstanceId, c.durable)));
    // A live-only client never acknowledges, not even its checkpoint's own value.
    case 'ackLiveOnly': return done(encodeFrame(ack(c.pluginSessionId, c.acceptedAck)));
    case 'ackForeignSession': return done(encodeFrame(ack(c.foreignSessionId, c.acceptedAck)));
    // The next eventSeq to cover is one beyond the highest eventSeq sent on this connection.
    case 'ackBeyondSent': return done(encodeFrame(ack(c.pluginSessionId, c.nextEventSeq)));
    case 'ackRegressing': need(c.acceptedAck >= 1n, 'an accepted ACK point of at least 1'); return done(encodeFrame(ack(c.pluginSessionId, c.acceptedAck - 1n)));
    case 'ackDuplicate': return done(encodeFrame(ack(c.pluginSessionId, c.acceptedAck)));
    case 'probeRepeat': need(c.lastProbeId >= 1n, 'an earlier probe on the connection'); return done(encodeFrame(probe(c.lastProbeId)));
    // Two probes in one write: the second arrives while the reply to the first is still unsent (OD-5 S6).
    case 'probeWhileReplyUnsent': return done(concat(encodeFrame(probe(c.lastProbeId + 1n)), encodeFrame(probe(c.lastProbeId + 2n))));
    case 'unknownKind': return done(rawFrame(JSON.stringify({version: PROTOCOL_V1, kind: 'subscribe', data: {}})));
    case 'oversizedFrame': return done(prefixOnly(V1_LIMITS.clientFrameBytes + 1));
    case 'malformedFrame': return done(rawFrame('{"kind":'));
    case 'partialFrameEof': return done(half(encodeFrame(ack(c.pluginSessionId, c.acceptedAck))), true);
    case 'stallRead': return done(new Uint8Array(0));
  }
}

/**
 * What a wire fault knows about its connection: the last message written, the last state message and event on it,
 * the next eventSeq the client expects, the store's current end cursor and a foreign plugin session.
 */
export interface WireFaultContext {last: ServerMessage; lastState: ServerMessage; lastEvent?: ServerMessage; nextEventSeq: bigint; end: EndData; foreignSessionId: string}
/** Bytes of a wire fault; `seqSkip` writes nothing (the producer skips one message seq). `endsOutput`: the server then closes. */
export function wireFaultBytes(fault: WireFault, c: WireFaultContext): {bytes: Uint8Array; endsOutput: boolean} {
  const next = (BigInt(c.last.seq) + 1n).toString(), capture = c.last.capture;
  const frame = (m: unknown) => rawFrame(JSON.stringify(m));
  // A snapshot carrying the last state; a checkpoint's boundarySeq is dropped.
  const snapshot = (seq: string, cap = capture, source = c.last.source) => {
    if (c.lastState.kind !== 'checkpoint' && c.lastState.kind !== 'snapshot') throw new Error('Wire fault needs a state message on the connection');
    const {state, status, continuity} = c.lastState.data;
    return {version: PROTOCOL_V1, kind: 'snapshot', source, seq, capture: cap, data: {state, status, continuity}};
  };
  const event = (eventSeq: string) => {
    if (c.lastEvent?.kind !== 'event') throw new Error(`Wire fault ${fault} needs an event on the connection`);
    return {...c.lastEvent, seq: next, capture, data: {...c.lastEvent.data, eventSeq, redelivered: false}};
  };
  const done = (bytes: Uint8Array, endsOutput = false) => ({bytes, endsOutput});
  switch (fault) {
    case 'duplicateEventSeq': return done(frame(event(c.lastEvent?.kind === 'event' ? c.lastEvent.data.eventSeq : '0')));
    case 'skippedEventSeq': return done(frame(event((c.nextEventSeq + 1n).toString())));
    case 'seqRegression': return done(frame(snapshot(c.last.seq)));
    case 'captureRegression': return done(frame(snapshot(next, {clockId: capture.clockId, monotonicNs: (BigInt(capture.monotonicNs) - 1n).toString()})));
    case 'foreignSource': return done(frame(snapshot(next, capture, {...c.last.source, pluginSessionId: c.foreignSessionId})));
    case 'malformedJson': return done(rawFrame('{"kind":'));
    case 'oversizedPrefix': return done(prefixOnly(V1_LIMITS.serverFrameBytes + 1));
    case 'partialEof': return done(half(frame(snapshot(next))), true);
    case 'v0Frame': return done(encodeV0Frame({version: PROTOCOL_V0, kind: 'welcome', source: c.last.source, seq: next, capture, data: {diagnostics: false, durableRecording: false}}));
    case 'frameAfterEnd': return done(concat(frame({version: PROTOCOL_V1, kind: 'end', source: c.last.source, seq: next, capture, data: c.end}), frame(snapshot((BigInt(next) + 1n).toString()))));
    case 'seqSkip': return done(new Uint8Array(0));
  }
}

/** Lowercase hex of injected bytes, as written to the transcript. */
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
