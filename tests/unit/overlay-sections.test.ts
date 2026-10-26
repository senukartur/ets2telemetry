import {expect, it} from 'vitest';
import type {OverlayPresentation} from '../../packages/contracts/src';
import {
  CLUSTER_GAUGE_SECTIONS, DEFAULT_OVERLAY_SETTINGS, enabledSectionCount, isOverlayLayout, OVERLAY_GROUPS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS, OVERLAY_SECTION_REQUIREMENTS,
  isGaugeFraction, overlayGauges, overlayUrgency, parseOverlaySections, sameSections, staleOverlay
} from '../../apps/desktop/src/overlay-sections';

// Hand-written expectations (ET-012a plan, design step 2). ET-052 appends the fifteenth section last.
const IDS = ['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining',
  'deadline', 'expected-income', 'game-time', 'mandatory-break'];
const only = (...enabled: string[]) => Object.fromEntries(IDS.map(id => [id, enabled.includes(id)]));
const ALL_ON = only(...IDS);
const without = (record: Record<string, boolean>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('lists fifteen sections in canonical order and groups each exactly once', () => {
  expect(OVERLAY_SECTION_IDS).toEqual(IDS);
  expect(OVERLAY_GROUPS.map(group => [group.id, group.sections])).toEqual([
    ['driving', ['speed', 'gear', 'rpm']],
    ['fuel', ['fuel', 'range', 'sdk-consumption']],
    ['job', ['cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income']],
    ['time', ['game-time', 'mandatory-break']]
  ]);
});

it('shows speed, gear and RPM in the cluster gauge and nothing else (ET-012d decision K7)', () => {
  expect([...CLUSTER_GAUGE_SECTIONS]).toEqual(['speed', 'gear', 'rpm']);
});

it('defaults to the strip layout with every section and the default placements, and defines three complete presets', () => {
  // ET-012b added the default placements: the ET-012a anchors at scale 1.
  expect(DEFAULT_OVERLAY_SETTINGS).toEqual({enabled: true, backgroundOpacity: 80, layout: 'strip', sections: ALL_ON, placements: {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1},
    cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}}});
  // ET-052 (MB11): only `everything` includes the break; job-focus and driving-only are unchanged.
  expect(OVERLAY_PRESETS).toEqual({
    'everything': ALL_ON,
    'job-focus': only('speed', 'gear', 'fuel', 'cargo', 'destination', 'distance-remaining', 'deadline'),
    'driving-only': only('speed', 'gear', 'rpm', 'fuel', 'range')
  });
  expect(Object.isFrozen(OVERLAY_PRESETS['job-focus'])).toBe(true);
  expect(enabledSectionCount(OVERLAY_PRESETS['driving-only'])).toBe(5);
  expect(enabledSectionCount(OVERLAY_PRESETS['everything'])).toBe(15);
  expect(OVERLAY_PRESETS['job-focus']['mandatory-break']).toBe(false);
  expect(OVERLAY_PRESETS['driving-only']['mandatory-break']).toBe(false);
  expect(sameSections(OVERLAY_PRESETS['everything'], {...ALL_ON} as never)).toBe(true);
  expect(sameSections(OVERLAY_PRESETS['everything'], OVERLAY_PRESETS['job-focus'])).toBe(false);
});

it('marks the sections that need protocol v1 or trip tracking', () => {
  expect(OVERLAY_SECTION_REQUIREMENTS).toEqual({'origin': 'protocol-v1', 'distance-remaining': 'protocol-v1', 'deadline': 'protocol-v1',
    'mandatory-break': 'protocol-v1', 'distance-driven': 'trip-tracking', 'cargo': 'ids-until-v1', 'destination': 'ids-until-v1'});
});

it('accepts exactly the four layout ids', () => {
  for (const layout of ['strip', 'card', 'cluster', 'hud']) expect(isOverlayLayout(layout)).toBe(true);
  for (const value of ['Strip', 'bar', '', null, undefined, 1, ['strip'], {layout: 'strip'}]) expect(isOverlayLayout(value)).toBe(false);
});

it('parses a complete section record into a fresh frozen copy', () => {
  const input = only('fuel');
  const parsed = parseOverlaySections(input);
  expect(parsed).toEqual(input); expect(parsed).not.toBe(input); expect(Object.isFrozen(parsed)).toBe(true);
  expect(parseOverlaySections(Object.assign(Object.create(null) as object, ALL_ON))).toEqual(ALL_ON);
});

it.each([
  ['an extra key', {...ALL_ON, theme: true}],
  ['a missing key', without(ALL_ON, 'rpm')],
  ['the fourteen keys of before ET-052', without(ALL_ON, 'mandatory-break')],
  ['a non-boolean value', {...ALL_ON, rpm: 1}],
  ['a string boolean', {...ALL_ON, gear: 'true'}],
  ['every section disabled', only()],
  ['an array', [true]],
  ['null', null],
  ['a string', 'all'],
  ['a foreign prototype', Object.assign(Object.create({inherited: true}) as object, ALL_ON)],
  ['a class instance', Object.assign(new (class Sections {})(), ALL_ON)],
  ['a symbol key', {...ALL_ON, [Symbol('extra')]: true}]
])('rejects %s', (_name, value) => {
  expect(parseOverlaySections(value)).toBeUndefined();
});

it('never runs a getter while validating', () => {
  let read = false;
  const value = {...ALL_ON};
  Object.defineProperty(value, 'rpm', {enumerable: true, get: () => {read = true; return true;}});
  expect(parseOverlaySections(value)).toBeUndefined(); expect(read).toBe(false);
});

it('turns a presentation stale: placeholders for every shown section, same layout, units and edit mode, not paused', () => {
  const current: OverlayPresentation = {source: 'ATS', origin: 'game', status: 'paused', speed: '56', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal',
    freshness: 'current', layout: 'cluster', paused: true, sections: [{id: 'speed', state: 'value', text: '56 mph'}, {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
      {id: 'fuel', state: 'unavailable'}], editing: true};
  expect(staleOverlay(current)).toEqual({source: 'ATS', origin: 'game', status: 'stale', speed: '—', speedUnit: 'mph', fuel: '—', fuelUnit: 'US gal',
    freshness: 'stale', layout: 'cluster', paused: false, sections: [{id: 'speed', state: 'unavailable'}, {id: 'rpm', state: 'unavailable'}, {id: 'fuel', state: 'unavailable'}], editing: true});
  expect(current.sections[0]).toEqual({id: 'speed', state: 'value', text: '56 mph'});
});

// ET-045f: the Cluster gauge fractions are validated in main and the overlay preload with one rule.
it('accepts only finite gauge fractions in [0, 1]', () => {
  for (const value of [0, 0.5, 1]) expect(isGaugeFraction(value), String(value)).toBe(true);
  for (const value of [-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null, undefined, {}])
    expect(isGaugeFraction(value), JSON.stringify(value) ?? 'undefined').toBe(false);
});

it('keeps valid gauge fractions on current speed and RPM values only, leaving everything else unchanged', () => {
  const current: OverlayPresentation = {source: 'ETS2', origin: 'game', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L',
    freshness: 'current', layout: 'cluster', paused: false, editing: false, sections: [{id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13},
      {id: 'gear', state: 'value', text: 'R1'}, {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2}, {id: 'fuel', state: 'value', text: '73.0 L', detail: '73%'}]};
  expect(overlayGauges(current)).toBe(current);
  const at = (index: number, section: object): OverlayPresentation => ({...current, sections: current.sections.map((old, position) => position === index ? section as typeof old : old)});
  // A fraction on another section, or out of range, is removed; the section's other fields are kept.
  for (const [index, bad, good] of [
    [2, {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2, speedRing: 0.5}, {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2}],
    [0, {id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13, ring: 0.4}, {id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13}],
    [3, {id: 'fuel', state: 'value', text: '73.0 L', detail: '73%', ring: 0.5}, {id: 'fuel', state: 'value', text: '73.0 L', detail: '73%'}],
    [0, {id: 'speed', state: 'value', text: '90 km/h', speedRing: 2}, {id: 'speed', state: 'value', text: '90 km/h'}],
    [0, {id: 'speed', state: 'value', text: '90 km/h', speedRing: Number.NaN}, {id: 'speed', state: 'value', text: '90 km/h'}],
    [0, {id: 'speed', state: 'value', text: '90 km/h', speedRing: '0.5'}, {id: 'speed', state: 'value', text: '90 km/h'}],
    [2, {id: 'rpm', state: 'value', text: '600 rpm', ring: -1}, {id: 'rpm', state: 'value', text: '600 rpm'}],
    [2, {id: 'rpm', state: 'value', text: '600 rpm', ring: Number.POSITIVE_INFINITY}, {id: 'rpm', state: 'value', text: '600 rpm'}]
  ] as const) {
    const input = at(index, bad), output = overlayGauges(input);
    expect(output, JSON.stringify(bad)).toEqual(at(index, good));
    expect(output.sections.filter((_section, position) => position !== index)).toEqual(current.sections.filter((_section, position) => position !== index));
    expect(input.sections[index]).toEqual(bad);
  }
  // Not current: no section keeps a fraction.
  for (const freshness of ['stale', 'unavailable'] as const) expect(overlayGauges({...current, freshness})).toEqual({...current, freshness,
    sections: [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'gear', state: 'value', text: 'R1'}, {id: 'rpm', state: 'value', text: '600 rpm'}, {id: 'fuel', state: 'value', text: '73.0 L', detail: '73%'}]});
  // The preload's expiry carries no fraction at all.
  expect(staleOverlay(current).sections.some(section => 'ring' in section || 'speedRing' in section)).toBe(false);
  // Sections that are not an array pass through to the existing delivery checks unchanged.
  const malformed = {...current, sections: 'x'} as unknown as OverlayPresentation;
  expect(overlayGauges(malformed)).toBe(malformed);
});

// ET-052 (MB7): the break's urgency is validated in the overlay preload with one rule.
const BREAK_NOW: OverlayPresentation = {source: 'ETS2', origin: 'game', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L',
  freshness: 'current', layout: 'strip', paused: false, editing: false, sections: [{id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13},
    {id: 'mandatory-break', state: 'value', text: '1 h 35 min', urgency: 'soon'}]};
it('keeps the break urgency soon or due on a current value of the break section and leaves everything else unchanged', () => {
  expect(overlayUrgency(BREAK_NOW)).toBe(BREAK_NOW);
  const due: OverlayPresentation = {...BREAK_NOW, sections: [{id: 'mandatory-break', state: 'value', text: '0 min', urgency: 'due'}]};
  expect(overlayUrgency(due)).toBe(due);
  const normal: OverlayPresentation = {...BREAK_NOW, sections: [{id: 'mandatory-break', state: 'value', text: '2 h'}]};
  expect(overlayUrgency(normal)).toBe(normal);
});
it('strips an invalid or misplaced urgency without dropping the update or the text', () => {
  const at = (index: number, section: object): OverlayPresentation => ({...BREAK_NOW, sections: BREAK_NOW.sections.map((old, position) => position === index ? section as typeof old : old)});
  for (const [index, bad, good] of [
    [1, {id: 'mandatory-break', state: 'value', text: '1 h 35 min', urgency: 'normal'}, {id: 'mandatory-break', state: 'value', text: '1 h 35 min'}],
    [1, {id: 'mandatory-break', state: 'value', text: '1 h 35 min', urgency: 'SOON'}, {id: 'mandatory-break', state: 'value', text: '1 h 35 min'}],
    [1, {id: 'mandatory-break', state: 'value', text: '1 h 35 min', urgency: true}, {id: 'mandatory-break', state: 'value', text: '1 h 35 min'}],
    [1, {id: 'mandatory-break', state: 'value', text: '1 h 35 min', urgency: null}, {id: 'mandatory-break', state: 'value', text: '1 h 35 min'}],
    // Another section never carries one, and the speed's own fraction is kept.
    [0, {id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13, urgency: 'due'}, {id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13}],
    // An unavailable section never carries one.
    [1, {id: 'mandatory-break', state: 'unavailable', urgency: 'due'}, {id: 'mandatory-break', state: 'unavailable'}]
  ] as const) {
    const input = at(index, bad), output = overlayUrgency(input);
    expect(output, JSON.stringify(bad)).toEqual(at(index, good));
    expect(output.sections.filter((_section, position) => position !== index)).toEqual(BREAK_NOW.sections.filter((_section, position) => position !== index));
    expect(input.sections[index]).toEqual(bad);
  }
});
it('removes the urgency from a presentation that is not current, and from the preload expiry', () => {
  for (const freshness of ['stale', 'unavailable'] as const)
    expect(overlayUrgency({...BREAK_NOW, freshness})).toEqual({...BREAK_NOW, freshness, sections: [BREAK_NOW.sections[0], {id: 'mandatory-break', state: 'value', text: '1 h 35 min'}]});
  const expired = staleOverlay(BREAK_NOW);
  expect(expired.sections).toEqual([{id: 'speed', state: 'unavailable'}, {id: 'mandatory-break', state: 'unavailable'}]);
  expect(expired.sections.some(section => 'urgency' in section)).toBe(false);
  const malformed = {...BREAK_NOW, sections: 'x'} as unknown as OverlayPresentation;
  expect(overlayUrgency(malformed)).toBe(malformed);
});
it('composes with the gauge rule in either order', () => {
  const both: OverlayPresentation = {...BREAK_NOW, sections: [{id: 'speed', state: 'value', text: '90 km/h', speedRing: 2, urgency: 'due'},
    {id: 'mandatory-break', state: 'value', text: '0 min', urgency: 'due', ring: 0.5}]};
  const expected = {...BREAK_NOW, sections: [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'mandatory-break', state: 'value', text: '0 min', urgency: 'due'}]};
  expect(overlayUrgency(overlayGauges(both))).toEqual(expected);
  expect(overlayGauges(overlayUrgency(both))).toEqual(expected);
});
