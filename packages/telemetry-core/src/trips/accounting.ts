// Readings accounting for trips (ET-014 PR-2, T16 and T17). Pure classification of one step between two readings, built
// on the derived.ts step primitives, a sliding window of game-time advance, and the per-trip accumulation of observed
// distance, fuel used and refuels. The reducer decides which trip a step belongs to and turns the findings into
// effects; see docs/trips.md.
import {MAX_PLAUSIBLE_SPEED_MPS, fuelStep, odometerStep, truckKey, type FuelStep, type OdometerStep, type StepSample} from '../derived';
import {NOT_CARRIED, type Distance, type LiveTruck, type Reading} from '../readings';

/**
 * T17 provisional thresholds, to be checked against real sessions (docs/validation/et-014.md). A game-time jump is a
 * forward advance on one game clock of at least GAME_TIME_JUMP_MINUTES that runs faster than GAME_TIME_JUMP_RATE game
 * minutes per real minute, measured from any reading at most GAME_TIME_WINDOW_SECONDS earlier: normal driving runs at
 * about 19 and a ferry at about 90, so both a single-step sleep and a ferry spread over many readings are found.
 */
export const GAME_TIME_JUMP_MINUTES = 30;
export const GAME_TIME_JUMP_RATE = 60;
export const GAME_TIME_WINDOW_SECONDS = 60;
/** A jump grows only by a fast advance measured over at least this much real time since its last growth. Provisional. */
export const GAME_TIME_GROWTH_SECONDS = 1;
/** A ferry or train event at most this long before a jump starts, or during it, labels the jump a crossing. Provisional. */
export const CROSSING_WINDOW_SECONDS = 300;
/** A position step longer than MAX_PLAUSIBLE_SPEED_MPS × elapsed source seconds + this margin is a jump. Provisional. */
export const POSITION_JUMP_MARGIN_METERS = 50;
/** At least this much running simulation time between two readings of one connection is a reading hole. Provisional. */
export const READING_HOLE_SECONDS = 5;
const NS_PER_SECOND = 1_000_000_000n;
const READING_HOLE_NS = BigInt(READING_HOLE_SECONDS) * NS_PER_SECOND;
const WINDOW_NS = BigInt(GAME_TIME_WINDOW_SECONDS) * NS_PER_SECOND;
const GROWTH_NS = BigInt(GAME_TIME_GROWTH_SECONDS) * NS_PER_SECOND;
const CROSSING_NS = BigInt(CROSSING_WINDOW_SECONDS) * NS_PER_SECOND;

/**
 * The part of a reading that accounting keeps until the next reading. Plain JSON-safe data: game minutes stay a
 * decimal string. `utcMs` is the reading's UTC label, if it is a non-negative safe integer.
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
  const s = sample.state, minutes = s.gameTime.minutes, placement = s.worldPlacement, utc = sample.utcMs;
  return {
    source: {game: sample.source.game, origin: sample.source.origin, pluginSessionId: sample.source.pluginSessionId, processInstanceId: sample.source.processInstanceId},
    capture: {clockId: sample.capture.clockId, monotonicNs: sample.capture.monotonicNs}, simulation: s.simulation,
    odometer: structuredClone(s.odometer), fuel: structuredClone(s.fuel), truck: structuredClone(s.truck),
    gameTime: {minutes: minutes.state === 'value' ? minutes.value.toString() : null, clockId: s.gameTime.clockId},
    position: placement.state === 'value' ? {...placement.value.position} : null,
    // A label that could not be a storage UTC value is treated as absent, as for event labels.
    utcMs: utc !== undefined && Number.isSafeInteger(utc) && utc >= 0 ? utc : null
  };
}
/** The step primitives read only identity, truck, game clock, odometer and fuel; everything else is not carried here. */
function sampleOf(point: ReadingPoint): StepSample {
  return {source: point.source, capture: point.capture, state: {
    protocol: 'v1', simulation: point.simulation, speed: NOT_CARRIED, gear: NOT_CARRIED, engineRpm: NOT_CARRIED, fuel: point.fuel, fuelCapacity: NOT_CARRIED,
    averageConsumption: NOT_CARRIED, estimatedRange: NOT_CARRIED, odometer: point.odometer, navigationDistance: NOT_CARRIED,
    gameTime: {minutes: point.gameTime.minutes === null ? NOT_CARRIED : {state: 'value', value: BigInt(point.gameTime.minutes)}, clockId: point.gameTime.clockId},
    worldPlacement: NOT_CARRIED, job: NOT_CARRIED, truck: point.truck, trailers: NOT_CARRIED, gameMode: NOT_CARRIED, eventLoss: NOT_CARRIED, gearbox: NOT_CARRIED, nextMandatoryBreak: NOT_CARRIED, configurationRevision: '0'
  }};
}

/** A step across a source, truck or game-clock boundary: nothing else is compared across it. */
const BOUNDARY = new Set(['source-changed', 'truck-changed', 'game-clock-rotated']);
/** `crossing` when a ferry or train event is next to the jump (T17), else an inference. */
export type JumpLabel = 'crossing' | 'possible-sleep' | 'possible-teleport';
export interface ReadingStep {
  odometer: OdometerStep; fuel: FuelStep;
  /** Source nanoseconds between the readings, or null across capture clocks or out of order. */
  elapsedNs: bigint | null;
  /** A boundary step compares nothing beyond the primitives. */
  boundary: boolean;
  /** The straight-line position step, when it exceeds the plausible speed. */
  positionJump: {meters: number} | null;
}
/** Classifies one step between consecutive readings of one connection. */
export function classifyStep(prev: ReadingPoint, next: ReadingPoint): ReadingStep {
  const a = sampleOf(prev), b = sampleOf(next), odometer = odometerStep(a, b), fuel = fuelStep(a, b);
  const sameClock = prev.capture.clockId === next.capture.clockId && prev.source.pluginSessionId === next.source.pluginSessionId;
  const ns = sameClock ? BigInt(next.capture.monotonicNs) - BigInt(prev.capture.monotonicNs) : null, elapsedNs = ns !== null && ns >= 0n ? ns : null;
  const boundary = odometer.kind === 'discontinuity' && BOUNDARY.has(odometer.cause);
  const step: ReadingStep = {odometer, fuel, elapsedNs, boundary, positionJump: null};
  if (elapsedNs === null || boundary) return step;
  if (prev.position !== null && next.position !== null) {
    const p = prev.position, q = next.position, meters = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (meters > MAX_PLAUSIBLE_SPEED_MPS * (Number(elapsedNs) / 1e9) + POSITION_JUMP_MARGIN_METERS) step.positionJump = {meters};
  }
  return step;
}

/**
 * Running simulation time since the last reading, split by the stream's simulation states: it starts from the
 * reading's own state, and each event's `occurred.simulation` switches it at the event's source time.
 */
export interface RunClock {clockId: string; running: boolean; markNs: string; runningNs: string}
export function startRunClock(next: ReadingPoint): RunClock {
  return {clockId: next.capture.clockId, running: next.simulation === 'running', markNs: next.capture.monotonicNs, runningNs: '0'};
}
/** Applies an event's simulation state at its source time; times before the mark count from the mark. */
export function switchRunClock(clock: RunClock, clockId: string, atNs: string, simulation: 'running' | 'paused' | 'unavailable'): RunClock {
  if (clockId !== clock.clockId) return clock;
  const at = BigInt(atNs) > BigInt(clock.markNs) ? atNs : clock.markNs, running = simulation === 'running';
  if (clock.running && !running) return {...clock, running, markNs: at, runningNs: (BigInt(clock.runningNs) + BigInt(at) - BigInt(clock.markNs)).toString()};
  if (!clock.running && running) return {...clock, running, markNs: at};
  return clock;
}
/** T17: whether at least READING_HOLE_SECONDS of running simulation lie between the clock's reading and `next`. */
export function isReadingHole(clock: RunClock, next: ReadingPoint): boolean {
  if (clock.clockId !== next.capture.clockId) return false;
  const end = BigInt(next.capture.monotonicNs), mark = BigInt(clock.markNs);
  return BigInt(clock.runningNs) + (clock.running && end > mark ? end - mark : 0n) >= READING_HOLE_NS;
}

/** Recent game-time readings of one game clock and capture clock, at most one per real second, for the jump rate. */
export interface GameTimeWindow {gameClockId: string; captureClockId: string; points: {ns: string; minutes: string}[]}
export interface GameTimeJump {fromMinutes: string; toMinutes: string; fromNs: string}
/**
 * Adds a reading to the window and reports a game-time jump (T17): an advance of at least GAME_TIME_JUMP_MINUTES at
 * more than GAME_TIME_JUMP_RATE per real minute from any window point or the previous reading. The latest such point is
 * its start, so a single-step sleep starts at the reading before it and a ferry where the fast advance began.
 */
export function advanceGameTime(window: GameTimeWindow | null, prev: ReadingPoint | null, next: ReadingPoint): {window: GameTimeWindow | null; jump: GameTimeJump | null} {
  if (next.gameTime.minutes === null) return {window, jump: null};
  const nextNs = BigInt(next.capture.monotonicNs), minutes = BigInt(next.gameTime.minutes);
  let points = window !== null && window.gameClockId === next.gameTime.clockId && window.captureClockId === next.capture.clockId ? window.points : [];
  if (points.length && BigInt(points[points.length - 1].minutes) > minutes) points = [];
  points = points.filter(p => BigInt(p.ns) >= nextNs - WINDOW_NS && BigInt(p.ns) <= nextNs);
  // The previous reading always counts, however long ago it was: a single step is judged on its own rate.
  const candidates: {ns: string; minutes: string; prev?: true}[] = [...points];
  if (prev !== null && prev.gameTime.minutes !== null && prev.gameTime.clockId === next.gameTime.clockId && prev.capture.clockId === next.capture.clockId) {
    candidates.push({ns: prev.capture.monotonicNs, minutes: prev.gameTime.minutes, prev: true});
  }
  let jump: GameTimeJump | null = null;
  for (const p of candidates) {
    const advance = minutes - BigInt(p.minutes), span = nextNs - BigInt(p.ns);
    if (span < 0n || (span > WINDOW_NS && p.prev !== true)) continue;
    // More than the rate per real minute: advance × 60 s × 1e9 > rate × span ns.
    if (advance >= BigInt(GAME_TIME_JUMP_MINUTES) && advance * 60n * NS_PER_SECOND > BigInt(GAME_TIME_JUMP_RATE) * span && (jump === null || BigInt(p.ns) > BigInt(jump.fromNs))) {
      jump = {fromMinutes: p.minutes, toMinutes: next.gameTime.minutes, fromNs: p.ns};
    }
  }
  if (!points.length || nextNs - BigInt(points[points.length - 1].ns) >= NS_PER_SECOND) points = [...points, {ns: next.capture.monotonicNs, minutes: next.gameTime.minutes}];
  return {window: {gameClockId: next.gameTime.clockId, captureClockId: next.capture.clockId, points}, jump};
}
/**
 * Whether game time advanced faster than GAME_TIME_JUMP_RATE from an earlier reading to `next`, over at least
 * GAME_TIME_GROWTH_SECONDS of real time. A jump that is already annotated grows only by such advances, so normal driving
 * after a sleep, still inside the window, does not extend it: one ordinary minute tick right after the jump is never
 * fast over a whole second (normal driving runs at about 0.3 game minutes per real second).
 */
export function isFastAdvance(fromNs: string, fromMinutes: string, next: ReadingPoint): boolean {
  if (next.gameTime.minutes === null) return false;
  const advance = BigInt(next.gameTime.minutes) - BigInt(fromMinutes), span = BigInt(next.capture.monotonicNs) - BigInt(fromNs);
  return advance > 0n && span >= GROWTH_NS && advance * 60n * NS_PER_SECOND > BigInt(GAME_TIME_JUMP_RATE) * span;
}
/** The last ferry or train event of the session: its source time on its capture clock. */
export interface TransferMark {clockId: string; monotonicNs: string}
/**
 * T17 label: a jump is a crossing when a ferry or train event lies at most CROSSING_WINDOW_SECONDS before the jump's
 * start, or between its start and `next`; otherwise `otherwise`, an inference.
 */
export function jumpLabel(transfer: TransferMark | null, startNs: string, next: ReadingPoint, otherwise: 'possible-sleep' | 'possible-teleport'): JumpLabel {
  if (transfer === null || transfer.clockId !== next.capture.clockId) return otherwise;
  const at = BigInt(transfer.monotonicNs);
  return at >= BigInt(startNs) - CROSSING_NS && at <= BigInt(next.capture.monotonicNs) ? 'crossing' : otherwise;
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
  /** The stored fuel used of a resumed trip (J8), from which fuel used accumulates; null otherwise. */
  storedFuelUsedL: number | null;
  /**
   * What was last sent with trip.update fuelUsedL (or stored, for a resumed trip): litres, `invalid` for a negative
   * total, which storage cannot hold, or null before that.
   */
  persistedFuelUsedL: number | 'invalid' | null;
  fuelConsumedL: number; fuelIncreaseL: number;
  /** Continuous fuel steps counted; without a stored value, fuel used is unavailable while zero. */
  fuelSteps: number;
  refuelledL: number;
  /** Refuel episodes: consecutive refuelled steps form one. */
  refuels: number;
  /** The last counted fuel step was a refuel, so the next one continues the episode. */
  refuelling: boolean;
  /** Where the session's last reading was taken: before this trip, while it was open, or while it was active. */
  lastReading: 'none' | 'open' | 'active';
}
export function newAccounting(storedDistanceM: number | null = null, storedFuelUsedL: number | null = null): TripAccounting {
  return {observedDistanceM: storedDistanceM, persistedDistanceM: storedDistanceM, storedFuelUsedL, persistedFuelUsedL: storedFuelUsedL, fuelConsumedL: 0, fuelIncreaseL: 0,
    fuelSteps: 0, refuelledL: 0, refuels: 0, refuelling: false, lastReading: 'none'};
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
/**
 * Fuel used in litres (T16): a resumed trip's stored value plus the net drop of the steps counted since (J8), or null
 * before the first continuous fuel step when nothing was stored.
 */
export function fuelUsedL(acc: TripAccounting): number | null {
  if (acc.fuelSteps === 0) return acc.storedFuelUsedL;
  return (acc.storedFuelUsedL ?? 0) + acc.fuelConsumedL - acc.fuelIncreaseL;
}
/** A trip.update of the readings totals; `set` holds only the totals that changed. */
export interface AccountingUpdate {
  kind: 'trip.update'; tripUuid: string;
  set: {observedDistanceM?: {available: true; value: number}; fuelUsedL?: {available: true; value: number} | {available: false; reason: 'invalid'}};
}
/**
 * The observed distance and fuel used to persist (T16, J8): one trip.update with each total that changed since it was
 * last sent. The caller adds it on every commit carrier and right before every close, so a close never leaves an unsent
 * change. A total that was never observed is not sent, so storage keeps `not-observed`. Fuel used is not clamped
 * (docs/trips.md): a negative total, which storage cannot hold, is sent as `invalid` and replaced by its value once it
 * is no longer negative.
 */
export function accountingUpdate(tripUuid: string, acc: TripAccounting): AccountingUpdate | null {
  const set: AccountingUpdate['set'] = {};
  if (acc.observedDistanceM !== null && acc.observedDistanceM !== acc.persistedDistanceM) {
    acc.persistedDistanceM = acc.observedDistanceM;
    set.observedDistanceM = {available: true, value: acc.observedDistanceM};
  }
  const used = fuelUsedL(acc), fuel = used === null ? null : used >= 0 ? used : 'invalid';
  if (fuel !== null && fuel !== acc.persistedFuelUsedL) {
    acc.persistedFuelUsedL = fuel;
    set.fuelUsedL = fuel === 'invalid' ? {available: false, reason: 'invalid'} : {available: true, value: fuel};
  }
  return set.observedDistanceM === undefined && set.fuelUsedL === undefined ? null : {kind: 'trip.update', tripUuid, set};
}
/**
 * The odometer change across a connection hole, recorded in its not-connected interval and never added to a trip:
 * null unless both readings have an odometer and a known truck, and it is the same truck (derived.ts truck identity:
 * brand, model and plate). An unavailable truck at either end is unknown, even when both are unavailable for the same
 * reason: no change between possibly different trucks is recorded.
 */
export function odometerDeltaM(before: ReadingPoint | null, after: ReadingPoint): number | null {
  if (before === null || before.odometer.state !== 'value' || after.odometer.state !== 'value') return null;
  if (before.truck.state !== 'value' || after.truck.state !== 'value' || truckKey(before) !== truckKey(after)) return null;
  return after.odometer.value.meters - before.odometer.value.meters;
}
