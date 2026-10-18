import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {cancelDeferral, deferralReadme, writeDeferralReadme, type CancelFileSystem} from '../../apps/desktop/src/uninstall/deferral';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {exists, installFixture, KNOWN, listTree, type InstallFixture} from '../shared/uninstall-fixture';

// REG-017 (ET-018 U7 fallback): the README a deferred uninstall leaves and the cancelling that install, update and start
// run. Cancelling removes only the deferral's two files, never through a link.

let guard: GuardedRoot, fixture: InstallFixture, fs: CancelFileSystem;
beforeEach(async () => {
  guard = await guardedTempRoot('ets2telemetry-uninstall-deferral-');
  fixture = await installFixture(guard);
  fs = guard.fs;
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const uninstallDirectory = () => path.win32.join(fixture.dataRoot, 'uninstall');

it('the README names the folders, every hash, the reason and the data root, with Windows line endings', () => {
  const root = path.win32.join(fixture.testRoot, 'Games', 'ETS2');
  const text = deferralReadme(fixture.dataRoot, [{game: 'ets2', root, hashes: ['a'.repeat(64)]}], KNOWN, 'GAME_RUNNING');
  expect(text).toContain('Reason: GAME_RUNNING');
  expect(text).toContain(`ets2: ${path.win32.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll')}`);
  for (const hash of [...KNOWN, 'a'.repeat(64)]) expect(text).toContain(`  ${hash}`);
  expect(text).toContain(fixture.dataRoot);
  expect(text).not.toMatch(/[^\r]\n/);
});

it('writes no README without an intent', async () => {
  expect(await writeDeferralReadme(fs, fixture.dataRoot, 'GAME_RUNNING')).toBe(false);
  expect(await exists(uninstallDirectory())).toBe(false);
});

it('cancels: removes pending.json, README.txt and the then empty folder, and nothing else', async () => {
  await fsp.mkdir(uninstallDirectory(), {recursive: true});
  for (const name of ['pending.json', 'README.txt']) await fsp.writeFile(path.win32.join(uninstallDirectory(), name), 'x');
  await fsp.mkdir(path.win32.join(fixture.dataRoot, 'plugins'), {recursive: true});
  await fsp.writeFile(path.win32.join(fixture.dataRoot, 'plugins', 'setup.json'), '{}');
  expect(await cancelDeferral(fs, fixture.dataRoot)).toBe('cancelled');
  expect(await listTree(fixture.dataRoot)).toEqual(['plugins\\', 'plugins\\setup.json']);
  expect(await cancelDeferral(fs, fixture.dataRoot)).toBe('none');
});

it('keeps an unknown file in the uninstall folder, and the folder with it', async () => {
  await fsp.mkdir(uninstallDirectory(), {recursive: true});
  await fsp.writeFile(path.win32.join(uninstallDirectory(), 'pending.json'), 'x');
  await fsp.writeFile(path.win32.join(uninstallDirectory(), 'notes.txt'), 'mine');
  expect(await cancelDeferral(fs, fixture.dataRoot)).toBe('cancelled');
  expect(await listTree(uninstallDirectory())).toEqual(['notes.txt']);
});

it('never follows a linked uninstall folder and never removes a README that is not a regular file', async () => {
  const outside = path.win32.join(fixture.testRoot, 'outside');
  await fsp.mkdir(outside, {recursive: true});
  await fsp.writeFile(path.win32.join(outside, 'pending.json'), 'sentinel');
  await guard.fs.symlink(outside, uninstallDirectory(), 'junction');
  expect(await cancelDeferral(fs, fixture.dataRoot)).toBe('failed');
  expect(await fsp.readFile(path.win32.join(outside, 'pending.json'), 'utf8')).toBe('sentinel');

  await fsp.unlink(uninstallDirectory());
  await fsp.mkdir(path.win32.join(uninstallDirectory(), 'README.txt'), {recursive: true});
  await fsp.writeFile(path.win32.join(uninstallDirectory(), 'pending.json'), 'x');
  expect(await cancelDeferral(fs, fixture.dataRoot)).toBe('failed');
  expect(await listTree(uninstallDirectory())).toEqual(['README.txt\\']);
});
