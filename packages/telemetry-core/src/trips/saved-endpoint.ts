/** Boundary comparison only: callers establish proof/ownership and credit no progress across the match. */
export interface SavedEndpoint {
  truck: string | null; odometerM: number | null; fuelL: number | null; gameMinutes?: string | null;
  position?: {x: number; y: number; z: number} | null;
}
export const SAVED_POSITION_METERS = 0.005, SAVED_FUEL_LITERS = 0.020;
/** Covers subtraction round-off at the recorded magnitude, not an additional physical allowance. */
export function savedEndpointLimits(point: SavedEndpoint): {position: number; fuel: number} {
  return {position: SAVED_POSITION_METERS + 2 * Number.EPSILON * Math.max(1, ...Object.values(point.position ?? {}).map(Math.abs)),
    fuel: SAVED_FUEL_LITERS + 2 * Number.EPSILON * Math.max(1, Math.abs(point.fuelL ?? 0))};
}
export function matchesSavedEndpoint(a: SavedEndpoint, b: SavedEndpoint, allowBoundaryDifferences = true): boolean {
  if (!a.truck || a.truck !== b.truck || a.odometerM === null || a.odometerM < 0 || a.odometerM !== b.odometerM
    || a.fuelL === null || b.fuelL === null || a.fuelL < 0 || b.fuelL < 0 || !a.gameMinutes || a.gameMinutes !== b.gameMinutes || !a.position || !b.position
    || ![a.odometerM,a.fuelL,b.fuelL,...Object.values(a.position),...Object.values(b.position)].every(Number.isFinite)) return false;
  const limits = allowBoundaryDifferences ? savedEndpointLimits(b) : {fuel:0,position:0};
  return Math.abs(a.fuelL-b.fuelL) <= limits.fuel
    && Math.hypot(a.position.x-b.position.x,a.position.y-b.position.y,a.position.z-b.position.z) <= limits.position;
}
