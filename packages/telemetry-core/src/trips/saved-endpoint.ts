/** Boundary comparison only: callers establish proof/ownership and credit no progress across the match. */
export interface SavedEndpoint {
  speedMps?: number | null; truck: string | null; odometerM: number | null; fuelL: number | null; gameMinutes?: string | null;
  position?: {x: number; y: number; z: number} | null;
}
export const SAVED_POSITION_METERS = 0.005, SAVED_STATIONARY_POSITION_METERS = 0.05, SAVED_FUEL_LITERS = 0.020;
/** Covers subtraction round-off at the recorded magnitude, not an additional physical allowance. */
export function savedEndpointLimits(point: SavedEndpoint): {position: number; fuel: number} {
  return {position: (point.speedMps!==null && point.speedMps!==undefined && Math.abs(point.speedMps)<=0.05 ? SAVED_STATIONARY_POSITION_METERS : SAVED_POSITION_METERS) + 2 * Number.EPSILON * Math.max(1, ...Object.values(point.position ?? {}).map(Math.abs)),
    fuel: SAVED_FUEL_LITERS + 2 * Number.EPSILON * Math.max(1, Math.abs(point.fuelL ?? 0))};
}
export function matchesSavedEndpoint(a: SavedEndpoint, b: SavedEndpoint, allowBoundaryDifferences = true, confirmedPausedMinute?: string): boolean {
  if (!a.truck || a.truck !== b.truck || a.odometerM === null || a.odometerM < 0 || a.odometerM !== b.odometerM
    || a.fuelL === null || b.fuelL === null || a.fuelL < 0 || b.fuelL < 0 || !a.gameMinutes || !b.gameMinutes || !a.position || !b.position
    || ![a.odometerM,a.fuelL,b.fuelL,...Object.values(a.position),...Object.values(b.position)].every(Number.isFinite)) return false;
  const stationary=a.speedMps!==null && a.speedMps!==undefined && b.speedMps!==null && b.speedMps!==undefined
    && Number.isFinite(a.speedMps) && Number.isFinite(b.speedMps) && Math.max(Math.abs(a.speedMps),Math.abs(b.speedMps))<=0.05;
  if(!/^(0|[1-9][0-9]{0,19})$/.test(a.gameMinutes) || !/^(0|[1-9][0-9]{0,19})$/.test(b.gameMinutes))return false;
  if(a.gameMinutes!==b.gameMinutes && !(allowBoundaryDifferences && confirmedPausedMinute===b.gameMinutes
    && BigInt(b.gameMinutes)===BigInt(a.gameMinutes)+1n && stationary))return false;
  const limits = allowBoundaryDifferences ? savedEndpointLimits(stationary?b:{...b,speedMps:null}) : {fuel:0,position:0};
  return Math.abs(a.fuelL-b.fuelL) <= limits.fuel
    && Math.hypot(a.position.x-b.position.x,a.position.y-b.position.y,a.position.z-b.position.z) <= limits.position;
}
