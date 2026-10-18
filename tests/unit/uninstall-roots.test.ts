import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {parseInstallTestFile, resolveUninstallRoots, type RootsFileSystem} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {installFixture, type InstallFixture} from '../shared/uninstall-fixture';

// REG-017 (ET-018 U3): the uninstall roots come from the running executable's install location, never from LOCALAPPDATA
// alone. Fake installs under the guarded temporary root; the environment is a hand-written object, never process.env.

let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-uninstall-roots-');});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const fs = () => guard.fs as unknown as RootsFileSystem;
const resolve = (executable: string, env: Record<string, string | undefined> = {}) => resolveUninstallRoots({executable, env, fs: fs()});

describe('test-root mode', () => {
  it('derives the app folder, install root, base and data root of an installed layout', async () => {
    const fixture = await installFixture(guard);
    expect(await resolve(fixture.executable)).toEqual({ok: true, mode: 'test-root', appDirectory: path.win32.dirname(fixture.executable), installRoot: fixture.installRoot,
      base: fixture.base, dataRoot: fixture.dataRoot, testRoot: fixture.testRoot,
      testFile: {profileDir: path.win32.join(fixture.testRoot, 'profile'), runOnceKey: null, shortcuts: false}});
  });
  it('ignores the LOCALAPPDATA variable entirely, whatever it names', async () => {
    const fixture = await installFixture(guard);
    const other = path.win32.join(guard.root, 'elsewhere');
    await fsp.mkdir(other);
    for (const env of [{LOCALAPPDATA: other}, {LOCALAPPDATA: undefined}, {LOCALAPPDATA: 'relative'}]) {
      expect(await resolve(fixture.executable, env)).toMatchObject({ok: true, mode: 'test-root', dataRoot: fixture.dataRoot});
    }
  });
  it.each([
    ['the marker without the test file', async (fixture: InstallFixture) => fsp.rm(path.win32.join(fixture.testRoot, 'ets2telemetry-install-test.json'))],
    ['the test file without the marker', async (fixture: InstallFixture) => fsp.rm(path.win32.join(fixture.testRoot, 'ets2telemetry-plugin-test-root.marker'))],
    ['a profile outside the test root', async (fixture: InstallFixture) => fsp.writeFile(path.win32.join(fixture.testRoot, 'ets2telemetry-install-test.json'),
      JSON.stringify({format: 'ets2telemetry.install-test', version: 1, profileDir: path.win32.join(guard.root, 'profile'), runOnceKey: null, shortcuts: false}))],
    ['a test file that is not JSON', async (fixture: InstallFixture) => fsp.writeFile(path.win32.join(fixture.testRoot, 'ets2telemetry-install-test.json'), 'not json')],
    ['a marker that is a folder', async (fixture: InstallFixture) => {
      await fsp.rm(path.win32.join(fixture.testRoot, 'ets2telemetry-plugin-test-root.marker'));
      await fsp.mkdir(path.win32.join(fixture.testRoot, 'ets2telemetry-plugin-test-root.marker'));
    }]
  ])('refuses %s as TEST_ROOT_INVALID, never as production', async (_name, change) => {
    const fixture = await installFixture(guard);
    await change(fixture);
    expect(await resolve(fixture.executable, {LOCALAPPDATA: fixture.base})).toEqual({ok: false, code: 'TEST_ROOT_INVALID'});
  });
  it.each([
    ['extra key', {format: 'ets2telemetry.install-test', version: 1, profileDir: 'X:\\run\\profile', runOnceKey: null, shortcuts: false, extra: 1}],
    ['version 2', {format: 'ets2telemetry.install-test', version: 2, profileDir: 'X:\\run\\profile', runOnceKey: null, shortcuts: false}],
    ['a RunOnce key outside the test namespace', {format: 'ets2telemetry.install-test', version: 1, profileDir: 'X:\\run\\profile',
      runOnceKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', shortcuts: false}],
    ['the profile equal to the test root', {format: 'ets2telemetry.install-test', version: 1, profileDir: 'X:\\run', runOnceKey: null, shortcuts: false}]
  ])('rejects an installer test file with %s', (_name, document) => {
    expect(parseInstallTestFile(Buffer.from(JSON.stringify(document)), 'X:\\run')).toBeUndefined();
  });
});

describe('production mode', () => {
  it('requires LOCALAPPDATA to name the base, by real location', async () => {
    const fixture = await installFixture(guard, {testRoot: false});
    expect(await resolve(fixture.executable, {LOCALAPPDATA: fixture.base})).toMatchObject({ok: true, mode: 'production', dataRoot: fixture.dataRoot});
    expect(await resolve(fixture.executable, {LOCALAPPDATA: `${fixture.base.toUpperCase()}\\`})).toMatchObject({ok: true, mode: 'production'});
    // A junction to the base names the same folder.
    const alias = path.win32.join(guard.root, 'alias');
    await guard.fs.symlink(fixture.base, alias, 'junction');
    expect(await resolve(fixture.executable, {LOCALAPPDATA: alias})).toMatchObject({ok: true, mode: 'production'});
  });
  it('refuses another LOCALAPPDATA, a missing one or one that does not exist as ROOT_MISMATCH', async () => {
    const fixture = await installFixture(guard, {testRoot: false});
    const other = path.win32.join(guard.root, 'other');
    await fsp.mkdir(other);
    for (const LOCALAPPDATA of [other, undefined, '', 'relative\\path', path.win32.join(guard.root, 'missing')]) {
      expect(await resolve(fixture.executable, {LOCALAPPDATA})).toEqual({ok: false, code: 'ROOT_MISMATCH'});
    }
  });
});

describe('refusals', () => {
  it('refuses a linked data root', async () => {
    const fixture = await installFixture(guard);
    const outside = path.win32.join(guard.root, 'outside-data');
    await fsp.mkdir(outside);
    await fsp.rm(fixture.dataRoot, {recursive: true});
    await guard.fs.symlink(outside, fixture.dataRoot, 'junction');
    expect(await resolve(fixture.executable)).toEqual({ok: false, code: 'DATA_ROOT_LINKED'});
  });
  it('refuses a linked base', async () => {
    const fixture = await installFixture(guard, {name: 'real-run'});
    const linkedBase = path.win32.join(guard.root, 'linked', 'LocalAppData');
    await fsp.mkdir(path.win32.dirname(linkedBase));
    await guard.fs.symlink(fixture.base, linkedBase, 'junction');
    expect(await resolve(path.win32.join(linkedBase, 'ETS2TelemetryDesktop', 'app-0.1.0', 'ETS2TelemetryDesktop.exe'))).toEqual({ok: false, code: 'LAYOUT_INVALID'});
  });
  it('refuses a bare drive as the base before reading anything', async () => {
    expect(await resolve('C:\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe', {LOCALAPPDATA: 'C:\\'})).toEqual({ok: false, code: 'LAYOUT_INVALID'});
  });
  it.each([
    ['a portable package', (fixture: InstallFixture) => path.win32.join(fixture.testRoot, 'out', 'ETS2Telemetry Desktop-win32-x64', 'ETS2TelemetryDesktop.exe')],
    ['an app folder without a version', (fixture: InstallFixture) => path.win32.join(fixture.installRoot, 'app-latest', 'ETS2TelemetryDesktop.exe')],
    ['another install root name', (fixture: InstallFixture) => path.win32.join(fixture.base, 'ETS2Telemetry Desktop', 'app-0.1.0', 'ETS2TelemetryDesktop.exe')],
    ['a missing app folder', (fixture: InstallFixture) => path.win32.join(fixture.installRoot, 'app-0.2.0', 'ETS2TelemetryDesktop.exe')],
    ['a UNC path', () => '\\\\server\\share\\LocalAppData\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe'],
    ['a relative path', () => 'ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe']
  ])('refuses %s as NOT_INSTALLED', async (_name, executable) => {
    const fixture = await installFixture(guard);
    expect(await resolve(executable(fixture), {LOCALAPPDATA: fixture.base})).toEqual({ok: false, code: 'NOT_INSTALLED'});
  });
  it('refuses an install root without a regular Update.exe', async () => {
    const fixture = await installFixture(guard);
    await fsp.rm(path.win32.join(fixture.installRoot, 'Update.exe'));
    expect(await resolve(fixture.executable)).toEqual({ok: false, code: 'NOT_INSTALLED'});
    await fsp.mkdir(path.win32.join(fixture.installRoot, 'Update.exe'));
    expect(await resolve(fixture.executable)).toEqual({ok: false, code: 'NOT_INSTALLED'});
  });
});
