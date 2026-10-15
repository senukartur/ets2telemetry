// REG-009 live view, with partial REG-003 (hydration, stale) and REG-002 (pause) live-display protection. Expected
// texts are written by hand from the shared fixtures and the rules in docs/live-telemetry-fields.md.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {
  buildLiveView, isCurrent, normalizeV0State, normalizeV1State, resolveDisplayUnits, type LiveDashboardView, type LiveField,
  type NormalizedLiveState, type Reading
} from '../../packages/telemetry-core/src';

type V0State = Extract<v0.ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
function v0Message(name: string): V0State {
  const message = v0.decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v0/${name}.json`)));
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return message;
}
function v1Data(name: string) {
  const message = v1.decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/${name}.json`)), 'server');
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return message.data;
}
function live(name = 'checkpoint', patch: Partial<LiveTelemetry> = {}, origin?: 'game' | 'synthetic' | 'replay'): LiveTelemetry {
  const message = v0Message(name);
  return {
    selection: message.source.game, status: 'connected', reason: '', fresh: true, recording: false, coverage: 'unknown',
    observation: {
      source: {...message.source, origin: origin ?? message.source.origin}, state: message.data.state, seq: message.seq, capture: message.capture,
      receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
      applied: {hydration: message.kind === 'checkpoint', skippedSequences: '0', continuity: message.data.continuity}
    },
    ...patch
  };
}
function fields(view: LiveDashboardView): Record<string, LiveField> {
  const all = [...view.sections.flatMap(section => section.fields), view.connection.gameMode, view.connection.eventLoss];
  expect(new Set(all.map(field => field.id)).size).toBe(all.length);
  return Object.fromEntries(all.map(field => [field.id, field]));
}
function texts(view: LiveDashboardView): Record<string, string> {
  return Object.fromEntries(Object.values(fields(view)).filter(field => field.state === 'value').map(field => [field.id, field.text]));
}
const viewOf = (telemetry: LiveTelemetry, state?: NormalizedLiveState, game: 'ets2' | 'ats' | undefined = 'ets2') =>
  buildLiveView(telemetry, state, resolveDisplayUnits(game));
const v0View = (telemetry: LiveTelemetry, game: 'ets2' | 'ats' | undefined = 'ets2') =>
  viewOf(telemetry, telemetry.observation && normalizeV0State(telemetry.observation.state), game);
const value = <T>(v: T): Reading<T> => ({state: 'value', value: v});

const STATUSES: LiveTelemetry['status'][] = ['waiting', 'connected', 'paused', 'stale', 'incompatible', 'disconnected', 'unavailable', 'service-failed', 'restarting'];

describe('REG-009 currentness for every LiveTelemetry status', () => {
  it.each(STATUSES)('%s', status => {
    const telemetry = live('checkpoint', {status});
    const expected = status === 'connected' || status === 'paused';
    expect(isCurrent(telemetry)).toBe(expected);
    const view = v0View(telemetry);
    expect(view.connection.status).toBe(status);
    expect(view.connection.current).toBe(expected);
    const shown = Object.values(fields(view)).filter(field => field.state !== 'hidden');
    expect(shown.length).toBeGreaterThan(10);
    if (expected) expect(shown.some(field => field.state === 'value')).toBe(true);
    else for (const field of shown) expect(field).toMatchObject({state: 'missing', text: 'unavailable', reason: 'not-current'});
  });
  it('never treats a stale or observation-less update as current', () => {
    expect(isCurrent(live('checkpoint', {fresh: false}))).toBe(false);
    expect(isCurrent(live('checkpoint', {observation: undefined}))).toBe(false);
    const view = viewOf(live('checkpoint'), undefined);
    expect(view.connection.current).toBe(false);
    expect(Object.values(fields(view)).every(field => field.state === 'missing' && field.reason === 'not-current')).toBe(true);
  });
  it('hides every value while stale or disconnected, without dimmed last-known values', () => {
    for (const status of ['stale', 'disconnected'] as const) {
      const view = v0View(live('checkpoint', {status, fresh: false}));
      expect(texts(view)).toEqual({});
      expect(fields(view).gear).toEqual({id: 'gear', state: 'missing', text: 'unavailable', reason: 'not-current'});
      expect(fields(view).speed.text).toBe('unavailable');
    }
  });
});

describe('REG-009 v0 dashboard values', () => {
  it('shows the checkpoint fixture in ETS2 metric units', () => {
    const view = v0View(live('checkpoint'));
    expect(view.connection).toMatchObject({current: true, paused: false, simulation: 'running', origin: 'synthetic', flagged: true, game: 'ets2', profile: 'metric', protocol: 'v0'});
    expect(texts(view)).toEqual({
      'speed': '0.0 km/h', 'gear': 'R1', 'engine-rpm': '600 rpm', 'fuel-capacity': '1000 L', 'sdk-average-consumption': '25.0 L/100 km',
      'odometer': '1234.6 km', 'game-time': 'Day 8574, 09:18', 'cargo': 'cargo.logs', 'destination-city': 'city.warszawa',
      'planned-distance': '200 km', 'expected-income': '9007199254740993.123456 (currency unknown)', 'truck': 'truck.volvo'
    });
    const all = fields(view);
    expect(all.fuel).toEqual({id: 'fuel', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    expect(all['fuel-level']).toEqual({id: 'fuel-level', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    expect(all['estimated-range']).toEqual({id: 'estimated-range', state: 'missing', text: 'unavailable', reason: 'not-observed', notes: ['game-estimate']});
  });
  it('hides every field v0 does not carry instead of calling it unavailable', () => {
    const all = fields(v0View(live('checkpoint')));
    for (const id of ['route-remaining', 'deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job',
      'cargo-loaded', 'truck-plate', 'trailers', 'position', 'bearing', 'game-mode', 'event-loss']) {
      expect(all[id]).toMatchObject({state: 'hidden', text: '', reason: 'not-carried'});
    }
  });
  it('keeps a road stop current at 0.0 km/h', () => {
    const telemetry = live('snapshot');
    telemetry.observation!.state.speed = {available: true, value: -0.001, unit: 'm/s'};
    expect(fields(v0View(telemetry)).speed).toEqual({id: 'speed', state: 'value', text: '0.0 km/h'});
  });
  it('shows current values with a pause flag while paused', () => {
    const paused = v0View(live('snapshot', {status: 'paused'}));
    expect(paused.connection).toMatchObject({current: true, paused: true});
    expect(fields(paused).gear.text).toBe('R1');
    const telemetry = live('snapshot');
    telemetry.observation!.state.simulation = 'paused';
    expect(v0View(telemetry).connection).toMatchObject({current: true, paused: true, simulation: 'paused'});
  });
  it('shows hydrated checkpoint configuration as current state without any gameplay effect', () => {
    const telemetry = live('checkpoint');
    expect(telemetry.observation!.applied.hydration).toBe(true);
    const view = v0View(telemetry);
    expect(fields(view).cargo.text).toBe('cargo.logs');
    expect(Object.keys(fields(view)).filter(id => /revenue|deliver|cancel|outcome|penalty/.test(id))).toEqual([]);
  });
  it('flags synthetic and replay origins and leaves game origin unflagged', () => {
    expect(v0View(live('checkpoint')).connection).toMatchObject({origin: 'synthetic', flagged: true});
    expect(v0View(live('ats'), 'ats').connection).toMatchObject({origin: 'replay', flagged: true});
    expect(v0View(live('checkpoint', {}, 'game')).connection).toMatchObject({origin: 'game', flagged: false});
  });
  it('shows ATS in US customary units with the SDK-documented currency basis', () => {
    const view = v0View(live('ats'), 'ats');
    expect(view.connection).toMatchObject({game: 'ats', profile: 'us-customary'});
    expect(texts(view)).toMatchObject({
      'speed': '0.0 mph', 'fuel-capacity': '264 US gal', 'odometer': '767.1 mi', 'sdk-average-consumption': '9.4 US mpg', 'planned-distance': '124 mi',
      'expected-income': '9007199254740993.123456 USD (SDK-documented)'
    });
    expect(fields(view)['sdk-average-consumption'].notes).toEqual(['sdk-mean', 'ats-mostly-static']);
  });
  it('uses metric without a game and reports no origin', () => {
    const view = viewOf({selection: 'game', status: 'waiting', reason: '', fresh: false, recording: false, coverage: 'unknown'}, undefined, undefined);
    expect(view.connection).toMatchObject({game: undefined, profile: 'metric', origin: 'none', flagged: false, current: false, protocol: undefined});
  });
  it('never labels the SDK average consumption as a trip value', () => {
    const view = v0View(live('checkpoint'));
    expect(fields(view)['sdk-average-consumption'].notes).toEqual(['sdk-mean']);
    expect(JSON.stringify(view)).not.toMatch(/trip/i);
  });
  it('reports zero consumption as non-numeric in US mpg and numeric in metric', () => {
    const telemetry = live('snapshot');
    telemetry.observation!.state.averageConsumption = {available: true, value: 0, unit: 'L/100km'};
    expect(fields(v0View(telemetry))['sdk-average-consumption']).toMatchObject({state: 'value', text: '0.0 L/100 km'});
    expect(fields(v0View(telemetry, 'ats'))['sdk-average-consumption']).toMatchObject({state: 'missing', text: 'unavailable', reason: 'zero-consumption'});
  });
  it('reports a missing job while current as a section reason', () => {
    const telemetry = live('snapshot');
    telemetry.observation!.state.configuration.job = {available: false, reason: 'not-observed'};
    const view = v0View(telemetry);
    const job = view.sections.find(section => section.id === 'job')!;
    expect(job.missing).toBe('not-observed');
    for (const field of job.fields) expect(field.state).toBe('hidden');
    expect(fields(view).deadline.state).toBe('hidden');
  });
});

describe('REG-009 v1 dashboard values', () => {
  const data = v1Data('snapshot');
  const state = normalizeV1State(data.state, data.status);
  it('shows the v1 snapshot fixture with v1-only fields', () => {
    const view = viewOf(live('snapshot'), state);
    expect(view.connection.protocol).toBe('v1');
    expect(texts(view)).toEqual({
      'gear': '3', 'engine-rpm': '600 rpm', 'fuel': '410.5 L', 'fuel-capacity': '1000 L', 'fuel-level': '41%', 'sdk-average-consumption': '32.5 L/100 km',
      'estimated-range': '1263 km', 'odometer': '1234.6 km', 'route-remaining': '151.0 km', 'game-time': 'Day 9, 13:45', 'deadline': 'in 10 h 55 min',
      'cargo': 'Synthetic Cargo', 'source-city': 'Synthetic City A', 'source-company': 'Synthetic Company A', 'destination-city': 'Synthetic City B',
      'destination-company': 'Synthetic Company B', 'cargo-mass': '18.0 t', 'market': 'freight_market', 'special-job': 'no', 'planned-distance': '152 km',
      'expected-income': '12345 (currency unknown)', 'truck': 'Synthetic Brand Synthetic Truck', 'truck-plate': 'SYN 0001', 'trailers': 'dryvan',
      'position': 'x -31234.5, y 42.3, z 18800.8', 'bearing': '270°', 'game-mode': 'single-player (weak evidence, module-scan)', 'event-loss': '0'
    });
    const all = fields(view);
    expect(all.speed).toEqual({id: 'speed', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    expect(all['cargo-loaded']).toMatchObject({state: 'hidden', notes: ['cargo-market-only']});
    expect(all['planned-distance'].notes).toEqual(['job-offer-excludes-ferry']);
    expect(all.position.notes).toEqual(['game-world-coordinates']);
  });
  it('shows cargo loaded only for the cargo market', () => {
    if (state.job.state !== 'value') throw new Error('job expected');
    const cargoMarket = {...state, job: value({...state.job.value, market: value('cargo_market'), cargoLoaded: value(false)})};
    expect(fields(viewOf(live('snapshot'), cargoMarket))['cargo-loaded']).toMatchObject({state: 'value', text: 'no'});
  });
  it('falls back from a localized name to the id and from a trailer name to its body type, then its id', () => {
    if (state.job.state !== 'value' || state.trailers.state !== 'value' || state.trailers.value[0].state !== 'value') throw new Error('configuration expected');
    const trailer = state.trailers.value[0].value;
    const changed: NormalizedLiveState = {
      ...state,
      job: value({...state.job.value, cargo: {id: value('synthetic_cargo'), name: value('')}, sourceCity: {id: value('synthetic_city_a'), name: {state: 'missing', reason: 'not-observed'}}}),
      trailers: value([value({...trailer, bodyType: value('')}), {state: 'missing', reason: 'not-observed'}, value({...trailer, model: {...trailer.model, name: value('Owned Trailer')}})])
    };
    const all = fields(viewOf(live('snapshot'), changed));
    expect(all.cargo.text).toBe('synthetic_cargo');
    expect(all['source-city'].text).toBe('synthetic_city_a');
    expect(all.trailers.text).toBe('trailer.synthetic_box, Owned Trailer');
  });
  it('keeps unknown game mode unknown and states the evidence of a detected mode', () => {
    const unknown = {...state, gameMode: value({mode: 'unknown' as const, method: 'none' as const, confidence: 'none' as const, module: {state: 'missing' as const, reason: 'not-observed' as const}})};
    expect(fields(viewOf(live('snapshot'), unknown))['game-mode'].text).toBe('unknown');
    const worst = v1Data('checkpoint-worst');
    const strong = normalizeV1State(worst.state, worst.status);
    expect(fields(viewOf(live('snapshot'), strong))['game-mode'].text).toBe('TruckersMP (strong evidence, module-scan)');
    expect(fields(viewOf(live('snapshot'), strong))['event-loss'].text).toBe('110680464442257309690');
  });
  it('reports game mode as not observed without a status block', () => {
    expect(fields(viewOf(live('snapshot'), normalizeV1State(data.state)))['game-mode']).toMatchObject({state: 'missing', reason: 'not-observed'});
  });
});

describe('fix round 1: carriage by protocol and trailer presence', () => {
  const V0_HIDDEN = ['route-remaining', 'deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job',
    'cargo-loaded', 'truck-plate', 'trailers', 'position', 'bearing', 'game-mode', 'event-loss'];
  it('keeps v0-uncarried rows hidden when the v0 truck and job readings are missing (unavailable fixture)', () => {
    const all = fields(v0View(live('unavailable')));
    expect(all.truck).toEqual({id: 'truck', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    for (const id of V0_HIDDEN) expect(all[id]).toMatchObject({state: 'hidden', reason: 'not-carried'});
  });
  it('keeps v0-uncarried rows hidden while stale without a job, and shows carried job rows as not current', () => {
    const telemetry = live('snapshot', {status: 'stale', fresh: false});
    telemetry.observation!.state.configuration.job = {available: false, reason: 'not-observed'};
    const all = fields(v0View(telemetry));
    for (const id of V0_HIDDEN) expect(all[id]).toMatchObject({state: 'hidden', reason: 'not-carried'});
    for (const id of ['cargo', 'destination-city', 'planned-distance', 'expected-income']) expect(all[id]).toMatchObject({state: 'missing', reason: 'not-current'});
  });
  const data = v1Data('snapshot');
  const state = normalizeV1State(data.state, data.status);
  const notObserved = {state: 'missing' as const, reason: 'not-observed' as const};
  const invalid = {state: 'missing' as const, reason: 'invalid' as const};
  if (state.trailers.state !== 'value' || state.trailers.value[0].state !== 'value') throw new Error('trailer expected');
  const dryvan = state.trailers.value[0];
  it('reports a bobtail truck as no trailer attached, distinct from not yet observed', () => {
    const bobtail = {...state, trailers: value(Array.from({length: 10}, () => notObserved))};
    expect(fields(viewOf(live('snapshot'), bobtail)).trailers).toEqual({id: 'trailers', state: 'absent', text: 'none', reason: 'no-trailer'});
    expect(fields(viewOf(live('snapshot'), {...state, trailers: value([])})).trailers.state).toBe('absent');
    expect(fields(viewOf(live('snapshot', {status: 'stale', fresh: false}), bobtail)).trailers).toMatchObject({state: 'missing', reason: 'not-current'});
  });
  it('keeps invalid trailer slots visible as invalid', () => {
    const mixed = {...state, trailers: value([dryvan, invalid, notObserved])};
    expect(fields(viewOf(live('snapshot'), mixed)).trailers).toEqual({id: 'trailers', state: 'value', text: 'dryvan, (invalid)'});
    const allInvalid = {...state, trailers: value([invalid, notObserved, invalid])};
    expect(fields(viewOf(live('snapshot'), allInvalid)).trailers).toEqual({id: 'trailers', state: 'missing', text: 'unavailable', reason: 'invalid'});
  });
});
