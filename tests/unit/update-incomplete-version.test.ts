import {mkdir, readdir, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {removeIncompleteVersion, type UpdateFileSystem} from '../../apps/desktop/src/updater/update-download';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// ET-055 risk R1 (REG-019; hosted run 40710991951): after a killed apply the half-written app-<version> folder made the
// installation unlaunchable, because the pinned Squirrel writes no completion marker and its stub starts the highest
// app-* folder. removeIncompleteVersion removes exactly that target folder and nothing else. Every case runs in a guarded
// temporary root; expected results are written by hand.

let guard: GuardedRoot;
let installRoot: string;
const fs = () => guard.fs as unknown as UpdateFileSystem;
beforeEach(async () => {
  guard = await guardedTempRoot('ets2telemetry-incomplete-version-');
  installRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2TelemetryDesktopStaging');
  for (const version of ['0.1.0-stg000000', '0.1.1-stg000000', '0.1.2-stg000000', '0.1.2-stg000000-extra']) {
    await mkdir(path.win32.join(installRoot, `app-${version}`, 'resources'), {recursive: true});
    await writeFile(path.win32.join(installRoot, `app-${version}`, 'ETS2TelemetryDesktopStaging.exe'), 'MZ');
  }
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const running = () => path.win32.join(installRoot, 'app-0.1.1-stg000000');
const apps = async () => (await readdir(installRoot)).sort();

it('removes exactly the target version folder, whatever it holds, and keeps every other folder', async () => {
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.2-stg000000', running())).toBe('removed');
  // A folder whose name only starts with the target's is another folder.
  expect(await apps()).toEqual(['app-0.1.0-stg000000', 'app-0.1.1-stg000000', 'app-0.1.2-stg000000-extra']);
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.2-stg000000', running())).toBe('absent');
});

it('never removes the folder the application runs from or one that contains it', async () => {
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.1-stg000000', running())).toBe('refused');
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.1-stg000000', `${running().toUpperCase()}\\`)).toBe('refused');
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.1-stg000000', path.win32.join(running(), 'resources'))).toBe('refused');
  expect(await apps()).toContain('app-0.1.1-stg000000');
});

it('refuses a version that is not one NuGet version, and relative roots', async () => {
  for (const version of ['..', '0.1.2\\..\\..', '0.1.2/x', '', 'v0.1.2', '0.1'])
    expect(await removeIncompleteVersion(fs(), installRoot, version, running()), version).toBe('refused');
  expect(await removeIncompleteVersion(fs(), 'LocalAppData\\ETS2TelemetryDesktopStaging', '0.1.2-stg000000', running())).toBe('refused');
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.2-stg000000', 'app-0.1.1-stg000000')).toBe('refused');
  expect(await apps()).toHaveLength(4);
});

it('unlinks a target that is a junction without entering it', async () => {
  const outside = path.win32.join(guard.root, 'outside');
  await mkdir(outside);
  await writeFile(path.win32.join(outside, 'kept.txt'), 'kept');
  await mkdir(path.win32.join(installRoot, 'app-0.1.3-stg000000-link-parent'));
  await symlink(outside, path.win32.join(installRoot, 'app-0.1.3-stg000000'), 'junction');
  expect(await removeIncompleteVersion(fs(), installRoot, '0.1.3-stg000000', running())).toBe('removed');
  expect(await readdir(outside)).toEqual(['kept.txt']);
  expect(await apps()).not.toContain('app-0.1.3-stg000000');
});

it('reports a folder it could not remove completely as failed', async () => {
  const held: UpdateFileSystem = {...fs(), unlink: () => Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'}))};
  expect(await removeIncompleteVersion(held, installRoot, '0.1.2-stg000000', running())).toBe('failed');
  expect(await apps()).toContain('app-0.1.2-stg000000');
});
