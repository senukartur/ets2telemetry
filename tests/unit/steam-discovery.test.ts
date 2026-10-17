import {mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {discoverSteamGames, MAX_APP_MANIFEST_BYTES, validateGameLayout, type PluginReadFileSystem, type SteamDiscovery,
  type SteamRootResult} from '../../apps/desktop/src/plugin-setup/steam-discovery';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeSteam, type FakeSteam} from '../shared/fake-steam';

// REG-015 (ET-017 P2, P3): Steam library discovery on fake Steam installations under a guarded temporary root. No
// test reads the registry or a real Steam or game folder; the guard fails a test that resolves any path outside its
// root, even when the code under test catches the error. Expected roots are written by hand from the fake layout.

let guard: GuardedRoot;
let steam: FakeSteam;
const ETS2 = 'Euro Truck Simulator 2', ATS = 'American Truck Simulator';
beforeEach(async () => {
  guard = await guardedTempRoot();
  steam = await fakeSteam(guard.root);
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const found = (located: string = steam.steam): () => Promise<SteamRootResult> => () => Promise.resolve({kind: 'found', path: located});
const discover = (options: {steamRoot?: () => Promise<SteamRootResult>; fs?: PluginReadFileSystem; log?: (event: string, detail?: unknown, facts?: unknown) => void} = {}) =>
  discoverSteamGames({steamRoot: options.steamRoot ?? found(), fs: options.fs ?? guard.fs, now: () => 1_800_000_000_000, log: options.log});
const roots = (result: SteamDiscovery, game: 'ets2' | 'ats') => result.games[game].roots.map(root => ({library: root.library, root: root.root, status: root.status}));
const common = (library: string, folder: string) => path.win32.join(library, 'steamapps', 'common', folder);

describe('libraries', () => {
  it('finds ETS2 in the Steam root alone; ATS is not found', async () => {
    await steam.install(steam.steam, 'ets2');
    const result = await discover();
    expect(result.steam).toBe('found');
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam]);
    expect(result.games.ets2.outcome).toBe('found');
    expect(roots(result, 'ets2')).toEqual([{library: 0, root: common(steam.steam, ETS2), status: 'ready'}]);
    expect(result.games.ats).toEqual({outcome: 'not-found', roots: []});
    expect(result.observedAt).toBe(1_800_000_000_000);
    expect(result.facts).toMatchObject({libraryList: 'absent', libraries: 1, ets2: 'found', ats: 'not-found'});
  });

  it('finds ETS2 and ATS in two different libraries of the current format', async () => {
    const a = await steam.library('LibraryA'), b = await steam.library('LibraryB');
    await steam.libraryFolders([steam.steam, a, b]);
    await steam.install(a, 'ets2', {plugins: true});
    await steam.install(b, 'ats');
    const result = await discover();
    expect(result.libraries.map(library => [library.ordinal, library.path])).toEqual([[0, steam.steam], [1, a], [2, b]]);
    expect(roots(result, 'ets2')).toEqual([{library: 1, root: common(a, ETS2), status: 'ready'}]);
    expect(roots(result, 'ats')).toEqual([{library: 2, root: common(b, ATS), status: 'ready'}]);
    const [ets2] = result.games.ets2.roots;
    expect(ets2).toMatchObject({executable: path.win32.join(common(a, ETS2), 'bin', 'win_x64', 'eurotrucks2.exe'), pluginsExists: true, targetExists: false,
      target: path.win32.join(common(a, ETS2), 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll')});
    expect(result.games.ats.roots[0]).toMatchObject({pluginsExists: false, targetExists: false});
  });

  it('reads three libraries of the legacy format, with the Steam root as library 0 although the file omits it', async () => {
    const a = await steam.library('One'), b = await steam.library('Two'), c = await steam.library('Three');
    await steam.libraryFolders([a, b, c], {format: 'legacy'});
    await steam.install(c, 'ets2');
    await steam.install(b, 'ats');
    const result = await discover();
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam, a, b, c]);
    expect(roots(result, 'ets2')).toEqual([{library: 3, root: common(c, ETS2), status: 'ready'}]);
    expect(roots(result, 'ats')).toEqual([{library: 2, root: common(b, ATS), status: 'ready'}]);
  });

  it('reports at most four Steam roots per game, in library order, and counts the rest', async () => {
    const extra = [await steam.library('L1'), await steam.library('L2'), await steam.library('L3'), await steam.library('L4')];
    await steam.libraryFolders([steam.steam, ...extra]);
    for (const library of [steam.steam, ...extra]) await steam.install(library, 'ets2');
    const result = await discover();
    expect(result.libraries.map(library => library.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(roots(result, 'ets2')).toEqual([
      {library: 0, root: common(steam.steam, ETS2), status: 'ready'},
      {library: 1, root: common(extra[0], ETS2), status: 'ready'},
      {library: 2, root: common(extra[1], ETS2), status: 'ready'},
      {library: 3, root: common(extra[2], ETS2), status: 'ready'}
    ]);
    expect(result.facts).toMatchObject({truncatedRoots: 1, duplicateRoots: 0, ets2: 'found'});
  });

  it('falls back to config\\libraryfolders.vdf when steamapps has none', async () => {
    const b = await steam.library('ConfigListed');
    await steam.libraryFolders([steam.steam, b], {location: 'config'});
    await steam.install(b, 'ats');
    const result = await discover();
    expect(result.facts).toMatchObject({libraryList: 'ok'});
    expect(roots(result, 'ats')).toEqual([{library: 1, root: common(b, ATS), status: 'ready'}]);
  });

  it('prefers steamapps\\libraryfolders.vdf over the config copy', async () => {
    const listed = await steam.library('Listed'), stale = await steam.library('Stale');
    await steam.libraryFolders([listed]);
    await steam.libraryFolders([stale], {location: 'config'});
    await steam.install(stale, 'ets2');
    const result = await discover();
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam, listed]);
    expect(result.games.ets2.outcome).toBe('not-found');
  });

  it('deduplicates a library listed again through a junction, by file identity', async () => {
    const a = await steam.library('Real');
    const alias = path.win32.join(guard.root, 'Alias');
    await symlink(a, alias, 'junction');
    await steam.libraryFolders([steam.steam, a, alias, a.toUpperCase().replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)]);
    await steam.install(a, 'ets2');
    const result = await discover();
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam, a]);
    expect(result.facts).toMatchObject({duplicateLibraries: 3});
    expect(roots(result, 'ets2')).toEqual([{library: 1, root: common(a, ETS2), status: 'ready'}]);
  });

  it('lists a junction-only library by its canonical target', async () => {
    const real = await steam.library('MovedLibrary');
    const alias = path.win32.join(guard.root, 'Junction');
    await symlink(real, alias, 'junction');
    await steam.libraryFolders([steam.steam, alias]);
    await steam.install(real, 'ats');
    const result = await discover();
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam, real]);
    expect(roots(result, 'ats')).toEqual([{library: 1, root: common(real, ATS), status: 'ready'}]);
  });

  it('skips a library on a missing drive and keeps the others', async () => {
    // The drive is simulated: every call for Q: answers ENOENT without reaching the operating system.
    const missingDrive = (fs: PluginReadFileSystem): PluginReadFileSystem => {
      const absent = (target: string) => /^q:/i.test(target) ? Promise.reject(Object.assign(new Error('missing drive'), {code: 'ENOENT'})) : undefined;
      return {
        lstat: (target, options) => absent(target) ?? fs.lstat(target, options),
        stat: (target, options) => absent(target) ?? fs.stat(target, options),
        realpath: target => absent(target) ?? fs.realpath(target),
        open: (target, flags) => absent(target) ?? fs.open(target, flags)
      };
    };
    const b = await steam.library('Present');
    await steam.libraryFolders([steam.steam, 'Q:\\SteamLibrary', b]);
    await steam.install(b, 'ets2');
    const result = await discover({fs: missingDrive(guard.fs)});
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam, b]);
    expect(result.facts).toMatchObject({missingLibraries: 1, libraryList: 'ok'});
    expect(result.games.ets2.outcome).toBe('found');
  });

  it('never touches a UNC or device library path', async () => {
    const lstat = vi.fn(guard.fs.lstat), realpath = vi.fn(guard.fs.realpath);
    await steam.libraryFolders([steam.steam, '\\\\server\\share\\Steam', '\\\\?\\C:\\Steam', '\\\\.\\C:\\Steam']);
    const result = await discover({fs: {...guard.fs, lstat, realpath} as PluginReadFileSystem});
    expect(result.facts).toMatchObject({rejectedLibraries: 3, libraries: 1});
    for (const call of [...lstat.mock.calls, ...realpath.mock.calls]) expect(String(call[0])).not.toMatch(/^\\\\/);
  });
});

describe('manifests', () => {
  it('treats a manifest whose game folder is missing as stale', async () => {
    await steam.install(steam.steam, 'ets2', {layout: false});
    const result = await discover();
    expect(result.games.ets2).toEqual({outcome: 'not-found', roots: []});
    expect(result.facts).toMatchObject({staleManifests: 1});
  });

  it('treats a folder without the 64-bit executable as stale', async () => {
    const root = await steam.install(steam.steam, 'ats', {layout: false});
    await mkdir(path.win32.join(root, 'bin', 'win_x86'), {recursive: true});
    await writeFile(path.win32.join(root, 'bin', 'win_x86', 'amtrucks.exe'), 'x86 only');
    expect((await discover()).games.ats.outcome).toBe('not-found');
  });

  it('refuses a manifest whose appid does not match its file name', async () => {
    await steam.install(steam.steam, 'ets2', {manifest: '"AppState" { "appid" "270880" "installdir" "Euro Truck Simulator 2" }'});
    const result = await discover();
    expect(result.games.ets2.outcome).toBe('not-found');
    expect(result.facts).toMatchObject({invalidManifests: 1});
  });

  it('ignores StateFlags', async () => {
    await steam.install(steam.steam, 'ets2', {manifest: '"AppState" { "appid" "227300" "StateFlags" "1026" "installdir" "Euro Truck Simulator 2" }'});
    expect((await discover()).games.ets2.outcome).toBe('found');
  });

  it.each([
    ['..\\Escaped', path.win32.join('steamapps', 'Escaped')],
    ['..', 'steamapps'],
    ['Nested\\Game', path.win32.join('steamapps', 'common', 'Nested', 'Game')],
    ['Nested/Game', path.win32.join('steamapps', 'common', 'Nested', 'Game')],
    ['C:', null],
    ['C:\\Games\\ETS2', null],
    ['CON', null],
    ['Game.', null],
    ['', null]
  ])('refuses installdir %j even when a game layout exists where it points', async (installdir, planted) => {
    const library = await steam.library('Traversal');
    await steam.libraryFolders([steam.steam, library]);
    // A real game layout where the traversal would land, so accepting the name would report it as found.
    if (planted) await steam.gameFolder(path.win32.join(library, planted), 'ets2');
    await steam.install(library, 'ets2', {layout: false, manifest: `"AppState" { "appid" "227300" "installdir" "${installdir.replaceAll('\\', '\\\\')}" }`});
    const result = await discover();
    expect(result.games.ets2).toEqual({outcome: 'not-found', roots: []});
    expect(result.facts).toMatchObject({invalidManifests: 1});
  });

  it(`refuses a manifest over ${MAX_APP_MANIFEST_BYTES} bytes and a manifest that is a folder`, async () => {
    const valid = '"AppState" { "appid" "227300" "installdir" "Euro Truck Simulator 2" }';
    await steam.install(steam.steam, 'ets2', {manifest: valid + ' '.repeat(MAX_APP_MANIFEST_BYTES - valid.length + 1)});
    expect((await discover()).games.ets2.outcome).toBe('not-found');
    await steam.install(steam.steam, 'ets2', {manifest: valid + ' '.repeat(MAX_APP_MANIFEST_BYTES - valid.length)});
    expect((await discover()).games.ets2.outcome).toBe('found');
    const manifest = path.win32.join(steam.steam, 'steamapps', 'appmanifest_270880.acf');
    await mkdir(manifest);
    await steam.gameFolder(common(steam.steam, ATS), 'ats');
    expect((await discover()).games.ats.outcome).toBe('not-found');
  });

  it('reports a game root reached through a junction once, by its canonical path', async () => {
    const real = path.win32.join(guard.root, 'Elsewhere', ETS2);
    await steam.gameFolder(real, 'ets2');
    const a = await steam.library('A');
    await steam.libraryFolders([steam.steam, a]);
    await steam.install(steam.steam, 'ets2', {layout: false});
    await steam.install(a, 'ets2', {layout: false});
    await symlink(real, common(steam.steam, ETS2), 'junction');
    await symlink(real, common(a, ETS2), 'junction');
    const result = await discover();
    expect(roots(result, 'ets2')).toEqual([{library: 0, root: real, status: 'ready'}]);
    expect(result.facts).toMatchObject({duplicateRoots: 1});
  });
});

describe('Steam root and list failures', () => {
  it('reports steam-not-found for both games without Steam, after a failed registry read, and for a missing Steam folder', async () => {
    const lstat = vi.fn(guard.fs.lstat);
    for (const [steamRoot, reason] of [
      [() => Promise.resolve({kind: 'not-found'} as const), 'not-installed'],
      [() => Promise.resolve({kind: 'failed', code: 'STEAM_REGISTRY_TIMEOUT'} as const), 'STEAM_REGISTRY_TIMEOUT'],
      [found(path.win32.join(guard.root, 'NoSteamHere')), 'root-missing']
    ] as const) {
      const result = await discover({steamRoot, fs: {...guard.fs, lstat} as PluginReadFileSystem});
      expect(result.games).toEqual({ets2: {outcome: 'steam-not-found', roots: []}, ats: {outcome: 'steam-not-found', roots: []}});
      expect(result.libraries).toEqual([]);
      expect(result.facts).toEqual({steam: 'not-found', reason});
    }
    expect(lstat).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed text', '"libraryfolders" { "0" { "path" '],
    ['a missing top key', '"other" { }'],
    ['invalid UTF-8', Buffer.from([0x22, 0xff, 0x22])]
  ])('falls back to the Steam root only for %s and logs STEAM_LIBRARY_LIST_INVALID', async (_name, content) => {
    const other = await steam.library('Other');
    await steam.install(steam.steam, 'ets2');
    await steam.install(other, 'ats');
    await steam.rawLibraryFolders(content);
    // A valid config copy is not consulted once the steamapps file exists.
    await steam.libraryFolders([steam.steam, other], {location: 'config'});
    const log = vi.fn();
    const result = await discover({log});
    expect(result.steam).toBe('list-invalid');
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam]);
    expect(result.games.ets2.outcome).toBe('steam-list-invalid');
    expect(roots(result, 'ets2')).toEqual([{library: 0, root: common(steam.steam, ETS2), status: 'ready'}]);
    expect(result.games.ats).toEqual({outcome: 'steam-list-invalid', roots: []});
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('STEAM_LIBRARY_LIST_INVALID');
  });

  it('treats an oversized list and a list that is a folder as invalid', async () => {
    await steam.rawLibraryFolders(Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect((await discover()).steam).toBe('list-invalid');
    await rm(path.win32.join(steam.steam, 'steamapps', 'libraryfolders.vdf'));
    await mkdir(path.win32.join(steam.steam, 'steamapps', 'libraryfolders.vdf'));
    expect((await discover()).steam).toBe('list-invalid');
  });

  it('stops when the run is aborted', async () => {
    const abort = new AbortController();
    abort.abort(new Error('run aborted'));
    await expect(discoverSteamGames({steamRoot: found(), fs: guard.fs, signal: abort.signal})).rejects.toThrow('run aborted');
  });
});

describe('layout (P3)', () => {
  it('reports linked bin, win_x64 and plugins folders, and an unexpected target', async () => {
    const elsewhere = path.win32.join(guard.root, 'Elsewhere');
    await steam.gameFolder(path.win32.join(elsewhere, 'Root'), 'ets2', {plugins: true});
    const cases: [string, () => Promise<string>, string][] = [
      ['bin', async () => {
        const root = path.win32.join(guard.root, 'BinLinked');
        await mkdir(root);
        await symlink(path.win32.join(elsewhere, 'Root', 'bin'), path.win32.join(root, 'bin'), 'junction');
        return root;
      }, 'linked'],
      ['win_x64', async () => {
        const root = path.win32.join(guard.root, 'Win64Linked');
        await mkdir(path.win32.join(root, 'bin'), {recursive: true});
        await symlink(path.win32.join(elsewhere, 'Root', 'bin', 'win_x64'), path.win32.join(root, 'bin', 'win_x64'), 'junction');
        return root;
      }, 'linked'],
      ['plugins', async () => {
        const root = await steam.gameFolder(path.win32.join(guard.root, 'PluginsLinked'), 'ets2');
        await symlink(path.win32.join(elsewhere, 'Root', 'bin', 'win_x64', 'plugins'), path.win32.join(root, 'bin', 'win_x64', 'plugins'), 'junction');
        return root;
      }, 'linked'],
      ['plugins file', async () => {
        const root = await steam.gameFolder(path.win32.join(guard.root, 'PluginsFile'), 'ets2');
        await writeFile(path.win32.join(root, 'bin', 'win_x64', 'plugins'), 'not a folder');
        return root;
      }, 'unexpected-entry'],
      ['target folder', async () => {
        const root = await steam.gameFolder(path.win32.join(guard.root, 'TargetFolder'), 'ets2', {plugins: true});
        await mkdir(path.win32.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll'));
        return root;
      }, 'unexpected-entry'],
      ['target file', async () => {
        const root = await steam.gameFolder(path.win32.join(guard.root, 'TargetFile'), 'ets2', {plugins: true});
        await writeFile(path.win32.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll'), 'someone else\'s file');
        return root;
      }, 'ready']
    ];
    for (const [name, build, status] of cases) {
      const layout = await validateGameLayout(guard.fs, await build(), 'ets2');
      expect([name, layout.status]).toEqual([name, status]);
    }
    const linkedBinWithoutGame = path.win32.join(guard.root, 'EmptyLink');
    await mkdir(path.win32.join(guard.root, 'EmptyTarget'));
    await mkdir(linkedBinWithoutGame);
    await symlink(path.win32.join(guard.root, 'EmptyTarget'), path.win32.join(linkedBinWithoutGame, 'bin'), 'junction');
    expect((await validateGameLayout(guard.fs, linkedBinWithoutGame, 'ets2')).status).toBe('not-game');
  });

  it('reports a Steam root with a linked plugins folder as found but linked', async () => {
    const root = await steam.install(steam.steam, 'ets2');
    const target = path.win32.join(guard.root, 'PluginsElsewhere');
    await mkdir(target);
    await symlink(target, path.win32.join(root, 'bin', 'win_x64', 'plugins'), 'junction');
    const result = await discover();
    expect(roots(result, 'ets2')).toEqual([{library: 0, root, status: 'linked'}]);
  });
});
