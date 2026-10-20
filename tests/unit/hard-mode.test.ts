import {describe, expect, it} from 'vitest';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {isHardModeDetails, isHardModeObservation, isHardModeStatus} from '../../packages/contracts/src/hard-mode';
import {hardModeView} from '../../apps/desktop/src/hard-mode/view';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
const evaluate = (text = HARD_MODE_CONFIG) => evaluateHardMode(parseHardModeConfig(text), 1000, 'fixture');
describe('ET-026 persisted settings (REG-009/010)', () => {
  it('passes exactly twelve independently supplied configured rules; parking still awaits delivery', () => {
    const a = evaluate(); expect(a.state).toBe('pass'); expect(a.rules).toHaveLength(12);
    const details = advanceHardMode(null, a); expect(details.firstLoss).toBeNull(); expect(details.manualDelivery).toBeNull(); expect(isHardModeDetails(details)).toBe(true);
    expect(hardModeView({assessment: a, trip: details}, 2000)).toMatchObject({headline: 'Hard Mode settings active', passed: 12, age: '1 s since observation'});
  });
  it.each([
    ['g_fuel_simulation', '0', 'fuel'], ['g_hardcore_simulation', '0', 'air'], ['g_police', '0', 'police'], ['g_fatigue', '0', 'fatigue'],
    ['g_use_speed_limiter', '0', 'limiter'], ['g_truck_stability', '0.6', 'truck'], ['g_trailer_stability', '0.6', 'trailer'],
    ['g_simple_parking_doubles', '1', 'parking'], ['g_parking_difficulty', '1', 'parking'], ['g_bad_weather_factor', '0.1', 'rain'],
    ['g_road_events', '0.2', 'events'], ['g_brake_intensity', '0.8', 'braking'], ['g_traffic', '0.9', 'traffic']
  ])('fails %s independently without changing other rules', (key, value, id) => {
    const a = evaluate(HARD_MODE_CONFIG.replace(new RegExp(`${key} "[^"]+"`), `${key} "${value}"`));
    expect(a.state).toBe('fail'); expect(a.rules.filter(r => r.state === 'fail').map(r => r.id)).toEqual([id]);
  });
  it('handles whitespace, comments, exponent/decimal syntax and identical numeric duplicates', () => {
    const text = HARD_MODE_CONFIG.replace('uset g_traffic "1.0"', '  uset  g_traffic  "1e0" // comment\n uset g_traffic "+1.000" # identical');
    expect(evaluate(text).state).toBe('pass');
  });
  it.each(['NaN', 'Infinity', '1oops', '1e999', '', '0x1'])('does not accept partial/nonfinite numeric text %s', value => {
    expect(evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', `g_fatigue "${value}"`)).rules[3]).toMatchObject({state: 'unknown', reason: 'malformed', values: [null]});
  });
  it('rejects malformed relevant lines, missing inputs and conflicting duplicates', () => {
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police 1').rules[2].reason).toBe('malformed');
    expect(evaluate(HARD_MODE_CONFIG.replace('uset g_police "1"', '')).rules[2].reason).toBe('missing');
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police "0"').rules[2].reason).toBe('conflicting');
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police "' + '1'.repeat(8192) + '"').rules[2].state).toBe('unknown');
    expect(evaluate('x'.repeat(256 * 1024 + 1)).state).toBe('unknown');
  });
  it('keeps exact booleans distinct from numeric comparison tolerance', () => {
    expect(evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0.9999999"')).state).toBe('fail');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_truck_stability "0.5"', 'g_truck_stability "0.500001"')).state).toBe('pass');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_truck_stability "0.5"', 'g_truck_stability "0.500002"')).state).toBe('fail');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_bad_weather_factor "0.12"', 'g_bad_weather_factor "0.119999"')).state).toBe('pass');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_bad_weather_factor "0.12"', 'g_bad_weather_factor "0.119998"')).state).toBe('fail');
  });
  it('retains the first failure through restoration and unknown observations', () => {
    const pass = evaluate(), fail = evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
    const d = advanceHardMode(advanceHardMode(advanceHardMode(null, pass), fail), pass);
    expect(d.firstLoss).toEqual({atUtcMs: 1000, reason: 'outside-limit', rule: 'fatigue', values: [0]});
    expect(advanceHardMode(d, unknownHardMode(2000)).firstLoss).toEqual(d.firstLoss);
    const restored = hardModeView({assessment: pass, trip: d}, 2000);
    expect(restored.headline).toBe('Hard Mode lost for this trip');
    expect(restored.loss).toContain('Does not meet the required setting; detected 0');
    expect(hardModeView({assessment: fail, trip: d}, 2000).rows[3]).toMatchObject({reason: 'Does not meet the required setting', detected: 'Off (0)', required: 'On (1)'});
    expect(hardModeView({assessment: evaluate(HARD_MODE_CONFIG.replace('uset g_police "1"', '')), trip: null}, 2000).rows[2].reason).toBe('Required setting is missing');
  });
  it('does not move latest evidence backwards when an older intake snapshot follows a newer observed loss', () => {
    const opening = evaluate(), lost = {...evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), observedUtcMs: 2000};
    const details = advanceHardMode(advanceHardMode(advanceHardMode(null, opening), lost), opening);
    expect(details.latest).toEqual(lost); expect(details.firstLoss).toMatchObject({atUtcMs: 2000, rule: 'fatigue', values: [0]});
    expect(advanceHardMode(details, {...opening, observedUtcMs: 3000})).toMatchObject({latest: {state: 'pass', observedUtcMs: 3000}, firstLoss: {rule: 'fatigue', values: [0]}});
  });
  it('rejects unlisted fields, identities, bad lengths and malformed cross-boundary values', () => {
    const status = {assessment: evaluate(), trip: null}; expect(isHardModeStatus(status)).toBe(true);
    expect(isHardModeStatus({...status, filename: 'private'})).toBe(false);
    expect(isHardModeStatus({...status, assessment: {...status.assessment, rules: []}})).toBe(false);
    expect(isHardModeObservation({assessment: evaluate(), binding: 'raw profile', pluginSessionId: null, sourceMonotonicNs: null})).toBe(false);
  });
});
