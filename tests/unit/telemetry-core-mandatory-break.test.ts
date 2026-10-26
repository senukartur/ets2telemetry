// ET-052 PR-1 (REG-009, REG-010): the next mandatory break in telemetry-core. Inputs are the minor-2 fixtures and plain
// numbers; every expected value is written by hand from docs/protocol/v1.md §7 and docs/live-telemetry-fields.md (D3:
// zero or less is due, 1 to 119 minutes is soon, 120 minutes or more is normal, the text is clamped at zero).
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {
  BREAK_SOON_MINUTES, breakUrgency, buildLiveView, carriesField, formatMandatoryBreak, normalizeV0State, normalizeV1State, resolveDisplayUnits, V0_CARRIED_FIELDS,
  type LiveViewSource, type NormalizedLiveState
} from '../../packages/telemetry-core/src';
import * as v0 from '../../packages/contracts/src/protocol-v0';

const INT32_MAX = 2_147_483_647, INT32_MIN = -2_147_483_648;
const fixture = (dir: string, name: string) => new Uint8Array(readFileSync(resolve('tests/fixtures', dir, `${name}.json`)));
function minor2(name: string) {
  const m = v1.decodePayload(fixture('protocol-v1/minor2', name), 'server', {maxMinor: 2}) as v1.ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m.data;
}
function minor1State(name: string) {
  const m = v1.decodePayload(fixture('protocol-v1/minor1', name), 'server', {maxMinor: 1}) as v1.ServerMessage;
  if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return m.data;
}
const v1Normalized = (name: string) => { const {state, status} = minor2(name); return normalizeV1State(state, status); };
const live = (status: LiveViewSource['status'] = 'connected', fresh = true): LiveViewSource =>
  ({selection: 'ets2', status, fresh, observation: {source: {origin: 'synthetic', game: 'ets2'}}});
const viewOf = (state: NormalizedLiveState, source = live()) => buildLiveView(source, state, resolveDisplayUnits('ets2'));
const breakRow = (state: NormalizedLiveState, source = live()) => {
  const row = viewOf(state, source).sections.flatMap(section => section.fields).find(field => field.id === 'mandatory-break');
  if (!row) throw new Error('no mandatory-break row');
  return row;
};
/** The same state with the break replaced, to test the presentation rules at exact values. */
const withBreak = (state: NormalizedLiveState, minutes: number): NormalizedLiveState => ({...state, nextMandatoryBreak: {state: 'value', value: minutes}});

describe('ET-052 break urgency (D3)', () => {
  it('declares two hours as the soon threshold', () => { expect(BREAK_SOON_MINUTES).toBe(120); });
  it.each([
    [INT32_MIN, 'due'], [-1_000, 'due'], [-30, 'due'], [-1, 'due'], [0, 'due'], [1, 'soon'], [59, 'soon'], [60, 'soon'], [119, 'soon'],
    [120, 'normal'], [121, 'normal'], [600, 'normal'], [INT32_MAX, 'normal']
  ] as const)('%i minutes is %s', (minutes, urgency) => { expect(breakUrgency(minutes)).toBe(urgency); });
});

describe('ET-052 break text (D3: clamped at zero)', () => {
  it.each([
    [0, '0 min'], [1, '1 min'], [59, '59 min'], [60, '1 h 0 min'], [61, '1 h 1 min'], [95, '1 h 35 min'], [119, '1 h 59 min'], [120, '2 h 0 min'],
    [121, '2 h 1 min'], [600, '10 h 0 min'], [INT32_MAX, '35791394 h 7 min'],
    [-1, '0 min'], [-30, '0 min'], [-61, '0 min'], [INT32_MIN, '0 min']
  ])('%i minutes reads %s', (minutes, text) => { expect(formatMandatoryBreak(minutes)).toBe(text); });
  it('uses the caller-supplied unit labels', () => {
    expect(formatMandatoryBreak(95, {h: 'ч', min: 'мин'})).toBe('1 ч 35 мин'); expect(formatMandatoryBreak(-5, {h: 'ч', min: 'мин'})).toBe('0 мин');
  });
});

describe('ET-052 break normalization', () => {
  it('keeps the signed raw value: zero and overdue are values, never clamped or unavailable', () => {
    expect(v1Normalized('checkpoint').nextMandatoryBreak).toEqual({state: 'value', value: 95});
    expect(v1Normalized('snapshot-break-zero').nextMandatoryBreak).toEqual({state: 'value', value: 0});
    expect(v1Normalized('snapshot-break-negative').nextMandatoryBreak).toEqual({state: 'value', value: -30});
    expect(v1Normalized('snapshot-break-int32-max').nextMandatoryBreak).toEqual({state: 'value', value: INT32_MAX});
    expect(v1Normalized('snapshot-break-int32-min').nextMandatoryBreak).toEqual({state: 'value', value: INT32_MIN});
  });
  it('keeps each unavailable reason', () => {
    expect(v1Normalized('snapshot-break-not-observed').nextMandatoryBreak).toEqual({state: 'missing', reason: 'not-observed'});
    expect(v1Normalized('snapshot-break-not-supported').nextMandatoryBreak).toEqual({state: 'missing', reason: 'not-supported'});
    expect(v1Normalized('snapshot-break-invalid').nextMandatoryBreak).toEqual({state: 'missing', reason: 'invalid'});
  });
  it('reports not-supported for a v1 state below minor 2, which carries no break', () => {
    const minor1 = minor1State('checkpoint'), minor0 = v1.decodePayload(fixture('protocol-v1', 'snapshot'), 'server');
    if (minor0.kind !== 'snapshot') throw new Error('fixture');
    expect(normalizeV1State(minor1.state, minor1.status).nextMandatoryBreak).toEqual({state: 'missing', reason: 'not-supported'});
    expect(normalizeV1State(minor0.data.state, minor0.data.status).nextMandatoryBreak).toEqual({state: 'missing', reason: 'not-supported'});
  });
  it('reports not-carried under protocol v0', () => {
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(normalizeV0State(message.data.state).nextMandatoryBreak).toEqual({state: 'missing', reason: 'not-carried'});
  });
  it('does not change any other reading of the state', () => {
    // The minor-2 snapshot differs from its minor-1 sibling only by the break; everything else normalizes identically.
    const a = minor2('snapshot'), b = minor1State('snapshot');
    const {nextMandatoryBreak: withBreakReading, ...rest} = normalizeV1State(a.state, a.status);
    const {nextMandatoryBreak: withoutBreakReading, ...restWithout} = normalizeV1State(b.state, b.status);
    expect(rest).toEqual(restWithout);
    expect(withBreakReading).toEqual({state: 'value', value: 95}); expect(withoutBreakReading).toEqual({state: 'missing', reason: 'not-supported'});
  });
});

describe('ET-052 break row in the live view', () => {
  const base = v1Normalized('snapshot');
  it('is a v1-only row in the time section, after the delivery deadline', () => {
    const view = viewOf(base);
    expect(view.sections.find(section => section.id === 'time')!.fields.map(field => field.id)).toEqual(['game-time', 'deadline', 'mandatory-break']);
    expect(V0_CARRIED_FIELDS.has('mandatory-break')).toBe(false);
    expect(carriesField('v0', 'mandatory-break')).toBe(false); expect(carriesField('v1', 'mandatory-break')).toBe(true);
  });
  it('shows 1 h 35 min as soon, with the game-time note, for 95 minutes', () => {
    expect(breakRow(base)).toEqual({id: 'mandatory-break', state: 'value', text: '1 h 35 min', notes: ['game-time'], urgency: 'soon'});
  });
  it.each([
    [INT32_MIN, '0 min', 'due'], [-30, '0 min', 'due'], [0, '0 min', 'due'], [1, '1 min', 'soon'], [119, '1 h 59 min', 'soon'],
    [120, '2 h 0 min', undefined], [121, '2 h 1 min', undefined], [INT32_MAX, '35791394 h 7 min', undefined]
  ] as const)('shows %i minutes as %s with urgency %s', (minutes, text, urgency) => {
    const row = breakRow(withBreak(base, minutes));
    expect(row).toMatchObject({state: 'value', text}); expect(row.urgency).toBe(urgency);
    expect(Object.hasOwn(row, 'urgency')).toBe(urgency !== undefined);
  });
  it('keeps zero distinct from every unavailable reading', () => {
    expect(breakRow(v1Normalized('snapshot-break-zero'))).toMatchObject({state: 'value', text: '0 min', urgency: 'due'});
    expect(breakRow(v1Normalized('snapshot-break-not-observed'))).toEqual({id: 'mandatory-break', state: 'missing', text: 'unavailable', reason: 'not-observed', notes: ['game-time']});
    expect(breakRow(v1Normalized('snapshot-break-not-supported'))).toMatchObject({state: 'missing', reason: 'not-supported'});
    expect(breakRow(v1Normalized('snapshot-break-invalid'))).toMatchObject({state: 'missing', reason: 'invalid'});
  });
  it('is not-supported below minor 2 and hidden as not carried under v0', () => {
    const minor1 = minor1State('snapshot');
    expect(breakRow(normalizeV1State(minor1.state, minor1.status))).toMatchObject({state: 'missing', reason: 'not-supported'});
    const message = v0.decodePayload(fixture('protocol-v0', 'snapshot'));
    if (message.kind !== 'snapshot') throw new Error('fixture');
    expect(breakRow(normalizeV0State(message.data.state)))
      .toEqual({id: 'mandatory-break', state: 'hidden', text: '', reason: 'not-carried', notes: ['game-time']});
  });
  it('is not current, with no urgency, when the source is stale or not connected', () => {
    for (const source of [live('stale', false), live('connected', false), live('disconnected'), live('waiting')]) {
      expect(breakRow(withBreak(base, 0), source)).toEqual({id: 'mandatory-break', state: 'missing', text: 'unavailable', reason: 'not-current', notes: ['game-time']});
    }
    const paused = breakRow(withBreak(base, 30), live('paused'));
    expect(paused).toMatchObject({state: 'value', text: '30 min', urgency: 'soon'});
  });
  it('shows no break before any normalized state exists', () => {
    const row = buildLiveView(live(), undefined, resolveDisplayUnits('ets2')).sections.flatMap(section => section.fields).find(field => field.id === 'mandatory-break');
    expect(row).toEqual({id: 'mandatory-break', state: 'missing', text: 'unavailable', reason: 'not-current', notes: ['game-time']});
  });
  it('rejects a non-integer reading as invalid instead of formatting it', () => {
    expect(breakRow(withBreak(base, 1.5))).toMatchObject({state: 'missing', reason: 'invalid'});
    expect(breakRow(withBreak(base, Number.NaN))).toMatchObject({state: 'missing', reason: 'invalid'});
  });
});
