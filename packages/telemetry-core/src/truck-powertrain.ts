import type {TruckEnergyUnit, TruckPowertrain} from '../../contracts/src/truck-powertrain';
import type {NormalizedLiveState} from './readings';

const ELECTRIC_TRUCK_IDS: Readonly<Record<'ets2' | 'ats', ReadonlySet<string>>> = {
  ets2: new Set(['vehicle.daf.xf_electric', 'vehicle.renault.etech_t', 'vehicle.scania.s_2024e']),
  ats: new Set(['vehicle.volvo.vnr_e'])
};

/** The SDK reports a model ID, which identifies a stock model's powertrain. */
export function truckPowertrain(game: 'ets2' | 'ats' | undefined, modelId: string | null | undefined): TruckPowertrain {
  if (!game || !modelId) return 'unknown';
  return ELECTRIC_TRUCK_IDS[game].has(modelId) ? 'electric' : 'diesel';
}

export function liveTruckPowertrain(game: 'ets2' | 'ats' | undefined, truck: NormalizedLiveState['truck'] | undefined): TruckPowertrain {
  const id = truck?.state === 'value' ? truck.value.model.id : undefined;
  return truckPowertrain(game, id?.state === 'value' ? id.value : undefined);
}

export function truckEnergyUnit(powertrain: TruckPowertrain): TruckEnergyUnit | null {
  return powertrain === 'electric' ? 'kWh' : powertrain === 'diesel' ? 'L' : null;
}
