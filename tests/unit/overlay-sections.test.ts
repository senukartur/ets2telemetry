import {expect, it} from 'vitest';
import type {OverlayPresentation} from '../../packages/contracts/src';
import {
  CLUSTER_GAUGE_SECTIONS, DEFAULT_OVERLAY_SETTINGS, enabledSectionCount, isOverlayLayout, OVERLAY_GROUPS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS, OVERLAY_SECTION_REQUIREMENTS,
  parseOverlaySections, sameSections, staleOverlay
} from '../../apps/desktop/src/overlay-sections';

// Hand-written expectations (ET-012a plan, design step 2).
const IDS = ['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining',
  'deadline', 'expected-income', 'game-time'];
const only = (...enabled: string[]) => Object.fromEntries(IDS.map(id => [id, enabled.includes(id)]));
const ALL_ON = only(...IDS);
const without = (record: Record<string, boolean>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('lists fourteen sections in canonical order and groups each exactly once', () => {
  expect(OVERLAY_SECTION_IDS).toEqual(IDS);
  expect(OVERLAY_GROUPS.map(group => [group.id, group.sections])).toEqual([
    ['driving', ['speed', 'gear', 'rpm']],
    ['fuel', ['fuel', 'range', 'sdk-consumption']],
    ['job', ['cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income']],
    ['time', ['game-time']]
  ]);
});

it('shows speed, gear and RPM in the cluster gauge and nothing else (ET-012d decision K7)', () => {
  expect([...CLUSTER_GAUGE_SECTIONS]).toEqual(['speed', 'gear', 'rpm']);
});

it('defaults to the strip layout with every section and the default placements, and defines three complete presets', () => {
  // ET-012b added the default placements: the ET-012a anchors at scale 1.
  expect(DEFAULT_OVERLAY_SETTINGS).toEqual({enabled: true, backgroundOpacity: 80, layout: 'strip', sections: ALL_ON, placements: {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1},
    cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}}});
  expect(OVERLAY_PRESETS).toEqual({
    'everything': ALL_ON,
    'job-focus': only('speed', 'gear', 'fuel', 'cargo', 'destination', 'distance-remaining', 'deadline'),
    'driving-only': only('speed', 'gear', 'rpm', 'fuel', 'range')
  });
  expect(Object.isFrozen(OVERLAY_PRESETS['job-focus'])).toBe(true);
  expect(enabledSectionCount(OVERLAY_PRESETS['driving-only'])).toBe(5);
  expect(sameSections(OVERLAY_PRESETS['everything'], {...ALL_ON} as never)).toBe(true);
  expect(sameSections(OVERLAY_PRESETS['everything'], OVERLAY_PRESETS['job-focus'])).toBe(false);
});

it('marks the sections that need protocol v1 or trip tracking', () => {
  expect(OVERLAY_SECTION_REQUIREMENTS).toEqual({'origin': 'protocol-v1', 'distance-remaining': 'protocol-v1', 'deadline': 'protocol-v1',
    'distance-driven': 'trip-tracking', 'cargo': 'ids-until-v1', 'destination': 'ids-until-v1'});
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
