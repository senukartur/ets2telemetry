import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {runUninstall, type UninstallFileSystem, type UninstallPorts, type UninstallResult} from '../../apps/desktop/src/uninstall/engine';
import {MAX_PENDING_BYTES, parsePendingRecord, serializePendingRecord, type PendingFolder} from '../../apps/desktop/src/uninstall/pending-record';
import {resolveUninstallRoots, type UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, LOCAL_BUILD, notRunning, pendingInstall, RELEASED, seedData, sha, UTC,
  writeRegistry, type FakeGameFolder, type InstallFixture} from '../shared/uninstall-fixture';

// REG-015, REG-017 (ET-018 U5): the uninstall engine's ordering, budget and outcomes, on fake installs under the guarded
// temporary root. A kill is simulated by a file system that stops answering after a given deletion; the run is then
// abandoned, as a killed process would be, and a fresh run must finish the cleanup.

let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-uninstall-engine-');});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

interface Scene {fixture: InstallFixture; games: FakeGameFolder[]; unrelated: string}
/** A complete installed scene: two game folders with the recorded plugin (one in a folder setup created), all data entries. */
async function scene(name = 'run'): Promise<Scene> {
  const fixture = await installFixture(guard, {name});
  const first = await gameFolder(fixture, 'ETS2', {content: CURRENT});
  const second = await gameFolder(fixture, 'ATS', {game: 'ats', content: CURRENT});
  const unrelated = path.win32.join(first.plugins, 'other-plugin.dll');
  await fsp.writeFile(unrelated, 'another tool');
  await writeRegistry(fixture, [installRecord(first), installRecord(second, {game: 'ats', createdPluginsDirectory: true})]);
  await seedData(fixture);
  return {fixture, games: [first, second], unrelated};
}
async function roots(fixture: InstallFixture): Promise<UninstallRoots> {
  return resolveUninstallRoots({executable: fixture.executable, env: {}, fs: fixture.fs});
}
async function run(fixture: InstallFixture, overrides: Partial<UninstallPorts> = {}): Promise<UninstallResult> {
  let clock = 0;
  return runUninstall({roots: await roots(fixture), fs: fixture.fs, checkRunning: notRunning, known: KNOWN, clock: () => clock++, deadline: Number.MAX_SAFE_INTEGER,
    delay: () => Promise.resolve(), now: () => new Date('2026-10-18T09:00:00.000Z'), ...overrides});
}
/** The state a complete uninstall must leave: no data root, no plugin, the created plugins folder gone, the unrelated DLL kept. */
async function expectCleaned(current: Scene) {
  expect(await exists(current.fixture.dataRoot)).toBe(false);
  for (const game of current.games) expect(await exists(game.dll)).toBe(false);
  expect(await exists(current.games[1].plugins)).toBe(false);
  expect(await listTree(current.games[0].plugins)).toEqual(['other-plugin.dll']);
}
const ets2Running: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}});
const intentFile = (fixture: InstallFixture) => path.win32.join(fixture.dataRoot, 'uninstall', 'pending.json');
const readIntent = async (fixture: InstallFixture) => parsePendingRecord(await fsp.readFile(intentFile(fixture)));
/** An intent an earlier run left, written as the engine writes it. */
async function writeIntent(fixture: InstallFixture, folders: readonly PendingFolder[]) {
  await fsp.mkdir(path.win32.dirname(intentFile(fixture)), {recursive: true});
  await fsp.writeFile(intentFile(fixture), serializePendingRecord({format: 'ets2telemetry.uninstall-pending', version: 1, phase: 'deferred', startedUtc: UTC,
    attempts: 1, known: [...KNOWN].sort(), folders}));
}
/** A recorded game folder that no longer exists, under `Games`. */
const gone = (fixture: InstallFixture, name: string): FakeGameFolder => {
  const root = path.win32.join(fixture.testRoot, 'Games', name), plugins = path.win32.join(root, 'bin', 'win_x64', 'plugins');
  return {root, plugins, dll: path.win32.join(plugins, 'ets2telemetry-plugin.dll')};
};
const DELETIONS = new Set(['unlink', 'rmdir']);
/**
 * The scene's file system, counting deletions. With `killAfter`, the operation after that many deletions never
 * settles, so the run stops there as a killed process would; `killed` resolves when that happens.
 */
function counting(base: UninstallFileSystem, options: {killAfter?: number; before?: (operation: string, target: string) => Promise<void> | void} = {}) {
  let deletions = 0, signal: () => void = () => undefined;
  const killed = new Promise<void>(resolve => {signal = resolve;});
  const wrapped = new Proxy(base, {get(target, property: string) {
    const real = (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[property];
    if (typeof real !== 'function') return real;
    return async (...args: unknown[]) => {
      if (options.killAfter !== undefined && deletions >= options.killAfter) {signal(); return new Promise(() => undefined);}
      await options.before?.(property, String(args[0]));
      const result = await real.apply(target, args);
      if (DELETIONS.has(property)) deletions++;
      return result;
    };
  }});
  return {fs: wrapped, deletions: () => deletions, killed};
}

describe('outcomes', () => {
  it('completes: removes the plugins, the created plugins folder, every data entry and the data root, and keeps the rest', async () => {
    const current = await scene();
    const result = await run(current.fixture);
    expect(result).toEqual({outcome: 'complete', code: null, plugins: {removed: 2, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 9, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable'});
    await expectCleaned(current);
    // The install itself is not the engine's: Squirrel removes the binaries.
    expect(await exists(current.fixture.executable)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:\\/);
  });
  it('refuses without changing anything when the roots are refused', async () => {
    const current = await scene();
    const before = await listTree(current.fixture.testRoot);
    for (const code of ['NOT_INSTALLED', 'ROOT_MISMATCH'] as const) {
      expect(await runUninstall({roots: {ok: false, code}, fs: current.fixture.fs, checkRunning: notRunning, known: KNOWN, clock: () => 0, deadline: 1}))
        .toMatchObject({outcome: 'refused', code, roaming: 'not-run'});
    }
    expect(await listTree(current.fixture.testRoot)).toEqual(before);
  });
  it('defers while a game runs: the plugin stays, plugins and uninstall stay, the rest of the data goes', async () => {
    const current = await scene();
    const running: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}});
    expect(await run(current.fixture, {checkRunning: running})).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING',
      plugins: {removed: 1, blocked: [{game: 'ets2', reason: 'GAME_RUNNING'}]}, data: {removed: 7, failed: [], rootRemoved: false}, roaming: 'not-run'});
    expect(await fsp.readFile(current.games[0].dll)).toEqual(CURRENT);
    expect((await fsp.readdir(current.fixture.dataRoot)).sort()).toEqual(['plugins', 'uninstall']);
    // The registry still records the blocked folder, and the intent keeps only it.
    expect(JSON.parse(await fsp.readFile(path.win32.join(current.fixture.registryDirectory, 'setup.json'), 'utf8')).installs.map((record: {game: string}) => record.game))
      .toEqual(['ets2']);
    const intent = parsePendingRecord(await fsp.readFile(path.win32.join(current.fixture.dataRoot, 'uninstall', 'pending.json')));
    expect(intent).toMatchObject({phase: 'deferred', attempts: 1, folders: [{game: 'ets2', root: current.games[0].root}]});
    // After the game exits, a second run finishes from the intent.
    expect(await run(current.fixture)).toMatchObject({outcome: 'complete', plugins: {removed: 1}});
    await expectCleaned(current);
  });
  it('defers without touching any game folder when the running check fails or outlasts its budget', async () => {
    for (const check of [(() => Promise.resolve({ok: false, code: 'RUNNING_CHECK_FAILED'})) as RunningCheck, (() => new Promise(() => undefined)) as RunningCheck]) {
      const current = await scene(`check-${Math.random().toString(16).slice(2, 8)}`);
      expect(await run(current.fixture, {checkRunning: check, runningCheckBudgetMs: 50})).toMatchObject({outcome: 'deferred', code: 'RUNNING_CHECK_FAILED',
        plugins: {removed: 0, blocked: [{game: 'ets2', reason: 'RUNNING_CHECK_FAILED'}, {game: 'ats', reason: 'RUNNING_CHECK_FAILED'}]}});
      for (const game of current.games) expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    }
  });
  it('cancels the running-game listing when its budget expires', async () => {
    const current = await scene();
    let received: AbortSignal | undefined;
    const slow: RunningCheck = signal => {received = signal; return new Promise(() => undefined);};
    expect(await run(current.fixture, {checkRunning: slow, runningCheckBudgetMs: 50})).toMatchObject({outcome: 'deferred', code: 'RUNNING_CHECK_FAILED'});
    expect(received?.aborted).toBe(true);
  });
  it('keeps the intent writable when a full intent list meets a new bundle hash', async () => {
    const fixture = await installFixture(guard);
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await writeRegistry(fixture, [installRecord(game)]);
    // 257 known hashes, the intent's bound: the current one and 256 earlier releases.
    const full = [KNOWN[0], ...Array.from({length: 256}, (_, index) => index.toString(16).padStart(64, '0'))];
    const running: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}});
    expect(await run(fixture, {checkRunning: running, known: full})).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING'});
    const intent = parsePendingRecord(await fsp.readFile(path.win32.join(fixture.dataRoot, 'uninstall', 'pending.json')));
    expect(intent?.known).toHaveLength(257);
    // The next build adds a new hash: the merged list stays within the bound, and the run proceeds.
    const next = 'b'.repeat(64);
    expect(await run(fixture, {known: [KNOWN[0], next]})).toMatchObject({outcome: 'complete', plugins: {removed: 1}});
    expect(await exists(game.dll)).toBe(false);
  });
  it('a rerun from another build still removes a DLL whose hash only the intent knows', async () => {
    const fixture = await installFixture(guard);
    const game = await gameFolder(fixture, 'ETS2', {content: RELEASED});
    await writeRegistry(fixture, [installRecord(game)]);
    const running: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}});
    expect(await run(fixture, {checkRunning: running})).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING'});
    // The next build no longer lists the older release; the intent still does.
    expect(await run(fixture, {known: [KNOWN[0]]})).toMatchObject({outcome: 'complete', plugins: {removed: 1}});
    expect(await exists(game.dll)).toBe(false);
  });
  it('completes for a game Steam uninstalled: the leftover root is cleaned by hash', async () => {
    const fixture = await installFixture(guard);
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await fsp.rm(path.win32.join(game.root, 'bin', 'win_x64', 'eurotrucks2.exe'));
    await writeRegistry(fixture, [installRecord(game)]);
    expect(await run(fixture)).toMatchObject({outcome: 'complete', plugins: {removed: 1, notes: [{game: 'ets2', note: 'GAME_EXECUTABLE_MISSING'}], blocked: []}});
    expect(await exists(game.dll)).toBe(false);
  });
  it('keeps an unrecognized plugin file and still completes, because nothing of this application is left', async () => {
    const fixture = await installFixture(guard);
    const game = await gameFolder(fixture, 'ETS2', {content: FOREIGN});
    await writeRegistry(fixture, [installRecord(game)]);
    expect(await run(fixture)).toMatchObject({outcome: 'complete', plugins: {removed: 0, unrecognized: 1}});
    expect(await fsp.readFile(game.dll)).toEqual(FOREIGN);
  });
  it('keeps unknown data entries and the data root, and still reports complete with the kept count', async () => {
    const current = await scene();
    await seedData(current.fixture, {unknown: true});
    expect(await run(current.fixture)).toMatchObject({outcome: 'complete', data: {kept: 1, rootRemoved: false}});
    expect(await listTree(current.fixture.dataRoot)).toEqual(['notes\\', 'notes\\mine.txt']);
  });
  it('defers when an allowlisted data entry cannot be removed, keeping plugins and uninstall', async () => {
    const current = await scene();
    const settings = path.win32.join(current.fixture.dataRoot, 'settings', 'settings.json');
    await fsp.chmod(settings, 0o444);
    try {
      expect(await run(current.fixture)).toMatchObject({outcome: 'deferred', code: 'DATA_ENTRY_BLOCKED', data: {failed: [{entry: 'settings', code: 'READ_ONLY_FILE'}]}});
      expect((await fsp.readdir(current.fixture.dataRoot)).sort()).toEqual(['plugins', 'settings', 'uninstall']);
    } finally {await fsp.chmod(settings, 0o666);}
    expect(await run(current.fixture)).toMatchObject({outcome: 'complete'});
    await expectCleaned(current);
  });
  it.each([
    ['invalid', 'REGISTRY_INVALID', '{"format":"ets2telemetry.plugin-setup","version":1,"broken":true}'],
    ['newer', 'REGISTRY_NEWER', '{"format":"ets2telemetry.plugin-setup","version":2,"installs":[]}']
  ])('a registry that turned %s keeps and then cleans the folder of an earlier intent by its own hash, and stays deferred', async (_state, code, content) => {
    const fixture = await installFixture(guard);
    // A recorded local build: neither the bundle nor a release knows its hash, only the registry and then the intent.
    const game = await gameFolder(fixture, 'ETS2', {content: LOCAL_BUILD});
    await writeRegistry(fixture, [installRecord(game, {sha256: sha(LOCAL_BUILD)})]);
    expect(await run(fixture, {checkRunning: ets2Running})).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING'});
    const setup = path.win32.join(fixture.registryDirectory, 'setup.json');
    await fsp.writeFile(setup, content);
    // The game still runs: the intent's folder is kept, not forgotten.
    expect(await run(fixture, {checkRunning: ets2Running})).toMatchObject({outcome: 'deferred', code,
      plugins: {removed: 0, blocked: [{game: 'ets2', reason: 'GAME_RUNNING'}]}});
    expect(await readIntent(fixture)).toMatchObject({phase: 'deferred', attempts: 2,
      folders: [{game: 'ets2', root: game.root, hashes: [sha(LOCAL_BUILD)], temps: [], createdPluginsDirectory: false}]});
    expect(await fsp.readFile(game.dll)).toEqual(LOCAL_BUILD);
    // The game exits: the folder is cleaned by the intent's hash; the registry stays untouched and keeps the run deferred.
    expect(await run(fixture)).toMatchObject({outcome: 'deferred', code, plugins: {removed: 1, blocked: []}});
    expect(await exists(game.dll)).toBe(false);
    expect(await fsp.readFile(setup, 'utf8')).toBe(content);
    expect(await readIntent(fixture)).toMatchObject({phase: 'deferred', attempts: 3, folders: []});
  });
  it('cleans the maximum registry merged with the maximum intent, and records what fits with the intent\'s own entries first', async () => {
    const fixture = await installFixture(guard);
    const shared = await gameFolder(fixture, 'Shared', {content: LOCAL_BUILD});
    const hash = (prefix: string, index: number) => `${prefix.repeat(48)}${index.toString(16).padStart(16, '0')}`;
    const temp = (prefix: string, index: number) => path.win32.join(shared.plugins, `ets2telemetry-plugin.dll.${prefix}${index.toString(16).padStart(15, '0')}.tmp`);
    // The registry at its bounds: 16 installs (the shared folder and 15 folders whose game is gone) and 16 pending updates
    // of the shared folder, 17 hashes and 16 temporary files there. The DLL's hash is only a pending update's toSha256.
    const registryOnly = Array.from({length: 15}, (_, index) => gone(fixture, `Registry${index}`));
    await writeRegistry(fixture, [installRecord(shared, {sha256: hash('a', 0)}), ...registryOnly.map(folder => installRecord(folder))],
      Array.from({length: 16}, (_, index) => pendingInstall(shared, '0', {op: 'update', temp: temp('b', index), fromSha256: hash('a', 0),
        toSha256: index === 0 ? sha(LOCAL_BUILD) : hash('b', index)})));
    // The intent at its bounds: 32 folders, the shared one with its own 17 hashes and 16 temporary files.
    const intentOnly = Array.from({length: 31}, (_, index) => gone(fixture, `Intent${index}`));
    const ownHashes = Array.from({length: 17}, (_, index) => hash('c', index)), ownTemps = Array.from({length: 16}, (_, index) => temp('d', index));
    await writeIntent(fixture, [{game: 'ets2', root: shared.root, hashes: ownHashes, temps: ownTemps, createdPluginsDirectory: false},
      ...intentOnly.map(folder => ({game: 'ets2' as const, root: folder.root, hashes: [sha(CURRENT)], temps: [], createdPluginsDirectory: false}))]);
    // 47 folders, 34 hashes and 32 temporary files in the shared one: beyond every bound of the intent.
    expect(await run(fixture, {checkRunning: ets2Running})).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', plugins: {removed: 0}});
    const deferred = await readIntent(fixture);
    expect(deferred?.folders.map(folder => folder.root)).toEqual([shared.root, ...intentOnly.map(folder => folder.root)]);
    expect(deferred?.folders[0]).toEqual({game: 'ets2', root: shared.root, hashes: [...ownHashes].sort(), temps: [...ownTemps].sort(), createdPluginsDirectory: false});
    // The folders the intent cannot hold stay in the registry, which a deferred run keeps.
    expect(JSON.parse(await fsp.readFile(path.win32.join(fixture.registryDirectory, 'setup.json'), 'utf8')).installs).toHaveLength(16);
    // The game exits: every folder is cleaned with the full merged list, so the DLL whose hash the intent dropped goes.
    const result = await run(fixture);
    expect(result).toMatchObject({outcome: 'complete', code: null, plugins: {removed: 1, absent: 46, unrecognized: 0, blocked: []}});
    expect(result.plugins.notes).toHaveLength(46);
    expect(await exists(shared.dll)).toBe(false);
    expect(await exists(fixture.dataRoot)).toBe(false);
  });
  it('keeps the intent within its byte bound for a registry of long game roots', async () => {
    const fixture = await installFixture(guard);
    // Roots near the registry's 4096-character bound, each with an install record and a pending install.
    const games = path.win32.join(fixture.testRoot, 'Games');
    const segment = 'x'.repeat(200), segments = Math.floor((4080 - games.length) / 201);
    const folders = Array.from({length: 16}, (_, index) => gone(fixture, path.win32.join(...Array.from({length: segments}, () => segment), `L${index}`)));
    expect(folders[0].root.length).toBeLessThanOrEqual(4096);
    const intents = folders.map((folder, index) => pendingInstall(folder, index.toString(16).padStart(16, '0')));
    await writeRegistry(fixture, folders.map(folder => installRecord(folder)), intents);
    const registryBefore = await fsp.readFile(path.win32.join(fixture.registryDirectory, 'setup.json'));
    // Precondition: these 16 folders alone, as the intent would record them, exceed its byte bound.
    const unbounded = serializePendingRecord({format: 'ets2telemetry.uninstall-pending', version: 1, phase: 'plugins', startedUtc: UTC, attempts: 1, known: [...KNOWN].sort(),
      folders: folders.map((folder, index) => ({game: 'ets2', root: folder.root, hashes: [sha(CURRENT), sha(LOCAL_BUILD)].sort(), temps: [intents[index].temp!],
        createdPluginsDirectory: false}))});
    expect(Buffer.byteLength(unbounded)).toBeGreaterThan(MAX_PENDING_BYTES);
    const result = await run(fixture, {checkRunning: ets2Running});
    expect(result).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', plugins: {removed: 0}});
    expect(result.plugins.blocked).toHaveLength(16);
    const deferred = await readIntent(fixture);
    expect(deferred?.folders.length).toBeGreaterThan(0);
    expect(deferred?.folders.length).toBeLessThan(16);
    expect(deferred?.folders.map(folder => folder.root)).toEqual(folders.slice(0, deferred?.folders.length).map(folder => folder.root));
    expect(await fsp.readFile(path.win32.join(fixture.registryDirectory, 'setup.json'))).toEqual(registryBefore);
  });
  it('calls the Roaming userData hook only in production mode and only after a complete run', async () => {
    const current = await scene();
    let calls = 0;
    const removeRoamingUserData = () => {calls++; return Promise.resolve(true);};
    expect(await run(current.fixture, {removeRoamingUserData})).toMatchObject({outcome: 'complete', roaming: 'not-applicable'});
    expect(calls).toBe(0);
    const production = await installFixture(guard, {name: 'production', testRoot: false});
    const productionRoots = await resolveUninstallRoots({executable: production.executable, env: {LOCALAPPDATA: production.base}, fs: production.fs});
    expect(productionRoots).toMatchObject({ok: true, mode: 'production'});
    expect(await runUninstall({roots: productionRoots, fs: production.fs, checkRunning: notRunning, known: KNOWN, clock: () => 0, deadline: 1, removeRoamingUserData}))
      .toMatchObject({outcome: 'complete', roaming: 'removed'});
    expect(calls).toBe(1);
  });
});

describe('ordering and interruption', () => {
  it('writes pending.json, with every folder to clean, before the first deletion', async () => {
    const current = await scene();
    const seen: unknown[] = [];
    const probe = counting(current.fixture.fs, {before: async operation => {
      if (DELETIONS.has(operation) && !seen.length) {
        const bytes = await fsp.readFile(path.win32.join(current.fixture.dataRoot, 'uninstall', 'pending.json')).catch(() => undefined);
        seen.push(bytes ? parsePendingRecord(bytes) ?? 'invalid' : 'absent');
      }
    }});
    expect(await run(current.fixture, {fs: probe.fs})).toMatchObject({outcome: 'complete'});
    expect(seen).toEqual([expect.objectContaining({phase: 'plugins', attempts: 1, known: [...KNOWN].sort(),
      folders: [expect.objectContaining({game: 'ets2', root: current.games[0].root}), expect.objectContaining({game: 'ats', root: current.games[1].root})]})]);
  });
  it('finishes after a kill after any deletion: a fresh run completes with the same final state', {timeout: 120_000}, async () => {
    const reference = await scene('reference');
    const probe = counting(reference.fixture.fs);
    expect(await run(reference.fixture, {fs: probe.fs})).toMatchObject({outcome: 'complete'});
    const total = probe.deletions();
    expect(total).toBeGreaterThan(15);
    for (let kill = 1; kill < total; kill++) {
      const current = await scene(`kill-${kill}`);
      const killing = counting(current.fixture.fs, {killAfter: kill});
      // The abandoned run never settles; the kill is observed and the run is left behind, as a killed process.
      void run(current.fixture, {fs: killing.fs});
      await killing.killed;
      const rerun = await run(current.fixture);
      expect(rerun.outcome, `kill after deletion ${kill}`).toBe('complete');
      await expectCleaned(current);
    }
  });
  it('defers at an expired budget and never reports complete while something is left', async () => {
    const expiredAtStart = await scene('expired');
    expect(await run(expiredAtStart.fixture, {deadline: 0})).toMatchObject({outcome: 'deferred', code: 'BUDGET_EXPIRED',
      plugins: {removed: 0, blocked: [{game: 'ets2', reason: 'BUDGET_EXPIRED'}, {game: 'ats', reason: 'BUDGET_EXPIRED'}]}});
    for (const game of expiredAtStart.games) expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await exists(path.win32.join(expiredAtStart.fixture.dataRoot, 'uninstall', 'pending.json'))).toBe(true);
    // Every possible expiry point: a deferred run always leaves the intent, and a complete one leaves nothing.
    for (let budget = 1; budget < 80; budget += 3) {
      const current = await scene(`budget-${budget}`);
      const result = await run(current.fixture, {deadline: budget});
      if (result.outcome === 'complete') await expectCleaned(current);
      else {
        expect(result.code, `budget ${budget}`).toBe('BUDGET_EXPIRED');
        expect(await exists(path.win32.join(current.fixture.dataRoot, 'uninstall', 'pending.json')), `budget ${budget}`).toBe(true);
      }
    }
  });
  it('a second run after a complete one changes nothing and completes', async () => {
    const current = await scene();
    await run(current.fixture);
    expect(await run(current.fixture)).toMatchObject({outcome: 'complete', plugins: {removed: 0}, data: {removed: 0, rootRemoved: true}});
    await expectCleaned(current);
  });
});
