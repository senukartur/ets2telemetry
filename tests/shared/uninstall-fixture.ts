import {createHash} from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type {RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import type {InstallRecord, PendingIntent} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import type {UninstallFileSystem} from '../../apps/desktop/src/uninstall/engine';
import type {RunOnceRegistry} from '../../apps/desktop/src/uninstall/executor';
import {fakeSteam, type FakeSteam} from './fake-steam';
import type {GuardedRoot} from './guarded-fs';

// A fake Squirrel install for the ET-018 uninstall tests, inside a guarded temporary root (tests/shared/guarded-fs.ts):
// `<guard>\run` is the test root with the ET-017 marker and the installer test file, `run\LocalAppData` the base with
// `ETS2TelemetryDesktop\app-0.1.0\ETS2TelemetryDesktop.exe` and `Update.exe` (text placeholders, never executed) and the
// data root `ETS2Telemetry`, and fake game folders under `run\Games`. Nothing here touches a real folder.

export const UTC = '2026-10-18T09:00:00.000Z';
export const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export const bytes = (label: string, size = 4096) => {
  const value = Buffer.alloc(size);
  for (let index = 0; index < size; index++) value[index] = (index * 31 + label.charCodeAt(index % label.length)) & 0xff;
  return value;
};
export const CURRENT = bytes('plugin 0.1.0'), RELEASED = bytes('plugin 0.0.9'), LOCAL_BUILD = bytes('recorded local build'), FOREIGN = bytes('someone else');
/** The bundle's own and earlier released hashes, as the engine receives them. */
export const KNOWN = [sha(CURRENT), sha(RELEASED)];
export const notRunning: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: false}});

export interface InstallFixture {
  readonly testRoot: string;
  readonly base: string;
  readonly installRoot: string;
  readonly executable: string;
  readonly dataRoot: string;
  readonly registryDirectory: string;
  readonly steam: FakeSteam;
  readonly fs: UninstallFileSystem;
}

/** Builds the fake install under `<guard>\<name>`; `testRoot: false` leaves out the marker and test file (production layout). */
export async function installFixture(guard: GuardedRoot, options: {name?: string; testRoot?: boolean} = {}): Promise<InstallFixture> {
  const testRoot = path.win32.join(guard.root, options.name ?? 'run');
  const base = path.win32.join(testRoot, 'LocalAppData');
  const installRoot = path.win32.join(base, 'ETS2TelemetryDesktop');
  const app = path.win32.join(installRoot, 'app-0.1.0');
  await fsp.mkdir(app, {recursive: true});
  const executable = path.win32.join(app, 'ETS2TelemetryDesktop.exe');
  await fsp.writeFile(executable, 'placeholder executable, never run');
  await fsp.writeFile(path.win32.join(installRoot, 'Update.exe'), 'placeholder updater, never run');
  if (options.testRoot !== false) {
    await fsp.writeFile(path.win32.join(testRoot, 'ets2telemetry-plugin-test-root.marker'), 'uninstall test root\n');
    await fsp.writeFile(path.win32.join(testRoot, 'ets2telemetry-install-test.json'), JSON.stringify({format: 'ets2telemetry.install-test', version: 1,
      profileDir: path.win32.join(testRoot, 'profile'), runOnceKey: null, shortcuts: false}));
  }
  const dataRoot = path.win32.join(base, 'ETS2Telemetry');
  await fsp.mkdir(dataRoot, {recursive: true});
  return {testRoot, base, installRoot, executable, dataRoot, registryDirectory: path.win32.join(dataRoot, 'plugins'), steam: await fakeSteam(guard.root),
    fs: guard.fs as unknown as UninstallFileSystem};
}

export interface FakeGameFolder {readonly root: string; readonly plugins: string; readonly dll: string}
/** A fake game folder inside the test root; `content` is the plugin file's bytes, if any. */
export async function gameFolder(fixture: InstallFixture, name: string, options: {game?: 'ets2' | 'ats'; plugins?: boolean; content?: Uint8Array} = {}): Promise<FakeGameFolder> {
  const root = await fixture.steam.gameFolder(path.win32.join(fixture.testRoot, 'Games', name), options.game ?? 'ets2',
    {plugins: options.plugins ?? options.content !== undefined});
  const plugins = path.win32.join(root, 'bin', 'win_x64', 'plugins'), dll = path.win32.join(plugins, 'ets2telemetry-plugin.dll');
  if (options.content) await fsp.writeFile(dll, options.content);
  return {root, plugins, dll};
}

export const installRecord = (folder: FakeGameFolder, overrides: Partial<InstallRecord> = {}): InstallRecord => ({game: 'ets2', root: folder.root, source: 'steam',
  sha256: sha(CURRENT), appVersion: '0.1.0', installedUtc: UTC, createdPluginsDirectory: false, ...overrides});
export const pendingInstall = (folder: FakeGameFolder, hex: string, overrides: Partial<PendingIntent> = {}): PendingIntent => ({op: 'install', game: 'ets2',
  root: folder.root, source: 'steam', temp: path.win32.join(folder.plugins, `ets2telemetry-plugin.dll.${hex}.tmp`), fromSha256: null, toSha256: sha(LOCAL_BUILD),
  appVersion: '0.1.0', createdPluginsDirectory: false, startedUtc: UTC, ...overrides});

/** Writes `plugins\setup.json` with these records. */
export async function writeRegistry(fixture: InstallFixture, installs: readonly InstallRecord[], pending: readonly PendingIntent[] = []): Promise<void> {
  await fsp.mkdir(fixture.registryDirectory, {recursive: true});
  await fsp.writeFile(path.win32.join(fixture.registryDirectory, 'setup.json'), `${JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
    games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}}, installs, pending, failures: []}, null, 2)}\n`);
}

/** Every allowlisted data entry with a file, plus an unknown entry when `unknown` is set. */
export async function seedData(fixture: InstallFixture, options: {unknown?: boolean} = {}): Promise<void> {
  for (const [folder, file] of [['data', 'telemetry.sqlite'], ['backups', 'telemetry-v1.sqlite'], ['settings', 'settings.json'], ['logs', 'startup.jsonl'],
    ['synthetic', 'smoke.sqlite'], ['captures', 'capture.cap0'], ['transport', 'v1\\service-policy.json']]) {
    const target = path.win32.join(fixture.dataRoot, folder, file);
    await fsp.mkdir(path.win32.dirname(target), {recursive: true});
    await fsp.writeFile(target, `synthetic ${folder}`);
  }
  if (options.unknown) {
    await fsp.mkdir(path.win32.join(fixture.dataRoot, 'notes'), {recursive: true});
    await fsp.writeFile(path.win32.join(fixture.dataRoot, 'notes', 'mine.txt'), 'the user\'s own file');
  }
}

/** Every file and folder under `root`, relative and sorted; links are listed as `<name> -> link`. */
export async function listTree(root: string): Promise<string[]> {
  const rows: string[] = [];
  async function walk(directory: string) {
    let names: string[];
    try {names = await fsp.readdir(directory);} catch {return;}
    for (const name of names.sort()) {
      const target = path.win32.join(directory, name), stats = await fsp.lstat(target), relative = path.win32.relative(root, target);
      if (stats.isSymbolicLink()) rows.push(`${relative} -> link`);
      else if (stats.isDirectory()) {rows.push(`${relative}\\`); await walk(target);}
      else rows.push(relative);
    }
  }
  await walk(root);
  return rows;
}
export const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);

/** A per-test RunOnce key of the allowed test form; the fake registry below never reaches Windows. */
export const TEST_RUN_ONCE = `HKCU\\Software\\ETS2Telemetry-Test-${'0123456789abcdef'.repeat(2)}\\RunOnce`;
/** Rewrites the fixture's installer test file with this RunOnce key (or null). */
export async function useRunOnceKey(fixture: InstallFixture, runOnceKey: string | null, shortcuts = false): Promise<void> {
  await fsp.writeFile(path.win32.join(fixture.testRoot, 'ets2telemetry-install-test.json'), JSON.stringify({format: 'ets2telemetry.install-test', version: 1,
    profileDir: path.win32.join(fixture.testRoot, 'profile'), runOnceKey, shortcuts}));
}
export interface FakeRunOnce extends RunOnceRegistry {
  /** `<key>\<value>` to data. */
  readonly values: Map<string, string>;
  /** `set <key>`, `remove <key>` and `read <key>`, in order. */
  readonly calls: string[];
}
/** An in-memory RunOnce registry for the uninstall tests; `fail` makes every set and remove fail, `onSet` observes a set. */
export function fakeRunOnce(options: {fail?: boolean; onSet?: () => void} = {}): FakeRunOnce {
  const values = new Map<string, string>(), calls: string[] = [];
  const name = (key: string, value: string) => `${key}\\${value}`;
  return {
    values, calls,
    set: (key, value, data) => {
      calls.push(`set ${key}`);
      options.onSet?.();
      if (options.fail) return Promise.resolve(false);
      values.set(name(key, value), data);
      return Promise.resolve(true);
    },
    remove: (key, value) => {
      calls.push(`remove ${key}`);
      if (options.fail) return Promise.resolve('failed' as const);
      return Promise.resolve(values.delete(name(key, value)) ? 'removed' as const : 'absent' as const);
    },
    read: (key, value) => {calls.push(`read ${key}`); return Promise.resolve(values.get(name(key, value)) ?? null);}
  };
}

