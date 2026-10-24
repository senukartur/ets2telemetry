import {expect, it} from 'vitest';
import {MAX_SETTINGS_BYTES, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';

const utf8 = (text: string) => new TextEncoder().encode(text);
const v1 = (units: unknown, extra: Record<string, unknown> = {}) => utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 1, units, ...extra}));
const v2 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 2, units, overlay, ...extra}));
const v3 = (units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 3, units, overlay, ...extra}));
// ET-049: current format v7 retains the prior fields and adds background opacity.
const v7 = (language: unknown, autostart: unknown, units: unknown, overlay: unknown, extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 7, language, autostart, units, overlay, ...extra}));

// Hand-written expectations: the fourteen section ids in canonical order, all enabled by default.
const ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
// The ET-012a anchors at scale 1, in canonical layout order.
const PLACEMENTS = {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}};
const MOVED = {...PLACEMENTS, card: {x: 0.25, y: 0.75, scale: 1.5}};
const DEFAULT_OVERLAY = {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: ALL_ON, placements: PLACEMENTS};
const DRIVING_ONLY = {...ALL_ON, 'sdk-consumption': false, 'cargo': false, 'origin': false, 'destination': false, 'distance-driven': false,
  'distance-remaining': false, 'deadline': false, 'expected-income': false, 'game-time': false};
const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

it('migrates v4 purely to enabled v7 without adopting a previously unknown flag', () => {
  const old = {format: 'ets2telemetry.settings', version: 4, language: 'ru', units: {ets2: 'metric', ats: 'metric'}, overlay: {...DEFAULT_OVERLAY, enabled: false}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 4)).toEqual({...old, version: 7, autostart: false, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80}});
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toMatchObject({state: 'loaded', migratedFrom: 4, settings: {overlay: {enabled: true}}});
});
it.each([undefined, null, 0, 1, 'false', {}, []])('falls back independently for invalid current enabled flag %j', enabled => {
  expect(parseSettings(v7('ru', true, {ets2: 'metric', ats: 'metric'}, {...DEFAULT_OVERLAY, enabled}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, fallbackFields: ['overlay.enabled']});
});
it('roundtrips committed false in canonical v7 without falling back', () => {
  const settings = {language: 'ru' as const, autostart: true, units: {ets2: 'metric' as const, ats: 'us-customary' as const}, overlay: {...DEFAULT_OVERLAY, layout: 'card' as const, sections: DRIVING_ONLY, placements: MOVED, enabled: false}};
  const serialized = serializeSettings(settings);
  expect(serialized).toContain('"overlay": {\n    "enabled": false,\n    "backgroundOpacity": 80,\n    "layout": "card"');
  expect(parseSettings(utf8(serialized))).toEqual({state: 'loaded', settings});
});

it('reads a valid current v7 file, ignoring unknown keys', () => {
  expect(parseSettings(v7('ru', false, {ets2: 'us-customary', ats: 'metric', future: 'x'},
    {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: {...DRIVING_ONLY, future: true}, placements: {...MOVED, future: {x: 0, y: 0, scale: 1}}, theme: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'ru', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED}}});
});

it('migrates a v3 file through v4 and v5 to v7 in memory: default language en, units and overlay kept, migratedFrom 3', () => {
  expect(parseSettings(v3({ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY, placements: MOVED}},
      migratedFrom: 3});
});

it('migrates a v2 file through v3, v4 and v5 to v7 in memory: default language en, layout and sections kept, default placements, migratedFrom 2', () => {
  expect(parseSettings(v2({ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'cluster', sections: DRIVING_ONLY, placements: PLACEMENTS}},
      migratedFrom: 2});
  // A v2 file never had placements: a stray key is replaced by the defaults.
  expect(parseSettings(v2({ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON, placements: MOVED})))
    .toMatchObject({state: 'loaded', settings: {language: 'en', overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', placements: PLACEMENTS}}, migratedFrom: 2});
});

it('migrates a v1 file through v2, v3 and v4 to v7 in memory: default language en, autostart false, units kept, overlay defaults, migratedFrom 1', () => {
  expect(parseSettings(v1({ets2: 'us-customary', ats: 'metric', future: 'x'}, {theme: 'dark'})))
    .toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, migratedFrom: 1});
});

it('migrates v1, v2, v3 and v4 purely without mutating their input, and leaves current documents unchanged', () => {
  const document = {format: 'ets2telemetry.settings', version: 1, units: {ets2: 'metric', ats: 'metric'}};
  const snapshot = structuredClone(document);
  const migrated = migrateToCurrent(document, 1);
  expect(migrated).toEqual({format: 'ets2telemetry.settings', version: 7, language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY});
  expect(document).toEqual(snapshot);
  expect(migrated).not.toBe(document);

  const second = {format: 'ets2telemetry.settings', version: 2, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: DRIVING_ONLY}};
  const secondSnapshot = structuredClone(second);
  const upgraded = migrateToCurrent(second, 2);
  expect(upgraded).toEqual({...second, version: 7, language: 'en', autostart: false, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: DRIVING_ONLY, placements: PLACEMENTS}});
  expect(second).toEqual(secondSnapshot); expect(upgraded!.overlay).not.toBe(second.overlay);

  const third = {format: 'ets2telemetry.settings', version: 3, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: DRIVING_ONLY, placements: PLACEMENTS}};
  const thirdSnapshot = structuredClone(third);
  const upgradedThird = migrateToCurrent(third, 3);
  expect(upgradedThird).toEqual({...third, version: 7, language: 'en', autostart: false});
  expect(third).toEqual(thirdSnapshot);

  const fourth = {format: 'ets2telemetry.settings', version: 4, language: 'ru', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: {layout: 'card', sections: DRIVING_ONLY, placements: PLACEMENTS}};
  const fourthSnapshot = structuredClone(fourth);
  const upgradedFourth = migrateToCurrent(fourth, 4);
  expect(upgradedFourth).toEqual({...fourth, version: 7, autostart: false, overlay: {...fourth.overlay, enabled: true, backgroundOpacity: 80}});
  expect(fourth).toEqual(fourthSnapshot);

  // A v2 overlay that is not an object stays as it is.
  expect(migrateToCurrent({format: 'ets2telemetry.settings', version: 2, overlay: 'strip'}, 2)).toEqual({format: 'ets2telemetry.settings', version: 7, language: 'en', autostart: false, overlay: 'strip'});
  const current = {format: 'ets2telemetry.settings', version: 7};
  expect(migrateToCurrent(current, 7)).toBe(current);
  expect(migrateToCurrent({format: 'ets2telemetry.settings'}, 0)).toBeUndefined();
});

it('accepts a leading UTF-8 byte order mark', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...v7('en', false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY)]);
  expect(parseSettings(bytes)).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY}});
});

it.each([
  {name: 'invalid language', language: 'fr', expected: 'en', fields: ['language']},
  {name: 'numeric language', language: 123, expected: 'en', fields: ['language']},
  {name: 'uppercase language', language: 'EN', expected: 'en', fields: ['language']},
  {name: 'missing language', language: undefined, expected: 'en', fields: ['language']}
])('falls back per language field for $name', ({language, expected, fields}) => {
  expect(parseSettings(v7(language, false, {ets2: 'metric', ats: 'us-customary'}, DEFAULT_OVERLAY))).toEqual({
    state: 'loaded-with-fallbacks',
    settings: {language: expected, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY},
    fallbackFields: fields
  });
});

it.each([
  {name: 'invalid autostart string', autostart: 'yes', expected: false, fields: ['autostart']},
  {name: 'numeric autostart', autostart: 1, expected: false, fields: ['autostart']},
  {name: 'null autostart', autostart: null, expected: false, fields: ['autostart']},
  {name: 'missing autostart', autostart: undefined, expected: false, fields: ['autostart']}
])('falls back per autostart field for $name', ({autostart, expected, fields}) => {
  expect(parseSettings(v7('en', autostart, {ets2: 'metric', ats: 'us-customary'}, {...DEFAULT_OVERLAY, enabled: false}))).toEqual({
    state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: expected, units: {ets2: 'metric', ats: 'us-customary'}, overlay: {...DEFAULT_OVERLAY, enabled: false}},
    fallbackFields: fields
  });
});

it.each([
  {name: 'invalid and missing profiles', units: {ets2: 'imperial'}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a non-string profile', units: {ets2: 'metric', ats: 1}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ats']},
  {name: 'units not an object', units: ['metric'], expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a profile in the wrong case', units: {ets2: 'Metric', ats: 'metric'}, expected: {ets2: 'metric', ats: 'metric'}, fields: ['units.ets2']}
])('falls back per unit field for $name', ({units, expected, fields}) => {
  expect(parseSettings(v7('en', false, units, DEFAULT_OVERLAY))).toEqual({state: 'loaded-with-fallbacks', settings: {language: 'en', autostart: false, units: expected, overlay: DEFAULT_OVERLAY}, fallbackFields: fields});
});

it('lets an invalid v1 unit fall back alone after migration', () => {
  expect(parseSettings(v1({ets2: 'imperial', ats: 'metric'}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: DEFAULT_OVERLAY}, fallbackFields: ['units.ets2'], migratedFrom: 1});
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
    expected: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...DRIVING_ONLY, deadline: true}, placements: MOVED}, fields: ['overlay.sections.deadline']}
])('falls back per overlay field for $name', ({overlay, expected, fields}) => {
  expect(parseSettings(v7('en', false, {ets2: 'metric', ats: 'metric'}, overlay))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: expected}, fallbackFields: fields});
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
  expect(parseSettings(v7('en', false, {ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements}))).toEqual({state: 'loaded-with-fallbacks',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements: expected}}, fallbackFields: fields});
});

it('normalises placements read from the file and accepts the range bounds', () => {
  const placements = {strip: {x: 0, y: 1, scale: 0.5}, card: {x: 1, y: 0, scale: 2}, cluster: {x: 0.123456, y: 0.99999, scale: 1.234}, hud: {x: 0, y: 0, scale: 1}};
  expect(parseSettings(v7('en', false, {ets2: 'metric', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON, placements}))).toEqual({state: 'loaded',
    settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON,
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
  const base = new TextDecoder().decode(v7('en', false, {ets2: 'us-customary', ats: 'metric'}, {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}));
  const exact = utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length));
  expect(exact.byteLength).toBe(65536);
  expect(parseSettings(exact)).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: MOVED}}});
  expect(parseSettings(utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length + 1)))).toEqual({state: 'invalid-file'});
});

// ET-049: version 7 is current format, so version 8 is newer-version.
it('classifies missing and older versions as unsupported-older and later ones as newer-version', () => {
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":0,"units":{}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":-3}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":8,"units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'newer-version'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":4,"units":{"ets2":"metric","ats":"metric"}}'))).toMatchObject({state: 'loaded-with-fallbacks'});
});

it('serializes the exact v7 bytes: language, units, sections and placements in canonical order, two-space indentation and a trailing newline', () => {
  expect(serializeSettings({language: 'ru', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: {...ALL_ON, rpm: false}, placements: MOVED}})).toBe([
    '{', '  "format": "ets2telemetry.settings",', '  "version": 7,', '  "language": "ru",', '  "autostart": false,', '  "units": {', '    "ets2": "us-customary",', '    "ats": "metric"', '  },',
    '  "overlay": {', '    "enabled": true,', '    "backgroundOpacity": 80,', '    "layout": "card",', '    "sections": {', '      "speed": true,', '      "gear": true,', '      "rpm": false,', '      "fuel": true,',
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
  const text = serializeSettings({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: reversed, placements}});
  const written = JSON.parse(text) as {language: string; autostart: boolean; overlay: {sections: object; placements: Record<string, object>}};
  expect(written.language).toBe('en');
  expect(written.autostart).toBe(false);
  expect(Object.keys(written.overlay.sections)).toEqual(Object.keys(ALL_ON));
  expect(Object.keys(written.overlay.placements)).toEqual(['strip', 'card', 'cluster', 'hud']);
  expect(Object.keys(written.overlay.placements.hud)).toEqual(['x', 'y', 'scale']);
  // Round trip through the parser.
  expect(parseSettings(utf8(text))).toEqual({state: 'loaded', settings: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'},
    overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: DRIVING_ONLY, placements: {...PLACEMENTS, cluster: {x: 0.1235, y: 1, scale: 1.26}}}}});
});

it('migrates accepted v5 autostart true purely while preserving all prior settings', () => {
  const old = {format: 'ets2telemetry.settings', version: 5, language: 'ru', autostart: true,
    units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'card', sections: DRIVING_ONLY, placements: MOVED}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 5)).toEqual({...old, version: 7, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80}});
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 5,
    settings: {language: 'ru', autostart: true, units: old.units, overlay: {...old.overlay, enabled: true, backgroundOpacity: 80}}});
  expect(old).toEqual(before);
});

// ET-049: authentic v6 migration ignores a stray future opacity and never mutates input.
it('migrates v6 to the unchanged 80% appearance while retaining every existing preference', () => {
  const old = {format: 'ets2telemetry.settings', version: 6, language: 'ru', autostart: true,
    units: {ets2: 'us-customary', ats: 'metric'}, overlay: {...DEFAULT_OVERLAY, enabled: false, layout: 'card', placements: MOVED, backgroundOpacity: 42}};
  const before = structuredClone(old);
  expect(migrateToCurrent(old, 6)).toEqual({...old, version: 7, overlay: {...old.overlay, backgroundOpacity: 80}});
  expect(old).toEqual(before);
  expect(parseSettings(utf8(JSON.stringify(old)))).toEqual({state: 'loaded', migratedFrom: 6,
    settings: {language: 'ru', autostart: true, units: old.units, overlay: {...old.overlay, backgroundOpacity: 80}}});
});
it.each([undefined, null, '60', false, 39, 101, 80.5, {}, []])('falls back only opacity for invalid stored value %j', backgroundOpacity => {
  expect(parseSettings(v7('ru', true, {ets2: 'metric', ats: 'us-customary'}, {...DEFAULT_OVERLAY, backgroundOpacity})))
    .toEqual({state: 'loaded-with-fallbacks', fallbackFields: ['overlay.backgroundOpacity'],
      settings: {language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY}});
});
it.each([40, 65, 80, 100])('roundtrips opacity %i without changing other fields', backgroundOpacity => {
  const settings = {language: 'ru' as const, autostart: true, units: {ets2: 'metric' as const, ats: 'us-customary' as const},
    overlay: {...DEFAULT_OVERLAY, layout: 'card' as const, enabled: false, backgroundOpacity, placements: MOVED}};
  expect(parseSettings(utf8(serializeSettings(settings)))).toEqual({state: 'loaded', settings});
});
