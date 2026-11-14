export type TruckPowertrain = 'electric' | 'diesel' | 'unknown';
export type TruckEnergyUnit = 'kWh' | 'L';

export function isTruckPowertrain(value: unknown): value is TruckPowertrain {
  return value === 'electric' || value === 'diesel' || value === 'unknown';
}
