import type {Available} from '../../../contracts/src/protocol-v1';
import {FUEL_NOISE_LITERS} from '../derived';

export interface ProgressAnchor {
  speedMps?: number | null; gameMinutes?: string | null; gameClockId?:string|null;position?:{x:number;y:number;z:number}|null;pluginSessionId: string; sourceClockId: string; monotonicNs: string; truck: string | null;
  odometerM: number | null; fuelL: number | null;
}
export interface ProgressCheckpoint {
  distanceM: Available<number>; fuelUsedL: Available<number>; anchor: ProgressAnchor;
}
const unknown = (): Available<number> => ({available: false, reason: 'not-observed'});
/** An exact recorded prefix, or a distance-only cut inside a proven continuous odometer span. */
export function restoredProgress(start: ProgressCheckpoint, end: ProgressCheckpoint, at: ProgressAnchor): ProgressCheckpoint {
  const a = start.anchor.odometerM, b = end.anchor.odometerM, x = at.odometerM;
  if (!at.truck || at.truck !== start.anchor.truck || at.truck !== end.anchor.truck || a === null || b === null || x === null || x < a || x > b
    || !start.distanceM.available || !end.distanceM.available || end.distanceM.value - start.distanceM.value !== b - a) {
    return {anchor: at, distanceM: unknown(), fuelUsedL: unknown()};
  }
  const exact = x === a ? start : x === b ? end : null;
  return {anchor: at, distanceM: {available: true, value: start.distanceM.value + x - a}, fuelUsedL: exact && exact.anchor.fuelL === at.fuelL ? exact.fuelUsedL : unknown()};
}
/** No bridging sessions, holes, truck changes or implausible jumps. A restore supplies its own supported prefix. */
export function advanceProgress(previous: ProgressCheckpoint | null, anchor: ProgressAnchor, continuous: boolean): ProgressCheckpoint {
  if (!previous) return {anchor, distanceM: anchor.odometerM === null || anchor.truck === null ? unknown() : {available: true, value: 0}, fuelUsedL: anchor.fuelL === null || anchor.truck === null ? unknown() : {available: true, value: 0}};
  const a = previous.anchor, meters = a.odometerM === null || anchor.odometerM === null ? null : anchor.odometerM - a.odometerM;
  const valid = continuous && a.truck !== null && a.truck === anchor.truck && meters !== null && meters >= 0;
  const fuel = a.fuelL === null || anchor.fuelL === null ? null : a.fuelL - anchor.fuelL;
  return {anchor, distanceM: valid && previous.distanceM.available ? {available: true, value: previous.distanceM.value + meters} : unknown(),
    fuelUsedL: valid && fuel !== null && previous.fuelUsedL.available ? {available: true, value: previous.fuelUsedL.value + (fuel < -FUEL_NOISE_LITERS ? 0 : fuel)} : unknown()};
}
