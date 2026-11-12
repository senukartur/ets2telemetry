import {describe, expect, it, vi} from 'vitest';
import type {HardModeAssessment, HardModeDetails, HardModeRule, HardModeStatus} from '../../packages/contracts/src/hard-mode';
import {HARD_MODE_RULE_IDS} from '../../packages/contracts/src/hard-mode';
import type {OverlayHardMode, OverlayPresentation} from '../../packages/contracts/src';
import {OVERLAY_HARD_MODE_RULES, overlayHardMode, sameOverlayHardMode, sanitizeOverlayHardMode, staleOverlayHardMode} from '../../apps/desktop/src/overlay-hard-mode';
import {staleOverlay} from '../../apps/desktop/src/overlay-sections';
import {overlayHardModeItem, overlayView} from '../../apps/desktop/src/overlay-view';

// ET-070 (owner decisions D1-D4): the overlay's fixed Hard Mode indicator. Main maps its lease-checked status to an enum
// and a pass count; the preload and the view model validate it again; nothing but positive evidence is `active`.
type RuleState = HardModeRule['state'];
/** An assessment whose twelve rules have the given states in HARD_MODE_RULE_IDS order. */
function assessment(state: HardModeAssessment['state'], states: RuleState[]): HardModeAssessment {
  expect(states).toHaveLength(12);
  return {observedUtcMs: 1000, state, source: 'fixture', rules: HARD_MODE_RULE_IDS.map((id, index) => ({id, state: states[index],
    values: [states[index] === 'unknown' ? null : 1], reason: states[index] === 'pass' ? 'compliant' : states[index] === 'fail' ? 'outside-limit' : 'missing'}))};
}
const repeat = (state: RuleState, count: number): RuleState[] => Array.from({length: count}, () => state);
const PASS = assessment('pass', repeat('pass', 12));
const FATIGUE_OFF = assessment('fail', [...repeat('pass', 3), 'fail', ...repeat('pass', 8)]);
const UNKNOWN = assessment('unknown', repeat('unknown', 12));
function trip(firstLoss: HardModeDetails['firstLoss']): HardModeDetails {
  return {version: 1, binding: null, opening: PASS, latest: PASS, firstLoss, manualDelivery: null};
}
const LOSS: HardModeDetails['firstLoss'] = {atUtcMs: 2000, reason: 'outside-limit', rule: 'fatigue', values: [0]};
const status = (value: HardModeAssessment, details: HardModeDetails | null = null): Pick<HardModeStatus, 'assessment' | 'trip'> => ({assessment: value, trip: details});

describe('the indicator main projects from its Hard Mode status', () => {
  it('is active only for a passing assessment, exactly {state: active}', () => {
    expect(OVERLAY_HARD_MODE_RULES).toBe(12);
    expect(overlayHardMode(status(PASS))).toStrictEqual({state: 'active'});
    // A current trip without a loss does not change it.
    expect(overlayHardMode(status(PASS, trip(null)))).toStrictEqual({state: 'active'});
  });
  it.each<{name: string; value: HardModeAssessment; passed: number}>([
    // Fatigue off, the smoke's failing fixture: 11 of 12.
    {name: 'one failing rule', value: FATIGUE_OFF, passed: 11},
    {name: 'seven passing, three failing and two unknown rules', value: assessment('fail', [...repeat('pass', 7), ...repeat('fail', 3), ...repeat('unknown', 2)]), passed: 7},
    {name: 'twelve failing rules', value: assessment('fail', repeat('fail', 12)), passed: 0},
    // A partly unknown observation is not active, but it counts the rules that do pass.
    {name: 'eleven passing rules and one unknown', value: assessment('unknown', [...repeat('pass', 11), 'unknown']), passed: 11},
    {name: 'one failing rule and eleven unknown', value: assessment('unknown', ['fail', ...repeat('unknown', 11)]), passed: 0}
  ])('is not active with the pass count for $name', ({value, passed}) => {
    expect(overlayHardMode(status(value))).toStrictEqual({state: 'inactive', passed});
  });
  it('shows no count when every rule is unknown: an expired lease, a service that is not ready or no evidence (D4)', () => {
    const projected = overlayHardMode(status(UNKNOWN));
    expect(projected).toStrictEqual({state: 'inactive'});
    expect(Object.keys(projected)).toEqual(['state']);
  });
  it.each([['pass', PASS], ['fail', FATIGUE_OFF], ['unknown', UNKNOWN]] as const)('is lost on a legacy v1 current trip loss, whatever the %s assessment', (_name, value) => {
    expect(overlayHardMode(status(value, trip(LOSS)))).toStrictEqual({state: 'lost'});
  });
});

describe('the current settings of a recoverable v2 trip', () => {
  const diagnostic = {atUtcMs:2000,code:'rule-failed' as const,rule:'fatigue' as const,values:[0]};
  const details: HardModeDetails = {version:2,binding:null,opening:PASS,latest:FATIGUE_OFF,firstLoss:null,manualDelivery:null,
    checkpoint:null,passingChecks:1,failingChecks:1,unknownChecks:3,firstDiagnostic:diagnostic,latestDiagnostic:diagnostic};
  it.each<[HardModeAssessment, OverlayHardMode]>([
    [PASS,{state:'active'}], [FATIGUE_OFF,{state:'inactive',passed:11}], [UNKNOWN,{state:'inactive'}]
  ])('uses the current assessment despite a below-threshold ratio and retained diagnostics: %s', (value,expected) => {
    expect(overlayHardMode(status(value,details))).toStrictEqual(expected);
  });
});

describe('the strict validation of an untrusted indicator', () => {
  it.each<[string, unknown, OverlayHardMode]>([
    ['active', {state: 'active'}, {state: 'active'}],
    ['lost', {state: 'lost'}, {state: 'lost'}],
    ['not active without a count', {state: 'inactive'}, {state: 'inactive'}],
    ['not active with 0', {state: 'inactive', passed: 0}, {state: 'inactive', passed: 0}],
    ['not active with 11', {state: 'inactive', passed: 11}, {state: 'inactive', passed: 11}],
    ['a null-prototype active', Object.assign(Object.create(null) as object, {state: 'active'}), {state: 'active'}]
  ])('keeps %s', (_name, value, expected) => {
    expect(sanitizeOverlayHardMode(value)).toStrictEqual(expected);
  });
  class Indicator {state = 'active';}
  it.each<[string, unknown]>([
    ['undefined', undefined], ['null', null], ['a string', 'active'], ['a number', 1], ['a boolean', true], ['an array', [{state: 'active'}]],
    ['an unknown state', {state: 'pass'}], ['another case', {state: 'ACTIVE'}], ['no state', {passed: 3}], ['a numeric state', {state: 1}],
    ['active with an extra key', {state: 'active', source: 'cloud'}], ['active with a count', {state: 'active', passed: 11}],
    ['lost with a count', {state: 'lost', passed: 0}], ['active with a symbol key', {state: 'active', [Symbol('extra')]: true}],
    ['a count of 12', {state: 'inactive', passed: 12}], ['a negative count', {state: 'inactive', passed: -1}],
    ['a fractional count', {state: 'inactive', passed: 1.5}], ['a NaN count', {state: 'inactive', passed: Number.NaN}],
    ['an infinite count', {state: 'inactive', passed: Number.POSITIVE_INFINITY}], ['a string count', {state: 'inactive', passed: '3'}],
    ['an unsafe count', {state: 'inactive', passed: 2 ** 53}], ['an undefined count', {state: 'inactive', passed: undefined}],
    ['a count with an extra key', {state: 'inactive', passed: 3, extra: 1}],
    ['an inherited state', Object.create({state: 'active'}) as object], ['a class instance', new Indicator()]
  ])('turns %s into not active without a count', (_name, value) => {
    expect(sanitizeOverlayHardMode(value)).toStrictEqual({state: 'inactive'});
  });
  it('never runs an accessor and never accepts one', () => {
    const state = vi.fn(() => 'active'), passed = vi.fn(() => 3);
    expect(sanitizeOverlayHardMode(Object.defineProperty({}, 'state', {get: state, enumerable: true}))).toStrictEqual({state: 'inactive'});
    expect(sanitizeOverlayHardMode(Object.defineProperty({state: 'inactive'}, 'passed', {get: passed, enumerable: true}))).toStrictEqual({state: 'inactive'});
    expect(state).not.toHaveBeenCalled(); expect(passed).not.toHaveBeenCalled();
  });
  it('compares indicators by state and count, two missing ones being equal', () => {
    expect(sameOverlayHardMode(undefined, undefined)).toBe(true);
    expect(sameOverlayHardMode(undefined, {state: 'inactive'})).toBe(false);
    expect(sameOverlayHardMode({state: 'active'}, {state: 'active'})).toBe(true);
    expect(sameOverlayHardMode({state: 'inactive', passed: 3}, {state: 'inactive', passed: 3})).toBe(true);
    expect(sameOverlayHardMode({state: 'inactive'}, {state: 'inactive', passed: 3})).toBe(false);
    expect(sameOverlayHardMode({state: 'active'}, {state: 'lost'})).toBe(false);
  });
});

describe('the indicator after the overlay preload quiet deadline', () => {
  const base: OverlayPresentation = {source: 'ETS2', origin: 'game', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73', fuelUnit: 'L',
    freshness: 'current', layout: 'strip', paused: false, sections: [{id: 'speed', state: 'value', text: '90 km/h'}], editing: false};
  it.each<[string, OverlayHardMode | undefined, OverlayHardMode | undefined]>([
    ['active', {state: 'active'}, {state: 'inactive'}],
    ['not active with a count', {state: 'inactive', passed: 11}, {state: 'inactive'}],
    ['not active', {state: 'inactive'}, {state: 'inactive'}],
    ['lost', {state: 'lost'}, {state: 'lost'}],
    ['missing', undefined, undefined]
  ])('turns %s into the expected stale indicator', (_name, value, expected) => {
    expect(staleOverlayHardMode(value)).toStrictEqual(expected);
    const stale = staleOverlay(value === undefined ? base : {...base, hardMode: value});
    expect(stale).toMatchObject({freshness: 'stale', status: 'stale', sections: [{id: 'speed', state: 'unavailable'}]});
    if (expected === undefined) expect('hardMode' in stale).toBe(false);
    else expect(stale.hardMode).toStrictEqual(expected);
  });
  it('downgrades a malformed indicator instead of keeping it', () => {
    expect(staleOverlayHardMode({state: 'active', passed: 3} as unknown as OverlayHardMode)).toStrictEqual({state: 'inactive'});
  });
});

describe('the indicator texts and accessible names', () => {
  // Hand-written from strings.ts: "HM" is the strip's and HUD's label in both languages, the row label is "Hard Mode".
  const common = {testId: 'overlay-hard-mode', label: 'Hard Mode', short: 'HM'};
  it.each<[string, 'en' | 'ru', unknown, Record<string, unknown>]>([
    ['active', 'en', {state: 'active'}, {state: 'active', cue: 'check', struck: false, rowValue: '12/12', hudValue: '', name: 'Hard Mode active, 12 of 12'}],
    ['active', 'ru', {state: 'active'}, {state: 'active', cue: 'check', struck: false, rowValue: '12/12', hudValue: '', name: 'Hard Mode активен, 12 из 12'}],
    ['lost', 'en', {state: 'lost'}, {state: 'lost', cue: 'cross', struck: true, rowValue: 'lost', hudValue: '', name: 'Hard Mode lost for this trip'}],
    ['lost', 'ru', {state: 'lost'}, {state: 'lost', cue: 'cross', struck: true, rowValue: 'потерян', hudValue: '', name: 'Hard Mode потерян для этого рейса'}],
    ['not active', 'en', {state: 'inactive'}, {state: 'inactive', cue: 'none', struck: false, rowValue: '', hudValue: '', name: 'Hard Mode not active'}],
    ['not active', 'ru', {state: 'inactive'}, {state: 'inactive', cue: 'none', struck: false, rowValue: '', hudValue: '', name: 'Hard Mode не активен'}],
    ['not active, 11', 'en', {state: 'inactive', passed: 11}, {state: 'inactive', cue: 'none', struck: false, rowValue: '11/12', hudValue: '11/12', name: 'Hard Mode not active, 11 of 12'}],
    ['not active, 11', 'ru', {state: 'inactive', passed: 11}, {state: 'inactive', cue: 'none', struck: false, rowValue: '11/12', hudValue: '11/12', name: 'Hard Mode не активен, 11 из 12'}],
    ['not active, 0', 'en', {state: 'inactive', passed: 0}, {state: 'inactive', cue: 'none', struck: false, rowValue: '0/12', hudValue: '0/12', name: 'Hard Mode not active, 0 of 12'}],
    ['malformed', 'en', {state: 'active', passed: 12}, {state: 'inactive', cue: 'none', struck: false, rowValue: '', hudValue: '', name: 'Hard Mode not active'}],
    ['missing', 'ru', undefined, {state: 'inactive', cue: 'none', struck: false, rowValue: '', hudValue: '', name: 'Hard Mode не активен'}]
  ])('describes %s in %s', (_name, language, value, expected) => {
    expect(overlayHardModeItem(value, language)).toStrictEqual({...common, ...expected});
  });
  const presentation: OverlayPresentation = {source: 'ETS2', origin: 'game', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73', fuelUnit: 'L',
    freshness: 'current', layout: 'strip', paused: false, sections: [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'gear', state: 'value', text: '3'},
      {id: 'fuel', state: 'value', text: '73 L'}, {id: 'cargo', state: 'value', text: 'Logs'}], editing: false, language: 'ru'};
  it.each(['strip', 'card', 'cluster', 'hud'] as const)('gives the %s view the indicator in the projection language, outside its sections', layout => {
    const view = overlayView({...presentation, layout, hardMode: {state: 'inactive', passed: 7}});
    expect(view.hardMode).toStrictEqual({...common, state: 'inactive', cue: 'none', struck: false, rowValue: '7/12', hudValue: '7/12', name: 'Hard Mode не активен, 7 из 12'});
    expect(view.items.map(item => item.id)).toEqual(['speed', 'gear', 'fuel', 'cargo']);
    expect(JSON.stringify([view.items, view.groups, view.panel, view.gauge ?? null])).not.toContain('hard-mode');
  });
  it('gives the placeholder and a projection without the field the not-active indicator', () => {
    expect(overlayView().hardMode).toMatchObject({state: 'inactive', name: 'Hard Mode not active', rowValue: ''});
    expect(overlayView({...presentation, language: 'en'}).hardMode).toMatchObject({state: 'inactive', name: 'Hard Mode not active', cue: 'none'});
  });
});
