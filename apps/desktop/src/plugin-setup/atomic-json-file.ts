import {randomUUID} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

// Atomic replacement of one small file in an application-owned folder (ET-017 P9; docs/plugin-setup.md, "Install
// registry"). It mirrors the settings save (docs/settings.md, "Saving"): the folder and the file must not be links,
// stale temporary files of this file's own pattern are removed, the new content goes to a new temporary file created
// with `wx`, which is synced, closed and renamed over the file with five retries on EPERM, EACCES or EBUSY. A failure
// removes the temporary file and leaves the previous file as it was. Reading never writes.

/** Delays before each retry of the final rename; five retries within 300 ms, as for settings.json. */
export const ATOMIC_RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([20, 40, 60, 80, 100]);
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

interface AtomicStats {isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean}
interface AtomicFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The file operations used here; `node:fs/promises` satisfies it, and tests wrap it to inject failures. */
export interface AtomicFileSystem {
  lstat(target: string): Promise<AtomicStats>;
  open(target: string, flags: 'r' | 'wx'): Promise<AtomicFileHandle>;
  mkdir(target: string, options: {recursive: true}): Promise<unknown>;
  readdir(target: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}
export const nodeAtomicFs: AtomicFileSystem = nodeFs;

export const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/** A failed write with the step that failed and the error code; never a path. */
export class AtomicFileError extends Error {
  constructor(readonly step: string, readonly code: string | null) {
    super(`Atomic file write failed at ${step}`);
    this.name = 'AtomicFileError';
  }
}

export type EntryState = 'present' | 'absent' | 'reparse-point' | 'not-file' | 'not-directory' | 'stat';
/** lstat without following links: a symbolic link or junction is reported, never read or written through. */
export async function inspectEntry(fs: AtomicFileSystem, target: string, kind: 'file' | 'directory'): Promise<EntryState> {
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink()) return 'reparse-point';
    if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return kind === 'file' ? 'not-file' : 'not-directory';
    return 'present';
  } catch (error) {return errorCode(error) === 'ENOENT' ? 'absent' : 'stat';}
}

export type AtomicRead = {readonly state: 'absent'} | {readonly state: 'present'; readonly bytes: Uint8Array}
  | {readonly state: 'unreadable'; readonly reason: Exclude<EntryState, 'present' | 'absent'> | 'read'};

/**
 * Reads `directory\name` when both are plain (not links) and returns at most `limit + 1` bytes, so an oversized file is
 * classified without reading it all. A missing folder or file is `absent`.
 */
export async function readAtomicFile(fs: AtomicFileSystem, directory: string, name: string, limit: number): Promise<AtomicRead> {
  const folder = await inspectEntry(fs, directory, 'directory');
  if (folder === 'absent') return {state: 'absent'};
  if (folder !== 'present') return {state: 'unreadable', reason: folder};
  const file = path.win32.join(directory, name);
  const entry = await inspectEntry(fs, file, 'file');
  if (entry === 'absent') return {state: 'absent'};
  if (entry !== 'present') return {state: 'unreadable', reason: entry};
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = new Uint8Array(limit + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const {bytesRead} = await handle.read(buffer, length, buffer.byteLength - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return {state: 'present', bytes: buffer.subarray(0, length)};
    } finally {await handle.close();}
  } catch {return {state: 'unreadable', reason: 'read'};}
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The pattern of this module's own temporary files for `name`: `<name>.<pid>.<uuid>.tmp`. */
export function temporaryPattern(name: string): RegExp {
  return new RegExp(`^${escape(name)}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`);
}

export interface AtomicWriteOptions {
  /** Waits between rename retries. */
  delay?: (milliseconds: number) => Promise<void>;
  /** Called with the rejected file's new name when `quarantine` moved it aside. */
  quarantined?: (name: string) => void;
  /** Moves the present file aside first, byte-identically, as `<prefix><UTC>.json`, keeping the newest `keep`. */
  quarantine?: {prefix: string; keep: number; now: () => Date};
}

const defaultDelay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/**
 * Writes `content` to `directory\name` atomically: creates the folder if needed and checks again that it is a plain
 * folder, removes stale temporary files of the own pattern, optionally quarantines the present file, writes a new
 * temporary file with `wx`, syncs and closes it, and renames it over the file. Throws AtomicFileError.
 */
export async function writeAtomicFile(fs: AtomicFileSystem, directory: string, name: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const delay = options.delay ?? defaultDelay;
  const target = path.win32.join(directory, name);
  let temporary: string | undefined;
  let step = 'directory';
  try {
    await fs.mkdir(directory, {recursive: true});
    if (await inspectEntry(fs, directory, 'directory') !== 'present') throw new AtomicFileError('directory', 'ENOTDIR');
    step = 'cleanup';
    const pattern = temporaryPattern(name);
    for (const entry of await fs.readdir(directory)) {
      if (pattern.test(entry)) await fs.unlink(path.win32.join(directory, entry)).catch(() => undefined);
    }
    step = 'target';
    const existing = await inspectEntry(fs, target, 'file');
    if (existing !== 'present' && existing !== 'absent') throw new AtomicFileError('target', existing);
    if (options.quarantine && existing === 'present') {
      step = 'quarantine';
      const moved = await quarantine(fs, directory, target, options.quarantine, delay);
      options.quarantined?.(moved);
    }
    step = 'temporary';
    temporary = path.win32.join(directory, `${name}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try {
      step = 'write';
      await handle.writeFile(content, 'utf8');
      step = 'sync';
      await handle.sync();
    } finally {await handle.close();}
    step = 'rename';
    await renameWithRetry(fs, temporary, target, delay);
    temporary = undefined;
  } catch (error) {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
    if (error instanceof AtomicFileError) throw error;
    throw new AtomicFileError(step, errorCode(error) ?? null);
  }
}

async function renameWithRetry(fs: AtomicFileSystem, from: string, to: string, delay: (milliseconds: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {await fs.rename(from, to); return;}
    catch (error) {
      // Antivirus scanners and indexers briefly hold new files open on Windows.
      const code = errorCode(error);
      if (attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME.has(code)) throw error;
      await delay(ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Renames the file unchanged to `<prefix><yyyymmddThhmmssZ>[-n].json` and keeps the newest `keep` such files. */
async function quarantine(fs: AtomicFileSystem, directory: string, target: string, rule: NonNullable<AtomicWriteOptions['quarantine']>,
  delay: (milliseconds: number) => Promise<void>): Promise<string> {
  const stamp = rule.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let name: string | undefined;
  for (let suffix = 1; suffix <= 100 && !name; suffix++) {
    const candidate = `${rule.prefix}${stamp}${suffix === 1 ? '' : `-${suffix}`}.json`;
    if (await inspectEntry(fs, path.win32.join(directory, candidate), 'file') === 'absent') name = candidate;
  }
  if (!name) throw new AtomicFileError('quarantine', 'EEXIST');
  await renameWithRetry(fs, target, path.win32.join(directory, name), delay);
  const pattern = new RegExp(`^${escape(rule.prefix)}(\\d{8}T\\d{6}Z)(?:-(\\d+))?\\.json$`);
  const rejected = (await fs.readdir(directory)).flatMap(file => {
    const match = pattern.exec(file);
    return match ? [{file, stamp: match[1], suffix: match[2] ? Number(match[2]) : 1}] : [];
  }).sort((left, right) => left.stamp === right.stamp ? right.suffix - left.suffix : left.stamp < right.stamp ? 1 : -1);
  for (const old of rejected.slice(rule.keep)) await fs.unlink(path.win32.join(directory, old.file)).catch(() => undefined);
  return name;
}
