// Protocol v1 SDK adapter model (ET-005b). It turns the SDK-callback vocabulary of a scenario into v1 records, current
// state and occurrences, mirroring the native ET-004b adapter ("Records from the callbacks" and "Callback capture" in
// docs/native-transport-v1.md) and the §6 mapping of docs/protocol/v1.md. It calls no SDK and performs no I/O.
import {createHash} from 'node:crypto';
import {
  EVENT_TYPES, GAMEPLAY_EVENT_TYPES, fraction, kmToMetersFloat, kmToMetersU32, sdkMoney, sdkText,
  type Available, type CurrentState, type Currency, type EventOccurrence, type EventRecord, type EventType, type GameMode,
  type GameTimeStamp, type JobConfiguration, type Measure, type TrailerConfiguration, type TruckConfiguration, type UnavailableReason
} from '../../../../packages/contracts/src/protocol-v1';
import {MAX_SEQ} from './store';
import type {CaptureStep} from './cap0-schema';

/** Deterministic UUID-shaped identity from the scenario seed (namespace `simulator-v1`). */
export function seededId(seed: string, label: string): string {
  const h = createHash('sha256').update(`simulator-v1:${seed}:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Scenario clocks. The source monotonic clock (the plugin's QPC) starts at 1,000,000,000,000 ns and stops during a
 * suspend that does not advance it; UTC labels start at 1,800,000,000,000 ms and move with UTC jumps. Game time comes
 * only from scenario frames.
 */
export class ScenarioClock {
  static readonly SOURCE_BASE_NS = 1_000_000_000_000n;
  static readonly UTC_BASE_MS = 1_800_000_000_000n;
  private stoppedMs = 0; private utcShiftMs = 0n;
  /** Scenario time before which a suspended machine cannot run anything. */
  awakeFromMs = 0;
  sourceNs(atMs: number): bigint { return ScenarioClock.SOURCE_BASE_NS + BigInt(atMs - this.stoppedMs) * 1_000_000n; }
  utcMs(atMs: number): bigint { return ScenarioClock.UTC_BASE_MS + BigInt(atMs) + this.utcShiftMs; }
  /** Earliest scenario time at which the source clock reaches `ns`, under the current mapping. */
  atMsFor(ns: bigint): number {
    const ms = (ns - ScenarioClock.SOURCE_BASE_NS + 999_999n) / 1_000_000n;
    return Math.max(Number(ms) + this.stoppedMs, this.awakeFromMs);
  }
  utcJump(deltaMs: number): void {
    if (ScenarioClock.UTC_BASE_MS + this.utcShiftMs + BigInt(deltaMs) < 0n) throw new Error('UTC label below zero');
    this.utcShiftMs += BigInt(deltaMs);
  }
  /** A system suspend from `atMs`; QPC may or may not advance across it (CD-12). */
  suspend(atMs: number, durationMs: number, sourceClockAdvances: boolean): void {
    if (!sourceClockAdvances) this.stoppedMs += durationMs;
    this.awakeFromMs = atMs + durationMs;
  }
}

export type SdkType = 'string' | 'bool' | 's32' | 'u32' | 's64' | 'u64' | 'float' | 'double';
/** One SDK named value. A string value of null models a null string pointer. */
export interface SdkAttribute {name: string; sdkType: SdkType; value: string | number | boolean | null; unavailable?: UnavailableReason; indexed?: boolean}
/** `terminated` is a normal list; `null` a null attribute pointer; `unterminated` a list cut at the scan bound. */
export type AttributeList = 'terminated' | 'null' | 'unterminated';
export interface Placement {x: number; y: number; z: number; heading: number; pitch: number; roll: number}
/** A channel callback value: a number in SDK units, null for a callback without a value, or a wrong-typed value. */
export type ChannelValue = number | null | 'invalid';
/** The registered channels in the native registration order, which is also the callback order within a frame. */
export const CHANNELS = ['speed', 'fuel.amount', 'engine.rpm', 'displayed.gear', 'odometer', 'fuel.consumption.average', 'fuel.range', 'game.time', 'navigation.distance', 'world.placement'] as const;
export type ChannelName = typeof CHANNELS[number];
export type FrameChannels = Partial<Record<Exclude<ChannelName, 'world.placement'>, ChannelValue>> & {'world.placement'?: Placement | null | 'invalid'};
export interface SourceConfig {
  game: 'ets2' | 'ats'; seed: string; gameplayEvents: 'registered' | 'not-supported'; currency: 'unknown' | 'sdk-documented';
  /** `unknown` is OD-3: no detection and no `source.gameMode` type. `synthetic-detection` enables gameMode steps (D9). */
  gameMode: 'unknown' | 'synthetic-detection';
  versions: {telemetryApi: {major: number; minor: number}; gameTelemetry: {major: number; minor: number}; sdkArchive: string};
  startEventSeq: bigint;
}
/** A record observed in an SDK callback, in wire shape, with its occurrence. */
export interface Observed {occurred: EventOccurrence; record: EventRecord}

type Reading = Available<number>;
const notObserved = {available: false, reason: 'not-observed'} as const;
const invalid = {available: false, reason: 'invalid'} as const;
const unavailable = (reason: UnavailableReason) => ({available: false as const, reason});
function withUnit<U extends string>(a: Available<number>, unit: U): Measure<U> { return a.available ? {available: true, value: a.value, unit} : {available: false, reason: a.reason, unit}; }
/** §6: scale an SDK float reading, marking non-finite or out-of-range results invalid. */
function scaled<U extends string>(r: Reading, scale: number, min: number, max: number, unit: U): Measure<U> {
  if (!r.available) return withUnit(r, unit);
  const v = r.value * scale;
  return Number.isFinite(v) && v >= min && v <= max ? {available: true, value: v, unit} : {available: false, reason: 'invalid', unit};
}

const CURRENCY_SOURCE = {
  ets2: {code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'},
  ats: {code: 'USD', source: 'scs-sdk-1.15/include/amtrucks/scssdk_telemetry_ats.h#game-specific-units'}
} as const;
const UNKNOWN_MODE: GameMode = {mode: 'unknown', method: 'none', confidence: 'none', module: notObserved};
const JOB_TEXT: Record<string, [keyof JobConfiguration, 'id' | 'name']> = {
  'source.city.id': ['sourceCityId', 'id'], 'source.city': ['sourceCity', 'name'], 'source.company.id': ['sourceCompanyId', 'id'], 'source.company': ['sourceCompany', 'name'],
  'destination.city.id': ['destinationCityId', 'id'], 'destination.city': ['destinationCity', 'name'], 'destination.company.id': ['destinationCompanyId', 'id'],
  'destination.company': ['destinationCompany', 'name'], 'cargo.id': ['cargoId', 'id'], 'cargo': ['cargo', 'name'], 'job.market': ['market', 'id']
};
const TRUCK_TEXT: Record<string, [keyof TruckConfiguration, 'id' | 'name']> = {
  'brand_id': ['brandId', 'id'], 'brand': ['brand', 'name'], 'id': ['id', 'id'], 'name': ['name', 'name'], 'license.plate': ['licensePlate', 'name'],
  'license.plate.country.id': ['plateCountryId', 'id'], 'license.plate.country': ['plateCountry', 'name']
};
const TRAILER_TEXT: Record<string, [keyof TrailerConfiguration, 'id' | 'name']> = {
  'id': ['id', 'id'], 'body.type': ['bodyType', 'id'], 'chain.type': ['chainType', 'id'], 'cargo.accessory.id': ['cargoAccessoryId', 'id'], 'brand_id': ['brandId', 'id'],
  'brand': ['brand', 'name'], 'name': ['name', 'name'], 'license.plate': ['licensePlate', 'name'], 'license.plate.country.id': ['plateCountryId', 'id'],
  'license.plate.country': ['plateCountry', 'name']
};

/**
 * Reads one attribute list the way the native scan does: later duplicates win, wrong-typed values are invalid and,
 * after a null or unterminated list, every field that was not seen is invalid because it may have been sent.
 */
class Attributes {
  private seen = new Map<string, SdkAttribute>();
  constructor(attributes: readonly SdkAttribute[], private readonly list: AttributeList) { for (const a of attributes) if (!a.indexed) this.seen.set(a.name, a); }
  private missing(): Available<never> { return this.list === 'terminated' ? notObserved : invalid; }
  text(name: string, kind: 'id' | 'name'): Available<string> {
    const a = this.seen.get(name); if (!a) return this.missing();
    if (a.unavailable) return unavailable(a.unavailable);
    return a.sdkType === 'string' && typeof a.value === 'string' ? sdkText(a.value, kind) : invalid;
  }
  number(name: string, type: 'u32' | 's32'): Available<number> {
    const a = this.seen.get(name); if (!a) return this.missing();
    if (a.unavailable) return unavailable(a.unavailable);
    return a.sdkType === type && typeof a.value === 'number' ? {available: true, value: a.value} : invalid;
  }
  /** SDK floats are 32-bit; scenario values are float32-exact, so the copy is exact. */
  float(name: string): Reading { const a = this.seen.get(name); if (!a) return this.missing(); if (a.unavailable) return unavailable(a.unavailable); return a.sdkType === 'float' && typeof a.value === 'number' ? {available: true, value: Math.fround(a.value)} : invalid; }
  flag(name: string): Available<boolean> { const a = this.seen.get(name); if (!a) return this.missing(); if (a.unavailable) return unavailable(a.unavailable); return a.sdkType === 'bool' && typeof a.value === 'boolean' ? {available: true, value: a.value} : invalid; }
  minutes(name: string): Available<string> & {unit: 'min'} { const n = this.number(name, 'u32'); return n.available ? {available: true, value: String(n.value), unit: 'min'} : {...n, unit: 'min'}; }
  money(name: string, type: 's64' | 'u64', currency: Currency) {
    const a = this.seen.get(name); if (!a) return this.missing();
    if (a.unavailable) return unavailable(a.unavailable);
    return a.sdkType === type && typeof a.value === 'string' ? sdkMoney(a.value, type, currency) : invalid;
  }
}

/** The SDK-thread side of the event channel: eventSeq assignment, the capture gate and open loss runs (OD-4, OD-5 S4). */
export type Gate = 'none' | 'live' | 'durable';
export interface LossRun {first: bigint; last: bigint; counts: {offline: bigint; noDurableConsumer: bigint; queueCount: bigint}; firstNs?: bigint; lastNs?: bigint}
export interface ChannelSlot {lossBefore?: LossRun; event?: Observed & {eventSeq: bigint}}
export class EventChannel {
  gate: Gate = 'none';
  /** A full handoff ring: every event the durable gate would copy is lost as queueCount until it drains. */
  full = false;
  private nextSeq: bigint; private run?: LossRun; private slots: ChannelSlot[] = [];
  constructor(start: bigint) { this.nextSeq = start; }
  get exhausted(): boolean { return this.nextSeq > MAX_SEQ; }
  /** The eventSeq the next observed record receives. */
  get nextEventSeq(): bigint { return this.nextSeq; }
  /** Assigns the next eventSeq (D5), then copies the record or extends the open loss run. */
  observe(o: Observed): void {
    if (this.exhausted) return;
    const eventSeq = this.nextSeq++;
    if (this.gate === 'durable' && !this.full) { this.slots.push({lossBefore: this.close(), event: {...o, eventSeq}}); return; }
    const cause = this.gate === 'none' ? 'offline' : this.gate === 'live' ? 'noDurableConsumer' : 'queueCount';
    const m = o.occurred.monotonicNs, ns = m.available ? BigInt(m.value) : undefined;
    this.run ??= {first: eventSeq, last: eventSeq, counts: {offline: 0n, noDurableConsumer: 0n, queueCount: 0n}};
    this.run.last = eventSeq; this.run.counts[cause]++;
    if (ns !== undefined) { if (this.run.firstNs === undefined || ns < this.run.firstNs) this.run.firstNs = ns; if (this.run.lastNs === undefined || ns > this.run.lastNs) this.run.lastNs = ns; }
  }
  private close(): LossRun | undefined { const run = this.run; this.run = undefined; return run; }
  /** At every frame_end: an open run moves into a slot of its own unless the ring is full. */
  flushLoss(): void { if (this.run && !this.full) this.slots.push({lossBefore: this.close()}); }
  drain(): ChannelSlot[] { const s = this.slots; this.slots = []; return s; }
}

interface Published {state: Omit<CurrentState, 'window'>; offlineTransitions: bigint}

/** The adapter: SDK callbacks in, records and the published v1 state slot out. */
export class AdapterModel {
  readonly channel: EventChannel;
  readonly currency: Currency;
  gameMode: GameMode = UNKNOWN_MODE;
  private boundary = 0n; private revision = 0n; private clockEpoch = 0; private offlineTransitions = 0n;
  private simulation: CurrentState['simulation'] = 'unavailable';
  private readings = new Map<ChannelName, Reading>();
  private placement: Available<Placement> = notObserved;
  private gameTime: Available<number> = notObserved;
  private fuelCapacity: Reading = notObserved;
  private job: Available<JobConfiguration> = notObserved;
  private truck: Available<TruckConfiguration> = notObserved;
  private trailers: Available<TrailerConfiguration>[] = Array.from({length: 10}, () => notObserved);
  private publishedSlot: Published;
  private captureContext?: CaptureStep['data'];
  private captureGameClock?: string;
  constructor(readonly config: SourceConfig, private readonly clock: ScenarioClock) {
    this.channel = new EventChannel(config.startEventSeq);
    this.currency = config.currency === 'unknown' ? {status: 'unknown'} : {status: 'sdk-documented', ...CURRENCY_SOURCE[config.game]};
    this.publishedSlot = this.copyState(0);
  }
  get published(): Published { return this.publishedSlot; }
  /** Record types this session can emit (welcome `eventTypes`). */
  eventTypes(): EventType[] {
    return EVENT_TYPES.filter(t => !(this.config.gameplayEvents === 'not-supported' && GAMEPLAY_EVENT_TYPES.includes(t)) && !(t === 'source.gameMode' && this.config.gameMode === 'unknown'));
  }
  private gameClockId(): string { return this.captureGameClock ?? seededId(this.config.seed, `game-clock-${this.clockEpoch}`); }
  private stamp(): GameTimeStamp {
    return {minutes: this.gameTime.available ? {available: true, value: String(this.gameTime.value)} : unavailable(this.gameTime.reason), clockId: this.gameClockId()};
  }
  private next(): void { this.boundary++; }
  /** The callback moment after the callback updated the adapter state (§8). */
  private emit(record: EventRecord, atMs: number, boundary: boolean): void {
    const occurred: EventOccurrence = {monotonicNs: {available: true, value: this.clock.sourceNs(atMs).toString()}, gameTime: this.stamp(),
      utcUnixMs: {available: true, value: this.clock.utcMs(atMs).toString()}, simulation: this.simulation, configurationRevision: this.revision.toString(), boundaryOrder: this.boundary.toString()};
    if (this.captureContext) {
      const ns = this.captureContext.callbackMonotonicNs;
      occurred.monotonicNs = ns.available ? {available: true, value: (ScenarioClock.SOURCE_BASE_NS + BigInt(ns.value)).toString()} : unavailable(ns.reason);
      occurred.utcUnixMs = notObserved;
    }
    // OD-5 S10: lifecycle and configuration boundaries while no v1 client is connected. Gameplay events count as loss.
    if (boundary && this.channel.gate === 'none') this.offlineTransitions++;
    this.channel.observe({occurred, record});
  }
  // Rotates the game clock. Channels not yet observed in this frame are invalidated (the native clock_restart).
  private restartClock(observed: ReadonlySet<ChannelName>): void {
    this.clockEpoch++;
    for (const c of CHANNELS) if (!observed.has(c)) { if (c === 'world.placement') this.placement = notObserved; else if (c === 'game.time') this.gameTime = notObserved; else this.readings.delete(c); }
  }

  configuration(id: string, attributes: readonly SdkAttribute[], list: AttributeList, atMs: number): void {
    this.next();
    const a = new Attributes(attributes, list), cleared = list === 'terminated' && attributes.length === 0;
    const slot = /^trailer\.[0-9]$/.test(id) ? Number(id.slice(8)) : -1;
    if (id === 'truck' && list !== 'null') {
      // A truck boundary invalidates dynamic values except game time; a model id is not a truck instance.
      for (const c of CHANNELS) if (c !== 'game.time' && c !== 'world.placement') this.readings.delete(c);
      this.placement = notObserved;
      this.fuelCapacity = list === 'unterminated' ? invalid : a.float('fuel.capacity');
    }
    // bus_job, car_job, the legacy `trailer` id and other configurations have no record and no eventSeq (TD-002).
    if (id !== 'job' && id !== 'truck' && slot < 0) return;
    // D13: an empty trailer slot emits only when it was non-empty before.
    if (slot >= 0 && cleared && !this.trailers[slot].available) return;
    this.revision++;
    let record: EventRecord;
    if (id === 'job') {
      if (cleared) { record = {type: 'job.cleared'}; this.job = notObserved; }
      else {
        const body = Object.fromEntries(Object.entries(JOB_TEXT).map(([name, [key, kind]]) => [key, a.text(name, kind)])) as unknown as JobConfiguration;
        Object.assign(body, {
          cargoMass: scaled(a.float('cargo.mass'), 1, 0, 1e9, 'kg'), cargoUnitMass: scaled(a.float('cargo.unit.mass'), 1, 0, 1e9, 'kg'), cargoUnitCount: a.number('cargo.unit.count', 'u32'),
          isSpecialJob: a.flag('is.special.job'), cargoLoaded: a.flag('cargo.loaded'), plannedDistance: kmToMetersU32(a.number('planned_distance.km', 'u32')),
          expectedIncome: a.money('income', 'u64', this.currency), deliveryDeadline: a.minutes('delivery.time')
        });
        record = {type: 'job.configured', ...body}; this.job = {available: true, value: body};
      }
    } else if (id === 'truck') {
      if (cleared) { record = {type: 'truck.cleared'}; this.truck = notObserved; }
      else {
        const body = Object.fromEntries(Object.entries(TRUCK_TEXT).map(([name, [key, kind]]) => [key, a.text(name, kind)])) as unknown as TruckConfiguration;
        body.fuelCapacity = scaled(a.float('fuel.capacity'), 1, 0, 1e6, 'L');
        record = {type: 'truck.configured', ...body}; this.truck = {available: true, value: body};
      }
    } else if (cleared) { record = {type: 'trailer.cleared', index: slot}; this.trailers[slot] = notObserved; }
    else {
      const body = {index: slot, ...Object.fromEntries(Object.entries(TRAILER_TEXT).map(([name, [key, kind]]) => [key, a.text(name, kind)]))} as TrailerConfiguration;
      record = {type: 'trailer.configured', ...body}; this.trailers[slot] = {available: true, value: body};
    }
    this.emit(record, atMs, true);
  }

  gameplay(id: string, attributes: readonly SdkAttribute[], list: AttributeList, atMs: number): void {
    this.next();
    const a = new Attributes(attributes, list), c = this.currency;
    const transfer = () => ({amount: a.money('pay.amount', 's64', c), sourceId: a.text('source.id', 'id'), sourceName: a.text('source.name', 'name'), targetId: a.text('target.id', 'id'), targetName: a.text('target.name', 'name')});
    let record: EventRecord;
    switch (id) {
      case 'job.delivered': record = {type: 'job.delivered', revenue: a.money('revenue', 's64', c), earnedXp: a.number('earned.xp', 's32'),
        cargoDamage: fraction(a.float('cargo.damage')), distance: kmToMetersFloat(a.float('distance.km')), deliveryDuration: a.minutes('delivery.time'),
        autoParkUsed: a.flag('auto.park.used'), autoLoadUsed: a.flag('auto.load.used')}; break;
      case 'job.cancelled': record = {type: 'job.cancelled', penalty: a.money('cancel.penalty', 's64', c)}; break;
      case 'player.fined': record = {type: 'player.fined', offence: a.text('fine.offence', 'id'), amount: a.money('fine.amount', 's64', c)}; break;
      case 'player.tollgate.paid': record = {type: 'player.tollgate.paid', amount: a.money('pay.amount', 's64', c)}; break;
      case 'player.use.ferry': record = {type: 'player.use.ferry', ...transfer()}; break;
      case 'player.use.train': record = {type: 'player.use.train', ...transfer()}; break;
      // car_job.* and unknown gameplay events have no v1 type (TD-002): no record and no eventSeq.
      default: return;
    }
    this.emit(record, atMs, false);
  }

  lifecycle(event: 'simulation.started' | 'simulation.paused', atMs: number): void {
    this.next();
    this.simulation = event === 'simulation.started' ? 'running' : 'paused';
    this.emit({type: event}, atMs, true);
  }

  /** CAP0 has callback context but no observed channel samples. Publish that context without inventing a frame. */
  capture(step: CaptureStep, atMs: number): void {
    const d = step.data, id = d.callback.id;
    if (!id.available) throw new Error('CAP0 callback identifier unavailable');
    const from = this.stamp();
    this.captureContext = d;
    this.captureGameClock = seededId(this.config.seed, `capture-game-clock:${d.gameTime.clockId}`);
    this.gameTime = d.gameTime.minutes.available ? {available: true, value: Number(d.gameTime.minutes.value)} : unavailable(d.gameTime.minutes.reason);
    this.simulation = d.simulation;
    this.boundary = BigInt(d.sharedBoundaryOrder) - 1n;
    const attributes: SdkAttribute[] = d.observations.flatMap(o => {
      if (!o.name.available) throw new Error('CAP0 attribute name unavailable');
      // Vector and unknown SDK types cannot satisfy a scalar v1 field. Their full typed values stay in the fixture.
      const scalar = ['string', 'bool', 's32', 'u32', 's64', 'u64', 'float', 'double'].includes(o.sdkType);
      return [{name: o.name.value, sdkType: scalar ? o.sdkType as SdkType : 'string',
        value: scalar && o.value.available ? o.value.value as SdkAttribute['value'] : null,
        indexed: o.arrayIndex.available,
        ...(!o.value.available ? {unavailable: o.value.reason} : {})}];
    });
    const list: AttributeList = !d.attributes.present ? 'null' : d.attributes.terminated ? 'terminated' : 'unterminated';
    if (d.callback.group === 'configuration' || d.callback.group === 'gameplay') this[d.callback.group](id.value, attributes, list, atMs);
    else if (id.value === 'simulation.started' || id.value === 'simulation.paused') this.lifecycle(id.value, atMs);
    else {
      this.next();
      if (id.value === 'timers.restart') this.emit({type: 'timers.restart'}, atMs, true);
      else if (id.value === 'game.time.regression') this.emit({type: 'gameTime.regression', from, to: this.stamp()}, atMs, true);
      else throw new Error('Unsupported CAP0 lifecycle callback');
    }
    this.channel.flushLoss();
    this.publishedSlot = this.copyState(atMs);
    this.captureContext = undefined;
  }

  /** frame_start, the listed channels in registration order, then frame_end with the loss flush and publication. */
  frame(timerRestart: boolean, channels: FrameChannels, atMs: number): void {
    this.next();
    const observed = new Set<ChannelName>();
    if (timerRestart) { this.restartClock(observed); this.emit({type: 'timers.restart'}, atMs, true); }
    for (const c of CHANNELS) {
      if (!Object.hasOwn(channels, c)) continue;
      this.next(); observed.add(c);
      if (c === 'world.placement') {
        const p = channels[c];
        const valid = p && p !== 'invalid' && [p.x, p.y, p.z].every(v => v >= -1e9 && v <= 1e9) && [p.heading, p.pitch, p.roll].every(v => v >= -1 && v <= 1);
        this.placement = p === null ? notObserved : valid ? {available: true, value: {...p}} : invalid;
        continue;
      }
      const v = channels[c] as ChannelValue, isInt = c === 'game.time' || c === 'displayed.gear';
      const reading: Reading = v === null ? notObserved : v === 'invalid' ? invalid : {available: true, value: isInt ? v : Math.fround(v)};
      if (c !== 'game.time') { this.readings.set(c, reading); continue; }
      if (reading.available && this.gameTime.available && reading.value < this.gameTime.value) {
        // gameTime.regression: `from` is the reading and clock before the rotation, `to` the regressed reading after it.
        const from = this.stamp(); this.restartClock(observed); this.gameTime = reading;
        this.emit({type: 'gameTime.regression', from, to: this.stamp()}, atMs, true);
      }
      this.gameTime = reading;
    }
    this.next();
    this.channel.flushLoss();
    this.publishedSlot = this.copyState(atMs);
  }

  /** A synthetic game-mode determination (D9); emitted when first determined and on every change. Not an SDK callback. */
  determineGameMode(mode: GameMode, atMs: number): void {
    if (JSON.stringify(mode) === JSON.stringify(this.gameMode)) return;
    this.gameMode = mode; this.emit({type: 'source.gameMode', ...mode}, atMs, false);
  }
  /** Injected unsendable records (fault injection): an out-of-range trailer index that the contract rejects. */
  unencodable(count: number, atMs: number): void { for (let i = 0; i < count; i++) { this.next(); this.emit({type: 'trailer.cleared', index: 10}, atMs, false); } }

  private reading(c: ChannelName): Reading { return this.readings.get(c) ?? notObserved; }
  private copyState(atMs: number): Published {
    const gear = this.reading('displayed.gear');
    const state: Omit<CurrentState, 'window'> = {
      simulation: this.simulation, speed: scaled(this.reading('speed'), 1, -1000, 1000, 'm/s'), fuel: scaled(this.reading('fuel.amount'), 1, 0, 1e6, 'L'),
      fuelCapacity: scaled(this.fuelCapacity, 1, 0, 1e6, 'L'), engineRpm: scaled(this.reading('engine.rpm'), 1, 0, 100_000, 'rpm'),
      gear: gear.available && (gear.value < -100 || gear.value > 100) ? {available: false, reason: 'invalid', unit: 'index'} : withUnit(gear, 'index'),
      odometer: scaled(this.reading('odometer'), 1000, 0, 1e12, 'm'), averageConsumption: scaled(this.reading('fuel.consumption.average'), 100, 0, 1e6, 'L/100km'),
      estimatedRange: scaled(this.reading('fuel.range'), 1000, 0, 1e12, 'm'), navigationDistance: scaled(this.reading('navigation.distance'), 1, 0, 1e12, 'm'),
      gameTime: {...(this.gameTime.available ? {available: true as const, value: String(this.gameTime.value)} : unavailable(this.gameTime.reason)), unit: 'min', clockId: this.gameClockId()},
      captureUtcUnixMs: {available: true, value: this.clock.utcMs(atMs).toString()}, boundaryOrder: this.boundary.toString(),
      worldPlacement: this.placement.available ? {available: true, value: {position: {x: this.placement.value.x, y: this.placement.value.y, z: this.placement.value.z},
        orientation: {heading: this.placement.value.heading, pitch: this.placement.value.pitch, roll: this.placement.value.roll}}} : this.placement,
      configuration: {revision: this.revision.toString(), job: this.job, truck: this.truck, trailers: [...this.trailers]}
    };
    return {state: structuredClone(state), offlineTransitions: this.offlineTransitions};
  }
}
