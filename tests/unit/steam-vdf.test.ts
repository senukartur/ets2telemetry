import {describe, expect, it} from 'vitest';
import {parseVdf, vdfEntry, VdfError, VDF_MAX_BYTES, VDF_MAX_DEPTH, VDF_MAX_STRING_BYTES, type VdfObject} from '../../apps/desktop/src/plugin-setup/vdf';
import {libraryPathsFromVdf, MAX_STEAM_LIBRARIES} from '../../apps/desktop/src/plugin-setup/steam-discovery';

// REG-015 (ET-017 P2): the bounded KeyValues reader for libraryfolders.vdf and appmanifest files. Expected values are
// written by hand from the file formats Steam writes.

const parse = (text: string | Uint8Array) => parseVdf(typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
const code = (run: () => unknown) => {
  try {run();} catch (error) {return error instanceof VdfError ? error.code : `unexpected ${String(error)}`;}
  return 'accepted';
};
const libraries = (text: string) => libraryPathsFromVdf(parse(text));

describe('formats Steam writes', () => {
  it('reads the current libraryfolders format: numbered blocks with a path', () => {
    const document = parse([
      '"libraryfolders"', '{',
      '\t"0"', '\t{', '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"', '\t\t"label"\t\t""', '\t\t"contentid"\t\t"123"',
      '\t\t"apps"', '\t\t{', '\t\t\t"227300"\t\t"1234"', '\t\t}', '\t}',
      '\t"1"', '\t{', '\t\t"path"\t\t"D:\\\\SteamLibrary"', '\t}', '}', ''
    ].join('\n'));
    expect(libraryPathsFromVdf(document)).toEqual({ok: true, paths: ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'], rejected: 0});
  });

  it('reads the legacy format: numbered strings beside non-library keys, top key in any case', () => {
    expect(libraries('"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1700000000"\n\t"ContentStatsID"\t\t"-42"\n\t"1"\t\t"E:\\\\Games\\\\Steam"\n\t"2"\t\t"F:\\\\Lib"\n}\n'))
      .toEqual({ok: true, paths: ['E:\\Games\\Steam', 'F:\\Lib'], rejected: 0});
  });

  it('orders libraries by number and rejects UNC, device and relative library paths one by one', () => {
    expect(libraries('"libraryfolders" { "2" "F:\\\\B" "1" "E:\\\\A" "3" "\\\\\\\\server\\\\share" "4" "\\\\\\\\?\\\\C:\\\\x" "5" "relative\\\\lib" "6" "G:relative" }'))
      .toEqual({ok: true, paths: ['E:\\A', 'F:\\B'], rejected: 4});
  });

  it('reads an appmanifest and keeps every entry in file order', () => {
    const document = parse('"AppState"\n{\n\t"appid"\t\t"227300"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Euro Truck Simulator 2"\n}\n');
    const state = vdfEntry(document, 'appstate') as VdfObject;
    expect(state.entries).toEqual([['appid', '227300'], ['StateFlags', '4'], ['installdir', 'Euro Truck Simulator 2']]);
  });
});

describe('lexical rules', () => {
  it('unescapes only \\\\ and \\"', () => {
    const document = parse('"k" "a\\\\b\\"c"');
    expect(document.entries).toEqual([['k', 'a\\b"c']]);
    for (const escape of ['\\n', '\\t', '\\x', '\\u0041']) expect(code(() => parse(`"k" "a${escape}"`))).toBe('VDF_SYNTAX');
  });

  it('skips // comments between tokens and after values, but not inside strings', () => {
    const document = parse('// header\n"root" // after key\n{\n\t"k" "v // not a comment" // trailing\n}\n// end');
    expect(document.entries).toEqual([['root', {entries: [['k', 'v // not a comment']]}]]);
  });

  it('accepts one UTF-8 byte order mark and non-ASCII text', () => {
    const body = Buffer.from('"k" "D:\\\\Игры\\\\Steam"', 'utf8');
    expect(parseVdf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])).entries).toEqual([['k', 'D:\\Игры\\Steam']]);
  });

  it('rejects bytes that are not UTF-8', () => {
    // 0xC8 0xE3 is "Иг" in Windows-1251, which Steam never writes.
    expect(code(() => parseVdf(Buffer.from([0x22, 0x6b, 0x22, 0x20, 0x22, 0xc8, 0xe3, 0x22])))).toBe('VDF_ENCODING');
  });

  it('keeps __proto__ as an ordinary key', () => {
    const document = parse('"__proto__" { "polluted" "yes" }');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(vdfEntry(document, '__proto__')).toEqual({entries: [['polluted', 'yes']]});
  });

  it('finds keys case-insensitively and refuses a repeated key', () => {
    const document = parse('"a" "1" "B" "2" "b" "3"');
    expect(vdfEntry(document, 'A')).toBe('1');
    expect(vdfEntry(document, 'missing')).toBeUndefined();
    expect(code(() => vdfEntry(document, 'b'))).toBe('VDF_SYNTAX');
  });
});

describe('bounds and malformed input', () => {
  it(`accepts ${VDF_MAX_BYTES} bytes and rejects one more`, () => {
    const prefix = '"k" "v"\n//';
    const exact = Buffer.from(prefix + 'x'.repeat(VDF_MAX_BYTES - prefix.length));
    expect(exact.length).toBe(1024 * 1024);
    expect(parseVdf(exact).entries).toEqual([['k', 'v']]);
    expect(code(() => parseVdf(Buffer.concat([exact, Buffer.from('x')])))).toBe('VDF_TOO_LARGE');
  });

  it(`accepts nesting depth ${VDF_MAX_DEPTH} and rejects depth ${VDF_MAX_DEPTH + 1}`, () => {
    const nested = (depth: number) => '"k" { '.repeat(depth) + '"leaf" "v"' + ' }'.repeat(depth);
    expect(VDF_MAX_DEPTH).toBe(8);
    expect(code(() => parse(nested(8)))).toBe('accepted');
    expect(code(() => parse(nested(9)))).toBe('VDF_DEPTH');
  });

  it(`accepts strings of ${VDF_MAX_STRING_BYTES} UTF-8 bytes and rejects longer ones, keys included`, () => {
    expect(VDF_MAX_STRING_BYTES).toBe(4096);
    expect(code(() => parse(`"k" "${'a'.repeat(4096)}"`))).toBe('accepted');
    expect(code(() => parse(`"k" "${'a'.repeat(4097)}"`))).toBe('VDF_STRING_TOO_LONG');
    // Cyrillic letters are two bytes each.
    expect(code(() => parse(`"k" "${'д'.repeat(2048)}"`))).toBe('accepted');
    expect(code(() => parse(`"k" "${'д'.repeat(2049)}"`))).toBe('VDF_STRING_TOO_LONG');
    expect(code(() => parse(`"${'a'.repeat(4097)}" "v"`))).toBe('VDF_STRING_TOO_LONG');
    // An escape counts as the one character it stands for.
    expect(code(() => parse(`"k" "${'\\\\'.repeat(4096)}"`))).toBe('accepted');
  });

  it(`accepts ${MAX_STEAM_LIBRARIES} libraries and rejects the list with one more`, () => {
    const list = (count: number) => `"libraryfolders" { ${Array.from({length: count}, (_, index) => `"${index}" { "path" "D:\\\\L${index}" }`).join(' ')} }`;
    const accepted = libraries(list(64));
    expect(accepted.ok && accepted.paths.length).toBe(64);
    expect(libraries(list(65))).toEqual({ok: false, reason: 'too-many-libraries'});
  });

  it.each([
    ['an unterminated string', '"k" "v'],
    ['an unterminated block', '"k" { "a" "b"'],
    ['a stray closing brace', '"k" "v" }'],
    ['an unquoted token', '"k" v'],
    ['an unquoted key', 'k "v"'],
    ['a key without a value', '"k"'],
    ['a conditional', '"k" "v" [$WIN32]'],
    ['an #include', '#include "other.vdf"'],
    ['a dangling escape', '"k" "v\\']
  ])('rejects %s', (_name, text) => {
    expect(code(() => parse(text))).toBe('VDF_SYNTAX');
  });

  it('rejects a libraryfolders file without the top key or with a numbered block lacking a path', () => {
    expect(libraries('"something" { "0" { "path" "D:\\\\L" } }')).toEqual({ok: false, reason: 'no-libraryfolders'});
    expect(libraries('"libraryfolders" "D:\\\\L"')).toEqual({ok: false, reason: 'no-libraryfolders'});
    expect(libraries('"libraryfolders" { "0" { "label" "x" } }')).toEqual({ok: false, reason: 'library-without-path'});
    expect(code(() => libraries('"libraryfolders" { "0" { "path" "D:\\\\A" "PATH" "D:\\\\B" } }'))).toBe('VDF_SYNTAX');
  });
});
