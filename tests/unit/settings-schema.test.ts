import {expect, it} from 'vitest';
import {MAX_SETTINGS_BYTES, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';

const utf8 = (text: string) => new TextEncoder().encode(text);
const v1 = (units: unknown, extra: Record<string, unknown> = {}) => utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 1, units, ...extra}));
const v2 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 2, units, overlay, ...extra}));
const v3 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 3, units, overlay, ...extra}));
// ET-049: format v7 retains the prior fields and adds background opacity.
const v7 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 7, language, autostart, units, overlay, ...extra}));
// ET-045e (decision Z5; ET-049 took v7 first): the requirement for the current format changed to v8, which keeps v7's
// fields and reinterprets the saved scale numbers; the tests of the current format below moved from v7 to v8 documents.
const v8 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 8, language, autostart, units, overlay, ...extra}));
// ET-050: the requirement for the current format changed to v9, which adds the per-game gear display mode after the
// units; the tests of the current format below moved from v8 to v9 documents, and every expected settings value gains
// the automatic default for both games.
// ET-050b (owner option B, October 26, 2026): the requirement changed again to v10, which changes only the version and
// adds the crawler gear mode; the current-format documents below are now v10 and every newer-version seed moved to 11.
const AUTO = {ets2: 'automatic', ats: 'automatic'} as const;
// ET-052 (MB11; ET-050b took v10 first): the requirement for the current format changed to v11, which adds the overlay section
// `mandatory-break`; the tests of the current format below moved from v10 to v11 documents, and every document of an older
// format (the v10 helper below included) carries only the fourteen earlier section keys (OLD_*), so each migration test shows
// the new key being added on a copy.
const v10 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 10, language, autostart, units, gearDisplay: AUTO, overlay, ...extra}));
const v11 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 11, language, autostart, units, gearDisplay: AUTO, overlay, ...extra}));
// ET-050b per-gearbox modes (owner decision of October 27, 2026): the requirement for the current format changed to v12, which
// adds per-game gearbox lists after the gear display modes; the tests of the current format below moved from v11 to v12
// documents with empty lists, and every expected settings value gains them.
const NO_GEARBOXES = {ets2: [], ats: []};
const v12 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 12, language, autostart, units, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay, ...extra}));

// Hand-written expectations: the fifteen section ids in canonical order, all enabled by default; the fourteen of formats
// before v11 (OLD_ALL_ON) are the same without the last one.
const OLD_ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
const ALL_ON = {...OLD_ALL_ON, 'mandatory-break': true};
// The ET-012a anchors at scale 1, in canonical layout order.
const PLACEMENTS = {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}};
const MOVED = {...PLACEMENTS, card: {x: 0.25, y: 0.75, scale: 1.5}};
const DEFAULT_OVERLAY = {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: ALL_ON, placements: PLACEMENTS};
const OLD_DRIVING_ONLY = {...OLD_ALL_ON, 'sdk-consumption': false, 'cargo': false, 'origin': false, 'destination': false, 'distance-driven': false,
  'distance-remaining': false, 'deadline': false, 'expected-income': false, 'game-time': false};
// A v11 user who switched the break off as well as everything but driving; and the same user migrated from an older format,
// where the migration switches the break on and keeps every other choice.
const DRIVING_ONLY = {...OLD_DRIVING_ONLY, 'mandatory-break': false};
const MIGRATED_DRIVING_ONLY = {...OLD_DRIVING_ONLY, 'mandatory-break': true};
// The overlay block an older format wrote (fourteen sections, every one on).
const OLD_OVERLAY = {...DEFAULT_OVERLAY, sections: OLD_ALL_ON};
const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('migrates v4 purely to enabled v12 without adopting a previously unknown flag', () => {
  const old = {format: 'ets2telemetry.settings', version: 4, language: 'ru', units: {ets2: 'metric', ats: 'metric'}, overlay: {...OLD_OVERLAY, enabled: false}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 4)).toEqual({...old, version: 12, autostart: false, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80, sections: ALL_ON}});
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toMatchObject({state: 'loaded', migratedFrom: 4, settings: {overlay: {enabled: true}}});
});
it.each([undefined, null, 0, 1, 'false', {}, []])('falls back independently for invalid current enabled flag %j', enabled => {
  expect(parseSettings(v12('ru', true, {ets2: 'metric', ats: 'metric'}, {...DEFAULT_OVERLAY, enabled}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}, fallbackFields: ['overlay.enabled']});
});
it('roundtrips committed false in canonical v12 without falling back', () => {
  const settings = {language: 'ru' as const, autostart: true, units: {ets2: 'metric' as const, ats: 'us-customary' as const}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, layout: 'card' as const, sections: DRIVING_ONLY, placements: MOVED, enabled: false}};
  const serialized = serializeSettings(settings);
  expect(serialized).toContain('"overlay": {\n    "enabled": false,\n    "backgroundOpacity": 80,\n    "layout": "card"');
  expect(parseSettings(utf8(serialized))).toEqual({state: 'loaded', settings});
});

it('reads a valid current v12 file, ignoring unknown keys', () => {
  expect(parseSettings(v12('ru', false, {ets2: 'us-customary', ats: 'metric', future: 'x'},
    {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: {...DRIVING_ONLY, future: true}, placements: {...MOVED, future: {x: 0, y: 0, scale: 1}}, theme: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'ru', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED}}});
});

it('migrates a v3 file through v4 to v7 and on to v12 in memory: default language en, units and overlay kept, automatic gears, the break on, migratedFrom 3', () => {
  expect(parseSettings(v3({ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: OLD_DRIVING_ONLY, placements: MOVED})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: MIGRATED_DRIVING_ONLY, placements: MOVED}},
      migratedFrom: 3});
});

it('migrates a v2 file through v3 to v7 and on to v12 in memory: default language en, layout and sections kept, the break on, default placements, migratedFrom 2', () => {
  expect(parseSettings(v2({ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: OLD_DRIVING_ONLY})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: MIGRATED_DRIVING_ONLY, placements: PLACEMENTS}},
      migratedFrom: 2});
  // A v2 file never had placements: a stray key is replaced by the defaults.
  expect(parseSettings(v2({ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: OLD_ALL_ON, placements: MOVED})))
    .toMatchObject({state: 'loaded', settings: {language: 'en', overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', placements: PLACEMENTS}}, migratedFrom: 2});
});

it('migrates a v1 file through v2 to v7 and on to v12 in memory: default language en, autostart false, units kept, overlay defaults, migratedFrom 1', () => {
  expect(parseSettings(v1({ets2: 'us-customary', ats: 'metric', future: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}, migratedFrom: 1});
});

it('migrates v1, v2, v3 and v4 purely without mutating their input, and leaves current documents unchanged', () => {
  const document = {format: 'ets2telemetry.settings', version: 1, units: {ets2: 'metric', ats: 'metric'}};
  const snapshot = structuredClone(document);
  const migrated = migrateToCurrent(document, 1);
  expect(migrated).toEqual({format: 'ets2telemetry.settings', version: 12, language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY});
  expect(document).toEqual(snapshot);
  expect(migrated).not.toBe(document);

  const second = {format: 'ets2telemetry.settings', version: 2, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: OLD_DRIVING_ONLY}};
  const secondSnapshot = structuredClone(second);
  const upgraded = migrateToCurrent(second, 2);
  expect(upgraded).toEqual({...second, version: 12, language: 'en', autostart: false, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: MIGRATED_DRIVING_ONLY, placements: PLACEMENTS}});
  expect(second).toEqual(secondSnapshot); expect(upgraded!.overlay).not.toBe(second.overlay);

  const third = {format: 'ets2telemetry.settings', version: 3, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: OLD_DRIVING_ONLY, placements: PLACEMENTS}};
  const thirdSnapshot = structuredClone(third);
  const upgradedThird = migrateToCurrent(third, 3);
  expect(upgradedThird).toEqual({...third, version: 12, language: 'en', autostart: false, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...third.overlay, sections: MIGRATED_DRIVING_ONLY}});
  expect(third).toEqual(thirdSnapshot);

  const fourth = {format: 'ets2telemetry.settings', version: 4, language: 'ru', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'card', sections: OLD_DRIVING_ONLY, placements: PLACEMENTS}};
  const fourthSnapshot = structuredClone(fourth);
  const upgradedFourth = migrateToCurrent(fourth, 4);
  expect(upgradedFourth).toEqual({...fourth, version: 12, autostart: false, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...fourth.overlay, enabled: true, backgroundOpacity: 80, sections: MIGRATED_DRIVING_ONLY}});
  expect(fourth).toEqual(fourthSnapshot);

  // A v2 overlay that is not an object stays as it is.
  expect(migrateToCurrent({format: 'ets2telemetry.settings', version: 2, overlay: 'strip'}, 2)).toEqual({format: 'ets2telemetry.settings', version: 12, language: 'en', autostart: false, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: 'strip'});
  const current = {format: 'ets2telemetry.settings', version: 12};
  expect(migrateToCurrent(current, 12)).toBe(current);
  expect(migrateToCurrent({format: 'ets2telemetry.settings'}, 0)).toBeUndefined();
});

it('accepts a leading UTF-8 byte order mark', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...v12('en', false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY)]);
  expect(parseSettings(bytes)).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});

it.each([
  {name: 'invalid language', language: 'fr', expected: 'en', fields: ['language']},
  {name: 'numeric language', language: 123, expected: 'en', fields: ['language']},
  {name: 'uppercase language', language: 'EN', expected: 'en', fields: ['language']},
  {name: 'missing language', language: undefined, expected: 'en', fields: ['language']}
])('falls back per language field for $name', ({language, expected, fields}) => {
  expect(parseSettings(v12(language, false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY))).toEqual({
    state: 'loaded-with-fallbacks',
    settings: {language: expected, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY},
    fallbackFields: fields
  });
});

it.each([
  {name: 'invalid autostart string', autostart: 'yes', expected: false, fields: ['autostart']},
  {name: 'numeric autostart', autostart: 1, expected: false, fields: ['autostart']},
  {name: 'null autostart', autostart: null, expected: false, fields: ['autostart']},
  {name: 'missing autostart', autostart: undefined, expected: false, fields: ['autostart']}
])('falls back per autostart field for $name', ({autostart, expected, fields}) => {
  expect(parseSettings(v12('en', autostart, {ets2: 'metric', ats: 'us-customary'}, {...DEFAULT_OVERLAY, enabled: false}))).toEqual({
    state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: expected, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, enabled: false}},
    fallbackFields: fields
  });
});

it.each([
  {name: 'invalid and missing profiles', units: {ets2: 'imperial'}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a non-string profile', units: {ets2: 'metric', ats: 1}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ats']},
  {name: 'units not an object', units: ['metric'], expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a profile in the wrong case', units: {ets2: 'Metric', ats: 'metric'}, expected: {ets2: 'metric', ats: 'metric'}, fields: ['units.ets2']}
])('falls back per unit field for $name', ({units, expected, fields}) => {
  expect(parseSettings(v12('en', false, units, DEFAULT_OVERLAY))).toEqual({state: 'loaded-with-fallbacks', settings: {language: 'en', autostart: false, units: expected, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}, fallbackFields: fields});
});

it('lets an invalid v1 unit fall back alone after migration', () => {
  expect(parseSettings(v1({ets2: 'imperial', ats: 'metric'}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}, fallbackFields: ['units.ets2'], migratedFrom: 1});
});

it.each([
  {name: 'a missing overlay block', overlay: undefined, expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections', 'overlay.placements', 'overlay.enabled', 'overlay.backgroundOpacity']},
  {name: 'an overlay block that is not an object', overlay: 'strip', expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections', 'overlay.placements', 'overlay.enabled', 'overlay.backgroundOpacity']},
  {name: 'an unknown layout', overlay: {enabled: true, backgroundOpacity: 80, layout: 'bar', sections: DRIVING_ONLY, placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.layout']},
  {name: 'a layout in the wrong case', overlay: {enabled: true, backgroundOpacity: 80, layout: 'Card', sections: DRIVING_ONLY, placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.layout']},
  {name: 'missing sections', overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', placements: MOVED}, expected: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON, placements: MOVED}, fields: ['overlay.sections']},
  {name: 'sections as an array', overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: [true], placements: MOVED}, expected: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON, placements: MOVED},
    fields: ['overlay.sections']},
  {name: 'every section disabled', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: Object.fromEntries(Object.keys(ALL_ON).map(id => [id, false])), placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements: MOVED}, fields: ['overlay.sections']},
  {name: 'one non-boolean section', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, rpm: 'yes'}, placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.sections.rpm']},
  {name: 'a non-boolean section that was off', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, 'game-time': 0}, placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, 'game-time': true}, placements: MOVED}, fields: ['overlay.sections.game-time']},
  {name: 'one missing section key', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: without(DRIVING_ONLY, 'deadline'), placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, deadline: true}, placements: MOVED}, fields: ['overlay.sections.deadline']},
  // ET-052: the new key falls back to its default (on) alone.
  {name: 'a missing mandatory-break key in a v11 file', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: without(DRIVING_ONLY, 'mandatory-break'), placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, 'mandatory-break': true}, placements: MOVED}, fields: ['overlay.sections.mandatory-break']},
  {name: 'a non-boolean mandatory-break value', overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, 'mandatory-break': 'on'}, placements: MOVED},
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, 'mandatory-break': true}, placements: MOVED}, fields: ['overlay.sections.mandatory-break']}
])('falls back per overlay field for $name', ({overlay, expected, fields}) => {
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, overlay))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: expected}, fallbackFields: fields});
});

// ET-012b (REG-017): out-of-range values fall back to the layout's default; they are never clamped.
it.each([
  {name: 'missing placements', placements: undefined, expected: PLACEMENTS, fields: ['overlay.placements']},
  {name: 'placements as an array', placements: [MOVED.card], expected: PLACEMENTS, fields: ['overlay.placements']},
  {name: 'placements as a string', placements: 'card', expected: PLACEMENTS, fields: ['overlay.placements']},
  {name: 'a missing layout placement', placements: without(MOVED, 'hud'), expected: MOVED, fields: ['overlay.placements.hud']},
  {name: 'an x above one', placements: {...MOVED, card: {x: 1.01, y: 0.75, scale: 1.5}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a negative y', placements: {...MOVED, card: {x: 0.25, y: -0.01, scale: 1.5}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a scale below 0.5', placements: {...MOVED, card: {x: 0.25, y: 0.75, scale: 0.49}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a scale above 3', placements: {...MOVED, card: {x: 0.25, y: 0.75, scale: 3.01}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a string scale', placements: {...MOVED, card: {x: 0.25, y: 0.75, scale: '1.5'}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a missing x', placements: {...MOVED, card: {y: 0.75, scale: 1.5}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'invalid strip and cluster placements', placements: {...MOVED, strip: null, cluster: {x: 0, y: 1, scale: 0}},
    expected: MOVED, fields: ['overlay.placements.strip', 'overlay.placements.cluster']}
])('falls back per placement for $name', ({placements, expected, fields}) => {
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements: expected}}, fallbackFields: fields});
});

it('normalises placements read from the file and accepts the range bounds', () => {
  const placements = {strip: {x: 0, y: 1, scale: 0.5}, card: {x: 1, y: 0, scale: 3}, cluster: {x: 0.123456, y: 0.99999, scale: 1.234}, hud: {x: 0, y: 0, scale: 2.5}};
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON, placements}))).toEqual({state: 'loaded',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON,
      placements: {...placements, cluster: {x: 0.1235, y: 1, scale: 1.23}}}}});
});

it.each([
  ['truncated JSON', utf8('{"format":"ets2telemetry.settings","version":5,"units":{"ets2":"metric",')],
  ['an empty file', utf8('')],
  ['a JSON array', utf8('[]')],
  ['JSON null', utf8('null')],
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ['another format marker', utf8('{"format":"ets2telemetry.other","version":5,"units":{}}')],
  ['no format marker', utf8('{"version":5,"language":"en","units":{"ets2":"metric","ats":"metric"}}')],
  ['a string version', utf8('{"format":"ets2telemetry.settings","version":"5","units":{}}')],
  ['a fractional version', utf8('{"format":"ets2telemetry.settings","version":2.5,"units":{}}')],
  ['a UTF-16 byte order mark', new Uint8Array([0xff, 0xfe, ...utf8('{}')])]
])('rejects %s as an invalid file', (_name, bytes) => {
  expect(parseSettings(bytes)).toEqual({state: 'invalid-file'});
});

it('rejects a file above 64 KiB and accepts one of exactly 64 KiB', () => {
  const base = new TextDecoder().decode(v12('en', false, {ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}));
  const exact = utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length));
  expect(exact.byteLength).toBe(65536);
  expect(parseSettings(exact)).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}}});
  expect(parseSettings(utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length + 1)))).toEqual({state: 'invalid-file'});
});

// ET-049 made version 7 current; ET-045e made version 8 current; ET-050 made version 9 current; ET-050b made version 10 current;
// ET-052 made version 11 current; ET-050b per-gearbox modes make version 12 current, so version 13 is newer-version, and a
// build from before them reads version 12 as newer-version (read-only defaults) while versions 9 to 11 migrate.
it('classifies missing and older versions as unsupported-older and later ones as newer-version', () => {
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":0,"units":{}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":-3}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":13,"units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'newer-version'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":13,"gearboxGearDisplay":{"ets2":[],"ats":[]}}'))).toEqual({state: 'newer-version'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":12,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":11,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks', migratedFrom: 11});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":10,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks', migratedFrom: 10});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":9,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks', migratedFrom: 9});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":8,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":4,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks'});
});

it('serializes the exact v12 bytes: language, units, gear display, per-gearbox lists, sections and placements in canonical order, two-space indentation and a trailing newline', () => {
  expect(serializeSettings({language: 'ru', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: {ets2: 'manual', ats: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...ALL_ON, rpm: false}, placements: MOVED}})).toBe([
    '{', '  "format": "ets2telemetry.settings",', '  "version": 12,', '  "language": "ru",', '  "autostart": false,', '  "units": {', '    "ets2": "us-customary",', '    "ats": "metric"', '  },',
    '  "gearDisplay": {', '    "ets2": "manual",', '    "ats": "automatic"', '  },',
    '  "gearboxGearDisplay": {', '    "ets2": [],', '    "ats": []', '  },',
    '  "overlay": {', '    "enabled": true,', '    "backgroundOpacity": 80,', '    "layout": "card",', '    "sections": {', '      "speed": true,', '      "gear": true,', '      "rpm": false,', '      "fuel": true,',
    '      "range": true,', '      "sdk-consumption": true,', '      "cargo": true,', '      "origin": true,', '      "destination": true,',
    '      "distance-driven": true,', '      "distance-remaining": true,', '      "deadline": true,', '      "expected-income": true,', '      "game-time": true,', '      "mandatory-break": true',
    '    },', '    "placements": {',
    '      "strip": {', '        "x": 0.5,', '        "y": 0,', '        "scale": 1', '      },',
    '      "card": {', '        "x": 0.25,', '        "y": 0.75,', '        "scale": 1.5', '      },',
    '      "cluster": {', '        "x": 0,', '        "y": 1,', '        "scale": 1', '      },',
    '      "hud": {', '        "x": 0,', '        "y": 0,', '        "scale": 1', '      }',
    '    }', '  }', '}', ''].join('\n'));
  // The canonical order holds whatever order the in-memory records have, and values are normalised on the way out.
  const reversed = Object.fromEntries(Object.entries(DRIVING_ONLY).reverse()) as typeof DRIVING_ONLY;
  const placements = {hud: {scale: 1, y: 0, x: 0}, cluster: {x: 0.123456, y: 1, scale: 1.256}, card: PLACEMENTS.card, strip: PLACEMENTS.strip};
  const text = serializeSettings({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: {ats: 'manual', ets2: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: reversed, placements}});
  const written = JSON.parse(text) as {language: string; autostart: boolean; gearDisplay: object; overlay: {sections: object; placements: Record<string, object>}};
  expect(Object.keys(written)).toEqual(['format', 'version', 'language', 'autostart', 'units', 'gearDisplay', 'gearboxGearDisplay', 'overlay']);
  expect(Object.keys(written.gearDisplay)).toEqual(['ets2', 'ats']);
  expect(written.language).toBe('en');
  expect(written.autostart).toBe(false);
  expect(Object.keys(written.overlay.sections)).toEqual(Object.keys(ALL_ON));
  expect(Object.keys(written.overlay.placements)).toEqual(['strip', 'card', 'cluster', 'hud']);
  expect(Object.keys(written.overlay.placements.hud)).toEqual(['x', 'y', 'scale']);
  // Round trip through the parser.
  expect(parseSettings(utf8(text))).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: {ets2: 'automatic', ats: 'manual'}, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: {...PLACEMENTS, cluster: {x: 0.1235, y: 1, scale: 1.26}}}}});
});

it('migrates accepted v5 autostart true purely while preserving all prior settings', () => {
  const old = {format: 'ets2telemetry.settings', version: 5, language: 'ru', autostart: true,
    units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'card', sections: OLD_DRIVING_ONLY, placements: MOVED}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 5)).toEqual({...old, version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80, sections: MIGRATED_DRIVING_ONLY}});
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 5,
    settings: {language: 'ru', autostart: true, units: old.units, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80, sections: MIGRATED_DRIVING_ONLY}}});
  expect(old).toEqual(before);
});

// ET-049: authentic v6 migration ignores a stray future opacity and never mutates input.
it('migrates v6 to the unchanged 80% appearance while retaining every existing preference', () => {
  const old = {format: 'ets2telemetry.settings', version: 6, language: 'ru', autostart: true,
    units: {ets2: 'us-customary', ats: 'metric'}, overlay: {...OLD_OVERLAY, enabled: false, layout: 'card', placements: MOVED, backgroundOpacity: 42}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 6)).toEqual({...old, version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, backgroundOpacity: 80, sections: ALL_ON}});
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 6,
    settings: {language: 'ru', autostart: true, units: old.units, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, backgroundOpacity: 80, sections: ALL_ON}}});
});
it.each([undefined, null, '60', false, 39, 101, 80.5, {}, []])('falls back only opacity for invalid stored value %j', backgroundOpacity => {
  expect(parseSettings(v12('ru', true, {ets2: 'metric', ats: 'us-customary'}, {...DEFAULT_OVERLAY, backgroundOpacity})))
    .toEqual({state: 'loaded-with-fallbacks', fallbackFields: ['overlay.backgroundOpacity'],
      settings: {language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});
it.each([40, 65, 80, 100])('roundtrips opacity %i without changing other fields', backgroundOpacity => {
  const settings = {language: 'ru' as const, autostart: true, units: {ets2: 'metric' as const, ats: 'us-customary' as const}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {...DEFAULT_OVERLAY, layout: 'card' as const, enabled: false, backgroundOpacity, placements: MOVED}};
  expect(parseSettings(utf8(serializeSettings(settings)))).toEqual({state: 'loaded', settings});
});

// ET-045e (decision Z5, owner decision D1 option b, REG-017; ET-049 took v7 first): v7 -> v8 keeps every saved scale
// number; it now means a setting whose zoom is setting × 0.7. The owner's saved strip {0.8485, 1, 0.5} stays 0.5.
const OWNER_PLACEMENTS = {strip: {x: 0.8485, y: 1, scale: 0.5}, card: {x: 1, y: 0, scale: 2}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1.5}};
it('migrates a v7 file through v8 to v11 and on to v12 with identical placement numbers and migratedFrom 7', () => {
  const overlay = {enabled: true, backgroundOpacity: 65, layout: 'strip', sections: OLD_DRIVING_ONLY, placements: OWNER_PLACEMENTS};
  const old = {format: 'ets2telemetry.settings', version: 7, language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, overlay};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 7)).toEqual({...old, version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}});
  expect(old).toEqual(before);
  expect(parseSettings(v7('ru', true, {ets2: 'metric', ats: 'us-customary'}, overlay))).toEqual({state: 'loaded', migratedFrom: 7,
    settings: {language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}}});
});
it('accepts a hand-edited v7 scale in (2, 3] after the migration and still refuses one above 3', () => {
  expect(parseSettings(v7('en', false, {ets2: 'metric', ats: 'metric'}, {...OLD_OVERLAY, placements: {...PLACEMENTS, card: {x: 0, y: 0, scale: 2.5}}})))
    .toMatchObject({state: 'loaded', migratedFrom: 7, settings: {overlay: {placements: {...PLACEMENTS, card: {x: 0, y: 0, scale: 2.5}}}}});
  expect(parseSettings(v7('en', false, {ets2: 'metric', ats: 'metric'}, {...OLD_OVERLAY, placements: {...PLACEMENTS, card: {x: 0, y: 0, scale: 3.01}}})))
    .toEqual({state: 'loaded-with-fallbacks', migratedFrom: 7, fallbackFields: ['overlay.placements.card'],
      settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});
it('reads current v12 placements at 2.5 and 3 unchanged and lets 3.01 fall back alone', () => {
  const placements = {...PLACEMENTS, strip: {x: 0.8485, y: 1, scale: 3}, hud: {x: 0, y: 0, scale: 2.5}};
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, {...DEFAULT_OVERLAY, placements}))).toEqual({state: 'loaded',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, placements}}});
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, {...DEFAULT_OVERLAY, placements: {...placements, strip: {x: 0.8485, y: 1, scale: 3.01}}})))
    .toEqual({state: 'loaded-with-fallbacks', fallbackFields: ['overlay.placements.strip'],
      settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, placements: {...placements, strip: PLACEMENTS.strip}}}});
});

// ET-050 (REG-017): v8 -> v9 adds automatic gear display for both games and replaces a stray pre-v9 block.
it('migrates a v8 file purely through v9 to v11 and on to v12 with automatic gears, replacing a stray gearDisplay key, migratedFrom 8', () => {
  const overlay = {enabled: false, backgroundOpacity: 65, layout: 'card', sections: OLD_DRIVING_ONLY, placements: OWNER_PLACEMENTS};
  const old = {format: 'ets2telemetry.settings', version: 8, language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'}, overlay,
    gearDisplay: {ets2: 'manual', ats: 'manual'}};
  const before = structuredClone(old);
  const migrated = migrateToCurrent(old, 8);
  expect(migrated).toEqual({...old, version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}});
  expect(migrated!.gearDisplay).not.toBe(old.gearDisplay);
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 8,
    settings: {language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}}});
  expect(parseSettings(v8('en', false, {ets2: 'metric', ats: 'us-customary'}, OLD_OVERLAY))).toEqual({state: 'loaded', migratedFrom: 8,
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});
it('reads per-game v12 gear display modes and round trips them', () => {
  const gearDisplay = {ets2: 'manual', ats: 'automatic'} as const;
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY, {gearDisplay: {...gearDisplay, future: 'x'}}))).toEqual({state: 'loaded',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
  for (const modes of [{ets2: 'manual', ats: 'manual'}, {ets2: 'automatic', ats: 'manual'}, AUTO, {ets2: 'crawler', ats: 'automatic'}, {ets2: 'crawler', ats: 'crawler'}] as const) {
    const settings = {language: 'ru' as const, autostart: true, units: {ets2: 'metric' as const, ats: 'metric' as const}, gearDisplay: modes, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, layout: 'cluster' as const}};
    expect(parseSettings(utf8(serializeSettings(settings)))).toEqual({state: 'loaded', settings});
  }
});
it.each([
  {name: 'a missing block', gearDisplay: undefined, expected: AUTO, fields: ['gearDisplay.ets2', 'gearDisplay.ats']},
  {name: 'a block that is not an object', gearDisplay: 'manual', expected: AUTO, fields: ['gearDisplay.ets2', 'gearDisplay.ats']},
  {name: 'a block as an array', gearDisplay: ['manual', 'manual'], expected: AUTO, fields: ['gearDisplay.ets2', 'gearDisplay.ats']},
  {name: 'null', gearDisplay: null, expected: AUTO, fields: ['gearDisplay.ets2', 'gearDisplay.ats']},
  {name: 'an unknown mode', gearDisplay: {ets2: 'semi', ats: 'manual'}, expected: {ets2: 'automatic', ats: 'manual'}, fields: ['gearDisplay.ets2']},
  {name: 'a mode in the wrong case', gearDisplay: {ets2: 'manual', ats: 'Manual'}, expected: {ets2: 'manual', ats: 'automatic'}, fields: ['gearDisplay.ats']},
  {name: 'a crawler mode in the wrong case', gearDisplay: {ets2: 'Crawler', ats: 'crawler'}, expected: {ets2: 'automatic', ats: 'crawler'}, fields: ['gearDisplay.ets2']},
  {name: 'a non-string mode', gearDisplay: {ets2: true, ats: 1}, expected: AUTO, fields: ['gearDisplay.ets2', 'gearDisplay.ats']},
  {name: 'a missing game', gearDisplay: {ats: 'manual'}, expected: {ets2: 'automatic', ats: 'manual'}, fields: ['gearDisplay.ets2']}
])('falls back per gear display field for $name without coercion', ({gearDisplay, expected, fields}) => {
  const bytes = utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 12, language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}));
  expect(parseSettings(bytes)).toEqual({state: 'loaded-with-fallbacks', fallbackFields: fields,
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: expected, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});

// ET-050b (owner option B, REG-017): v9 -> v10 changes only the version; every v9 gear mode is kept. ET-052: the chain goes on to
// v11, which adds the break section on a copy of the saved sections.
it('migrates a v9 file purely through v10 and v11 to v12 keeping its gear display modes, migratedFrom 9', () => {
  const overlay = {enabled: true, backgroundOpacity: 40, layout: 'hud', sections: OLD_DRIVING_ONLY, placements: OWNER_PLACEMENTS};
  const old = {format: 'ets2telemetry.settings', version: 9, language: 'ru', autostart: false, units: {ets2: 'metric', ats: 'us-customary'},
    gearDisplay: {ets2: 'manual', ats: 'automatic'}, overlay};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 9)).toEqual({...old, version: 12, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}});
  expect(old).toEqual(before);
  const migratedOverlay = {...overlay, sections: MIGRATED_DRIVING_ONLY};
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 9,
    settings: {language: 'ru', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'manual', ats: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES, overlay: migratedOverlay}});
  // No ET-050 build writes the crawler mode into a v9 file; a hand-edited one is a valid mode once migrated.
  expect(parseSettings(utf8(JSON.stringify({...old, gearDisplay: {ets2: 'crawler', ats: 'manual'}})))).toMatchObject({state: 'loaded', migratedFrom: 9,
    settings: {gearDisplay: {ets2: 'crawler', ats: 'manual'}}});
});

// ET-052 (MB11, owner decision D2, REG-017): v10 -> v11 adds the overlay section `mandatory-break`, on, on a copy of the saved
// section record, so the section is on for upgraders and every other saved choice (the crawler gear mode included) survives.
it('migrates a v10 file purely through v11 to v12: the break is on, every other choice is kept, the input is untouched, migratedFrom 10', () => {
  const overlay = {enabled: false, backgroundOpacity: 65, layout: 'card', sections: OLD_DRIVING_ONLY, placements: OWNER_PLACEMENTS};
  const old = {format: 'ets2telemetry.settings', version: 10, language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'},
    gearDisplay: {ets2: 'crawler', ats: 'automatic'}, overlay};
  const before = structuredClone(old);
  const migrated = migrateToCurrent(old, 10)!;
  expect(migrated).toEqual({...old, version: 12, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}});
  expect((migrated.overlay as {sections: unknown}).sections).not.toBe(old.overlay.sections);
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 10,
    settings: {language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: {ets2: 'crawler', ats: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES, overlay: {...overlay, sections: MIGRATED_DRIVING_ONLY}}});
  expect(parseSettings(v10('en', false, {ets2: 'metric', ats: 'us-customary'}, OLD_OVERLAY))).toEqual({state: 'loaded', migratedFrom: 10,
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY}});
});
it('migrates a v10 file that holds only one section on, keeping that choice and adding the break', () => {
  const only = Object.fromEntries(Object.keys(OLD_ALL_ON).map(id => [id, id === 'cargo']));
  const settings = parseSettings(v10('en', false, {ets2: 'metric', ats: 'metric'}, {...OLD_OVERLAY, sections: only}));
  expect(settings).toMatchObject({state: 'loaded', migratedFrom: 10, settings: {overlay: {sections: {...only, 'mandatory-break': true}}}});
});
it('replaces a stray mandatory-break key of a v10 file, which a v10 build ignored, with true', () => {
  expect(migrateToCurrent({format: 'ets2telemetry.settings', version: 10, overlay: {sections: {...OLD_ALL_ON, 'mandatory-break': false}}}, 10))
    .toEqual({format: 'ets2telemetry.settings', version: 12, gearboxGearDisplay: NO_GEARBOXES, overlay: {sections: ALL_ON}});
});
it.each([
  ['a missing overlay block', undefined], ['an overlay block that is not an object', 'strip'], ['an overlay block as an array', [OLD_ALL_ON]],
  ['missing sections', {layout: 'card'}], ['sections as an array', {layout: 'card', sections: [true]}], ['sections as a string', {layout: 'card', sections: 'all'}], ['null sections', {layout: 'card', sections: null}]
])('leaves %s of a v10 file to the existing fallbacks and adds nothing', (_name, overlay) => {
  const old = {format: 'ets2telemetry.settings', version: 10, language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, overlay};
  const migrated = migrateToCurrent(old, 10)!;
  expect(migrated.version).toBe(12);
  expect(migrated.overlay).toEqual(overlay);
  expect(parseSettings(utf8(JSON.stringify(old)))).toMatchObject({state: 'loaded-with-fallbacks', migratedFrom: 10});
});
it('keeps a stored mandatory-break false of a v11 file and writes it last', () => {
  const settings = {language: 'en' as const, autostart: false, units: {ets2: 'metric' as const, ats: 'metric' as const}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {...DEFAULT_OVERLAY, layout: 'strip' as const, sections: {...ALL_ON, 'mandatory-break': false}}};
  const text = serializeSettings(settings);
  expect(text).toContain('"game-time": true,\n      "mandatory-break": false\n    },');
  expect(parseSettings(utf8(text))).toEqual({state: 'loaded', settings});
  // The first save of a migrated v10 file writes v11 with the break on.
  const migrated = parseSettings(v10('en', false, {ets2: 'metric', ats: 'metric'}, {...OLD_OVERLAY, sections: OLD_DRIVING_ONLY}));
  expect(migrated.state).toBe('loaded');
  const rewritten = serializeSettings((migrated as {settings: Parameters<typeof serializeSettings>[0]}).settings);
  expect(JSON.parse(rewritten)).toMatchObject({version: 12, gearboxGearDisplay: NO_GEARBOXES, overlay: {sections: MIGRATED_DRIVING_ONLY}});
  expect(rewritten).toContain('"game-time": false,\n      "mandatory-break": true\n    },');
});

// ET-050b per-gearbox modes (owner decision of October 27, 2026, REG-017): v11 -> v12 adds empty per-gearbox lists for both
// games and replaces a stray key; every v11 choice is kept. The gearboxes are the owner's captured Scania R gearboxes.
const GA867R = {model: 'vehicle.scania.r_2016', forwardGears: 6, reverseGears: 1, label: 'Scania R', mode: 'automatic'} as const;
const G38CMR = {model: 'vehicle.scania.r_2016', forwardGears: 14, reverseGears: 8, label: 'Scania R', mode: 'crawler'} as const;
const GRSO925R = {model: 'vehicle.scania.r_2016', forwardGears: 14, reverseGears: 2, label: 'Scania R', mode: 'manual'} as const;
const MACK = {model: 'vehicle.mack.anthem', forwardGears: 18, reverseGears: 4, label: 'Mack Anthem', mode: 'manual'} as const;
it('migrates a v11 file purely to v12 with empty gearbox lists, replacing a stray key and keeping every v11 choice, migratedFrom 11', () => {
  const overlay = {enabled: false, backgroundOpacity: 65, layout: 'card', sections: DRIVING_ONLY, placements: OWNER_PLACEMENTS};
  const old = {format: 'ets2telemetry.settings', version: 11, language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'},
    gearDisplay: {ets2: 'crawler', ats: 'manual'}, overlay, gearboxGearDisplay: {ets2: [GA867R], ats: []}};
  const before = structuredClone(old);
  const migrated = migrateToCurrent(old, 11)!;
  expect(migrated).toEqual({...old, version: 12, gearboxGearDisplay: NO_GEARBOXES});
  expect(migrated.gearboxGearDisplay).not.toBe(old.gearboxGearDisplay);
  expect(old).toEqual(before);
  expect(parseSettings(v11('ru', true, {ets2: 'us-customary', ats: 'metric'}, overlay, {gearDisplay: {ets2: 'crawler', ats: 'manual'}}))).toEqual({state: 'loaded', migratedFrom: 11,
    settings: {language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: {ets2: 'crawler', ats: 'manual'}, gearboxGearDisplay: NO_GEARBOXES, overlay}});
});
it('reads v12 gearbox lists in canonical order and round trips them, ignoring unknown block keys', () => {
  const gearboxGearDisplay = {ets2: [G38CMR, GA867R, GRSO925R], ats: [MACK]};
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY, {gearboxGearDisplay: {...gearboxGearDisplay, future: [GA867R]}}))).toEqual({state: 'loaded',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO,
      gearboxGearDisplay: {ets2: [GA867R, GRSO925R, G38CMR], ats: [MACK]}, overlay: DEFAULT_OVERLAY}});
  const settings = {language: 'ru' as const, autostart: false, units: {ets2: 'metric' as const, ats: 'metric' as const}, gearDisplay: {ets2: 'crawler', ats: 'manual'} as const,
    gearboxGearDisplay: {ets2: [GA867R, GRSO925R, G38CMR], ats: [MACK]}, overlay: DEFAULT_OVERLAY as Parameters<typeof serializeSettings>[0]['overlay']};
  expect(parseSettings(utf8(serializeSettings(settings)))).toEqual({state: 'loaded', settings});
});
it('serializes gearbox entries in canonical order with their five keys in order', () => {
  const text = serializeSettings({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO,
    gearboxGearDisplay: {ets2: [GRSO925R, GA867R], ats: []}, overlay: DEFAULT_OVERLAY as Parameters<typeof serializeSettings>[0]['overlay']});
  expect(text).toContain([
    '  "gearboxGearDisplay": {', '    "ets2": [', '      {', '        "model": "vehicle.scania.r_2016",', '        "forwardGears": 6,', '        "reverseGears": 1,',
    '        "label": "Scania R",', '        "mode": "automatic"', '      },', '      {', '        "model": "vehicle.scania.r_2016",', '        "forwardGears": 14,',
    '        "reverseGears": 2,', '        "label": "Scania R",', '        "mode": "manual"', '      }', '    ],', '    "ats": []', '  },', '  "overlay": {'].join('\n'));
});
const LONG_MODEL = 'x'.repeat(128), TOO_LONG_MODEL = 'x'.repeat(129), MULTIBYTE_MODEL = 'ы'.repeat(65);
it.each([
  {name: 'a missing block', block: undefined, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2', 'gearboxGearDisplay.ats']},
  {name: 'a block as an array', block: [GA867R], expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2', 'gearboxGearDisplay.ats']},
  {name: 'a list that is not an array', block: {ets2: GA867R, ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a missing game', block: {ets2: [GA867R]}, expected: {ets2: [GA867R], ats: []}, fields: ['gearboxGearDisplay.ats']},
  {name: 'an unknown mode', block: {ets2: [{...GA867R, mode: 'semi'}, G38CMR], ats: []}, expected: {ets2: [G38CMR], ats: []}, fields: ['gearboxGearDisplay.ets2']},
  {name: 'an extra key', block: {ets2: [{...GA867R, ratios: [4.7]}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a missing label', block: {ets2: [without(GA867R, 'label')], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'an empty model', block: {ets2: [{...GA867R, model: ''}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a model above 128 UTF-8 bytes', block: {ets2: [{...GA867R, model: TOO_LONG_MODEL}, {...GA867R, model: MULTIBYTE_MODEL}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a label above 128 characters', block: {ets2: [{...GA867R, label: 'L'.repeat(129)}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a control character', block: {ets2: [{...GA867R, label: 'Scania\nR'}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'no forward gear', block: {ets2: [{...GA867R, forwardGears: 0}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a negative reverse count', block: {ets2: [{...GA867R, reverseGears: -1}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'more than 100 gears', block: {ets2: [{...GA867R, forwardGears: 101}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a fractional count', block: {ets2: [{...GA867R, forwardGears: 6.5}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a string count', block: {ets2: [{...GA867R, reverseGears: '1'}], ats: []}, expected: NO_GEARBOXES, fields: ['gearboxGearDisplay.ets2']},
  {name: 'a repeated gearbox, keeping the first', block: {ets2: [GA867R, {...GA867R, mode: 'manual', label: 'Other'}], ats: []}, expected: {ets2: [GA867R], ats: []}, fields: ['gearboxGearDisplay.ets2']}
])('falls back per gearbox list for $name without coercion', ({block, expected, fields}) => {
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, DEFAULT_OVERLAY, {gearboxGearDisplay: block}))).toEqual({state: 'loaded-with-fallbacks', fallbackFields: fields,
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: expected, overlay: DEFAULT_OVERLAY}});
});
it('accepts the bounds of a gearbox entry', () => {
  const bounds = [{...GA867R, model: LONG_MODEL, label: 'L'.repeat(128), forwardGears: 100, reverseGears: 0}, {...GA867R, model: 'ы'.repeat(64), forwardGears: 1, reverseGears: 100}];
  expect(parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, DEFAULT_OVERLAY, {gearboxGearDisplay: {ets2: bounds, ats: []}}))).toMatchObject({state: 'loaded',
    settings: {gearboxGearDisplay: {ets2: bounds, ats: []}}});
});
it('keeps the first sixteen gearboxes of a game and drops the rest alone', () => {
  const entries = Array.from({length: 17}, (_, index) => ({...GA867R, forwardGears: index + 1}));
  const parsed = parseSettings(v12('en', false, {ets2: 'metric', ats: 'metric'}, DEFAULT_OVERLAY, {gearboxGearDisplay: {ets2: [...entries].reverse(), ats: [MACK]}}));
  expect(parsed).toMatchObject({state: 'loaded-with-fallbacks', fallbackFields: ['gearboxGearDisplay.ets2'], settings: {gearboxGearDisplay: {ats: [MACK]}}});
  // The file's first sixteen are kept (gears 17 down to 2), then put in canonical order.
  expect((parsed as unknown as {settings: {gearboxGearDisplay: {ets2: unknown[]}}}).settings.gearboxGearDisplay.ets2).toEqual(entries.slice(1));
});
it('writes a full set of thirty-two maximal gearboxes within the 64 KiB file cap', () => {
  const entry = (index: number) => ({model: `${'ы'.repeat(60)}${String(index).padStart(2, '0')}`, forwardGears: 100, reverseGears: 100, label: '"'.repeat(128), mode: 'crawler' as const});
  const text = serializeSettings({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO,
    gearboxGearDisplay: {ets2: Array.from({length: 16}, (_, index) => entry(index)), ats: Array.from({length: 16}, (_, index) => entry(16 + index))},
    overlay: DEFAULT_OVERLAY as Parameters<typeof serializeSettings>[0]['overlay']});
  expect(utf8(text).byteLength).toBeLessThan(MAX_SETTINGS_BYTES);
  expect(parseSettings(utf8(text))).toMatchObject({state: 'loaded'});
});
