import {readFileSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ShortcutLink} from '../../apps/desktop/src/legacy-shortcuts';
import {cancelDeferralOnStart, countOtherProcesses, deadlineSignal, EXIT_CODES, hookDeadlines, prepareSquirrelProcess, PROCESS_POLL_MS, INSTANCE_EXIT_WAIT_MS, parseSquirrelArgs, PROCESS_START_MARGIN_MS, RECEIPT_FORMAT, runSquirrelEvent, settle,
  UNINSTALL_DEADLINE_MS, UNINSTALL_HARD_STOP_MS,
  type SquirrelArgs, type SquirrelPorts, type UninstallReceipt} from '../../apps/desktop/src/squirrel-events';
import type {UninstallPorts, UninstallResult} from '../../apps/desktop/src/uninstall/engine';
import {EXECUTOR_FILE, executorCommand, RUN_ONCE_VALUE} from '../../apps/desktop/src/uninstall/executor';
import {resolveUninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {fileWorkBudget, withoutFlush} from '../shared/file-work';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, fakeRunOnce, fakeUninstallEntry, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, notRunning, seedData, TEST_RUN_ONCE,
  useRunOnceKey, UTC, writeRegistry, type FakeGameFolder, type FakeRunOnce, type FakeUninstallEntry, type InstallFixture} from '../shared/uninstall-fixture';

// REG-015, REG-017 (ET-018 U2, U6): the Squirrel event handler on fake installs under the guarded temporary root. Every
// port is injected: no Update.exe, no lock, no tasklist and no %TEMP% receipt is real, and the handler never sees the
// real execPath layout.

// The guard skips the flush to disk of every file opened through it (withoutFlush, tests/shared/file-work.ts): no case in
// this file observes durability across a power loss. Single syncs of the atomic writes took up to 1,211 ms here under
// load on October 28, 2026, nearly all of a slow case's time (ET-019, docs/validation/et-019.md).
// The cases build scenes and run the code under test on real temporary files: at most 680 file requests
// per case (libuv promise and callback requests and handle closes, counted for every case on October 28, 2026), rounded
// up to 700. Without the flush, single stalled requests still made a case take seconds in a full npm test. This
// named budget bounds that file work at FS_OPERATION_ALLOWANCE_MS per request (TESTING.md section 6), not behaviour
// timing: the cases run on injected clocks and assert no real time, and a case with its own timeout keeps it.
const CASE_FS_OPERATIONS = 700;
vi.setConfig({testTimeout: fileWorkBudget(CASE_FS_OPERATIONS)});
let guard: GuardedRoot;
beforeEach(async () => {guard = withoutFlush(await guardedTempRoot('ets2telemetry-squirrel-events-'));});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const event = (name: 'install' | 'updated' | 'obsolete' | 'uninstall'): SquirrelArgs => ({kind: 'event', event: name, version: '0.1.0'});

/** The tracked executor script, which the production port reads from the packaged resources. */
const SCRIPT = readFileSync(path.join(import.meta.dirname, '..', '..', 'resources', 'uninstall', EXECUTOR_FILE));
const RUN_ONCE_ENTRY = `${TEST_RUN_ONCE}\\${RUN_ONCE_VALUE}`;
const WINDOWS = 'C:\\Windows';

/** The tracked product icon, which the production port reads from the packaged resources (ET-045g). */
const ICON = readFileSync(path.join(import.meta.dirname, '..', '..', 'resources', 'icon', 'app.ico'));

interface Harness {
  ports: SquirrelPorts;
  /** The in-memory RunOnce registry; the real key is never written. */
  registry: FakeRunOnce;
  /** The in-memory uninstall entry (ET-045g); the real key is never written. */
  entry: FakeUninstallEntry;
  /** How often the bundled icon was read. */
  iconReads: () => number;
  receipts: {name: string; receipt: UninstallReceipt; text: string}[];
  updates: {installRoot: string; args: readonly string[]}[];
  lockRequests: () => number;
  /** Resolves at the first lock request, so a case can wait for the run to reach it without a wall-clock wait. */
  firstLockRequest: Promise<void>;
  order: string[];
  advance(milliseconds: number): void;
}
/** Fake ports around `fixture`; the clock advances only through `delay` and `advance`. */
function harness(fixture: InstallFixture, overrides: Partial<SquirrelPorts> & {env?: Record<string, string>; locks?: boolean[]} = {}): Harness {
  let clock = 1000, requests = 0, iconReads = 0, locked: () => void = () => undefined;
  const firstLockRequest = new Promise<void>(resolve => {locked = resolve;});
  const receipts: Harness['receipts'] = [], updates: Harness['updates'] = [], order: string[] = [];
  const {env, locks, ...rest} = overrides;
  const registry = fakeRunOnce({onSet: () => order.push('register')});
  const entry = fakeUninstallEntry({onSet: () => order.push('display-icon')});
  const ports: SquirrelPorts = {
    appVersion: '0.1.0',
    executableName: 'ETS2TelemetryDesktop.exe',
    resolveRoots: () => resolveUninstallRoots({executable: fixture.executable, env: env ?? {}, fs: fixture.fs}),
    useProfile: () => true,
    requestInstanceLock: () => {
      order.push('lock');
      const answer = locks ? locks[Math.min(requests, locks.length - 1)] : true;
      requests++;
      locked();
      return answer;
    },
    runUpdate: (installRoot, args) => {updates.push({installRoot, args}); return Promise.resolve(true);},
    fs: fixture.fs,
    runOnce: registry,
    windowsDirectory: WINDOWS,
    readExecutor: () => Promise.resolve(SCRIPT),
    readBundledIcon: () => {iconReads++; return Promise.resolve(ICON);},
    uninstallEntry: entry,
    // ET-045h: no shortcut folder by default, so the old-name step touches nothing unless a case gives it folders.
    shortcutFolders: () => undefined,
    readShortcut: () => undefined,
    checkRunning: notRunning,
    readKnown: () => Promise.resolve(KNOWN),
    countOtherProcesses: () => Promise.resolve(0),
    deadlineSignal: () => new AbortController().signal,
    writeReceipt: (name, text) => {receipts.push({name, text, receipt: JSON.parse(text) as UninstallReceipt}); return Promise.resolve(true);},
    clock: () => clock,
    delay: milliseconds => {clock += milliseconds; return Promise.resolve();},
    hardStop: () => new Promise<void>(() => undefined),
    now: () => new Date(UTC),
    ...rest
  };
  return {ports, registry, entry, iconReads: () => iconReads, receipts, updates, order, lockRequests: () => requests, firstLockRequest,
    advance: milliseconds => {clock += milliseconds;}};
}

interface Scene {fixture: InstallFixture; game: FakeGameFolder; unrelated: string}
/** An installed scene: one fake ETS2 folder with the recorded plugin and an unrelated DLL, and every data entry. */
async function scene(options: {testRoot?: boolean; shortcuts?: boolean; runOnceKey?: string} = {}): Promise<Scene> {
  const fixture = await installFixture(guard, {testRoot: options.testRoot});
  if (options.shortcuts || options.runOnceKey) await useRunOnceKey(fixture, options.runOnceKey ?? null, options.shortcuts === true);
  const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
  const unrelated = path.win32.join(game.plugins, 'other-plugin.dll');
  await fsp.writeFile(unrelated, 'another tool');
  await writeRegistry(fixture, [installRecord(game)]);
  await seedData(fixture);
  return {fixture, game, unrelated};
}
const deferralFiles = (fixture: InstallFixture) => ['pending.json', 'README.txt'].map(name => path.win32.join(fixture.dataRoot, 'uninstall', name));
async function seedDeferral(fixture: InstallFixture): Promise<void> {
  await fsp.mkdir(path.win32.join(fixture.dataRoot, 'uninstall'), {recursive: true});
  for (const file of deferralFiles(fixture)) await fsp.writeFile(file, 'deferred');
}
/** The entry the install and updated hooks add to the base (ET-045g): the product icon in Squirrel's install root. */
const ICON_ENTRY = 'ETS2TelemetryDesktop\\app.ico';
/** `tree` without `added`, after checking that each of `added` is in it exactly once. */
function withoutAdded(tree: string[], added: readonly string[]): string[] {
  for (const entry of added) expect(tree.filter(row => row === entry)).toEqual([entry]);
  return tree.filter(row => !added.includes(row));
}
/** A receipt never names a path: no drive letter, no backslash, nothing of the test root. */
function expectNoPath(text: string, fixture: InstallFixture) {
  expect(text).not.toMatch(/[A-Za-z]:\\|\\\\/);
  expect(text.toLowerCase()).not.toContain(path.win32.basename(fixture.testRoot).toLowerCase() + '\\');
}

describe('parseSquirrelArgs', () => {
  it.each([
    [[], {kind: 'none'}],
    [['--inspect'], {kind: 'none'}],
    [['--squirrel-firstrun'], {kind: 'none'}],
    [['--squirrel-install', '0.1.0'], {kind: 'event', event: 'install', version: '0.1.0'}],
    [['--squirrel-updated', '0.1.1'], {kind: 'event', event: 'updated', version: '0.1.1'}],
    [['--squirrel-obsolete', '0.1.0'], {kind: 'event', event: 'obsolete', version: '0.1.0'}],
    [['--squirrel-uninstall', '0.1.0-alpha.1'], {kind: 'event', event: 'uninstall', version: '0.1.0-alpha.1'}]
  ] as const)('parses %j', (args, expected) => {
    expect(parseSquirrelArgs(args)).toEqual(expected);
  });
  it.each([
    [['--squirrel-uninstall']],
    [['--squirrel-uninstall', 'latest']],
    [['--squirrel-uninstall', '0.1.0', '--extra']],
    [['--extra', '--squirrel-uninstall', '0.1.0']],
    [['--squirrel-uninstall=0.1.0']],
    [['--SQUIRREL-UNINSTALL', '0.1.0']],
    [['--squirrel-firstrun', '0.1.0']],
    [['--squirrel-unknown', '0.1.0']],
    [['--squirrel-install', '..\\..\\0.1.0']]
  ] as const)('refuses %j', args => {
    expect(parseSquirrelArgs(args)).toEqual({kind: 'invalid'});
  });
});

describe('install, updated and obsolete', () => {
  // ET-045g changed this case for install and updated: they now also add the product icon to Squirrel's install root,
  // and nothing else; obsolete still changes nothing.
  it.each(['install', 'updated', 'obsolete'] as const)('%s never runs the engine, never requests the lock and keeps every data entry', async name => {
    const {fixture} = await scene();
    const before = await listTree(fixture.base);
    const engine = vi.fn<(ports: UninstallPorts) => Promise<UninstallResult>>();
    const test = harness(fixture, {runUninstall: engine});
    expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(engine).not.toHaveBeenCalled();
    expect(test.lockRequests()).toBe(0);
    expect(test.receipts).toEqual([]);
    expect(withoutAdded(await listTree(fixture.base), name === 'obsolete' ? [] : [ICON_ENTRY])).toEqual(before);
  });

  it('obsolete does not even resolve the roots', async () => {
    const resolveRoots = vi.fn<SquirrelPorts['resolveRoots']>();
    const {fixture} = await scene();
    expect(await runSquirrelEvent(event('obsolete'), harness(fixture, {resolveRoots}).ports)).toBe(0);
    expect(resolveRoots).not.toHaveBeenCalled();
  });

  it.each(['install', 'updated'] as const)('%s skips the shortcuts in a test install whose test file does not ask for them', async name => {
    const {fixture} = await scene();
    const test = harness(fixture);
    await runSquirrelEvent(event(name), test.ports);
    expect(test.updates).toEqual([]);
  });

  it.each(['install', 'updated'] as const)('%s creates the shortcuts through Update.exe when the test file asks for them', async name => {
    const {fixture} = await scene({shortcuts: true});
    const test = harness(fixture);
    await runSquirrelEvent(event(name), test.ports);
    expect(test.updates).toEqual([{installRoot: fixture.installRoot, args: ['--createShortcut=ETS2TelemetryDesktop.exe']}]);
  });

  it('a production install creates the shortcuts; a portable or development layout creates none', async () => {
    const {fixture} = await scene({testRoot: false});
    const production = harness(fixture, {env: {LOCALAPPDATA: fixture.base}});
    await runSquirrelEvent(event('install'), production.ports);
    expect(production.updates).toEqual([{installRoot: fixture.installRoot, args: ['--createShortcut=ETS2TelemetryDesktop.exe']}]);
    const portable = harness(fixture, {resolveRoots: () => resolveUninstallRoots({executable: path.win32.join(guard.root, 'portable', 'app.exe'), env: {}, fs: fixture.fs})});
    await runSquirrelEvent(event('install'), portable.ports);
    expect(portable.updates).toEqual([]);
  });

  it.each(['install', 'updated'] as const)('%s cancels a pending deferral and removes nothing else', async name => {
    const {fixture, game} = await scene();
    await seedDeferral(fixture);
    const before = (await listTree(fixture.base)).filter(entry => !entry.startsWith('ETS2Telemetry\\uninstall'));
    await runSquirrelEvent(event(name), harness(fixture).ports);
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall'))).toBe(false);
    // ET-045g: the product icon in Squirrel's install root is the only addition.
    expect(withoutAdded(await listTree(fixture.base), [ICON_ENTRY])).toEqual(before);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });
});

// REG-017 (ET-045g, owner decision D3): install and updated place the bundled product icon in Squirrel's install root and
// set this product's DisplayIcon, so Squirrel never downloads its default Electron icon. The registry is a fake.
describe('the Installed apps icon (ET-045g)', () => {
  const displayIcon = (fixture: InstallFixture) => `${path.win32.dirname(fixture.executable)}\\ETS2TelemetryDesktop.exe,0`;
  const iconFile = (fixture: InstallFixture) => path.win32.join(fixture.installRoot, 'app.ico');

  it.each([['install', true], ['install', false], ['updated', true], ['updated', false]] as const)(
    '%s places the bundled icon and sets DisplayIcon once to the versioned executable (test root: %s)', async (name, testRoot) => {
      const {fixture} = await scene({testRoot});
      const test = harness(fixture, testRoot ? {} : {env: {LOCALAPPDATA: fixture.base}});
      expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
      expect(await fsp.readFile(iconFile(fixture))).toEqual(ICON);
      expect(test.entry.calls).toEqual([displayIcon(fixture)]);
      expect(displayIcon(fixture)).toMatch(/\\app-0\.1\.0\\ETS2TelemetryDesktop\.exe,0$/);
      expect(test.iconReads()).toBe(1);
    });

  it('updated replaces a legacy app.ico that Squirrel downloaded earlier', async () => {
    const {fixture} = await scene();
    await fsp.writeFile(iconFile(fixture), 'the Electron icon Squirrel downloaded');
    const test = harness(fixture);
    expect(await runSquirrelEvent(event('updated'), test.ports)).toBe(0);
    expect(await fsp.readFile(iconFile(fixture))).toEqual(ICON);
    expect(test.entry.calls).toEqual([displayIcon(fixture)]);
  });

  it.each(['obsolete', 'uninstall'] as const)('%s never reads the icon or writes DisplayIcon', async name => {
    const {fixture} = await scene();
    const test = harness(fixture);
    await runSquirrelEvent(event(name), test.ports);
    expect(test.iconReads()).toBe(0);
    expect(test.entry.calls).toEqual([]);
  });

  it('a portable or development layout reads no icon and writes no DisplayIcon', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {resolveRoots: () => resolveUninstallRoots({executable: path.win32.join(guard.root, 'portable', 'app.exe'), env: {}, fs: fixture.fs})});
    for (const name of ['install', 'updated'] as const) expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(test.iconReads()).toBe(0);
    expect(test.entry.calls).toEqual([]);
    expect(await exists(iconFile(fixture))).toBe(false);
  });

  it('a registry that keeps failing is tried twice, and the shortcuts, the icon and the deferral cancel still happen', async () => {
    const {fixture} = await scene({shortcuts: true});
    await seedDeferral(fixture);
    const entry = fakeUninstallEntry({results: [false]});
    const test = harness(fixture, {uninstallEntry: entry});
    expect(await runSquirrelEvent(event('install'), test.ports)).toBe(0);
    expect(entry.calls).toEqual([displayIcon(fixture), displayIcon(fixture)]);
    expect(test.updates).toEqual([{installRoot: fixture.installRoot, args: ['--createShortcut=ETS2TelemetryDesktop.exe']}]);
    expect(await fsp.readFile(iconFile(fixture))).toEqual(ICON);
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
  });

  it('a first registry failure is retried once and then set', async () => {
    const {fixture} = await scene();
    const entry = fakeUninstallEntry({results: [false, true]});
    expect(await runSquirrelEvent(event('updated'), harness(fixture, {uninstallEntry: entry}).ports)).toBe(0);
    expect(entry.calls).toHaveLength(2);
    expect(entry.displayIcon()).toBe(displayIcon(fixture));
  });

  it.each([
    ['cannot be read', () => Promise.resolve(undefined)],
    ['throws', () => Promise.reject(new Error('unreadable'))],
    ['is not an icon file', () => Promise.resolve(Buffer.from('not an icon'))]
  ] as const)('a bundled icon that %s writes no file, still sets DisplayIcon and keeps the shortcuts and the deferral cancel', async (_name, readBundledIcon) => {
    const {fixture} = await scene({shortcuts: true});
    await seedDeferral(fixture);
    const test = harness(fixture, {readBundledIcon});
    expect(await runSquirrelEvent(event('install'), test.ports)).toBe(0);
    expect(await exists(iconFile(fixture))).toBe(false);
    expect((await fsp.readdir(fixture.installRoot)).filter(entry => entry.startsWith('app.ico'))).toEqual([]);
    expect(test.entry.calls).toEqual([displayIcon(fixture)]);
    expect(test.updates).toHaveLength(1);
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
  });

  it('runs beside the shortcuts: DisplayIcon is set while Update.exe --createShortcut is still running', async () => {
    const {fixture} = await scene({shortcuts: true});
    let release: (ok: boolean) => void = () => undefined, started: () => void = () => undefined;
    const shortcutStarted = new Promise<void>(resolve => {started = resolve;});
    let iconSet: () => void = () => undefined;
    const displayIconSet = new Promise<void>(resolve => {iconSet = resolve;});
    const entry = fakeUninstallEntry({onSet: () => iconSet()});
    const test = harness(fixture, {uninstallEntry: entry, runUpdate: () => {started(); return new Promise<boolean>(resolve => {release = resolve;});}});
    let finished = false;
    const run = runSquirrelEvent(event('install'), test.ports).then(code => {finished = true; return code;});
    await shortcutStarted;
    await displayIconSet;
    expect(finished).toBe(false);
    expect(entry.calls).toEqual([displayIcon(fixture)]);
    release(true);
    expect(await run).toBe(0);
  });
});

// REG-017, REG-015 (ET-045h, owner decision D2): the hooks delete this install's old "ETS2Telemetry Desktop" shortcuts.
// The Desktop and Start menu folders are fake folders in the guarded test root and the shortcut reader is a fake; no real
// known folder or shortcut is touched.
interface ShortcutScene {desktop: string; programs: string; legacy: {desktop: string; startMenu: string}; current: {desktop: string; startMenu: string}}
async function shortcutScene(fixture: InstallFixture, files: {legacy?: boolean; current?: boolean} = {}): Promise<ShortcutScene> {
  const desktop = path.win32.join(fixture.testRoot, 'Desktop'), programs = path.win32.join(fixture.testRoot, 'Start Menu', 'Programs');
  const company = path.win32.join(programs, 'Artur Sianiuk');
  await fsp.mkdir(desktop, {recursive: true});
  await fsp.mkdir(company, {recursive: true});
  const scene: ShortcutScene = {desktop, programs, legacy: {desktop: path.win32.join(desktop, 'ETS2Telemetry Desktop.lnk'), startMenu: path.win32.join(company, 'ETS2Telemetry Desktop.lnk')},
    current: {desktop: path.win32.join(desktop, 'Yukon Union Telemetry.lnk'), startMenu: path.win32.join(company, 'Yukon Union Telemetry.lnk')}};
  for (const file of files.legacy === false ? [] : [scene.legacy.desktop, scene.legacy.startMenu]) await fsp.writeFile(file, 'old shortcut');
  for (const file of files.current === false ? [] : [scene.current.desktop, scene.current.startMenu]) await fsp.writeFile(file, 'new shortcut');
  return scene;
}
/** Ports that see the fake folders and read every shortcut as this install's root stub, unless `links` says otherwise. */
function shortcutPorts(fixture: InstallFixture, scene: ShortcutScene, links: Record<string, ShortcutLink | undefined> = {}): {reads: string[]; ports: Pick<SquirrelPorts, 'shortcutFolders' | 'readShortcut'>} {
  const reads: string[] = [];
  return {reads, ports: {shortcutFolders: () => ({desktop: scene.desktop, startMenuPrograms: scene.programs}),
    readShortcut: file => {
      reads.push(file);
      return file in links ? links[file] : {target: path.win32.join(fixture.installRoot, 'ETS2TelemetryDesktop.exe'), appUserModelId: 'com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop'};
    }}};
}
const RECEIPT_KEYS = ['appVersion', 'code', 'createdUtc', 'data', 'elapsedMs', 'executor', 'failedStep', 'format', 'instance', 'mode', 'otherProcesses', 'outcome', 'plugins',
  'processWaitMs', 'readme', 'roaming', 'shortcuts', 'startupOffsetMs', 'version'];

describe('the old-name shortcuts (ET-045h)', () => {
  it.each(['install', 'updated'] as const)('%s deletes this install\'s old-name shortcuts once Update.exe created the new ones', async name => {
    const {fixture} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture);
    const {reads, ports} = shortcutPorts(fixture, shortcuts);
    const test = harness(fixture, ports);
    expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(await exists(shortcuts.legacy.desktop)).toBe(false);
    expect(await exists(shortcuts.legacy.startMenu)).toBe(false);
    expect(await fsp.readFile(shortcuts.current.desktop, 'utf8')).toBe('new shortcut');
    expect(await fsp.readFile(shortcuts.current.startMenu, 'utf8')).toBe('new shortcut');
    expect(reads).toEqual([shortcuts.legacy.desktop, shortcuts.legacy.startMenu]);
    // The company folder stays, and nothing else in either folder changed.
    expect(await fsp.readdir(shortcuts.desktop)).toEqual(['Yukon Union Telemetry.lnk']);
    expect(await fsp.readdir(path.win32.join(shortcuts.programs, 'Artur Sianiuk'))).toEqual(['Yukon Union Telemetry.lnk']);
  });

  it('keeps a foreign old-name shortcut and one without a new-name shortcut beside it', async () => {
    const {fixture} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture);
    await fsp.rm(shortcuts.current.startMenu);
    const {reads, ports} = shortcutPorts(fixture, shortcuts, {[shortcuts.legacy.desktop]: {target: path.win32.join(fixture.testRoot, 'decoy-target', 'ETS2TelemetryDesktop.exe')}});
    expect(await runSquirrelEvent(event('updated'), harness(fixture, ports).ports)).toBe(0);
    expect(await fsp.readFile(shortcuts.legacy.desktop, 'utf8')).toBe('old shortcut');
    expect(await fsp.readFile(shortcuts.legacy.startMenu, 'utf8')).toBe('old shortcut');
    expect(reads).toEqual([shortcuts.legacy.desktop]);
  });

  it.each(['install', 'updated'] as const)('%s never looks at shortcuts in a test install whose test file does not ask for them', async name => {
    const {fixture} = await scene();
    const shortcuts = await shortcutScene(fixture);
    const folders = vi.fn(() => ({desktop: shortcuts.desktop, startMenuPrograms: shortcuts.programs}));
    const readShortcut = vi.fn<SquirrelPorts['readShortcut']>();
    expect(await runSquirrelEvent(event(name), harness(fixture, {shortcutFolders: folders, readShortcut}).ports)).toBe(0);
    expect(folders).not.toHaveBeenCalled();
    expect(readShortcut).not.toHaveBeenCalled();
    expect(await exists(shortcuts.legacy.desktop)).toBe(true);
  });

  it.each([['fails', () => Promise.resolve(false)], ['throws', () => Promise.reject(new Error('Update.exe'))]] as const)(
    'keeps the old-name shortcuts when Update.exe --createShortcut %s', async (_label, runUpdate) => {
      const {fixture} = await scene({shortcuts: true});
      const shortcuts = await shortcutScene(fixture);
      const {reads, ports} = shortcutPorts(fixture, shortcuts);
      expect(await runSquirrelEvent(event('install'), harness(fixture, {...ports, runUpdate}).ports)).toBe(0);
      expect(reads).toEqual([]);
      expect(await exists(shortcuts.legacy.desktop)).toBe(true);
      expect(await exists(shortcuts.legacy.startMenu)).toBe(true);
    });

  it('a failing old-name step changes neither the icon, the deferral cancel nor the exit code', async () => {
    const {fixture} = await scene({shortcuts: true});
    await seedDeferral(fixture);
    const shortcuts = await shortcutScene(fixture);
    const {ports} = shortcutPorts(fixture, shortcuts);
    const unlink = (target: string) => target.toLowerCase().endsWith('.lnk') ? Promise.reject(Object.assign(new Error('EPERM'), {code: 'EPERM'})) : fixture.fs.unlink(target);
    const test = harness(fixture, {...ports, fs: {...fixture.fs, unlink}, shortcutFolders: () => {throw new Error('no known folder');}});
    expect(await runSquirrelEvent(event('install'), test.ports)).toBe(0);
    const failing = harness(fixture, {...ports, fs: {...fixture.fs, unlink}});
    expect(await runSquirrelEvent(event('updated'), failing.ports)).toBe(0);
    expect(await exists(shortcuts.legacy.desktop)).toBe(true);
    expect(await fsp.readFile(path.win32.join(fixture.installRoot, 'app.ico'))).toEqual(ICON);
    expect(failing.entry.calls).toHaveLength(1);
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
  });

  it('runs beside the deferral cancel: old-name shortcuts go while the RunOnce removal is still running, within the 1 s budget', async () => {
    const {fixture} = await scene({shortcuts: true, runOnceKey: TEST_RUN_ONCE});
    await seedDeferral(fixture);
    const shortcuts = await shortcutScene(fixture);
    const registry = fakeRunOnce();
    let release: () => void = () => undefined, started: () => void = () => undefined;
    const removalStarted = new Promise<void>(resolve => {started = resolve;});
    const held: FakeRunOnce = {...registry, remove: (key, value, timeoutMs) => {started(); return new Promise<void>(resolve => {release = resolve;}).then(() => registry.remove(key, value, timeoutMs));}};
    const {reads, ports} = shortcutPorts(fixture, shortcuts);
    // The unlink port opens a gate once the last old-name shortcut (the Start menu one, read last) is gone, so the case
    // waits for the step to reach it instead of polling under vi.waitFor's default 1 s real-time limit (ET-019).
    let lastRemoved: () => void = () => undefined;
    const legacyRemoved = new Promise<void>(resolve => {lastRemoved = resolve;});
    const unlink = async (target: string) => {
      await fixture.fs.unlink(target);
      if (target.toLowerCase() === shortcuts.legacy.startMenu.toLowerCase()) lastRemoved();
    };
    const test = harness(fixture, {...ports, runOnce: held, fs: {...fixture.fs, unlink}});
    let finished = false;
    const run = runSquirrelEvent(event('updated'), test.ports).then(code => {finished = true; return code;});
    await removalStarted;
    await legacyRemoved;
    expect(await exists(shortcuts.legacy.startMenu)).toBe(false);
    expect(await exists(shortcuts.legacy.desktop)).toBe(false);
    expect(finished).toBe(false);
    release();
    expect(await run).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it('stops at its 1 s budget: a shortcut read that takes it keeps the rest', async () => {
    const {fixture} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture);
    let advance: (milliseconds: number) => void = () => undefined;
    const {reads, ports} = shortcutPorts(fixture, shortcuts);
    const test = harness(fixture, {...ports, readShortcut: file => {advance(1000); return ports.readShortcut(file);}});
    advance = test.advance;
    expect(await runSquirrelEvent(event('install'), test.ports)).toBe(0);
    expect(reads).toEqual([shortcuts.legacy.desktop]);
    expect(await exists(shortcuts.legacy.desktop)).toBe(true);
    expect(await exists(shortcuts.legacy.startMenu)).toBe(true);
  });

  it('uninstall removes owned old-name shortcuts after Update.exe --removeShortcut and reports them as removed', async () => {
    const {fixture} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture, {current: false});
    const order: string[] = [];
    const {reads, ports} = shortcutPorts(fixture, shortcuts);
    const test = harness(fixture, {...ports, runUpdate: (_installRoot, args) => {order.push(args[0]); return Promise.resolve(true);},
      readShortcut: file => {order.push('read'); return ports.readShortcut(file);}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(order).toEqual(['--removeShortcut=ETS2TelemetryDesktop.exe', 'read', 'read']);
    expect(await exists(shortcuts.legacy.desktop)).toBe(false);
    expect(await exists(shortcuts.legacy.startMenu)).toBe(false);
    expect(reads).toHaveLength(2);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', shortcuts: 'removed'});
    expect(Object.keys(test.receipts[0].receipt).sort()).toEqual(RECEIPT_KEYS);
  });

  it('uninstall reports the shortcuts failed when an old-name shortcut cannot be deleted, and keeps the engine\'s outcome', async () => {
    const {fixture, game} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture, {current: false});
    const {ports} = shortcutPorts(fixture, shortcuts);
    const unlink = (target: string) => target.toLowerCase().endsWith('.lnk') ? Promise.reject(Object.assign(new Error('EPERM'), {code: 'EPERM'})) : fixture.fs.unlink(target);
    const test = harness(fixture, {...ports, fs: {...fixture.fs, unlink}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', code: null, shortcuts: 'failed', failedStep: null});
    expect(Object.keys(test.receipts[0].receipt).sort()).toEqual(RECEIPT_KEYS);
    expect(await exists(game.dll)).toBe(false);
    expect(await exists(shortcuts.legacy.desktop)).toBe(true);
  });

  it('uninstall keeps a foreign old-name shortcut and still reports the shortcuts removed', async () => {
    const {fixture} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture, {current: false});
    const {ports} = shortcutPorts(fixture, shortcuts, {[shortcuts.legacy.desktop]: {target: 'C:\\Program Files\\Other\\Other.exe'}});
    const test = harness(fixture, ports);
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(await fsp.readFile(shortcuts.legacy.desktop, 'utf8')).toBe('old shortcut');
    expect(await exists(shortcuts.legacy.startMenu)).toBe(false);
    expect(test.receipts[0].receipt.shortcuts).toBe('removed');
  });

  interface ReaderScene {ports: Pick<SquirrelPorts, 'readShortcut'>; advance(milliseconds: number): void}
  // Fix round 1: an old-name shortcut whose ownership was never decided may still be this install's, so the receipt must
  // not call the shortcuts removed. A shortcut proven foreign (the case above) does not count.
  it.each([
    ['cannot be read', (scene: ReaderScene): SquirrelPorts['readShortcut'] =>
      file => file.endsWith('ETS2Telemetry Desktop.lnk') && file.includes('Desktop\\') ? undefined : scene.ports.readShortcut(file)],
    ['takes the whole 1 s budget', (scene: ReaderScene): SquirrelPorts['readShortcut'] =>
      file => {scene.advance(1000); return scene.ports.readShortcut(file);}]
  ] as const)('uninstall reports the shortcuts failed when an old-name shortcut %s, and keeps the engine\'s outcome', async (_label, reader) => {
    const {fixture, game} = await scene({shortcuts: true});
    const shortcuts = await shortcutScene(fixture, {current: false});
    const {ports} = shortcutPorts(fixture, shortcuts);
    let advance: (milliseconds: number) => void = () => undefined;
    const test = harness(fixture, {...ports, readShortcut: file => reader({ports, advance})(file)});
    advance = test.advance;
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', code: null, shortcuts: 'failed', failedStep: null});
    expect(Object.keys(test.receipts[0].receipt).sort()).toEqual(RECEIPT_KEYS);
    expect(await exists(game.dll)).toBe(false);
    expect(await exists(shortcuts.legacy.desktop)).toBe(true);
  });

  it('uninstall in a test install without shortcuts never looks at them', async () => {
    const {fixture} = await scene();
    const shortcuts = await shortcutScene(fixture);
    const readShortcut = vi.fn<SquirrelPorts['readShortcut']>();
    const test = harness(fixture, {shortcutFolders: () => ({desktop: shortcuts.desktop, startMenuPrograms: shortcuts.programs}), readShortcut});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(readShortcut).not.toHaveBeenCalled();
    expect(test.receipts[0].receipt.shortcuts).toBe('skipped');
  });
});

describe('uninstall', () => {
  it('requests the lock before the engine, cleans everything and writes a complete receipt without a path', async () => {
    const {fixture, game, unrelated} = await scene();
    const test = harness(fixture);
    const engine = test.ports.runUninstall;
    expect(engine).toBeUndefined();
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(await exists(fixture.dataRoot)).toBe(false);
    expect(await exists(game.dll)).toBe(false);
    expect(await fsp.readFile(unrelated, 'utf8')).toBe('another tool');
    expect(test.receipts).toHaveLength(1);
    const [{name, receipt, text}] = test.receipts;
    expect(name).toMatch(/^ETS2Telemetry-uninstall-\d{8}T\d{9}Z\.json$/);
    expect(receipt).toMatchObject({format: RECEIPT_FORMAT, version: 1, outcome: 'complete', code: null, mode: 'test-root', instance: 'none',
      plugins: {removed: 1, absent: 0, unrecognized: 0, notes: [], blocked: []}, data: {failed: [], rootRemoved: true}, roaming: 'not-applicable', readme: false,
      shortcuts: 'skipped'});
    expectNoPath(text, fixture);
  });

  it('removes the autostart login item during squirrel uninstall', async () => {
    const {fixture} = await scene();
    const removed: {installRoot: string; executableName?: string}[] = [];
    const test = harness(fixture, {
      removeLoginItem: (installRoot, executableName) => {
        removed.push({installRoot, executableName});
      }
    });
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(removed).toEqual([{installRoot: fixture.installRoot, executableName: 'ETS2TelemetryDesktop.exe'}]);
  });

  it('refuses a layout that is not an install, changes nothing and exits 4', async () => {
    const {fixture} = await scene();
    const before = await listTree(guard.root);
    const test = harness(fixture, {resolveRoots: () => resolveUninstallRoots({executable: path.win32.join(guard.root, 'portable', 'app.exe'), env: {}, fs: fixture.fs})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.refused);
    expect(test.lockRequests()).toBe(0);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.code])).toEqual([['refused', 'NOT_INSTALLED']]);
    expect(await listTree(guard.root)).toEqual(before);
  });

  it('an invalid Squirrel argument exits 4 and touches nothing', async () => {
    const {fixture} = await scene();
    const before = await listTree(guard.root);
    const test = harness(fixture);
    expect(await runSquirrelEvent({kind: 'invalid'}, test.ports)).toBe(EXIT_CODES.refused);
    expect(test.lockRequests() + test.receipts.length + test.updates.length).toBe(0);
    expect(await listTree(guard.root)).toEqual(before);
  });

  it('takes the roots from the install, not from LOCALAPPDATA: a decoy data root in the environment stays byte-identical', async () => {
    const {fixture} = await scene();
    const decoy = path.win32.join(guard.root, 'decoy');
    await fsp.mkdir(path.win32.join(decoy, 'ETS2Telemetry', 'data'), {recursive: true});
    await fsp.writeFile(path.win32.join(decoy, 'ETS2Telemetry', 'data', 'telemetry.sqlite'), 'decoy history');
    const before = await listTree(decoy);
    expect(await runSquirrelEvent(event('uninstall'), harness(fixture, {env: {LOCALAPPDATA: decoy}}).ports)).toBe(EXIT_CODES.complete);
    expect(await exists(fixture.dataRoot)).toBe(false);
    expect(await listTree(decoy)).toEqual(before);
    expect(await fsp.readFile(path.win32.join(decoy, 'ETS2Telemetry', 'data', 'telemetry.sqlite'), 'utf8')).toBe('decoy history');
  });

  it('a production install whose LOCALAPPDATA names another folder is refused and keeps everything', async () => {
    const {fixture, game} = await scene({testRoot: false});
    const decoy = path.win32.join(guard.root, 'decoy');
    await fsp.mkdir(decoy, {recursive: true});
    const before = await listTree(fixture.base);
    const test = harness(fixture, {env: {LOCALAPPDATA: decoy}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.refused);
    expect(test.receipts[0].receipt.code).toBe('ROOT_MISMATCH');
    expect(await listTree(fixture.base)).toEqual(before);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });

  it('defers while a game runs: the DLL stays, only plugins and uninstall remain, README.txt names the folder and the hashes', async () => {
    const {fixture, game} = await scene();
    const test = harness(fixture, {checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await fsp.readdir(fixture.dataRoot)).toEqual(['plugins', 'uninstall']);
    expect((await fsp.readdir(path.win32.join(fixture.dataRoot, 'uninstall'))).sort()).toEqual(['README.txt', 'pending.json']);
    const readme = await fsp.readFile(path.win32.join(fixture.dataRoot, 'uninstall', 'README.txt'), 'utf8');
    expect(readme).toContain(game.dll);
    for (const hash of KNOWN) expect(readme).toContain(hash);
    expect(readme).toContain('GAME_RUNNING');
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', readme: true, plugins: {blocked: [{game: 'ets2', reason: 'GAME_RUNNING'}]}});
    expectNoPath(test.receipts[0].text, fixture);
  });

  it('a running instance that does not exit defers everything with INSTANCE_RUNNING and touches no game folder or data entry', async () => {
    const {fixture, game} = await scene();
    const before = (await listTree(fixture.base)).filter(entry => !entry.startsWith('ETS2Telemetry\\uninstall'));
    const engineSaw: (string | undefined)[] = [];
    const test = harness(fixture, {locks: [false]});
    const {runUninstall: real} = await import('../../apps/desktop/src/uninstall/engine');
    test.ports = {...test.ports, runUninstall: ports => {engineSaw.push(ports.deferAll); return real(ports);}};
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    // The first request and one more every 200 ms for 6 s, each signalling the running instance again.
    expect(test.lockRequests()).toBe(1 + INSTANCE_EXIT_WAIT_MS / 200);
    expect(engineSaw).toEqual(['INSTANCE_RUNNING']);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect((await listTree(fixture.base)).filter(entry => !entry.startsWith('ETS2Telemetry\\uninstall'))).toEqual(before);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'INSTANCE_RUNNING', instance: 'running', readme: true});
  });

  it('an instance that exits within the wait releases the lock and the cleanup completes', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {locks: [false, false, false, true]});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(test.lockRequests()).toBe(4);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', instance: 'exited'});
  });

  it('a test-root profile that cannot be used defers everything rather than missing a running instance', async () => {
    const {fixture, game} = await scene();
    const test = harness(fixture, {useProfile: () => false});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.lockRequests()).toBe(0);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(test.receipts[0].receipt.code).toBe('INSTANCE_RUNNING');
  });

  it('the 8 s deadline gives deferred, never complete, with the plugin and its registry kept', async () => {
    const {fixture, game} = await scene();
    let test: Harness | undefined = undefined;
    test = harness(fixture, {checkRunning: () => {test!.advance(UNINSTALL_DEADLINE_MS); return notRunning();}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'BUDGET_EXPIRED', readme: true});
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(await exists(path.win32.join(fixture.registryDirectory, 'setup.json'))).toBe(true);
  });

  it('a run that never settles stops at the hard stop with one deferred receipt', async () => {
    const {fixture} = await scene();
    let stop: () => void = () => undefined;
    const test = harness(fixture, {runUninstall: () => new Promise<UninstallResult>(() => undefined), hardStop: () => new Promise<void>(resolve => {stop = resolve;})});
    const running = runSquirrelEvent(event('uninstall'), test.ports);
    await test.firstLockRequest;
    expect(test.lockRequests()).toBe(1);
    stop();
    expect(await running).toBe(EXIT_CODES.deferred);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.code])).toEqual([['deferred', 'BUDGET_EXPIRED']]);
  });

  it('never reports complete while the data root remains, whatever the engine says', async () => {
    const {fixture} = await scene();
    const lying = (): Promise<UninstallResult> => Promise.resolve({outcome: 'complete', code: null, plugins: {removed: 1, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 7, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable', executor: 'not-run'});
    const test = harness(fixture, {runUninstall: lying});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'RESIDUE_REMAINS'});
  });

  it('settle keeps a clean complete and downgrades one with a blocked folder or a failed entry', () => {
    const complete: UninstallResult = {outcome: 'complete', code: null, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 0, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable', executor: 'not-run'};
    expect(settle(complete, false)).toEqual(complete);
    expect(settle({...complete, plugins: {...complete.plugins, blocked: [{game: 'ets2', reason: 'TARGET_LOCKED'}]}}, false)).toMatchObject({outcome: 'deferred', code: 'RESIDUE_REMAINS'});
    expect(settle({...complete, data: {...complete.data, failed: [{entry: 'logs', code: 'READ_ONLY_FILE'}]}}, false)).toMatchObject({outcome: 'deferred', code: 'RESIDUE_REMAINS'});
    expect(settle({...complete, outcome: 'deferred', code: 'GAME_RUNNING'}, true)).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING'});
  });

  it('removes the Roaming userData only for a production install, and keeps the notes in the receipt', async () => {
    const testRoot = await scene();
    const roamingTest = vi.fn(() => Promise.resolve(true));
    await runSquirrelEvent(event('uninstall'), harness(testRoot.fixture, {removeRoamingUserData: roamingTest}).ports);
    expect(roamingTest).not.toHaveBeenCalled();
    await guard.dispose().catch(() => undefined);
    guard = withoutFlush(await guardedTempRoot('ets2telemetry-squirrel-events-'));
    const production = await scene({testRoot: false});
    // A folder that is no longer a game folder: the plugin goes by hash and the receipt carries the fixed note.
    await fsp.rm(path.win32.join(production.game.root, 'bin', 'win_x64', 'eurotrucks2.exe'));
    const roamingProduction = vi.fn(() => Promise.resolve(true));
    const test = harness(production.fixture, {env: {LOCALAPPDATA: production.fixture.base}, removeRoamingUserData: roamingProduction});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(roamingProduction).toHaveBeenCalledOnce();
    expect(test.receipts[0].receipt).toMatchObject({mode: 'production', roaming: 'removed', shortcuts: 'removed'});
    expect(test.receipts[0].receipt.plugins.notes).toHaveLength(1);
    expect(test.updates.map(update => update.args)).toEqual([['--removeShortcut=ETS2TelemetryDesktop.exe']]);
  });

  it('an unrecognized file with the plugin name stays and is counted', async () => {
    const {fixture, game} = await scene();
    await fsp.writeFile(game.dll, FOREIGN);
    const test = harness(fixture);
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(await fsp.readFile(game.dll)).toEqual(FOREIGN);
    expect(test.receipts[0].receipt.plugins.unrecognized).toBe(1);
  });
});

describe('the hard stop and the run claim one result', () => {
  const COMPLETE: UninstallResult = {outcome: 'complete', code: null, plugins: {removed: 1, absent: 0, unrecognized: 0, notes: [], blocked: []},
    data: {removed: 8, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable', executor: 'not-run'};
  /** A gate: `open()` resolves `wait`. */
  function gate() {
    let open: () => void = () => undefined;
    const wait = new Promise<void>(resolve => {open = resolve;});
    return {wait, open: () => open()};
  }
  const flush = async () => {for (let index = 0; index < 20; index++) await Promise.resolve();};
  /** One macrotask turn: every microtask queued before it has run. No wall-clock wait. */
  const macrotask = () => new Promise<void>(resolve => setImmediate(resolve));

  it('the run settling just after the hard stop neither changes the code nor cuts the hard stop\'s receipt short', async () => {
    const {fixture} = await scene();
    const stop = gate(), engine = gate(), write = gate(), processWait = gate();
    let settled = false;
    const written: string[] = [];
    const test = harness(fixture, {
      runUninstall: async ports => {await engine.wait; await fsp.rm(ports.roots.ok ? ports.roots.dataRoot : '', {recursive: true}); return COMPLETE;},
      // The process wait is the run's last step before it claims the result: reaching it shows the run has settled.
      countOtherProcesses: () => {processWait.open(); return Promise.resolve(0);},
      hardStop: () => stop.wait,
      writeReceipt: async (_name, text) => {await write.wait; written.push((JSON.parse(text) as UninstallReceipt).code ?? 'null'); return true;}});
    const result = runSquirrelEvent(event('uninstall'), test.ports).then(code => {settled = true; return code;});
    await test.firstLockRequest;
    expect(test.lockRequests()).toBe(1);
    stop.open(); await flush();
    // The hard stop owns the result now; its receipt is still being written when the run settles.
    // After the process wait only microtasks are left before the run's claim; one macrotask turn drains them all.
    engine.open(); await processWait.wait; await macrotask();
    expect(settled).toBe(false);
    write.open();
    expect(await result).toBe(EXIT_CODES.deferred);
    expect(written).toEqual(['BUDGET_EXPIRED']);
  });

  it('the hard stop firing while the run writes its receipt waits for that receipt and keeps the run\'s code', async () => {
    const {fixture} = await scene();
    const stop = gate(), write = gate(), writing = gate();
    let settled = false;
    const written: string[] = [];
    const test = harness(fixture, {
      hardStop: () => stop.wait,
      writeReceipt: async (_name, text) => {writing.open(); await write.wait; written.push((JSON.parse(text) as UninstallReceipt).outcome); return true;}});
    const result = runSquirrelEvent(event('uninstall'), test.ports).then(code => {settled = true; return code;});
    await writing.wait;
    stop.open(); await flush();
    expect(settled).toBe(false);
    write.open();
    expect(await result).toBe(EXIT_CODES.complete);
    expect(written).toEqual(['complete']);
  });

  it('anchors both deadlines to the process time origin and records the startup offset', async () => {
    expect(hookDeadlines(100)).toEqual({engine: UNINSTALL_DEADLINE_MS - PROCESS_START_MARGIN_MS, hardStop: UNINSTALL_HARD_STOP_MS - PROCESS_START_MARGIN_MS});
    expect(hookDeadlines(0)).toEqual({engine: 7500, hardStop: 8500});
    const {fixture} = await scene();
    const stopAfter: number[] = [], deadlines: number[] = [];
    const test = harness(fixture, {hardStop: milliseconds => {stopAfter.push(milliseconds); return new Promise<void>(() => undefined);},
      runUninstall: ports => {deadlines.push(ports.deadline); return Promise.resolve({...COMPLETE, outcome: 'deferred', code: 'GAME_RUNNING'});}});
    // The hook starts 5 s after the process time origin: 2.5 s are left for the engine and 3.5 s until the hard stop.
    test.advance(4000);
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(stopAfter).toEqual([3500]);
    expect(deadlines).toEqual([7500]);
    expect(test.receipts[0].receipt.startupOffsetMs).toBe(5000);
  });

  it('a late start leaves the engine only what is left before the process deadline', async () => {
    const {fixture, game} = await scene();
    let test: Harness | undefined = undefined;
    // Started at 5 s; the running-game check takes 2.6 s, past the anchored 7.5 s deadline though not past start + 8 s.
    test = harness(fixture, {checkRunning: () => {test!.advance(2600); return notRunning();}});
    test.advance(4000);
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'BUDGET_EXPIRED'});
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
  });

  it('an engine that throws is reported as ENGINE_FAILED and exits 3', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {runUninstall: () => Promise.reject(new Error('boom'))});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.code])).toEqual([['deferred', 'ENGINE_FAILED']]);
  });

  it('a hook step that throws before the engine is reported as HOOK_FAILED and deletes nothing', async () => {
    const {fixture} = await scene();
    const before = await listTree(fixture.base);
    const test = harness(fixture, {requestInstanceLock: () => {throw new Error('lock');}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.code])).toEqual([['deferred', 'HOOK_FAILED']]);
    expect(await listTree(fixture.base)).toEqual(before);
  });
});

describe('a step after the engine never replaces its result (final-head hosted run)', () => {
  it('the production deadline signal takes the fractional milliseconds of performance.now()', () => {
    // AbortSignal.timeout(6499.7) throws RangeError ERR_OUT_OF_RANGE; the production signal rounds the delay up.
    expect(() => AbortSignal.timeout(6499.7)).toThrow(RangeError);
    const signal = deadlineSignal(6499.7);
    expect(signal.aborted).toBe(false);
    expect(deadlineSignal(-3).aborted).toBe(false);
  });

  it('a hook on a fractional clock with the production deadline signal completes and counts the other processes', async () => {
    const {fixture, game} = await scene();
    const counted: AbortSignal[] = [];
    const test = harness(fixture, {deadlineSignal, countOtherProcesses: signal => {counted.push(signal); return Promise.resolve(0);}});
    // performance.now() is fractional; the harness clock otherwise starts at a whole 1000.
    test.advance(0.37);
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(counted).toHaveLength(1);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', code: null, plugins: {removed: 1}, data: {rootRemoved: true}, otherProcesses: 0,
      failedStep: null});
    expect(await exists(game.dll)).toBe(false);
  });

  it('a throw in the process wait keeps the engine\'s outcome and counts and names the step', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {deadlineSignal: () => {throw new RangeError('The value of "delay" is out of range. It must be an integer.');}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    const receipt = test.receipts[0].receipt;
    expect(receipt).toMatchObject({outcome: 'complete', code: null, plugins: {removed: 1, blocked: []}, data: {failed: [], rootRemoved: true}, failedStep: 'process-wait',
      otherProcesses: null});
    expect(receipt.data.removed).toBeGreaterThan(0);
  });

  it('a failed README write keeps the engine\'s deferral: the README is reported missing, and no step failed', async () => {
    const {fixture} = await scene();
    const failing = new Proxy(fixture.fs, {get(target, property: string) {
      const real = (target as unknown as Record<string, unknown>)[property];
      // The README is the only file the hook writes after the engine; its temporary file is opened with `wx`.
      if (property === 'open') return (file: string, flags: string) => file.includes('README') && flags === 'wx' ? Promise.reject(new Error('disk')) : (real as (...args: unknown[]) => unknown).call(target, file, flags);
      return typeof real === 'function' ? (real as (...args: unknown[]) => unknown).bind(target) : real;
    }});
    const test = harness(fixture, {fs: failing, checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', readme: false, failedStep: null, plugins: {blocked: [{game: 'ets2', reason: 'GAME_RUNNING'}]}});
  });

  it('a receipt that cannot even be built (JSON.stringify throws) still lets the claim resolve with its exit code', async () => {
    const {fixture} = await scene();
    // A count JSON cannot encode; the data root stays, so the claim is a deferral with RESIDUE_REMAINS.
    const unencodable = {outcome: 'complete', code: null, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 1n, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable', executor: 'not-run'} as unknown as UninstallResult;
    const test = harness(fixture, {runUninstall: () => Promise.resolve(unencodable)});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts).toEqual([]);
  });

  it('a receipt port that throws synchronously still lets the claim resolve', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {writeReceipt: () => {throw new Error('temp folder');}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
  });
});

describe('no process of this application outlives the uninstall hook', () => {
  it('a Squirrel event process turns off hardware acceleration and runs the GPU and the network service in process', () => {
    const calls: string[] = [];
    prepareSquirrelProcess({disableHardwareAcceleration: () => calls.push('disableHardwareAcceleration'),
      commandLine: {appendSwitch: (name, value) => calls.push(value === undefined ? name : `${name}=${value}`)}});
    expect(calls).toEqual(['disableHardwareAcceleration', 'in-process-gpu', 'enable-features=NetworkServiceInProcess2']);
  });

  it('waits for other processes of the executable to end before the receipt, and records the count and the wait', async () => {
    const {fixture} = await scene();
    const counts = [2, 1, 0];
    let calls = 0, receiptAt = -1;
    const test = harness(fixture, {countOtherProcesses: () => Promise.resolve(counts[Math.min(calls++, counts.length - 1)])});
    const write = test.ports.writeReceipt;
    test.ports = {...test.ports, writeReceipt: (name, text) => {receiptAt = calls; return write(name, text);}};
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(calls).toBe(3);
    expect(receiptAt).toBe(3);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', otherProcesses: 0, processWaitMs: 2 * PROCESS_POLL_MS});
  });

  it('stops waiting at the engine deadline and records what is still running, without changing the outcome', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {countOtherProcesses: () => Promise.resolve(1)});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    const receipt = test.receipts[0].receipt;
    expect(receipt).toMatchObject({outcome: 'complete', otherProcesses: 1});
    // The harness clock starts at 1000 and the anchored engine deadline is 7500.
    expect(receipt.processWaitMs).toBeLessThanOrEqual(7500 - 1000);
    expect(receipt.processWaitMs).toBeGreaterThan(7500 - 1000 - 2 * PROCESS_POLL_MS);
  });

  it('counts nothing once the engine deadline has passed', async () => {
    const {fixture} = await scene();
    const count = vi.fn<SquirrelPorts['countOtherProcesses']>(() => Promise.resolve(1));
    let test: Harness | undefined = undefined;
    // The running-game check ends past the anchored 7.5 s deadline: the engine defers, and the wait is skipped.
    test = harness(fixture, {countOtherProcesses: count, checkRunning: () => {test!.advance(7000); return notRunning();}});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(count).not.toHaveBeenCalled();
    expect(test.receipts[0].receipt).toMatchObject({code: 'BUDGET_EXPIRED', otherProcesses: null, processWaitMs: 0});
  });

  it('cuts off a slow listing at the deadline and keeps the engine\'s result', async () => {
    const {fixture} = await scene();
    const deadline = new AbortController(), asked: number[] = [];
    let hardStopFired = false, fireHardStop: () => void = () => undefined;
    const test = harness(fixture, {
      deadlineSignal: milliseconds => {asked.push(milliseconds); return deadline.signal;},
      // A tasklist that does not answer before the deadline: it ends only when the signal it got aborts. The hard stop
      // fires one macrotask after the deadline, once every microtask is done: a run that honours the signal has claimed
      // its result by then, while one that waited for the listing would lose the claim to the hard stop.
      countOtherProcesses: signal => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(null), {once: true});
        queueMicrotask(() => {deadline.abort(); setImmediate(() => fireHardStop());});
      }),
      hardStop: () => new Promise<void>(resolve => {fireHardStop = () => {hardStopFired = true; resolve();};})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    await new Promise<void>(resolve => setImmediate(resolve));
    // The hard stop did fire, after the run had claimed: its claim wrote nothing.
    expect(hardStopFired).toBe(true);
    // The harness clock starts at 1000 and the anchored engine deadline is 7500.
    expect(asked).toEqual([6500]);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.otherProcesses])).toEqual([['complete', null]]);
  });

  it('records null and does not wait when the processes cannot be listed', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {countOtherProcesses: () => Promise.resolve(null)});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(test.receipts[0].receipt).toMatchObject({otherProcesses: null, processWaitMs: 0});
  });
});

describe('cancelDeferralOnStart', () => {
  it('cancels the deferral of the installed application and refuses any other layout', async () => {
    const {fixture} = await scene();
    await seedDeferral(fixture);
    const runOnce = fakeRunOnce();
    expect(await cancelDeferralOnStart({executable: path.win32.join(guard.root, 'node_modules', 'electron', 'dist', 'electron.exe'), env: {},
      fs: fixture.fs, runOnce})).toEqual({deferral: 'NOT_INSTALLED', executor: 'not-run'});
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(true);
    // The fixture's test file names no RunOnce key: no registry call at all.
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs, runOnce})).toEqual({deferral: 'cancelled', executor: 'not-applicable'});
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs, runOnce})).toEqual({deferral: 'none', executor: 'not-run'});
    expect(runOnce.calls).toEqual([]);
  });

  it('removes the copied executor and its RunOnce value with the deferral, and touches the registry only when there was one', async () => {
    const {fixture} = await scene({runOnceKey: TEST_RUN_ONCE});
    await seedDeferral(fixture);
    await fsp.writeFile(path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE), SCRIPT);
    const runOnce = fakeRunOnce();
    runOnce.values.set(RUN_ONCE_ENTRY, executorCommand(fixture.dataRoot, WINDOWS)!);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs, runOnce})).toEqual({deferral: 'cancelled', executor: 'removed'});
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall'))).toBe(false);
    expect(runOnce.values.size).toBe(0);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs, runOnce})).toEqual({deferral: 'none', executor: 'not-run'});
    expect(runOnce.calls).toEqual([`remove ${TEST_RUN_ONCE}`]);
  });
});

describe('the deferred-cleanup executor (ET-018 PR-5, U7)', () => {
  it('a complete uninstall registers before the first deletion and removes the registration last', async () => {
    const {fixture, game} = await scene({runOnceKey: TEST_RUN_ONCE});
    const deletions: string[] = [];
    const test = harness(fixture);
    const fs = new Proxy(fixture.fs, {get: (target, name, receiver) => {
      const value: unknown = Reflect.get(target, name, receiver);
      if (name !== 'unlink' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (!/\.tmp$/.test(String(args[0]))) test.order.push('delete');
        deletions.push(String(args[0]));
        return (value as (...parameters: unknown[]) => unknown).apply(target, args);
      };
    }});
    test.ports = {...test.ports, fs};
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(test.order.indexOf('register')).toBeGreaterThan(-1);
    expect(test.order.indexOf('register')).toBeLessThan(test.order.indexOf('delete'));
    expect(test.registry.calls).toEqual([`set ${TEST_RUN_ONCE}`, `remove ${TEST_RUN_ONCE}`]);
    expect(test.registry.values.size).toBe(0);
    expect(await exists(fixture.dataRoot)).toBe(false);
    expect(await exists(game.dll)).toBe(false);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'complete', executor: 'removed'});
    // The copied executor went with the uninstall folder, after the registration.
    expect(deletions.some(file => file.endsWith(`\\uninstall\\${EXECUTOR_FILE}`))).toBe(true);
  });

  it('a deferred uninstall leaves the copied executor registered for the next sign-in and says so in README.txt', async () => {
    const {fixture, game} = await scene({runOnceKey: TEST_RUN_ONCE});
    const test = harness(fixture, {checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.registry.values.get(RUN_ONCE_ENTRY)).toBe(executorCommand(fixture.dataRoot, WINDOWS));
    expect(await fsp.readFile(path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE))).toEqual(SCRIPT);
    expect((await fsp.readdir(path.win32.join(fixture.dataRoot, 'uninstall'))).sort()).toEqual([EXECUTOR_FILE, 'README.txt', 'pending.json']);
    expect(await fsp.readFile(path.win32.join(fixture.dataRoot, 'uninstall', 'README.txt'), 'utf8')).toContain('finishes this cleanup by itself at your next Windows sign-in');
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', executor: 'registered', readme: true});
    expectNoPath(test.receipts[0].text, fixture);
  });

  it('a running instance defers everything, with the executor registered', async () => {
    const {fixture} = await scene({runOnceKey: TEST_RUN_ONCE});
    const test = harness(fixture, {locks: [false]});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({code: 'INSTANCE_RUNNING', executor: 'registered'});
    expect(test.registry.values.get(RUN_ONCE_ENTRY)).toBe(executorCommand(fixture.dataRoot, WINDOWS));
  });

  it('a failed registration keeps the README as the fallback, without the sign-in promise', async () => {
    const {fixture} = await scene({runOnceKey: TEST_RUN_ONCE});
    const test = harness(fixture, {runOnce: fakeRunOnce({fail: true}), checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', executor: 'failed', readme: true});
    const readme = await fsp.readFile(path.win32.join(fixture.dataRoot, 'uninstall', 'README.txt'), 'utf8');
    expect(readme).not.toContain('by itself');
    expect(readme).toContain('Get-FileHash');
  });

  it('a test install without a RunOnce key copies nothing and writes no key', async () => {
    const {fixture} = await scene();
    const test = harness(fixture, {checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.registry.calls).toEqual([]);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE))).toBe(false);
    expect(test.receipts[0].receipt.executor).toBe('not-applicable');
  });

  it('a production install registers under the production RunOnce key (on the injected registry only)', async () => {
    const {fixture} = await scene({testRoot: false});
    const test = harness(fixture, {env: {LOCALAPPDATA: fixture.base}, checkRunning: () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: true}})});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.registry.calls).toEqual(['set HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce']);
    expect(test.receipts[0].receipt).toMatchObject({mode: 'production', code: 'CLIENT_RUNNING', executor: 'registered'});
  });

  it.each(['install', 'updated'] as const)('%s cancels the deferral with its copied executor and RunOnce value', async name => {
    const {fixture} = await scene({runOnceKey: TEST_RUN_ONCE});
    await seedDeferral(fixture);
    await fsp.writeFile(path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE), SCRIPT);
    const test = harness(fixture);
    test.registry.values.set(RUN_ONCE_ENTRY, executorCommand(fixture.dataRoot, WINDOWS)!);
    expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(await exists(path.win32.join(fixture.dataRoot, 'uninstall'))).toBe(false);
    expect(test.registry.values.size).toBe(0);
  });

  it.each(['install', 'updated'] as const)('%s without a deferral never touches the registry', async name => {
    const {fixture} = await scene({runOnceKey: TEST_RUN_ONCE});
    const test = harness(fixture);
    expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(test.registry.calls).toEqual([]);
  });
});

// ET-055 UP14: the uninstall hook waits only for processes of its own channel's executable. The other channel's
// application, running beside it in the same session, is never counted, so a staging uninstall never waits on production.
describe('countOtherProcesses', () => {
  const rows = [
    {name: 'ETS2TelemetryDesktopStaging.exe', pid: 10, session: 1}, {name: 'ETS2TelemetryDesktopStaging.exe', pid: 11, session: 1},
    {name: 'etS2telemetrydesktopstaging.EXE', pid: 12, session: 1}, {name: 'ETS2TelemetryDesktopStaging.exe', pid: 13, session: 2},
    {name: 'ETS2TelemetryDesktop.exe', pid: 20, session: 1}, {name: 'ETS2TelemetryDesktop.exe', pid: 21, session: 1}];
  const staging = 'C:/Users/driver/AppData/Local/ETS2TelemetryStagingDesktop/app-0.2.0-stg000042/ETS2TelemetryDesktopStaging.exe';
  const production = 'C:/Users/driver/AppData/Local/ETS2TelemetryDesktop/app-0.1.1/ETS2TelemetryDesktop.exe';

  it('counts only its own image in its own session, without itself and its children', () => {
    expect(countOtherProcesses(rows, staging, 10, new Set([10, 11]))).toBe(1);
  });
  it('never counts the other channel', () => {
    expect(countOtherProcesses(rows, production, 20, new Set([20]))).toBe(1);
    expect(countOtherProcesses([...rows, {name: 'ETS2TelemetryDesktopStaging.exe', pid: 30, session: 1}], production, 20, new Set([20]))).toBe(1);
  });
  it('gives null when this process is not listed', () => {
    expect(countOtherProcesses(rows, staging, 99, new Set([99]))).toBeNull();
  });
});
