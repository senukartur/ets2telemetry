// telemetry-core is pure TypeScript shared by renderer and service code. It may import only its own modules and
// type-only declarations from packages/contracts/src. Node.js, Electron, React, any runtime package, Node globals and
// triple-slash type references are forbidden. This test replaces a lint-config rule (decision N16), so tools/lint and
// the root tsconfig stay unchanged.
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const coreDir = resolve('packages/telemetry-core/src');
const contractsDir = resolve('packages/contracts/src');
const files = readdirSync(coreDir, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.ts')).map(file => join(coreDir, file));
const STATIC = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE = /\bimport\s+['"]([^'"]+)['"]/g;
const NODE_GLOBAL = /(?<![\w$.])(process|Buffer|__dirname|__filename|global|require)(?![\w$])/g;
const TRIPLE_SLASH = /^\s*\/\/\/\s*<reference\b/m;
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/**
 * Removes comments, and optionally the contents of string and template literals, so that prose and quoted text cannot
 * hide or fake an import or a global.
 */
function strip(source: string, strings: boolean): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; out += ' '; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      out += strings ? c + c : source.slice(i, j + 1);
      i = j + 1;
      continue;
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
    problems.push(inside(target, contractsDir) ? `runtime contracts import ${specifier}` : `import outside the allowed modules ${specifier}`);
  }
  return problems;
}

describe('telemetry-core import boundary', () => {
  it('finds the expected modules and their imports', () => {
    const names = files.map(file => relative(coreDir, file).split(sep).join('/')).sort();
    expect(names).toEqual(['derived.ts', 'display-profile.ts', 'format.ts', 'index.ts', 'live-view.ts', 'normalize-v0.ts', 'normalize-v1.ts', 'readings.ts', 'units.ts']);
    const all = files.flatMap(file => specifiers(readFileSync(file, 'utf8'))).map(({specifier, typeOnly}) => `${typeOnly ? 'type ' : ''}${specifier}`);
    expect(all).toContain('type ../../contracts/src/protocol-v0');
    expect(all).toContain('type ../../contracts/src/protocol-v1');
    expect(all).toContain('type ../../contracts/src');
    expect(all).toContain('./units');
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
      ['a dynamic import', "const m = await import('./units');", ['dynamic import()']],
      ['require', "const fs = require('fs');", ['Node global require']],
      ['process', 'const home = process.env.HOME;', ['Node global process']],
      ['Buffer', "const b = Buffer.from('x');", ['Node global Buffer']],
      ['__dirname and __filename', 'const here = [__dirname, __filename];', ['Node global __dirname', 'Node global __filename']],
      ['global', 'const g = global;', ['Node global global']],
      ['a triple-slash reference', '/// <reference types="node" />\nexport const x = 1;', ['triple-slash reference']]
    ])('%s', (_name, source, expected) => expect(violations(source, at)).toEqual(expected));
    it('ignores the same words in comments, strings and property names', () => {
      const source = "// import x from 'node:fs'; process.env\n/* require('fs') */\nconst text = 'process Buffer global';\nconst o = {processInstanceId: 1};\nvoid o.process;";
      expect(violations(source, at)).toEqual([]);
    });
    it('allows type-only contracts imports and own modules', () => {
      expect(violations("import type {CurrentState} from '../../contracts/src/protocol-v0';\nimport {fixed} from './format';", at)).toEqual([]);
    });
  });
});
