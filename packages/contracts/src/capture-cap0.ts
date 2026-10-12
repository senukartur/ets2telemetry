// CAP0 evidence capture contract. It is separately versioned from protocol v0: the v0 parser never
// accepts these packets, and nothing here feeds live state, trips, history or acknowledgements.
import {isUint64, strictJson, type Uint64} from './protocol-v0';

export const CAP0_FORMAT = 'ets2telemetry-cap0';
export const CAP0_VERSION = {major: 0, minor: 0} as const;
export const CAP0_MAX_PACKET_BYTES = 65_536;
export const CAP0_MAX_HELLO_BYTES = 4_096;
/** Native producer bounds announced by every CAP0 0.0 header. */
export const CAP0_BOUNDS = {queueEnvelopes: 128, queueBytes: 2_097_152, packetBytes: 65_536, attributeScan: 256, identifierBytes: 128, stringBytes: 1_024} as const;
export const CAP0_DETAILS = ['none', 'null-value', 'too-long', 'invalid-utf8', 'non-finite', 'unsupported-type', 'null-name', 'null-attributes'] as const;
export const CAP0_SDK_TYPES = {bool: 1, s32: 2, u32: 3, u64: 4, float: 5, double: 6, fvector: 7, dvector: 8, euler: 9, fplacement: 10, dplacement: 11, string: 12, s64: 13} as const;

export type Cap0Detail = (typeof CAP0_DETAILS)[number];
export type Cap0Available<T> = {available: true; value: T} | {available: false; reason: 'not-observed' | 'not-supported' | 'invalid'; detail: Cap0Detail};
export type Cap0SdkType = keyof typeof CAP0_SDK_TYPES | 'unknown';
export interface Cap0Vector {x: number; y: number; z: number}
export interface Cap0Euler {heading: number; pitch: number; roll: number}
export type Cap0Value = boolean | number | string | Cap0Vector | Cap0Euler | {position: Cap0Vector; orientation: Cap0Euler};
export interface Cap0Observation {position: number; name: Cap0Available<string>; arrayIndex: Cap0Available<number>; sdkType: Cap0SdkType; sdkTypeId: number; value: Cap0Available<Cap0Value>}
export interface Cap0Source {game: 'ets2' | 'ats'; sdkGameId: string; processId: number; windowsSessionId: number; processInstanceId: string; pluginSessionId: string}
export interface Cap0HeaderData {
  origin: 'game' | 'synthetic'; source: Cap0Source;
  versions: {telemetryApi: {major: number; minor: number}; gameTelemetry: {major: number; minor: number}; sdkArchive: string; pluginImage: Cap0Available<{path: string; sha256: string}>};
  clocks: {sourceMonotonicClockId: string; gameClockIdAtOpen: string; openMonotonicNs: Uint64};
  currency: Cap0Available<{code: string; source: string}>; publishedBoundaryOrderAtOpen: Uint64; bounds: typeof CAP0_BOUNDS;
}
export interface Cap0EnvelopeData {
  envelopeSeq: Uint64; droppedBefore: Uint64; callback: {group: 'configuration' | 'gameplay' | 'lifecycle'; id: Cap0Available<string>};
  sharedBoundaryOrder: Uint64; configurationRevision: Uint64; callbackMonotonicNs: Cap0Available<Uint64>;
  sdkFrame: Cap0Available<{renderTimeUs: Uint64; simulationTimeUs: Uint64; pausedSimulationTimeUs: Uint64}>;
  gameTime: {minutes: Cap0Available<Uint64>; clockId: string}; simulation: 'running' | 'paused' | 'unavailable';
  attributes: {expected: boolean; present: boolean; terminated: boolean; total: number; first: number; count: number; final: boolean; omittedLowerBound: number};
  observations: Cap0Observation[];
}
export interface Cap0LossData {attemptedEnvelopes: Uint64; droppedEnvelopes: Uint64; droppedBytes: Uint64; droppedQueueFull: Uint64; droppedBytesFull: Uint64; lastDroppedEnvelopeSeq: Cap0Available<Uint64>; lastDropMonotonicNs: Cap0Available<Uint64>}
export interface Cap0EndData {reason: 'plugin-shutdown' | 'source-retired' | 'encoding-failed'; attemptedEnvelopes: Uint64; enqueuedEnvelopes: Uint64; publishedEnvelopes: Uint64; droppedEnvelopes: Uint64; droppedBytes: Uint64; unsentEnvelopes: Uint64}
interface Cap0Base {format: typeof CAP0_FORMAT; version: typeof CAP0_VERSION; captureSessionId: string; packetSeq: Uint64; publishMonotonicNs: Uint64}
export type Cap0Packet = Cap0Base & ({kind: 'header'; data: Cap0HeaderData} | {kind: 'envelope'; data: Cap0EnvelopeData} | {kind: 'loss'; data: Cap0LossData} | {kind: 'end'; data: Cap0EndData});
export interface Cap0Hello {format: typeof CAP0_FORMAT; version: typeof CAP0_VERSION; kind: 'hello'; captureSessionId: string; data: {evidenceOnly: true}}

export class Cap0Error extends Error {}
function fail(reason = 'Invalid CAP0 packet'): never { throw new Cap0Error(reason); }
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>, own = Object.keys(o);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(o, key))) fail();
  return o;
}
const encoder = new TextEncoder();
function text(v: unknown, maxBytes: number, allowEmpty = true): string {
  if (typeof v !== 'string' || (!allowEmpty && !v.length) || encoder.encode(v).length > maxBytes) fail();
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail();
  return v;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(v: unknown): string { if (typeof v !== 'string' || !UUID.test(v)) fail(); return v; }
function u64(v: unknown): Uint64 { if (!isUint64(v)) fail(); return v; }
function s64(v: unknown): string {
  if (typeof v !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(v) || v === '-0') fail();
  const n = BigInt(v); if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) fail(); return v;
}
function integer(v: unknown, min: number, max: number): number { if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(); return v; }
function finite(v: unknown, limit = Number.MAX_VALUE): number { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) fail(); return v; }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') fail(); return v; }
function choice<T extends string>(v: unknown, options: readonly T[]): T { if (typeof v !== 'string' || !options.includes(v as T)) fail(); return v as T; }
function available(v: unknown, validate: (value: unknown) => void): void {
  if (v === null || typeof v !== 'object') fail();
  if ((v as Record<string, unknown>).available === true) validate(record(v, ['available', 'value']).value);
  else { const o = record(v, ['available', 'reason', 'detail']); if (o.available !== false) fail(); choice(o.reason, ['not-observed', 'not-supported', 'invalid']); choice(o.detail, CAP0_DETAILS); }
}
const FLOAT_MAX = 3.4028234663852886e38;
function vector(v: unknown, limit: number) { const o = record(v, ['x', 'y', 'z']); finite(o.x, limit); finite(o.y, limit); finite(o.z, limit); }
function euler(v: unknown) { const o = record(v, ['heading', 'pitch', 'roll']); finite(o.heading, FLOAT_MAX); finite(o.pitch, FLOAT_MAX); finite(o.roll, FLOAT_MAX); }
function typed(type: Cap0SdkType, v: unknown) {
  switch (type) {
    case 'bool': bool(v); break;
    case 's32': integer(v, -2_147_483_648, 2_147_483_647); break;
    case 'u32': integer(v, 0, 4_294_967_295); break;
    case 'u64': u64(v); break;
    case 's64': s64(v); break;
    case 'float': finite(v, FLOAT_MAX); break;
    case 'double': finite(v); break;
    case 'fvector': vector(v, FLOAT_MAX); break;
    case 'dvector': vector(v, Number.MAX_VALUE); break;
    case 'euler': euler(v); break;
    case 'fplacement': case 'dplacement': { const o = record(v, ['position', 'orientation']); vector(o.position, type === 'fplacement' ? FLOAT_MAX : Number.MAX_VALUE); euler(o.orientation); break; }
    case 'string': text(v, CAP0_BOUNDS.stringBytes); break;
    default: fail();
  }
}
function header(v: unknown) {
  const d = record(v, ['origin', 'source', 'versions', 'clocks', 'currency', 'publishedBoundaryOrderAtOpen', 'bounds']);
  choice(d.origin, ['game', 'synthetic']);
  const s = record(d.source, ['game', 'sdkGameId', 'processId', 'windowsSessionId', 'processInstanceId', 'pluginSessionId']);
  choice(s.game, ['ets2', 'ats']); text(s.sdkGameId, 128, false); integer(s.processId, 1, 4_294_967_295); integer(s.windowsSessionId, 0, 4_294_967_295); uuid(s.processInstanceId); uuid(s.pluginSessionId);
  const versions = record(d.versions, ['telemetryApi', 'gameTelemetry', 'sdkArchive', 'pluginImage']);
  for (const version of [versions.telemetryApi, versions.gameTelemetry]) { const o = record(version, ['major', 'minor']); integer(o.major, 0, 65_535); integer(o.minor, 0, 65_535); }
  text(versions.sdkArchive, 128, false);
  available(versions.pluginImage, value => { const o = record(value, ['path', 'sha256']); text(o.path, 4096, false); if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) fail(); });
  const clocks = record(d.clocks, ['sourceMonotonicClockId', 'gameClockIdAtOpen', 'openMonotonicNs']); uuid(clocks.sourceMonotonicClockId); uuid(clocks.gameClockIdAtOpen); u64(clocks.openMonotonicNs);
  available(d.currency, value => { const o = record(value, ['code', 'source']); if (typeof o.code !== 'string' || !/^[A-Z]{3}$/.test(o.code)) fail(); text(o.source, 128, false); });
  u64(d.publishedBoundaryOrderAtOpen);
  const bounds = record(d.bounds, Object.keys(CAP0_BOUNDS));
  for (const [key, value] of Object.entries(CAP0_BOUNDS)) if (bounds[key] !== value) fail('Unsupported CAP0 producer bounds');
}
function envelope(v: unknown) {
  const d = record(v, ['envelopeSeq', 'droppedBefore', 'callback', 'sharedBoundaryOrder', 'configurationRevision', 'callbackMonotonicNs', 'sdkFrame', 'gameTime', 'simulation', 'attributes', 'observations']);
  if (BigInt(u64(d.envelopeSeq)) === 0n) fail(); u64(d.droppedBefore); u64(d.sharedBoundaryOrder); u64(d.configurationRevision);
  const callback = record(d.callback, ['group', 'id']); const group = choice(callback.group, ['configuration', 'gameplay', 'lifecycle']);
  available(callback.id, value => text(value, CAP0_BOUNDS.identifierBytes, false));
  available(d.callbackMonotonicNs, u64);
  available(d.sdkFrame, value => { const o = record(value, ['renderTimeUs', 'simulationTimeUs', 'pausedSimulationTimeUs']); u64(o.renderTimeUs); u64(o.simulationTimeUs); u64(o.pausedSimulationTimeUs); });
  const gameTime = record(d.gameTime, ['minutes', 'clockId']); available(gameTime.minutes, value => { if (BigInt(u64(value)) > 4_294_967_295n) fail(); }); uuid(gameTime.clockId);
  choice(d.simulation, ['running', 'paused', 'unavailable']);
  const a = record(d.attributes, ['expected', 'present', 'terminated', 'total', 'first', 'count', 'final', 'omittedLowerBound']);
  const expected = bool(a.expected), present = bool(a.present), terminated = bool(a.terminated), final = bool(a.final);
  const total = integer(a.total, 0, CAP0_BOUNDS.attributeScan), first = integer(a.first, 0, CAP0_BOUNDS.attributeScan), count = integer(a.count, 0, CAP0_BOUNDS.attributeScan);
  integer(a.omittedLowerBound, terminated ? 0 : 1, terminated ? 0 : 1);
  if (first + count > total || final !== (first + count === total) || (present && !expected) || (!present && (total || !terminated)) || (group === 'lifecycle' && (expected || total))) fail();
  if (!terminated && total !== CAP0_BOUNDS.attributeScan) fail();
  if (!Array.isArray(d.observations) || d.observations.length !== count) fail();
  d.observations.forEach((item, offset) => {
    const o = record(item, ['position', 'name', 'arrayIndex', 'sdkType', 'sdkTypeId', 'value']);
    if (integer(o.position, 0, CAP0_BOUNDS.attributeScan - 1) !== first + offset) fail();
    available(o.name, value => text(value, CAP0_BOUNDS.identifierBytes, false));
    available(o.arrayIndex, value => integer(value, 0, 4_294_967_294));
    const id = integer(o.sdkTypeId, 0, 4_294_967_295);
    const type = choice(o.sdkType, [...Object.keys(CAP0_SDK_TYPES), 'unknown'] as Cap0SdkType[]);
    if (type === 'unknown' ? Object.values(CAP0_SDK_TYPES).includes(id as never) : CAP0_SDK_TYPES[type] !== id) fail();
    available(o.value, value => typed(type, value));
  });
}
function loss(v: unknown) {
  const d = record(v, ['attemptedEnvelopes', 'droppedEnvelopes', 'droppedBytes', 'droppedQueueFull', 'droppedBytesFull', 'lastDroppedEnvelopeSeq', 'lastDropMonotonicNs']);
  const attempted = BigInt(u64(d.attemptedEnvelopes)), dropped = BigInt(u64(d.droppedEnvelopes)); u64(d.droppedBytes);
  if (dropped > attempted || BigInt(u64(d.droppedQueueFull)) + BigInt(u64(d.droppedBytesFull)) !== dropped) fail();
  available(d.lastDroppedEnvelopeSeq, u64); available(d.lastDropMonotonicNs, u64);
}
function end(v: unknown) {
  const d = record(v, ['reason', 'attemptedEnvelopes', 'enqueuedEnvelopes', 'publishedEnvelopes', 'droppedEnvelopes', 'droppedBytes', 'unsentEnvelopes']);
  choice(d.reason, ['plugin-shutdown', 'source-retired', 'encoding-failed']);
  const attempted = BigInt(u64(d.attemptedEnvelopes)), enqueued = BigInt(u64(d.enqueuedEnvelopes)), dropped = BigInt(u64(d.droppedEnvelopes));
  if (enqueued + dropped !== attempted || BigInt(u64(d.publishedEnvelopes)) > enqueued || BigInt(u64(d.unsentEnvelopes)) > enqueued) fail();
  u64(d.droppedBytes);
}
/** Strict CAP0 0.0 packet validation: exact keys, bounds and exact integer representations. */
export function validateCap0Packet(v: unknown): Cap0Packet {
  const o = record(v, ['format', 'version', 'kind', 'captureSessionId', 'packetSeq', 'publishMonotonicNs', 'data']);
  if (o.format !== CAP0_FORMAT) fail('Not a CAP0 packet');
  const version = record(o.version, ['major', 'minor']); if (version.major !== 0 || version.minor !== 0) fail('Unsupported CAP0 version');
  uuid(o.captureSessionId); u64(o.packetSeq); u64(o.publishMonotonicNs);
  switch (choice(o.kind, ['header', 'envelope', 'loss', 'end'])) {
    case 'header': header(o.data); break;
    case 'envelope': envelope(o.data); break;
    case 'loss': loss(o.data); break;
    case 'end': end(o.data); break;
  }
  return v as Cap0Packet;
}
const fatal = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
export function decodeCap0Payload(bytes: Uint8Array): Cap0Packet {
  if (!bytes.length || bytes.length > CAP0_MAX_PACKET_BYTES) fail('CAP0 packet size rejected');
  let parsed: unknown;
  try { parsed = strictJson(fatal.decode(bytes)); } catch { fail('Malformed CAP0 JSON'); }
  return validateCap0Packet(parsed);
}
export function encodeCap0Hello(captureSessionId: string): Uint8Array {
  uuid(captureSessionId);
  const hello: Cap0Hello = {format: CAP0_FORMAT, version: CAP0_VERSION, kind: 'hello', captureSessionId, data: {evidenceOnly: true}};
  const payload = encoder.encode(JSON.stringify(hello)), frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length, true); frame.set(payload, 4); return frame;
}
/** Length-prefixed CAP0 framing. Fails closed; never rescans for a later prefix after an error. */
export class Cap0FrameDecoder {
  private header = new Uint8Array(4); private headerUsed = 0; private payload?: Uint8Array; private used = 0; private failed = false;
  push(chunk: Uint8Array, emit: (payload: Uint8Array) => void): void {
    if (this.failed) fail('CAP0 decoder closed');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.payload) {
          const n = Math.min(4 - this.headerUsed, chunk.length - offset); this.header.set(chunk.subarray(offset, offset + n), this.headerUsed); this.headerUsed += n; offset += n;
          if (this.headerUsed < 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, true);
          if (!length || length > CAP0_MAX_PACKET_BYTES) fail('CAP0 packet size rejected');
          this.payload = new Uint8Array(length); this.used = 0;
        }
        const n = Math.min(this.payload.length - this.used, chunk.length - offset); this.payload.set(chunk.subarray(offset, offset + n), this.used); this.used += n; offset += n;
        if (this.used === this.payload.length) { const complete = this.payload; this.payload = undefined; this.headerUsed = 0; emit(complete); }
      }
    } catch (error) { this.failed = true; this.payload = undefined; throw error; }
  }
  /** True when the stream ended on a packet boundary. */
  get idle(): boolean { return !this.failed && this.headerUsed === 0 && !this.payload; }
}
export interface Cap0Authority {game: 'ets2' | 'ats'; processId: number; windowsSessionId: number; processInstanceId: string; pluginSessionId: string}
/** Stream ordering for one capture session; it never reorders, deduplicates or repairs evidence. */
export class Cap0StreamValidator {
  private nextPacket = 0n; private lastPublish = -1n; private lastEnvelope = 0n; private lastBoundary = -1n;
  private open?: {seq: string; next: number; total: number};
  private lastLoss?: Cap0LossData; header?: Cap0HeaderData; ended = false;
  private authority?: Cap0Authority;
  constructor(private readonly captureSessionId: string, authority?: Cap0Authority) { uuid(captureSessionId); this.authority = authority; }
  /** Binds the broker-verified source before the header; afterwards identity can no longer change. */
  bindAuthority(authority: Cap0Authority): void { if (this.header || this.nextPacket) fail('CAP0 authority bound after header'); this.authority = authority; }
  accept(packet: Cap0Packet): void {
    if (this.ended) fail('CAP0 packet after end marker');
    if (packet.captureSessionId !== this.captureSessionId) fail('CAP0 capture session mismatch');
    if (BigInt(packet.packetSeq) !== this.nextPacket) fail('CAP0 packet sequence gap or regression');
    const publish = BigInt(packet.publishMonotonicNs); if (publish < this.lastPublish) fail('CAP0 publication clock regressed');
    if (!this.header && packet.kind !== 'header') fail('CAP0 header must be first');
    if (this.header && packet.kind === 'header') fail('Duplicate CAP0 header');
    if (packet.kind !== 'envelope' && this.open) fail('CAP0 envelope parts interrupted');
    if (packet.kind === 'header') {
      const s = packet.data.source, a = this.authority;
      if (a && (s.game !== a.game || s.processId !== a.processId || s.windowsSessionId !== a.windowsSessionId || s.processInstanceId !== a.processInstanceId || s.pluginSessionId !== a.pluginSessionId)) fail('CAP0 source authority mismatch');
      if (BigInt(packet.data.clocks.openMonotonicNs) > publish) fail('CAP0 header clock order invalid');
      this.header = packet.data;
    } else if (packet.kind === 'envelope') {
      const d = packet.data, seq = BigInt(d.envelopeSeq);
      if (d.callbackMonotonicNs.available && BigInt(d.callbackMonotonicNs.value) > publish) fail('CAP0 callback after publication');
      if (this.open) {
        if (d.envelopeSeq !== this.open.seq || d.attributes.first !== this.open.next || d.attributes.total !== this.open.total) fail('CAP0 envelope part mismatch');
      } else {
        if (d.attributes.first !== 0 || seq <= this.lastEnvelope || seq - this.lastEnvelope - 1n !== BigInt(d.droppedBefore)) fail('CAP0 envelope sequence or drop boundary mismatch');
        const boundary = BigInt(d.sharedBoundaryOrder); if (boundary <= this.lastBoundary) fail('CAP0 shared boundary order regressed');
        this.lastBoundary = boundary; this.lastEnvelope = seq;
      }
      this.open = d.attributes.final ? undefined : {seq: d.envelopeSeq, next: d.attributes.first + d.attributes.count, total: d.attributes.total};
    } else if (packet.kind === 'loss') {
      const previous = this.lastLoss;
      if (previous && (['attemptedEnvelopes', 'droppedEnvelopes', 'droppedBytes', 'droppedQueueFull', 'droppedBytesFull'] as const).some(key => BigInt(packet.data[key]) < BigInt(previous[key]))) fail('CAP0 loss counters regressed');
      this.lastLoss = packet.data;
    } else this.ended = true;
    this.nextPacket += 1n; this.lastPublish = publish;
  }
  get lastEnvelopeSeq(): string { return this.lastEnvelope.toString(); }
  get lastPacketSeq(): string | undefined { return this.nextPacket ? (this.nextPacket - 1n).toString() : undefined; }
  get loss(): Cap0LossData | undefined { return this.lastLoss; }
  get partial(): boolean { return Boolean(this.open); }
}
