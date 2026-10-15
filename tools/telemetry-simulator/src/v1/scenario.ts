// Strict protocol v1 simulator scenario schema (ET-005b). Scenario files are read with the bounded strict-JSON reader of
// the v0 simulator; unknown keys, unordered steps and unsupported origins are rejected, and the returned scenario is
// rebuilt from validated fields only. The format is documented in docs/simulator-v1.md.
import {MAX_EVENT_SEQ, PROTOCOL_V1, validateServerMessage, type GameMode} from '../../../../packages/contracts/src/protocol-v1';
import {isUint64} from '../../../../packages/contracts/src/protocol-v0';
import {CHANNELS, type AttributeList, type FrameChannels, type SdkAttribute, type SdkType, type SourceConfig} from './source';
import {type AckPolicy, type ClientPolicy, type CommitPolicy} from './client';

export const SCENARIO_FORMAT = 'ets2telemetry-simulator-v1';
export const MAX_AT_MS = 86_400_000;
export const MAX_STEPS = 1_000;
type At = {atMs: number};
export type SourceStep = At & (
  {action: 'configuration' | 'gameplay'; id: string; attributes: SdkAttribute[]; list: AttributeList; repeat: number} |
  {action: 'lifecycle'; event: 'simulation.started' | 'simulation.paused'} |
  {action: 'frame'; timerRestart: boolean; channels: FrameChannels} |
  {action: 'gameMode'; mode: GameMode} |
  {action: 'encodingFailure'; count: number} |
  {action: 'handoff'; full: boolean} |
  {action: 'utcJump'; deltaMs: number} |
  {action: 'suspend'; durationMs: number; sourceClockAdvances: boolean} |
  {action: 'shutdown'; reason: 'plugin-shutdown' | 'source-retired'});
export type TransportStep = At & ({action: 'connect'; client: ClientPolicy & {probes: number[]}} | {action: 'disconnect'});
export interface Scenario {
  id: string; purpose: string; reg: string[]; origin: 'synthetic'; game: 'ets2' | 'ats'; seed: string;
  source: Omit<SourceConfig, 'game' | 'seed'>; steps: SourceStep[]; transport: TransportStep[];
}

function fail(path: string, reason = 'invalid'): never { throw new Error(`Invalid simulator v1 scenario at ${path}: ${reason}`); }
function obj(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'object expected');
  const keys = Reflect.ownKeys(v);
  for (const k of keys) if (typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) fail(path, `unknown field ${String(k)}`);
  for (const k of required) if (!Object.hasOwn(v, k)) fail(path, `missing field ${k}`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(v) || v.length > maxLength) fail(path, `array of at most ${maxLength} expected`);
  return Array.from({length: v.length}, (_, i) => (v as unknown[])[i]);
}
function str(v: unknown, path: string, maxLength = 128): string { if (typeof v !== 'string' || !v.length || v.length > maxLength) fail(path, 'nonempty string expected'); return v; }
function int(v: unknown, path: string, min: number, max: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(path, `integer ${min}..${max} expected`); return v; }
function bool(v: unknown, path: string): boolean { if (typeof v !== 'boolean') fail(path, 'boolean expected'); return v; }
function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T { if (typeof v !== 'string' || !options.includes(v as T)) fail(path, `one of ${options.join(', ')} expected`); return v as T; }
const opt = <T>(o: Record<string, unknown>, key: string, read: (v: unknown) => T, fallback: T): T => Object.hasOwn(o, key) ? read(o[key]) : fallback;
/** SDK floats are 32-bit; requiring float32-exact values keeps hand-written expectations exact. */
function float32(v: unknown, path: string): number { if (typeof v !== 'number' || !Number.isFinite(v) || Math.fround(v) !== v) fail(path, 'float32-exact number expected'); return v; }
function finite(v: unknown, path: string): number { if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'finite number expected'); return v; }
const S64 = /^-?(0|[1-9][0-9]{0,18})$/;

const SDK_TYPES: readonly SdkType[] = ['string', 'bool', 's32', 'u32', 's64', 'u64', 'float', 'double'];
function attribute(v: unknown, path: string): SdkAttribute {
  const a = obj(v, path, ['name', 'sdkType', 'value']), name = str(a.name, `${path}.name`), sdkType = oneOf(a.sdkType, `${path}.sdkType`, SDK_TYPES), raw = a.value;
  let value: SdkAttribute['value'];
  switch (sdkType) {
    case 'string': if (raw !== null && (typeof raw !== 'string' || raw.length > 1_024)) fail(`${path}.value`, 'string or null expected'); value = raw; break;
    case 'bool': value = bool(raw, `${path}.value`); break;
    case 's32': value = int(raw, `${path}.value`, -2_147_483_648, 2_147_483_647); break;
    case 'u32': value = int(raw, `${path}.value`, 0, 4_294_967_295); break;
    case 's64': if (typeof raw !== 'string' || !S64.test(raw) || raw === '-0' || BigInt(raw) < -(2n ** 63n) || BigInt(raw) > 2n ** 63n - 1n) fail(`${path}.value`, 'exact s64 decimal string expected'); value = raw; break;
    case 'u64': if (!isUint64(raw)) fail(`${path}.value`, 'exact u64 decimal string expected'); value = raw; break;
    case 'float': value = float32(raw, `${path}.value`); break;
    case 'double': value = finite(raw, `${path}.value`); break;
  }
  return {name, sdkType, value};
}
const CONFIGURATION_IDS = ['job', 'truck', 'trailer', ...Array.from({length: 10}, (_, i) => `trailer.${i}`), 'bus_job', 'car_job', 'controls', 'hshifter', 'substances'];
function channels(v: unknown, path: string): FrameChannels {
  const c = obj(v, path, [], CHANNELS), out: Record<string, unknown> = {};
  for (const name of CHANNELS) {
    if (!Object.hasOwn(c, name)) continue;
    const raw = c[name], p = `${path}.${name}`;
    if (raw === null || raw === 'invalid') { out[name] = raw; continue; }
    if (name === 'world.placement') {
      const o = obj(raw, p, ['x', 'y', 'z', 'heading', 'pitch', 'roll']);
      out[name] = Object.fromEntries(['x', 'y', 'z', 'heading', 'pitch', 'roll'].map(k => [k, finite(o[k], `${p}.${k}`)]));
    } else if (name === 'game.time') out[name] = int(raw, p, 0, 4_294_967_295);
    else if (name === 'displayed.gear') out[name] = int(raw, p, -2_147_483_648, 2_147_483_647);
    else out[name] = float32(raw, p);
  }
  return out;
}
function gameMode(v: unknown, path: string): GameMode {
  const o = obj(v, path, ['mode', 'method', 'confidence'], ['module']);
  const mode: GameMode = {mode: oneOf(o.mode, `${path}.mode`, ['single-player', 'truckersmp', 'unknown'] as const), method: oneOf(o.method, `${path}.method`, ['module-scan', 'process-scan', 'none'] as const),
    confidence: oneOf(o.confidence, `${path}.confidence`, ['strong', 'weak', 'none'] as const), module: Object.hasOwn(o, 'module') ? {available: true, value: str(o.module, `${path}.module`)} : {available: false, reason: 'not-observed'}};
  // The D9 invariants are the contract's: validate through a synthetic source.gameMode event.
  const id = '00000000-0000-4000-8000-000000000000', occurred = {monotonicNs: {available: true, value: '0'}, gameTime: {minutes: {available: false, reason: 'not-observed'}, clockId: id},
    utcUnixMs: {available: false, reason: 'not-observed'}, simulation: 'unavailable', configurationRevision: '0', boundaryOrder: '0'};
  try {
    validateServerMessage({version: PROTOCOL_V1, kind: 'event', source: {game: 'ets2', pluginSessionId: id, processInstanceId: id, processId: 1, windowsSessionId: 0, origin: 'synthetic'},
      seq: '1', capture: {clockId: id, monotonicNs: '0'}, data: {eventSeq: '1', redelivered: false, occurred, record: {type: 'source.gameMode', ...mode}}});
  } catch { fail(path, 'game mode violates the D9 invariants'); }
  return mode;
}
function policy(v: unknown, path: string, connectAt: number): ClientPolicy & {probes: number[]} {
  const o = obj(v, path, ['durable'], ['commit', 'ack', 'probes']), durable = bool(o.durable, `${path}.durable`);
  if (!durable && (Object.hasOwn(o, 'commit') || Object.hasOwn(o, 'ack'))) fail(path, 'a live-only client never commits or acknowledges');
  const commit = opt<CommitPolicy>(o, 'commit', raw => {
    const s = str(raw, `${path}.commit`), m = /^(failAt|crashAfterCommit):([1-9][0-9]*)$/.exec(s);
    if (s === 'each' || s === 'none') return {kind: s};
    if (!m || BigInt(m[2]) > BigInt(MAX_EVENT_SEQ)) fail(`${path}.commit`, 'each, none, failAt:<eventSeq> or crashAfterCommit:<eventSeq> expected');
    return {kind: m[1] as 'failAt' | 'crashAfterCommit', eventSeq: BigInt(m[2])};
  }, {kind: durable ? 'each' : 'none'});
  const ack = opt<AckPolicy>(o, 'ack', raw => {
    const s = str(raw, `${path}.ack`), m = /^dropAfter:([0-9]{1,4})$/.exec(s);
    if (s === 'each' || s === 'withhold') return {kind: s};
    if (!m) fail(`${path}.ack`, 'each, withhold or dropAfter:<count> expected');
    return {kind: 'dropAfter', count: Number(m[1])};
  }, {kind: durable ? 'each' : 'withhold'});
  let last = connectAt - 1_000;
  // At most one probe per second (§11); a probe follows its connection's checkpoint.
  const probes = opt(o, 'probes', raw => arr(raw, `${path}.probes`, 100).map((t, i) => {
    const at = int(t, `${path}.probes[${i}]`, connectAt + 1, MAX_AT_MS); if (at < last + 1_000) fail(`${path}.probes[${i}]`, 'probes must be at least 1,000 ms apart'); last = at; return at;
  }), []);
  return {durable, commit, ack, probes};
}

function sourceStep(v: unknown, path: string, source: Scenario['source']): SourceStep {
  const action = oneOf(obj(v, path, ['atMs', 'action'], ['id', 'attributes', 'list', 'repeat', 'event', 'timerRestart', 'channels', 'mode', 'method', 'confidence', 'module',
    'count', 'full', 'deltaMs', 'durationMs', 'sourceClockAdvances', 'reason']).action, `${path}.action`,
  ['configuration', 'gameplay', 'lifecycle', 'frame', 'gameMode', 'encodingFailure', 'handoff', 'utcJump', 'suspend', 'shutdown'] as const);
  const at = (o: Record<string, unknown>) => int(o.atMs, `${path}.atMs`, 0, MAX_AT_MS);
  switch (action) {
    case 'configuration': case 'gameplay': {
      const o = obj(v, path, ['atMs', 'action', 'id', 'attributes'], ['list', 'repeat']);
      if (action === 'gameplay' && source.gameplayEvents === 'not-supported') fail(path, 'gameplay callbacks are not registered in this session');
      const id = action === 'configuration' ? oneOf(o.id, `${path}.id`, CONFIGURATION_IDS) : str(o.id, `${path}.id`);
      const attributes = arr(o.attributes, `${path}.attributes`, 255).map((a, i) => attribute(a, `${path}.attributes[${i}]`));
      const list = opt<AttributeList>(o, 'list', raw => oneOf(raw, `${path}.list`, ['terminated', 'null', 'unterminated'] as const), 'terminated');
      if (list === 'null' && attributes.length) fail(path, 'a null attribute list has no attributes');
      // The native scan reports an unterminated list only after 255 named entries; the scenario form is a shorthand for
      // such a cut list and must still carry at least one attribute.
      if (list === 'unterminated' && !attributes.length) fail(path, 'an unterminated attribute list has at least one attribute');
      return {atMs: at(o), action, id, attributes, list, repeat: opt(o, 'repeat', raw => int(raw, `${path}.repeat`, 1, 1_000), 1)};
    }
    case 'lifecycle': { const o = obj(v, path, ['atMs', 'action', 'event']); return {atMs: at(o), action, event: oneOf(o.event, `${path}.event`, ['simulation.started', 'simulation.paused'] as const)}; }
    case 'frame': {
      const o = obj(v, path, ['atMs', 'action'], ['timerRestart', 'channels']);
      return {atMs: at(o), action, timerRestart: opt(o, 'timerRestart', raw => bool(raw, `${path}.timerRestart`), false), channels: opt(o, 'channels', raw => channels(raw, `${path}.channels`), {})};
    }
    case 'gameMode': {
      const o = obj(v, path, ['atMs', 'action', 'mode', 'method', 'confidence'], ['module']);
      if (source.gameMode !== 'synthetic-detection') fail(path, 'game-mode steps require synthetic detection (OD-3 reports unknown)');
      const mode = {mode: o.mode, method: o.method, confidence: o.confidence, ...(Object.hasOwn(o, 'module') ? {module: o.module} : {})};
      return {atMs: at(o), action, mode: gameMode(mode, path)};
    }
    case 'encodingFailure': { const o = obj(v, path, ['atMs', 'action', 'count']); return {atMs: at(o), action, count: int(o.count, `${path}.count`, 1, 1_000)}; }
    case 'handoff': { const o = obj(v, path, ['atMs', 'action', 'full']); return {atMs: at(o), action, full: bool(o.full, `${path}.full`)}; }
    case 'utcJump': {
      const o = obj(v, path, ['atMs', 'action', 'deltaMs']), deltaMs = int(o.deltaMs, `${path}.deltaMs`, -1e12, 1e12);
      if (!deltaMs) fail(`${path}.deltaMs`, 'nonzero expected');
      return {atMs: at(o), action, deltaMs};
    }
    case 'suspend': {
      const o = obj(v, path, ['atMs', 'action', 'durationMs', 'sourceClockAdvances']);
      return {atMs: at(o), action, durationMs: int(o.durationMs, `${path}.durationMs`, 1, MAX_AT_MS), sourceClockAdvances: bool(o.sourceClockAdvances, `${path}.sourceClockAdvances`)};
    }
    case 'shutdown': { const o = obj(v, path, ['atMs', 'action', 'reason']); return {atMs: at(o), action, reason: oneOf(o.reason, `${path}.reason`, ['plugin-shutdown', 'source-retired'] as const)}; }
  }
}
function transportStep(v: unknown, path: string): TransportStep {
  const o = obj(v, path, ['atMs', 'action'], ['client']), atMs = int(o.atMs, `${path}.atMs`, 0, MAX_AT_MS);
  const action = oneOf(o.action, `${path}.action`, ['connect', 'disconnect'] as const);
  if (action === 'disconnect') { obj(v, path, ['atMs', 'action']); return {atMs, action}; }
  obj(v, path, ['atMs', 'action', 'client']);
  return {atMs, action, client: policy(o.client, `${path}.client`, atMs)};
}

/** Validates one scenario and rebuilds it from declared, validated values only. */
export function validateScenario(input: unknown): Scenario {
  const o = obj(input, '$', ['format', 'schemaVersion', 'id', 'purpose', 'reg', 'origin', 'game', 'seed', 'provenance', 'source', 'steps', 'transport']);
  if (o.format !== SCENARIO_FORMAT || o.schemaVersion !== 1) fail('$.format', `${SCENARIO_FORMAT} schema 1 expected`);
  // The simulator never emits `game` (CD-4). Replay origins require CAP-01 provenance, which a later ET-005b PR adds.
  if (o.origin === 'game') fail('$.origin', 'the simulator never emits origin game');
  if (o.origin !== 'synthetic') fail('$.origin', 'only synthetic scenarios are supported in this revision');
  if (o.provenance !== null) fail('$.provenance', 'a synthetic scenario has no capture provenance');
  const reg = arr(o.reg, '$.reg', 18).map((r, i) => { const s = str(r, `$.reg[${i}]`); if (!/^REG-0(0[1-9]|1[0-8])$/.test(s)) fail(`$.reg[${i}]`); return s; });
  if (!reg.length || new Set(reg).size !== reg.length) fail('$.reg', 'unique REG identifiers expected');
  const s = obj(o.source, '$.source', ['versions', 'gameplayEvents', 'currency', 'gameMode'], ['startEventSeq']);
  const v = obj(s.versions, '$.source.versions', ['telemetryApi', 'gameTelemetry', 'sdkArchive']);
  const pair = (p: unknown, path: string) => { const x = obj(p, path, ['major', 'minor']); return {major: int(x.major, `${path}.major`, 0, 65_535), minor: int(x.minor, `${path}.minor`, 0, 65_535)}; };
  const sdkArchive = str(v.sdkArchive, '$.source.versions.sdkArchive');
  if (!/^[\x21-\x7e]+$/.test(sdkArchive)) fail('$.source.versions.sdkArchive', 'printable ASCII expected');
  const source: Scenario['source'] = {
    versions: {telemetryApi: pair(v.telemetryApi, '$.source.versions.telemetryApi'), gameTelemetry: pair(v.gameTelemetry, '$.source.versions.gameTelemetry'), sdkArchive},
    gameplayEvents: oneOf(s.gameplayEvents, '$.source.gameplayEvents', ['registered', 'not-supported'] as const),
    currency: oneOf(s.currency, '$.source.currency', ['unknown', 'sdk-documented'] as const),
    gameMode: oneOf(s.gameMode, '$.source.gameMode', ['unknown', 'synthetic-detection'] as const),
    startEventSeq: opt(s, 'startEventSeq', raw => { if (!isUint64(raw) || BigInt(raw) < 1n || BigInt(raw) > BigInt(MAX_EVENT_SEQ)) fail('$.source.startEventSeq'); return BigInt(raw); }, 1n)
  };
  const steps = arr(o.steps, '$.steps', MAX_STEPS).map((x, i) => sourceStep(x, `$.steps[${i}]`, source));
  const transport = arr(o.transport, '$.transport', MAX_STEPS).map((x, i) => transportStep(x, `$.transport[${i}]`));
  if (steps.length + transport.length > MAX_STEPS) fail('$', `at most ${MAX_STEPS} steps`);
  checkTimeline(steps, transport);
  return {id: str(o.id, '$.id'), purpose: str(o.purpose, '$.purpose', 1_024), reg, origin: 'synthetic', game: oneOf(o.game, '$.game', ['ets2', 'ats'] as const), seed: str(o.seed, '$.seed'), source, steps, transport};
}

/** One ordered timeline: at equal times source steps precede probes, which precede transport steps. */
export type TimelineEntry = {atMs: number} & ({lane: 'source'; step: SourceStep} | {lane: 'probe'; connection: number} | {lane: 'transport'; step: TransportStep; connection: number});
export function timeline(steps: readonly SourceStep[], transport: readonly TransportStep[]): TimelineEntry[] {
  const entries: TimelineEntry[] = steps.map(step => ({atMs: step.atMs, lane: 'source', step}));
  let connection = 0;
  for (const step of transport) {
    if (step.action === 'connect') connection++;
    entries.push({atMs: step.atMs, lane: 'transport', step, connection});
    if (step.action === 'connect') for (const atMs of step.client.probes) entries.push({atMs, lane: 'probe', connection});
  }
  const rank = {source: 0, probe: 1, transport: 2};
  // Array.prototype.sort is stable, so entries of one lane keep their scenario order.
  return entries.sort((a, b) => a.atMs - b.atMs || rank[a.lane] - rank[b.lane]);
}
function checkTimeline(steps: readonly SourceStep[], transport: readonly TransportStep[]): void {
  for (const [name, list] of [['steps', steps], ['transport', transport]] as const) list.forEach((s, i) => { if (i && s.atMs < list[i - 1].atMs) fail(`$.${name}[${i}].atMs`, 'steps must be ordered by atMs'); });
  const entries = timeline(steps, transport);
  let connected = false, open = -1, asleepUntil = -1, ended = false;
  entries.forEach((e, i) => {
    if (ended) fail(`$ entry ${i}`, 'nothing may follow shutdown');
    if (e.atMs < asleepUntil) fail(`$ entry ${i}`, 'no step may run while the machine is suspended');
    if (e.lane === 'probe') { if (!connected || e.connection !== open) fail(`$ entry ${i}`, 'a probe needs its connection'); return; }
    if (e.lane === 'transport') {
      if (e.step.action === 'connect') { if (connected) fail(`$ entry ${i}`, 'one client at a time'); connected = true; open = e.connection; }
      else { if (!connected) fail(`$ entry ${i}`, 'disconnect without a connection'); connected = false; }
      return;
    }
    if (e.step.action === 'suspend') asleepUntil = e.atMs + e.step.durationMs;
    if (e.step.action === 'shutdown') ended = true;
  });
}
