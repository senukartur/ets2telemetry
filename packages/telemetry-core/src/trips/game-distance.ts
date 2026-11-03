import {MAX_PLAUSIBLE_SPEED_MPS, odometerJumpMargin, type OdometerStep} from '../derived';

export const GAME_TIME_JUMP_MINUTES = 30, GAME_TIME_JUMP_RATE = 60;

export interface GameDistancePoint {
  odometerM: number | null; speedMps: number | null; gameMinutes: string | null;
  position: {x: number; y: number; z: number} | null;
}
/** Callers establish source, truck, game-clock and uninterrupted running ownership before comparing these points. */
export function gameDistanceStep(a: GameDistancePoint, b: GameDistancePoint, elapsed: number): OdometerStep {
  if (a.odometerM === null || b.odometerM === null || !Number.isFinite(elapsed) || elapsed < 0) return {kind: 'unavailable'};
  const meters = b.odometerM - a.odometerM;
  if (meters < 0) return {kind: 'discontinuity', cause: 'odometer-regressed'};
  if (meters === 0) return {kind: 'continuous', meters};
  if (a.position === null || b.position === null || a.speedMps === null || b.speedMps === null || a.gameMinutes === null || b.gameMinutes === null) return {kind: 'unavailable'};
  if (![a.odometerM, b.odometerM, a.speedMps, b.speedMps, ...Object.values(a.position), ...Object.values(b.position)].every(Number.isFinite)) return {kind: 'unavailable'};
  const motion = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z);
  const speed = Math.max(Math.abs(a.speedMps), Math.abs(b.speedMps));
  if (motion <= 0 || speed <= 0 || speed > MAX_PLAUSIBLE_SPEED_MPS || motion > MAX_PLAUSIBLE_SPEED_MPS * elapsed + 50) return {kind: 'discontinuity', cause: 'odometer-jump'};
  const minutes = BigInt(b.gameMinutes) - BigInt(a.gameMinutes);
  if (minutes < 0n) return {kind: 'unavailable'};
  if (minutes >= BigInt(GAME_TIME_JUMP_MINUTES) && Number(minutes) * 60 > GAME_TIME_JUMP_RATE * elapsed) return {kind:'discontinuity',cause:'odometer-jump'};
  // SDK local.scale affects both odometer and time-of-day. Whole-minute timestamps leave less than one minute of
  // quantization uncertainty; use that interval, never an inferred/hardcoded map scale or a real-time distance cap.
  const seconds = Number(minutes + 1n) * 60;
  if (meters > MAX_PLAUSIBLE_SPEED_MPS * seconds + odometerJumpMargin(a.odometerM, b.odometerM)) return {kind: 'discontinuity', cause: 'odometer-jump'};
  return {kind: 'continuous', meters};
}
