import type {LiveTelemetry, OverlayPresentation} from '../../../packages/contracts/src';
import {displaySpeed} from './speed-display';

/** Canonical v0 m/s and liters remain unchanged; only this display projection converts. */
export function overlayPresentation(live: LiveTelemetry): OverlayPresentation {
  const observation = live.observation;
  const explicitFixture = (live.selection === 'synthetic' || live.selection === 'replay') && observation?.source.origin === live.selection;
  const game = explicitFixture ? observation.source.game : live.selection;
  const ats = game === 'ats';
  const current = live.fresh && (live.status === 'connected' || live.status === 'paused') &&
    (explicitFixture || (observation?.source.origin === 'game' && observation.source.game === live.selection));
  const state = observation?.state;
  return {
    source: ats ? 'ATS' : game === 'ets2' ? 'ETS2' : 'No game', origin: observation?.source.origin ?? 'none', status: live.status,
    speed: current && state?.speed.available ? displaySpeed(state.speed.value * (ats ? 2.2369362920544 : 3.6)) : '—',
    speedUnit: ats ? 'mph' : 'km/h',
    fuel: current && state?.fuel.available ? (state.fuel.value / (ats ? 3.785411784 : 1)).toFixed(1) : '—',
    fuelUnit: ats ? 'US gal' : 'L',
    freshness: current ? 'current' : live.status === 'stale' ? 'stale' : 'unavailable'
  };
}
