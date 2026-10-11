// Protocol logic is independent of Electron, Node APIs, SDK callbacks and storage.
export const PROTOCOL_V0 = { major: 0, minor: 0 } as const;
export const MAX_FRAME_BYTES = 65_536;
export const MAX_JSON_DEPTH = 16;
export const MAX_DIAGNOSTIC_OBSERVATIONS = 32;
export type Uint64 = string;
export type UnavailableReason = 'not-supported' | 'not-observed' | 'invalid';
export type Available<T> = { available: true; value: T } | { available: false; reason: UnavailableReason };
export type Measure<U extends string> = Available<number> & { unit: U };
export interface SourceIdentity {
  game: 'ets2' | 'ats'; pluginSessionId: string; processInstanceId: string;
  processId: number; windowsSessionId: number; origin: 'game' | 'synthetic' | 'replay';
}
export interface CaptureTime { clockId: string; monotonicNs: Uint64 }
export interface LocalReceiveTime { clockId: string; monotonicNs: Uint64; utcUnixMs: Available<Uint64> }
export interface CurrentState {
  simulation: 'running' | 'paused' | 'unavailable';
  speed: Measure<'m/s'>; fuel: Measure<'L'>; fuelCapacity: Measure<'L'>;
  engineRpm: Measure<'rpm'>; gear: Measure<'index'>; odometer: Measure<'m'>;
  averageConsumption: Measure<'L/100km'>; estimatedRange: Measure<'m'>;
  gameTime: Available<Uint64> & { unit: 'min'; clockId: string };
  captureUtcUnixMs: Available<Uint64>;
  configuration: {
    revision: Uint64; truckId: Available<string>; job: Available<{
      cargoId: string; destinationCityId: string; plannedDistance: Measure<'m'>;
      expectedIncome: { rawValue: string; currency: { status: 'unknown' } | { status: 'verified'; code: string; source: string } };
    }>;
  };
  window: Available<{ handle: Uint64; x: number; y: number; width: number; height: number; dpi: number;
    foreground: boolean; minimized: boolean; displayMode: 'windowed' | 'borderless' | 'exclusive' | 'unknown' }>;
}
export interface Continuity { coalescedSnapshots: Uint64; lostObservations: Uint64; offlineTransitions: Uint64 }
export interface DiagnosticObservation {
  channel: string; sdkType: 'bool' | 's32' | 'u32' | 'u64' | 'float' | 'double' | 'string';
  value: Available<boolean | number | string>; unit: string;
}
interface ServerBase {
  version: typeof PROTOCOL_V0; source: SourceIdentity; seq: Uint64; capture: CaptureTime;
}
export type ServerMessage = ServerBase & (
  { kind: 'welcome'; data: { diagnostics: boolean; durableRecording: false } } |
  { kind: 'checkpoint'; data: { boundarySeq: Uint64; state: CurrentState; continuity: Continuity } } |
  { kind: 'snapshot'; data: { state: CurrentState; continuity: Continuity } } |
  { kind: 'diagnostic'; data: { copied: true; observations: DiagnosticObservation[]; continuity: Continuity } }
);
export interface HelloMessage { version: typeof PROTOCOL_V0; kind: 'hello'; data: {
  clientInstanceId: string; minMinor: 0; maxMinor: number; diagnostics: boolean;
} }
export type ProtocolMessage = HelloMessage | ServerMessage;
export interface ReceivedMessage { message: ServerMessage; received: LocalReceiveTime }
export class ProtocolError extends Error {}
function fail(): never { throw new ProtocolError('Invalid protocol v0 message'); }
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  let count = 0;
  for (const key in o) if (Object.hasOwn(o, key)) { if (!keys.includes(key) || ++count > keys.length) fail(); }
  if (count !== keys.length || keys.some(k => !Object.hasOwn(o, k))) fail();
  return o;
}
function text(v: unknown, max = 128, allowEmpty = false): asserts v is string {
  // eslint-disable-next-line no-control-regex -- control characters are deliberately rejected.
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0) || v.length > max || new TextEncoder().encode(v).length > max || /[\u0000-\u001f\u007f]/u.test(v) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail();
}
function uuid(v: unknown) { if (typeof v !== 'string' || v.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) fail(); }
export function isUint64(v: unknown): v is Uint64 {
  return typeof v === 'string' && v.length <= 20 && /^(0|[1-9][0-9]{0,19})$/.test(v) && (v.length < 20 || v <= '18446744073709551615');
}
function uint64(v: unknown) { if (!isUint64(v)) fail(); }
function num(v: unknown, min: number, max: number, integer = false) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail();
}
function bool(v: unknown) { if (typeof v !== 'boolean') fail(); }
function choice(v: unknown, options: readonly unknown[]) { if (!options.includes(v)) fail(); }
function available(v: unknown, validate: (value: unknown) => void, extra: string[] = []) {
  if (v === null || typeof v !== 'object') fail();
  const flag = (v as Record<string, unknown>).available;
  bool(flag);
  const o = object(v, ['available', flag ? 'value' : 'reason', ...extra]);
  if (flag) validate(o.value); else choice(o.reason, ['not-supported', 'not-observed', 'invalid']);
  return o;
}
function measure(v: unknown, unit: string, min: number, max: number, integer = false) {
  const o = available(v, value => num(value, min, max, integer), ['unit']);
  if (o.unit !== unit) fail();
}
function continuity(v: unknown) {
  const o = object(v, ['coalescedSnapshots', 'lostObservations', 'offlineTransitions']);
  Object.values(o).forEach(uint64);
}
function state(v: unknown) {
  const o = object(v, ['simulation', 'speed', 'fuel', 'fuelCapacity', 'engineRpm', 'gear', 'odometer', 'averageConsumption', 'estimatedRange', 'gameTime', 'captureUtcUnixMs', 'configuration', 'window']);
  choice(o.simulation, ['running', 'paused', 'unavailable']);
  measure(o.speed, 'm/s', -1_000, 1_000); measure(o.fuel, 'L', 0, 1_000_000);
  measure(o.fuelCapacity, 'L', 0, 1_000_000); measure(o.engineRpm, 'rpm', 0, 100_000);
  measure(o.gear, 'index', -100, 100, true); measure(o.odometer, 'm', 0, 1e12);
  measure(o.averageConsumption, 'L/100km', 0, 1_000_000); measure(o.estimatedRange, 'm', 0, 1e12);
  const gt = available(o.gameTime, uint64, ['unit', 'clockId']);
  if (gt.unit !== 'min') fail(); uuid(gt.clockId); available(o.captureUtcUnixMs, uint64);
  const c = object(o.configuration, ['revision', 'truckId', 'job']); uint64(c.revision);
  available(c.truckId, value => text(value));
  available(c.job, value => {
    const j = object(value, ['cargoId', 'destinationCityId', 'plannedDistance', 'expectedIncome']);
    text(j.cargoId); text(j.destinationCityId); measure(j.plannedDistance, 'm', 0, 1e12);
    const m = object(j.expectedIncome, ['rawValue', 'currency']);
    if (typeof m.rawValue !== 'string' || m.rawValue.length > 28 || !/^-?(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$/.test(m.rawValue)) fail();
    const status = (m.currency as Record<string, unknown> | null)?.status;
    if (status === 'unknown') object(m.currency, ['status']);
    else { const currency = object(m.currency, ['status', 'code', 'source']);
      if (status !== 'verified' || typeof currency.code !== 'string' || !/^[A-Z]{3}$/.test(currency.code)) fail(); text(currency.source); }
  });
  available(o.window, value => {
    const w = object(value, ['handle', 'x', 'y', 'width', 'height', 'dpi', 'foreground', 'minimized', 'displayMode']);
    uint64(w.handle); if (w.handle === '0') fail(); num(w.x, -1e6, 1e6, true); num(w.y, -1e6, 1e6, true);
    num(w.width, 0, 100_000, true); num(w.height, 0, 100_000, true); num(w.dpi, 1, 1_000, true);
    bool(w.foreground); bool(w.minimized); choice(w.displayMode, ['windowed', 'borderless', 'exclusive', 'unknown']);
  });
}
export function validateMessage(v: unknown): ProtocolMessage {
  if (v === null || typeof v !== 'object') fail();
  const kind = (v as Record<string, unknown>).kind;
  const o = object(v, kind === 'hello' ? ['version', 'kind', 'data'] : ['version', 'kind', 'source', 'seq', 'capture', 'data']);
  const ver = object(o.version, ['major', 'minor']);
  if (ver.major !== 0 || ver.minor !== 0) throw new ProtocolError('Unsupported protocol version');
  if (kind === 'hello') {
    const d = object(o.data, ['clientInstanceId', 'minMinor', 'maxMinor', 'diagnostics']);
    uuid(d.clientInstanceId); if (d.minMinor !== 0) fail(); num(d.maxMinor, 0, 65_535, true); bool(d.diagnostics);
  } else {
    const s = object(o.source, ['game', 'pluginSessionId', 'processInstanceId', 'processId', 'windowsSessionId', 'origin']);
    choice(s.game, ['ets2', 'ats']); uuid(s.pluginSessionId); uuid(s.processInstanceId);
    num(s.processId, 1, 4_294_967_295, true); num(s.windowsSessionId, 0, 4_294_967_295, true); choice(s.origin, ['game', 'synthetic', 'replay']);
    uint64(o.seq); const cap = object(o.capture, ['clockId', 'monotonicNs']); uuid(cap.clockId); uint64(cap.monotonicNs);
    if (kind === 'welcome') { const d = object(o.data, ['diagnostics', 'durableRecording']); bool(d.diagnostics); if (d.durableRecording !== false) fail(); }
    else if (kind === 'snapshot' || kind === 'checkpoint') {
      const d = object(o.data, kind === 'checkpoint' ? ['boundarySeq', 'state', 'continuity'] : ['state', 'continuity']);
      if (kind === 'checkpoint' && d.boundarySeq !== o.seq) fail(); state(d.state); continuity(d.continuity);
    } else if (kind === 'diagnostic') {
      const d = object(o.data, ['copied', 'observations', 'continuity']); if (d.copied !== true) fail(); continuity(d.continuity);
      if (!Array.isArray(d.observations) || d.observations.length > MAX_DIAGNOSTIC_OBSERVATIONS) fail();
      const channels = new Set<string>();
      for (const value of d.observations) {
        const obs = object(value, ['channel', 'sdkType', 'value', 'unit']); text(obs.channel); text(obs.unit, 32);
        if (channels.has(obs.channel)) fail(); channels.add(obs.channel);
        choice(obs.sdkType, ['bool', 's32', 'u32', 'u64', 'float', 'double', 'string']);
        available(obs.value, raw => {
          switch (obs.sdkType) {
            case 'bool': bool(raw); break;
            case 's32': num(raw, -2_147_483_648, 2_147_483_647, true); break;
            case 'u32': num(raw, 0, 4_294_967_295, true); break;
            case 'u64': uint64(raw); break;
            case 'float': num(raw, -3.4028234663852886e38, 3.4028234663852886e38); break;
            case 'double': num(raw, -Number.MAX_VALUE, Number.MAX_VALUE); break;
            case 'string': text(raw, 1_024, true); break;
          }
        });
      }
    } else fail();
  }
  return v as ProtocolMessage;
}

// JSON.parse alone loses duplicate keys. This bounded parser rejects them before schema validation.
export function strictJson(input: string): unknown {
  let p = 0;
  const ws = () => { while (/[ \r\n\t]/.test(input[p] ?? '\0')) p++; };
  const str = (): string => {
    const start = p++; let escaped = false;
    while (p < input.length) {
      const c = input[p++];
      if (!escaped && c === '"') {
        const value: unknown = JSON.parse(input.slice(start, p));
        if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
        return value;
      }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) fail(); ws(); const c = input[p];
    if (c === '"') return str();
    if (c === '{') {
      p++; ws(); const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (input[p] === '}') { p++; return o; }
      while (true) {
        ws(); if (input[p] !== '"') fail(); const k = str(); if (Object.hasOwn(o, k)) fail(); ws();
        if (input[p++] !== ':') fail(); o[k] = value(depth + 1); ws();
        const end = input[p++]; if (end === '}') return o; if (end !== ',') fail();
      }
    }
    if (c === '[') {
      p++; ws(); const a: unknown[] = []; if (input[p] === ']') { p++; return a; }
      while (true) { a.push(value(depth + 1)); ws(); const end = input[p++]; if (end === ']') return a; if (end !== ',') fail(); }
    }
    const match = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(input.slice(p));
    if (!match) fail(); p += match[0].length; const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail(); return parsed;
  };
  const result = value(0); ws(); if (p !== input.length) fail(); return result;
}
export function decodePayload(bytes: Uint8Array): ProtocolMessage {
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) fail();
  try { return validateMessage(strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))); }
  catch (error) { if (error instanceof ProtocolError) throw error; return fail(); }
}
export function encodeFrame(message: ProtocolMessage): Uint8Array {
  validateMessage(message); const bytes = new TextEncoder().encode(JSON.stringify(message));
  // Validate serialized bytes as well: this catches invalid string scalars and encoder size limits.
  decodePayload(bytes); const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, true); frame.set(bytes, 4); return frame;
}
export class FrameDecoder {
  private header = new Uint8Array(4); private headerUsed = 0;
  private payload: Uint8Array | undefined; private payloadUsed = 0; private failed = false; private pushing = false;
  // Emit immediately; the decoder never accumulates an unbounded result list for a large chunk.
  push(chunk: Uint8Array, emit: (message: ProtocolMessage) => void): void {
    if (this.failed) throw new ProtocolError('Decoder is closed');
    if (this.pushing) { this.failed = true; this.payload = undefined; throw new ProtocolError('Recursive decoding is unsupported'); }
    this.pushing = true;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.payload) {
          const n = Math.min(4 - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + n), this.headerUsed); this.headerUsed += n; offset += n;
          if (this.headerUsed !== 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, true);
          if (length === 0 || length > MAX_FRAME_BYTES) fail(); this.payload = new Uint8Array(length); this.payloadUsed = 0;
        }
        const n = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
        this.payload.set(chunk.subarray(offset, offset + n), this.payloadUsed); this.payloadUsed += n; offset += n;
        if (this.payloadUsed === this.payload.length) {
          const message = decodePayload(this.payload); this.payload = undefined; this.headerUsed = 0; emit(message);
          if (this.failed) return;
        }
      }
    } catch (error) { this.failed = true; this.payload = undefined; throw error; }
    finally { this.pushing = false; }
  }
  end(): void { const truncated = this.failed || this.headerUsed !== 0 || !!this.payload; this.failed = true; this.payload = undefined; if (truncated) throw new ProtocolError('Truncated or failed stream'); }
}

export interface AppliedState { hydration: boolean; skippedSequences: Uint64; continuity: Continuity }
export class V0Consumer {
  private phase: 'welcome' | 'checkpoint' | 'live' | 'closed' = 'welcome';
  private identity?: string; private clock?: string; private lastSeq?: bigint; private lastCapture?: bigint;
  private counters?: Continuity;
  constructor(private readonly diagnosticsRequested: boolean) {}
  accept(input: unknown): AppliedState | undefined {
    try {
      const m = validateMessage(input); if (m.kind === 'hello' || this.phase === 'closed') fail();
      const seq = BigInt(m.seq), capture = BigInt(m.capture.monotonicNs);
      // Identity comparison does not depend on JSON property order.
      const stableIdentity = [m.source.game, m.source.pluginSessionId, m.source.processInstanceId, m.source.processId, m.source.windowsSessionId, m.source.origin].join('|');
      if (this.phase === 'welcome') {
        if (m.kind !== 'welcome' || (m.data.diagnostics && !this.diagnosticsRequested)) fail();
        this.identity = stableIdentity; this.clock = m.capture.clockId; this.phase = 'checkpoint';
        this.lastSeq = seq; this.lastCapture = capture; this.diagnosticsEnabled = m.data.diagnostics; return;
      }
      if (stableIdentity !== this.identity || m.capture.clockId !== this.clock || seq <= this.lastSeq! || capture < this.lastCapture!) fail();
      if (this.phase === 'checkpoint' && m.kind !== 'checkpoint') fail();
      if (this.phase === 'live' && (m.kind === 'welcome' || m.kind === 'checkpoint')) fail();
      if (m.kind === 'welcome' || (m.kind === 'diagnostic' && !this.diagnosticsEnabled)) fail();
      const counters = m.data.continuity;
      if (this.counters && Object.keys(this.counters).some(k => BigInt(counters[k as keyof Continuity]) < BigInt(this.counters![k as keyof Continuity]))) fail();
      const result = { hydration: m.kind === 'checkpoint', skippedSequences: (seq - this.lastSeq! - 1n).toString(), continuity: counters };
      this.lastSeq = seq; this.lastCapture = capture; this.counters = { ...counters }; this.phase = 'live'; return result;
    } catch (error) { this.phase = 'closed'; throw error; }
  }
  private diagnosticsEnabled = false;
}
export function withReceiveTime(message: ServerMessage, received: LocalReceiveTime): ReceivedMessage {
  validateMessage(message); const r = object(received, ['clockId', 'monotonicNs', 'utcUnixMs']);
  uuid(r.clockId); uint64(r.monotonicNs); available(r.utcUnixMs, uint64); return { message, received };
}

export function negotiateV0(input: unknown): { version: typeof PROTOCOL_V0; diagnostics: boolean; durableRecording: false } {
  const hello = validateMessage(input); if (hello.kind !== 'hello') fail();
  return { version: PROTOCOL_V0, diagnostics: hello.data.diagnostics, durableRecording: false };
}
export type SdkMeasurementField = 'speed' | 'fuel' | 'fuelCapacity' | 'engineRpm' | 'gear' | 'odometer' | 'averageConsumption' | 'estimatedRange';
const sdkMeasures = {
  speed: ['m/s', 1, -1_000, 1_000], fuel: ['L', 1, 0, 1_000_000], fuelCapacity: ['L', 1, 0, 1_000_000],
  engineRpm: ['rpm', 1, 0, 100_000], gear: ['index', 1, -100, 100], odometer: ['m', 1_000, 0, 1e12],
  averageConsumption: ['L/100km', 100, 0, 1_000_000], estimatedRange: ['m', 1_000, 0, 1e12],
} as const;
// SDK-independent mapping; adapter callbacks and feature availability detection belong to ET-003.
export function normalizeSdkMeasurement<F extends SdkMeasurementField>(field: F, input: Available<number>): Measure<(typeof sdkMeasures)[F][0]> {
  const [unit, multiplier, min, max] = sdkMeasures[field];
  available(input, value => { if (typeof value !== 'number') fail(); });
  if (!input.available) return { ...input, unit };
  const value = input.value * multiplier;
  if (!Number.isFinite(value) || value < min || value > max || (field === 'gear' && !Number.isInteger(value))) return { available: false, reason: 'invalid', unit };
  return { available: true, value, unit };
}
