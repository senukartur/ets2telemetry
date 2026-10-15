// Readings accounting for trips (ET-014 PR-2, T16 and T17). Pure classification of one step between two readings, built
// on the derived.ts step primitives, plus the per-trip accumulation of observed distance, fuel used and refuels. The
// reducer decides which trip a step belongs to and turns the findings into effects; see docs/trips.md.
import {MAX_PLAUSIBLE_SPEED_MPS, fuelStep, odometerStep, type FuelStep, type OdometerStep, type StepSample} from '../derived';
import {NOT_CARRIED, type Distance, type LiveTruck, type Reading} from '../readings';

/**
 * T17 provisional thresholds, to be checked against real sessions (docs/validation/et-014.md). A game-time jump is a
 * forward step on one game clock of at least GAME_TIME_JUMP_MINUTES that also runs faster than
 * GAME_TIME_JUMP_RATE game minutes per real minute: normal driving runs at about 19 and a ferry at about 90.
 */
export const GAME_TIME_JUMP_MINUTES = 30;
export const GAME_TIME_JUMP_RATE = 60;
/** A position step longer than MAX_PLAUSIBLE_SPEED_MPS × elapsed source seconds + this margin is a jump. Provisional. */
export const POSITION_JUMP_MARGIN_METERS = 50;
/** Readings at least this far apart while connected, with the simulation running at both ends, are a hole. Provisional. */
export const READING_HOLE_SECONDS = 5;
const READING_HOLE_NS = BigInt(READING_HOLE_SECONDS) * 1_000_000_000n;

/**
 * The part of a reading that accounting keeps until the next reading. Plain JSON-safe data: game minutes stay a
 * decimal string. `utcMs` is the reading's UTC label, if any.
 */
export interface ReadingPoint {
  source: StepSample['source']; capture: StepSample['capture'];
  simulation: 'running' | 'paused' | 'unavailable';
  odometer: Reading<Distance<'odometer'>>; fuel: Reading<number>; truck: Reading<LiveTruck>;
  gameTime: {minutes: string | null; clockId: string};
  position: {x: number; y: number; z: number} | null;
  utcMs: number | null;
}
export function readingPoint(sample: StepSample & {utcMs?: number}): ReadingPoint {
  const s = sample.state, minutes = s.gameTime.minutes, placement = s.worldPlacement;
  return {
    source: {game: sample.source.game, origin: sample.source.origin, pluginSessionId: sample.source.pluginSessionId, processInstanceId: sample.source.processInstanceId},
    capture: {clockId: sample.capture.clockId, monotonicNs: sample.capture.monotonicNs}, simulation: s.simulation,
    odometer: structuredClone(s.odometer), fuel: structuredClone(s.fuel), truck: structuredClone(s.truck),
    gameTime: {minutes: minutes.state === 'value' ? minutes.value.toString() : null, clockId: s.gameTime.clockId},
    position: placement.state === 'value' ? {...placement.value.position} : null, utcMs: sample.utcMs ?? null
  };
}
/** The step primitives read only identity, truck, game clock, odometer and fuel; everything else is not carried here. */
function sampleOf(point: ReadingPoint): StepSample {
  return {source: point.source, capture: point.capture, state: {
    protocol: 'v1', simulation: point.simulation, speed: NOT_CARRIED, gear: NOT_CARRIED, engineRpm: NOT_CARRIED, fuel: point.fuel, fuelCapacity: NOT_CARRIED,
    averageConsumption: NOT_CARRIED, estimatedRange: NOT_CARRIED, odometer: point.odometer, navigationDistance: NOT_CARRIED,
    gameTime: {minutes: point.gameTime.minutes === null ? NOT_CARRIED : {state: 'value', value: BigInt(point.gameTime.minutes)}, clockId: point.gameTime.clockId},
    worldPlacement: NOT_CARRIED, job: NOT_CARRIED, truck: point.truck, trailers: NOT_CARRIED, gameMode: NOT_CARRIED, eventLoss: NOT_CARRIED, configurationRevision: '0'
  }};
}

/** A step across a source, truck or game-clock boundary: nothing else is compared across it. */
const BOUNDARY = new Set(['source-changed', 'truck-changed', 'game-clock-rotated']);
/** Whether a ferry or train event lies between the two readings (T17 label), else an inference. */
export type JumpLabel = 'crossing' | 'possible-sleep' | 'possible-teleport';
export interface ReadingStep {
  odometer: OdometerStep; fuel: FuelStep;
  /** Source nanoseconds between the readings, or null across capture clocks or out of order. */
  elapsedNs: bigint | null;
  /** T17: at least READING_HOLE_SECONDS apart with the simulation running at both ends. */
  hole: boolean;
  gameTimeJump: {fromMinutes: string; toMinutes: string; label: JumpLabel} | null;
  positionJump: {meters: number; label: JumpLabel} | null;
}
/** Classifies one step between consecutive readings of one connection. `transfer`: a ferry or train event lies between them. */
export function classifyStep(prev: ReadingPoint, next: ReadingPoint, transfer: boolean): ReadingStep {
  const a = sampleOf(prev), b = sampleOf(next), odometer = odometerStep(a, b), fuel = fuelStep(a, b);
  const sameClock = prev.capture.clockId === next.capture.clockId && prev.source.pluginSessionId === next.source.pluginSessionId;
  const ns = sameClock ? BigInt(next.capture.monotonicNs) - BigInt(prev.capture.monotonicNs) : null, elapsedNs = ns !== null && ns >= 0n ? ns : null;
  const step: ReadingStep = {odometer, fuel, elapsedNs, hole: false, gameTimeJump: null, positionJump: null};
  if (elapsedNs === null) return step;
  step.hole = elapsedNs >= READING_HOLE_NS && prev.simulation === 'running' && next.simulation === 'running';
  if (odometer.kind === 'discontinuity' && BOUNDARY.has(odometer.cause)) return step;
  const from = prev.gameTime.minutes, to = next.gameTime.minutes;
  if (from !== null && to !== null) {
    const minutes = BigInt(to) - BigInt(from);
    // More than GAME_TIME_JUMP_RATE game minutes per real minute: minutes × 60 s × 1e9 > rate × elapsed ns.
    if (minutes >= BigInt(GAME_TIME_JUMP_MINUTES) && minutes * 60_000_000_000n > BigInt(GAME_TIME_JUMP_RATE) * elapsedNs) {
      step.gameTimeJump = {fromMinutes: from, toMinutes: to, label: transfer ? 'crossing' : 'possible-sleep'};
    }
  }
  if (prev.position !== null && next.position !== null) {
    const p = prev.position, q = next.position, meters = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (meters > MAX_PLAUSIBLE_SPEED_MPS * (Number(elapsedNs) / 1e9) + POSITION_JUMP_MARGIN_METERS) step.positionJump = {meters, label: transfer ? 'crossing' : 'possible-teleport'};
  }
  return step;
}

/**
 * What one trip has accumulated from readings (T16). Observed distance is the sum of continuous odometer steps while the
 * trip is active; fuel used is the summed consumption minus the summed small increases over continuous fuel steps;
 * refuels are excluded from both and reported apart. A step counts only when both of its readings were taken while
 * the trip was active, so nothing is bridged across an opening, a clear, a disconnection or a boundary.
 */
export interface TripAccounting {
  /** Metres; null until the first continuous odometer step. */
  observedDistanceM: number | null;
  /** The value last sent with trip.update observedDistanceM (or stored, for a resumed trip); null before that. */
  persistedDistanceM: number | null;
  fuelConsumedL: number; fuelIncreaseL: number;
  /** Continuous fuel steps counted; fuel used is unavailable while zero. */
  fuelSteps: number;
  refuelledL: number;
  /** Refuel episodes: consecutive refuelled steps form one. */
  refuels: number;
  /** The last counted fuel step was a refuel, so the next one continues the episode. */
  refuelling: boolean;
  /** Where the session's last reading was taken: before this trip, while it was open, or while it was active. */
  lastReading: 'none' | 'open' | 'active';
}
export function newAccounting(storedDistanceM: number | null = null): TripAccounting {
  return {observedDistanceM: storedDistanceM, persistedDistanceM: storedDistanceM, fuelConsumedL: 0, fuelIncreaseL: 0, fuelSteps: 0, refuelledL: 0, refuels: 0,
    refuelling: false, lastReading: 'none'};
}
/** What accumulating one step found beyond the totals: a refuel (`episode` when it starts a new one). */
export interface Accumulated {refuel: {addedLiters: number; episode: boolean} | null}
/** Adds one counted step to the trip's totals. Discontinuities and unavailable steps add nothing. */
export function accumulate(acc: TripAccounting, step: ReadingStep): Accumulated {
  if (step.odometer.kind === 'continuous') acc.observedDistanceM = (acc.observedDistanceM ?? 0) + step.odometer.meters;
  const fuel = step.fuel;
  let refuel: Accumulated['refuel'] = null;
  if (fuel.kind === 'consumed') { acc.fuelConsumedL += fuel.liters; acc.fuelSteps += 1; }
  else if (fuel.kind === 'unchanged') { acc.fuelIncreaseL += fuel.increaseLiters; acc.fuelSteps += 1; }
  else if (fuel.kind === 'refuelled') {
    refuel = {addedLiters: fuel.addedLiters, episode: !acc.refuelling};
    acc.refuelledL += fuel.addedLiters;
    if (!acc.refuelling) acc.refuels += 1;
  }
  acc.refuelling = fuel.kind === 'refuelled';
  return {refuel};
}
/** Fuel used in litres (T16), or null before the first continuous fuel step. */
export function fuelUsedL(acc: TripAccounting): number | null {
  return acc.fuelSteps === 0 ? null : acc.fuelConsumedL - acc.fuelIncreaseL;
}
/**
 * The observed distance to persist (T16): a trip.update when it changed since the last one. The caller adds it on every
 * commit carrier and right before every close, so a close never leaves an unsent change.
 */
export function distanceUpdate(tripUuid: string, acc: TripAccounting): {kind: 'trip.update'; tripUuid: string; set: {observedDistanceM: {available: true; value: number}}} | null {
  if (acc.observedDistanceM === null || acc.observedDistanceM === acc.persistedDistanceM) return null;
  acc.persistedDistanceM = acc.observedDistanceM;
  return {kind: 'trip.update', tripUuid, set: {observedDistanceM: {available: true, value: acc.observedDistanceM}}};
}
/**
 * The odometer change across a connection hole, recorded in its not-connected interval and never added to a trip:
 * null unless both readings have an odometer of the same truck.
 */
export function odometerDeltaM(before: ReadingPoint | null, after: ReadingPoint): number | null {
  if (before === null || before.odometer.state !== 'value' || after.odometer.state !== 'value') return null;
  if (JSON.stringify(before.truck) !== JSON.stringify(after.truck)) return null;
  return after.odometer.value.meters - before.odometer.value.meters;
}
