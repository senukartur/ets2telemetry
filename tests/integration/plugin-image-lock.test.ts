import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {checkRunningGames} from '../../apps/desktop/src/plugin-setup/game-processes';
import {PluginInstaller, type InstallerFileSystem, type RunningCheck, type VerifiedPluginBundle} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {PluginRegistry} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import type {AtomicFileSystem} from '../../apps/desktop/src/plugin-setup/atomic-json-file';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeSteam} from '../shared/fake-steam';

// REG-015 (ET-017 P7, P8): the operating-system lock on a plugin DLL a running process has loaded. The tests-only fake
// SDK host, built as eurotrucks2.exe, loads the isolated test plugin DLL from a fake game root under a guarded
// temporary folder, which the installer first installed and recorded as owned. With a lister that wrongly reports no
// running game, an update and a removal must both end as TARGET_LOCKED with the loaded bytes unchanged; with the real
// tasklist lister, the same update must stop at GAME_RUNNING before any file operation. Synthetic only: no game, Steam
// library or game folder is touched. Needs the Release test plugin DLL and the fake-SDK host (npm run native:build).
const repository = path.resolve(import.meta.dirname, '../..');
const artifacts = {
  host: path.join(repository, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'),
  dll: path.join(repository, 'native/telemetry-plugin/build/Release/snapshot-transport-test-plugin.dll')
};
const UTC = new Date(Date.UTC(2026, 9, 17, 8, 30, 15, 250));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const notRunning: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: false}});

let guard: GuardedRoot;
let host: ChildProcessWithoutNullStreams | undefined;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-plugin-lock-');});
afterEach(async () => {
  if (host && host.exitCode === null) {
    host.stdin.end('exit\n');
    await until(() => host!.exitCode !== null, 5_000);
    if (host.exitCode === null) host.kill();
  }
  host = undefined;
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
async function until(predicate: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 25));}
  return predicate();
}

it('keeps a loaded plugin DLL byte-identical: TARGET_LOCKED with a wrong lister, GAME_RUNNING with the real one', async () => {
  for (const [name, file] of Object.entries(artifacts)) expect(existsSync(file), `${name} artifact missing: run npm run native:build first`).toBe(true);
  // The GAME_RUNNING assertion below means something only when no real game or client runs now. A fake host that an
  // earlier chain step has just stopped may take a moment to exit, so the listing is retried for up to 10 s.
  let before = await checkRunningGames();
  for (const end = Date.now() + 10_000; Date.now() < end && !(before.ok && !before.running.ets2 && !before.running.ats && !before.running.client);) {
    await new Promise(resolve => setTimeout(resolve, 500));
    before = await checkRunningGames();
  }
  expect(before.ok && before.running, 'ETS2, ATS or TruckersMP is running; close it before this test').toEqual({ets2: false, ats: false, client: false});

  const loaded = await fsp.readFile(artifacts.dll);
  const next = Buffer.concat([loaded, Buffer.from('ETS2Telemetry plugin-lock test update')]);
  const steam = await fakeSteam(guard.root);
  const root = await steam.gameFolder(path.win32.join(guard.root, 'Games', 'Euro Truck Simulator 2'), 'ets2', {plugins: true});
  const target = {game: 'ets2', source: 'manual', root} as const;
  const dll = path.win32.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll');
  const registryDirectory = path.join(guard.root, 'ETS2Telemetry', 'plugins');
  const registry = await PluginRegistry.load(registryDirectory, {fs: guard.fs as unknown as AtomicFileSystem, now: () => UTC});
  const fs = guard.fs as unknown as InstallerFileSystem;
  const bundleOf = (bytes: Buffer): VerifiedPluginBundle => ({bytes, sha256: sha(bytes), appVersion: '0.1.0', known: []});

  // The owned test DLL: installed by the installer itself, so only this root's registry record recognizes it.
  expect((await new PluginInstaller(bundleOf(loaded), {fs, registry, checkRunning: notRunning}).ensureInstalled(target)).outcome).toBe('installed');
  host = spawn(artifacts.host, ['host', dll, path.win32.join(guard.root, 'transport', 'v0')], {stdio: 'pipe', windowsHide: true});
  let output = '';
  host.stdout.on('data', (chunk: Buffer) => {output += chunk.toString('utf8');});
  host.stderr.on('data', () => undefined);
  expect(await until(() => output.includes('"ready":true'), 10_000), 'fake SDK host loaded the plugin').toBe(true);

  const update = new PluginInstaller({...bundleOf(next), known: [{appVersion: '0.1.0', sha256: sha(loaded)}]}, {fs, registry, checkRunning: notRunning});
  expect(await update.ensureInstalled(target)).toMatchObject({outcome: 'blocked', reason: 'TARGET_LOCKED', step: 'rename', errno: 'EPERM'});
  expect(await fsp.readFile(dll)).toEqual(loaded);
  expect(await update.remove(target)).toMatchObject({outcome: 'blocked', reason: 'TARGET_LOCKED', step: 'unlink', errno: 'EPERM'});
  expect(await fsp.readFile(dll)).toEqual(loaded);
  expect((await fsp.readdir(path.dirname(dll))).sort()).toEqual(['ets2telemetry-plugin.dll']);
  expect(registry.document.pending).toEqual([]);

  // The real lister sees the fake host by its image name and stops the change before any file operation.
  const operations: string[] = [];
  const counted = new Proxy(fs, {get: (real, name: keyof InstallerFileSystem) => (...args: unknown[]) => {operations.push(String(name)); return (real[name] as (...values: unknown[]) => unknown)(...args);}});
  const real = new PluginInstaller(bundleOf(next), {fs: counted, registry, checkRunning: signal => checkRunningGames({signal})});
  expect(await real.ensureInstalled(target)).toMatchObject({outcome: 'blocked', reason: 'GAME_RUNNING', step: 'process'});
  expect(await real.remove(target)).toMatchObject({outcome: 'blocked', reason: 'GAME_RUNNING', step: 'process'});
  expect(operations).toEqual([]);
  expect(await fsp.readFile(dll)).toEqual(loaded);

  // Once the host has exited and unloaded the DLL, the same update succeeds.
  host.stdin.end('exit\n');
  expect(await until(() => host!.exitCode !== null, 10_000), 'fake SDK host exited').toBe(true);
  expect(host.exitCode).toBe(0);
  const after = await checkRunningGames();
  expect(after.ok && after.running.ets2).toBe(false);
  expect((await real.ensureInstalled(target)).outcome).toBe('updated');
  expect(await fsp.readFile(dll)).toEqual(next);
});
