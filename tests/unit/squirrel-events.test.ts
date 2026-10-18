import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cancelDeferralOnStart, EXIT_CODES, INSTANCE_EXIT_WAIT_MS, parseSquirrelArgs, RECEIPT_FORMAT, runSquirrelEvent, settle, UNINSTALL_DEADLINE_MS,
  type SquirrelArgs, type SquirrelPorts, type UninstallReceipt} from '../../apps/desktop/src/squirrel-events';
import type {UninstallPorts, UninstallResult} from '../../apps/desktop/src/uninstall/engine';
import {resolveUninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, FOREIGN, gameFolder, installFixture, installRecord, KNOWN, listTree, notRunning, seedData, UTC, writeRegistry,
  type FakeGameFolder, type InstallFixture} from '../shared/uninstall-fixture';

// REG-015, REG-017 (ET-018 U2, U6): the Squirrel event handler on fake installs under the guarded temporary root. Every
// port is injected: no Update.exe, no lock, no tasklist and no %TEMP% receipt is real, and the handler never sees the
// real execPath layout.

let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-squirrel-events-');});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const event = (name: 'install' | 'updated' | 'obsolete' | 'uninstall'): SquirrelArgs => ({kind: 'event', event: name, version: '0.1.0'});

interface Harness {
  ports: SquirrelPorts;
  receipts: {name: string; receipt: UninstallReceipt; text: string}[];
  updates: {installRoot: string; args: readonly string[]}[];
  lockRequests: () => number;
  order: string[];
  advance(milliseconds: number): void;
}
/** Fake ports around `fixture`; the clock advances only through `delay` and `advance`. */
function harness(fixture: InstallFixture, overrides: Partial<SquirrelPorts> & {env?: Record<string, string>; locks?: boolean[]} = {}): Harness {
  let clock = 1000, requests = 0;
  const receipts: Harness['receipts'] = [], updates: Harness['updates'] = [], order: string[] = [];
  const {env, locks, ...rest} = overrides;
  const ports: SquirrelPorts = {
    appVersion: '0.1.0',
    executableName: 'ETS2TelemetryDesktop.exe',
    resolveRoots: () => resolveUninstallRoots({executable: fixture.executable, env: env ?? {}, fs: fixture.fs}),
    useProfile: () => true,
    requestInstanceLock: () => {
      order.push('lock');
      const answer = locks ? locks[Math.min(requests, locks.length - 1)] : true;
      requests++;
      return answer;
    },
    runUpdate: (installRoot, args) => {updates.push({installRoot, args}); return Promise.resolve(true);},
    fs: fixture.fs,
    checkRunning: notRunning,
    readKnown: () => Promise.resolve(KNOWN),
    writeReceipt: (name, text) => {receipts.push({name, text, receipt: JSON.parse(text) as UninstallReceipt}); return Promise.resolve(true);},
    clock: () => clock,
    delay: milliseconds => {clock += milliseconds; return Promise.resolve();},
    hardStop: () => new Promise<void>(() => undefined),
    now: () => new Date(UTC),
    ...rest
  };
  return {ports, receipts, updates, order, lockRequests: () => requests, advance: milliseconds => {clock += milliseconds;}};
}

interface Scene {fixture: InstallFixture; game: FakeGameFolder; unrelated: string}
/** An installed scene: one fake ETS2 folder with the recorded plugin and an unrelated DLL, and every data entry. */
async function scene(options: {testRoot?: boolean; shortcuts?: boolean} = {}): Promise<Scene> {
  const fixture = await installFixture(guard, {testRoot: options.testRoot});
  if (options.shortcuts) {
    await fsp.writeFile(path.win32.join(fixture.testRoot, 'ets2telemetry-install-test.json'), JSON.stringify({format: 'ets2telemetry.install-test', version: 1,
      profileDir: path.win32.join(fixture.testRoot, 'profile'), runOnceKey: null, shortcuts: true}));
  }
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
  it.each(['install', 'updated', 'obsolete'] as const)('%s never runs the engine, never requests the lock and keeps every data entry', async name => {
    const {fixture} = await scene();
    const before = await listTree(fixture.base);
    const engine = vi.fn<(ports: UninstallPorts) => Promise<UninstallResult>>();
    const test = harness(fixture, {runUninstall: engine});
    expect(await runSquirrelEvent(event(name), test.ports)).toBe(0);
    expect(engine).not.toHaveBeenCalled();
    expect(test.lockRequests()).toBe(0);
    expect(test.receipts).toEqual([]);
    expect(await listTree(fixture.base)).toEqual(before);
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
    expect(await listTree(fixture.base)).toEqual(before);
    expect(await fsp.readFile(game.dll)).toEqual(CURRENT);
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
    await vi.waitFor(() => expect(test.lockRequests()).toBe(1));
    stop();
    expect(await running).toBe(EXIT_CODES.deferred);
    expect(test.receipts.map(entry => [entry.receipt.outcome, entry.receipt.code])).toEqual([['deferred', 'BUDGET_EXPIRED']]);
  });

  it('never reports complete while the data root remains, whatever the engine says', async () => {
    const {fixture} = await scene();
    const lying = (): Promise<UninstallResult> => Promise.resolve({outcome: 'complete', code: null, plugins: {removed: 1, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 7, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable'});
    const test = harness(fixture, {runUninstall: lying});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.deferred);
    expect(test.receipts[0].receipt).toMatchObject({outcome: 'deferred', code: 'RESIDUE_REMAINS'});
  });

  it('settle keeps a clean complete and downgrades one with a blocked folder or a failed entry', () => {
    const complete: UninstallResult = {outcome: 'complete', code: null, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []},
      data: {removed: 0, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable'};
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
    guard = await guardedTempRoot('ets2telemetry-squirrel-events-');
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

describe('cancelDeferralOnStart', () => {
  it('cancels the deferral of the installed application and refuses any other layout', async () => {
    const {fixture} = await scene();
    await seedDeferral(fixture);
    expect(await cancelDeferralOnStart({executable: path.win32.join(guard.root, 'node_modules', 'electron', 'dist', 'electron.exe'), env: {},
      fs: fixture.fs})).toBe('NOT_INSTALLED');
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(true);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs})).toBe('cancelled');
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs})).toBe('none');
  });
});
