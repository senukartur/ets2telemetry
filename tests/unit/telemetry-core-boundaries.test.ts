// telemetry-core is pure TypeScript shared by renderer and service code. It may import only its own modules and
// type-only declarations from packages/contracts/src; Node.js, Electron, React and any runtime package are forbidden.
// This test replaces a lint-config rule (decision N16), so tools/lint stays unchanged.
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const coreDir = resolve('packages/telemetry-core/src');
const contractsDir = resolve('packages/contracts/src');
const files = readdirSync(coreDir, {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.ts')).map(file => join(coreDir, file));
const STATIC = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE = /\bimport\s+['"]([^'"]+)['"]/g;
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

interface Specifier {file: string; specifier: string; typeOnly: boolean}
function specifiers(file: string): Specifier[] {
  const source = readFileSync(file, 'utf8');
  const found: Specifier[] = [];
  for (const match of source.matchAll(STATIC)) found.push({file, specifier: match[4], typeOnly: match[2] !== undefined});
  for (const match of source.matchAll(BARE)) found.push({file, specifier: match[1], typeOnly: false});
  return found;
}
function violations(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const problems: string[] = [];
  if (/\bimport\s*\(/.test(source)) problems.push('dynamic import()');
  if (/\brequire\s*\(/.test(source)) problems.push('require()');
  for (const {specifier, typeOnly} of specifiers(file)) {
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
    const all = files.flatMap(specifiers).map(({specifier, typeOnly}) => `${typeOnly ? 'type ' : ''}${specifier}`);
    expect(all).toContain('type ../../contracts/src/protocol-v0');
    expect(all).toContain('type ../../contracts/src/protocol-v1');
    expect(all).toContain('type ../../contracts/src');
    expect(all).toContain('./units');
  });
  it.each(files.map(file => [relative(coreDir, file), file]))('%s imports only telemetry-core modules and contracts types', (_name, file) => {
    expect(violations(file)).toEqual([]);
  });
  it('detects forbidden imports', () => {
    const probe = (source: string) => {
      const problems: string[] = [];
      for (const match of source.matchAll(STATIC)) if (!match[4].startsWith('.')) problems.push(match[4]);
      for (const match of source.matchAll(BARE)) problems.push(match[1]);
      return problems;
    };
    expect(probe("import {readFileSync} from 'node:fs';")).toEqual(['node:fs']);
    expect(probe("import {\n  ipcRenderer\n} from 'electron';")).toEqual(['electron']);
    expect(probe("export {useState} from 'react';")).toEqual(['react']);
    expect(probe("import 'node:path';")).toEqual(['node:path']);
  });
});
