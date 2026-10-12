import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Exported CAP0 evidence never contains the identifier mapping; tokens are stable within one export only. */
export const EXPORT_FORMAT = 'ets2telemetry-cap0-export';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKETS_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Windows extended, UNC and drive paths anywhere in a string. A match runs to the end of the
// path-like text (spaces included), so redaction errs towards removing trailing context.
const EMBEDDED_PATH = /(?:\\\\\?\\|\\\\[^\\\s"'<>|]+\\|(?<![A-Za-z0-9])[A-Za-z]:[\\/])[^"'<>|\r\n\t]*/g;
// User-profile fragments that survive outside a full path, for example "..\Users\name\".
const USER_FRAGMENT = /([\\/])(Users|home|Documents and Settings)([\\/])([^\\/"'<>|\r\n\t]+)/gi;
/** JSON text that keeps -0 exactly; JSON.stringify would write it as 0. */
export function stringify(value: Json): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type Category = 'uuid' | 'processId' | 'windowsSessionId' | 'processCreationTime' | 'userTag' | 'path' | 'user' | 'displayId';

/**
 * Replaces identifiers and local paths with first-appearance tokens. Equal inputs map to equal tokens and
 * token order follows first appearance, so equality and ordering relationships survive. UTC receipt
 * labels are rebased to the capture start; monotonic clocks, sequence numbers and game data are kept.
 */
export class Sanitizer {
  private readonly maps = new Map<Category, Map<string, string>>();
  constructor(private readonly utcBase: bigint) {}
  counts(): Record<Category, number> {
    const categories: Category[] = ['uuid', 'processId', 'windowsSessionId', 'processCreationTime', 'userTag', 'path', 'user', 'displayId'];
    return Object.fromEntries(categories.map(category => [category, this.maps.get(category)?.size ?? 0])) as Record<Category, number>;
  }
  private token(category: Category, value: string, make: (index: number) => string): string {
    let map = this.maps.get(category); if (!map) this.maps.set(category, map = new Map<string, string>());
    let token = map.get(value); if (token === undefined) map.set(value, token = make(map.size + 1)); return token;
  }
  value(input: Json, key = '', parent = ''): Json {
    if (Array.isArray(input)) return input.map(item => this.value(item, key, parent));
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, this.value(value, name, key)]));
    if (typeof input === 'number' && (key === 'processId' || key === 'windowsSessionId')) return Number(this.token(key, String(input), index => String(index)));
    if (typeof input !== 'string') return input;
    if (key === 'utcUnixMs' || key === 'startedUtcUnixMs' || key === 'stoppedUtcUnixMs') return /^(0|[1-9][0-9]*)$/.test(input) ? (BigInt(input) - this.utcBase).toString() : input;
    if (key === 'processCreationTime') return this.token('processCreationTime', input, index => String(index));
    if (key === 'userTag') return this.token('userTag', input, index => index.toString(16).padStart(64, '0'));
    if (key === 'id' && parent === 'displays') return this.token('displayId', input, index => String(index));
    if (UUID.test(input)) return this.token('uuid', input, index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
    if (key === 'path') return this.token('path', input, index => `redacted-path-${index}`);
    return input.replace(EMBEDDED_PATH, path => this.token('path', path, index => `redacted-path-${index}`))
      .replace(USER_FRAGMENT, (_match, before: string, folder: string, after: string, name: string) => `${before}${folder}${after}${this.token('user', name, index => `redacted-user-${index}`)}`);
  }
}
async function bounded(filename: string, limit: number): Promise<Buffer> {
  const bytes = await readFile(filename); if (bytes.length > limit) throw new Error(`${path.basename(filename)} exceeds export bound`); return bytes;
}
export interface ExportResult {outputDirectory: string; packets: number; counts: Record<Category, number>; files: {name: string; bytes: number; sha256: string}[]}
/** Verifies a raw capture against its manifest, then writes a sanitized copy into a new directory. */
export async function exportCapture(captureDirectory: string, outputDirectory: string): Promise<ExportResult> {
  if (!path.isAbsolute(captureDirectory) || !path.isAbsolute(outputDirectory)) throw new Error('Export paths must be absolute');
  const manifest = JSON.parse((await bounded(path.join(captureDirectory, 'manifest.json'), MAX_MANIFEST_BYTES)).toString('utf8')) as {[key: string]: Json};
  const files = manifest.files as {name: string; bytes: number; sha256: string}[] | undefined;
  if (manifest.format !== 'ets2telemetry-cap0-capture-manifest' || manifest.schemaVersion !== 1 || !Array.isArray(files) || files.length !== 1 || files[0].name !== 'packets.ndjson') throw new Error('Unsupported capture manifest');
  const raw = await bounded(path.join(captureDirectory, 'packets.ndjson'), MAX_PACKETS_BYTES);
  if (raw.length !== files[0].bytes || sha256(raw) !== files[0].sha256) throw new Error('Capture packets do not match their manifest');
  const timing = manifest.timing as {startedUtcUnixMs?: string} | undefined;
  if (!timing || typeof timing.startedUtcUnixMs !== 'string' || !/^(0|[1-9][0-9]*)$/.test(timing.startedUtcUnixMs)) throw new Error('Capture manifest timing missing');
  const sanitizer = new Sanitizer(BigInt(timing.startedUtcUnixMs));
  const sanitizedManifest = sanitizer.value(manifest) as {[key: string]: Json};
  const lines = raw.toString('utf8').split('\n'); if (lines.pop() !== '') throw new Error('Capture packets file is not newline terminated');
  const packets = lines.map(line => stringify(sanitizer.value(JSON.parse(line) as Json))).join('\n') + (lines.length ? '\n' : '');
  const output = Buffer.from(packets);
  sanitizedManifest.files = [{name: 'packets.ndjson', bytes: output.length, sha256: sha256(output)}];
  sanitizedManifest.sanitized = true;
  const manifestText = JSON.stringify(sanitizedManifest, null, 2) + '\n';
  const exportRecord = {format: EXPORT_FORMAT, schemaVersion: 1, rawIntegrityVerified: true, counts: sanitizer.counts(),
    rules: ['UUIDs, process IDs, Windows session IDs, process creation times, user tags, display IDs, local paths (including paths embedded in text) and user-profile folder names are replaced by first-appearance tokens',
      'UTC receipt labels are rebased to the capture start; monotonic clocks and sequences are unchanged; copied game data are unchanged except path-like text, which is redacted',
      'The identifier mapping is not written; raw captures stay local and are never uploaded automatically']};
  await mkdir(path.dirname(outputDirectory), {recursive: true}); await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, 'packets.ndjson'), output, {flag: 'wx'});
  await writeFile(path.join(outputDirectory, 'manifest.json'), manifestText, {flag: 'wx'});
  await writeFile(path.join(outputDirectory, 'export.json'), JSON.stringify(exportRecord, null, 2) + '\n', {flag: 'wx'});
  return {outputDirectory, packets: lines.length, counts: sanitizer.counts(), files: [{name: 'packets.ndjson', bytes: output.length, sha256: sha256(output)}, {name: 'manifest.json', bytes: Buffer.byteLength(manifestText), sha256: sha256(manifestText)}]};
}
