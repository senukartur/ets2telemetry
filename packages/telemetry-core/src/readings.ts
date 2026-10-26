// Source-agnostic normalized live state. Protocol adapters (normalize-v0.ts, normalize-v1.ts) produce it; display
// code consumes it. Values stay in canonical units: m/s, m, L, L/100 km (SDK mean), kg, rpm, gear index, game minutes.

/**
 * Why a reading has no value. The first three come from the wire. `not-carried` exists only here: the protocol in use
 * does not transport the field (for example navigation distance under v0). It never appears on the wire or in storage.
 */
export type MissingReason = 'not-observed' | 'not-supported' | 'invalid' | 'not-carried';
export type Reading<T> = {state: 'value'; value: T} | {state: 'missing'; reason: MissingReason};
type WireAvailable<T> = {available: true; value: T} | {available: false; reason: 'not-supported' | 'not-observed' | 'invalid'};

export const valueOf = <T>(value: T): Reading<T> => ({state: 'value', value});
export const missing = <T = never>(reason: MissingReason): Reading<T> => ({state: 'missing', reason});
export const NOT_CARRIED: Reading<never> = Object.freeze({state: 'missing', reason: 'not-carried'});
export function fromAvailable<T>(input: WireAvailable<T>): Reading<T> {
  return input.available ? valueOf(input.value) : missing(input.reason);
}
export function mapReading<T, U>(input: Reading<T>, map: (value: T) => U): Reading<U> {
  return input.state === 'value' ? valueOf(map(input.value)) : input;
}

/** Money kinds never mix: expected income is not revenue, and a penalty is not a fine. */
export type MoneyKind = 'expected-income' | 'revenue' | 'penalty' | 'fine' | 'toll' | 'transfer';
/**
 * Currency basis. `sdk-documented` means the pinned SDK header documents the unit (v1 `sdk-documented`, or the frozen
 * v0 spelling `verified`); it is never a runtime observation. Currency is never inferred from the game or locale.
 */
export type MoneyCurrency = {basis: 'unknown'} | {basis: 'sdk-documented'; code: string; source: string};
/** Exact raw money digits as a string. Never parsed into a JS number, converted or rounded. */
export interface MoneyValue<K extends MoneyKind = MoneyKind> {
  readonly kind: K; readonly raw: string; readonly sdkType: 's64' | 'u64' | 'v0-decimal'; readonly currency: MoneyCurrency;
}
/** Distance kinds never mix: a job offer's planned distance is not the odometer or the game-reported delivery distance. */
export type DistanceKind = 'planned' | 'navigation-remaining' | 'game-delivered' | 'odometer';
export interface Distance<K extends DistanceKind = DistanceKind> {readonly kind: K; readonly meters: number}

export interface NamedEntity {id: Reading<string>; name: Reading<string>}
export interface LiveJob {
  cargo: NamedEntity; sourceCity: NamedEntity; sourceCompany: NamedEntity; destinationCity: NamedEntity; destinationCompany: NamedEntity;
  /** kg */
  cargoMass: Reading<number>;
  market: Reading<string>; isSpecialJob: Reading<boolean>;
  /** Meaningful only for the `cargo_market` market (SDK 1.15); always true for other markets. */
  cargoLoaded: Reading<boolean>;
  plannedDistance: Reading<Distance<'planned'>>;
  expectedIncome: Reading<MoneyValue<'expected-income'>>;
  /** Absolute game minutes. */
  deliveryDeadline: Reading<bigint>;
}
export interface LiveTruck {brand: NamedEntity; model: NamedEntity; licensePlate: Reading<string>; plateCountry: NamedEntity}
export interface LiveTrailer {index: number; model: NamedEntity; brand: NamedEntity; bodyType: Reading<string>; chainType: Reading<string>; licensePlate: Reading<string>}
/** Game-world coordinates, never latitude/longitude. Orientation is in SDK unit fractions of a full turn. */
export interface LiveWorldPlacement {position: {x: number; y: number; z: number}; orientation: {heading: number; pitch: number; roll: number}}
export interface GameModeView {
  mode: 'single-player' | 'truckersmp' | 'unknown'; method: 'module-scan' | 'process-scan' | 'none';
  confidence: 'strong' | 'weak' | 'none'; module: Reading<string>;
}
/** One H-shifter slot of the SDK layout: a nonzero gear index (reverse negative), its handle position and selector bits. */
export interface LiveHShifterSlot {gear: number; handlePosition: number; selectors: number}
/**
 * The protocol v1 minor-1 gearbox (ET-050b B2): the truck's gear counts and the latest SDK H-shifter layout, each with its
 * own availability. It carries no derived labels; a minor-0 source reports every part `not-supported`.
 */
export interface LiveGearbox {
  forwardGears: Reading<number>; reverseGears: Reading<number>;
  hshifter: Reading<{selectorCount: number; slots: readonly LiveHShifterSlot[]}>;
}
export const EVENT_LOSS_CAUSES = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed'] as const;
export type EventLossCause = (typeof EVENT_LOSS_CAUSES)[number];
export type EventLossView = Readonly<Record<EventLossCause, bigint>>;

export interface NormalizedLiveState {
  protocol: 'v0' | 'v1';
  simulation: 'running' | 'paused' | 'unavailable';
  /** m/s; negative means reverse. */
  speed: Reading<number>;
  /** Displayed gear index: reverse negative, neutral zero. */
  gear: Reading<number>;
  engineRpm: Reading<number>;
  /** L */
  fuel: Reading<number>;
  fuelCapacity: Reading<number>;
  /** The SDK's own mean consumption in L/100 km. Never a trip average. */
  averageConsumption: Reading<number>;
  /** m; the game's own estimate. */
  estimatedRange: Reading<number>;
  odometer: Reading<Distance<'odometer'>>;
  navigationDistance: Reading<Distance<'navigation-remaining'>>;
  gameTime: {minutes: Reading<bigint>; clockId: string};
  worldPlacement: Reading<LiveWorldPlacement>;
  job: Reading<LiveJob>;
  truck: Reading<LiveTruck>;
  /** v1: one reading per slot (an empty slot is missing). v0: not carried. */
  trailers: Reading<Reading<LiveTrailer>[]>;
  gameMode: Reading<GameModeView>;
  eventLoss: Reading<EventLossView>;
  /** v1: the minor-1 gearbox, `not-supported` in every part under minor 0 (ET-050b). v0: not carried. */
  gearbox: Reading<LiveGearbox>;
  /**
   * Game minutes until the next mandatory break (ET-052). The raw signed SDK value: zero is a value, negative means
   * overdue, and the clamp to zero is the presentation's (mandatory-break.ts). v1 minor 2 carries it; a source below
   * minor 2 reports `not-supported`; v0 does not carry it.
   */
  nextMandatoryBreak: Reading<number>;
  configurationRevision: string;
}
