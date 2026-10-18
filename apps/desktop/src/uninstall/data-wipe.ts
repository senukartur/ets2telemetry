import path from 'node:path';

// The data wipe of an uninstall (ET-018 U4; docs/uninstall.md, "What is removed"). Only the allowlisted top-level
// entries of the data root are removed; any other entry stays and is counted. A custom walker lstats every entry and
// never follows a link: a symbolic link or junction is unlinked itself, so its target is never entered or changed. It
// never clears a read-only attribute (Node's unlink on Windows would), so a read-only file stays and is reported, and
// so do a locked or denied entry. The data root itself is removed only when it is empty. Failures carry the
// allowlisted entry's name and a fixed code, never a path.

/** The data root's top-level entries an uninstall removes; `dataPaths()` may not name anything outside them. */
export const DATA_ALLOWLIST = Object.freeze(['data', 'backups', 'settings', 'logs', 'synthetic', 'plugins', 'captures', 'transport', 'uninstall'] as const);
export type DataEntry = typeof DATA_ALLOWLIST[number];
/** Removed last, and only when the plugin cleanup finished: they hold the install registry and the uninstall intent. */
export const KEPT_UNTIL_CLEAN: readonly DataEntry[] = Object.freeze(['plugins', 'uninstall']);
export type WipeFailureCode = 'READ_ONLY_FILE' | 'TARGET_LOCKED' | 'PERMISSION_DENIED' | 'IO_ERROR' | 'BUDGET_EXPIRED';

interface WipeStats {isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; mode: bigint}
/** The operations the walker uses; `node:fs/promises` satisfies them. `lstat` never follows a link. */
export interface WipeFileSystem {
  lstat(target: string, options: {bigint: true}): Promise<WipeStats>;
  readdir(target: string): Promise<string[]>;
  unlink(target: string): Promise<void>;
  rmdir(target: string): Promise<void>;
}
export interface WipeReport {
  /** Allowlisted top-level entries now gone. */
  readonly removed: number;
  /** Top-level entries outside the allowlist, kept. */
  readonly kept: number;
  /** Allowlisted entries that could not be removed completely, with the first failure's code. */
  readonly failed: readonly {readonly entry: DataEntry; readonly code: WipeFailureCode}[];
  readonly rootRemoved: boolean;
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
function failureCode(code: string | null): WipeFailureCode {
  if (code === 'EBUSY') return 'TARGET_LOCKED';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return 'PERMISSION_DENIED';
  return 'IO_ERROR';
}
const missing = (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

/**
 * Removes one entry and everything below it without following links. Returns the first failure, or null when the entry
 * is gone. Entries that cannot be removed stay, and so do their parent folders.
 */
async function removeTree(fs: WipeFileSystem, target: string, expired: () => boolean): Promise<WipeFailureCode | null> {
  if (expired()) return 'BUDGET_EXPIRED';
  let stats: WipeStats;
  try {stats = await fs.lstat(target, {bigint: true});} catch (error) {return missing(error) ? null : failureCode(errorCode(error));}
  if (stats.isSymbolicLink()) {
    // A symbolic link or junction: removed itself, never entered. Directory links are removed as directories on Windows.
    try {await fs.unlink(target); return null;} catch (error) {
      if (missing(error)) return null;
      try {await fs.rmdir(target); return null;} catch (second) {return missing(second) ? null : failureCode(errorCode(second));}
    }
  }
  if (stats.isDirectory()) {
    let names: string[];
    try {names = await fs.readdir(target);} catch (error) {return missing(error) ? null : failureCode(errorCode(error));}
    let first: WipeFailureCode | null = null;
    for (const name of names.sort()) {
      const failure = await removeTree(fs, path.win32.join(target, name), expired);
      first ??= failure;
      if (failure === 'BUDGET_EXPIRED') return failure;
    }
    if (first) return first;
    try {await fs.rmdir(target); return null;} catch (error) {return missing(error) ? null : failureCode(errorCode(error));}
  }
  if ((stats.mode & 0o200n) === 0n) return 'READ_ONLY_FILE';
  try {await fs.unlink(target); return null;} catch (error) {return missing(error) ? null : failureCode(errorCode(error));}
}

export interface WipeOptions {
  /** Allowlisted entries that stay this time (KEPT_UNTIL_CLEAN while the plugin cleanup is unfinished). */
  readonly keep?: readonly DataEntry[];
  /** Removes the data root when it is empty afterwards. */
  readonly removeRoot?: boolean;
  /** True once the uninstall budget is spent: the walk stops and reports BUDGET_EXPIRED. */
  readonly expired?: () => boolean;
}

/** Wipes the allowlisted entries of `dataRoot` except `keep`; see the file comment. A missing data root is already wiped. */
export async function wipeDataRoot(fs: WipeFileSystem, dataRoot: string, options: WipeOptions = {}): Promise<WipeReport> {
  const keep = new Set<string>(options.keep ?? []), expired = options.expired ?? (() => false);
  let names: string[];
  try {names = await fs.readdir(dataRoot);} catch (error) {
    if (missing(error)) return {removed: 0, kept: 0, failed: [], rootRemoved: true};
    return {removed: 0, kept: 0, failed: [{entry: 'data', code: failureCode(errorCode(error))}], rootRemoved: false};
  }
  let removed = 0, kept = 0;
  const failed: {entry: DataEntry; code: WipeFailureCode}[] = [];
  // Allowlist names are compared case-insensitively, as Windows does; an unknown entry is never touched.
  const allowed = (name: string) => DATA_ALLOWLIST.find(entry => entry === name.toLowerCase());
  for (const name of names.sort()) {
    const entry = allowed(name);
    if (!entry) {kept++; continue;}
    if (keep.has(entry)) continue;
    const failure = await removeTree(fs, path.win32.join(dataRoot, name), expired);
    if (failure) failed.push({entry, code: failure}); else removed++;
    if (failure === 'BUDGET_EXPIRED') break;
  }
  let rootRemoved = false;
  if (options.removeRoot && !failed.length && !expired()) {
    try {
      if (!(await fs.readdir(dataRoot)).length) {await fs.rmdir(dataRoot); rootRemoved = true;}
    } catch (error) {rootRemoved = missing(error);}
  }
  return {removed, kept, failed, rootRemoved};
}
