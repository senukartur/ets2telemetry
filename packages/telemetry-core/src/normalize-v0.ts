// Protocol v0 adapter. v0 carries a reduced field set; everything it does not transport is `not-carried`.
import type {CurrentState} from '../../contracts/src/protocol-v0';
import {fromAvailable, mapReading, NOT_CARRIED, valueOf, type LiveJob, type LiveTruck, type MoneyValue, type NamedEntity, type NormalizedLiveState, type Reading} from './readings';

const idOnly = (id: Reading<string>): NamedEntity => ({id, name: NOT_CARRIED});
const notCarriedEntity = (): NamedEntity => ({id: NOT_CARRIED, name: NOT_CARRIED});

/** v0 `verified` is a frozen wire spelling for an SDK-documented currency, not a runtime observation. */
function expectedIncome(income: {rawValue: string; currency: {status: 'unknown'} | {status: 'verified'; code: string; source: string}}): MoneyValue<'expected-income'> {
  const currency = income.currency.status === 'verified'
    ? {basis: 'sdk-documented' as const, code: income.currency.code, source: income.currency.source}
    : {basis: 'unknown' as const};
  return {kind: 'expected-income', raw: income.rawValue, sdkType: 'v0-decimal', currency};
}

export function normalizeV0State(state: CurrentState): NormalizedLiveState {
  const configuration = state.configuration;
  const job: Reading<LiveJob> = mapReading(fromAvailable(configuration.job), value => ({
    // v0 sends no empty identifiers: an empty source identifier is already unavailable on the wire.
    cargo: idOnly(valueOf(value.cargoId)), sourceCity: notCarriedEntity(), sourceCompany: notCarriedEntity(),
    destinationCity: idOnly(valueOf(value.destinationCityId)), destinationCompany: notCarriedEntity(),
    cargoMass: NOT_CARRIED, market: NOT_CARRIED, isSpecialJob: NOT_CARRIED, cargoLoaded: NOT_CARRIED,
    plannedDistance: mapReading(fromAvailable(value.plannedDistance), meters => ({kind: 'planned' as const, meters})),
    expectedIncome: valueOf(expectedIncome(value.expectedIncome)),
    deliveryDeadline: NOT_CARRIED
  }));
  const truck: Reading<LiveTruck> = mapReading(fromAvailable(configuration.truckId), id => ({
    brand: notCarriedEntity(), model: idOnly(valueOf(id)), licensePlate: NOT_CARRIED, plateCountry: notCarriedEntity()
  }));
  return {
    protocol: 'v0', simulation: state.simulation,
    speed: fromAvailable(state.speed), gear: fromAvailable(state.gear), engineRpm: fromAvailable(state.engineRpm),
    fuel: fromAvailable(state.fuel), fuelCapacity: fromAvailable(state.fuelCapacity),
    averageConsumption: fromAvailable(state.averageConsumption), estimatedRange: fromAvailable(state.estimatedRange),
    odometer: mapReading(fromAvailable(state.odometer), meters => ({kind: 'odometer' as const, meters})),
    navigationDistance: NOT_CARRIED,
    gameTime: {minutes: mapReading(fromAvailable(state.gameTime), minutes => BigInt(minutes)), clockId: state.gameTime.clockId},
    worldPlacement: NOT_CARRIED, job, truck, trailers: NOT_CARRIED, gameMode: NOT_CARRIED, eventLoss: NOT_CARRIED, gearbox: NOT_CARRIED,
    nextMandatoryBreak: NOT_CARRIED,
    configurationRevision: configuration.revision
  };
}
