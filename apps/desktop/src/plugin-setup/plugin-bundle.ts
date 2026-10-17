import {createHash} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {VerifiedPluginBundle} from './plugin-installer';

// The runtime reader of the bundled plugin (ET-017 P5; docs/plugin-setup.md, "Runtime reading"). Main reads the bundle
// once per application run: the manifest (at most 64 KiB, strict keys) and the DLL (at most 16 MiB, a regular file that
// is not a link, an x64 PE DLL), hashes the DLL in memory and hands only that verified buffer to the installer. The DLL
// is never read again for an install. The checks mirror scripts/plugin-bundle.mjs, which verifies the same bundle at
// packaging time.

export const PLUGIN_BUNDLE_FORMAT = 'ets2telemetry.plugin-bundle';
export const PLUGIN_BUNDLE_FILE = 'ets2telemetry-plugin.dll';
export const PLUGIN_BUNDLE_MANIFEST = 'plugin-manifest.json';
export const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024;
export const MAX_BUNDLE_PLUGIN_BYTES = 16 * 1024 * 1024;
const MIN_PLUGIN_BYTES = 64;
const MAX_KNOWN = 256;
const MAX_SOURCES = 1024;
const MANIFEST_KEYS = ['appVersion', 'file', 'format', 'known', 'pluginSources', 'sha256', 'size', 'version'];
const HASH = /^[0-9a-f]{64}$/;
const APP_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
const SOURCE_KEY = /^native\/telemetry-plugin\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * Where the bundle is: `resources\telemetry-plugin` beside the packaged application, or the staged
 * `<repository>\.local\package-native\telemetry-plugin` that `npm run build` writes in development. `mainDirectory` is
 * the folder of the built main script (`apps\desktop\dist`).
 */
export function pluginBundleDirectory(mainDirectory: string, resourcesPath: string, packaged: boolean): string {
  return packaged ? path.join(resourcesPath, 'telemetry-plugin') : path.resolve(mainDirectory, '../../../.local/package-native/telemetry-plugin');
}

/** A verified bundle and, for main only, its DLL's location (for "Show plugin file"); never sent to a renderer. */
export interface LoadedPluginBundle extends VerifiedPluginBundle {readonly file: string}
/** Why the bundle could not be used; a fixed code for the PLUGIN_BUNDLE_UNAVAILABLE log line, never a path. */
export type PluginBundleFailure = 'directory' | 'contents' | 'manifest-unreadable' | 'manifest-invalid' | 'plugin-unreadable' | 'plugin-not-file'
  | 'plugin-size' | 'plugin-hash' | 'plugin-not-x64-dll' | 'aborted';
export type PluginBundleResult = {readonly ok: true; readonly bundle: LoadedPluginBundle}
  | {readonly ok: false; readonly code: 'BUNDLE_UNAVAILABLE'; readonly failure: PluginBundleFailure};

interface BundleStats {isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: bigint; dev: bigint; ino: bigint}
interface BundleHandle {
  stat(options: {bigint: true}): Promise<BundleStats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
  close(): Promise<void>;
}
/** The read operations the bundle reader uses; `node:fs/promises` satisfies it. */
export interface BundleFileSystem {
  lstat(target: string, options: {bigint: true}): Promise<BundleStats>;
  readdir(target: string): Promise<string[]>;
  open(target: string, flags: 'r'): Promise<BundleHandle>;
}
const nodeBundleFs: BundleFileSystem = nodeFs;

class BundleRefusal extends Error {constructor(readonly failure: PluginBundleFailure) {super(failure);}}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
};

/** Reads a regular, non-link file of at most `limit` bytes through one handle that is the file lstat saw. */
async function readBounded(fs: BundleFileSystem, target: string, limit: number, unreadable: PluginBundleFailure, signal?: AbortSignal): Promise<Buffer> {
  let before: BundleStats;
  try {before = await fs.lstat(target, {bigint: true});} catch {throw new BundleRefusal(unreadable);}
  if (before.isSymbolicLink() || !before.isFile()) throw new BundleRefusal(unreadable === 'plugin-unreadable' ? 'plugin-not-file' : 'manifest-invalid');
  if (before.size > BigInt(limit)) throw new BundleRefusal(unreadable === 'plugin-unreadable' ? 'plugin-size' : 'manifest-invalid');
  let handle: BundleHandle;
  try {handle = await fs.open(target, 'r');} catch {throw new BundleRefusal(unreadable);}
  try {
    const held = await handle.stat({bigint: true});
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino) throw new BundleRefusal(unreadable === 'plugin-unreadable' ? 'plugin-not-file' : 'manifest-invalid');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      if (signal?.aborted) throw new BundleRefusal('aborted');
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new BundleRefusal(unreadable === 'plugin-unreadable' ? 'plugin-size' : 'manifest-invalid');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof BundleRefusal) throw error;
    throw new BundleRefusal(unreadable);
  } finally {await handle.close().catch(() => undefined);}
}

interface Manifest {appVersion: string; size: number; sha256: string; known: {appVersion: string; sha256: string}[]}
/** Strict manifest parsing: exactly the eight keys of the bundle format, with valid values. */
export function parsePluginManifest(bytes: Uint8Array): Manifest | undefined {
  let value: unknown;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return undefined;}
  if (!isRecord(value) || !exactKeys(value, MANIFEST_KEYS)) return undefined;
  if (value.format !== PLUGIN_BUNDLE_FORMAT || value.version !== 1 || value.file !== PLUGIN_BUNDLE_FILE) return undefined;
  if (typeof value.appVersion !== 'string' || !APP_VERSION.test(value.appVersion)) return undefined;
  if (!Number.isSafeInteger(value.size) || (value.size as number) < MIN_PLUGIN_BYTES || (value.size as number) > MAX_BUNDLE_PLUGIN_BYTES) return undefined;
  if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) return undefined;
  if (!isRecord(value.pluginSources)) return undefined;
  const sources = Object.entries(value.pluginSources);
  if (!sources.length || sources.length > MAX_SOURCES) return undefined;
  if (!sources.every(([name, hash]) => SOURCE_KEY.test(name) && !name.split('/').some(part => part === '.' || part === '..') && typeof hash === 'string' && HASH.test(hash))) return undefined;
  if (!Array.isArray(value.known) || value.known.length > MAX_KNOWN) return undefined;
  const known: Manifest['known'] = [];
  for (const entry of value.known as unknown[]) {
    if (!isRecord(entry) || !exactKeys(entry, ['appVersion', 'sha256'])) return undefined;
    if (typeof entry.appVersion !== 'string' || !APP_VERSION.test(entry.appVersion) || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) return undefined;
    if (known.some(other => other.sha256 === entry.sha256)) return undefined;
    known.push({appVersion: entry.appVersion, sha256: entry.sha256});
  }
  return {appVersion: value.appVersion, size: value.size as number, sha256: value.sha256, known};
}

/** A Windows x64 DLL: the MZ header, the PE signature at e_lfanew, machine AMD64 (0x8664) and IMAGE_FILE_DLL. */
export function isX64Dll(bytes: Buffer): boolean {
  if (bytes.length < MIN_PLUGIN_BYTES || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < MIN_PLUGIN_BYTES || pe > bytes.length - 24) return false;
  return bytes.readUInt32LE(pe) === 0x4550 && bytes.readUInt16LE(pe + 4) === 0x8664 && (bytes.readUInt16LE(pe + 22) & 0x2000) !== 0;
}

/**
 * Reads and verifies the bundle in `directory`: the folder is not a link and holds exactly the DLL and its manifest; the
 * manifest is strict; the DLL's size and SHA-256 equal the manifest's and it is an x64 PE DLL. Any failure is
 * BUNDLE_UNAVAILABLE with a fixed failure code.
 */
export async function readPluginBundle(directory: string, options: {fs?: BundleFileSystem; signal?: AbortSignal} = {}): Promise<PluginBundleResult> {
  const fs = options.fs ?? nodeBundleFs;
  try {
    let folder: BundleStats;
    try {folder = await fs.lstat(directory, {bigint: true});} catch {throw new BundleRefusal('directory');}
    if (folder.isSymbolicLink() || !folder.isDirectory()) throw new BundleRefusal('directory');
    let names: string[];
    try {names = await fs.readdir(directory);} catch {throw new BundleRefusal('directory');}
    if ([...names].sort().join('\n') !== [PLUGIN_BUNDLE_FILE, PLUGIN_BUNDLE_MANIFEST].join('\n')) throw new BundleRefusal('contents');
    const manifest = parsePluginManifest(await readBounded(fs, path.join(directory, PLUGIN_BUNDLE_MANIFEST), MAX_BUNDLE_MANIFEST_BYTES, 'manifest-unreadable', options.signal));
    if (!manifest) throw new BundleRefusal('manifest-invalid');
    const file = path.join(directory, PLUGIN_BUNDLE_FILE);
    const bytes = await readBounded(fs, file, MAX_BUNDLE_PLUGIN_BYTES, 'plugin-unreadable', options.signal);
    if (bytes.length !== manifest.size) throw new BundleRefusal('plugin-size');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== manifest.sha256) throw new BundleRefusal('plugin-hash');
    if (!isX64Dll(bytes)) throw new BundleRefusal('plugin-not-x64-dll');
    // A private copy, so nothing that held the read buffer can change the bytes the installer writes.
    return {ok: true, bundle: Object.freeze({bytes: new Uint8Array(bytes), sha256, appVersion: manifest.appVersion, known: Object.freeze(manifest.known.map(entry => Object.freeze(entry))), file})};
  } catch (error) {
    if (error instanceof BundleRefusal) return {ok: false, code: 'BUNDLE_UNAVAILABLE', failure: options.signal?.aborted ? 'aborted' : error.failure};
    return {ok: false, code: 'BUNDLE_UNAVAILABLE', failure: options.signal?.aborted ? 'aborted' : 'plugin-unreadable'};
  }
}
