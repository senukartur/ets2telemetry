import type {LiveTelemetry, OverlayPresentation, UnitProfiles} from '../../../packages/contracts/src';
import {DEFAULT_UNIT_PROFILES, displayGame, isExplicitFixture, profileFor, speedNumber, speedUnit, volumeNumber, volumeUnit} from './unit-profiles';

/**
 * Canonical v0 m/s and liters remain unchanged; only this display projection converts, in the persisted profile of
 * the displayed game (ETS2 metric and ATS US customary by default; metric without a game).
 */
export function overlayPresentation(live: LiveTelemetry, units: UnitProfiles = DEFAULT_UNIT_PROFILES): OverlayPresentation {
  const observation = live.observation;
  const explicitFixture = isExplicitFixture(live);
  const game = displayGame(live), profile = profileFor(units, game);
  const current = live.fresh && (live.status === 'connected' || live.status === 'paused') &&
    (explicitFixture || (observation?.source.origin === 'game' && observation.source.game === live.selection));
  const state = observation?.state;
  return {
    source: game === 'ats' ? 'ATS' : game === 'ets2' ? 'ETS2' : 'No game', origin: observation?.source.origin ?? 'none', status: live.status,
    speed: current && state?.speed.available ? speedNumber(state.speed.value, profile) : '—',
    speedUnit: speedUnit(profile),
    fuel: current && state?.fuel.available ? volumeNumber(state.fuel.value, profile) : '—',
    fuelUnit: volumeUnit(profile),
    freshness: current ? 'current' : live.status === 'stale' ? 'stale' : 'unavailable'
  };
}
