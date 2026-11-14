import type {AppLanguage, LiveTelemetry, UnitProfile} from '../../../packages/contracts/src';
import {speedNumber, speedUnit, volumeNumber, volumeUnit} from './unit-profiles';
import {translateUnit} from './i18n';
import {isCurrent} from '../../../packages/telemetry-core/src/live-view';
import {localizedMeasurement} from './screens/app-copy';
import {formatTruckAmount} from '../../../packages/telemetry-core/src/format';
import {truckPowertrain} from '../../../packages/telemetry-core/src/truck-powertrain';
import {getStrings} from './strings';

/**
 * Dashboard speed in the displayed game's profile, with the existing freshness gate. Canonical signed speed is not
 * changed; a negative value means reverse. The default profile is metric.
 */
export function dashboardSpeed(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric', language: AppLanguage = 'en'): string {
  const speed = live?.observation?.state.speed;
  const unit = translateUnit(speedUnit(profile), language);
  const unavail = getStrings(language).unavailableText;
  return live?.fresh && speed?.available ? `${speedNumber(speed.value, profile)} ${unit}` : unavail;
}

/** Dashboard fuel in the displayed game's profile, with the same freshness gate. */
export function dashboardFuel(live: LiveTelemetry | undefined, profile: UnitProfile = 'metric', language: AppLanguage = 'en'): string {
  const fuel = live?.observation?.state.fuel;
  const truckId = live?.observation?.state.configuration.truckId;
  const type = truckPowertrain(live?.observation?.source.game, truckId?.available ? truckId.value : undefined);
  return live && isCurrent(live) && fuel?.available && type !== 'unknown'
    ? type === 'electric' ? localizedMeasurement(formatTruckAmount(fuel.value, 'kWh', 1), language)
      : `${volumeNumber(fuel.value, profile)} ${translateUnit(volumeUnit(profile), language)}`
    : getStrings(language).unavailableText;
}
