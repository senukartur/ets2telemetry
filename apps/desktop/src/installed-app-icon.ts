import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {ATOMIC_RENAME_RETRY_DELAYS_MS, errorCode, inspectEntry, temporaryPattern, type AtomicFileSystem} from './plugin-setup/atomic-json-file';
import {nodeExecFile, runFixedProgram, systemRoot, type ExecFilePort} from './plugin-setup/fixed-program';
import type {InstallerFileSystem} from './plugin-setup/plugin-installer';
import {REG_TIMEOUT_MS} from './uninstall/executor';
import {PRODUCT_ROOT_NAME, type UninstallRoots} from './uninstall/roots';

// The Installed apps icon (ET-045g, owner decision D3; docs/release.md, "Installed apps icon"). Squirrel's
// CreateUninstallerRegistryEntry (pinned commit eef37460ae) downloads `iconUrl` into `<install root>\app.ico` and sets the
// uninstall entry's DisplayIcon only when that file does not exist yet. electron-winstaller defaults `iconUrl` to the
// Electron atom icon, so Windows Settings showed the atom. Squirrel runs `--squirrel-install` and `--squirrel-updated`
// before that registration, so these hooks place the bundled product icon at `<install root>\app.ico` (Squirrel then
// downloads nothing and keeps its hands off DisplayIcon) and set this product's DisplayIcon to the versioned executable's
// icon resource 0. They never touch another key or value, and never the data root.

/** The packaged icon: `resources\icon\app.ico` (forge.config.cjs `extraResource`). */
export const ICON_RESOURCE_DIRECTORY = 'icon';
/** Squirrel's icon file name in the install root, and the packaged icon's file name. */
export const INSTALLED_ICON_FILE = 'app.ico';
/** The tracked icon is about 170 KiB; anything larger is not read. */
export const MAX_ICON_BYTES = 1024 * 1024;
/** The HKCU uninstall entry Squirrel creates for this application (the Squirrel id, `PRODUCT_ROOT_NAME`). */
export const UNINSTALL_ENTRY_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_ROOT_NAME}`;
export const DISPLAY_ICON_VALUE = 'DisplayIcon';
/** The longest DisplayIcon data the registry port accepts. */
export const MAX_DISPLAY_ICON_LENGTH = 1024;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left.buffer, left.byteOffset, left.byteLength)
  .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
const defaultDelay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * A Windows icon file: reserved 0, type 1, 1 to 64 entries, and every entry's image inside the buffer, after the
 * directory. The bytes are not decoded further.
 */
export function validIcoBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6 || bytes.byteLength > MAX_ICON_BYTES) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.readUInt16LE(4);
  if (view.readUInt16LE(0) !== 0 || view.readUInt16LE(2) !== 1 || count < 1 || count > 64) return false;
  const directoryEnd = 6 + 16 * count;
  if (directoryEnd > view.length) return false;
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index, size = view.readUInt32LE(entry + 8), offset = view.readUInt32LE(entry + 12);
    if (size === 0 || offset < directoryEnd || offset + size > view.length) return false;
  }
  return true;
}

/** DisplayIcon data this module writes: an absolute drive path to an `.exe` with icon index 0, no quote or control character. */
export function validDisplayIconData(data: unknown): data is string {
  return typeof data === 'string' && data.length <= MAX_DISPLAY_ICON_LENGTH && !/["\r\n\0]/.test(data) && /^[A-Za-z]:\\[^"]+\.exe,0$/i.test(data);
}

/**
 * The DisplayIcon of an install: icon resource 0 of the running executable in its validated `app-<semver>` folder. The
 * string changes with every version, so Windows never reuses an icon it cached for an earlier value.
 */
export function displayIconFor(roots: Extract<UninstallRoots, {ok: true}>, executableName: string): string {
  return `${path.win32.join(roots.appDirectory, executableName)},0`;
}

/**
 * The file operations used here; `node:fs/promises` and the uninstall file system satisfy them. The installer's binary
 * `open` comes first, so a handle can write bytes; `mkdir` is never called.
 */
export type IconFileSystem = Pick<InstallerFileSystem, 'open'> & AtomicFileSystem;
export type IconPlacement = 'placed' | 'replaced' | 'unchanged' | 'target-blocked' | 'failed';

/** Reads at most `limit` bytes of `file`; a larger file throws. */
async function readBounded(fs: IconFileSystem, file: string, limit: number): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = new Uint8Array(limit + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const {bytesRead} = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('ICON_TOO_LARGE');
    return buffer.subarray(0, length);
  } finally {await handle.close();}
}

async function renameWithRetry(fs: IconFileSystem, from: string, to: string, delay: (milliseconds: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {await fs.rename(from, to); return;}
    catch (error) {
      const code = errorCode(error);
      if (attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME.has(code)) throw error;
      await delay(ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Places `bytes` at `<installRoot>\app.ico`:
 *
 * 1. A regular file with the same bytes is `unchanged` and nothing is written. A link, junction, folder or anything
 *    else at the target is `target-blocked` and nothing is touched.
 * 2. Stale temporary files of this file's own pattern (`app.ico.<pid>.<uuid>.tmp`) are removed; other files stay.
 * 3. A new temporary file is created with `wx`, written, synced and closed, then read back and compared by SHA-256.
 * 4. It is renamed over the target, with ATOMIC_RENAME_RETRY_DELAYS_MS retries on EPERM, EACCES or EBUSY, and the target
 *    is hashed again.
 *
 * Any failure removes the temporary file and keeps the previous file; it never throws.
 */
export async function placeInstalledIcon(fs: IconFileSystem, installRoot: string, bytes: Uint8Array,
  options: {delay?: (milliseconds: number) => Promise<void>} = {}): Promise<IconPlacement> {
  const delay = options.delay ?? defaultDelay;
  const target = path.win32.join(installRoot, INSTALLED_ICON_FILE);
  const expected = sha256(bytes);
  const existing = await inspectEntry(fs, target, 'file');
  if (existing === 'reparse-point' || existing === 'not-file') return 'target-blocked';
  if (existing !== 'present' && existing !== 'absent') return 'failed';
  if (existing === 'present') {
    const current = await readBounded(fs, target, MAX_ICON_BYTES).catch(() => undefined);
    if (current && sameBytes(current, bytes)) return 'unchanged';
  }
  const pattern = temporaryPattern(INSTALLED_ICON_FILE);
  try {
    for (const entry of await fs.readdir(installRoot)) {
      if (pattern.test(entry)) await fs.unlink(path.win32.join(installRoot, entry)).catch(() => undefined);
    }
  } catch {return 'failed';}
  const temporary = path.win32.join(installRoot, `${INSTALLED_ICON_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx');
    created = true;
    try {
      for (let written = 0; written < bytes.byteLength;) {
        const {bytesWritten} = await handle.write(bytes, written, bytes.byteLength - written, written);
        if (bytesWritten <= 0) throw new Error('ICON_WRITE_STALLED');
        written += bytesWritten;
      }
      await handle.sync();
    } finally {await handle.close();}
    if (sha256(await readBounded(fs, temporary, MAX_ICON_BYTES)) !== expected) throw new Error('ICON_READ_BACK_MISMATCH');
    // The target may have changed since step 1; a link or folder that appeared is never replaced.
    const now = await inspectEntry(fs, target, 'file');
    if (now !== 'present' && now !== 'absent') {
      await fs.unlink(temporary).catch(() => undefined);
      created = false;
      return now === 'reparse-point' || now === 'not-file' ? 'target-blocked' : 'failed';
    }
    await renameWithRetry(fs, temporary, target, delay);
    created = false;
    if (sha256(await readBounded(fs, target, MAX_ICON_BYTES)) !== expected) return 'failed';
    return existing === 'present' ? 'replaced' : 'placed';
  } catch {
    if (created) await fs.unlink(temporary).catch(() => undefined);
    return 'failed';
  }
}

/** The one registry write of this module; the production port runs reg.exe, tests inject a fake. */
export interface UninstallEntryRegistry {
  /** Sets this product's uninstall entry's DisplayIcon (REG_SZ) to `data`; true on success. */
  setDisplayIcon(data: string, timeoutMs: number): Promise<boolean>;
}

/**
 * The production port: `%SystemRoot%\System32\reg.exe add <UNINSTALL_ENTRY_KEY> /v DisplayIcon /t REG_SZ /d <data> /f`
 * with no shell, a hidden window and a deadline. The key and value name are fixed; data that validDisplayIconData
 * refuses fails without starting reg.exe. A missing key is created, which Squirrel's later CreateSubKey keeps.
 */
export function regExeUninstallEntry(env: Readonly<Record<string, string | undefined>>, execFile: ExecFilePort = nodeExecFile): UninstallEntryRegistry {
  const reg = path.win32.join(systemRoot(env), 'System32', 'reg.exe');
  return {
    setDisplayIcon: async (data, timeoutMs) => {
      if (!validDisplayIconData(data)) return false;
      return (await runFixedProgram(execFile, reg, ['add', UNINSTALL_ENTRY_KEY, '/v', DISPLAY_ICON_VALUE, '/t', 'REG_SZ', '/d', data, '/f'],
        {timeoutMs: Math.max(1, timeoutMs), maxOutputBytes: 64 * 1024})).ok;
    }
  };
}

export type DisplayIconState = 'set' | 'failed' | 'skipped';
export interface InstalledIconResult {readonly icon: IconPlacement; readonly displayIcon: DisplayIconState}

export interface InstalledIconPorts {
  readonly roots: Extract<UninstallRoots, {ok: true}>;
  readonly fs: IconFileSystem;
  /** The packaged icon's bytes, or undefined when it cannot be read. */
  readBundledIcon(): Promise<Uint8Array | undefined>;
  readonly registry: UninstallEntryRegistry;
  /** The running executable's file name. */
  readonly executableName: string;
  /** Each DisplayIcon attempt gets this long (REG_TIMEOUT_MS by default). */
  readonly timeoutMs?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

/**
 * The install and updated hooks' icon step: places the bundled icon (an unreadable or invalid one writes nothing and is
 * `failed`), then sets DisplayIcon with one retry, whatever the placement did. Never throws.
 */
export async function registerInstalledIcon(ports: InstalledIconPorts): Promise<InstalledIconResult> {
  const bytes = await ports.readBundledIcon().catch(() => undefined);
  const icon: IconPlacement = bytes && validIcoBytes(bytes)
    ? await placeInstalledIcon(ports.fs, ports.roots.installRoot, bytes, {delay: ports.delay}).catch((): IconPlacement => 'failed') : 'failed';
  const data = displayIconFor(ports.roots, ports.executableName);
  if (!validDisplayIconData(data)) return {icon, displayIcon: 'skipped'};
  const timeoutMs = ports.timeoutMs ?? REG_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await ports.registry.setDisplayIcon(data, timeoutMs).catch(() => false)) return {icon, displayIcon: 'set'};
  }
  return {icon, displayIcon: 'failed'};
}
