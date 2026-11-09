// ET-084 (REG-009, REG-010): the navigation speed limit in telemetry-core. Inputs are the minor-4 fixtures and plain
// numbers; every expected value is written by hand from docs/protocol/v1.md §7 and docs/live-telemetry-fields.md: the
// SDK value is m/s, zero or a negative value means no limit (a value, never unavailable), and a limit reads in whole units.
// 25 m/s = 25 × 3.6 = 90 km/h = 25 × 2.236936 = 55.92 mph, so 56 mph.
// 13.888889 × 3.6 = 50.0000004. 29.0576 × 3.6 = 104.607 and × 2.236936 = 64.9999. 33.3333 × 3.6 = 119.99988.
// A limit needs at least half a unit: 0.5 / 3.6 = 0.13889 m/s and 0.5 / 2.236936 = 0.22352 m/s. 0.1 m/s is 0.36 km/h and
// 0.2237 mph; 0.13 × 3.6 = 0.468 and 0.14 × 3.6 = 0.504; 0.2235 × 2.236936 = 0.49996 and 0.2236 × 2.236936 = 0.50018;
// 0.14 × 2.236936 = 0.3132 mph.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {
  buildLiveView, carriesField, formatSpeedLimit, normalizeV0State, normalizeV1State, resolveDisplayUnits, SPEED_LIMIT_NONE, V0_CARRIED_FIELDS,
  type LiveViewSource, type NormalizedLiveState
} from '../../packages/telemetry-core/src';

const fixture = (dir: string, name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures', dir, `${name}.json`)));
function stateOf(dir: string, name: string, maxMinor: v1.V1Minor) {
  const m = v1.decodePayload(fixture(dir, name), 'server', maxMinor === 0 ? {} : {maxMinor}) as v1.ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m.data;
}
const minor4 = (name: string) => stateOf('protocol-v1/minor4', name, 4);
const v1Normalized = (name: string) => { const {state, status} = minor4(name); return normalizeV1State(state, status); };
const live = (status: LiveViewSource['status'] = 'connected', fresh = true): LiveViewSource =>
  ({selection: 'ets2', status, fresh, observation: {source: {origin: 'synthetic', game: 'ets2'}}});
const limitRow = (state: NormalizedLiveState, game: 'ets2' | 'ats' = 'ets2', source = live()) => {
  const row = buildLiveView(source, state, resolveDisplayUnits(game)).sections.flatMap(section => section.fields).find(field => field.id === 'speed-limit');
  if (!row) throw new Error('no speed-limit row');
  return row;
};
const withLimit = (state: NormalizedLiveState, mps: number): NormalizedLiveState => ({...state, speedLimit: {state: 'value', value: mps}});

describe('ET-084 speed limit text', () => {
  it.each([[0], [-0], [-1], [-1000], [-1e-300]])('reads %f m/s as no limit, a value and never a dash', mps => {
    expect(SPEED_LIMIT_NONE).toBe('none');
    expect(formatSpeedLimit(mps, 'km/h')).toBe('none'); expect(formatSpeedLimit(mps, 'mph')).toBe('none');
  });
  it.each([
    [0.1, 'km/h', 'none'], [0.1, 'mph', 'none'], [0.13, 'km/h', 'none'], [0.14, 'km/h', '1 km/h'], [0.14, 'mph', 'none'], [0.2235, 'mph', 'none'], [0.2236, 'mph', '1 mph']
  ] as const)('never shows a limit of 0: %f m/s in %s reads %s', (mps, unit, text) => {
    expect(formatSpeedLimit(mps, unit)).toBe(text);
  });
  it.each([
    [25, 'km/h', '90 km/h'], [25, 'mph', '56 mph'], [13.888889, 'km/h', '50 km/h'], [29.0576, 'km/h', '105 km/h'], [29.0576, 'mph', '65 mph'], [33.3333, 'km/h', '120 km/h'],
    [1000, 'km/h', '3600 km/h'], [1000, 'mph', '2237 mph']
  ] as const)('reads %f m/s as %s %s in whole units', (mps, unit, text) => {
    expect(formatSpeedLimit(mps, unit)).toBe(text);
  });
});

describe('ET-084 speed limit normalization', () => {
  it('keeps the raw m/s value, zero and negative included', () => {
    expect(v1Normalized('checkpoint').speedLimit).toEqual({state: 'value', value: 25});
    expect(v1Normalized('snapshot').speedLimit).toEqual({state: 'value', value: 22.5});
    expect(v1Normalized('snapshot-limit-zero').speedLimit).toEqual({state: 'value', value: 0});
    expect(v1Normalized('snapshot-limit-negative').speedLimit).toEqual({state: 'value', value: -1});
    expect(v1Normalized('snapshot-limit-max').speedLimit).toEqual({state: 'value', value: 1000});
    expect(v1Normalized('snapshot-limit-min').speedLimit).toEqual({state: 'value', value: -1000});
  });
  it('keeps each unavailable reason', () => {
    expect(v1Normalized('snapshot-limit-not-observed').speedLimit).toEqual({state: 'missing', reason: 'not-observed'});
    expect(v1Normalized('snapshot-limit-not-supported').speedLimit).toEqual({state: 'missing', reason: 'not-supported'});
    expect(v1Normalized('snapshot-limit-invalid').speedLimit).toEqual({state: 'missing', reason: 'invalid'});
  });
  it('reports not-supported for a v1 state below minor 4, which carries no speed limit', () => {
    for (const data of [stateOf('protocol-v1/minor3', 'checkpoint', 3), stateOf('protocol-v1/minor2', 'checkpoint', 2), stateOf('protocol-v1/minor1', 'checkpoint', 1), stateOf('protocol-v1', 'snapshot', 0)]) {
      expect(normalizeV1State(data.state, data.status).speedLimit).toEqual({state: 'missing', reason: 'not-supported'});
    }
  });
  it('reports not-carried under protocol v0', () => {
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(normalizeV0State(message.data.state).speedLimit).toEqual({state: 'missing', reason: 'not-carried'});
  });
  it('does not change any other reading of the state', () => {
    // The minor-4 snapshot differs from its minor-3 sibling only by the speed limit; everything else normalizes identically.
    const a = minor4('snapshot'), b = stateOf('protocol-v1/minor3', 'snapshot', 3);
    const {speedLimit: withReading, ...rest} = normalizeV1State(a.state, a.status);
    const {speedLimit: withoutReading, ...restWithout} = normalizeV1State(b.state, b.status);
    expect(rest).toEqual(restWithout);
    expect(withReading).toEqual({state: 'value', value: 22.5}); expect(withoutReading).toEqual({state: 'missing', reason: 'not-supported'});
  });
});

describe('ET-084 speed limit row in the live view', () => {
  const base = v1Normalized('checkpoint');
  it('is a v1-only row in the motion section, after cruise control', () => {
    const view = buildLiveView(live(), base, resolveDisplayUnits('ets2'));
    expect(view.sections.find(section => section.id === 'motion')!.fields.map(field => field.id)).toEqual(['speed', 'gear', 'engine-rpm', 'cruise-control', 'speed-limit']);
    expect(V0_CARRIED_FIELDS.has('speed-limit')).toBe(false);
    expect(carriesField('v0', 'speed-limit')).toBe(false); expect(carriesField('v1', 'speed-limit')).toBe(true);
  });
  it('shows 25 m/s as 90 km/h for ETS2 and 56 mph for ATS, a whole number without a second conversion', () => {
    expect(limitRow(base)).toEqual({id: 'speed-limit', state: 'value', text: '90 km/h'});
    expect(limitRow(base, 'ats')).toEqual({id: 'speed-limit', state: 'value', text: '56 mph'});
  });
  it('keeps no limit distinct from every unavailable reading', () => {
    expect(limitRow(v1Normalized('snapshot-limit-zero'))).toEqual({id: 'speed-limit', state: 'value', text: 'none'});
    expect(limitRow(v1Normalized('snapshot-limit-negative'), 'ats')).toEqual({id: 'speed-limit', state: 'value', text: 'none'});
    expect(limitRow(withLimit(base, 0.1))).toEqual({id: 'speed-limit', state: 'value', text: 'none'});
    expect(limitRow(v1Normalized('snapshot-limit-not-observed'))).toEqual({id: 'speed-limit', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    expect(limitRow(v1Normalized('snapshot-limit-not-supported'))).toMatchObject({state: 'missing', reason: 'not-supported'});
    expect(limitRow(v1Normalized('snapshot-limit-invalid'))).toMatchObject({state: 'missing', reason: 'invalid'});
  });
  it('is not-supported below minor 4 and hidden as not carried under v0', () => {
    const minor3 = stateOf('protocol-v1/minor3', 'snapshot', 3);
    expect(limitRow(normalizeV1State(minor3.state, minor3.status))).toMatchObject({state: 'missing', reason: 'not-supported'});
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(limitRow(normalizeV0State(message.data.state))).toEqual({id: 'speed-limit', state: 'hidden', text: '', reason: 'not-carried'});
  });
  it('is not current when the source is stale or not connected, and stays a value while paused', () => {
    for (const source of [live('stale', false), live('connected', false), live('disconnected'), live('waiting')]) {
      expect(limitRow(withLimit(base, 25), 'ets2', source)).toEqual({id: 'speed-limit', state: 'missing', text: 'unavailable', reason: 'not-current'});
    }
    expect(limitRow(withLimit(base, 0), 'ets2', live('paused'))).toEqual({id: 'speed-limit', state: 'value', text: 'none'});
  });
});
