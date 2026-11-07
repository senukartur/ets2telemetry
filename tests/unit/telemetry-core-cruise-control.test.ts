// ET-071 (REG-009, REG-010): the cruise control set speed in telemetry-core. Inputs are the minor-3 fixtures and plain
// numbers; every expected value is written by hand from docs/protocol/v1.md §7 and docs/live-telemetry-fields.md: the
// SDK value is m/s, zero means cruise control is off (a value, never unavailable), and a set speed reads like speed.
// 25 m/s = 25 × 3.6 = 90 km/h = 25 × 2.236936 = 55.92 mph.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {
  buildLiveView, carriesField, CRUISE_CONTROL_OFF, cruiseControlActive, formatCruiseControl, normalizeV0State, normalizeV1State, resolveDisplayUnits, V0_CARRIED_FIELDS,
  type LiveViewSource, type NormalizedLiveState
} from '../../packages/telemetry-core/src';

const fixture = (dir: string, name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures', dir, `${name}.json`)));
function stateOf(dir: string, name: string, maxMinor: v1.V1Minor) {
  const m = v1.decodePayload(fixture(dir, name), 'server', maxMinor === 0 ? {} : {maxMinor}) as v1.ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m.data;
}
const minor3 = (name: string) => stateOf('protocol-v1/minor3', name, 3);
const v1Normalized = (name: string) => { const {state, status} = minor3(name); return normalizeV1State(state, status); };
const live = (status: LiveViewSource['status'] = 'connected', fresh = true): LiveViewSource =>
  ({selection: 'ets2', status, fresh, observation: {source: {origin: 'synthetic', game: 'ets2'}}});
const cruiseRow = (state: NormalizedLiveState, game: 'ets2' | 'ats' = 'ets2', source = live()) => {
  const row = buildLiveView(source, state, resolveDisplayUnits(game)).sections.flatMap(section => section.fields).find(field => field.id === 'cruise-control');
  if (!row) throw new Error('no cruise-control row');
  return row;
};
const withCruise = (state: NormalizedLiveState, mps: number): NormalizedLiveState => ({...state, cruiseControl: {state: 'value', value: mps}});

describe('ET-071 cruise control text', () => {
  it('reads off at zero, a value and never a dash', () => {
    expect(CRUISE_CONTROL_OFF).toBe('off');
    expect(formatCruiseControl(0, 'km/h')).toBe('off'); expect(formatCruiseControl(0, 'mph')).toBe('off');
    expect(cruiseControlActive(0)).toBe(false);
  });
  it.each([
    [25, 'km/h', '90.0 km/h'], [25, 'mph', '55.9 mph'], [22.5, 'km/h', '81.0 km/h'], [22.5, 'mph', '50.3 mph'],
    [0.5, 'km/h', '1.8 km/h'], [1000, 'km/h', '3600.0 km/h'], [1000, 'mph', '2236.9 mph']
  ] as const)('reads %f m/s as %s %s', (mps, unit, text) => {
    expect(cruiseControlActive(mps)).toBe(true); expect(formatCruiseControl(mps, unit)).toBe(text);
  });
});

describe('ET-071 cruise control normalization', () => {
  it('keeps the raw m/s value, zero included', () => {
    expect(v1Normalized('checkpoint').cruiseControl).toEqual({state: 'value', value: 22.5});
    expect(v1Normalized('snapshot').cruiseControl).toEqual({state: 'value', value: 25});
    expect(v1Normalized('snapshot-cruise-zero').cruiseControl).toEqual({state: 'value', value: 0});
    expect(v1Normalized('snapshot-cruise-max').cruiseControl).toEqual({state: 'value', value: 1000});
  });
  it('keeps each unavailable reason', () => {
    expect(v1Normalized('snapshot-cruise-not-observed').cruiseControl).toEqual({state: 'missing', reason: 'not-observed'});
    expect(v1Normalized('snapshot-cruise-not-supported').cruiseControl).toEqual({state: 'missing', reason: 'not-supported'});
    expect(v1Normalized('snapshot-cruise-invalid').cruiseControl).toEqual({state: 'missing', reason: 'invalid'});
  });
  it('reports not-supported for a v1 state below minor 3, which carries no cruise control', () => {
    for (const data of [stateOf('protocol-v1/minor2', 'checkpoint', 2), stateOf('protocol-v1/minor1', 'checkpoint', 1), stateOf('protocol-v1', 'snapshot', 0)]) {
      expect(normalizeV1State(data.state, data.status).cruiseControl).toEqual({state: 'missing', reason: 'not-supported'});
    }
  });
  it('reports not-carried under protocol v0', () => {
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(normalizeV0State(message.data.state).cruiseControl).toEqual({state: 'missing', reason: 'not-carried'});
  });
  it('does not change any other reading of the state', () => {
    // The minor-3 snapshot differs from its minor-2 sibling only by cruise control; everything else normalizes identically.
    const a = minor3('snapshot'), b = stateOf('protocol-v1/minor2', 'snapshot', 2);
    const {cruiseControl: withReading, ...rest} = normalizeV1State(a.state, a.status);
    const {cruiseControl: withoutReading, ...restWithout} = normalizeV1State(b.state, b.status);
    expect(rest).toEqual(restWithout);
    expect(withReading).toEqual({state: 'value', value: 25}); expect(withoutReading).toEqual({state: 'missing', reason: 'not-supported'});
  });
});

describe('ET-071 cruise control row in the live view', () => {
  const base = v1Normalized('snapshot');
  it('is a v1-only row in the motion section, after engine RPM', () => {
    const view = buildLiveView(live(), base, resolveDisplayUnits('ets2'));
    expect(view.sections.find(section => section.id === 'motion')!.fields.map(field => field.id)).toEqual(['speed', 'gear', 'engine-rpm', 'cruise-control']);
    expect(V0_CARRIED_FIELDS.has('cruise-control')).toBe(false);
    expect(carriesField('v0', 'cruise-control')).toBe(false); expect(carriesField('v1', 'cruise-control')).toBe(true);
  });
  it('shows 25 m/s as 90.0 km/h for ETS2 and 55.9 mph for ATS', () => {
    expect(cruiseRow(base)).toEqual({id: 'cruise-control', state: 'value', text: '90.0 km/h'});
    expect(cruiseRow(base, 'ats')).toEqual({id: 'cruise-control', state: 'value', text: '55.9 mph'});
  });
  it('keeps off distinct from every unavailable reading', () => {
    expect(cruiseRow(v1Normalized('snapshot-cruise-zero'))).toEqual({id: 'cruise-control', state: 'value', text: 'off'});
    expect(cruiseRow(withCruise(base, 0), 'ats')).toEqual({id: 'cruise-control', state: 'value', text: 'off'});
    expect(cruiseRow(v1Normalized('snapshot-cruise-not-observed'))).toEqual({id: 'cruise-control', state: 'missing', text: 'unavailable', reason: 'not-observed'});
    expect(cruiseRow(v1Normalized('snapshot-cruise-not-supported'))).toMatchObject({state: 'missing', reason: 'not-supported'});
    expect(cruiseRow(v1Normalized('snapshot-cruise-invalid'))).toMatchObject({state: 'missing', reason: 'invalid'});
  });
  it('is not-supported below minor 3 and hidden as not carried under v0', () => {
    const minor2 = stateOf('protocol-v1/minor2', 'snapshot', 2);
    expect(cruiseRow(normalizeV1State(minor2.state, minor2.status))).toMatchObject({state: 'missing', reason: 'not-supported'});
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(cruiseRow(normalizeV0State(message.data.state))).toEqual({id: 'cruise-control', state: 'hidden', text: '', reason: 'not-carried'});
  });
  it('is not current when the source is stale or not connected, and stays a value while paused', () => {
    for (const source of [live('stale', false), live('connected', false), live('disconnected'), live('waiting')]) {
      expect(cruiseRow(withCruise(base, 25), 'ets2', source)).toEqual({id: 'cruise-control', state: 'missing', text: 'unavailable', reason: 'not-current'});
    }
    expect(cruiseRow(withCruise(base, 0), 'ets2', live('paused'))).toEqual({id: 'cruise-control', state: 'value', text: 'off'});
  });
});
