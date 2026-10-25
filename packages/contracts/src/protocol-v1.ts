// Durable telemetry protocol 1.0 and 1.1 (ET-002b; minor 1, the gearbox state, is ET-050b). It is a separate major from
// the frozen v0 live protocol and from CAP0 evidence capture: each decoder rejects the others' frames. Protocol logic is
// independent of Electron, Node APIs, SDK callbacks and storage. The wire format is specified in docs/protocol/v1.md.
import {isUint64, strictJson, type Uint64} from './protocol-v0';

export type {Uint64};
/** Version 1.0: every hello, and every message of a connection that selected minor 0. */
export const PROTOCOL_V1 = {major: 1, minor: 0} as const;
/** The highest minor this contract implements. Minor 1 adds `state.gearbox` to checkpoints and snapshots (§7). */
export const V1_MAX_MINOR = 1;
export type V1Minor = 0 | 1;
export interface V1Version {major: 1; minor: V1Minor}
/**
 * Minor selection for the stateless entry points. Every entry point defaults to 0, so a caller accepts or writes a
 * minor-1 message only when it opts in; the per-connection minor is enforced by V1Consumer and AckValidator.
 */
export interface V1MinorOptions {maxMinor?: number}
/** Gearbox bounds of minor 1 (ET-050b B2). A producer marks a reading outside them `invalid`, never truncated. */
export const V1_GEARBOX = {maxGears: 100, maxSelectorCount: 6, maxSlots: 64, maxHandlePosition: 255} as const;
/** Fixed producer and transport bounds. Every welcome repeats them exactly; a mismatch is rejected. */
export const V1_LIMITS = {
  serverFrameBytes: 65_536, clientFrameBytes: 4_096, eventBytes: 16_384, retainedEntries: 256, retainedBytes: 1_048_576,
  disconnectRetentionMs: 300_000, helloTimeoutMs: 5_000, writeDeadlineMs: 1_000, snapshotIntervalMs: 50, trailerSlots: 10
} as const;
/** UTF-8 byte limits of SDK identifiers and localized display text. Longer values become `invalid`, never truncated. */
export const ID_BYTES = 128;
export const NAME_BYTES = 256;
/**
 * Retained-byte accounting of one gap record, whatever its encoded size. The retained store always reserves one entry
 * and these bytes for a trailing gap record, so a loss stays representable when the store is full (docs/protocol/v1.md §9).
 */
export const GAP_RECORD_BYTES = 1_024;
/** The last assignable eventSeq, so that `nextEventSeq` stays representable as a uint64 after it. */
export const MAX_EVENT_SEQ = '18446744073709551614';
const U32_MAX = 4_294_967_295;

export type Sender = 'server' | 'client';
export type UnavailableReason = 'not-supported' | 'not-observed' | 'invalid';
export type Available<T> = {available: true; value: T} | {available: false; reason: UnavailableReason};
export type Measure<U extends string> = Available<number> & {unit: U};
/** Game minutes: an absolute game time or a duration, distinguished by the field name. */
export type GameMinutes = Available<Uint64> & {unit: 'min'};
export interface GameTimeStamp {minutes: Available<Uint64>; clockId: string}
export interface SourceIdentity {
  game: 'ets2' | 'ats'; pluginSessionId: string; processInstanceId: string;
  processId: number; windowsSessionId: number; origin: 'game' | 'synthetic' | 'replay';
}
export interface CaptureTime {clockId: string; monotonicNs: Uint64}
export type Currency = {status: 'unknown'} | {status: 'sdk-documented'; code: string; source: string};
/** Raw SDK money as an exact decimal string; never a JSON number and never converted. */
export interface Money {raw: string; sdkType: 's64' | 'u64'; currency: Currency}
export interface GameMode {
  mode: 'single-player' | 'truckersmp' | 'unknown'; method: 'module-scan' | 'process-scan' | 'none';
  confidence: 'strong' | 'weak' | 'none'; module: Available<string>;
}
export interface JobConfiguration {
  sourceCityId: Available<string>; sourceCity: Available<string>; sourceCompanyId: Available<string>; sourceCompany: Available<string>;
  destinationCityId: Available<string>; destinationCity: Available<string>; destinationCompanyId: Available<string>; destinationCompany: Available<string>;
  cargoId: Available<string>; cargo: Available<string>; cargoMass: Measure<'kg'>; cargoUnitMass: Measure<'kg'>; cargoUnitCount: Available<number>;
  market: Available<string>; isSpecialJob: Available<boolean>; cargoLoaded: Available<boolean>;
  plannedDistance: Measure<'m'>; expectedIncome: Available<Money>; deliveryDeadline: GameMinutes;
}
export interface TruckConfiguration {
  brandId: Available<string>; brand: Available<string>; id: Available<string>; name: Available<string>; fuelCapacity: Measure<'L'>;
  licensePlate: Available<string>; plateCountryId: Available<string>; plateCountry: Available<string>;
}
export interface TrailerConfiguration {
  index: number; id: Available<string>; bodyType: Available<string>; chainType: Available<string>; cargoAccessoryId: Available<string>;
  brandId: Available<string>; brand: Available<string>; name: Available<string>; licensePlate: Available<string>;
  plateCountryId: Available<string>; plateCountry: Available<string>;
}
export interface WorldPlacement {position: {x: number; y: number; z: number}; orientation: {heading: number; pitch: number; roll: number}}
export interface WindowState {
  handle: Uint64; x: number; y: number; width: number; height: number; dpi: number;
  foreground: boolean; minimized: boolean; displayMode: 'windowed' | 'borderless' | 'exclusive' | 'unknown';
}
/** One H-shifter slot with a nonzero gear: reverse negative. `selectors` is a bit set below 2^selectorCount. */
export interface HShifterSlot {gear: number; handlePosition: number; selectors: number}
/** The latest SDK `hshifter` configuration: every slot whose gear is not neutral, in SDK slot order. */
export interface HShifterLayout {selectorCount: number; slots: HShifterSlot[]}
/** Minor 1 only (ET-050b B1, B2): the truck's gear counts and the H-shifter layout. */
export interface GearboxState {forwardGears: Available<number>; reverseGears: Available<number>; hshifter: Available<HShifterLayout>}
export interface CurrentState {
  simulation: 'running' | 'paused' | 'unavailable';
  speed: Measure<'m/s'>; fuel: Measure<'L'>; fuelCapacity: Measure<'L'>; engineRpm: Measure<'rpm'>; gear: Measure<'index'>;
  odometer: Measure<'m'>; averageConsumption: Measure<'L/100km'>; estimatedRange: Measure<'m'>; navigationDistance: Measure<'m'>;
  gameTime: Available<Uint64> & {unit: 'min'; clockId: string}; captureUtcUnixMs: Available<Uint64>;
  boundaryOrder: Uint64; worldPlacement: Available<WorldPlacement>;
  configuration: {revision: Uint64; job: Available<JobConfiguration>; truck: Available<TruckConfiguration>; trailers: Available<TrailerConfiguration>[]};
  window: Available<WindowState>;
  /** Present exactly when the message's envelope minor is 1. */
  gearbox?: GearboxState;
}
/** Cumulative counts of lost eventSeqs by cause; gap messages use the same keys for one range. */
export interface LossCounts {offline: Uint64; noDurableConsumer: Uint64; queueCount: Uint64; queueBytes: Uint64; retentionExpired: Uint64; encodingFailed: Uint64}
export interface DeliveryStatus {
  durable: boolean; ackedThroughEventSeq: Uint64; nextEventSeq: Uint64; retainedEvents: number; retainedBytes: number;
  oldestRetainedMonotonicNs: Available<Uint64>;
}
export interface SourceStatus {gameMode: GameMode; delivery: DeliveryStatus; eventLoss: LossCounts}
export interface Continuity {coalescedSnapshots: Uint64; offlineTransitions: Uint64}
export interface EventOccurrence {
  monotonicNs: Available<Uint64>; gameTime: GameTimeStamp; utcUnixMs: Available<Uint64>;
  simulation: 'running' | 'paused' | 'unavailable'; configurationRevision: Uint64; boundaryOrder: Uint64;
}
export interface Transfer {amount: Available<Money>; sourceId: Available<string>; sourceName: Available<string>; targetId: Available<string>; targetName: Available<string>}
export type EventRecord =
  ({type: 'job.configured'} & JobConfiguration) | {type: 'job.cleared'} |
  ({type: 'truck.configured'} & TruckConfiguration) | {type: 'truck.cleared'} |
  ({type: 'trailer.configured'} & TrailerConfiguration) | {type: 'trailer.cleared'; index: number} |
  {type: 'simulation.paused'} | {type: 'simulation.started'} | {type: 'timers.restart'} |
  {type: 'gameTime.regression'; from: GameTimeStamp; to: GameTimeStamp} |
  {type: 'job.delivered'; revenue: Available<Money>; earnedXp: Available<number>; cargoDamage: Measure<'fraction'>; distance: Measure<'m'>;
    deliveryDuration: GameMinutes; autoParkUsed: Available<boolean>; autoLoadUsed: Available<boolean>} |
  {type: 'job.cancelled'; penalty: Available<Money>} |
  {type: 'player.fined'; offence: Available<string>; amount: Available<Money>} |
  {type: 'player.tollgate.paid'; amount: Available<Money>} |
  ({type: 'player.use.ferry'} & Transfer) | ({type: 'player.use.train'} & Transfer) |
  ({type: 'source.gameMode'} & GameMode);
export type EventType = EventRecord['type'];
export const EVENT_TYPES: readonly EventType[] = [
  'job.configured', 'job.cleared', 'truck.configured', 'truck.cleared', 'trailer.configured', 'trailer.cleared',
  'simulation.paused', 'simulation.started', 'timers.restart', 'gameTime.regression', 'job.delivered', 'job.cancelled',
  'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train', 'source.gameMode'
];
/** Record types that come from SDK gameplay-event callbacks, absent when that registration is unsupported. */
export const GAMEPLAY_EVENT_TYPES: readonly EventType[] = ['job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train'];
export interface WelcomeData {
  /** The selected minor; it equals the welcome's envelope minor. */
  minor: V1Minor; durableEvents: boolean; limits: typeof V1_LIMITS;
  capabilities: {gameplayEvents: 'registered' | 'not-supported'; eventTypes: EventType[]};
  versions: {telemetryApi: {major: number; minor: number}; gameTelemetry: {major: number; minor: number}; sdkArchive: string};
  gameMode: GameMode;
}
export interface EventData {eventSeq: Uint64; redelivered: boolean; occurred: EventOccurrence; record: EventRecord}
export interface GapData {
  firstEventSeq: Uint64; lastEventSeq: Uint64; causes: LossCounts;
  firstLostMonotonicNs: Available<Uint64>; lastLostMonotonicNs: Available<Uint64>; redelivered: boolean;
}
export interface EndData {reason: 'plugin-shutdown' | 'sequence-exhausted' | 'source-retired'; nextEventSeq: Uint64; ackedThroughEventSeq: Uint64; retainedUnacked: Uint64}
interface ServerBase {version: V1Version; source: SourceIdentity; seq: Uint64; capture: CaptureTime}
export type ServerMessage = ServerBase & (
  {kind: 'welcome'; data: WelcomeData} |
  {kind: 'checkpoint'; data: {boundarySeq: Uint64; state: CurrentState; status: SourceStatus; continuity: Continuity}} |
  {kind: 'snapshot'; data: {state: CurrentState; status: SourceStatus; continuity: Continuity}} |
  {kind: 'event'; data: EventData} |
  {kind: 'gap'; data: GapData} |
  {kind: 'clock.reply'; data: {probeId: Uint64; receivedMonotonicNs: Uint64; sentMonotonicNs: Uint64}} |
  {kind: 'end'; data: EndData}
);
/** A hello is always version 1.0; `ack` and `clock.probe` carry the connection's selected minor. */
export type ClientMessage =
  {version: typeof PROTOCOL_V1; kind: 'hello'; data: {clientInstanceId: string; minMinor: 0; maxMinor: number; durableEvents: boolean}} |
  {version: V1Version; kind: 'ack'; data: {pluginSessionId: string; throughEventSeq: Uint64}} |
  {version: V1Version; kind: 'clock.probe'; data: {probeId: Uint64}};
export type ProtocolMessage = ServerMessage | ClientMessage;
const CLIENT_KINDS = ['hello', 'ack', 'clock.probe'];

export class ProtocolError extends Error {}
function fail(reason = 'Invalid protocol v1 message'): never { throw new ProtocolError(reason); }
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(key => !Object.hasOwn(o, key))) fail();
  return o;
}
const encoder = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
// eslint-disable-next-line no-control-regex -- C0 and DEL control characters are deliberately rejected.
const CONTROL = /[\u0000-\u001f\u007f]/u;
function text(v: unknown, maxBytes: number, allowEmpty = true): string {
  if (typeof v !== 'string' || (!allowEmpty && !v.length) || v.length > maxBytes || encoder.encode(v).length > maxBytes || CONTROL.test(v) || LONE_SURROGATE.test(v)) fail();
  return v;
}
const id = (v: unknown) => text(v, ID_BYTES);
const name = (v: unknown) => text(v, NAME_BYTES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(v: unknown): string { if (typeof v !== 'string' || !UUID.test(v)) fail(); return v; }
function u64(v: unknown, max?: bigint): bigint { if (!isUint64(v)) fail(); const n = BigInt(v); if (max !== undefined && n > max) fail(); return n; }
const eventSeq = (v: unknown) => { const n = u64(v, BigInt(MAX_EVENT_SEQ)); if (n === 0n) fail(); return n; };
function s64(v: unknown): bigint {
  if (typeof v !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(v) || v === '-0') fail();
  const n = BigInt(v); if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) fail(); return n;
}
function num(v: unknown, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail();
  return v;
}
function bool(v: unknown): boolean { if (typeof v !== 'boolean') fail(); return v; }
function choice<T extends string>(v: unknown, options: readonly T[]): T { if (typeof v !== 'string' || !options.includes(v as T)) fail(); return v as T; }
function available(v: unknown, validate: (value: unknown) => void, extra: readonly string[] = []): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
  const flag = (v as Record<string, unknown>).available;
  if (flag === true) { const o = record(v, ['available', 'value', ...extra]); validate(o.value); return o; }
  if (flag !== false) fail();
  const o = record(v, ['available', 'reason', ...extra]); choice(o.reason, ['not-supported', 'not-observed', 'invalid']); return o;
}
function measure(v: unknown, unit: string, min: number, max: number, integer = false, check?: (value: number) => boolean) {
  const o = available(v, value => { const n = num(value, min, max, integer); if (check && !check(n)) fail(); }, ['unit']);
  if (o.unit !== unit) fail();
}
function gameMinutes(v: unknown) { if (available(v, value => u64(value, BigInt(U32_MAX)), ['unit']).unit !== 'min') fail(); }
const sameAvailable = (a: Available<Uint64>, b: Available<Uint64>) => a.available ? b.available && a.value === b.value : !b.available && a.reason === b.reason;
function gameTimeStamp(v: unknown): Record<string, unknown> {
  const o = record(v, ['minutes', 'clockId']); available(o.minutes, value => u64(value, BigInt(U32_MAX))); uuid(o.clockId); return o;
}
function currency(v: unknown) {
  if (v !== null && typeof v === 'object' && (v as Record<string, unknown>).status === 'unknown') { record(v, ['status']); return; }
  const o = record(v, ['status', 'code', 'source']);
  if (o.status !== 'sdk-documented' || typeof o.code !== 'string' || !/^[A-Z]{3}$/.test(o.code)) fail();
  text(o.source, ID_BYTES, false);
}
function money(v: unknown, sdkType: 's64' | 'u64') {
  available(v, value => {
    const o = record(value, ['raw', 'sdkType', 'currency']);
    if (o.sdkType !== sdkType) fail();
    if (sdkType === 's64') s64(o.raw); else u64(o.raw);
    currency(o.currency);
  });
}
const ids = (o: Record<string, unknown>, keys: readonly string[]) => keys.forEach(key => available(o[key], id));
const names = (o: Record<string, unknown>, keys: readonly string[]) => keys.forEach(key => available(o[key], name));
const JOB_KEYS = ['sourceCityId', 'sourceCity', 'sourceCompanyId', 'sourceCompany', 'destinationCityId', 'destinationCity', 'destinationCompanyId', 'destinationCompany',
  'cargoId', 'cargo', 'cargoMass', 'cargoUnitMass', 'cargoUnitCount', 'market', 'isSpecialJob', 'cargoLoaded', 'plannedDistance', 'expectedIncome', 'deliveryDeadline'];
const TRUCK_KEYS = ['brandId', 'brand', 'id', 'name', 'fuelCapacity', 'licensePlate', 'plateCountryId', 'plateCountry'];
const TRAILER_KEYS = ['index', 'id', 'bodyType', 'chainType', 'cargoAccessoryId', 'brandId', 'brand', 'name', 'licensePlate', 'plateCountryId', 'plateCountry'];
const TRANSFER_KEYS = ['amount', 'sourceId', 'sourceName', 'targetId', 'targetName'];
function job(o: Record<string, unknown>) {
  ids(o, ['sourceCityId', 'sourceCompanyId', 'destinationCityId', 'destinationCompanyId', 'cargoId', 'market']);
  names(o, ['sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany', 'cargo']);
  measure(o.cargoMass, 'kg', 0, 1e9); measure(o.cargoUnitMass, 'kg', 0, 1e9); available(o.cargoUnitCount, value => num(value, 0, U32_MAX, true));
  available(o.isSpecialJob, bool); available(o.cargoLoaded, bool);
  // SDK planned_distance.km is a u32 of whole kilometres, so its exact metre value is a multiple of 1,000.
  measure(o.plannedDistance, 'm', 0, U32_MAX * 1_000, true, value => value % 1_000 === 0);
  money(o.expectedIncome, 'u64'); gameMinutes(o.deliveryDeadline);
}
function truck(o: Record<string, unknown>) {
  ids(o, ['brandId', 'id', 'plateCountryId']); names(o, ['brand', 'name', 'licensePlate', 'plateCountry']); measure(o.fuelCapacity, 'L', 0, 1_000_000);
}
function trailer(o: Record<string, unknown>): number {
  ids(o, ['id', 'bodyType', 'chainType', 'cargoAccessoryId', 'brandId', 'plateCountryId']); names(o, ['brand', 'name', 'licensePlate', 'plateCountry']);
  return num(o.index, 0, V1_LIMITS.trailerSlots - 1, true);
}
function gameMode(o: Record<string, unknown>) {
  const mode = choice(o.mode, ['single-player', 'truckersmp', 'unknown']), method = choice(o.method, ['module-scan', 'process-scan', 'none']);
  const confidence = choice(o.confidence, ['strong', 'weak', 'none']), module = available(o.module, value => text(value, ID_BYTES, false));
  // Unknown pairs only with none; a missing module is weak evidence, so single-player is never strong.
  if ((mode === 'unknown') !== (method === 'none') || (mode === 'unknown') !== (confidence === 'none')) fail();
  if (mode === 'single-player' && confidence === 'strong') fail();
  if (mode === 'truckersmp' && method === 'module-scan' && module.available !== true) fail();
  // Only a module scan can name a module.
  if (method !== 'module-scan' && module.available === true) fail();
}
const GAME_MODE_KEYS = ['mode', 'method', 'confidence', 'module'];
const LOSS_KEYS = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed'];
function lossCounts(v: unknown): bigint { const o = record(v, LOSS_KEYS); return LOSS_KEYS.reduce((sum, key) => sum + u64(o[key]), 0n); }
function windowState(v: unknown) {
  const w = record(v, ['handle', 'x', 'y', 'width', 'height', 'dpi', 'foreground', 'minimized', 'displayMode']);
  if (u64(w.handle) === 0n) fail(); num(w.x, -1e6, 1e6, true); num(w.y, -1e6, 1e6, true);
  num(w.width, 0, 100_000, true); num(w.height, 0, 100_000, true); num(w.dpi, 1, 1_000, true);
  bool(w.foreground); bool(w.minimized); choice(w.displayMode, ['windowed', 'borderless', 'exclusive', 'unknown']);
}
const STATE_KEYS = ['simulation', 'speed', 'fuel', 'fuelCapacity', 'engineRpm', 'gear', 'odometer', 'averageConsumption', 'estimatedRange',
  'navigationDistance', 'gameTime', 'captureUtcUnixMs', 'boundaryOrder', 'worldPlacement', 'configuration', 'window'];
const gearCount = (value: unknown) => num(value, 0, V1_GEARBOX.maxGears, true);
function gearbox(v: unknown) {
  const g = record(v, ['forwardGears', 'reverseGears', 'hshifter']);
  available(g.forwardGears, gearCount); available(g.reverseGears, gearCount);
  available(g.hshifter, value => {
    const h = record(value, ['selectorCount', 'slots']), count = num(h.selectorCount, 0, V1_GEARBOX.maxSelectorCount, true);
    if (!Array.isArray(h.slots) || h.slots.length > V1_GEARBOX.maxSlots) fail();
    const pairs = new Set<number>();
    for (const slot of h.slots) {
      const s = record(slot, ['gear', 'handlePosition', 'selectors']);
      // Neutral slots are omitted, so a slot gear is never 0.
      if (num(s.gear, -V1_GEARBOX.maxGears, V1_GEARBOX.maxGears, true) === 0) fail();
      const pair = num(s.handlePosition, 0, V1_GEARBOX.maxHandlePosition, true) * 2 ** V1_GEARBOX.maxSelectorCount + num(s.selectors, 0, 2 ** count - 1, true);
      // Each (handlePosition, selectors) pair selects exactly one slot.
      if (pairs.has(pair)) fail();
      pairs.add(pair);
    }
  });
}
/** The minor-0 state, plus `gearbox` exactly when the envelope minor is 1. */
function state(v: unknown, minor: V1Minor) {
  const o = record(v, minor === 0 ? STATE_KEYS : [...STATE_KEYS, 'gearbox']);
  choice(o.simulation, ['running', 'paused', 'unavailable']);
  measure(o.speed, 'm/s', -1_000, 1_000); measure(o.fuel, 'L', 0, 1_000_000); measure(o.fuelCapacity, 'L', 0, 1_000_000);
  measure(o.engineRpm, 'rpm', 0, 100_000); measure(o.gear, 'index', -100, 100, true); measure(o.odometer, 'm', 0, 1e12);
  measure(o.averageConsumption, 'L/100km', 0, 1_000_000); measure(o.estimatedRange, 'm', 0, 1e12); measure(o.navigationDistance, 'm', 0, 1e12);
  const gt = available(o.gameTime, value => u64(value, BigInt(U32_MAX)), ['unit', 'clockId']); if (gt.unit !== 'min') fail(); uuid(gt.clockId);
  available(o.captureUtcUnixMs, u64); u64(o.boundaryOrder);
  available(o.worldPlacement, value => {
    const p = record(value, ['position', 'orientation']), position = record(p.position, ['x', 'y', 'z']), orientation = record(p.orientation, ['heading', 'pitch', 'roll']);
    for (const axis of ['x', 'y', 'z']) num(position[axis], -1e9, 1e9);
    for (const angle of ['heading', 'pitch', 'roll']) num(orientation[angle], -1, 1);
  });
  const c = record(o.configuration, ['revision', 'job', 'truck', 'trailers']); u64(c.revision);
  available(c.job, value => job(record(value, JOB_KEYS))); available(c.truck, value => truck(record(value, TRUCK_KEYS)));
  if (!Array.isArray(c.trailers) || c.trailers.length > V1_LIMITS.trailerSlots) fail();
  c.trailers.forEach((slot, index) => available(slot, value => { if (trailer(record(value, TRAILER_KEYS)) !== index) fail(); }));
  available(o.window, windowState);
  if (minor === 1) gearbox(o.gearbox);
}
function status(v: unknown, captureNs: bigint) {
  const o = record(v, ['gameMode', 'delivery', 'eventLoss']); gameMode(record(o.gameMode, GAME_MODE_KEYS)); lossCounts(o.eventLoss);
  const d = record(o.delivery, ['durable', 'ackedThroughEventSeq', 'nextEventSeq', 'retainedEvents', 'retainedBytes', 'oldestRetainedMonotonicNs']);
  bool(d.durable); const acked = u64(d.ackedThroughEventSeq), next = u64(d.nextEventSeq);
  const entries = num(d.retainedEvents, 0, V1_LIMITS.retainedEntries, true), bytes = num(d.retainedBytes, 0, V1_LIMITS.retainedBytes, true);
  // Each retained entry (event or gap record) covers at least one unacknowledged eventSeq.
  if (next === 0n || acked >= next || BigInt(entries) > next - 1n - acked || (entries === 0) !== (bytes === 0)) fail();
  // Events never take the reserved last entry, so a full store holds at least one gap record.
  if (entries === V1_LIMITS.retainedEntries && bytes < GAP_RECORD_BYTES) fail();
  const oldest = available(d.oldestRetainedMonotonicNs, value => { if (u64(value) > captureNs) fail(); });
  if ((oldest.available === true) !== (entries > 0)) fail();
}
function occurrence(v: unknown, captureNs: bigint): Record<string, unknown> {
  const o = record(v, ['monotonicNs', 'gameTime', 'utcUnixMs', 'simulation', 'configurationRevision', 'boundaryOrder']);
  available(o.monotonicNs, value => { if (u64(value) > captureNs) fail(); });
  gameTimeStamp(o.gameTime); available(o.utcUnixMs, u64); choice(o.simulation, ['running', 'paused', 'unavailable']);
  u64(o.configurationRevision); u64(o.boundaryOrder);
  return o;
}
const RECORD_KEYS: Record<EventType, readonly string[]> = {
  'job.configured': JOB_KEYS, 'job.cleared': [], 'truck.configured': TRUCK_KEYS, 'truck.cleared': [], 'trailer.configured': TRAILER_KEYS, 'trailer.cleared': ['index'],
  'simulation.paused': [], 'simulation.started': [], 'timers.restart': [], 'gameTime.regression': ['from', 'to'],
  'job.delivered': ['revenue', 'earnedXp', 'cargoDamage', 'distance', 'deliveryDuration', 'autoParkUsed', 'autoLoadUsed'],
  'job.cancelled': ['penalty'], 'player.fined': ['offence', 'amount'], 'player.tollgate.paid': ['amount'],
  'player.use.ferry': TRANSFER_KEYS, 'player.use.train': TRANSFER_KEYS, 'source.gameMode': GAME_MODE_KEYS
};
function eventRecord(v: unknown, occurred: Record<string, unknown>) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
  // Unknown types, including the deferred bus and car jobs (TD-002), are rejected rather than ignored.
  const type = choice((v as Record<string, unknown>).type, EVENT_TYPES), o = record(v, ['type', ...RECORD_KEYS[type]]);
  switch (type) {
    case 'job.configured': job(o); break;
    case 'truck.configured': truck(o); break;
    case 'trailer.configured': trailer(o); break;
    case 'trailer.cleared': num(o.index, 0, V1_LIMITS.trailerSlots - 1, true); break;
    case 'gameTime.regression': {
      const from = gameTimeStamp(o.from), to = gameTimeStamp(o.to), fromMinutes = from.minutes as Available<Uint64>, toMinutes = to.minutes as Available<Uint64>;
      const now = occurred.gameTime as GameTimeStamp;
      // Only the regression event carries the new game time and clock, so it occurs at `to`.
      if (from.clockId === to.clockId || now.clockId !== to.clockId || !sameAvailable(now.minutes, toMinutes)) fail();
      if (fromMinutes.available && toMinutes.available && BigInt(toMinutes.value) >= BigInt(fromMinutes.value)) fail();
      break;
    }
    case 'job.delivered':
      money(o.revenue, 's64'); available(o.earnedXp, value => num(value, -2_147_483_648, 2_147_483_647, true));
      measure(o.cargoDamage, 'fraction', 0, 1_000); measure(o.distance, 'm', 0, 1e12); gameMinutes(o.deliveryDuration);
      available(o.autoParkUsed, bool); available(o.autoLoadUsed, bool); break;
    case 'job.cancelled': money(o.penalty, 's64'); break;
    case 'player.fined': available(o.offence, id); money(o.amount, 's64'); break;
    case 'player.tollgate.paid': money(o.amount, 's64'); break;
    case 'player.use.ferry': case 'player.use.train': money(o.amount, 's64'); ids(o, ['sourceId', 'targetId']); names(o, ['sourceName', 'targetName']); break;
    case 'source.gameMode': gameMode(o); break;
    default: break;
  }
}
function welcome(v: unknown, minor: V1Minor) {
  const d = record(v, ['minor', 'durableEvents', 'limits', 'capabilities', 'versions', 'gameMode']);
  // The welcome is the first message at the selected minor, so its envelope minor equals the minor it announces.
  if (d.minor !== minor) fail(); bool(d.durableEvents);
  const limits = record(d.limits, Object.keys(V1_LIMITS));
  for (const [key, value] of Object.entries(V1_LIMITS)) if (limits[key] !== value) fail('Unsupported protocol v1 limits');
  const c = record(d.capabilities, ['gameplayEvents', 'eventTypes']), gameplay = choice(c.gameplayEvents, ['registered', 'not-supported']);
  if (!Array.isArray(c.eventTypes) || c.eventTypes.length > EVENT_TYPES.length) fail();
  const seen = new Set<EventType>();
  for (const type of c.eventTypes) { const t = choice(type, EVENT_TYPES); if (seen.has(t) || (gameplay === 'not-supported' && GAMEPLAY_EVENT_TYPES.includes(t))) fail(); seen.add(t); }
  const versions = record(d.versions, ['telemetryApi', 'gameTelemetry', 'sdkArchive']);
  for (const version of [versions.telemetryApi, versions.gameTelemetry]) { const o = record(version, ['major', 'minor']); num(o.major, 0, 65_535, true); num(o.minor, 0, 65_535, true); }
  text(versions.sdkArchive, ID_BYTES, false); gameMode(record(d.gameMode, GAME_MODE_KEYS));
}
function source(v: unknown) {
  const s = record(v, ['game', 'pluginSessionId', 'processInstanceId', 'processId', 'windowsSessionId', 'origin']);
  choice(s.game, ['ets2', 'ats']); uuid(s.pluginSessionId); uuid(s.processInstanceId);
  num(s.processId, 1, U32_MAX, true); num(s.windowsSessionId, 0, U32_MAX, true); choice(s.origin, ['game', 'synthetic', 'replay']);
}
/** The caller's highest accepted minor; a value this contract does not implement is a caller error. */
function maxMinorOf(options: V1MinorOptions): V1Minor {
  const max = options.maxMinor ?? 0;
  if (max !== 0 && max !== 1) fail('Unsupported maximum protocol v1 minor');
  return max;
}
function version(v: unknown, maxMinor: V1Minor): V1Minor {
  const ver = record(v, ['major', 'minor']);
  if (ver.major !== PROTOCOL_V1.major || (ver.minor !== 0 && !(ver.minor === 1 && maxMinor === 1))) fail('Unsupported protocol version');
  return ver.minor;
}
/**
 * Strict validation of one server-to-client message: exact keys, bounds, units and exact integer strings. The envelope
 * minor selects the state schema; minors above `maxMinor` (default 0) are rejected.
 */
export function validateServerMessage(v: unknown, options: V1MinorOptions = {}): ServerMessage {
  const o = record(v, ['version', 'kind', 'source', 'seq', 'capture', 'data']); const minor = version(o.version, maxMinorOf(options));
  source(o.source); u64(o.seq); const cap = record(o.capture, ['clockId', 'monotonicNs']); uuid(cap.clockId); const captureNs = u64(cap.monotonicNs);
  switch (choice(o.kind, ['welcome', 'checkpoint', 'snapshot', 'event', 'gap', 'clock.reply', 'end'])) {
    case 'welcome': welcome(o.data, minor); break;
    case 'checkpoint': case 'snapshot': {
      const d = record(o.data, o.kind === 'checkpoint' ? ['boundarySeq', 'state', 'status', 'continuity'] : ['state', 'status', 'continuity']);
      if (o.kind === 'checkpoint' && d.boundarySeq !== o.seq) fail();
      state(d.state, minor); status(d.status, captureNs); const c = record(d.continuity, ['coalescedSnapshots', 'offlineTransitions']); u64(c.coalescedSnapshots); u64(c.offlineTransitions);
      break;
    }
    case 'event': {
      const d = record(o.data, ['eventSeq', 'redelivered', 'occurred', 'record']); eventSeq(d.eventSeq); bool(d.redelivered);
      eventRecord(d.record, occurrence(d.occurred, captureNs)); break;
    }
    case 'gap': {
      const d = record(o.data, ['firstEventSeq', 'lastEventSeq', 'causes', 'firstLostMonotonicNs', 'lastLostMonotonicNs', 'redelivered']);
      const first = eventSeq(d.firstEventSeq), last = eventSeq(d.lastEventSeq);
      if (last < first || lossCounts(d.causes) !== last - first + 1n) fail();
      let firstLost: bigint | undefined;
      available(d.firstLostMonotonicNs, value => { firstLost = u64(value); if (firstLost > captureNs) fail(); });
      available(d.lastLostMonotonicNs, value => { const lastLost = u64(value); if (lastLost > captureNs || (firstLost !== undefined && lastLost < firstLost)) fail(); });
      bool(d.redelivered); break;
    }
    case 'clock.reply': {
      const d = record(o.data, ['probeId', 'receivedMonotonicNs', 'sentMonotonicNs']);
      if (u64(d.probeId) === 0n) fail(); const received = u64(d.receivedMonotonicNs), sent = u64(d.sentMonotonicNs);
      if (received > sent || sent > captureNs) fail(); break;
    }
    case 'end': {
      const d = record(o.data, ['reason', 'nextEventSeq', 'ackedThroughEventSeq', 'retainedUnacked']);
      choice(d.reason, ['plugin-shutdown', 'sequence-exhausted', 'source-retired']);
      const next = u64(d.nextEventSeq), acked = u64(d.ackedThroughEventSeq);
      if (next === 0n || acked >= next || u64(d.retainedUnacked) > next - 1n - acked) fail(); break;
    }
  }
  return v as ServerMessage;
}
/** v1 current state without the game window, as the live display receives it (ET-010c). The gearbox is not projected yet. */
export type LiveStateV1 = Omit<CurrentState, 'window' | 'gearbox'>;
/**
 * The whitelisted v1 observation the telemetry service projects for live display (ET-010c, decision F2). It is not a
 * wire message: it omits the game window and its handle, the message kind, the delivery cursor, continuity, the clock
 * mapping and durable status, and keeps only the game mode and event loss of the source status.
 */
export interface LiveObservationV1 {
  source: SourceIdentity; seq: Uint64; capture: CaptureTime; state: LiveStateV1;
  sourceStatus: {gameMode: GameMode; eventLoss: LossCounts};
  /** Service receive time in milliseconds; it advances only with a new SDK boundary. */
  receivedMonotonicMs: number;
  /** True for a connection's hydrating checkpoint: current state only, never a gameplay effect. */
  hydration: boolean;
}
const NOT_OBSERVED_WINDOW = Object.freeze({available: false, reason: 'not-observed'});
/**
 * Strict validation of a live v1 observation with the same rules as the wire state. A state that still carries a
 * window, or any key outside the whitelist, is rejected.
 */
export function validateLiveObservationV1(v: unknown): LiveObservationV1 {
  const o = record(v, ['source', 'seq', 'capture', 'state', 'sourceStatus', 'receivedMonotonicMs', 'hydration']);
  source(o.source); u64(o.seq); const cap = record(o.capture, ['clockId', 'monotonicNs']); uuid(cap.clockId); u64(cap.monotonicNs);
  const s = o.state;
  if (s === null || typeof s !== 'object' || Array.isArray(s) || Object.hasOwn(s, 'window')) fail();
  // The wire state validator with a not-observed placeholder in place of the omitted window.
  state({...(s as Record<string, unknown>), window: NOT_OBSERVED_WINDOW}, 0);
  const status = record(o.sourceStatus, ['gameMode', 'eventLoss']); gameMode(record(status.gameMode, GAME_MODE_KEYS)); lossCounts(status.eventLoss);
  num(o.receivedMonotonicMs, 0, Number.MAX_VALUE); bool(o.hydration);
  return v as LiveObservationV1;
}
/** Strict validation of one client-to-server message. A hello is always version 1.0; minors above `maxMinor` (default 0) are rejected. */
export function validateClientMessage(v: unknown, options: V1MinorOptions = {}): ClientMessage {
  const o = record(v, ['version', 'kind', 'data']); const minor = version(o.version, maxMinorOf(options));
  switch (choice(o.kind, CLIENT_KINDS)) {
    case 'hello': {
      if (minor !== 0) fail('Unsupported protocol version');
      const d = record(o.data, ['clientInstanceId', 'minMinor', 'maxMinor', 'durableEvents']);
      uuid(d.clientInstanceId); if (d.minMinor !== 0) fail(); num(d.maxMinor, 0, 65_535, true); bool(d.durableEvents); break;
    }
    case 'ack': { const d = record(o.data, ['pluginSessionId', 'throughEventSeq']); uuid(d.pluginSessionId); u64(d.throughEventSeq); break; }
    case 'clock.probe': { const d = record(o.data, ['probeId']); if (u64(d.probeId) === 0n) fail(); break; }
  }
  return v as ClientMessage;
}
export function validateMessage(v: unknown, sender: Sender, options: V1MinorOptions = {}): ProtocolMessage {
  return sender === 'server' ? validateServerMessage(v, options) : validateClientMessage(v, options);
}
const maxPayload = (sender: Sender) => sender === 'server' ? V1_LIMITS.serverFrameBytes : V1_LIMITS.clientFrameBytes;
const fatal = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
/** Decodes one payload from the given sender. Size, UTF-8, strict JSON, schema and the event size bound all apply. */
export function decodePayload(bytes: Uint8Array, sender: Sender, options: V1MinorOptions = {}): ProtocolMessage {
  if (!bytes.length || bytes.length > maxPayload(sender)) fail('Protocol v1 payload size rejected');
  let parsed: unknown;
  // strictJson rejects duplicate keys, malformed numbers, lone surrogates, trailing data and depth above 16.
  try { parsed = strictJson(fatal.decode(bytes)); } catch { fail('Malformed protocol v1 JSON'); }
  const message = validateMessage(parsed, sender, options);
  if (message.kind === 'event' && bytes.length > V1_LIMITS.eventBytes) fail('Protocol v1 event size rejected');
  return message;
}
/** Validates first, then encodes and enforces the sender's payload bound and the event bound. Minors above `maxMinor` (default 0) are refused. */
export function encodeFrame(message: ProtocolMessage, options: V1MinorOptions = {}): Uint8Array {
  const sender: Sender = CLIENT_KINDS.includes((message as {kind?: unknown}).kind as string) ? 'client' : 'server';
  validateMessage(message, sender, options); const bytes = encoder.encode(JSON.stringify(message));
  // Validate serialized bytes as well: this catches invalid string scalars and the size limits.
  decodePayload(bytes, sender, options); const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, true); frame.set(bytes, 4); return frame;
}
/** Length-prefixed v1 framing for one direction. Fails closed; never rescans for a later prefix after an error. */
export class FrameDecoder {
  private header = new Uint8Array(4); private headerUsed = 0;
  private payload: Uint8Array | undefined; private payloadUsed = 0; private failed = false; private pushing = false;
  private readonly options: V1MinorOptions;
  /** `sender` is the peer whose frames this decoder reads: `server` on the client, `client` on the server. */
  constructor(private readonly sender: Sender, options: V1MinorOptions = {}) { this.options = {maxMinor: maxMinorOf(options)}; }
  // Emit immediately; the decoder never accumulates an unbounded result list for a large chunk.
  push(chunk: Uint8Array, emit: (message: ProtocolMessage) => void): void {
    if (this.failed) fail('Decoder is closed');
    if (this.pushing) { this.failed = true; this.payload = undefined; fail('Recursive decoding is unsupported'); }
    this.pushing = true;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.payload) {
          const n = Math.min(4 - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + n), this.headerUsed); this.headerUsed += n; offset += n;
          if (this.headerUsed !== 4) continue;
          const length = new DataView(this.header.buffer).getUint32(0, true);
          if (length === 0 || length > maxPayload(this.sender)) fail('Protocol v1 payload size rejected');
          this.payload = new Uint8Array(length); this.payloadUsed = 0;
        }
        const n = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
        this.payload.set(chunk.subarray(offset, offset + n), this.payloadUsed); this.payloadUsed += n; offset += n;
        if (this.payloadUsed === this.payload.length) {
          const message = decodePayload(this.payload, this.sender, this.options); this.payload = undefined; this.headerUsed = 0; emit(message);
          if (this.failed) return;
        }
      }
    } catch (error) { this.failed = true; this.payload = undefined; throw error; }
    finally { this.pushing = false; }
  }
  end(): void {
    const truncated = this.failed || this.headerUsed !== 0 || !!this.payload; this.failed = true; this.payload = undefined;
    if (truncated) fail('Truncated or failed stream');
  }
}

/**
 * Server-side hello negotiation. The server selects min(hello `maxMinor`, its own `maxMinor`), which defaults to 0;
 * the welcome and every later message in both directions then carry that minor. Durable delivery never exceeds the
 * client's request.
 */
export function negotiateV1(input: unknown, options: {allowDurable: boolean; maxMinor?: number} = {allowDurable: true}): {version: V1Version; minor: V1Minor; durableEvents: boolean} {
  const own = maxMinorOf(options), hello = validateClientMessage(input); if (hello.kind !== 'hello') fail();
  const minor: V1Minor = hello.data.maxMinor < own ? 0 : own;
  return {version: {major: 1, minor}, minor, durableEvents: hello.data.durableEvents && options.allowDurable};
}

// SDK-independent normalization helpers. The SDK adapter (ET-004b) decides availability before calling them.
/** Exact metres from a u32 kilometre count, such as job `planned_distance.km`. */
export function kmToMetersU32(km: Available<number>): Measure<'m'> {
  if (!km.available) return {available: false, reason: km.reason, unit: 'm'};
  if (!Number.isInteger(km.value) || km.value < 0 || km.value > U32_MAX) return {available: false, reason: 'invalid', unit: 'm'};
  return {available: true, value: km.value * 1_000, unit: 'm'};
}
/** Metres from an SDK float kilometre value, such as `distance.km`; non-finite or out-of-range input is invalid. */
export function kmToMetersFloat(km: Available<number>): Measure<'m'> {
  if (!km.available) return {available: false, reason: km.reason, unit: 'm'};
  const value = km.value * 1_000;
  if (!Number.isFinite(value) || value < 0 || value > 1e12) return {available: false, reason: 'invalid', unit: 'm'};
  return {available: true, value, unit: 'm'};
}
/** An SDK fraction, such as cargo damage; values outside the defensive 0-1,000 range are invalid. */
export function fraction(input: Available<number>): Measure<'fraction'> {
  if (!input.available) return {available: false, reason: input.reason, unit: 'fraction'};
  if (!Number.isFinite(input.value) || input.value < 0 || input.value > 1_000) return {available: false, reason: 'invalid', unit: 'fraction'};
  return {available: true, value: input.value, unit: 'fraction'};
}
/** Exact raw money from an SDK integer. Out-of-range or non-canonical input is invalid, never rounded. */
export function sdkMoney(raw: string | bigint, sdkType: 's64' | 'u64', currencyValue: Currency): Available<Money> {
  const textValue = typeof raw === 'bigint' ? raw.toString() : raw;
  try { if (sdkType === 's64') s64(textValue); else u64(textValue); currency(currencyValue); } catch { return {available: false, reason: 'invalid'}; }
  return {available: true, value: {raw: textValue, sdkType, currency: currencyValue}};
}
/** SDK text: not sent is `not-observed`, a provided empty string stays available, and a rule violation is invalid. */
export function sdkText(value: string | undefined, kind: 'id' | 'name'): Available<string> {
  if (value === undefined) return {available: false, reason: 'not-observed'};
  try { text(value, kind === 'id' ? ID_BYTES : NAME_BYTES); } catch { return {available: false, reason: 'invalid'}; }
  return {available: true, value};
}
