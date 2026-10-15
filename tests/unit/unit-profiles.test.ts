import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {initialLive} from '../../apps/desktop/src/live-state';
import {
  DEFAULT_UNIT_PROFILES, displayGame, displayProfile, isUnitGame, isUnitProfile, profileFor, speedNumber, speedUnit, UNIT_GAMES, volumeNumber, volumeUnit
} from '../../apps/desktop/src/unit-profiles';
import {dashboardFuel, dashboardSpeed} from '../../apps/desktop/src/speed-display';

it('keeps the ET-000 defaults and the exact profile ids', () => {
  expect(DEFAULT_UNIT_PROFILES).toEqual({ets2: 'metric', ats: 'us-customary'});
  expect(UNIT_GAMES).toEqual(['ets2', 'ats']);
  for (const value of ['metric', 'us-customary']) expect(isUnitProfile(value)).toBe(true);
  for (const value of ['imperial', 'Metric', 'us_customary', '', undefined, null, 1, {}]) expect(isUnitProfile(value)).toBe(false);
  for (const value of ['synthetic', 'replay', 'game', 'ETS2', '', undefined]) expect(isUnitGame(value)).toBe(false);
});

it('applies the metric profile without a game and the game profile otherwise', () => {
  const units = {ets2: 'us-customary', ats: 'metric'} as const;
  expect(profileFor(units, undefined)).toBe('metric');
  expect(profileFor(units, 'ets2')).toBe('us-customary');
  expect(profileFor(units, 'ats')).toBe('metric');
});

it('takes the game from an explicit fixture source and otherwise only from an ETS2 or ATS selection', () => {
  const observed = (selection: LiveTelemetry['selection'], origin: 'game' | 'synthetic' | 'replay', game: 'ets2' | 'ats'): LiveTelemetry =>
    ({...initialLive(selection), observation: {source: {origin, game}} as NonNullable<LiveTelemetry['observation']>});
  expect(displayGame(initialLive('ats'))).toBe('ats');
  expect(displayGame(initialLive('ets2'))).toBe('ets2');
  expect(displayGame(initialLive('game'))).toBeUndefined();
  expect(displayGame(initialLive('synthetic'))).toBeUndefined();
  expect(displayGame(observed('synthetic', 'synthetic', 'ats'))).toBe('ats');
  expect(displayGame(observed('replay', 'replay', 'ets2'))).toBe('ets2');
  // A game-origin observation under a fixture selection names no trustworthy game.
  expect(displayGame(observed('synthetic', 'game', 'ats'))).toBeUndefined();
});

it('formats both profiles with telemetry-core conversions and no signed zero', () => {
  expect([speedUnit('metric'), volumeUnit('metric'), speedUnit('us-customary'), volumeUnit('us-customary')]).toEqual(['km/h', 'L', 'mph', 'US gal']);
  // 25 m/s = 90 km/h = 55.92 mph; 73 L = 19.28 US gal.
  expect([speedNumber(25, 'metric'), speedNumber(25, 'us-customary'), volumeNumber(73, 'metric'), volumeNumber(73, 'us-customary')]).toEqual(['90.0', '55.9', '73.0', '19.3']);
  for (const profile of ['metric', 'us-customary'] as const) {
    expect(speedNumber(-0, profile)).toBe('0.0'); expect(speedNumber(-0.001, profile)).toBe('0.0'); expect(volumeNumber(-0, profile)).toBe('0.0');
  }
  expect(speedNumber(-2, 'us-customary')).toBe('-4.5');
});

it('repeats no conversion constant in the desktop display projections', () => {
  // telemetry-core is the single numeric source (ET-010 N2); these modules may only call it.
  // ET-012a adds the overlay renderer's view model, its components and the overlay settings card.
  for (const file of ['unit-profiles.ts', 'overlay-presentation.ts', 'speed-display.ts', 'dashboard-renderer.tsx', 'overlay-view.ts', 'overlay-renderer.tsx',
    'overlay-settings-card.tsx']) {
    const source = readFileSync(`apps/desktop/src/${file}`, 'utf8');
    expect(source, file).not.toMatch(/\b(?:3\.6|2\.236\d*|3\.785\d*|1609\.344|0\.6213\d*|0\.4535\d*|235\.21\d*)\b/);
    expect(source, file).not.toMatch(/\.toFixed\(/);
  }
});

// Fix round 1: the dashboard's profile choice. Before or without persisted settings each game uses its ET-000 default,
// so an ATS dashboard shows mph and US gallons while ETS2 and no-game output stay metric.
it('selects the displayed game profile for the dashboard, with ATS defaulting to US customary', () => {
  const reading = (selection: LiveTelemetry['selection'], origin: 'game' | 'synthetic', game: 'ets2' | 'ats'): LiveTelemetry => ({
    ...initialLive(selection), status: 'connected', fresh: true,
    observation: {source: {origin, game}, state: {speed: {available: true, value: 25, unit: 'm/s'}, fuel: {available: true, value: 73, unit: 'L'}}} as NonNullable<LiveTelemetry['observation']>});
  expect(displayProfile(reading('ats', 'game', 'ats'))).toBe('us-customary');
  expect(displayProfile(reading('synthetic', 'synthetic', 'ats'))).toBe('us-customary');
  expect(displayProfile(reading('ets2', 'game', 'ets2'))).toBe('metric');
  expect(displayProfile(initialLive('game'))).toBe('metric');
  expect(displayProfile(undefined)).toBe('metric');
  const ats = reading('ats', 'game', 'ats');
  expect([dashboardSpeed(ats, displayProfile(ats)), dashboardFuel(ats, displayProfile(ats))]).toEqual(['55.9 mph', '19.3 US gal']);
  const ets2 = reading('ets2', 'game', 'ets2');
  expect([dashboardSpeed(ets2, displayProfile(ets2)), dashboardFuel(ets2, displayProfile(ets2))]).toEqual(['90.0 km/h', '73.0 L']);
  // Persisted settings replace the defaults.
  expect(displayProfile(ats, {ets2: 'metric', ats: 'metric'})).toBe('metric');
  expect(displayProfile(ets2, {ets2: 'us-customary', ats: 'us-customary'})).toBe('us-customary');
});
