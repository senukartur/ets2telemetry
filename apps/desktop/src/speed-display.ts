import type {LiveTelemetry, UnitProfile} from '../../../packages/contracts/src';
import {speedNumber, speedUnit, volumeNumber, volumeUnit} from './unit-profiles';

/**
 * Dashboard speed in the displayed game's profile, with the existing freshness gate. Canonical signed speed is not
 * changed; a negative value means reverse. The default profile is metric.
 */
export function dashboardSpeed(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric'): string {
  const speed = live?.observation?.state.speed;
  return live?.fresh && speed?.available ? `${speedNumber(speed.value, profile)} ${speedUnit(profile)}` : 'unavailable';
}

/** Dashboard fuel in the displayed game's profile, with the same freshness gate. */
export function dashboardFuel(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric'): string {
  const fuel = live?.observation?.state.fuel;
  return live?.fresh && fuel?.available ? `${volumeNumber(fuel.value, profile)} ${volumeUnit(profile)}` : 'unavailable';
}
