// REG-009 (and partial REG-004) normalization of the shared protocol fixtures. Every expected value below is written by
// hand from the fixture bytes and docs/protocol/v0.md and v1.md; none is produced by the code under test.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {
  normalizeCancelledRecord, normalizeDeliveredRecord, normalizeV0State, normalizeV1Gearbox, normalizeV1Job, normalizeV1State, normalizeV1Trailer,
  type MoneyValue, type Reading
} from '../../packages/telemetry-core/src';

const bytes = (dir: string, name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures', dir, `${name}.json`)));
function v0State(name: string): v0.CurrentState {
  const message = v0.decodePayload(bytes('protocol-v0', name));
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return message.data.state;
}
function v1Message(name: string): v1.ServerMessage {
  return v1.decodePayload(bytes('protocol-v1', name), 'server') as v1.ServerMessage;
}
function v1Record<T extends v1.EventRecord['type']>(name: string, type: T): Extract<v1.EventRecord, {type: T}> {
  const message = v1Message(name);
  if (message.kind !== 'event' || message.data.record.type !== type) throw new Error(`${name} is not a ${type} event`);
  return message.data.record as Extract<v1.EventRecord, {type: T}>;
}
function v1Checkpoint(name: string) {
  const message = v1Message(name);
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return message.data;
}
const value = <T>(v: T): Reading<T> => ({state: 'value', value: v});
const missing = (reason: string) => ({state: 'missing', reason});
const notCarried = missing('not-carried');

describe('REG-009 protocol v0 normalization', () => {
  it('normalizes the checkpoint fixture with zero speed, unavailable fuel and exact job values', () => {
    const state = normalizeV0State(v0State('checkpoint'));
    expect(state.protocol).toBe('v0');
    expect(state.simulation).toBe('running');
    expect(state.speed).toEqual(value(0));
    expect(state.fuel).toEqual(missing('not-observed'));
    expect(state.fuelCapacity).toEqual(value(1000));
    expect(state.engineRpm).toEqual(value(600));
    expect(state.gear).toEqual(value(-1));
    expect(state.odometer).toEqual(value({kind: 'odometer', meters: 1234567.5}));
    expect(state.averageConsumption).toEqual(value(25));
    expect(state.estimatedRange).toEqual(missing('not-observed'));
    expect(state.gameTime).toEqual({minutes: value(12345678n), clockId: '00000000-0000-4000-8000-000000000001'});
    expect(state.configurationRevision).toBe('9007199254740993');
    expect(state.truck).toEqual(value({
      brand: {id: notCarried, name: notCarried}, model: {id: value('truck.volvo'), name: notCarried},
      licensePlate: notCarried, plateCountry: {id: notCarried, name: notCarried}
    }));
    expect(state.job).toEqual(value({
      cargo: {id: value('cargo.logs'), name: notCarried}, sourceCity: {id: notCarried, name: notCarried},
      sourceCompany: {id: notCarried, name: notCarried}, destinationCity: {id: value('city.warszawa'), name: notCarried},
      destinationCompany: {id: notCarried, name: notCarried}, cargoMass: notCarried, market: notCarried, isSpecialJob: notCarried,
      cargoLoaded: notCarried, plannedDistance: value({kind: 'planned', meters: 200000}),
      expectedIncome: value({kind: 'expected-income', raw: '9007199254740993.123456', sdkType: 'v0-decimal', currency: {basis: 'unknown'}}),
      deliveryDeadline: notCarried
    }));
  });
  it('marks every field that v0 does not transport as not-carried, never not-supported', () => {
    const state = normalizeV0State(v0State('snapshot'));
    for (const reading of [state.navigationDistance, state.worldPlacement, state.trailers, state.gameMode, state.eventLoss, state.gearbox, state.nextMandatoryBreak]) expect(reading).toEqual(notCarried);
  });
  it('keeps each unavailable reason from the unavailable fixture', () => {
    const state = normalizeV0State(v0State('unavailable'));
    expect(state.simulation).toBe('unavailable');
    for (const reading of [state.speed, state.fuel, state.fuelCapacity, state.engineRpm, state.gear, state.odometer, state.averageConsumption,
      state.estimatedRange, state.gameTime.minutes, state.truck, state.job]) expect(reading).toEqual(missing('not-observed'));
    expect(state.configurationRevision).toBe('0');
  });
  it('maps the frozen v0 `verified` currency to sdk-documented and keeps replay origin data intact', () => {
    const state = normalizeV0State(v0State('ats'));
    expect(state.job.state === 'value' && state.job.value.expectedIncome).toEqual(value({
      kind: 'expected-income', raw: '9007199254740993.123456', sdkType: 'v0-decimal',
      currency: {basis: 'sdk-documented', code: 'USD', source: 'synthetic-test-only'}
    }));
  });
  it('treats an underflowed speed as a real zero reading, not unavailable', () => {
    expect(normalizeV0State(v0State('valid-underflow')).speed).toEqual(value(0));
  });
  it('preserves zero as a value and an explicit wire reason as missing', () => {
    const raw = v0State('snapshot');
    raw.fuel = {available: true, value: 0, unit: 'L'};
    raw.engineRpm = {available: false, reason: 'not-supported', unit: 'rpm'};
    raw.averageConsumption = {available: false, reason: 'invalid', unit: 'L/100km'};
    const state = normalizeV0State(raw);
    expect(state.fuel).toEqual(value(0));
    expect(state.engineRpm).toEqual(missing('not-supported'));
    expect(state.averageConsumption).toEqual(missing('invalid'));
  });
  it('converts SDK average consumption from L/km to the canonical L/100 km once, in the contracts mapping', () => {
    const measure = v0.normalizeSdkMeasurement('averageConsumption', {available: true, value: 0.3});
    const raw = v0State('snapshot');
    raw.averageConsumption = measure;
    const reading = normalizeV0State(raw).averageConsumption;
    expect(reading.state === 'value' && reading.value).toBeCloseTo(30, 12);
  });
});

describe('REG-009 protocol v1 normalization', () => {
  it('normalizes the snapshot fixture, including v1-only fields and status', () => {
    const data = v1Checkpoint('snapshot');
    const state = normalizeV1State(data.state, data.status);
    expect(state.protocol).toBe('v1');
    expect(state.speed).toEqual(missing('not-observed'));
    expect(state.fuel).toEqual(value(410.5));
    expect(state.gear).toEqual(value(3));
    expect(state.estimatedRange).toEqual(value(1263000));
    expect(state.navigationDistance).toEqual(value({kind: 'navigation-remaining', meters: 151000}));
    expect(state.gameTime).toEqual({minutes: value(12345n), clockId: '40000000-0000-4000-8000-000000000001'});
    expect(state.worldPlacement).toEqual(value({position: {x: -31234.5, y: 42.25, z: 18800.75}, orientation: {heading: 0.25, pitch: 0, roll: -0.01}}));
    expect(state.gameMode).toEqual(value({mode: 'single-player', method: 'module-scan', confidence: 'weak', module: missing('not-observed')}));
    expect(state.eventLoss).toEqual(value({offline: 0n, noDurableConsumer: 0n, queueCount: 0n, queueBytes: 0n, retentionExpired: 0n, encodingFailed: 0n}));
    expect(state.configurationRevision).toBe('8');
    if (state.job.state !== 'value') throw new Error('job expected');
    expect(state.job.value.cargo).toEqual({id: value('synthetic_cargo'), name: value('Synthetic Cargo')});
    expect(state.job.value.cargoMass).toEqual(value(18000));
    expect(state.job.value.cargoLoaded).toEqual(value(true));
    expect(state.job.value.plannedDistance).toEqual(value({kind: 'planned', meters: 152000}));
    expect(state.job.value.deliveryDeadline).toEqual(value(13000n));
    expect(state.job.value.expectedIncome).toEqual(value({kind: 'expected-income', raw: '12345', sdkType: 'u64', currency: {basis: 'unknown'}}));
    expect(state.truck).toEqual(value({
      brand: {id: value('synthetic_brand'), name: value('Synthetic Brand')}, model: {id: value('vehicle.synthetic_truck'), name: value('Synthetic Truck')},
      licensePlate: value('SYN 0001'), plateCountry: {id: value('synthetica'), name: value('Synthetica')}
    }));
    expect(state.trailers).toEqual(value([value({
      index: 0, model: {id: value('trailer.synthetic_box'), name: missing('not-observed')}, brand: {id: missing('not-observed'), name: missing('not-observed')},
      bodyType: value('dryvan'), chainType: value('single'), licensePlate: value('SYN 0002')
    })]));
  });
  it('reports game mode and event loss as not-observed without a status block', () => {
    const state = normalizeV1State(v1Checkpoint('snapshot').state);
    expect(state.gameMode).toEqual(missing('not-observed'));
    expect(state.eventLoss).toEqual(missing('not-observed'));
  });
  it('keeps worst-case text, uint64 extremes and strong TruckersMP evidence exactly', () => {
    const data = v1Checkpoint('checkpoint-worst');
    const state = normalizeV1State(data.state, data.status);
    // The fixture fills ids to 128 and names to 256 characters with escape-heavy text: `"\"\"…\` and `\"\"…`.
    const id = '"' + '\\"'.repeat(63) + '\\', name = '\\"'.repeat(128), max = 18446744073709551615n;
    expect(state.speed).toEqual(value(-1.2345678901234568e-300));
    expect(state.gear).toEqual(value(-100));
    expect(state.gameTime.minutes).toEqual(value(4294967295n));
    expect(state.configurationRevision).toBe('18446744073709551615');
    if (state.job.state !== 'value' || state.truck.state !== 'value' || state.trailers.state !== 'value') throw new Error('configuration expected');
    expect(state.job.value.sourceCity).toEqual({id: value(id), name: value(name)});
    expect(state.job.value.plannedDistance).toEqual(value({kind: 'planned', meters: 4294967295000}));
    expect(state.job.value.deliveryDeadline).toEqual(value(4294967295n));
    const income = state.job.value.expectedIncome;
    expect(income.state === 'value' && [income.value.raw, income.value.sdkType, income.value.currency.basis]).toEqual(['18446744073709551615', 'u64', 'sdk-documented']);
    expect(state.truck.value.licensePlate).toEqual(value(name));
    expect(state.trailers.value).toHaveLength(10);
    expect(state.trailers.value.map(slot => slot.state === 'value' && slot.value.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(state.gameMode.state === 'value' && [state.gameMode.value.mode, state.gameMode.value.method, state.gameMode.value.confidence, state.gameMode.value.module])
      .toEqual(['truckersmp', 'module-scan', 'strong', value(id)]);
    expect(state.eventLoss).toEqual(value({offline: max, noDurableConsumer: max, queueCount: max, queueBytes: max, retentionExpired: max, encodingFailed: max}));
  });
  it('keeps localized names next to their stable ids', () => {
    const job = normalizeV1Job(v1Record('event-job-configured-localized', 'job.configured'));
    expect(job.sourceCity).toEqual({id: value('synthetic_city_a'), name: value('Синтетический город')});
    expect(job.destinationCity).toEqual({id: value('synthetic_city_b'), name: value('Ciudad Sintética')});
    expect(job.cargo).toEqual({id: value('synthetic_cargo'), name: value('Синтетический груз 🚚')});
  });
  it('keeps not-observed and not-supported text distinct', () => {
    const job = normalizeV1Job(v1Record('event-job-configured-unobserved-text', 'job.configured'));
    expect(job.sourceCompany).toEqual({id: missing('not-observed'), name: missing('not-observed')});
    expect(job.destinationCompany).toEqual({id: missing('not-supported'), name: missing('not-supported')});
    expect(job.isSpecialJob).toEqual(value(true));
  });
  it('copies the SDK-documented currency without inferring one', () => {
    const job = normalizeV1Job(v1Record('event-job-configured-documented-currency', 'job.configured'));
    expect(job.expectedIncome).toEqual(value({
      kind: 'expected-income', raw: '12345', sdkType: 'u64',
      currency: {basis: 'sdk-documented', code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'}
    }));
  });
  it('keeps the uint64 maximum expected income as exact digits', () => {
    const job = normalizeV1Job(v1Record('money-uint64-max', 'job.configured'));
    expect(job.expectedIncome).toEqual(value({kind: 'expected-income', raw: '18446744073709551615', sdkType: 'u64', currency: {basis: 'unknown'}}));
  });
  it('keeps a zero revenue as a value and an unavailable revenue as missing', () => {
    const zero = normalizeDeliveredRecord(v1Record('event-job-delivered-zero-revenue', 'job.delivered'));
    expect(zero).toEqual({
      revenue: value({kind: 'revenue', raw: '0', sdkType: 's64', currency: {basis: 'unknown'}}), earnedXp: value(250), cargoDamage: value(0.0125),
      distance: value({kind: 'game-delivered', meters: 151250.5}), deliveryDuration: value(471n), autoParkUsed: value(false), autoLoadUsed: value(true)
    });
    const unavailable = normalizeDeliveredRecord(v1Record('event-job-delivered-unavailable-revenue', 'job.delivered'));
    expect(unavailable.revenue).toEqual(missing('not-observed'));
    expect(unavailable.earnedXp).toEqual(missing('not-supported'));
    expect(unavailable.cargoDamage).toEqual(missing('invalid'));
  });
  it('keeps the int64 minimum penalty as exact digits', () => {
    expect(normalizeCancelledRecord(v1Record('money-int64-min', 'job.cancelled'))).toEqual({
      penalty: value({kind: 'penalty', raw: '-9223372036854775808', sdkType: 's64', currency: {basis: 'unknown'}})
    });
  });
  it('keeps a provided empty trailer string distinct from a missing name', () => {
    const record = v1Record('event-trailer-configured', 'trailer.configured');
    expect(record.cargoAccessoryId).toEqual({available: true, value: ''});
    const trailer = normalizeV1Trailer(record);
    expect(trailer.model).toEqual({id: value('trailer.synthetic_box'), name: missing('not-observed')});
    expect(trailer.bodyType).toEqual(value('dryvan'));
    const empty = normalizeV1Trailer({...record, name: {available: true, value: ''}});
    expect(empty.model.name).toEqual(value(''));
  });
});

// ET-050b B2, B7: the minor-1 gearbox reading. Inputs are the minor-1 fixtures; expected values are written by hand.
describe('ET-050b gearbox normalization', () => {
  const minor1 = (name: string) => {
    const m = v1.decodePayload(bytes('protocol-v1/minor1', name), 'server', {maxMinor: 1}) as v1.ServerMessage;
    if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
    return m.data;
  };
  it('copies the 12-speed counts and layout slot by slot, deriving nothing', () => {
    const {state, status} = minor1('checkpoint');
    expect(normalizeV1State(state, status).gearbox).toEqual(value({
      forwardGears: value(12), reverseGears: value(4),
      hshifter: value({selectorCount: 2, slots: [
        {gear: -1, handlePosition: 1, selectors: 0}, {gear: -3, handlePosition: 1, selectors: 1}, {gear: -2, handlePosition: 1, selectors: 2}, {gear: -4, handlePosition: 1, selectors: 3},
        {gear: 1, handlePosition: 2, selectors: 0}, {gear: 7, handlePosition: 2, selectors: 1}, {gear: 2, handlePosition: 2, selectors: 2}, {gear: 8, handlePosition: 2, selectors: 3},
        {gear: 3, handlePosition: 3, selectors: 0}, {gear: 9, handlePosition: 3, selectors: 1}, {gear: 4, handlePosition: 3, selectors: 2}, {gear: 10, handlePosition: 3, selectors: 3},
        {gear: 5, handlePosition: 4, selectors: 0}, {gear: 11, handlePosition: 4, selectors: 1}, {gear: 6, handlePosition: 4, selectors: 2}, {gear: 12, handlePosition: 4, selectors: 3}]})
    }));
  });
  it('keeps the availability of each part', () => {
    expect(normalizeV1State(minor1('snapshot-counts-not-observed').state).gearbox).toMatchObject(value({forwardGears: missing('not-observed'), reverseGears: missing('not-observed')}));
    expect(normalizeV1State(minor1('snapshot-hshifter-invalid').state).gearbox).toMatchObject(value({hshifter: missing('invalid')}));
    expect(normalizeV1State(minor1('snapshot-gearbox-not-supported').state).gearbox)
      .toEqual(value({forwardGears: missing('not-supported'), reverseGears: missing('not-supported'), hshifter: missing('not-supported')}));
  });
  it('reports every part not-supported for a minor-0 state, which carries no gearbox', () => {
    const none = value({forwardGears: missing('not-supported'), reverseGears: missing('not-supported'), hshifter: missing('not-supported')});
    expect(normalizeV1State(v1Checkpoint('snapshot').state).gearbox).toEqual(none);
    expect(normalizeV1Gearbox(undefined)).toEqual(none);
  });
});

describe('money and distance kinds', () => {
  it('rejects mixing money kinds at compile time', () => {
    const revenue: MoneyValue<'revenue'> = {kind: 'revenue', raw: '0', sdkType: 's64', currency: {basis: 'unknown'}};
    // @ts-expect-error Revenue is not expected income.
    const income: MoneyValue<'expected-income'> = revenue;
    expect(income.kind).toBe('revenue');
  });
});
