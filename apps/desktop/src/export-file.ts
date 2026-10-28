// Shared export file safety for main's Save-dialog exports (ET-016 J16, ET-017 P17): the trip export
// (journal-export-writer.ts) and the diagnostic bundle (diagnostic-bundle-writer.ts). A target inside the application's
// data directory `<LOCALAPPDATA>\ETS2Telemetry` or a device path is refused by name, by its real path and by file
// identity; the file is written as `<name>.<hex8>.partial` beside the target, synced, closed and renamed over it, and the
// partial file is removed after any failure, so an existing target is never left half written. Main process only.
// The refused data directories are the channel's `exportRefusalDataRootNames` (ET-055 UP12): in production only its own
// `ETS2Telemetry`, in staging `ETS2TelemetryStaging` and `ETS2Telemetry`, so "the data directory" below means each of them.
// Every check takes the folder names as its last argument, this build's list by default, so tests cover both channels.
import path from 'node:path';
import {CHANNEL} from './channel';

/** Delays before each retry of the final rename, as for settings saves: five retries within 300 ms. */
export const EXPORT_RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([20, 40, 60, 80, 100]);
/** Antivirus scanners and indexers briefly hold new files open on Windows. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** The Save dialog's only file type. */
export const EXPORT_DIALOG_FILTERS = Object.freeze([{name: 'JSON', extensions: ['json']}]);
/** Ancestors of the chosen folder compared with the data directory by file identity; a deeper folder is refused. */
export const EXPORT_ANCESTOR_LIMIT = 128;

export interface ExportFileHandle {writeFile(data: string, encoding: 'utf8'): Promise<void>; sync(): Promise<void>; close(): Promise<void>}
/** The file operations of an export; tests wrap the real ones to inject failures. */
export interface ExportFileSystem {
  open(target: string, flags: 'wx'): Promise<ExportFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  realpath(target: string): Promise<string>;
  stat(target: string, options: {bigint: true}): Promise<{dev: bigint; ino: bigint}>;
}
/** The step an export file write failed in, for the fixed log facts. */
export type ExportWriteStep = 'target' | 'open' | 'write' | 'sync' | 'close' | 'rename';

export const exportErrorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Strips Win32 extended-length file prefixes: maps `\\?\[A-Za-z]:` to `[A-Za-z]:` and `\\?\UNC\<server>\<share>` to
 * `\\<server>\<share>`. Non-file extended paths (`\\?\pipe\`, `\\?\Volume{...}`) and paths without extended prefixes
 * are returned unchanged.
 */
export function stripExtendedPrefix(target: string): string {
  if (target.startsWith('\\\\?\\')) {
    if (/^\\\\\?\\[A-Za-z]:/i.test(target)) {
      return target.slice(4);
    }
    const uncMatch = /^\\\\\?\\UNC\\([^\\?.\\][^\\]*\\.*)$/i.exec(target);
    if (uncMatch) {
      return `\\\\${uncMatch[1]}`;
    }
  }
  return target;
}

/**
 * A Windows path as Windows compares it: resolved, with the trailing dots and spaces Windows drops from each component
 * removed, in lower case (NTFS names are case-insensitive by default). Extended prefixes are canonicalized before
 * resolving so standard and extended drive/UNC paths evaluate symmetrically.
 */
function comparable(target: string): string {
  const stripped = stripExtendedPrefix(target);
  return path.win32.resolve(stripped).split('\\').map((part, index) => index === 0 ? part : part.replace(/[. ]+$/, '')).join('\\').toLowerCase();
}
const inside = (target: string, root: string) => target === root || target.startsWith(`${root}\\`);

/**
 * Whether a chosen target is refused by name (J16): anything that is not an ordinary drive or UNC path (standard or
 * extended-length), a device path (`\\.\`, `\??\`, `\\?\pipe\`, `\\?\Volume{...}`), a DOS device name in any component,
 * or a path inside `<LOCALAPPDATA>\ETS2Telemetry` (normalized and case-insensitive). Without a usable LOCALAPPDATA the
 * data directory is unknown, so every target is refused.
 */
export function exportTargetRefused(target: unknown, localAppData: string | undefined,
  rootNames: readonly string[] = CHANNEL.exportRefusalDataRootNames): boolean {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) return true;
  const raw = target.replaceAll('/', '\\');
  if (raw.startsWith('\\\\.\\') || raw.startsWith('\\??\\')) return true;
  if (raw.startsWith('\\\\?\\')) {
    if (target.includes('/')) return true;
    if (!/^\\\\\?\\[A-Za-z]:\\/i.test(raw) && !/^\\\\\?\\UNC\\[^\\?.\\][^\\]*\\[^\\]+/i.test(raw)) return true;
  } else {
    if (!/^[A-Za-z]:\\/.test(raw) && !/^\\\\[^\\?.]/.test(raw)) return true;
  }
  const resolved = comparable(raw);
  if (resolved.split('\\').slice(1).some(part => DEVICE_NAME.test(part.trim()))) return true;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) return true;
  const base = localAppData;
  return rootNames.some(name => inside(resolved, comparable(path.win32.join(base, name))));
}

/**
 * Whether `folder` or one of its at most EXPORT_ANCESTOR_LIMIT ancestors is the data directory by file identity: the
 * same volume (`dev`) and file index (`ino`). A data directory that does not exist yet has no identity; the lexical
 * checks alone apply then. A folder deeper than the limit is refused, since it cannot be shown to lie outside.
 */
async function insideByIdentity(fs: ExportFileSystem, folder: string, localAppData: string | undefined, rootNames: readonly string[]): Promise<boolean> {
  if (!localAppData) return true;
  const identity = (target: string) => fs.stat(target, {bigint: true}).then(stats => `${stats.dev}:${stats.ino}`, () => undefined);
  const roots: string[] = [];
  for (const name of rootNames) {
    const root = await identity(path.join(localAppData, name));
    // No identity to compare: a data directory that does not exist yet, or a file system without file indexes.
    if (root !== undefined && !root.endsWith(':0')) roots.push(root);
  }
  if (roots.length === 0) return false;
  let current = folder;
  for (let depth = 0; depth < EXPORT_ANCESTOR_LIMIT; depth++) {
    const found = await identity(current);
    if (found !== undefined && roots.includes(found)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return true;
}

/**
 * Whether a chosen target lies in the data directory once its folder is resolved as Windows resolves it (junctions,
 * short names), or by file identity. Rejects when the chosen folder cannot be resolved.
 */
export async function targetInsideDataRoot(fs: ExportFileSystem, target: string, localAppData: string | undefined,
  rootNames: readonly string[] = CHANNEL.exportRefusalDataRootNames): Promise<boolean> {
  const real = await fs.realpath(path.dirname(target));
  const roots: string[] = [];
  if (localAppData) {
    for (const name of rootNames) {
      const root = await fs.realpath(path.join(localAppData, name)).catch(() => undefined);
      if (root !== undefined) roots.push(root);
    }
  }
  const resolved = path.join(real, path.basename(target));
  if (exportTargetRefused(resolved, localAppData, rootNames) || roots.some(root => inside(comparable(resolved), comparable(root)))) return true;
  // A UNC alias of a local folder (\\localhost\C$\..., \\127.0.0.1\c$\..., the computer's own name, a drive mapped to
  // such a share) passes both checks above, because realpath leaves a UNC path unchanged. The data directory is
  // therefore also compared by file identity (volume and file index) with the chosen folder and each of its ancestors.
  return insideByIdentity(fs, real, localAppData, rootNames);
}

export interface PartialWriteOptions {
  fs: ExportFileSystem;
  /** The file the user chose; checked against the data directory again before anything is written. */
  target: string;
  localAppData: string | undefined;
  /** Eight hex digits of the partial file's name. */
  suffix(): string;
  delay(milliseconds: number): Promise<void>;
  /** Throws to stop the export (the application exits); called before every write and every rename attempt. */
  check(): void;
  /** The error for a target inside the data directory. */
  refused(): Error;
  /** Maps any error of the write to the export's own error; `step` names where it happened. */
  failed(step: ExportWriteStep, error: unknown): Error;
  /** Writes the content through `write`, which appends text at the file's current position. */
  body(write: (text: string) => Promise<void>): Promise<void>;
}

/**
 * Writes an export through a partial file beside the target and renames it over the target. Nothing is opened before
 * the target passed the data-directory check; the partial file never outlives a failure or an exit.
 */
export async function writeThroughPartial(options: PartialWriteOptions): Promise<void> {
  const {fs, target} = options, directory = path.dirname(target);
  let handle: ExportFileHandle | undefined, partial: string | undefined, step: ExportWriteStep = 'target';
  try {
    if (await targetInsideDataRoot(fs, target, options.localAppData)) throw options.refused();
    step = 'open';
    const candidate = path.join(directory, `${path.basename(target)}.${options.suffix()}.partial`);
    handle = await fs.open(candidate, 'wx');
    partial = candidate;
    step = 'write';
    const open = handle;
    // writeFile writes the whole text from the handle's current position, looping over partial writes itself.
    await options.body(async text => {options.check(); if (text) await open.writeFile(text, 'utf8');});
    step = 'sync';
    await handle.sync();
    step = 'close';
    const closing = handle; handle = undefined;
    await closing.close();
    step = 'rename';
    await renameWithRetry(options, partial, target);
    partial = undefined;
  } catch (error) {
    throw options.failed(step, error);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (partial) await fs.unlink(partial).catch(() => undefined);
  }
}

async function renameWithRetry(options: PartialWriteOptions, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    options.check();
    try { await options.fs.rename(from, to); return; }
    catch (error) {
      const code = exportErrorCode(error);
      if (attempt >= EXPORT_RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME.has(code)) throw error;
      await options.delay(EXPORT_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}
