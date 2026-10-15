import {expect, it} from 'vitest';
import {MAX_SETTINGS_BYTES, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';

const utf8 = (text: string) => new TextEncoder().encode(text);
const v1 = (units: unknown, extra: Record<string, unknown> = {}) => utf8(JSON.stringify({format: 'ets2telemetry.settings', version: 1, units, ...extra}));

it('reads a valid v1 file, ignoring unknown keys', () => {
  expect(parseSettings(v1({ets2: 'us-customary', ats: 'metric', future: 'x'}, {theme: 'dark'}))).toEqual({state: 'loaded', settings: {units: {ets2: 'us-customary', ats: 'metric'}}});
});

it('accepts a leading UTF-8 byte order mark', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...v1({ets2: 'metric', ats: 'us-customary'})]);
  expect(parseSettings(bytes)).toEqual({state: 'loaded', settings: {units: {ets2: 'metric', ats: 'us-customary'}}});
});

it.each([
  {name: 'invalid and missing profiles', units: {ets2: 'imperial'}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a non-string profile', units: {ets2: 'metric', ats: 1}, expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ats']},
  {name: 'units not an object', units: ['metric'], expected: {ets2: 'metric', ats: 'us-customary'}, fields: ['units.ets2', 'units.ats']},
  {name: 'a profile in the wrong case', units: {ets2: 'Metric', ats: 'metric'}, expected: {ets2: 'metric', ats: 'metric'}, fields: ['units.ets2']}
])('falls back per field for $name', ({units, expected, fields}) => {
  expect(parseSettings(v1(units))).toEqual({state: 'loaded-with-fallbacks', settings: {units: expected}, fallbackFields: fields});
});

it.each([
  ['truncated JSON', utf8('{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric",')],
  ['an empty file', utf8('')],
  ['a JSON array', utf8('[]')],
  ['JSON null', utf8('null')],
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ['another format marker', utf8('{"format":"ets2telemetry.other","version":1,"units":{}}')],
  ['no format marker', utf8('{"version":1,"units":{"ets2":"metric","ats":"metric"}}')],
  ['a string version', utf8('{"format":"ets2telemetry.settings","version":"1","units":{}}')],
  ['a fractional version', utf8('{"format":"ets2telemetry.settings","version":1.5,"units":{}}')],
  ['a UTF-16 byte order mark', new Uint8Array([0xff, 0xfe, ...utf8('{}')])]
])('rejects %s as an invalid file', (_name, bytes) => {
  expect(parseSettings(bytes)).toEqual({state: 'invalid-file'});
});

it('rejects a file above 64 KiB and accepts one of exactly 64 KiB', () => {
  const base = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"us-customary","ats":"metric"}}';
  const exact = utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length));
  expect(exact.byteLength).toBe(65536);
  expect(parseSettings(exact)).toEqual({state: 'loaded', settings: {units: {ets2: 'us-customary', ats: 'metric'}}});
  expect(parseSettings(utf8(base + ' '.repeat(MAX_SETTINGS_BYTES - base.length + 1)))).toEqual({state: 'invalid-file'});
});

it('classifies missing and older versions as unsupported-older and later ones as newer-version', () => {
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":0,"units":{}}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":-3}'))).toEqual({state: 'unsupported-older'});
  expect(parseSettings(utf8('{"format":"ets2telemetry.settings","version":2,"units":{"ets2":"metric","ats":"metric"}}'))).toEqual({state: 'newer-version'});
});

it('has no migration path to v1 yet and leaves v1 documents unchanged', () => {
  expect(migrateToCurrent({format: 'ets2telemetry.settings'}, 0)).toBeUndefined();
  const document = {format: 'ets2telemetry.settings', version: 1};
  expect(migrateToCurrent(document, 1)).toBe(document);
});

it('serializes the exact v1 bytes: no byte order mark, two-space indentation and a trailing newline', () => {
  expect(serializeSettings({units: {ets2: 'us-customary', ats: 'us-customary'}})).toBe(
    '{\n  "format": "ets2telemetry.settings",\n  "version": 1,\n  "units": {\n    "ets2": "us-customary",\n    "ats": "us-customary"\n  }\n}\n');
  // Round trip through the parser.
  expect(parseSettings(utf8(serializeSettings({units: {ets2: 'metric', ats: 'metric'}})))).toEqual({state: 'loaded', settings: {units: {ets2: 'metric', ats: 'metric'}}});
});
