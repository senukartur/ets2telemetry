// Versioned distance and fuel engine for logical trips (ET-112c, engine 1). Pure: one step between the last complete
// ledger anchor and the next stored sample, plus the retained run path for a save rollback. Storage records the result
// in logical_progress (schema 10: logical_trips.accounting_engine, logical_progress.quantity_flags); reconstruction folds
// stored samples through the same function with memoryPath(). A break never zeroes a quantity: the subtotal carries and
// a flag bit makes it partial. Only an unproven rollback or truck order makes a quantity unavailable; see docs/storage.md, Schema version 10.
import {FUEL_NOISE_LITERS} from '../derived';
import {READING_HOLE_SECONDS} from './accounting';
import {gameDistanceStep} from './game-distance';
import {matchesSavedEndpoint} from './saved-endpoint';

export const QUANTITY_ENGINE_VERSION = 1;
/** The most run ends a rollback searches, as the engine-0 accounting path walk. */
export const QUANTITY_RUN_LIMIT = 256;
/** The most points of one run a rollback compares for its fuel save point. */
export const QUANTITY_POINT_LIMIT = 65;

/** Frozen for engine 1: bits 0-13 are cumulative along the ledger; bits 14 and 15 describe one row. */
export const QUANTITY_FLAGS = Object.freeze({
  distanceTruck: 1 << 0, distanceJump: 1 << 1, distanceTransfer: 1 << 2, distanceHole: 1 << 3, distanceGap: 1 << 4, distanceUnproven: 1 << 5,
  /** Quality, not a break: distance continued across a reading hole inside one connection. */
  distanceBridged: 1 << 6,
  /** Quality, not a break: distance was restored to a retained run after a rollback. */
  distanceRestored: 1 << 7,
  fuelTruck: 1 << 8, fuelHole: 1 << 9, fuelTransfer: 1 << 10, fuelBoundary: 1 << 11, fuelUnproven: 1 << 12,
  /** Quality, not a break: a refuel was left out of fuel used. */
  fuelRefuelExcluded: 1 << 13,
  /** Row fact: the first point of a ledger or of a spliced member. */
  base: 1 << 14,
  /** Row input: the recorder linked this sample to the previous ledger anchor. */
  linked: 1 << 15
});
const F = QUANTITY_FLAGS;
export const DISTANCE_BREAK_FLAGS = 0x003f, FUEL_BREAK_FLAGS = 0x1f00;
const DISTANCE_FLAGS = 0x00ff, FUEL_FLAGS = 0x3f00, CUMULATIVE_FLAGS = 0x3fff, UNPROVEN_FLAGS = F.distanceUnproven | F.fuelUnproven;

/** One stored sample as the engine reads it. Game minutes are a decimal string; `truck` is the recorder's identity key. */
export interface QuantityAnchor {
  pluginSessionId: string; sourceClockId: string; monotonicNs: string; gameClockId: string | null; gameMinutes: string | null;
  truck: string | null; odometerM: number | null; fuelL: number | null; speedMps: number | null; position: {x: number; y: number; z: number} | null;
}
/** Cumulative quantities at an anchor; null is unavailable (unproven). */
export interface QuantityPoint {anchor: QuantityAnchor; distanceM: number | null; fuelUsedL: number | null; flags: number}
/**
 * How the caller reached this anchor from the previous complete one: another raw member of the trip, a source, capture or
 * game clock change or a non-positive time inside one member, or running time. `seconds` excludes paused time, `transfer`
 * is a ferry or train event in the step, and `linked` is the recorder's link to the previous anchor.
 */
export type QuantityStep = {kind: 'member'} | {kind: 'boundary'} | {kind: 'running'; seconds: number; transfer: boolean; linked: boolean};
/** A retained run: continuous distance on one truck from `startOdometerM` to its end point. */
export interface QuantityRun {startOdometerM: number | null; end: QuantityPoint}
export interface QuantityPath<R extends QuantityRun = QuantityRun> {
  /** Retained run ends, newest first, the current run included, at most QUANTITY_RUN_LIMIT; 'member' stops at another member. */
  runs(scope: 'member' | 'trip'): readonly R[];
  /** At most QUANTITY_POINT_LIMIT self-anchored points of `run` with odometer at most `odometerM`, by odometer, then recency, descending. */
  points(run: R, odometerM: number): readonly QuantityPoint[];
}
export interface QuantityAdvance<R extends QuantityRun = QuantityRun> {
  /** The new point; the previous one unchanged for a hold; null while no complete anchor was seen. */
  point: QuantityPoint | null;
  run: 'continue' | 'new';
  /** A rollback restored to `run` at `odometerM`; the caller records the cut. */
  cut: {run: R; odometerM: number} | null;
  /** This step made a quantity unavailable (a different truck at earlier minutes, or a rollback without a retained run). */
  unproven: boolean;
  /** At a junction or rollback: whether the anchor is the same save point as the compared one; null otherwise. */
  savePoint: boolean | null;
  /** Break bits this step newly set. */
  added: number;
}

const MINUTES = /^(0|[1-9][0-9]{0,19})$/;
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
/** Rule 1 input: a complete anchor has a truck, odometer, fuel, speed, game minutes and position (D16). */
export function completeAnchor(anchor: QuantityAnchor): boolean {
  const p = anchor.position;
  return !!anchor.truck && finite(anchor.odometerM) && anchor.odometerM >= 0 && finite(anchor.fuelL) && anchor.fuelL >= 0 && finite(anchor.speedMps)
    && anchor.gameMinutes !== null && MINUTES.test(anchor.gameMinutes) && p !== null && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/** One engine-1 step. Rules apply in order: hold, start, junction or boundary, truck, transfer, hole, ordinary step. */
export function advanceQuantities<R extends QuantityRun>(previous: QuantityPoint | null, anchor: QuantityAnchor, step: QuantityStep, path: QuantityPath<R>): QuantityAdvance<R> {
  if (!completeAnchor(anchor)) return {point: previous, run: 'continue', cut: null, unproven: false, savePoint: null, added: 0};
  if (!previous) return {point: {anchor, distanceM: 0, fuelUsedL: 0, flags: F.base}, run: 'new', cut: null, unproven: false, savePoint: null, added: 0};
  const e = previous.anchor, x = anchor.odometerM!, fuelDelta = anchor.fuelL! - e.fuelL!;
  let distance = previous.distanceM, fuel = previous.fuelUsedL, flags = previous.flags & CUMULATIVE_FLAGS;
  let run: 'continue' | 'new' = 'continue', cut: QuantityAdvance<R>['cut'] = null, unproven = false, savePoint: boolean | null = null;
  const credit = (meters: number) => { if (distance !== null) distance += meters; };
  const consume = () => { if (fuel !== null) fuel -= fuelDelta; };
  const restore = (scope: 'member' | 'trip') => {
    run = 'new'; savePoint = false;
    const retained = path.runs(scope).slice(0, QUANTITY_RUN_LIMIT).find(r => r.end.anchor.truck === anchor.truck && r.startOdometerM !== null
      && r.startOdometerM <= x && x <= r.end.anchor.odometerM! && r.end.distanceM !== null);
    // E7: no retained run holds the loaded point, so neither quantity can be supported for the rest of the trip.
    if (!retained) { distance = null; fuel = null; flags |= UNPROVEN_FLAGS; unproven = true; return; }
    cut = {run: retained, odometerM: x};
    const points = path.points(retained, x).slice(0, QUANTITY_POINT_LIMIT);
    let match: QuantityPoint | undefined;
    for (const point of points) {
      if (point.anchor.odometerM !== x || !matchesSavedEndpoint(point.anchor, anchor, true, anchor.gameMinutes!)) continue;
      if (!match || Math.abs(point.anchor.fuelL! - anchor.fuelL!) < Math.abs(match.anchor.fuelL! - anchor.fuelL!)) match = point;
    }
    const kept = match ?? points[0];
    let fuelFlags = kept ? kept.flags & FUEL_FLAGS : F.fuelUnproven;
    if (!match && kept) fuelFlags |= F.fuelBoundary;
    if (!kept) unproven = true;
    savePoint = !!match;
    distance = previous.distanceM === null ? null : retained.end.distanceM! - (retained.end.anchor.odometerM! - x);
    fuel = previous.fuelUsedL === null || !kept ? null : kept.fuelUsedL;
    flags = (retained.end.flags & DISTANCE_FLAGS) | F.distanceRestored | (previous.flags & UNPROVEN_FLAGS) | fuelFlags;
  };
  if (step.kind !== 'running') {
    if (anchor.truck !== e.truck) {
      // E3: a different truck is a member gap only when the game clock moved on; otherwise the order is unknown.
      run = 'new'; savePoint = false;
      if (BigInt(anchor.gameMinutes!) > BigInt(e.gameMinutes!)) flags |= F.distanceTruck | F.fuelTruck;
      else { distance = null; fuel = null; flags |= UNPROVEN_FLAGS; unproven = true; }
    } else if (x === e.odometerM) {
      // No credit is given across the comparison; fuel continues unbroken only at the same save point.
      savePoint = matchesSavedEndpoint(e, anchor, true, anchor.gameMinutes!);
      if (!savePoint) flags |= F.fuelBoundary;
    } else if (x > e.odometerM!) { run = 'new'; savePoint = false; flags |= F.distanceGap | F.fuelBoundary; }
    else restore(step.kind === 'member' ? 'trip' : 'member');
  } else if (anchor.truck !== e.truck) { run = 'new'; flags |= F.distanceTruck | F.fuelTruck; }
  else if (step.transfer) {
    if (x !== e.odometerM) { run = 'new'; flags |= F.distanceTransfer; }
    if (Math.abs(fuelDelta) <= FUEL_NOISE_LITERS) consume(); else flags |= F.fuelTransfer;
  } else if (step.seconds >= READING_HOLE_SECONDS) {
    // E4 and REG-008: distance bridges a hole only inside one recorder connection.
    const moved = gameDistanceStep(e, anchor, step.seconds);
    if (step.linked && moved.kind === 'continuous') { credit(moved.meters); flags |= F.distanceBridged; } else { run = 'new'; flags |= F.distanceHole; }
    flags |= F.fuelHole;
  } else {
    const moved = gameDistanceStep(e, anchor, step.seconds);
    if (moved.kind === 'continuous') credit(moved.meters);
    else if (moved.kind === 'discontinuity' && moved.cause === 'odometer-regressed') restore('member');
    else { run = 'new'; flags |= F.distanceJump; }
    // A decrease adds, an increase within the noise band is subtracted, and a refuel adds nothing.
    if (!cut && !unproven) { if (fuelDelta > FUEL_NOISE_LITERS) flags |= F.fuelRefuelExcluded; else consume(); }
  }
  if (step.kind === 'running' && step.linked) flags |= F.linked;
  return {point: {anchor, distanceM: distance, fuelUsedL: fuel, flags}, run, cut, unproven, savePoint,
    added: flags & ~previous.flags & (DISTANCE_BREAK_FLAGS | FUEL_BREAK_FLAGS)};
}

/** A member-local point (counted from the member's own base) placed after `base`, the member's junction point in the trip. */
export function composeOffset(base: QuantityPoint, local: QuantityPoint): QuantityPoint {
  return {anchor: local.anchor, distanceM: base.distanceM === null || local.distanceM === null ? null : base.distanceM + local.distanceM,
    fuelUsedL: base.fuelUsedL === null || local.fuelUsedL === null ? null : base.fuelUsedL + local.fuelUsedL,
    flags: (base.flags & CUMULATIVE_FLAGS) | (local.flags & (CUMULATIVE_FLAGS | F.linked))};
}

export type QuantityStatus = 'complete' | 'partial' | 'unavailable';
/** D8: from the value and the flags only; quality bits never make a quantity partial. */
export function quantityStatus(value: number | null, flags: number, quantity: 'distance' | 'fuel'): QuantityStatus {
  if (value === null) return 'unavailable';
  return flags & (quantity === 'distance' ? DISTANCE_BREAK_FLAGS : FUEL_BREAK_FLAGS) ? 'partial' : 'complete';
}

/** A run of the in-memory path; `member` is any stable key of the raw member whose sample ended the run. */
export interface MemoryRun extends QuantityRun {readonly member: string}
export interface MemoryPath extends QuantityPath<MemoryRun> {
  /** The latest recorded point: the `previous` of the next advance. */
  readonly head: QuantityPoint | null;
  /** Records one advance of `anchor` by a sample of `member`, as storage records its ledger row. */
  record(member: string, anchor: QuantityAnchor, advance: QuantityAdvance<MemoryRun>): void;
}
interface Run extends MemoryRun {member: string; end: QuantityPoint; points: QuantityPoint[]; prefix: Run | null}
/** The ledger of one logical trip in memory, for reconstruction and tests. Holds add no point. */
export function memoryPath(): MemoryPath {
  let current: Run | null = null, head: QuantityPoint | null = null;
  return {
    get head() { return head; },
    runs(scope) {
      const runs: Run[] = [];
      for (let run = current; run && runs.length < QUANTITY_RUN_LIMIT; run = run.prefix) {
        if (scope === 'member' && run.member !== current!.member) break;
        runs.push(run);
      }
      return runs;
    },
    points(run, odometerM) {
      return (run as Run).points.map((point, index) => ({point, index})).filter(({point}) => point.anchor.odometerM! <= odometerM)
        .sort((a, b) => b.point.anchor.odometerM! - a.point.anchor.odometerM! || b.index - a.index).slice(0, QUANTITY_POINT_LIMIT).map(({point}) => point);
    },
    record(member, anchor, advance) {
      const point = advance.point;
      if (!point || point.anchor !== anchor) return;
      head = point;
      if (advance.cut) {
        // The retained part of the restored run ends at the cut, and the abandoned newer runs leave the path.
        const restored = advance.cut.run as Run;
        const kept: Run = {member: restored.member, startOdometerM: restored.startOdometerM, end: point, points: restored.points, prefix: restored.prefix};
        current = {member, startOdometerM: anchor.odometerM, end: point, points: [point], prefix: kept};
      } else if (advance.run === 'new' || !current) current = {member, startOdometerM: anchor.odometerM, end: point, points: [point], prefix: current};
      else { current.end = point; current.points.push(point); current.member = member; }
    }
  };
}
