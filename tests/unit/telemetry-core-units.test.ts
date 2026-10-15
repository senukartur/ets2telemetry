// REG-009 unit conversion and per-game display profiles. Expected values are written by hand from the exact unit
// definitions (international mile 1609.344 m, US gallon 3.785411784 L, pound 0.45359237 kg).
import {describe, expect, it} from 'vitest';
import {
  convertConsumption, convertDistance, convertMass, convertSpeed, convertVolume, DEFAULT_DISPLAY_PROFILE, DISPLAY_PROFILE_IDS,
  KILOGRAMS_PER_POUND, L100KM_US_MPG, LITERS_PER_US_GALLON, METERS_PER_MILE, MPS_TO_KMH, MPS_TO_MPH, resolveDisplayUnits,
  type DisplaySelection
} from '../../packages/telemetry-core/src';

describe('REG-009 exact conversion constants', () => {
  it('uses the exact international definitions', () => {
    expect(METERS_PER_MILE).toBe(1609.344);
    expect(LITERS_PER_US_GALLON).toBe(3.785411784);
    expect(KILOGRAMS_PER_POUND).toBe(0.45359237);
    expect(MPS_TO_KMH).toBe(3.6);
    expect(MPS_TO_MPH).toBeCloseTo(2.2369362920544, 12);
  });
  it('derives the L/100 km to US mpg constant exactly instead of the rounded 235.215', () => {
    expect(L100KM_US_MPG).toBeCloseTo(235.2145833333, 9);
    expect(Math.abs(L100KM_US_MPG - 235.215)).toBeGreaterThan(4e-4);
  });
  it('converts canonical values without rounding', () => {
    expect(convertSpeed(10, 'km/h')).toBeCloseTo(36, 12);
    expect(convertSpeed(10, 'mph')).toBeCloseTo(22.369362920544, 10);
    expect(convertSpeed(-2, 'km/h')).toBeCloseTo(-7.2, 12);
    expect(convertDistance(1609.344, 'mi')).toBe(1);
    expect(convertDistance(200_000, 'km')).toBe(200);
    expect(convertVolume(3.785411784, 'US gal')).toBe(1);
    expect(convertVolume(410.5, 'L')).toBe(410.5);
    expect(convertMass(18_000, 't')).toBe(18);
    expect(convertMass(0.45359237, 'lb')).toBe(1);
    expect(convertConsumption(30, 'L/100 km')).toBe(30);
    expect(convertConsumption(30, 'US mpg')).toBeCloseTo(7.84048611, 7);
  });
  it('has no US mpg for zero, negative or non-finite consumption', () => {
    expect(convertConsumption(0, 'US mpg')).toBeUndefined();
    expect(convertConsumption(0, 'L/100 km')).toBe(0);
    expect(convertConsumption(-1, 'US mpg')).toBeUndefined();
    expect(convertConsumption(Number.NaN, 'L/100 km')).toBeUndefined();
  });
});

describe('per-game display profiles', () => {
  it('lists the two profiles and the ET-000 game defaults', () => {
    expect(DISPLAY_PROFILE_IDS).toEqual(['metric', 'us-customary']);
    expect(DEFAULT_DISPLAY_PROFILE).toEqual({ets2: 'metric', ats: 'us-customary'});
  });
  it('resolves ETS2 to metric, ATS to US customary and no game to metric', () => {
    expect(resolveDisplayUnits('ets2')).toEqual({profile: 'metric', speed: 'km/h', distance: 'km', volume: 'L', consumption: 'L/100 km', mass: 't'});
    expect(resolveDisplayUnits('ats')).toEqual({profile: 'us-customary', speed: 'mph', distance: 'mi', volume: 'US gal', consumption: 'US mpg', mass: 'lb'});
    expect(resolveDisplayUnits(undefined)).toEqual({profile: 'metric', speed: 'km/h', distance: 'km', volume: 'L', consumption: 'L/100 km', mass: 't'});
  });
  it('applies an explicit profile and per-quantity overrides', () => {
    expect(resolveDisplayUnits('ats', {profile: 'metric'}).speed).toBe('km/h');
    expect(resolveDisplayUnits('ets2', {overrides: {speed: 'mph', consumption: 'US mpg'}}))
      .toEqual({profile: 'metric', speed: 'mph', distance: 'km', volume: 'L', consumption: 'US mpg', mass: 't'});
    expect(resolveDisplayUnits('ats', {profile: 'us-customary', overrides: {volume: 'L'}}).volume).toBe('L');
  });
  it('ignores unknown stored profile ids and override values', () => {
    const stale = {profile: 'imperial', overrides: {speed: 'knots', mass: 'lb'}} as unknown as DisplaySelection;
    expect(resolveDisplayUnits('ets2', stale)).toEqual({profile: 'metric', speed: 'km/h', distance: 'km', volume: 'L', consumption: 'L/100 km', mass: 'lb'});
  });
  it('does not mutate the shared profile table', () => {
    resolveDisplayUnits('ets2', {overrides: {speed: 'mph'}});
    expect(resolveDisplayUnits('ets2').speed).toBe('km/h');
  });
});
