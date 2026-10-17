import {mkdir, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {gameRootFromSelection, validateManualFolder, type ManualFolderContext} from '../../apps/desktop/src/plugin-setup/game-folder';
import type {PluginReadFileSystem} from '../../apps/desktop/src/plugin-setup/steam-discovery';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeSteam, type FakeSteam} from '../shared/fake-steam';

// REG-015 (ET-017 P4): validation and normalization of a game folder the user chose. Everything runs on fake folders
// under a guarded temporary root; the refusal codes are written by hand from P4.

let guard: GuardedRoot;
let steam: FakeSteam;
let ets2: string;
beforeEach(async () => {
  guard = await guardedTempRoot();
  steam = await fakeSteam(guard.root);
  ets2 = await steam.gameFolder(path.win32.join(guard.root, 'Games', 'ETS2 manual'), 'ets2', {plugins: true});
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const context = (overrides: Partial<ManualFolderContext> = {}): ManualFolderContext => ({
  fs: guard.fs,
  dataRoot: path.win32.join(guard.root, 'LocalAppData', 'ETS2Telemetry'),
  installDirectory: path.win32.join(guard.root, 'Programs', 'ETS2Telemetry'),
  steamRoots: [],
  ...overrides
});

describe('normalization', () => {
  it('maps the root, bin, bin\\win_x64 and bin\\win_x64\\plugins to the canonical root, in any case and separator', async () => {
    for (const selected of [ets2, `${ets2}\\`, path.win32.join(ets2, 'bin'), path.win32.join(ets2, 'BIN', 'Win_X64'), path.win32.join(ets2, 'bin', 'win_x64', 'Plugins'),
      `${ets2.replaceAll('\\', '/')}/bin/win_x64/`, ets2.toUpperCase().replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)]) {
      const result = await validateManualFolder(selected, 'ets2', context());
      expect([selected, result]).toEqual([selected, expect.objectContaining({ok: true, root: ets2})]);
    }
  });

  it('normalizes only by exact tail components', () => {
    expect(gameRootFromSelection('D:\\Games\\ETS2\\bin\\win_x64\\plugins')).toBe('D:\\Games\\ETS2');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\bin\\win_x64')).toBe('D:\\Games\\ETS2');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\bin')).toBe('D:\\Games\\ETS2');
    expect(gameRootFromSelection('D:\\bin')).toBe('D:\\');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\binary')).toBe('D:\\Games\\ETS2\\binary');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\win_x64')).toBe('D:\\Games\\ETS2\\win_x64');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\plugins')).toBe('D:\\Games\\ETS2\\plugins');
    expect(gameRootFromSelection('D:\\Games\\ETS2\\bin\\win_x86')).toBe('D:\\Games\\ETS2\\bin\\win_x86');
  });

  it('accepts a root whose plugin target is not a regular file, for the installer to report', async () => {
    await mkdir(path.win32.join(ets2, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll'));
    const result = await validateManualFolder(ets2, 'ets2', context());
    expect(result.ok && result.layout.status).toBe('unexpected-entry');
  });
});

describe('refusals', () => {
  it.each([
    '\\\\server\\share\\Euro Truck Simulator 2',
    '//server/share/ETS2',
    '\\\\?\\C:\\Games\\ETS2',
    '\\\\.\\C:\\Games\\ETS2',
    '\\??\\C:\\Games\\ETS2',
    'Games\\ETS2',
    'C:Games\\ETS2',
    '\\Games\\ETS2',
    'C:\\Games\\ETS2:stream',
    ''
  ])('refuses %j as FOLDER_UNSUPPORTED_PATH without touching the file system', async selected => {
    const calls = vi.fn();
    const fs: PluginReadFileSystem = {
      lstat: (...args) => {calls(...args); return guard.fs.lstat(...args);},
      stat: (...args) => {calls(...args); return guard.fs.stat(...args);},
      realpath: target => {calls(target); return guard.fs.realpath(target);},
      open: (...args) => {calls(...args); return guard.fs.open(...args);}
    };
    expect(await validateManualFolder(selected, 'ets2', context({fs, dataRoot: undefined, installDirectory: undefined}))).toEqual({ok: false, code: 'FOLDER_UNSUPPORTED_PATH'});
    expect(calls).not.toHaveBeenCalled();
  });

  it('refuses a game layout inside the data folder or the install folder, also through a junction', async () => {
    const dataRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2Telemetry');
    const inData = await steam.gameFolder(path.win32.join(dataRoot, 'plugins', 'Copy'), 'ets2');
    const inInstall = await steam.gameFolder(path.win32.join(guard.root, 'Programs', 'ETS2Telemetry', 'app-0.1.0'), 'ets2');
    const alias = path.win32.join(guard.root, 'Alias');
    await symlink(path.win32.join(dataRoot, 'plugins'), alias, 'junction');
    for (const selected of [inData, path.win32.join(inData, 'bin'), dataRoot, inInstall, path.win32.join(alias, 'Copy'), path.win32.join(alias, 'Copy', 'bin', 'win_x64'),
      inData.toUpperCase().replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)]) {
      expect([selected, await validateManualFolder(selected, 'ets2', context())]).toEqual([selected, {ok: false, code: 'FOLDER_UNSUPPORTED_PATH'}]);
    }
  });

  it('refuses the data folder lexically before it exists', async () => {
    const dataRoot = path.win32.join(guard.root, 'NotCreated', 'ETS2Telemetry');
    expect(await validateManualFolder(path.win32.join(dataRoot, 'Game'), 'ets2', context({dataRoot}))).toEqual({ok: false, code: 'FOLDER_UNSUPPORTED_PATH'});
  });

  it('refuses a folder of the other game as FOLDER_WRONG_GAME', async () => {
    const ats = await steam.gameFolder(path.win32.join(guard.root, 'Games', 'ATS'), 'ats');
    expect(await validateManualFolder(ats, 'ets2', context())).toEqual({ok: false, code: 'FOLDER_WRONG_GAME'});
    expect(await validateManualFolder(path.win32.join(ats, 'bin', 'win_x64'), 'ets2', context())).toEqual({ok: false, code: 'FOLDER_WRONG_GAME'});
    expect(await validateManualFolder(ets2, 'ats', context())).toEqual({ok: false, code: 'FOLDER_WRONG_GAME'});
    expect((await validateManualFolder(ats, 'ats', context())).ok).toBe(true);
  });

  it('refuses folders without the 64-bit executable, missing folders and files as FOLDER_NOT_GAME', async () => {
    const empty = path.win32.join(guard.root, 'Empty');
    await mkdir(path.win32.join(empty, 'bin', 'win_x64'), {recursive: true});
    const executableFolder = path.win32.join(guard.root, 'ExeFolder');
    await mkdir(path.win32.join(executableFolder, 'bin', 'win_x64', 'eurotrucks2.exe'), {recursive: true});
    const file = path.win32.join(guard.root, 'file.txt');
    await writeFile(file, 'text');
    for (const selected of [empty, executableFolder, path.win32.join(guard.root, 'Missing'), file, path.win32.join(guard.root, 'Missing', 'bin', 'win_x64')]) {
      expect([selected, await validateManualFolder(selected, 'ets2', context())]).toEqual([selected, {ok: false, code: 'FOLDER_NOT_GAME'}]);
    }
  });

  it('refuses a junction under bin as FOLDER_LINKED', async () => {
    const real = await steam.gameFolder(path.win32.join(guard.root, 'RealGame'), 'ets2', {plugins: true});
    const linkedWin64 = path.win32.join(guard.root, 'LinkedWin64');
    await mkdir(path.win32.join(linkedWin64, 'bin'), {recursive: true});
    await symlink(path.win32.join(real, 'bin', 'win_x64'), path.win32.join(linkedWin64, 'bin', 'win_x64'), 'junction');
    const linkedBin = path.win32.join(guard.root, 'LinkedBin');
    await mkdir(linkedBin);
    await symlink(path.win32.join(real, 'bin'), path.win32.join(linkedBin, 'bin'), 'junction');
    const linkedPlugins = await steam.gameFolder(path.win32.join(guard.root, 'LinkedPlugins'), 'ets2');
    await symlink(path.win32.join(real, 'bin', 'win_x64', 'plugins'), path.win32.join(linkedPlugins, 'bin', 'win_x64', 'plugins'), 'junction');
    for (const selected of [linkedWin64, path.win32.join(linkedWin64, 'bin', 'win_x64'), linkedBin, linkedPlugins, path.win32.join(linkedPlugins, 'bin', 'win_x64', 'plugins')]) {
      expect([selected, await validateManualFolder(selected, 'ets2', context())]).toEqual([selected, {ok: false, code: 'FOLDER_LINKED'}]);
    }
  });

  it('stores the canonical root of a game folder chosen through a junction', async () => {
    const alias = path.win32.join(guard.root, 'GameAlias');
    await symlink(ets2, alias, 'junction');
    expect(await validateManualFolder(path.win32.join(alias, 'bin'), 'ets2', context())).toEqual(expect.objectContaining({ok: true, root: ets2}));
  });

  it('refuses a Steam root chosen again as FOLDER_DUPLICATE, by file identity', async () => {
    const steamRoot = await steam.install(steam.steam, 'ets2');
    const alias = path.win32.join(guard.root, 'SteamAlias');
    await symlink(steamRoot, alias, 'junction');
    for (const selected of [steamRoot, path.win32.join(steamRoot, 'bin', 'win_x64'), alias]) {
      expect([selected, await validateManualFolder(selected, 'ets2', context({steamRoots: [steamRoot]}))]).toEqual([selected, {ok: false, code: 'FOLDER_DUPLICATE'}]);
    }
    expect((await validateManualFolder(ets2, 'ets2', context({steamRoots: [steamRoot, path.win32.join(guard.root, 'GoneSteamRoot')]}))).ok).toBe(true);
  });
});
