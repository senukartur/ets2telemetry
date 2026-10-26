// ET-010c decision F2: the whitelisted protocol v1 live projection and its strict validation in main and the preload.
// Inputs come from tests/fixtures/protocol-v1; expected key sets are the whitelist of docs/telemetry-service-v1.md.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry, LiveTelemetryV1} from '../../packages/contracts/src';
import {decodePayload, ProtocolError, validateLiveObservationV1, validateServerMessage, type GearboxState, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {initialLive} from '../../apps/desktop/src/live-state';
import {liveV1Key, liveV1Projection, parseLiveV1, withV1} from '../../apps/desktop/src/live-v1';
import {v1Projection, v1SourceState} from '../shared/live-v1-fixtures';

const STATE_KEYS = ['simulation', 'speed', 'fuel', 'fuelCapacity', 'engineRpm', 'gear', 'odometer', 'averageConsumption', 'estimatedRange',
  'navigationDistance', 'gameTime', 'captureUtcUnixMs', 'boundaryOrder', 'worldPlacement', 'configuration', 'gearbox', 'nextMandatoryBreak'];
/** ET-052 MB5: a minor-0 or minor-1 state carries no break, so the projection reports it not-supported. */
const NOT_SUPPORTED_BREAK = {available: false, reason: 'not-supported', unit: 'min'};
/** ET-050b B7: a minor-0 state carries no gearbox, so the projection reports every part not-supported. */
const NOT_SUPPORTED = {forwardGears: {available: false, reason: 'not-supported'}, reverseGears: {available: false, reason: 'not-supported'}, hshifter: {available: false, reason: 'not-supported'}};
const minor1 = (name: string) => {
  const m = decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/minor1/${name}.json`)), 'server', {maxMinor: 1}) as ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m;
};
const minor2 = (name: string) => {
  const m = decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/minor2/${name}.json`)), 'server', {maxMinor: 2}) as ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m;
};
/** A service source state of a fixture message, as v1SourceState builds one of a minor-0 fixture. */
function sourceStateOf(m: ReturnType<typeof minor1>) {
  const base = v1SourceState();
  return {...base, observation: {...base.observation!, kind: m.kind, source: m.source, seq: m.seq, capture: m.capture, state: m.data.state, status: m.data.status, continuity: m.data.continuity, hydration: m.kind === 'checkpoint'}};
}
const minor1SourceState = (name: string) => sourceStateOf(minor1(name));
const minor2SourceState = (name: string) => sourceStateOf(minor2(name));

describe('liveV1Projection', () => {
  const projection = liveV1Projection(v1SourceState());
  it('keeps exactly the whitelisted keys', () => {
    expect(Object.keys(projection)).toEqual(['selection', 'status', 'reason', 'fresh', 'observation']);
    expect(Object.keys(projection.observation!)).toEqual(['source', 'seq', 'capture', 'state', 'sourceStatus', 'receivedMonotonicMs', 'hydration']);
    expect(Object.keys(projection.observation!.state)).toEqual(STATE_KEYS);
    expect(Object.keys(projection.observation!.sourceStatus)).toEqual(['gameMode', 'eventLoss']);
    expect(projection).toMatchObject({selection: 'synthetic', status: 'connected', reason: 'Validated current observation', fresh: true,
      observation: {seq: '5', receivedMonotonicMs: 1250, hydration: false, sourceStatus: {eventLoss: {noDurableConsumer: '2'}}}});
  });
  it('never carries the window handle, clock mapping, delivery cursor, continuity, durable status, last end or kind', () => {
    const json = JSON.stringify(projection);
    for (const text of ['handle', '65538', '"window"', 'displayMode', 'clockMapping', 'offsetNs', '"delivery"', 'ackedThroughEventSeq', 'continuity', 'coalescedSnapshots',
      'durable', 'WORKER_FAILED', 'lastEnd', 'plugin-shutdown', '"kind"']) expect(json).not.toContain(text);
  });
  it('carries the minor-1 gearbox exactly and reports a minor-0 one as not-supported in every part (ET-050b B7)', () => {
    expect(projection.observation!.state.gearbox).toEqual(NOT_SUPPORTED);
    const mack = liveV1Projection(minor1SourceState('checkpoint-ats-mack')), wire = minor1('checkpoint-ats-mack').data.state.gearbox!;
    expect(mack.observation!.state.gearbox).toEqual(wire);
    expect(Object.keys(mack.observation!.state)).toEqual(STATE_KEYS);
    if (!wire.hshifter.available) throw new Error('fixture');
    // The 18-speed CAP-01 layout: 22 nonzero slots, two selector bits, 18 forward and 4 reverse gears.
    expect([wire.forwardGears, wire.reverseGears, wire.hshifter.value.selectorCount, wire.hshifter.value.slots.length])
      .toEqual([{available: true, value: 18}, {available: true, value: 4}, 2, 22]);
    expect(parseLiveV1(mack, 'synthetic')).toBe(mack);
    expect(parseLiveV1(structuredClone(liveV1Projection(minor1SourceState('snapshot-counts-not-observed'))), 'synthetic')).toBeDefined();
  });
  it('carries the minor-2 next mandatory break exactly, raw and unclamped, and reports a minor-0 or minor-1 state as not-supported (ET-052 MB5)', () => {
    // The projection of the minor-0 snapshot-live fixture and of the minor-1 corpus carries the substitute.
    expect(projection.observation!.state.nextMandatoryBreak).toEqual(NOT_SUPPORTED_BREAK);
    expect(liveV1Projection(minor1SourceState('checkpoint')).observation!.state.nextMandatoryBreak).toEqual(NOT_SUPPORTED_BREAK);
    expect(liveV1Projection(minor1SourceState('checkpoint-ats-mack')).observation!.state.nextMandatoryBreak).toEqual(NOT_SUPPORTED_BREAK);
    // A minor-2 state carries what the wire carried: 95, zero, a negative value, both s32 limits and each unavailable reading.
    for (const [name, expected] of [
      ['checkpoint', {available: true, value: 95, unit: 'min'}], ['snapshot', {available: true, value: 95, unit: 'min'}],
      ['snapshot-break-zero', {available: true, value: 0, unit: 'min'}], ['snapshot-break-negative', {available: true, value: -30, unit: 'min'}],
      ['snapshot-break-int32-max', {available: true, value: 2147483647, unit: 'min'}], ['snapshot-break-int32-min', {available: true, value: -2147483648, unit: 'min'}],
      ['snapshot-break-not-observed', {available: false, reason: 'not-observed', unit: 'min'}], ['snapshot-break-not-supported', {available: false, reason: 'not-supported', unit: 'min'}],
      ['snapshot-break-invalid', {available: false, reason: 'invalid', unit: 'min'}]
    ] as const) {
      const live = liveV1Projection(minor2SourceState(name));
      expect([name, live.observation!.state.nextMandatoryBreak]).toEqual([name, expected]);
      expect(Object.keys(live.observation!.state)).toEqual(STATE_KEYS);
      expect(parseLiveV1(structuredClone(live), 'synthetic')).toBeDefined();
    }
    // The gearbox rides along unchanged beside the break.
    expect(liveV1Projection(minor2SourceState('checkpoint')).observation!.state.gearbox).toEqual(minor2('checkpoint').data.state.gearbox);
  });
  it('replaces the break with every new state, and an older plugin\'s state replaces it with not-supported', () => {
    const hydrating = liveV1Projection(minor2SourceState('checkpoint')), later = liveV1Projection(minor2SourceState('snapshot-break-zero'));
    expect([hydrating.observation!.hydration, hydrating.observation!.state.nextMandatoryBreak]).toEqual([true, {available: true, value: 95, unit: 'min'}]);
    expect([later.observation!.hydration, later.observation!.state.nextMandatoryBreak]).toEqual([false, {available: true, value: 0, unit: 'min'}]);
    expect(liveV1Projection(minor2SourceState('checkpoint-minor-1')).observation!.state.nextMandatoryBreak).toEqual(NOT_SUPPORTED_BREAK);
    expect(liveV1Projection(minor2SourceState('checkpoint-minor-0')).observation!.state.nextMandatoryBreak).toEqual(NOT_SUPPORTED_BREAK);
  });
  it('omits the observation before the first one', () => {
    expect(liveV1Projection(v1SourceState('snapshot-live', {status: 'waiting', reason: 'Awaiting selected source', fresh: false, observation: undefined})))
      .toEqual({selection: 'synthetic', status: 'waiting', reason: 'Awaiting selected source', fresh: false});
  });
  it('is accepted by the strict parser, also after a structured clone', () => {
    expect(parseLiveV1(projection, 'synthetic')).toBe(projection);
    const clone = structuredClone(projection);
    expect(parseLiveV1(clone, 'synthetic')).toBe(clone);
  });
});

describe('withV1', () => {
  const v0: LiveTelemetry = initialLive('synthetic');
  it('attaches the projection of the same selection only', () => {
    const v1 = v1Projection();
    expect(withV1(v0, v1)).toEqual({...v0, v1});
    expect(withV1(v0, {...v1, selection: 'replay'})).toBe(v0);
    expect(withV1(v0, undefined)).toBe(v0);
  });
});

describe('parseLiveV1', () => {
  const valid = () => v1Projection();
  const mutate = (change: (value: Record<string, unknown>) => void): unknown => {const value = structuredClone(valid()) as unknown as Record<string, unknown>; change(value); return value;};
  const observation = (value: Record<string, unknown>) => value.observation as Record<string, Record<string, unknown>>;
  it.each<[string, unknown]>([
    ['a game window in the state', mutate(value => {observation(value).state.window = {available: true, value: {handle: '65538', x: 0, y: 0, width: 1, height: 1, dpi: 96, foreground: true, minimized: false, displayMode: 'borderless'}};})],
    ['a not-observed window in the state', mutate(value => {observation(value).state.window = {available: false, reason: 'not-observed'};})],
    ['an extra clock mapping', mutate(value => {value.clockMapping = {offsetNs: '1'};})],
    ['an extra observation key', mutate(value => {observation(value).delivery = {};})],
    ['an extra state key', mutate(value => {observation(value).state.extra = 1;})],
    ['a missing state key', mutate(value => {delete observation(value).state.boundaryOrder;})],
    // ET-050b B7: main and the dashboard preload strip a projection whose gearbox is missing or invalid.
    ['a missing gearbox', mutate(value => {delete observation(value).state.gearbox;})],
    ['a null gearbox', mutate(value => {observation(value).state.gearbox = null;})],
    ['a gearbox with an extra key', mutate(value => {(observation(value).state.gearbox as Record<string, unknown>).shifterType = 'name-1';})],
    ['a gear count above 100', mutate(value => {(observation(value).state.gearbox as GearboxState).forwardGears = {available: true, value: 101};})],
    ['a duplicate h-shifter slot pair', mutate(value => {(observation(value).state.gearbox as GearboxState).hshifter = {available: true, value: {selectorCount: 1, slots: [{gear: 1, handlePosition: 1, selectors: 0}, {gear: 2, handlePosition: 1, selectors: 0}]}};})],
    ['h-shifter selectors out of range', mutate(value => {(observation(value).state.gearbox as GearboxState).hshifter = {available: true, value: {selectorCount: 1, slots: [{gear: 1, handlePosition: 1, selectors: 2}]}};})],
    ['a neutral h-shifter slot', mutate(value => {(observation(value).state.gearbox as GearboxState).hshifter = {available: true, value: {selectorCount: 0, slots: [{gear: 0, handlePosition: 1, selectors: 0}]}};})],
    // ET-052 MB5: the projection always carries the next mandatory break, a plain s32 integer with unit min.
    ['a missing next mandatory break', mutate(value => {delete observation(value).state.nextMandatoryBreak;})],
    ['a null next mandatory break', mutate(value => {observation(value).state.nextMandatoryBreak = null;})],
    ['a next mandatory break beyond the s32 maximum', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: 2147483648, unit: 'min'};})],
    ['a next mandatory break below the s32 minimum', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: -2147483649, unit: 'min'};})],
    ['a fractional next mandatory break', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: 45.5, unit: 'min'};})],
    ['a next mandatory break as a decimal string', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: '45', unit: 'min'};})],
    ['a next mandatory break in metres', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: 45, unit: 'm'};})],
    ['a next mandatory break with an extra key', mutate(value => {observation(value).state.nextMandatoryBreak = {available: true, value: 45, unit: 'min', extra: 1};})],
    ['an unavailable next mandatory break with a value', mutate(value => {observation(value).state.nextMandatoryBreak = {available: false, reason: 'not-observed', unit: 'min', value: 1};})],
    ['fresh data without an observation', mutate(value => {delete value.observation;})],
    ['fresh stale data', mutate(value => {value.status = 'stale';})],
    ['a service status', mutate(value => {value.status = 'service-failed'; value.fresh = false;})],
    ['a non-canonical sequence', mutate(value => {observation(value).seq = '01' as unknown as Record<string, unknown>;})],
    ['a negative loss count', mutate(value => {(observation(value).sourceStatus.eventLoss as Record<string, unknown>).offline = '-1';})],
    ['a 257-character reason', mutate(value => {value.reason = 'x'.repeat(257);})],
    ['an empty reason', mutate(value => {value.reason = '';})],
    ['a control character in the reason', mutate(value => {value.reason = 'stale\nline';})],
    ['a negative receipt time', mutate(value => {observation(value).receivedMonotonicMs = -1 as unknown as Record<string, unknown>;})],
    ['a non-boolean hydration flag', mutate(value => {observation(value).hydration = 'false' as unknown as Record<string, unknown>;})],
    ['null', null], ['an array', [valid()]], ['a string', 'connected'],
    ['a throwing getter', Object.defineProperty({status: 'connected', reason: 'x', fresh: false, observation: undefined}, 'selection', {enumerable: true, get: () => {throw new Error('getter');}})]
  ])('rejects %s without throwing', (_name, value) => {
    expect(() => parseLiveV1(value, 'synthetic')).not.toThrow();
    expect(parseLiveV1(value, 'synthetic')).toBeUndefined();
  });
  it('rejects a projection of another selection', () => {
    expect(parseLiveV1(valid(), 'replay')).toBeUndefined();
  });
  it.each([
    [{available: true, value: 95, unit: 'min'}], [{available: true, value: 0, unit: 'min'}], [{available: true, value: -1, unit: 'min'}],
    [{available: true, value: 2147483647, unit: 'min'}], [{available: true, value: -2147483648, unit: 'min'}],
    [{available: false, reason: 'not-observed', unit: 'min'}], [{available: false, reason: 'not-supported', unit: 'min'}], [{available: false, reason: 'invalid', unit: 'min'}]
  ])('accepts the next mandatory break %j', measure => {
    const value = mutate(v => {observation(v).state.nextMandatoryBreak = structuredClone(measure);});
    expect(parseLiveV1(value, 'synthetic')).toBe(value);
  });
  it('accepts a 256-character reason and a stale projection that keeps its observation', () => {
    expect(parseLiveV1({...valid(), reason: 'x'.repeat(256)}, 'synthetic')).toBeDefined();
    const stale: LiveTelemetryV1 = {...valid(), status: 'stale', fresh: false, reason: 'No recent SDK capture'};
    expect(parseLiveV1(stale, 'synthetic')).toBe(stale);
  });
});

describe('validateLiveObservationV1', () => {
  it('accepts the projection observation and rejects a window or an extra key', () => {
    const live = v1Projection().observation!;
    expect(validateLiveObservationV1(live)).toBe(live);
    expect(() => validateLiveObservationV1({...live, state: {...live.state, window: {available: false, reason: 'not-observed'}}})).toThrow(ProtocolError);
    expect(() => validateLiveObservationV1({...live, kind: 'snapshot'})).toThrow(ProtocolError);
    expect(() => validateLiveObservationV1({...live, sourceStatus: {...live.sourceStatus, delivery: {}}})).toThrow(ProtocolError);
  });
  it('leaves the wire validator unchanged: a snapshot state without its window is still rejected', () => {
    const message = JSON.parse(readFileSync('tests/fixtures/protocol-v1/snapshot-live.json', 'utf8')) as {data: {state: Record<string, unknown>}};
    expect(validateServerMessage(structuredClone(message))).toBeDefined();
    delete message.data.state.window;
    expect(() => validateServerMessage(message)).toThrow(ProtocolError);
  });
});

describe('liveV1Key', () => {
  const base = v1Projection();
  const key = (change: (value: LiveTelemetryV1) => void) => {const value = structuredClone(base); change(value); return liveV1Key(value);};
  it('changes only with the source identity, capture clock, SDK boundary or receipt time', () => {
    const original = liveV1Key(base);
    expect(original).toBe('10000000-0000-4000-8000-000000000001|20000000-0000-4000-8000-000000000001|30000000-0000-4000-8000-000000000001|102|0');
    expect(key(value => {value.observation!.seq = '6'; value.observation!.capture.monotonicNs = '1000300000000'; value.observation!.state.speed = {available: true, value: 3, unit: 'm/s'};})).toBe(original);
    expect(key(value => {value.status = 'stale'; value.fresh = false;})).toBe(original);
    for (const change of [
      (value: LiveTelemetryV1) => {value.observation!.state.boundaryOrder = '103';},
      (value: LiveTelemetryV1) => {value.observation!.receivedMonotonicMs = 50;},
      (value: LiveTelemetryV1) => {value.observation!.source.pluginSessionId = '10000000-0000-4000-8000-000000000002';},
      (value: LiveTelemetryV1) => {value.observation!.source.processInstanceId = '20000000-0000-4000-8000-000000000002';},
      (value: LiveTelemetryV1) => {value.observation!.capture.clockId = '30000000-0000-4000-8000-000000000002';}
    ]) expect(key(change)).not.toBe(original);
    expect(liveV1Key({...base, observation: undefined})).toBeUndefined();
    expect(liveV1Key(undefined)).toBeUndefined();
  });
});
