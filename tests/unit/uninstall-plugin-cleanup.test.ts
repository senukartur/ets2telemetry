import {execFileSync, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {InstallerFileSystem} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {parsePluginRegistry} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {runUninstall, type UninstallPorts} from '../../apps/desktop/src/uninstall/engine';
import type {PendingFolder} from '../../apps/desktop/src/uninstall/pending-record';
import {cleanFolder, cleanupFolders} from '../../apps/desktop/src/uninstall/plugin-cleanup';
import {resolveUninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {fileWorkBudget, withoutFlush} from '../shared/file-work';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, LOCAL_BUILD, notRunning, pendingInstall, RELEASED, seedData, sha,
  writeRegistry, type FakeGameFolder, type InstallFixture} from '../shared/uninstall-fixture';

// REG-015, REG-017 (ET-018 U5 step 3): plugin cleanup on uninstall under the ET-017 contract (docs/plugin-setup.md,
// "Contract with ET-018"). Fake game folders under the guarded temporary root; the real-system cases take a real
// sharing lock from a Windows PowerShell child. Expected outcomes are written by hand from the contract.

// The guard skips the flush to disk of every file opened through it (withoutFlush, tests/shared/file-work.ts): no case in
// this file observes durability across a power loss. Single syncs of the intent and registry writes took up to 2,324 ms here under
// load on October 28, 2026, nearly all of a slow case's time (ET-019, docs/validation/et-019.md).
// The cases build scenes and run the code under test on real temporary files: at most 306 file requests
// per case (libuv promise and callback requests and handle closes, counted for every case on October 28, 2026), rounded
// up to 350. Without the flush, single stalled requests still made a case take seconds in a full npm test. This
// named budget bounds that file work at FS_OPERATION_ALLOWANCE_MS per request (TESTING.md section 6), not behaviour
// timing: the cases run on injected clocks and assert no real time, and a case with its own timeout keeps it.
const CASE_FS_OPERATIONS = 350;
vi.setConfig({testTimeout: fileWorkBudget(CASE_FS_OPERATIONS)});
let guard: GuardedRoot;
let fixture: InstallFixture;
let delays: number[];
beforeEach(async () => {
  guard = withoutFlush(await guardedTempRoot('ets2telemetry-uninstall-plugins-'));
  fixture = await installFixture(guard);
  delays = [];
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const gameFs = () => guard.fs as unknown as InstallerFileSystem;
const delay = (milliseconds: number) => {delays.push(milliseconds); return Promise.resolve();};
const folderOf = (game: FakeGameFolder, overrides: Partial<PendingFolder> = {}): PendingFolder => ({game: 'ets2', root: game.root, hashes: [sha(CURRENT)], temps: [],
  createdPluginsDirectory: false, ...overrides});
const clean = (folder: PendingFolder, options: {fs?: InstallerFileSystem; running?: {ets2?: boolean; ats?: boolean; client?: boolean}} = {}) =>
  cleanFolder(folder, {fs: options.fs ?? gameFs(), running: {ets2: false, ats: false, client: false, ...options.running}, known: KNOWN, delay});
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), {code});
async function uninstall(overrides: Partial<UninstallPorts> = {}) {
  const roots = await resolveUninstallRoots({executable: fixture.executable, env: {}, fs: fixture.fs});
  let clock = 0;
  return runUninstall({roots, fs: fixture.fs, checkRunning: notRunning, known: KNOWN, clock: () => clock++, deadline: Number.MAX_SAFE_INTEGER, delay,
    now: () => new Date('2026-10-18T09:00:00.000Z'), ...overrides});
}

describe('registry states', () => {
  it('loaded: removes the recorded plugin and forgets the folder before the registry goes with the data root', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await writeRegistry(fixture, [installRecord(game)]);
    expect(await uninstall()).toMatchObject({outcome: 'complete', code: null, plugins: {removed: 1, absent: 0, unrecognized: 0, blocked: []}});
    expect(await exists(game.dll)).toBe(false);
    expect(await exists(fixture.dataRoot)).toBe(false);
  });
  it('empty: no registry means nothing to clean, and no game folder is read', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    expect(await uninstall()).toMatchObject({outcome: 'complete', plugins: {removed: 0, absent: 0, blocked: []}});
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });
  it.each([
    ['invalid', 'REGISTRY_INVALID', '{"format":"ets2telemetry.plugin-setup","version":1,"broken":true}'],
    ['newer', 'REGISTRY_NEWER', '{"format":"ets2telemetry.plugin-setup","version":2,"installs":[]}']
  ])('%s: touches no game folder, keeps setup.json and the rejected copies, and wipes the rest', async (_state, code, content) => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await seedData(fixture);
    await fsp.mkdir(fixture.registryDirectory, {recursive: true});
    await fsp.writeFile(path.win32.join(fixture.registryDirectory, 'setup.json'), content);
    await fsp.writeFile(path.win32.join(fixture.registryDirectory, 'setup.rejected-20261017T000000Z.json'), 'an earlier rejected registry');
    expect(await uninstall()).toMatchObject({outcome: 'deferred', code, plugins: {removed: 0, absent: 0, blocked: []}});
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await fsp.readFile(path.win32.join(fixture.registryDirectory, 'setup.json'), 'utf8')).toBe(content);
    expect(await listTree(fixture.dataRoot)).toEqual(['plugins\\', 'plugins\\setup.json', 'plugins\\setup.rejected-20261017T000000Z.json', 'uninstall\\', 'uninstall\\pending.json']);
  });
  it('unreadable: a setup.json that is a folder touches no game folder and is kept', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await fsp.mkdir(path.win32.join(fixture.registryDirectory, 'setup.json'), {recursive: true});
    expect(await uninstall()).toMatchObject({outcome: 'deferred', code: 'REGISTRY_UNREADABLE'});
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await exists(path.win32.join(fixture.registryDirectory, 'setup.json'))).toBe(true);
  });
});

describe('folders and hashes', () => {
  it('collects every install record and pending install or update once, and skips a pending removal', () => {
    const root = 'X:\\Games\\ETS2';
    const document = parsePluginRegistry(Buffer.from(JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
      games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}},
      installs: [{game: 'ets2', root, source: 'steam', sha256: sha(CURRENT), appVersion: '0.1.0', installedUtc: '2026-10-18T09:00:00.000Z', createdPluginsDirectory: false}],
      pending: [{op: 'update', game: 'ets2', root, source: 'steam', temp: `${root}\\bin\\win_x64\\plugins\\ets2telemetry-plugin.dll.0123456789abcdef.tmp`, fromSha256: sha(CURRENT),
        toSha256: sha(LOCAL_BUILD), appVersion: '0.1.0', createdPluginsDirectory: true, startedUtc: '2026-10-18T09:00:00.000Z'},
      {op: 'remove', game: 'ats', root: 'X:\\Games\\ATS', source: 'steam', temp: null, fromSha256: sha(CURRENT), toSha256: null, appVersion: null,
        createdPluginsDirectory: false, startedUtc: '2026-10-18T09:00:00.000Z'}],
      failures: []})));
    if (document.state !== 'loaded') throw new Error(document.state);
    expect(cleanupFolders(document.document, [])).toEqual([{game: 'ets2', root, hashes: [sha(CURRENT), sha(LOCAL_BUILD)].sort(),
      temps: [`${root}\\bin\\win_x64\\plugins\\ets2telemetry-plugin.dll.0123456789abcdef.tmp`], createdPluginsDirectory: true}]);
  });
  it.each([
    ['the recorded hash', LOCAL_BUILD, {hashes: [sha(LOCAL_BUILD)]}],
    ['a pending update\'s toSha256', LOCAL_BUILD, {hashes: [sha(CURRENT), sha(LOCAL_BUILD)]}],
    ['the bundled hash', CURRENT, {hashes: []}],
    ['an earlier released hash', RELEASED, {hashes: []}]
  ])('removes a DLL with %s', async (_name, content, overrides) => {
    const game = await gameFolder(fixture, 'ETS2', {content});
    expect(await clean(folderOf(game, overrides))).toEqual({status: 'removed'});
    expect(await exists(game.dll)).toBe(false);
  });
  it('keeps a file with the plugin name and an unrecognized hash, and every other file', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: FOREIGN});
    await fsp.writeFile(path.win32.join(game.plugins, 'other-plugin.dll'), 'another tool');
    expect(await clean(folderOf(game))).toEqual({status: 'unrecognized'});
    expect(await fsp.readFile(game.dll)).toEqual(FOREIGN);
    expect(await listTree(game.plugins)).toEqual(['ets2telemetry-plugin.dll', 'other-plugin.dll']);
  });
  it('removes the exact temporary file of a pending entry, and no other file of that pattern', async () => {
    const game = await gameFolder(fixture, 'ETS2', {plugins: true});
    const intent = pendingInstall(game, '0123456789abcdef');
    const stranger = path.win32.join(game.plugins, 'ets2telemetry-plugin.dll.fedcba9876543210.tmp');
    await fsp.writeFile(intent.temp!, LOCAL_BUILD); await fsp.writeFile(stranger, LOCAL_BUILD);
    expect(await clean(folderOf(game, {temps: [intent.temp!]}))).toEqual({status: 'absent'});
    expect(await listTree(game.plugins)).toEqual(['ets2telemetry-plugin.dll.fedcba9876543210.tmp']);
  });
  it('a pending install with its temporary file and target removes both through the engine', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: LOCAL_BUILD});
    const intent = pendingInstall(game, '0123456789abcdef', {createdPluginsDirectory: true});
    await fsp.writeFile(intent.temp!, LOCAL_BUILD);
    await writeRegistry(fixture, [], [intent]);
    expect(await uninstall()).toMatchObject({outcome: 'complete', plugins: {removed: 1}});
    expect(await exists(game.plugins)).toBe(false);
  });
  it('skips and reports a read-only DLL and never clears its attribute', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await fsp.chmod(game.dll, 0o444);
    try {
      expect(await clean(folderOf(game))).toEqual({status: 'blocked', reason: 'READ_ONLY_FILE'});
      expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
      expect((await fsp.stat(game.dll)).mode & 0o200).toBe(0);
    } finally {await fsp.chmod(game.dll, 0o666);}
  });
  it('removes the plugins folder only when this application created it and it is empty', async () => {
    const created = await gameFolder(fixture, 'Created', {content: CURRENT});
    expect(await clean(folderOf(created, {createdPluginsDirectory: true}))).toEqual({status: 'removed'});
    expect(await exists(created.plugins)).toBe(false);
    const preexisting = await gameFolder(fixture, 'Preexisting', {content: CURRENT});
    expect(await clean(folderOf(preexisting, {createdPluginsDirectory: false}))).toEqual({status: 'removed'});
    expect(await listTree(preexisting.plugins)).toEqual([]);
    const shared = await gameFolder(fixture, 'Shared', {content: CURRENT});
    await fsp.writeFile(path.win32.join(shared.plugins, 'other-plugin.dll'), 'another tool');
    expect(await clean(folderOf(shared, {createdPluginsDirectory: true}))).toEqual({status: 'removed'});
    expect(await listTree(shared.plugins)).toEqual(['other-plugin.dll']);
  });
  it('skips a linked plugins folder and a linked bin, and never reaches through them', async () => {
    const elsewhere = path.win32.join(fixture.testRoot, 'elsewhere-plugins');
    await fsp.mkdir(elsewhere, {recursive: true});
    await fsp.writeFile(path.win32.join(elsewhere, 'ets2telemetry-plugin.dll'), CURRENT);
    const linkedPlugins = await gameFolder(fixture, 'LinkedPlugins');
    await guard.fs.symlink(elsewhere, linkedPlugins.plugins, 'junction');
    expect(await clean(folderOf(linkedPlugins))).toEqual({status: 'blocked', reason: 'LINKED_FOLDER'});
    const realBin = await gameFolder(fixture, 'RealBin', {content: CURRENT});
    const linkedBin = path.win32.join(fixture.testRoot, 'Games', 'LinkedBin');
    await fsp.mkdir(linkedBin, {recursive: true});
    await guard.fs.symlink(path.win32.join(realBin.root, 'bin'), path.win32.join(linkedBin, 'bin'), 'junction');
    expect(await clean(folderOf({root: linkedBin, plugins: '', dll: ''}))).toEqual({status: 'blocked', reason: 'LINKED_FOLDER'});
    expect(await fsp.readFile(path.win32.join(elsewhere, 'ets2telemetry-plugin.dll'))).toEqual(CURRENT);
    expect(await fsp.readFile(realBin.dll)).toEqual(CURRENT);
  });
  it('treats a removed game folder as absent, and an unreachable one as blocked', async () => {
    const gone = path.win32.join(fixture.testRoot, 'Games', 'Gone');
    await fsp.mkdir(path.win32.dirname(gone), {recursive: true});
    expect(await clean(folderOf({root: gone, plugins: '', dll: ''}))).toEqual({status: 'absent', note: 'GAME_FOLDER_GONE'});
    const unplugged = path.win32.join(fixture.testRoot, 'Unplugged-drive', 'Games', 'ETS2');
    expect(await clean(folderOf({root: unplugged, plugins: '', dll: ''}))).toEqual({status: 'blocked', reason: 'FOLDER_UNAVAILABLE'});
  });
  describe('a root that remains without the game executable (a game uninstalled by Steam)', () => {
    /** A game folder whose executable Steam removed, leaving the plugins folder with `content`. */
    async function leftover(name: string, content?: Uint8Array) {
      const game = await gameFolder(fixture, name, {plugins: true, ...(content ? {content} : {})});
      await fsp.rm(path.win32.join(game.root, 'bin', 'win_x64', 'eurotrucks2.exe'));
      return game;
    }
    it('removes this application\'s DLL and the plugins folder it created, by hash ownership', async () => {
      const game = await leftover('Uninstalled', CURRENT);
      expect(await clean(folderOf(game, {createdPluginsDirectory: true}))).toEqual({status: 'removed', note: 'GAME_EXECUTABLE_MISSING'});
      expect(await exists(game.plugins)).toBe(false);
      expect(await listTree(path.win32.join(game.root, 'bin'))).toEqual(['win_x64\\']);
    });
    it('removes the exact temporary file of a pending entry there too', async () => {
      const game = await leftover('Uninstalled');
      const temp = pendingInstall(game, '0123456789abcdef').temp!;
      await fsp.writeFile(temp, LOCAL_BUILD);
      expect(await clean(folderOf(game, {temps: [temp]}))).toEqual({status: 'absent', note: 'GAME_EXECUTABLE_MISSING'});
      expect(await listTree(game.plugins)).toEqual([]);
    });
    it('keeps an unrecognized DLL and every other file', async () => {
      const game = await leftover('Uninstalled', FOREIGN);
      await fsp.writeFile(path.win32.join(game.plugins, 'other-plugin.dll'), 'another tool');
      expect(await clean(folderOf(game, {createdPluginsDirectory: true}))).toEqual({status: 'unrecognized', note: 'GAME_EXECUTABLE_MISSING'});
      expect(await listTree(game.plugins)).toEqual(['ets2telemetry-plugin.dll', 'other-plugin.dll']);
    });
    it('skips a read-only DLL there as everywhere else', async () => {
      const game = await leftover('Uninstalled', CURRENT);
      await fsp.chmod(game.dll, 0o444);
      try {
        expect(await clean(folderOf(game))).toEqual({status: 'blocked', reason: 'READ_ONLY_FILE'});
        expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
      } finally {await fsp.chmod(game.dll, 0o666);}
    });
    it('touches nothing through a linked plugins folder or a linked bin, and counts the folder as absent', async () => {
      const elsewhere = path.win32.join(fixture.testRoot, 'elsewhere-plugins');
      await fsp.mkdir(elsewhere, {recursive: true});
      await fsp.writeFile(path.win32.join(elsewhere, 'ets2telemetry-plugin.dll'), CURRENT);
      const linkedPlugins = await gameFolder(fixture, 'LinkedPlugins');
      await fsp.rm(path.win32.join(linkedPlugins.root, 'bin', 'win_x64', 'eurotrucks2.exe'));
      await guard.fs.symlink(elsewhere, linkedPlugins.plugins, 'junction');
      expect(await clean(folderOf(linkedPlugins))).toEqual({status: 'absent', note: 'LAYOUT_NOT_PLAIN'});
      const linkedBin = path.win32.join(fixture.testRoot, 'Games', 'LinkedBin');
      await fsp.mkdir(linkedBin, {recursive: true});
      const realBin = path.win32.join(fixture.testRoot, 'real-bin');
      await fsp.mkdir(path.win32.join(realBin, 'win_x64', 'plugins'), {recursive: true});
      await fsp.writeFile(path.win32.join(realBin, 'win_x64', 'plugins', 'ets2telemetry-plugin.dll'), CURRENT);
      await guard.fs.symlink(realBin, path.win32.join(linkedBin, 'bin'), 'junction');
      expect(await clean(folderOf({root: linkedBin, plugins: '', dll: ''}))).toEqual({status: 'absent', note: 'LAYOUT_NOT_PLAIN'});
      expect(await fsp.readFile(path.win32.join(elsewhere, 'ets2telemetry-plugin.dll'))).toEqual(CURRENT);
      expect(await fsp.readFile(path.win32.join(realBin, 'win_x64', 'plugins', 'ets2telemetry-plugin.dll'))).toEqual(CURRENT);
    });
    it('defers a root that is a junction to a missing target as FOLDER_UNAVAILABLE, like an unplugged drive', async () => {
      const target = path.win32.join(fixture.testRoot, 'Removed-drive', 'ETS2');
      await fsp.mkdir(target, {recursive: true});
      const root = path.win32.join(fixture.testRoot, 'Games', 'Dangling');
      await fsp.mkdir(path.win32.dirname(root), {recursive: true});
      await guard.fs.symlink(target, root, 'junction');
      await fsp.rm(path.win32.dirname(target), {recursive: true});
      expect(await clean(folderOf({root, plugins: '', dll: ''}))).toEqual({status: 'blocked', reason: 'FOLDER_UNAVAILABLE'});
    });
    it('follows a junctioned root, as ET-017 does, and cleans this application\'s DLL there by hash', async () => {
      // The game moved to another folder (another drive in practice); its old root is a junction ET-017 installed through.
      const real = await leftover('Moved-real', CURRENT);
      const root = path.win32.join(fixture.testRoot, 'Games', 'Moved');
      await guard.fs.symlink(real.root, root, 'junction');
      expect(await clean(folderOf({root, plugins: '', dll: ''}, {createdPluginsDirectory: true}))).toEqual({status: 'removed', note: 'GAME_EXECUTABLE_MISSING'});
      expect(await exists(real.dll)).toBe(false);
      expect(await exists(real.plugins)).toBe(false);
    });
    it('counts a root without bin, win_x64 or plugins as absent', async () => {
      const bare = path.win32.join(fixture.testRoot, 'Games', 'Bare');
      await fsp.mkdir(path.win32.join(bare, 'bin', 'win_x64'), {recursive: true});
      expect(await clean(folderOf({root: bare, plugins: '', dll: ''}))).toEqual({status: 'absent', note: 'PLUGINS_FOLDER_ABSENT'});
      const empty = path.win32.join(fixture.testRoot, 'Games', 'Empty');
      await fsp.mkdir(empty, {recursive: true});
      expect(await clean(folderOf({root: empty, plugins: '', dll: ''}))).toEqual({status: 'absent', note: 'PLUGINS_FOLDER_ABSENT'});
    });
  });
  it('changes nothing while the game or a TruckersMP client runs', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    expect(await clean(folderOf(game), {running: {ets2: true}})).toEqual({status: 'blocked', reason: 'GAME_RUNNING'});
    expect(await clean(folderOf(game), {running: {client: true}})).toEqual({status: 'blocked', reason: 'CLIENT_RUNNING'});
    expect(await clean(folderOf(game), {running: {ats: true}})).toEqual({status: 'removed'});
  });
  it('retries EBUSY on the unlink five times within 300 ms, then reports TARGET_LOCKED; EPERM at once', async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    const failing = (code: string): InstallerFileSystem => ({...gameFs(), unlink: target => target === game.dll ? Promise.reject(errno(code)) : gameFs().unlink(target)});
    expect(await clean(folderOf(game), {fs: failing('EBUSY')})).toEqual({status: 'blocked', reason: 'TARGET_LOCKED', errno: 'EBUSY'});
    expect(delays).toEqual([20, 40, 60, 80, 100]);
    delays = [];
    expect(await clean(folderOf(game), {fs: failing('EPERM')})).toEqual({status: 'blocked', reason: 'TARGET_LOCKED', errno: 'EPERM'});
    expect(delays).toEqual([]);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });
});

describe('real Windows sharing locks', () => {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let holder: ChildProcessWithoutNullStreams | undefined;
  afterEach(async () => {
    if (holder && holder.exitCode === null) {holder.kill(); await new Promise(resolve => holder!.once('exit', resolve));}
    holder = undefined;
  });
  /** A Windows PowerShell child that opens `target` with the given sharing and holds it until its stdin closes. */
  async function holdOpen(target: string, share: 'None' | 'Read'): Promise<() => Promise<void>> {
    const script = `$f = [System.IO.File]::Open($env:ETS2TELEMETRY_TEST_LOCK, 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); ` +
      '[void][Console]::In.ReadLine(); $f.Close()';
    const child = holder = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'pipe', windowsHide: true,
      env: {...process.env, ETS2TELEMETRY_TEST_LOCK: target, PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {output += chunk.toString('utf8');});
    const deadline = Date.now() + 30_000;
    while (!output.includes('locked')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('lock holder did not start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return async () => {child.stdin.end('\n'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));};
  }

  it('reports a DLL held with FileShare.None as TARGET_LOCKED (EBUSY on the read) and keeps it', {timeout: 60_000}, async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    const release = await holdOpen(game.dll, 'None');
    expect(await clean(folderOf(game))).toEqual({status: 'blocked', reason: 'TARGET_LOCKED', errno: 'EBUSY'});
    await release();
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await clean(folderOf(game))).toEqual({status: 'removed'});
  });
  // A handle without delete sharing makes the unlink a sharing violation (EBUSY, measured October 18, 2026), which is
  // retried five times within 300 ms and then reported; the hash read itself succeeds because reading is shared.
  it('reports a DLL held without delete sharing as TARGET_LOCKED after the bounded EBUSY retries and keeps it', {timeout: 60_000}, async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    const release = await holdOpen(game.dll, 'Read');
    expect(await clean(folderOf(game))).toEqual({status: 'blocked', reason: 'TARGET_LOCKED', errno: 'EBUSY'});
    expect(delays).toEqual([20, 40, 60, 80, 100]);
    await release();
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });
  // A real denied delete (an ACL deny of DELETE on the DLL and of delete-child on its folder, inside this test's own
  // temporary root and restored afterwards) is EPERM: reported at once as TARGET_LOCKED, never retried.
  it('reports a real denied delete as TARGET_LOCKED (EPERM) at once and restores the ACLs', {timeout: 60_000}, async () => {
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    expect(game.dll.toLowerCase().startsWith(`${guard.root.toLowerCase()}\\`)).toBe(true);
    const icacls = path.win32.join(systemRoot, 'System32', 'icacls.exe');
    const whoami = execFileSync(path.win32.join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8', windowsHide: true});
    const sid = /"(S-1-[0-9-]+)"/.exec(whoami)?.[1];
    expect(sid).toMatch(/^S-1-5-/);
    execFileSync(icacls, [game.dll, '/deny', `*${sid}:(DE)`], {windowsHide: true, stdio: 'ignore'});
    execFileSync(icacls, [game.plugins, '/deny', `*${sid}:(DC)`], {windowsHide: true, stdio: 'ignore'});
    try {
      expect(await clean(folderOf(game))).toEqual({status: 'blocked', reason: 'TARGET_LOCKED', errno: 'EPERM'});
      expect(delays).toEqual([]);
    } finally {
      execFileSync(icacls, [game.dll, '/remove:d', `*${sid}`], {windowsHide: true, stdio: 'ignore'});
      execFileSync(icacls, [game.plugins, '/remove:d', `*${sid}`], {windowsHide: true, stdio: 'ignore'});
    }
    expect(execFileSync(icacls, [game.plugins], {encoding: 'utf8', windowsHide: true})).not.toMatch(/\(DENY\)/);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await clean(folderOf(game))).toEqual({status: 'removed'});
  });
});
