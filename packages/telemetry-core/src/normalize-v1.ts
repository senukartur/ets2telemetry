// Protocol v1 adapter. Gameplay-event records are normalized for later journal use (ET-016) and never shown live.
import type {
  Available, CurrentState, EventRecord, GearboxState, JobConfiguration, Money, SourceStatus, TrailerConfiguration, TruckConfiguration
} from '../../contracts/src/protocol-v1';
import {
  fromAvailable, mapReading, missing, valueOf, EVENT_LOSS_CAUSES, type Distance, type EventLossCause, type EventLossView, type LiveGearbox, type LiveJob, type LiveTrailer, type LiveTruck,
  type MoneyKind, type MoneyValue, type NamedEntity, type NormalizedLiveState, type Reading
} from './readings';

const entity = (id: Available<string>, name: Available<string>): NamedEntity => ({id: fromAvailable(id), name: fromAvailable(name)});

/** Maps wire money to a typed money reading. The raw digits stay a string; the currency basis is copied, never inferred. */
export function moneyReading<K extends MoneyKind>(kind: K, input: Available<Money>): Reading<MoneyValue<K>> {
  return mapReading(fromAvailable(input), money => ({
    kind, raw: money.raw, sdkType: money.sdkType,
    currency: money.currency.status === 'sdk-documented'
      ? {basis: 'sdk-documented' as const, code: money.currency.code, source: money.currency.source}
      : {basis: 'unknown' as const}
  }));
}
function distance<K extends Distance['kind']>(kind: K, input: Available<number>): Reading<Distance<K>> {
  return mapReading(fromAvailable(input), meters => ({kind, meters}));
}

export function normalizeV1Job(job: JobConfiguration): LiveJob {
  return {
    cargo: entity(job.cargoId, job.cargo), sourceCity: entity(job.sourceCityId, job.sourceCity),
    sourceCompany: entity(job.sourceCompanyId, job.sourceCompany), destinationCity: entity(job.destinationCityId, job.destinationCity),
    destinationCompany: entity(job.destinationCompanyId, job.destinationCompany),
    cargoMass: fromAvailable(job.cargoMass), market: fromAvailable(job.market), isSpecialJob: fromAvailable(job.isSpecialJob),
    cargoLoaded: fromAvailable(job.cargoLoaded), plannedDistance: distance('planned', job.plannedDistance),
    expectedIncome: moneyReading('expected-income', job.expectedIncome),
    deliveryDeadline: mapReading(fromAvailable(job.deliveryDeadline), minutes => BigInt(minutes))
  };
}
export function normalizeV1Truck(truck: TruckConfiguration): LiveTruck {
  return {
    brand: entity(truck.brandId, truck.brand), model: entity(truck.id, truck.name),
    licensePlate: fromAvailable(truck.licensePlate), plateCountry: entity(truck.plateCountryId, truck.plateCountry)
  };
}
export function normalizeV1Trailer(trailer: TrailerConfiguration): LiveTrailer {
  return {
    index: trailer.index, model: entity(trailer.id, trailer.name), brand: entity(trailer.brandId, trailer.brand),
    bodyType: fromAvailable(trailer.bodyType), chainType: fromAvailable(trailer.chainType), licensePlate: fromAvailable(trailer.licensePlate)
  };
}

/**
 * The minor-1 gearbox reading (ET-050b B2, B7). A state without `gearbox`, as every minor-0 state is, reports each part
 * `not-supported`: minor 0 never transports it. The layout is copied slot by slot in SDK slot order; nothing is derived.
 */
export function normalizeV1Gearbox(gearbox: GearboxState | undefined): Reading<LiveGearbox> {
  if (!gearbox) {
    const none = missing<never>('not-supported');
    return valueOf({forwardGears: none, reverseGears: none, hshifter: none});
  }
  return valueOf({
    forwardGears: fromAvailable(gearbox.forwardGears), reverseGears: fromAvailable(gearbox.reverseGears),
    hshifter: mapReading(fromAvailable(gearbox.hshifter), layout => ({
      selectorCount: layout.selectorCount, slots: layout.slots.map(slot => ({gear: slot.gear, handlePosition: slot.handlePosition, selectors: slot.selectors}))
    }))
  });
}

/**
 * Normalizes v1 current state. Without the status block (game mode and event loss), those readings are
 * `not-observed`. Hydrated checkpoint configuration is current state only and never implies a gameplay effect.
 * It reads neither the game window nor the delivery cursor, so the live projection without them (ET-010c) is accepted.
 */
export function normalizeV1State(state: Omit<CurrentState, 'window'>, status?: Pick<SourceStatus, 'gameMode' | 'eventLoss'>): NormalizedLiveState {
  const configuration = state.configuration;
  const eventLoss: Reading<EventLossView> = status
    ? valueOf(Object.freeze(Object.fromEntries(EVENT_LOSS_CAUSES.map(cause => [cause, BigInt(status.eventLoss[cause])])) as Record<EventLossCause, bigint>))
    : missing('not-observed');
  return {
    protocol: 'v1', simulation: state.simulation,
    speed: fromAvailable(state.speed), gear: fromAvailable(state.gear), engineRpm: fromAvailable(state.engineRpm),
    fuel: fromAvailable(state.fuel), fuelCapacity: fromAvailable(state.fuelCapacity),
    averageConsumption: fromAvailable(state.averageConsumption), estimatedRange: fromAvailable(state.estimatedRange),
    odometer: distance('odometer', state.odometer), navigationDistance: distance('navigation-remaining', state.navigationDistance),
    gameTime: {minutes: mapReading(fromAvailable(state.gameTime), minutes => BigInt(minutes)), clockId: state.gameTime.clockId},
    worldPlacement: mapReading(fromAvailable(state.worldPlacement), placement => ({
      position: {...placement.position}, orientation: {...placement.orientation}
    })),
    job: mapReading(fromAvailable(configuration.job), normalizeV1Job),
    truck: mapReading(fromAvailable(configuration.truck), normalizeV1Truck),
    trailers: valueOf(configuration.trailers.map(slot => mapReading(fromAvailable(slot), normalizeV1Trailer))),
    gameMode: status
      ? valueOf({mode: status.gameMode.mode, method: status.gameMode.method, confidence: status.gameMode.confidence, module: fromAvailable(status.gameMode.module)})
      : missing('not-observed'),
    eventLoss,
    gearbox: normalizeV1Gearbox(state.gearbox),
    configurationRevision: configuration.revision
  };
}

export interface DeliveredRecord {
  revenue: Reading<MoneyValue<'revenue'>>; earnedXp: Reading<number>; cargoDamage: Reading<number>;
  /** The game-reported job distance: not the planned distance and not the odometer. */
  distance: Reading<Distance<'game-delivered'>>;
  /** Game minutes, including any sleep or crossing inside the job (concept.md, October 13, 2026). */
  deliveryDuration: Reading<bigint>; autoParkUsed: Reading<boolean>; autoLoadUsed: Reading<boolean>;
}
export function normalizeDeliveredRecord(record: Extract<EventRecord, {type: 'job.delivered'}>): DeliveredRecord {
  return {
    revenue: moneyReading('revenue', record.revenue), earnedXp: fromAvailable(record.earnedXp), cargoDamage: fromAvailable(record.cargoDamage),
    distance: distance('game-delivered', record.distance),
    deliveryDuration: mapReading(fromAvailable(record.deliveryDuration), minutes => BigInt(minutes)),
    autoParkUsed: fromAvailable(record.autoParkUsed), autoLoadUsed: fromAvailable(record.autoLoadUsed)
  };
}
export interface CancelledRecord {penalty: Reading<MoneyValue<'penalty'>>}
export function normalizeCancelledRecord(record: Extract<EventRecord, {type: 'job.cancelled'}>): CancelledRecord {
  return {penalty: moneyReading('penalty', record.penalty)};
}
