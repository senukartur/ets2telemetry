// telemetry-core is pure TypeScript shared by renderer and service code. It may import only its own modules,
// type-only declarations from packages/contracts/src and, for the trip reducer's effect types (ET-014, T2) and the sampler's row type (ET-015b), type-only
// declarations from exactly packages/storage/src/api.ts. Node.js, Electron, React, any runtime package, any other
// storage module, Node globals and triple-slash type references are forbidden. This test replaces a lint-config rule
// (decision N16), so tools/lint and the root tsconfig stay unchanged.
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const coreDir = resolve('packages/telemetry-core/src');
const contractsDir = resolve('packages/contracts/src');
/** The one storage module telemetry-core may name, and only in a type-only import. */
const storageApi = resolve('packages/storage/src/api');
const files = readdirSync(coreDir, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.ts')).map(file => join(coreDir, file));
const STATIC = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE = /\bimport\s+['"]([^'"]+)['"]/g;
const NODE_GLOBAL = /(?<![\w$.])(process|Buffer|__dirname|__filename|global|globalThis|require|setImmediate|clearImmediate)(?![\w$])/g;
const TRIPLE_SLASH = /^\s*\/\/\/\s*<reference\b/m;
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

// A `/` starts a regex literal, not a division, after these tokens (or at the start of the source).
const REGEX_AFTER_PUNCTUATOR = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_AFTER_KEYWORD = /(?<![\w$])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;

/**
 * A small TypeScript lexer for this scan. It removes comments and regex literals, and the text of template literals,
 * while keeping the code inside `${…}` interpolations (nested templates included). With `strings` it also empties
 * single- and double-quoted strings; without it, quoted strings stay intact so import specifiers can be read. Prose,
 * quoted text and regex patterns therefore can neither hide code from the scan nor fake an import or a global.
 */
function strip(source: string, strings: boolean): string {
  const n = source.length;
  let out = '';
  let depth = 0;
  const interpolations: number[] = [];
  /** Scans template text from `j`; returns the index after the closing backtick or after an opening `${`. */
  const templateText = (j: number): {end: number; interpolation: boolean} => {
    while (j < n) {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '`') return {end: j + 1, interpolation: false};
      if (source[j] === '$' && source[j + 1] === '{') return {end: j + 2, interpolation: true};
      j++;
    }
    return {end: n, interpolation: false};
  };
  const enterTemplate = (from: number, opening: string): number => {
    const scanned = templateText(from);
    if (scanned.interpolation) { interpolations.push(depth); depth = 0; out += `${opening}\${`; } else out += `${opening}\``;
    return scanned.end;
  };
  /** Returns the index after a regex literal starting at `i`, or undefined when `/` is not a complete regex here. */
  const regexEnd = (i: number): number | undefined => {
    const before = out.trimEnd();
    if (before !== '' && !REGEX_AFTER_PUNCTUATOR.test(before) && !REGEX_AFTER_KEYWORD.test(before)) return undefined;
    let j = i + 1, inClass = false;
    while (j < n && source[j] !== '\n') {
      const c = source[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { j++; while (j < n && /[a-z]/i.test(source[j])) j++; return j; }
      j++;
    }
    return undefined;
  };
  for (let i = 0; i < n;) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; out += ' '; continue; }
    if (c === '/') {
      const end = regexEnd(i);
      if (end !== undefined) { out += '/r/'; i = end; continue; }
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += strings ? c + c : source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') { i = enterTemplate(i + 1, '`'); continue; }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0 && interpolations.length) { depth = interpolations.pop()!; i = enterTemplate(i + 1, '}'); continue; }
      depth--;
    }
    out += c; i++;
  }
  return out;
}

interface Specifier {specifier: string; typeOnly: boolean}
function specifiers(source: string): Specifier[] {
  const code = strip(source, false);
  const found: Specifier[] = [];
  for (const match of code.matchAll(STATIC)) found.push({specifier: match[4], typeOnly: match[2] !== undefined});
  for (const match of code.matchAll(BARE)) found.push({specifier: match[1], typeOnly: false});
  return found;
}
/** Every rule violation of one telemetry-core source file at `file`. */
function violations(source: string, file: string): string[] {
  const problems: string[] = [];
  const bare = strip(source, true);
  if (TRIPLE_SLASH.test(source)) problems.push('triple-slash reference');
  if (/\bimport\s*\(/.test(bare)) problems.push('dynamic import()');
  for (const match of bare.matchAll(NODE_GLOBAL)) problems.push(`Node global ${match[1]}`);
  for (const {specifier, typeOnly} of specifiers(source)) {
    if (!specifier.startsWith('.')) { problems.push(`package import ${specifier}`); continue; }
    const target = resolve(dirname(file), specifier);
    if (inside(target, coreDir)) continue;
    if (inside(target, contractsDir) && typeOnly) continue;
    const isStorageApi = target.replace(/\.ts$/, '') === storageApi;
    if (isStorageApi && typeOnly) continue;
    problems.push(inside(target, contractsDir) ? `runtime contracts import ${specifier}`
      : isStorageApi ? `runtime storage import ${specifier}` : `import outside the allowed modules ${specifier}`);
  }
  return problems;
}

describe('telemetry-core import boundary', () => {
  it('finds the expected modules and their imports', () => {
    const names = files.map(file => relative(coreDir, file).split(sep).join('/')).sort();
    expect(names).toEqual(['consumption-hold.ts', 'derived.ts', 'display-profile.ts', 'format.ts', 'gear-labels.ts', 'hard-mode/index.ts', 'history-samples.ts', 'index.ts', 'live-view.ts', 'mandatory-break.ts', 'normalize-v0.ts', 'normalize-v1.ts', 'readings.ts',
      'trips/accounting.ts', 'trips/identity.ts', 'trips/reducer.ts', 'trips/types.ts', 'trips/view.ts', 'units.ts']);
    const all = files.flatMap(file => specifiers(readFileSync(file, 'utf8'))).map(({specifier, typeOnly}) => `${typeOnly ? 'type ' : ''}${specifier}`);
    expect(all).toContain('type ../../contracts/src/protocol-v0');
    expect(all).toContain('type ../../contracts/src/protocol-v1');
    expect(all).toContain('type ../../contracts/src');
    expect(all).toContain('type ../../../storage/src/api');
    expect(all).toContain('type ../../storage/src/api');
    expect(all).toContain('./units');
    // The storage API is the only storage module named anywhere in telemetry-core, and only by type.
    expect(all.filter(name => name.includes('storage/'))).toEqual(all.filter(name => name === 'type ../../../storage/src/api' || name === 'type ../../storage/src/api'));
  });
  it.each(files.map(file => [relative(coreDir, file), file]))('%s imports only telemetry-core modules and contracts types', (_name, file) => {
    expect(violations(readFileSync(file, 'utf8'), file)).toEqual([]);
  });
  describe('rejects each forbidden pattern', () => {
    const at = join(coreDir, 'probe.ts');
    it.each([
      ['a Node module', "import {readFileSync} from 'node:fs';", ['package import node:fs']],
      ['a multi-line Electron import', "import {\n  ipcRenderer\n} from 'electron';", ['package import electron']],
      ['a React re-export', "export {useState} from 'react';", ['package import react']],
      ['a side-effect import', "import 'node:path';", ['package import node:path']],
      ['a runtime contracts import', "import {decodePayload} from '../../contracts/src/protocol-v0';", ['runtime contracts import ../../contracts/src/protocol-v0']],
      ['an escape from the allowed modules', "import type {LiveTelemetry} from '../../../apps/desktop/src/live-state';", ['import outside the allowed modules ../../../apps/desktop/src/live-state']],
      ['a runtime storage API import', "import {MAX_EFFECTS} from '../../storage/src/api';", ['runtime storage import ../../storage/src/api']],
      ['a runtime storage API re-export', "export {ACCEPTED_ORIGIN} from '../../storage/src/api.ts';", ['runtime storage import ../../storage/src/api.ts']],
      ['a type import of another storage module', "import type {Storage} from '../../storage/src/index';", ['import outside the allowed modules ../../storage/src/index']],
      ['a type import of the storage directory', "import type {TripEffect} from '../../storage/src';", ['import outside the allowed modules ../../storage/src']],
      ['a type import of the SQLite core', "import type {StorageConnection} from '../../storage/src/sqlite/connection';", ['import outside the allowed modules ../../storage/src/sqlite/connection']],
      ['a dynamic import', "const m = await import('./units');", ['dynamic import()']],
      ['require', "const fs = require('fs');", ['Node global require']],
      ['process', 'const home = process.env.HOME;', ['Node global process']],
      ['Buffer', "const b = Buffer.from('x');", ['Node global Buffer']],
      ['__dirname and __filename', 'const here = [__dirname, __filename];', ['Node global __dirname', 'Node global __filename']],
      ['global', 'const g = global;', ['Node global global']],
      ['a triple-slash reference', '/// <reference types="node" />\nexport const x = 1;', ['triple-slash reference']],
      ['a global inside a template interpolation', 'const home = `${process.env.HOME}`;', ['Node global process']],
      ['a global inside a nested template', 'const t = `a${`b${Buffer.from("x").length}`}c`;', ['Node global Buffer']],
      ['code after a template interpolation', 'const t = `a${1}b`; const g = global;', ['Node global global']],
      ['globalThis', 'const env = globalThis.process.env;', ['Node global globalThis']],
      ['setImmediate and clearImmediate', 'clearImmediate(setImmediate(() => 0));', ['Node global clearImmediate', 'Node global setImmediate']],
      ['a global after a regex literal containing quotes', "const quote = /['\"]/;\nconst env = process.env;", ['Node global process']],
      ['a global after a regex with a slash in a class', "const re = /[/'`]+/g.test(x); const b = Buffer;", ['Node global Buffer']],
      ['an import after a regex literal containing a quote', "export const re = /'/;\nimport {readFileSync} from 'node:fs';", ['package import node:fs']]
    ])('%s', (_name, source, expected) => expect(violations(source, at)).toEqual(expected));
    it('ignores the same words in comments, strings, template text, regex literals and property names', () => {
      const source = "// import x from 'node:fs'; process.env\n/* require('fs') */\nconst text = 'process Buffer global';\nconst o = {processInstanceId: 1};\n" +
        'void o.process;\nconst t = `process ${o.processInstanceId} global`;\nconst re = /process|global/;\nconst half = o.processInstanceId / 2 / 1;';
      expect(violations(source, at)).toEqual([]);
    });
    it('allows type-only contracts imports and own modules', () => {
      expect(violations("import type {CurrentState} from '../../contracts/src/protocol-v0';\nimport {fixed} from './format';", at)).toEqual([]);
    });
    it('allows a type-only import of exactly the storage API', () => {
      expect(violations("import type {TripEffect} from '../../storage/src/api';\nexport type {RecordingCompleteness} from '../../storage/src/api.ts';", at)).toEqual([]);
      expect(violations("import type {TripEffect} from '../../../storage/src/api';", join(coreDir, 'trips', 'probe.ts'))).toEqual([]);
    });
  });
});
