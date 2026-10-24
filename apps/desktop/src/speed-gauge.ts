import type {UnitProfile} from '../../../packages/contracts/src';
import {convertSpeed, type SpeedUnit} from '../../../packages/telemetry-core/src/units';
import {speedNumber, speedUnit} from './unit-profiles';

// The speed gauge scale shared by the dashboard's Live instrument and the Cluster overlay's speed arc (ET-045f). Pure, without
// Node built-ins, so main, the renderers and plain Node tests share one rule. Conversion and rounding stay in telemetry-core.

/** Full scale of the speed gauge in each display unit: the Live instrument's 0-130 km/h and 0-80 mph dials. */
export const SPEED_GAUGE_FULL_SCALE: Readonly<Record<SpeedUnit, number>> = Object.freeze({'km/h': 130, mph: 80});

/**
 * The gauge fraction in [0, 1] of a canonical m/s speed on the scale of the profile's speed unit. It follows the displayed
 * integer: a speed that shows as 0 (ET-045a) or a reverse speed gives 0, so no arc is drawn; above 0 the fraction keeps its
 * fractional precision and is capped at 1. A speed that is not finite has no fraction (undefined). The displayed text is
 * produced by the same telemetry-core formatter as the overlay and dashboard speed, never parsed back.
 */
export function speedGaugeFraction(metersPerSecond: number, profile: UnitProfile): number | undefined {
  if (!Number.isFinite(metersPerSecond)) return undefined;
  if (speedNumber(metersPerSecond, profile) === '0') return 0;
  const unit = speedUnit(profile);
  return Math.min(1, Math.max(0, convertSpeed(metersPerSecond, unit) / SPEED_GAUGE_FULL_SCALE[unit]));
}
