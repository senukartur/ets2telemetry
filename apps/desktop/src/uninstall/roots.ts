import path from 'node:path';
import {readAtomicFile, type AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {TEST_ROOT_MARKER} from '../plugin-setup/mode';
import type {InstallerFileSystem} from '../plugin-setup/plugin-installer';
import {isDrivePath} from '../plugin-setup/steam-discovery';

// The uninstall roots (ET-018 U3; docs/uninstall.md, "Roots"). The central safety rule: the folders an uninstall may
// delete come from the install location of the running executable, never from %LOCALAPPDATA% alone. The layout is
// `<base>\ETS2TelemetryDesktop\app-<semver>\<executable>`, and the data root is `<base>\ETS2Telemetry`.
//
// - Production: no test files beside the base, and the real location of the LOCALAPPDATA variable equals the base. Any
//   difference is ROOT_MISMATCH: nothing is deleted.
// - Test root: the base is named `LocalAppData`, and its parent holds the ET-017 test-root marker and a valid
//   `ets2telemetry-install-test.json`. The LOCALAPPDATA variable is ignored, and every path of the test file lies
//   inside that parent. A test install, even one uninstalled from Windows Settings, can only wipe its own test root.
// - Anything else (a portable, unpackaged or development launch) is NOT_INSTALLED.
//
// Every refusal is a fixed code; no path leaves this module except in a successful result, which only main uses.

export const PRODUCT_ROOT_NAME = 'ETS2TelemetryDesktop';
export const DATA_ROOT_NAME = 'ETS2Telemetry';
export const TEST_BASE_NAME = 'LocalAppData';
export const INSTALL_TEST_FILE = 'ets2telemetry-install-test.json';
export const INSTALL_TEST_FORMAT = 'ets2telemetry.install-test';
const MAX_INSTALL_TEST_BYTES = 16 * 1024;
/** `app-<semver>`, as Squirrel names an installed version's folder. */
const APP_DIRECTORY = /^app-\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** The per-run RunOnce key a test install may name (plan U7); production never reads it. */
const TEST_RUN_ONCE_KEY = /^HKCU\\Software\\ETS2Telemetry-Test-[0-9a-f]{32}\\RunOnce$/;

export type UninstallRootsRefusal = 'NOT_INSTALLED' | 'ROOT_MISMATCH' | 'LAYOUT_INVALID' | 'DATA_ROOT_LINKED' | 'TEST_ROOT_INVALID';
export interface InstallTestFile {readonly profileDir: string; readonly runOnceKey: string | null; readonly shortcuts: boolean}
interface RootsCommon {
  readonly ok: true;
  /** `app-<semver>`, the folder of the running executable. */
  readonly appDirectory: string;
  /** `<base>\ETS2TelemetryDesktop`, Squirrel's binary root, holding Update.exe. */
  readonly installRoot: string;
  readonly base: string;
  /** `<base>\ETS2Telemetry`; it may not exist. */
  readonly dataRoot: string;
}
export type UninstallRoots =
  | (RootsCommon & {readonly mode: 'production'})
  /** `testRoot` is the parent of the base; plugin cleanup is confined to it. */
  | (RootsCommon & {readonly mode: 'test-root'; readonly testRoot: string; readonly testFile: InstallTestFile})
  | {readonly ok: false; readonly code: UninstallRootsRefusal};

/** The read operations used here; `node:fs/promises` satisfies them. */
export type RootsFileSystem = Pick<InstallerFileSystem, 'lstat' | 'realpath'> & AtomicFileSystem;

const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
const isInside = (child: string, parent: string) => normal(child).startsWith(`${normal(parent)}\\`);
const refuse = (code: UninstallRootsRefusal): UninstallRoots => ({ok: false, code});

type Kind = 'file' | 'directory' | 'link' | 'missing' | 'other' | 'error';
async function kindOf(fs: RootsFileSystem, target: string): Promise<Kind> {
  try {
    const stats = await fs.lstat(target, {bigint: true});
    return stats.isSymbolicLink() ? 'link' : stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? 'missing' : 'error';
  }
}

/** Validates the parsed installer test file: exactly its keys, version 1, and every path inside `testRoot`. */
export function parseInstallTestFile(bytes: Uint8Array, testRoot: string): InstallTestFile | undefined {
  let value: unknown;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'format,profileDir,runOnceKey,shortcuts,version') return undefined;
  if (record.format !== INSTALL_TEST_FORMAT || record.version !== 1 || typeof record.shortcuts !== 'boolean') return undefined;
  if (!isDrivePath(record.profileDir) || !isInside(record.profileDir, testRoot)) return undefined;
  if (record.runOnceKey !== null && (typeof record.runOnceKey !== 'string' || !TEST_RUN_ONCE_KEY.test(record.runOnceKey))) return undefined;
  return {profileDir: path.win32.normalize(record.profileDir), runOnceKey: record.runOnceKey, shortcuts: record.shortcuts};
}

export interface RootsInput {
  /** process.execPath of the running application. */
  readonly executable: string;
  /** The process environment; only LOCALAPPDATA is read, and only in production mode. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: RootsFileSystem;
}

/** Derives the uninstall roots from the running executable (U3); see the file comment. */
export async function resolveUninstallRoots(input: RootsInput): Promise<UninstallRoots> {
  const {fs} = input;
  if (!isDrivePath(input.executable)) return refuse('NOT_INSTALLED');
  const executable = path.win32.normalize(input.executable);
  const appDirectory = path.win32.dirname(executable);
  const installRoot = path.win32.dirname(appDirectory);
  const base = path.win32.dirname(installRoot);
  // Portable, unpackaged and development launches do not have this layout: they never delete anything.
  if (!APP_DIRECTORY.test(path.win32.basename(appDirectory)) || path.win32.basename(installRoot) !== PRODUCT_ROOT_NAME) return refuse('NOT_INSTALLED');
  // The base: an absolute drive path that is not a bare drive (checked before anything is read) and not a link.
  if (!isDrivePath(base) || /^[A-Za-z]:\\*$/.test(base) || base === installRoot) return refuse('LAYOUT_INVALID');
  if (await kindOf(fs, installRoot) !== 'directory' || await kindOf(fs, appDirectory) !== 'directory') return refuse('NOT_INSTALLED');
  if (await kindOf(fs, path.win32.join(installRoot, 'Update.exe')) !== 'file') return refuse('NOT_INSTALLED');
  if (await kindOf(fs, base) !== 'directory') return refuse('LAYOUT_INVALID');
  const dataRoot = path.win32.join(base, DATA_ROOT_NAME);
  const dataKind = await kindOf(fs, dataRoot);
  if (dataKind === 'link') return refuse('DATA_ROOT_LINKED');
  if (dataKind !== 'directory' && dataKind !== 'missing') return refuse('LAYOUT_INVALID');
  const common = {ok: true as const, appDirectory, installRoot, base, dataRoot};

  // Test root: the base is `LocalAppData` and its parent is marked. A partial or invalid marking is refused, never
  // treated as production.
  if (path.win32.basename(base) === TEST_BASE_NAME) {
    const testRoot = path.win32.dirname(base);
    const marker = await kindOf(fs, path.win32.join(testRoot, TEST_ROOT_MARKER));
    const testFileKind = await kindOf(fs, path.win32.join(testRoot, INSTALL_TEST_FILE));
    if (marker !== 'missing' || testFileKind !== 'missing') {
      if (marker !== 'file' || testFileKind !== 'file' || /^[A-Za-z]:\\*$/.test(testRoot)) return refuse('TEST_ROOT_INVALID');
      const read = await readAtomicFile(fs, testRoot, INSTALL_TEST_FILE, MAX_INSTALL_TEST_BYTES);
      if (read.state !== 'present' || read.bytes.byteLength > MAX_INSTALL_TEST_BYTES) return refuse('TEST_ROOT_INVALID');
      const testFile = parseInstallTestFile(read.bytes, testRoot);
      return testFile ? {...common, mode: 'test-root', testRoot, testFile} : refuse('TEST_ROOT_INVALID');
    }
  }

  // Production: the LOCALAPPDATA variable must name the same folder as the base, by real location.
  const localAppData = input.env.LOCALAPPDATA;
  if (!isDrivePath(localAppData)) return refuse('ROOT_MISMATCH');
  let realBase: string, realLocal: string;
  try {[realBase, realLocal] = await Promise.all([fs.realpath(base), fs.realpath(localAppData)]);} catch {return refuse('ROOT_MISMATCH');}
  if (normal(realBase) !== normal(realLocal)) return refuse('ROOT_MISMATCH');
  return {...common, mode: 'production'};
}
