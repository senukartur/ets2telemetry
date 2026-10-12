import type {LiveTelemetry} from '../../../packages/contracts/src';

/** Round in the chosen display unit without changing canonical signed speed. */
export function displaySpeed(value: number): string {
  const rounded = value.toFixed(1);
  return rounded === '-0.0' ? '0.0' : rounded;
}

/** The diagnostic dashboard retains its existing freshness gate and km/h unit. */
export function dashboardSpeed(live: LiveTelemetry | undefined): string {
  const speed = live?.observation?.state.speed;
  return live?.fresh && speed?.available ? `${displaySpeed(speed.value * 3.6)} km/h` : 'unavailable';
}
