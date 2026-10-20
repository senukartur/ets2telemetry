import type {AppLanguage, LiveTelemetry, UnitProfile} from '../../../packages/contracts/src';
import {speedNumber, speedUnit, volumeNumber, volumeUnit} from './unit-profiles';
import {translateUnit} from './i18n';

/**
 * Dashboard speed in the displayed game's profile, with the existing freshness gate. Canonical signed speed is not
 * changed; a negative value means reverse. The default profile is metric.
 */
export function dashboardSpeed(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric', language: AppLanguage = 'en'): string {
  const speed = live?.observation?.state.speed;
  const unit = translateUnit(speedUnit(profile), language);
  const unavail = language === 'ru' ? 'недоступно' : 'unavailable';
  return live?.fresh && speed?.available ? `${speedNumber(speed.value, profile)} ${unit}` : unavail;
}

/** Dashboard fuel in the displayed game's profile, with the same freshness gate. */
export function dashboardFuel(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric', language: AppLanguage = 'en'): string {
  const fuel = live?.observation?.state.fuel;
  const unit = translateUnit(volumeUnit(profile), language);
  const unavail = language === 'ru' ? 'недоступно' : 'unavailable';
  return live?.fresh && fuel?.available ? `${volumeNumber(fuel.value, profile)} ${unit}` : unavail;
}
