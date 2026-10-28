import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReleaseChannel} from '../../apps/desktop/src/channel';
import type {RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import type {UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {fileWorkBudget, withoutFlush} from '../shared/file-work';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-017 (ET-018 PR-5, U7): the shared deferred-cleanup case table, run through the TypeScript engine. The same table
// runs through the PowerShell executor in tests/windows/Test-DeferredCleanup.ps1, so the two implementations of the
// uninstall contract agree on what is kept and what is removed. Each scene is a later run after a deferred uninstall,
// built under the guarded temporary root; nothing touches a real folder or the registry. ET-055 UP12: the table runs in
// both build channels. The engine's names are fixed when its modules load, so the staging run loads the channel table, the
// engine, the pending record and the process listing again with the build define stubbed to staging, as a staging bundle
// has it; the PowerShell harness runs the table in both channels too.

interface CaseFolder {game: 'ets2' | 'ats'; layout: 'game' | 'gone' | 'no-executable' | 'plugins-link'; dll: 'owned' | 'known' | 'foreign' | 'none';
  readOnly?: boolean; temp?: boolean; created?: boolean; unrelated?: boolean; otherChannel?: boolean}
interface CaseExpect {outcome: 'complete' | 'deferred'; code: string | null; dll: 'absent' | 'present'; dataRoot: string[] | null; temp?: 'absent' | 'present';
  pluginsDirectory?: 'absent' | 'present'; unrelated?: 'absent' | 'present'; sentinel?: 'present'; otherChannelDll?: 'absent' | 'present'}
interface DeferredCase {id: string; folder: CaseFolder; running: string[]; data?: {unknownEntry?: boolean; readOnlyEntry?: boolean; logsJunction?: boolean; lateEntry?: string; updatesEntry?: boolean}; expect: CaseExpect}
const TABLE = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'uninstall', 'deferred-cases.json'), 'utf8')) as {
  format: string; version: number; contents: Record<'owned' | 'known' | 'foreign', string>; cases: DeferredCase[]};
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const EXECUTABLE = {ets2: 'eurotrucks2.exe', ats: 'amtrucks.exe'} as const;
const UTC = '2026-10-18T09:00:00.000Z';

/** The modules whose names depend on the build channel, loaded fresh with the channel's build define. */
async function channelModules(channel: ReleaseChannel) {
  vi.resetModules();
  if (channel === 'staging') vi.stubGlobal('__ETS2TELEMETRY_BUILD_CHANNEL__', 'staging');
  try {
    const [channelModule, engine, pending, processes] = await Promise.all([import('../../apps/desktop/src/channel'), import('../../apps/desktop/src/uninstall/engine'),
      import('../../apps/desktop/src/uninstall/pending-record'), import('../../apps/desktop/src/plugin-setup/game-processes')]);
    const CHANNEL = channelModule.CHANNEL;
    return {CHANNEL, runUninstall: engine.runUninstall, serializePendingRecord: pending.serializePendingRecord, runningGames: processes.runningGames,
      tempName: `${CHANNEL.pluginFileName}.00112233445566aa.tmp`,
      /** The other channel's plugin file, which this channel's cleanup never removes. */
      otherPlugin: channelModule.CHANNEL_IDENTITIES[CHANNEL.channel === 'production' ? 'staging' : 'production'].pluginFileName};
  } finally {vi.unstubAllGlobals();}
}
type ChannelModules = Awaited<ReturnType<typeof channelModules>>;

// The guard skips the flush to disk of every file opened through it (withoutFlush, tests/shared/file-work.ts): no case in
// this file observes durability across a power loss. Single syncs of the intent and registry writes took up to 1,273 ms here under
// load on October 28, 2026, nearly all of a slow case's time (ET-019, docs/validation/et-019.md).
// The cases build scenes and run the code under test on real temporary files: at most 239 file requests
// per case (libuv promise and callback requests and handle closes, counted for every case on October 28, 2026), rounded
// up to 250. Without the flush, single stalled requests still made a case take seconds in a full npm test. This
// named budget bounds that file work at FS_OPERATION_ALLOWANCE_MS per request (TESTING.md section 6), not behaviour
// timing: the cases run on injected clocks and assert no real time, and a case with its own timeout keeps it.
const CASE_FS_OPERATIONS = 250;
vi.setConfig({testTimeout: fileWorkBudget(CASE_FS_OPERATIONS)});
let guard: GuardedRoot;
const readOnly: string[] = [];
beforeEach(async () => {guard = withoutFlush(await guardedTempRoot('ets2telemetry-deferred-cases-'));});
afterEach(async () => {
  for (const file of readOnly.splice(0)) await fsp.chmod(file, 0o666).catch(() => undefined);
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const state = (target: string) => fsp.lstat(target).then(() => 'present' as const, () => 'absent' as const);

/** Builds the case's scene: `R` with the test-root marker, the data root under `R\LocalAppData` and the game folder under `R\Games`. */
async function scene(m: ChannelModules, entry: DeferredCase) {
  const {CHANNEL, serializePendingRecord} = m;
  const testRoot = path.win32.join(guard.root, 'R');
  const base = path.win32.join(testRoot, 'LocalAppData'), dataRoot = path.win32.join(base, CHANNEL.dataRootName);
  await fsp.mkdir(dataRoot, {recursive: true});
  await fsp.writeFile(path.win32.join(testRoot, 'ets2telemetry-plugin-test-root.marker'), 'deferred-cleanup cases\n');
  const {folder} = entry;
  const games = path.win32.join(testRoot, 'Games', entry.id);
  const root = path.win32.join(games, folder.game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator');
  const win64 = path.win32.join(root, 'bin', 'win_x64'), plugins = path.win32.join(win64, 'plugins');
  const dllDirectory = folder.layout === 'plugins-link' ? path.win32.join(games, 'elsewhere') : plugins;
  const dll = path.win32.join(dllDirectory, CHANNEL.pluginFileName), temp = path.win32.join(plugins, m.tempName);
  const unrelated = path.win32.join(plugins, 'other-plugin.dll'), otherDll = path.win32.join(plugins, m.otherPlugin);
  await fsp.mkdir(games, {recursive: true});
  if (folder.layout !== 'gone') {
    await fsp.mkdir(win64, {recursive: true});
    if (folder.layout !== 'no-executable') await fsp.writeFile(path.win32.join(win64, EXECUTABLE[folder.game]), 'fake game executable\n');
    if (folder.layout === 'plugins-link') {
      await fsp.mkdir(dllDirectory, {recursive: true});
      await guard.fs.symlink(dllDirectory, plugins, 'junction');
    } else await fsp.mkdir(plugins, {recursive: true});
    if (folder.dll !== 'none') await fsp.writeFile(dll, TABLE.contents[folder.dll]);
    if (folder.readOnly) {await fsp.chmod(dll, 0o444); readOnly.push(dll);}
    if (folder.temp) await fsp.writeFile(temp, 'an interrupted install\n');
    if (folder.unrelated) await fsp.writeFile(unrelated, 'another tool\n');
    // The other channel's plugin with a hash this channel installed: still not this channel's file.
    if (folder.otherChannel) await fsp.writeFile(otherDll, TABLE.contents.owned);
  }
  // The registry and the intent a deferred uninstall left.
  await fsp.mkdir(path.win32.join(dataRoot, 'plugins'), {recursive: true});
  await fsp.writeFile(path.win32.join(dataRoot, 'plugins', 'setup.json'), `${JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
    games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}},
    installs: [{game: folder.game, root, source: 'steam', sha256: sha(TABLE.contents.owned), appVersion: '0.1.0', installedUtc: UTC, createdPluginsDirectory: folder.created === true}],
    pending: [], failures: []}, null, 2)}\n`);
  await fsp.mkdir(path.win32.join(dataRoot, 'uninstall'), {recursive: true});
  await fsp.writeFile(path.win32.join(dataRoot, 'uninstall', 'pending.json'), serializePendingRecord({format: 'ets2telemetry.uninstall-pending', version: 1, phase: 'deferred',
    startedUtc: UTC, attempts: 1, known: [sha(TABLE.contents.known)], folders: [{game: folder.game, root, hashes: [sha(TABLE.contents.owned)],
      temps: folder.temp ? [temp] : [], createdPluginsDirectory: folder.created === true}]}));
  for (const [name, file] of [['data', 'telemetry.sqlite'], ['settings', 'settings.json'], ['logs', 'startup.jsonl']]) {
    await fsp.mkdir(path.win32.join(dataRoot, name), {recursive: true});
    await fsp.writeFile(path.win32.join(dataRoot, name, file), `synthetic ${name}\n`);
  }
  const sentinel = path.win32.join(testRoot, 'outside', 'sentinel.txt');
  // ET-055 UP18: an interrupted in-app update's download in the allowlisted `updates` folder.
  if (entry.data?.updatesEntry) {
    await fsp.mkdir(path.win32.join(dataRoot, 'updates', '0.2.0'), {recursive: true});
    await fsp.writeFile(path.win32.join(dataRoot, 'updates', '0.2.0', 'ETS2TelemetryDesktop-0.2.0-full.nupkg.partial'), 'synthetic partial download\n');
  }
  if (entry.data?.unknownEntry) {
    await fsp.mkdir(path.win32.join(dataRoot, 'notes'), {recursive: true});
    await fsp.writeFile(path.win32.join(dataRoot, 'notes', 'mine.txt'), 'the user\'s own file\n');
  }
  if (entry.data?.readOnlyEntry) {
    const locked = path.win32.join(dataRoot, 'logs', 'locked.jsonl');
    await fsp.writeFile(locked, 'read-only log\n');
    await fsp.chmod(locked, 0o444);
    readOnly.push(locked);
  }
  if (entry.data?.logsJunction) {
    await fsp.mkdir(path.dirname(sentinel), {recursive: true});
    await fsp.writeFile(sentinel, 'outside the data root\n');
    await guard.fs.symlink(path.dirname(sentinel), path.win32.join(dataRoot, 'logs', 'linked'), 'junction');
  }
  const roots: UninstallRoots = {ok: true, mode: 'test-root', appDirectory: path.win32.join(base, CHANNEL.squirrelId, 'app-0.1.0'),
    installRoot: path.win32.join(base, CHANNEL.squirrelId), base, dataRoot, testRoot, testFile: {profileDir: path.win32.join(testRoot, 'profile'), runOnceKey: null, shortcuts: false}};
  return {roots, dataRoot, dll, temp, plugins, unrelated, sentinel, otherDll};
}

describe.each(['production', 'staging'] as const)('the shared deferred-cleanup case table in the %s channel', channel => {
  let m: ChannelModules;
  beforeAll(async () => {m = await channelModules(channel);});

  it('runs the engine with this channel\'s names', () => {
    expect(m.CHANNEL.channel).toBe(channel);
    expect(m.tempName.startsWith(channel === 'staging' ? 'ets2telemetry-plugin-staging.dll.' : 'ets2telemetry-plugin.dll.')).toBe(true);
    expect(m.otherPlugin).toBe(channel === 'staging' ? 'ets2telemetry-plugin.dll' : 'ets2telemetry-plugin-staging.dll');
  });

  it('is the expected table', () => {
    expect({format: TABLE.format, version: TABLE.version}).toEqual({format: 'ets2telemetry.deferred-cleanup-cases', version: 1});
    expect(new Set(TABLE.cases.map(entry => entry.id)).size).toBe(TABLE.cases.length);
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(17);
  });

  it.each(TABLE.cases.map(entry => [entry.id, entry] as const))('%s: the engine keeps and removes what the table says', async (_id, entry) => {
    const built = await scene(m, entry);
    expect(built.dataRoot.endsWith(`\\${m.CHANNEL.dataRootName}`)).toBe(true);
    const otherBefore = entry.folder.otherChannel ? await fsp.stat(built.otherDll) : undefined;
    const checkRunning: RunningCheck = () => Promise.resolve({ok: true, running: m.runningGames(entry.running.map((name, pid) => ({name, pid: pid + 1})))});
    let clock = 0;
    // `lateEntry`: an allowlisted entry that a writer leaves behind after the registry step, so it is present at the
    // last step (the script's -TestLateEntry does the same); the last step must still remove it and then the root.
    const late = entry.data?.lateEntry;
    const registryFolder = path.win32.join(built.dataRoot, 'plugins').toLowerCase();
    const fs: typeof guard.fs = late ? {...guard.fs, rmdir: async (...args: Parameters<typeof guard.fs.rmdir>) => {
      await guard.fs.rmdir(...args);
      if (String(args[0]).toLowerCase() === registryFolder) {
        await guard.fs.mkdir(path.win32.join(built.dataRoot, late), {recursive: true});
        await guard.fs.writeFile(path.win32.join(built.dataRoot, late, 'late.jsonl'), 'written after the registry step\n');
      }
    }} : guard.fs;
    const result = await m.runUninstall({roots: built.roots, fs, checkRunning, known: [], clock: () => clock++,
      deadline: Number.MAX_SAFE_INTEGER, delay: () => Promise.resolve(), now: () => new Date(UTC)});
    const dataRoot = await fsp.readdir(built.dataRoot).then(names => names.sort(), () => null);
    const observed: Record<string, unknown> = {outcome: result.outcome, code: result.code, dll: await state(built.dll), dataRoot};
    if (entry.expect.temp) observed.temp = await state(built.temp);
    if (entry.expect.pluginsDirectory) observed.pluginsDirectory = await state(built.plugins);
    if (entry.expect.unrelated) observed.unrelated = await state(built.unrelated);
    if (entry.expect.sentinel) observed.sentinel = await state(built.sentinel);
    if (entry.expect.otherChannelDll) observed.otherChannelDll = await state(built.otherDll);
    expect(observed).toEqual(entry.expect);
    // The other channel's plugin stays exactly as it was: bytes and modification time.
    if (otherBefore) {
      expect(await fsp.readFile(built.otherDll, 'utf8')).toBe(TABLE.contents.owned);
      expect((await fsp.stat(built.otherDll)).mtimeMs).toBe(otherBefore.mtimeMs);
    }
    // A file that stays keeps its bytes.
    if (entry.expect.dll === 'present' && entry.folder.dll !== 'none') expect(await fsp.readFile(built.dll, 'utf8')).toBe(TABLE.contents[entry.folder.dll]);
  });
});
