// Exact unit-conversion constants and pure numeric conversions from canonical units (m/s, m, L, L/100km, kg).
// Canonical values are never changed; every function returns a new display-unit number.

/** International mile (1959 agreement), exact. */
export const METERS_PER_MILE = 1609.344;
/** US liquid gallon, exact. */
export const LITERS_PER_US_GALLON = 3.785411784;
/** International avoirdupois pound, exact. */
export const KILOGRAMS_PER_POUND = 0.45359237;
export const MPS_TO_KMH = 3.6;
export const MPS_TO_MPH = 3600 / METERS_PER_MILE;
/**
 * US mpg = L100KM_US_MPG / (L/100 km). Derived from the exact mile and gallon (235.2145833…); the rounded 235.215
 * is not used.
 */
export const L100KM_US_MPG = 100 * LITERS_PER_US_GALLON / (METERS_PER_MILE / 1000);

export type SpeedUnit = 'km/h' | 'mph';
export type DistanceUnit = 'km' | 'mi';
export type VolumeUnit = 'L' | 'US gal';
export type ConsumptionUnit = 'L/100 km' | 'US mpg';
export type MassUnit = 't' | 'lb';

export function convertSpeed(metersPerSecond: number, unit: SpeedUnit): number {
  return metersPerSecond * (unit === 'mph' ? MPS_TO_MPH : MPS_TO_KMH);
}
export function convertDistance(meters: number, unit: DistanceUnit): number {
  return meters / (unit === 'mi' ? METERS_PER_MILE : 1000);
}
export function convertVolume(liters: number, unit: VolumeUnit): number {
  return unit === 'US gal' ? liters / LITERS_PER_US_GALLON : liters;
}
export function convertMass(kilograms: number, unit: MassUnit): number {
  return unit === 'lb' ? kilograms / KILOGRAMS_PER_POUND : kilograms / 1000;
}
/**
 * Converts the SDK mean consumption. US mpg is the reciprocal, so zero, negative or non-finite L/100 km has no mpg
 * value and returns undefined; the caller reports it as non-numeric instead of inventing an infinite economy.
 */
export function convertConsumption(litersPer100Km: number, unit: ConsumptionUnit): number | undefined {
  if (!Number.isFinite(litersPer100Km) || litersPer100Km < 0) return undefined;
  if (unit === 'L/100 km') return litersPer100Km;
  return litersPer100Km > 0 ? L100KM_US_MPG / litersPer100Km : undefined;
}
