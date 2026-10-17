// A bounded reader for Valve's text KeyValues files (libraryfolders.vdf, appmanifest_<id>.acf); see
// docs/plugin-setup.md, "Steam discovery". Only the subset Steam writes is accepted: quoted keys and values, braces,
// whitespace and `//` comments, a UTF-8 byte order mark and the escapes of Valve's reader (`\n \t \v \b \r \f \a \\
// \? \' \"`). Unquoted tokens, conditionals such as [$WIN32], `#include`, other escapes and invalid UTF-8 are rejected,
// so a damaged or unexpected file never yields a partial result.

/** Largest accepted file: libraryfolders.vdf and appmanifest files are a few KiB. */
export const VDF_MAX_BYTES = 1024 * 1024;
/** Deepest accepted nesting of braces. libraryfolders.vdf uses 3 levels (libraryfolders > 0 > apps). */
export const VDF_MAX_DEPTH = 8;
/** Longest accepted key or value, in UTF-8 bytes after unescaping. */
export const VDF_MAX_STRING_BYTES = 4096;

export type VdfErrorCode = 'VDF_TOO_LARGE' | 'VDF_ENCODING' | 'VDF_SYNTAX' | 'VDF_DEPTH' | 'VDF_STRING_TOO_LONG';
/** A rejected file. The message is fixed text and never contains file content or a path. */
export class VdfError extends Error {
  constructor(readonly code: VdfErrorCode) {super(`KeyValues file rejected: ${code}`); this.name = 'VdfError';}
}

export type VdfValue = string | VdfObject;
/**
 * One brace block, in file order. KeyValues allows repeated keys, so entries are a list rather than a record; that also
 * keeps keys such as `__proto__` from reaching an object prototype.
 */
export interface VdfObject {readonly entries: readonly (readonly [string, VdfValue])[]}

const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false});
/** The escape set of Valve's KeyValues reader; any other character after `\` is refused. */
const ESCAPES: ReadonlyMap<string | undefined, string> = new Map([
  ['n', '\n'], ['t', '\t'], ['v', '\v'], ['b', '\b'], ['r', '\r'], ['f', '\f'], ['a', '\x07'], ['\\', '\\'], ['?', '?'], ["'", "'"], ['"', '"']
]);
/**
 * UTF-8 bytes of one UTF-16 code unit of well-formed text. Each half of a surrogate pair counts 2, so the pair counts
 * the 4 bytes of its code point; the decoder never yields an unpaired surrogate.
 */
const utf8Bytes = (unit: number) => unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 2 : 3;

/** Parses a whole file into its top-level block. Throws VdfError for every rejected input. */
export function parseVdf(bytes: Uint8Array): VdfObject {
  if (bytes.length > VDF_MAX_BYTES) throw new VdfError('VDF_TOO_LARGE');
  let text: string;
  // ignoreBOM: false makes the decoder drop one leading byte order mark.
  try {text = decoder.decode(bytes);} catch {throw new VdfError('VDF_ENCODING');}
  let position = 0;

  const skipSpaceAndComments = () => {
    while (position < text.length) {
      const character = text[position];
      if (character === ' ' || character === '\t' || character === '\r' || character === '\n') position++;
      else if (character === '/' && text[position + 1] === '/') {
        while (position < text.length && text[position] !== '\n') position++;
      } else return;
    }
  };
  const readString = (): string => {
    // The caller has checked the opening quote.
    position++;
    let value = '', bytes = 0;
    while (true) {
      if (position >= text.length) throw new VdfError('VDF_SYNTAX');
      let character = text[position++];
      if (character === '"') break;
      if (character === '\\') {
        const escaped = ESCAPES.get(text[position++]);
        if (escaped === undefined) throw new VdfError('VDF_SYNTAX');
        character = escaped;
      }
      value += character;
      bytes += utf8Bytes(character.charCodeAt(0));
      if (bytes > VDF_MAX_STRING_BYTES) throw new VdfError('VDF_STRING_TOO_LONG');
    }
    return value;
  };
  // Reads key/value pairs until a closing brace (depth > 0) or the end of the file (depth 0).
  const readBlock = (depth: number): VdfObject => {
    const entries: (readonly [string, VdfValue])[] = [];
    while (true) {
      skipSpaceAndComments();
      if (position >= text.length) {
        if (depth > 0) throw new VdfError('VDF_SYNTAX');
        return {entries};
      }
      if (text[position] === '}') {
        if (depth === 0) throw new VdfError('VDF_SYNTAX');
        position++;
        return {entries};
      }
      if (text[position] !== '"') throw new VdfError('VDF_SYNTAX');
      const key = readString();
      skipSpaceAndComments();
      if (text[position] === '"') entries.push([key, readString()]);
      else if (text[position] === '{') {
        if (depth + 1 > VDF_MAX_DEPTH) throw new VdfError('VDF_DEPTH');
        position++;
        entries.push([key, readBlock(depth + 1)]);
      } else throw new VdfError('VDF_SYNTAX');
    }
  };
  return readBlock(0);
}

/**
 * The single entry named `key`, compared case-insensitively as Steam does. Returns undefined when it is absent and
 * throws VDF_SYNTAX when it is repeated: an ambiguous identity field is never resolved by picking one.
 */
export function vdfEntry(block: VdfObject, key: string): VdfValue | undefined {
  const wanted = key.toLowerCase();
  const matches = block.entries.filter(([name]) => name.toLowerCase() === wanted);
  if (matches.length > 1) throw new VdfError('VDF_SYNTAX');
  return matches[0]?.[1];
}

export function isVdfObject(value: VdfValue | undefined): value is VdfObject {
  return typeof value === 'object';
}
