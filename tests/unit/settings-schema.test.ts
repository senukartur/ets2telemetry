import {expect, it} from 'vitest';
import {MAX_SETTINGS_BYTES, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';

const utf8 = (text: string) => new TextEncoder().encode(text);
const v1 = (units: unknown, extra: Record<string, unknown> = {}) => utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 1, units, ...extra}));
const v2 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 2, units, overlay, ...extra}));
// Hand-written expectations: the fourteen section ids in canonical order, all enabled by default.
const ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
const DEFAULT_OVERLAY = {layout: 'strip', sections: ALL_ON};
const DRIVING_ONLY = {...ALL_ON, 'sdk-consumption': false, 'cargo': false, 'origin': false, 'destination': false, 'distance-driven': false,
  'distance-remaining': false, 'deadline': false, 'expected-income': false, 'game-time': false};
const without = (record: Record<string, boolean>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('reads a valid v2 file, ignoring unknown keys', () => {
  expect(parseSettings(v2({ets2: 'us-customary', ats: 'metric', future: 'x'}, {layout: 'cluster', sections: {...DRIVING_ONLY, future: true}, theme: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'cluster', sections: DRIVING_ONLY}}});
});

it('migrates a v1 file to v2 in memory: units kept, overlay defaults, migratedFrom 1', () => {
  expect(parseSettings(v1({ets2: 'us-customary', ats: 'metric', future: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {units: {ets2: 'us-customary', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, migratedFrom: 1});
});

it('migrates v1 purely without mutating its input, and leaves current documents unchanged', () => {
  const document = {format: 'ets2telemetry.settings', version: 1, units: {ets2: 'metric', ats: 'metric'}};
  const snapshot = structuredClone(document);
  const migrated = migrateToCurrent(document, 1);
  expect(migrated).toEqual({format: 'ets2telemetry.settings', version: 2, units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY});
  expect(document).toEqual(snapshot);
  expect(migrated).not.toBe(document);
  const current = {format: 'ets2telemetry.settings', version: 2};
  expect(migrateToCurrent(current, 2)).toBe(current);
  expect(migrateToCurrent({format: 'ets2telemetry.settings'}, 0)).toBeUndefined();
});

it('accepts a leading UTF-8 byte order mark', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...v2({ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY)]);
  expect(parseSettings(bytes)).toEqual({state: 'loaded', settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY}});
});

it.each([
  {name: 'invalid and missing profiles', units: {ets2: 'imperial'}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a non-string profile', units: {ets2: 'metric', ats: 1}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ats']},
  {name: 'units not an object', units: ['metric'], expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a profile in the wrong case', units: {ets2: 'Metric', ats: 'metric'}, expected: {ets2: 'metric', ats: 'metric'}, fields: ['units.ets2']}
])('falls back per unit field for $name', ({units, expected, fields}) => {
  expect(parseSettings(v2(units, DEFAULT_OVERLAY))).toEqual({state: 'loaded-with-fallbacks', settings: {units: expected, overlay: DEFAULT_OVERLAY}, fallbackFields: fields});
});

it('lets an invalid v1 unit fall back alone after migration', () => {
  expect(parseSettings(v1({ets2: 'imperial', ats: 'metric'}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, fallbackFields: ['units.ets2'], migratedFrom: 1});
});

it.each([
  {name: 'a missing overlay block', overlay: undefined, expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections']},
  {name: 'an overlay block that is not an object', overlay: 'strip', expected: DEFAULT_OVERLAY, fields: ['overlay.layout', 'overlay.sections']},
  {name: 'an unknown layout', overlay: {layout: 'bar', sections: DRIVING_ONLY}, expected: {layout: 'strip', sections: DRIVING_ONLY}, fields: ['overlay.layout']},
  {name: 'a layout in the wrong case', overlay: {layout: 'Card', sections: DRIVING_ONLY}, expected: {layout: 'strip', sections: DRIVING_ONLY}, fields: ['overlay.layout']},
  {name: 'missing sections', overlay: {layout: 'hud'}, expected: {layout: 'hud', sections: ALL_ON}, fields: ['overlay.sections']},
  {name: 'sections as an array', overlay: {layout: 'hud', sections: [true]}, expected: {layout: 'hud', sections: ALL_ON}, fields: ['overlay.sections']},
  {name: 'every section disabled', overlay: {layout: 'card', sections: Object.fromEntries(Object.keys(ALL_ON).map(id => [id, false]))},
    expected: {layout: 'card', sections: ALL_ON}, fields: ['overlay.sections']},
  {name: 'one non-boolean section', overlay: {layout: 'card', sections: {...DRIVING_ONLY, rpm: 'yes'}},
    expected: {layout: 'card', sections: DRIVING_ONLY}, fields: ['overlay.sections.rpm']},
  {name: 'a non-boolean section that was off', overlay: {layout: 'card', sections: {...DRIVING_ONLY, 'game-time': 0}},
    expected: {layout: 'card', sections: {...DRIVING_ONLY, 'game-time': true}}, fields: ['overlay.sections.game-time']},
  {name: 'one missing section key', overlay: {layout: 'card', sections: without(DRIVING_ONLY, 'deadline')},
    expected: {layout: 'card', sections: {...DRIVING_ONLY, deadline: true}}, fields: ['overlay.sections.deadline']}
])('falls back per overlay field for $name', ({overlay, expected, fields}) => {
  expect(parseSettings(v2({ets2: 'metric', ats: 'metric'}, overlay))).toEqual({state: 'loaded-with-fallbacks',
    settings: {units: {ets2: 'metric', ats: 'metric'}, overlay: expected}, fallbackFields: fields});
});

it.each([
  ['truncated JSON', utf8('{"format":"ets2telemetry.settings","version":2,"units":{"ets2":"metric",')],
  ['an empty file', utf8('')],
  ['a JSON array', utf8('[]')],
  ['JSON null', utf8('null')],
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ['another format marker', utf8('{"format":"ets2telemetry.other","version":2,"units":{}}')],
  ['no format marker', utf8('{"version":2,"units":{"ets2":"metric","ats":"metric"}}')],
  ['a string version', utf8('{"format":"ets2telemetry.settings","version":"2","units":{}}')],
  ['a fractional version', utf8('{"format":"ets2telemetry.settings","version":1.5,"units":{}}')],
  ['a UTF-16 byte order mark', new Uint8Array([0xff, 0xfe, ...utf8('{}')])]
])('rejects %s as an invalid file', (_name, bytes) => {
  expect(parseSettings(bytes)).toEqual({state: 'invalid-file'});
});

it('rejects a file above 64 KiB and accepts one of exactly 64 KiB', () => {
  const base = new TextDecoder().decode(v2({ets2: 'us-customary', ats: 'metric'}, {layout: 'hud', sections: DRIVING_ONLY}));
  const exact = utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length));
  expect(exact.byteLength).toBe(65536);
  expect(parseSettings(exact)).toEqual({state: 'loaded', settings: {units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'hud', sections: DRIVING_ONLY}}});
  expect(parseSettings(utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length + 1)))).toEqual({state: 'invalid-file'});
});

// Changed by ET-012a: version 2 is now the current format, so version 3 is the first newer one.
it('classifies missing and older versions as unsupported-older and later ones as newer-version', () => {
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":0,"units":{}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":-3}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":3,"units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'newer-version'});
});

it('serializes the exact v2 bytes: every section in canonical order, two-space indentation and a trailing newline', () => {
  expect(serializeSettings({units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'card', sections: {...ALL_ON, rpm: false}}})).toBe([
    '{', '  "format": "ets2telemetry.settings",', '  "version": 2,', '  "units": {', '    "ets2": "us-customary",', '    "ats": "metric"', '  },',
    '  "overlay": {', '    "layout": "card",', '    "sections": {', '      "speed": true,', '      "gear": true,', '      "rpm": false,', '      "fuel": true,',
    '      "range": true,', '      "sdk-consumption": true,', '      "cargo": true,', '      "origin": true,', '      "destination": true,',
    '      "distance-driven": true,', '      "distance-remaining": true,', '      "deadline": true,', '      "expected-income": true,', '      "game-time": true',
    '    }', '  }', '}', ''].join('\n'));
  // The canonical order holds whatever order the in-memory record has.
  const reversed = Object.fromEntries(Object.entries(DRIVING_ONLY).reverse()) as typeof DRIVING_ONLY;
  const text = serializeSettings({units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'hud', sections: reversed}});
  expect(Object.keys((JSON.parse(text) as {overlay: {sections: object}}).overlay.sections)).toEqual(Object.keys(ALL_ON));
  // Round trip through the parser.
  expect(parseSettings(utf8(text))).toEqual({state: 'loaded', settings: {units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'hud', sections: DRIVING_ONLY}}});
});
