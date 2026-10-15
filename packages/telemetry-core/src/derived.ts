// Derived live values and stateless pairwise step primitives (REG-008). Nothing here accumulates trips, observed
// distance or trip averages; ET-014 owns accumulation and decides what each discontinuity means for a trip.
import {missing, valueOf, type Distance, type NormalizedLiveState, type Reading} from './readings';

/** Fuel above capacity by more than this relative margin is an invalid combination. */
export const FUEL_CAPACITY_TOLERANCE = 1e-6;
/**
 * Provisional step thresholds, to be checked against real sessions (docs/validation/et-010.md). An odometer step
 * longer than MAX_PLAUSIBLE_SPEED_MPS × elapsed source seconds + ODOMETER_JUMP_MARGIN_METERS is a jump, such as a
 * teleport or a ferry/train transfer. A fuel increase of at most FUEL_NOISE_LITERS is not a refuel; decreases are
 * always consumption, because ordinary 1 Hz and 20 Hz steps are far smaller than that band.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 100;
export const ODOMETER_JUMP_MARGIN_METERS = 50;
export const FUEL_NOISE_LITERS = 0.01;

/**
 * Fuel level as a fraction of capacity. Missing fuel or capacity keeps its reason. A provided capacity of zero cannot
 * be a denominator and makes the level `invalid`; fuel above capacity is `invalid` too.
 */
export function fuelLevel(fuel: Reading<number>, capacity: Reading<number>): Reading<number> {
  if (fuel.state === 'missing') return fuel;
  if (capacity.state === 'missing') return capacity;
  if (capacity.value <= 0) return missing('invalid');
  if (fuel.value > capacity.value * (1 + FUEL_CAPACITY_TOLERANCE)) return missing('invalid');
  return valueOf(fuel.value / capacity.value);
}
/** Signed game minutes from now until the delivery deadline; negative when late. */
export function deadlineRemaining(deadline: Reading<bigint>, gameTime: Reading<bigint>): Reading<bigint> {
  if (deadline.state === 'missing') return deadline;
  if (gameTime.state === 'missing') return gameTime;
  return valueOf(deadline.value - gameTime.value);
}
/**
 * Compass bearing in degrees in [0, 360), clockwise from north. The SDK heading is a unit fraction measured
 * counterclockwise from north (0.25 west, 0.75 east), so bearing = ((1 − heading) mod 1) × 360°.
 */
export function bearingDegrees(heading: number): number {
  return ((((1 - heading) % 1) + 1) % 1) * 360;
}

/** One normalized observation with the source and capture identity needed to compare two observations. */
export interface StepSample {
  source: {game: string; origin: string; pluginSessionId: string; processInstanceId: string};
  capture: {clockId: string; monotonicNs: string};
  state: NormalizedLiveState;
}
export type StepDiscontinuity = 'source-changed' | 'truck-changed' | 'game-clock-rotated';
export type OdometerStep =
  {kind: 'continuous'; meters: number} | {kind: 'unavailable'} |
  {kind: 'discontinuity'; cause: StepDiscontinuity | 'odometer-regressed' | 'odometer-jump'};
export type FuelStep =
  {kind: 'consumed'; liters: number} | {kind: 'unchanged'; increaseLiters: number} | {kind: 'refuelled'; addedLiters: number} | {kind: 'unavailable'} |
  {kind: 'discontinuity'; cause: StepDiscontinuity};

/** Truck identity: v0 truck id and its availability; v1 brand id, model id and plate. */
function truckKey(state: NormalizedLiveState): string {
  const truck = state.truck;
  return truck.state === 'missing' ? `missing:${truck.reason}` : JSON.stringify([truck.value.brand.id, truck.value.model.id, truck.value.licensePlate]);
}
function boundary(prev: StepSample, next: StepSample): StepDiscontinuity | undefined {
  const a = prev.source, b = next.source;
  // A new capture clock is a new source lifetime: elapsed time cannot be computed across it.
  if (a.game !== b.game || a.origin !== b.origin || a.pluginSessionId !== b.pluginSessionId || a.processInstanceId !== b.processInstanceId ||
    prev.capture.clockId !== next.capture.clockId) return 'source-changed';
  if (truckKey(prev.state) !== truckKey(next.state)) return 'truck-changed';
  // The adapter rotates the game clock on a timer restart or a save load (concept.md, October 14, 2026).
  if (prev.state.gameTime.clockId !== next.state.gameTime.clockId) return 'game-clock-rotated';
  return undefined;
}
/** Elapsed source seconds within one capture clock, or undefined when the samples are out of order. */
function elapsedSeconds(prev: StepSample, next: StepSample): number | undefined {
  const ns = BigInt(next.capture.monotonicNs) - BigInt(prev.capture.monotonicNs);
  return ns < 0n ? undefined : Number(ns) / 1e9;
}

/** Classifies one odometer step. A continuous step is never negative; a road stop is continuous with 0 m. */
export function odometerStep(prev: StepSample, next: StepSample): OdometerStep {
  const cause = boundary(prev, next);
  if (cause) return {kind: 'discontinuity', cause};
  const a: Reading<Distance<'odometer'>> = prev.state.odometer, b: Reading<Distance<'odometer'>> = next.state.odometer;
  const elapsed = elapsedSeconds(prev, next);
  if (a.state === 'missing' || b.state === 'missing' || elapsed === undefined) return {kind: 'unavailable'};
  const meters = b.value.meters - a.value.meters;
  if (meters < 0) return {kind: 'discontinuity', cause: 'odometer-regressed'};
  if (meters > MAX_PLAUSIBLE_SPEED_MPS * elapsed + ODOMETER_JUMP_MARGIN_METERS) return {kind: 'discontinuity', cause: 'odometer-jump'};
  return {kind: 'continuous', meters};
}
/**
 * Classifies one fuel step. Every decrease is `consumed` with its exact amount, however small, so the sum of
 * `consumed` over consecutive steps equals the sum of all decreases. An increase above FUEL_NOISE_LITERS is
 * `refuelled`. A smaller increase is `unchanged`, not a refuel, with its exact `increaseLiters`; the net fuel drop is
 * the summed `consumed` minus the summed `increaseLiters`. No amount is ever negative.
 */
export function fuelStep(prev: StepSample, next: StepSample): FuelStep {
  const cause = boundary(prev, next);
  if (cause) return {kind: 'discontinuity', cause};
  const a = prev.state.fuel, b = next.state.fuel;
  if (a.state === 'missing' || b.state === 'missing' || elapsedSeconds(prev, next) === undefined) return {kind: 'unavailable'};
  const delta = b.value - a.value;
  if (delta < 0) return {kind: 'consumed', liters: -delta};
  return delta > FUEL_NOISE_LITERS ? {kind: 'refuelled', addedLiters: delta} : {kind: 'unchanged', increaseLiters: delta};
}
