import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {runUninstall, type UninstallFileSystem, type UninstallPorts, type UninstallResult} from '../../apps/desktop/src/uninstall/engine';
import {parsePendingRecord} from '../../apps/desktop/src/uninstall/pending-record';
import {resolveUninstallRoots, type UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, notRunning, seedData, writeRegistry,
  type FakeGameFolder, type InstallFixture} from '../shared/uninstall-fixture';

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
    expect(result).toEqual({outcome: 'complete', code: null, plugins: {removed: 2, absent: 0, unrecognized: 0, blocked: []},
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
