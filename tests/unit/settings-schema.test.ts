import {expect, it} from 'vitest';
import {MAX_SETTINGS_BYTES, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';

const utf8 = (text: string) => new TextEncoder().encode(text);
const v1 = (units: unknown, extra: Record<string, unknown> = {}) => utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 1, units, ...extra}));
const v2 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 2, units, overlay, ...extra}));
const v3 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 3, units, overlay, ...extra}));
// Changed by ET-029: version 4 is the current format; it adds the interface language.
const v4 = (language: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 4, language, units, overlay, ...extra}));

// Hand-written expectations: the fourteen section ids in canonical order, all enabled by default.
const ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
// The ET-012a anchors at scale 1, in canonical layout order.
const PLACEMENTS = {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}};
const MOVED = {...PLACEMENTS, card: {x: 0.25, y: 0.75, scale: 1.5}};
const DEFAULT_OVERLAY = {layout: 'strip', sections: ALL_ON, placements: PLACEMENTS};
const DRIVING_ONLY = {...ALL_ON, 'sdk-consumption': false, 'cargo': false, 'origin': false, 'destination': false, 'distance-driven': false,
  'distance-remaining': false, 'deadline': false, 'expected-income': false, 'game-time': false};
const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('reads a valid v4 file, ignoring unknown keys', () => {
  expect(parseSettings(v4('ru', {ets2: 'us-customary', ats: 'metric', future: 'x'},
    {layout: 'cluster', sections: {...DRIVING_ONLY, future: true}, placements: {...MOVED, future: {x: 0, y: 0, scale: 1}}, theme: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'ru', units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED}}});
});

it('migrates a v3 file to v4 in memory: default language en, units and overlay kept, migratedFrom 3', () => {
  expect(parseSettings(v3({ets2: 'us-customary', ats: 'metric'}, {layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED})))
    .toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED}},
      migratedFrom: 3});
});

it('migrates a v2 file through v3 to v4 in memory: default language en, layout and sections kept, default placements, migratedFrom 2', () => {
  expect(parseSettings(v2({ets2: 'us-customary', ats: 'metric'}, {layout: 'cluster', sections: DRIVING_ONLY})))
    .toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'cluster', sections: DRIVING_ONLY, placements: PLACEMENTS}},
      migratedFrom: 2});
  // A v2 file never had placements: a stray key is replaced by the defaults.
  expect(parseSettings(v2({ets2: 'metric', ats: 'metric'}, {layout: 'hud', sections: ALL_ON, placements: MOVED})))
    .toMatchObject({state: 'loaded', settings: {language: 'en', overlay: {layout: 'hud', placements: PLACEMENTS}}, migratedFrom: 2});
});

it('migrates a v1 file through v2 and v3 to v4 in memory: default language en, units kept, overlay defaults, migratedFrom 1', () => {
  expect(parseSettings(v1({ets2: 'us-customary', ats: 'metric', future: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'us-customary', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, migratedFrom: 1});
});

it('migrates v1, v2 and v3 purely without mutating their input, and leaves current documents unchanged', () => {
  const document = {format: 'ets2telemetry.settings', version: 1, units: {ets2: 'metric', ats: 'metric'}};
  const snapshot = structuredClone(document);
  const migrated = migrateToCurrent(document, 1);
  expect(migrated).toEqual({format: 'ets2telemetry.settings', version: 4, language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY});
  expect(document).toEqual(snapshot);
  expect(migrated).not.toBe(document);

  const second = {format: 'ets2telemetry.settings', version: 2, units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'card', sections: DRIVING_ONLY}};
  const secondSnapshot = structuredClone(second);
  const upgraded = migrateToCurrent(second, 2);
  expect(upgraded).toEqual({...second, version: 4, language: 'en', overlay: {layout: 'card', sections: DRIVING_ONLY, placements: PLACEMENTS}});
  expect(second).toEqual(secondSnapshot); expect(upgraded!.overlay).not.toBe(second.overlay);

  const third = {format: 'ets2telemetry.settings', version: 3, units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'card', sections: DRIVING_ONLY, placements: PLACEMENTS}};
  const thirdSnapshot = structuredClone(third);
  const upgradedThird = migrateToCurrent(third, 3);
  expect(upgradedThird).toEqual({...third, version: 4, language: 'en'});
  expect(third).toEqual(thirdSnapshot);

  // A v2 overlay that is not an object stays as it is.
  expect(migrateToCurrent({format: 'ets2telemetry.settings', version: 2, overlay: 'strip'}, 2)).toEqual({format: 'ets2telemetry.settings', version: 4, language: 'en', overlay: 'strip'});
  const current = {format: 'ets2telemetry.settings', version: 4};
  expect(migrateToCurrent(current, 4)).toBe(current);
  expect(migrateToCurrent({format: 'ets2telemetry.settings'}, 0)).toBeUndefined();
});

it('accepts a leading UTF-8 byte order mark', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...v4('en', {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY)]);
  expect(parseSettings(bytes)).toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY}});
});

it.each([
  {name: 'invalid language', language: 'fr', expected: 'en', fields: ['language']},
  {name: 'numeric language', language: 123, expected: 'en', fields: ['language']},
  {name: 'uppercase language', language: 'EN', expected: 'en', fields: ['language']},
  {name: 'missing language', language: undefined, expected: 'en', fields: ['language']}
])('falls back per language field for $name', ({language, expected, fields}) => {
  expect(parseSettings(v4(language, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY))).toEqual({
    state: 'loaded-with-fallbacks',
    settings: {language: expected, units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY},
    fallbackFields: fields
  });
});

it.each([
  {name: 'invalid and missing profiles', units: {ets2: 'imperial'}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a non-string profile', units: {ets2: 'metric', ats: 1}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ats']},
  {name: 'units not an object', units: ['metric'], expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a profile in the wrong case', units: {ets2: 'Metric', ats: 'metric'}, expected: {ets2: 'metric', ats: 'metric'}, fields: ['units.ets2']}
])('falls back per unit field for $name', ({units, expected, fields}) => {
  expect(parseSettings(v4('en', units, DEFAULT_OVERLAY))).toEqual({state: 'loaded-with-fallbacks', settings: {language: 'en', units: expected, overlay: DEFAULT_OVERLAY}, fallbackFields: fields});
});

it('lets an invalid v1 unit fall back alone after migration', () => {
  expect(parseSettings(v1({ets2: 'imperial', ats: 'metric'}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, fallbackFields: ['units.ets2'], migratedFrom: 1});
});

it.each([
  {name: 'a missing overlay block', overlay: undefined, expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections', 'overlay.placements']},
  {name: 'an overlay block that is not an object', overlay: 'strip', expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections', 'overlay.placements']},
  {name: 'an unknown layout', overlay: {layout: 'bar', sections: DRIVING_ONLY, placements: MOVED},
    expected: {layout: 'strip', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.layout']},
  {name: 'a layout in the wrong case', overlay: {layout: 'Card', sections: DRIVING_ONLY, placements: MOVED},
    expected: {layout: 'strip', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.layout']},
  {name: 'missing sections', overlay: {layout: 'hud', placements: MOVED}, expected: {layout: 'hud', sections: ALL_ON, placements: MOVED}, fields: ['overlay.sections']},
  {name: 'sections as an array', overlay: {layout: 'hud', sections: [true], placements: MOVED}, expected: {layout: 'hud', sections: ALL_ON, placements: MOVED},
    fields: ['overlay.sections']},
  {name: 'every section disabled', overlay: {layout: 'card', sections: Object.fromEntries(Object.keys(ALL_ON).map(id => [id, false])), placements: MOVED},
    expected: {layout: 'card', sections: ALL_ON, placements: MOVED}, fields: ['overlay.sections']},
  {name: 'one non-boolean section', overlay: {layout: 'card', sections: {...DRIVING_ONLY, rpm: 'yes'}, placements: MOVED},
    expected: {layout: 'card', sections: DRIVING_ONLY, placements: MOVED}, fields: ['overlay.sections.rpm']},
  {name: 'a non-boolean section that was off', overlay: {layout: 'card', sections: {...DRIVING_ONLY, 'game-time': 0}, placements: MOVED},
    expected: {layout: 'card', sections: {...DRIVING_ONLY, 'game-time': true}, placements: MOVED}, fields: ['overlay.sections.game-time']},
  {name: 'one missing section key', overlay: {layout: 'card', sections: without(DRIVING_ONLY, 'deadline'), placements: MOVED},
    expected: {layout: 'card', sections: {...DRIVING_ONLY, deadline: true}, placements: MOVED}, fields: ['overlay.sections.deadline']}
])('falls back per overlay field for $name', ({overlay, expected, fields}) => {
  expect(parseSettings(v4('en', {ets2: 'metric', ats: 'metric'}, overlay))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: expected}, fallbackFields: fields});
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
  {name: 'a scale above 2', placements: {...MOVED, card: {x: 0.25, y: 0.75, scale: 2.01}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a string scale', placements: {...MOVED, card: {x: 0.25, y: 0.75, scale: '1.5'}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'a missing x', placements: {...MOVED, card: {y: 0.75, scale: 1.5}}, expected: PLACEMENTS, fields: ['overlay.placements.card']},
  {name: 'invalid strip and cluster placements', placements: {...MOVED, strip: null, cluster: {x: 0, y: 1, scale: 0}},
    expected: MOVED, fields: ['overlay.placements.strip', 'overlay.placements.cluster']}
])('falls back per placement for $name', ({placements, expected, fields}) => {
  expect(parseSettings(v4('en', {ets2: 'metric', ats: 'metric'}, {layout: 'card', sections: ALL_ON, placements}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'card', sections: ALL_ON, placements: expected}}, fallbackFields: fields});
});

it('normalises placements read from the file and accepts the range bounds', () => {
  const placements = {strip: {x: 0, y: 1, scale: 0.5}, card: {x: 1, y: 0, scale: 2}, cluster: {x: 0.123456, y: 0.99999, scale: 1.234}, hud: {x: 0, y: 0, scale: 1}};
  expect(parseSettings(v4('en', {ets2: 'metric', ats: 'metric'}, {layout: 'hud', sections: ALL_ON, placements}))).toEqual({state: 'loaded',
    settings: {language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'hud', sections: ALL_ON,
      placements: {...placements, cluster: {x: 0.1235, y: 1, scale: 1.23}}}}});
});

it.each([
  ['truncated JSON', utf8('{"format":"ets2telemetry.settings","version":4,"units":{"ets2":"metric",')],
  ['an empty file', utf8('')],
  ['a JSON array', utf8('[]')],
  ['JSON null', utf8('null')],
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ['another format marker', utf8('{"format":"ets2telemetry.other","version":4,"units":{}}')],
  ['no format marker', utf8('{"version":4,"language":"en","units":{"ets2":"metric","ats":"metric"}}')],
  ['a string version', utf8('{"format":"ets2telemetry.settings","version":"4","units":{}}')],
  ['a fractional version', utf8('{"format":"ets2telemetry.settings","version":2.5,"units":{}}')],
  ['a UTF-16 byte order mark', new Uint8Array([0xff, 0xfe, ...utf8('{}')])]
])('rejects %s as an invalid file', (_name, bytes) => {
  expect(parseSettings(bytes)).toEqual({state: 'invalid-file'});
});

it('rejects a file above 64 KiB and accepts one of exactly 64 KiB', () => {
  const base = new TextDecoder().decode(v4('en', {ets2: 'us-customary', ats: 'metric'}, {layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}));
  const exact = utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length));
  expect(exact.byteLength).toBe(65536);
  expect(parseSettings(exact)).toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}}});
  expect(parseSettings(utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length + 1)))).toEqual({state: 'invalid-file'});
});

// Changed by ET-029: version 4 is current format, so version 5 is newer-version.
it('classifies missing and older versions as unsupported-older and later ones as newer-version', () => {
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":0,"units":{}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":-3}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":5,"units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'newer-version'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":4,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks'});
});

it('serializes the exact v4 bytes: language, units, sections and placements in canonical order, two-space indentation and a trailing newline', () => {
  expect(serializeSettings({language: 'ru', units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'card', sections: {...ALL_ON, rpm: false}, placements: MOVED}})).toBe([
    '{', '  "format": "ets2telemetry.settings",', '  "version": 4,', '  "language": "ru",', '  "units": {', '    "ets2": "us-customary",', '    "ats": "metric"', '  },',
    '  "overlay": {', '    "layout": "card",', '    "sections": {', '      "speed": true,', '      "gear": true,', '      "rpm": false,', '      "fuel": true,',
    '      "range": true,', '      "sdk-consumption": true,', '      "cargo": true,', '      "origin": true,', '      "destination": true,',
    '      "distance-driven": true,', '      "distance-remaining": true,', '      "deadline": true,', '      "expected-income": true,', '      "game-time": true',
    '    },', '    "placements": {',
    '      "strip": {', '        "x": 0.5,', '        "y": 0,', '        "scale": 1', '      },',
    '      "card": {', '        "x": 0.25,', '        "y": 0.75,', '        "scale": 1.5', '      },',
    '      "cluster": {', '        "x": 0,', '        "y": 1,', '        "scale": 1', '      },',
    '      "hud": {', '        "x": 0,', '        "y": 0,', '        "scale": 1', '      }',
    '    }', '  }', '}', ''].join('\n'));
  // The canonical order holds whatever order the in-memory records have, and values are normalised on the way out.
  const reversed = Object.fromEntries(Object.entries(DRIVING_ONLY).reverse()) as typeof DRIVING_ONLY;
  const placements = {hud: {scale: 1, y: 0, x: 0}, cluster: {x: 0.123456, y: 1, scale: 1.256}, card: PLACEMENTS.card, strip: PLACEMENTS.strip};
  const text = serializeSettings({language: 'en', units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'hud', sections: reversed, placements}});
  const written = JSON.parse(text) as {language: string; overlay: {sections: object; placements: Record<string, object>}};
  expect(written.language).toBe('en');
  expect(Object.keys(written.overlay.sections)).toEqual(Object.keys(ALL_ON));
  expect(Object.keys(written.overlay.placements)).toEqual(['strip', 'card', 'cluster', 'hud']);
  expect(Object.keys(written.overlay.placements.hud)).toEqual(['x', 'y', 'scale']);
  // Round trip through the parser.
  expect(parseSettings(utf8(text))).toEqual({state: 'loaded', settings: {language: 'en', units: {ets2: 'metric', ats: 'metric'},
    overlay: {layout: 'hud', sections: DRIVING_ONLY, placements: {...PLACEMENTS, cluster: {x: 0.1235, y: 1, scale: 1.26}}}}});
});
