import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {APP_UNINSTALL_FAILSAFE_MS, AppUninstall, uninstallWipeBudget, type AppUninstallPorts} from '../../apps/desktop/src/uninstall/app-uninstall';
import {resolveUninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, notRunning, seedData, writeRegistry,
  type FakeGameFolder, type InstallFixture} from '../shared/uninstall-fixture';

// REG-015, REG-017 (ET-018 PR-4, plan U8): the in-app uninstall's order on fake installs under the guarded temporary root.
// Every port is injected: no dialog, no tasklist, no real install, data or game folder is touched.

let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-app-uninstall-');});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const ets2Running: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}});
interface Scene {fixture: InstallFixture; ets2: FakeGameFolder; ats: FakeGameFolder; unrelated: string}
async function scene(): Promise<Scene> {
  const fixture = await installFixture(guard);
  const ets2 = await gameFolder(fixture, 'ETS2', {content: CURRENT});
  const ats = await gameFolder(fixture, 'ATS', {game: 'ats', content: CURRENT});
  const unrelated = path.win32.join(ets2.plugins, 'other-plugin.dll');
  await fsp.writeFile(unrelated, 'another tool');
  await writeRegistry(fixture, [installRecord(ets2), installRecord(ats, {game: 'ats'})]);
  await seedData(fixture);
  return {fixture, ets2, ats, unrelated};
}
interface Harness {uninstall: AppUninstall; confirm: ReturnType<typeof vi.fn>; suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; events: string[]}
function harness(fixture: InstallFixture, overrides: Partial<AppUninstallPorts> & {confirmed?: boolean} = {}): Harness {
  let clock = 0;
  const events: string[] = [];
  const {confirmed = true, ...rest} = overrides;
  const confirm = vi.fn(() => {events.push('confirm'); return Promise.resolve(confirmed);});
  const suspend = vi.fn(() => {events.push('suspend'); return Promise.resolve();});
  const resume = vi.fn(() => {events.push('resume');});
  const ports: AppUninstallPorts = {
    resolveRoots: () => resolveUninstallRoots({executable: fixture.executable, env: {}, fs: fixture.fs}),
    confirm, fs: fixture.fs, checkRunning: notRunning, readKnown: () => Promise.resolve(KNOWN),
    setup: {suspend, resume, targetIdFor: (game, root) => root.endsWith('ETS2') ? `${game}:steam:0` : undefined},
    clock: () => clock++, delay: () => Promise.resolve(), log: event => {events.push(event);}, startWindowsUninstall: () => {events.push('handover'); return Promise.resolve(true);}, ...rest
  };
  return {uninstall: new AppUninstall(ports), confirm, suspend, resume, events};
}
const noPath = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/[A-Za-z]:\\|\\\\/);

describe('before anything changes', () => {
  it('a portable or development copy answers not-installed before any dialog', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {resolveRoots: () => resolveUninstallRoots({executable: path.win32.join(guard.root, 'portable', 'ETS2TelemetryDesktop.exe'), env: {}, fs: fixture.fs})});
    expect(await test.uninstall.run()).toEqual({outcome: 'not-installed'});
    expect(test.confirm).not.toHaveBeenCalled();
    expect(test.uninstall.prepared).toBeUndefined();
  });

  it('a declined confirmation changes nothing', async () => {
    const {fixture} = await scene();
    const before = await listTree(guard.root);
    const test = harness(fixture, {confirmed: false});
    expect(await test.uninstall.run()).toEqual({outcome: 'cancelled'});
    expect(await listTree(guard.root)).toEqual(before);
    expect(test.suspend).not.toHaveBeenCalled();
  });

  it('a running game blocks it before setup is paused; nothing changes and the answer holds target ids and codes only', async () => {
    const {fixture} = await scene();
    const before = await listTree(guard.root);
    const test = harness(fixture, {checkRunning: ets2Running});
    const result = await test.uninstall.run();
    expect(result).toEqual({outcome: 'blocked', code: 'GAME_RUNNING', blocked: [{targetId: 'ets2:steam:0', reason: 'GAME_RUNNING'}]});
    noPath(result);
    expect(await listTree(guard.root)).toEqual(before);
    expect(test.suspend).not.toHaveBeenCalled();
    expect(test.uninstall.prepared).toBeUndefined();
  });

  it('a read-only plugin file blocks the preflight without being touched; an unrecognized file does not block', async () => {
    const {fixture, ets2, ats} = await scene();
    await fsp.writeFile(ats.dll, FOREIGN);
    await fsp.chmod(ets2.dll, 0o444);
    try {
      const before = await listTree(guard.root);
      const result = await harness(fixture).uninstall.run();
      expect(result).toEqual({outcome: 'blocked', code: 'READ_ONLY_FILE', blocked: [{targetId: 'ets2:steam:0', reason: 'READ_ONLY_FILE'}]});
      expect(await listTree(guard.root)).toEqual(before);
    } finally {await fsp.chmod(ets2.dll, 0o666);}
  });

  it('an invalid install registry blocks it and changes nothing', async () => {
    const {fixture} = await scene();
    await fsp.writeFile(path.win32.join(fixture.registryDirectory, 'setup.json'), '{broken');
    const before = await listTree(guard.root);
    expect(await harness(fixture).uninstall.run()).toEqual({outcome: 'blocked', code: 'REGISTRY_INVALID', blocked: []});
    expect(await listTree(guard.root)).toEqual(before);
  });

  it('TruckersMP blocks every game; a folder that is not listed is named by its game only', async () => {
    const {fixture} = await scene();
    const client: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: true}});
    expect(await harness(fixture, {checkRunning: client}).uninstall.run()).toEqual({outcome: 'blocked', code: 'CLIENT_RUNNING',
      blocked: [{targetId: 'ets2:steam:0', reason: 'CLIENT_RUNNING'}, {targetId: 'ats:other', reason: 'CLIENT_RUNNING'}]});
  });
});

describe('the plugin removal and the data wipe', () => {
  it('pauses setup, removes the plugins, keeps the data until the exit, then wipes it', async () => {
    const {fixture, ets2, ats, unrelated} = await scene();
    const test = harness(fixture);
    expect(await test.uninstall.run()).toEqual({outcome: 'started'});
    expect(test.events.filter(event => event === 'confirm' || event === 'suspend' || event === 'resume')).toEqual(['confirm', 'suspend']);
    expect(await exists(ets2.dll)).toBe(false);
    expect(await exists(ats.dll)).toBe(false);
    expect(await fsp.readFile(unrelated, 'utf8')).toBe('another tool');
    // The data stays until the application has stopped its service and every writer.
    expect(await exists(path.win32.join(fixture.dataRoot, 'data', 'telemetry.sqlite'))).toBe(true);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall', 'pending.json'))).toBe(true);
    expect(test.uninstall.prepared).toMatchObject({removed: 2, unrecognized: 0, notes: []});
    expect(await test.uninstall.run()).toEqual({outcome: 'failed', code: 'BUSY'});
    const finished = await test.uninstall.finishAfterExit();
    expect(finished).toMatchObject({removed: 2, data: {failed: [], rootRemoved: true}});
    noPath(finished);
    expect(await exists(fixture.dataRoot)).toBe(false);
  });

  it('a removal that races (a game started after the preflight) after removing another plugin answers interrupted, removes the intent, resumes setup and keeps the data', async () => {
    const {fixture, ets2, ats} = await scene();
    let calls = 0;
    const raced: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: calls++ > 0, ats: false, client: false}});
    const test = harness(fixture, {checkRunning: raced});
    const result = await test.uninstall.run();
    // ATS's plugin was already gone when ETS2's folder stopped the run: "nothing was changed" would be false here.
    expect(result).toEqual({outcome: 'interrupted', code: 'GAME_RUNNING', removed: 1, blocked: [{targetId: 'ets2:steam:0', reason: 'GAME_RUNNING'}]});
    expect(await exists(ats.dll)).toBe(false);
    expect(test.events.filter(event => event === 'suspend' || event === 'resume')).toEqual(['suspend', 'resume']);
    expect(await fsp.readFile(ets2.dll)).toEqual(CURRENT);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall'))).toBe(false);
    expect(await exists(path.win32.join(fixture.dataRoot, 'data', 'telemetry.sqlite'))).toBe(true);
    expect(test.uninstall.prepared).toBeUndefined();
    expect(await test.uninstall.finishAfterExit()).toBeUndefined();
  });

  it('a removal that races before any plugin was removed answers blocked, and nothing changed', async () => {
    const {fixture, ets2} = await scene();
    await writeRegistry(fixture, [installRecord(ets2)]);
    const before = await listTree(guard.root);
    let calls = 0;
    const raced: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: calls++ > 0, ats: false, client: false}});
    const test = harness(fixture, {checkRunning: raced});
    expect(await test.uninstall.run()).toEqual({outcome: 'blocked', code: 'GAME_RUNNING', blocked: [{targetId: 'ets2:steam:0', reason: 'GAME_RUNNING'}]});
    expect(test.events.filter(event => event === 'suspend' || event === 'resume')).toEqual(['suspend', 'resume']);
    expect(await listTree(guard.root)).toEqual(before);
  });

  it('an engine that throws during the removal resumes setup and fails without touching the data', async () => {
    const {fixture} = await scene();
    let call = 0;
    const {runUninstall} = await import('../../apps/desktop/src/uninstall/engine');
    const test = harness(fixture, {runUninstall: ports => call++ ? Promise.reject(new Error('boom')) : runUninstall(ports)});
    expect(await test.uninstall.run()).toEqual({outcome: 'failed', code: 'ENGINE_FAILED'});
    expect(test.resume).toHaveBeenCalledOnce();
    expect(await exists(path.win32.join(fixture.dataRoot, 'settings', 'settings.json'))).toBe(true);
  });

  it('keeps the note of a folder whose game was uninstalled for the result dialog', async () => {
    const {fixture, ats} = await scene();
    await fsp.rm(path.win32.join(ats.root, 'bin', 'win_x64', 'amtrucks.exe'));
    const test = harness(fixture);
    expect(await test.uninstall.run()).toEqual({outcome: 'started'});
    expect(test.uninstall.prepared?.notes).toEqual([{game: 'ats', note: 'GAME_EXECUTABLE_MISSING'}]);
    expect((await test.uninstall.finishAfterExit())?.notes).toEqual([{game: 'ats', note: 'GAME_EXECUTABLE_MISSING'}]);
  });

  it('a dialog that cannot open fails and changes nothing', async () => {
    const {fixture} = await scene();
    const before = await listTree(guard.root);
    const test = harness(fixture, {confirm: () => Promise.reject(new Error('no window'))});
    expect(await test.uninstall.run()).toEqual({outcome: 'failed', code: 'DIALOG_FAILED'});
    expect(await listTree(guard.root)).toEqual(before);
  });
});

describe('the wipe budget before the 12 s failsafe', () => {
  it('gives the wipe what is left before the failsafe, less the handover margin, at most 5 s and never less than 0', () => {
    expect(APP_UNINSTALL_FAILSAFE_MS).toBe(12_000);
    expect(uninstallWipeBudget(12_000, 0)).toBe(5000);
    expect(uninstallWipeBudget(12_000, 5300)).toBe(5000);
    expect(uninstallWipeBudget(12_000, 9000)).toBe(2000);
    expect(uninstallWipeBudget(12_000, 11_200)).toBe(0);
    expect(uninstallWipeBudget(12_000, 20_000)).toBe(0);
    expect(uninstallWipeBudget(Number.NaN, 0)).toBe(0);
  });

  it('a wipe without budget deletes nothing and keeps the intent, so Windows\' uninstall can finish it', async () => {
    const {fixture} = await scene();
    const test = harness(fixture);
    expect(await test.uninstall.run()).toEqual({outcome: 'started'});
    const finished = await test.uninstall.finishAfterExit(0);
    expect(finished?.data.rootRemoved).toBe(false);
    expect(finished?.data.removed).toBe(0);
    expect(finished?.data.failed.length).toBeGreaterThan(0);
    expect(finished?.data.failed.every(entry => entry.code === 'BUDGET_EXPIRED')).toBe(true);
    // Every allowlisted entry that remains is named, the registry and the intent included.
    const present = (await fsp.readdir(fixture.dataRoot)).map(name => name.toLowerCase()).sort();
    expect(finished?.data.failed.map(entry => entry.entry).sort()).toEqual(present);
    expect(present).toEqual(expect.arrayContaining(['data', 'plugins', 'uninstall']));
    expect(await exists(path.win32.join(fixture.dataRoot, 'data', 'telemetry.sqlite'))).toBe(true);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall', 'pending.json'))).toBe(true);
  });
});

describe('the handover to Windows\' uninstall', () => {
  it('starts Update.exe of the install only after the plugins are removed, and never before', async () => {
    const {fixture} = await scene();
    const started: string[] = [];
    const test = harness(fixture, {startWindowsUninstall: installRoot => {started.push(installRoot); return Promise.resolve(true);}});
    expect(await test.uninstall.handOver()).toBe(false);
    expect(started).toEqual([]);
    expect(await test.uninstall.run()).toEqual({outcome: 'started'});
    expect(await test.uninstall.handOver()).toBe(true);
    expect(started).toEqual([fixture.installRoot]);
  });
  it('reports a handover that failed', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {startWindowsUninstall: () => Promise.reject(new Error('spawn'))});
    await test.uninstall.run();
    expect(await test.uninstall.handOver()).toBe(false);
  });
  it('removes the autostart login item during handover', async () => {
    const {fixture} = await scene();
    const removed: string[] = [];
    const test = harness(fixture, {
      removeLoginItem: installRoot => {removed.push(installRoot);}
    });
    await test.uninstall.run();
    expect(await test.uninstall.handOver()).toBe(true);
    expect(removed).toEqual([fixture.installRoot]);
  });
});
