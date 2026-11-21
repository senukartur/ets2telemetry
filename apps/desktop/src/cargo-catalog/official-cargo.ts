import {basename, isAbsolute, posix} from 'node:path';
import {withHashFs} from './hashfs';

export type OfficialCargoDefinition = Readonly<{
  fragility: number | null;
  valuable: boolean | null;
  adrClass: number | null;
  overweight: boolean | null;
  oversize: boolean | null;
  groups: readonly string[];
}>;

export interface OfficialCargoCatalog {
  readonly definitions: ReadonlyMap<string, OfficialCargoDefinition>;
  readonly conflicts: ReadonlySet<string>;
}

const MAX_ARCHIVES = 256;
const MAX_REGISTRIES = 64;
const MAX_INCLUDE_DEPTH = 8;
const MAX_FILES = 4096;
const MAX_SOURCE_CHARS = 16 * 1024 * 1024;
const MAX_TOKENS = 1_000_000;
const MAX_CARGO_IDS = 4096;
const MAX_GROUPS = 64;
const sourceName = /^(?:def|dlc_[a-z0-9_]+)\.scs$/;
const registryName = /^cargo(?:\.[a-z0-9_]+)?\.sii$/;
const cargoUnitId = /^cargo\.([A-Za-z0-9_][A-Za-z0-9_.]{0,127})$/;
const fieldName = /^[a-z_][a-z0-9_]*$/;
const groupToken = /^[a-z][a-z0-9_]{0,31}$/;
const fields = new Set(['fragility', 'valuable', 'adr_class', 'overweight', 'oversize', 'group']);

function unsupported(): never {
  throw new Error('Invalid or unsupported official cargo definitions');
}

function localAbsolute(path: string) {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path)) return false;
  // Windows rooted-relative paths and device namespaces do not prove a local drive.
  return process.platform !== 'win32' || /^[a-z]:[\\/](?![\\/])/i.test(path) && !path.slice(2).includes(':');
}

function tokensIn(source: string) {
  const matcher = /\s+|\/\/[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\r\n]|\\[^\r\n])*"|@include|[{}:[\]]|(?:[^\s{}:[\]"#/]|\/(?![/*]))+/y;
  const tokens: string[] = [];
  while (matcher.lastIndex < source.length) {
    const token = matcher.exec(source)?.[0];
    if (!token) unsupported();
    if (/^\s|^#|^\/[/*]/.test(token)) continue;
    if (tokens.length === MAX_TOKENS) unsupported();
    tokens.push(token);
  }
  if (tokens[0] !== 'SiiNunit') return tokens;
  if (tokens[1] !== '{' || tokens.at(-1) !== '}') unsupported();
  return tokens.slice(2, -1);
}

function includePath(parent: string, token: string | undefined) {
  if (!token || !/^"\/?[a-z0-9_.]+(?:\/[a-z0-9_.]+)*\.(?:sii|sui)"$/i.test(token)) unsupported();
  const relative = token.slice(1, -1);
  const path = relative.startsWith('/') ? relative.slice(1) : posix.join(posix.dirname(parent), relative);
  if (!path.startsWith('def/cargo/') || path.length > 256 || relative.split('/').some(part => part === '..' || part === '.')) unsupported();
  return path;
}

type ReadBudget = {files: number; chars: number; tokens: number};

class ArchiveDefinitions {
  constructor(
    private readonly readText: (path: string) => Promise<string | undefined>,
    private readonly budget: ReadBudget,
  ) {}

  async expand(path: string, output: string[], ancestors: readonly string[] = []) {
    if (ancestors.length >= MAX_INCLUDE_DEPTH || ancestors.includes(path) || ++this.budget.files > MAX_FILES) unsupported();
    const text = await this.readText(path);
    if (text === undefined) unsupported();
    this.budget.chars += text.length;
    if (this.budget.chars > MAX_SOURCE_CHARS) unsupported();
    const tokens = tokensIn(text);
    this.budget.tokens += tokens.length;
    if (this.budget.tokens > MAX_TOKENS) unsupported();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '@include') {
        await this.expand(includePath(path, tokens[++i]), output, [...ancestors, path]);
      } else {
        output.push(tokens[i]);
      }
    }
  }
}

type Field = Readonly<{name: string; index?: string; end: number}>;

function fieldAt(tokens: string[], start: number): Field | undefined {
  const name = tokens[start];
  if (!name || !fieldName.test(name)) return undefined;
  if (tokens[start + 1] === ':') return {name, end: start + 2};
  if (tokens[start + 1] !== '[') return undefined;
  if (tokens[start + 2] === ']' && tokens[start + 3] === ':') return {name, index: '', end: start + 4};
  if (tokens[start + 3] === ']' && tokens[start + 4] === ':') return {name, index: tokens[start + 2], end: start + 5};
  return undefined;
}

function uint(token: string, max: number) {
  const value = Number(token);
  if (!/^(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(value) || value > max) unsupported();
  return value;
}

function asBoolean(token: string) {
  if (token !== 'true' && token !== 'false') unsupported();
  return token === 'true';
}

function asFragility(token: string) {
  let value: number;
  if (/^&[a-f0-9]{8}$/i.test(token)) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(Number.parseInt(token.slice(1), 16));
    value = bytes.readFloatBE();
  } else {
    if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(token)) unsupported();
    value = Number(token);
  }
  if (!Number.isFinite(value) || value < 0) unsupported();
  return value;
}

class CargoFields {
  private readonly scalars = new Map<string, string>();
  private readonly groupValues = new Map<number, string>();
  private groupMode: 'indexed' | 'append' | undefined;

  add({name, index}: Field, token: string) {
    if (index === undefined) {
      if (this.scalars.has(name)) unsupported();
      this.scalars.set(name, token);
      return;
    }
    if (name !== 'group' || !groupToken.test(token) || this.groupValues.size === MAX_GROUPS) unsupported();
    const mode = index === '' ? 'append' : 'indexed';
    if (this.groupMode && this.groupMode !== mode) unsupported();
    this.groupMode = mode;
    const position = index === '' ? this.groupValues.size : uint(index, MAX_GROUPS - 1);
    if (this.groupValues.has(position)) unsupported();
    this.groupValues.set(position, token);
  }

  result(): OfficialCargoDefinition {
    const count = this.scalars.get('group');
    if (count !== undefined) {
      const expected = uint(count, MAX_GROUPS);
      if (this.groupValues.size !== expected || [...this.groupValues.keys()].some(index => index >= expected)) unsupported();
    }
    const fragility = this.scalars.get('fragility'), adrClass = this.scalars.get('adr_class');
    const flag = (name: string) => {
      const value = this.scalars.get(name);
      return value === undefined ? null : asBoolean(value);
    };
    return {
      fragility: fragility === undefined ? null : asFragility(fragility),
      valuable: flag('valuable'),
      adrClass: adrClass === undefined ? null : uint(adrClass, 0xffffffff),
      overweight: flag('overweight'),
      oversize: flag('oversize'),
      groups: [...new Set(this.groupValues.values())].sort(),
    };
  }
}

function nextFieldOrUnitEnd(tokens: string[], start: number) {
  let at = start;
  while (at < tokens.length && tokens[at] !== '}' && !fieldAt(tokens, at)) {
    if (tokens[at] === '{') unsupported();
    at++;
  }
  return at;
}

function* parseUnits(tokens: string[]): Generator<[string, OfficialCargoDefinition]> {
  let at = 0;
  while (at < tokens.length) {
    const type = tokens[at++], separator = tokens[at++], unit = tokens[at++], opening = tokens[at++];
    const match = type === 'cargo_data' ? cargoUnitId.exec(unit ?? '') : undefined;
    if (!fieldName.test(type) || separator !== ':' || !unit || opening !== '{' || (type === 'cargo_data' && !match)) unsupported();
    const properties = new CargoFields();
    while (tokens[at] !== '}') {
      const field = fieldAt(tokens, at);
      if (!field) unsupported();
      at = nextFieldOrUnitEnd(tokens, field.end);
      if (at === field.end) unsupported();
      if (match && fields.has(field.name)) {
        if (at !== field.end + 1) unsupported();
        properties.add(field, tokens[field.end]);
      }
    }
    at++;
    if (match) yield [match[1], properties.result()];
  }
}

function sameDefinition(a: OfficialCargoDefinition, b: OfficialCargoDefinition) {
  return a.fragility === b.fragility && a.valuable === b.valuable && a.adrClass === b.adrClass
    && a.overweight === b.overweight && a.oversize === b.oversize
    && a.groups.length === b.groups.length && a.groups.every((group, i) => group === b.groups[i]);
}

/**
 * The caller supplies the trusted inventory for one installation. The reader
 * never scans mod folders or infers Steam ownership from a file's basename.
 */
export async function readOfficialCargoCatalog(paths: readonly string[], signal?: AbortSignal): Promise<OfficialCargoCatalog> {
  if (paths.length > MAX_ARCHIVES || new Set(paths).size !== paths.length) unsupported();
  const names = paths.map(path => basename(path));
  if (!names.includes('def.scs') || new Set(names).size !== names.length
    || paths.some(path => !localAbsolute(path)) || names.some(name => !sourceName.test(name))) unsupported();
  const definitions = new Map<string, OfficialCargoDefinition>(), conflicts = new Set<string>();
  const budget: ReadBudget = {files: 0, chars: 0, tokens: 0};
  const record = (id: string, value: OfficialCargoDefinition) => {
    if (conflicts.has(id)) return;
    const previous = definitions.get(id);
    if (!previous) {
      if (definitions.size + conflicts.size === MAX_CARGO_IDS) unsupported();
      definitions.set(id, value);
    } else if (!sameDefinition(previous, value)) {
      definitions.delete(id);
      conflicts.add(id);
    }
  };
  for (const [index, path] of paths.entries()) {
    await withHashFs(path, async archive => {
      const listing = await archive.list('def');
      const namesInArchive = (listing ?? [])
        .filter(entry => !entry.directory && registryName.test(entry.name))
        .map(entry => entry.name);
      if (names[index] === 'def.scs' && !namesInArchive.includes('cargo.sii')) unsupported();
      if (namesInArchive.length > MAX_REGISTRIES) unsupported();
      // Official registries in the observed base and DLC packs include definitions in the
      // same pack. An unresolved include fails closed without guessing mount precedence.
      const reader = new ArchiveDefinitions(file => archive.text(file), budget);
      for (const name of namesInArchive) {
        const tokens: string[] = [];
        await reader.expand('def/' + name, tokens);
        for (const [id, value] of parseUnits(tokens)) record(id, value);
      }
    }, signal);
  }
  return {definitions, conflicts};
}
