import {readFileSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DISPLAY_ICON_VALUE, displayIconFor, MAX_ICON_BYTES, placeInstalledIcon, registerInstalledIcon, regExeUninstallEntry, uninstallEntryKey,
  validDisplayIconData, validIcoBytes, type IconFileSystem} from '../../apps/desktop/src/installed-app-icon';
import {ATOMIC_RENAME_RETRY_DELAYS_MS} from '../../apps/desktop/src/plugin-setup/atomic-json-file';
import type {ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';
import type {InstallerHandle} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {productionSquirrelPorts, type SquirrelApp} from '../../apps/desktop/src/squirrel-events';
import {PRODUCT_ROOT_NAME, type UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {withoutFlush} from '../shared/file-work';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeUninstallEntry} from '../shared/uninstall-fixture';

// REG-017 (ET-045g, owner decision D3): the Installed apps icon of the install and updated hooks. The icon placement
// runs on a guarded temporary install root (tests/shared/guarded-fs.ts); the registry port gets an injected execFile, so
// reg.exe never starts and no real key is written.

const ICON = readFileSync(path.join(import.meta.dirname, '..', '..', 'resources', 'icon', 'app.ico'));
/** A synthetic one-entry icon, distinct from the product icon: Squirrel's earlier download in these cases. */
function legacyIcon(): Buffer {
  const bytes = Buffer.alloc(22 + 8, 0x11);
  bytes.writeUInt16LE(0, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(1, 4);
  bytes.writeUInt8(1, 6); bytes.writeUInt8(1, 7); bytes.writeUInt8(0, 8); bytes.writeUInt8(0, 9); bytes.writeUInt16LE(1, 10); bytes.writeUInt16LE(32, 12);
  bytes.writeUInt32LE(8, 14); bytes.writeUInt32LE(22, 18);
  return bytes;
}

// The guard skips the flush to disk of every file opened through it (withoutFlush, tests/shared/file-work.ts): no case in
// this file observes durability across a power loss. Single syncs of the icon placement took up to 1,378 ms here under
// load on October 28, 2026, nearly all of a slow case's time (ET-019, docs/validation/et-019.md). The failing-sync case
// below still injects its own rejecting sync.
let guard: GuardedRoot, installRoot: string, target: string;
beforeEach(async () => {
  guard = withoutFlush(await guardedTempRoot('ets2telemetry-installed-icon-'));
  installRoot = path.win32.join(guard.root, 'LocalAppData', PRODUCT_ROOT_NAME);
  await fsp.mkdir(path.win32.join(installRoot, 'app-0.1.0'), {recursive: true});
  target = path.win32.join(installRoot, 'app.ico');
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const fs = () => guard.fs as unknown as IconFileSystem;
const noDelay = () => Promise.resolve();
const temporaries = async () => (await fsp.readdir(installRoot)).filter(name => name.endsWith('.tmp'));

/** The guarded file system with one operation replaced; `opens` records each open's flags. */
function wrapped(changes: {open?: (file: string, flags: 'r' | 'wx') => Promise<unknown>; rename?: (from: string, to: string) => Promise<void>} = {}) {
  const base = fs();
  const opens: string[] = [];
  const system: IconFileSystem = {...base,
    open: ((file: string, flags: 'r' | 'wx') => {opens.push(flags); return changes.open ? changes.open(file, flags) : base.open(file, flags);}) as IconFileSystem['open'],
    rename: (from, to) => changes.rename ? changes.rename(from, to) : base.rename(from, to)};
  return {system, opens};
}
const failing = (code: string) => Object.assign(new Error(code), {code});
type Handle = InstallerHandle;
/** The handle operations the placement uses, bound to a real handle, so a case can replace one of them. */
const handleOf = (handle: Handle) => ({stat: handle.stat.bind(handle), read: handle.read.bind(handle), write: handle.write.bind(handle),
  sync: handle.sync.bind(handle), close: handle.close.bind(handle)});

describe('placeInstalledIcon', () => {
  it('places the icon into an absent target, replaces a legacy file and leaves an identical one unwritten', async () => {
    expect(await placeInstalledIcon(fs(), installRoot, ICON, {delay: noDelay})).toBe('placed');
    expect(await fsp.readFile(target)).toEqual(ICON);
    await fsp.writeFile(target, legacyIcon());
    expect(await placeInstalledIcon(fs(), installRoot, ICON, {delay: noDelay})).toBe('replaced');
    expect(await fsp.readFile(target)).toEqual(ICON);
    const old = new Date('2026-01-02T03:04:05Z');
    await fsp.utimes(target, old, old);
    const {system, opens} = wrapped();
    expect(await placeInstalledIcon(system, installRoot, ICON, {delay: noDelay})).toBe('unchanged');
    expect(opens).toEqual(['r']);
    expect((await fsp.stat(target)).mtime.getTime()).toBe(old.getTime());
    expect(await temporaries()).toEqual([]);
  });

  it('never touches a folder or a junction at the target', async () => {
    await fsp.mkdir(target);
    await fsp.writeFile(path.win32.join(target, 'inside.txt'), 'kept');
    expect(await placeInstalledIcon(fs(), installRoot, ICON, {delay: noDelay})).toBe('target-blocked');
    expect(await fsp.readFile(path.win32.join(target, 'inside.txt'), 'utf8')).toBe('kept');
    await fsp.rm(target, {recursive: true});
    const elsewhere = path.win32.join(guard.root, 'elsewhere');
    await fsp.mkdir(elsewhere);
    await fsp.symlink(elsewhere, target, 'junction');
    expect(await placeInstalledIcon(fs(), installRoot, ICON, {delay: noDelay})).toBe('target-blocked');
    expect((await fsp.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fsp.readdir(elsewhere)).toEqual([]);
    expect(await temporaries()).toEqual([]);
  });

  it('removes stale temporary files of its own pattern and keeps every other file', async () => {
    const own = `app.ico.${process.pid}.0123abcd-0123-4567-89ab-0123456789ab.tmp`, foreign = ['other.tmp', 'app.ico.tmp', 'app.ico.12.not-a-uuid.tmp'];
    for (const name of [own, ...foreign]) await fsp.writeFile(path.win32.join(installRoot, name), 'stale');
    expect(await placeInstalledIcon(fs(), installRoot, ICON, {delay: noDelay})).toBe('placed');
    expect((await temporaries()).sort()).toEqual([...foreign].sort());
  });

  it.each([
    ['the wx open', {open: (file: string, flags: 'r' | 'wx') => flags === 'wx' ? Promise.reject(failing('EACCES')) : fs().open(file, flags)}],
    ['the write', {open: async (file: string, flags: 'r' | 'wx') => {
      const handle = await fs().open(file, flags);
      return flags === 'wx' ? {...handleOf(handle), write: () => Promise.reject(failing('ENOSPC'))} : handle;
    }}],
    ['the sync', {open: async (file: string, flags: 'r' | 'wx') => {
      const handle = await fs().open(file, flags);
      return flags === 'wx' ? {...handleOf(handle), sync: () => Promise.reject(failing('EIO'))} : handle;
    }}],
    ['the read-back (different bytes)', {open: async (file: string, flags: 'r' | 'wx') => {
      const handle = await fs().open(file, flags);
      if (flags !== 'r' || !file.endsWith('.tmp')) return handle;
      return {...handleOf(handle), read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const result = await handle.read(buffer, offset, length, position);
        if (result.bytesRead > 0) buffer[offset] ^= 0xff;
        return result;
      }};
    }}],
    ['the rename', {rename: () => Promise.reject(failing('EIO'))}]
  ])('a failure at %s keeps the previous file and leaves no temporary file', async (_step, changes) => {
    const legacy = legacyIcon();
    await fsp.writeFile(target, legacy);
    expect(await placeInstalledIcon(wrapped(changes).system, installRoot, ICON, {delay: noDelay})).toBe('failed');
    expect(await fsp.readFile(target)).toEqual(legacy);
    expect(await temporaries()).toEqual([]);
  });

  it('retries a busy rename a bounded number of times', async () => {
    await fsp.writeFile(target, legacyIcon());
    const delays: number[] = [];
    let attempts = 0;
    const busy = wrapped({rename: () => {attempts++; return Promise.reject(failing('EBUSY'));}});
    expect(await placeInstalledIcon(busy.system, installRoot, ICON, {delay: milliseconds => {delays.push(milliseconds); return Promise.resolve();}})).toBe('failed');
    expect(attempts).toBe(ATOMIC_RENAME_RETRY_DELAYS_MS.length + 1);
    expect(delays).toEqual([...ATOMIC_RENAME_RETRY_DELAYS_MS]);
    expect(await fsp.readFile(target)).toEqual(legacyIcon());
    expect(await temporaries()).toEqual([]);
    let left = 2;
    const brief = wrapped({rename: (from, to) => left-- > 0 ? Promise.reject(failing('EBUSY')) : fs().rename(from, to)});
    expect(await placeInstalledIcon(brief.system, installRoot, ICON, {delay: noDelay})).toBe('replaced');
    expect(await fsp.readFile(target)).toEqual(ICON);
  });
});

describe('the icon file check', () => {
  it('accepts the product icon and refuses anything that is not a bounded icon file', () => {
    expect(validIcoBytes(ICON)).toBe(true);
    expect(validIcoBytes(legacyIcon())).toBe(true);
    expect(validIcoBytes(Buffer.from('not an icon at all'))).toBe(false);
    expect(validIcoBytes(Buffer.alloc(0))).toBe(false);
    const cursor = legacyIcon(); cursor.writeUInt16LE(2, 2);
    expect(validIcoBytes(cursor)).toBe(false);
    const outside = legacyIcon(); outside.writeUInt32LE(9, 14);
    expect(validIcoBytes(outside)).toBe(false);
    const none = legacyIcon(); none.writeUInt16LE(0, 4);
    expect(validIcoBytes(none)).toBe(false);
    const large = Buffer.concat([legacyIcon(), Buffer.alloc(MAX_ICON_BYTES)]);
    expect(validIcoBytes(large)).toBe(false);
  });
});

describe('DisplayIcon', () => {
  const roots = (version: string): Extract<UninstallRoots, {ok: true}> => ({ok: true, mode: 'production', base: 'C:\\Users\\fixture\\AppData\\Local',
    installRoot: `C:\\Users\\fixture\\AppData\\Local\\${PRODUCT_ROOT_NAME}`, appDirectory: `C:\\Users\\fixture\\AppData\\Local\\${PRODUCT_ROOT_NAME}\\app-${version}`,
    dataRoot: 'C:\\Users\\fixture\\AppData\\Local\\ETS2Telemetry'});

  it('names icon 0 of the executable in the versioned app folder, prereleases included', () => {
    expect(displayIconFor(roots('0.1.0'), 'ETS2TelemetryDesktop.exe')).toBe('C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe,0');
    expect(displayIconFor(roots('0.1.0-alpha1'), 'ETS2TelemetryDesktop.exe'))
      .toBe('C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.1.0-alpha1\\ETS2TelemetryDesktop.exe,0');
  });

  /** A fake execFile that records each call and answers with `exitCodes` in order (0 succeeds). */
  function fakeExec(exitCodes: number[] = [0]) {
    const calls: {file: string; args: readonly string[]; timeout: number; shell: boolean; windowsHide: boolean}[] = [];
    const execFile: ExecFilePort = (file, args, options, callback) => {
      calls.push({file, args, timeout: options.timeout, shell: options.shell, windowsHide: options.windowsHide});
      const code = exitCodes[Math.min(calls.length - 1, exitCodes.length - 1)];
      callback(code === 0 ? null : Object.assign(new Error('Command failed'), {code, killed: false}), Buffer.alloc(0), Buffer.alloc(0));
      return undefined;
    };
    return {execFile, calls};
  }
  const DATA = 'C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe,0';

  it('runs reg.exe add on this product\'s uninstall entry only, with the exact arguments, no shell and the given timeout', async () => {
    const {execFile, calls} = fakeExec();
    expect(await regExeUninstallEntry({SystemRoot: 'C:\\Windows'}, execFile).setDisplayIcon(DATA, 2000)).toBe(true);
    expect(uninstallEntryKey()).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ETS2TelemetryDesktop');
    expect(DISPLAY_ICON_VALUE).toBe('DisplayIcon');
    expect(calls).toEqual([{file: 'C:\\Windows\\System32\\reg.exe', args: ['add', uninstallEntryKey(), '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', DATA, '/f'],
      timeout: 2000, shell: false, windowsHide: true}]);
  });

  it.each([
    ['a quote', `"${DATA}"`],
    ['a line break', `${DATA}\r\n/v Other`],
    ['a NUL', `${DATA}\0`],
    ['a relative path', 'app-0.1.0\\ETS2TelemetryDesktop.exe,0'],
    ['another icon index', DATA.replace(/,0$/, ',1')],
    ['an icon file', 'C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\app.ico'],
    ['a UNC path', '\\\\server\\share\\ETS2TelemetryDesktop.exe,0'],
    ['an overlong value', `C:\\${'a'.repeat(1100)}\\ETS2TelemetryDesktop.exe,0`]
  ])('refuses data with %s without starting reg.exe', async (_name, data) => {
    const {execFile, calls} = fakeExec();
    expect(validDisplayIconData(data)).toBe(false);
    expect(await regExeUninstallEntry({SystemRoot: 'C:\\Windows'}, execFile).setDisplayIcon(data, 2000)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a failing reg.exe is retried once by the hook step, and DisplayIcon is written whatever the icon placement did', async () => {
    const installRoots = {...roots('0.1.0'), installRoot, appDirectory: path.win32.join(installRoot, 'app-0.1.0'), base: path.win32.dirname(installRoot)};
    const {execFile, calls} = fakeExec([1, 1]);
    const result = await registerInstalledIcon({roots: installRoots, fs: fs(), readBundledIcon: () => Promise.resolve(ICON), registry: regExeUninstallEntry({}, execFile),
      executableName: 'ETS2TelemetryDesktop.exe', delay: noDelay});
    expect(result).toEqual({icon: 'placed', displayIcon: 'failed'});
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.timeout === 2000)).toBe(true);
    // A blocked target still gets its DisplayIcon.
    await fsp.rm(target);
    await fsp.mkdir(target);
    const entry = fakeUninstallEntry();
    expect(await registerInstalledIcon({roots: installRoots, fs: fs(), readBundledIcon: () => Promise.resolve(ICON), registry: entry,
      executableName: 'ETS2TelemetryDesktop.exe', delay: noDelay})).toEqual({icon: 'target-blocked', displayIcon: 'set'});
    expect(entry.calls).toEqual([`${path.win32.join(installRoot, 'app-0.1.0', 'ETS2TelemetryDesktop.exe')},0`]);
  });

  it('skips DisplayIcon for an executable name that does not end in .exe', async () => {
    const entry = fakeUninstallEntry();
    const installRoots = {...roots('0.1.0'), installRoot, appDirectory: path.win32.join(installRoot, 'app-0.1.0'), base: path.win32.dirname(installRoot)};
    expect(await registerInstalledIcon({roots: installRoots, fs: fs(), readBundledIcon: () => Promise.resolve(ICON), registry: entry,
      executableName: 'electron', delay: noDelay})).toEqual({icon: 'placed', displayIcon: 'skipped'});
    expect(entry.calls).toEqual([]);
  });
});

describe('the production icon port', () => {
  const app: SquirrelApp = {getPath: () => 'C:\\unused', setPath: () => undefined, requestSingleInstanceLock: () => true, releaseSingleInstanceLock: () => undefined,
    getAppMetrics: () => []};
  const port = (resourcesPath: string) => productionSquirrelPorts({app, appVersion: '0.1.0', executable: 'C:\\unused\\ETS2TelemetryDesktop.exe', env: {},
    mainDirectory: resourcesPath, resourcesPath}).readBundledIcon();

  it('reads resources\\icon\\app.ico when it is a regular file within the bound, and nothing else', async () => {
    const resources = path.win32.join(guard.root, 'resources');
    const folder = path.win32.join(resources, 'icon'), file = path.win32.join(folder, 'app.ico');
    await expect(port(resources)).rejects.toMatchObject({code: 'ENOENT'});
    await fsp.mkdir(folder, {recursive: true});
    await fsp.writeFile(file, ICON);
    expect(Buffer.from((await port(resources))!)).toEqual(ICON);
    await fsp.writeFile(file, Buffer.alloc(MAX_ICON_BYTES + 1));
    expect(await port(resources)).toBeUndefined();
    await fsp.rm(file);
    const elsewhere = path.win32.join(guard.root, 'elsewhere');
    await fsp.mkdir(elsewhere);
    await fsp.symlink(elsewhere, file, 'junction');
    expect(await port(resources)).toBeUndefined();
  });
});
