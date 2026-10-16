// ET-010c decision F2: the whitelisted protocol v1 live projection and its strict validation in main and the preload.
// Inputs come from tests/fixtures/protocol-v1; expected key sets are the whitelist of docs/telemetry-service-v1.md.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry, LiveTelemetryV1} from '../../packages/contracts/src';
import {ProtocolError, validateLiveObservationV1, validateServerMessage} from '../../packages/contracts/src/protocol-v1';
import {initialLive} from '../../apps/desktop/src/live-state';
import {liveV1Key, liveV1Projection, parseLiveV1, withV1} from '../../apps/desktop/src/live-v1';
import {v1Projection, v1SourceState} from '../shared/live-v1-fixtures';

const STATE_KEYS = ['simulation', 'speed', 'fuel', 'fuelCapacity', 'engineRpm', 'gear', 'odometer', 'averageConsumption', 'estimatedRange',
  'navigationDistance', 'gameTime', 'captureUtcUnixMs', 'boundaryOrder', 'worldPlacement', 'configuration'];

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
