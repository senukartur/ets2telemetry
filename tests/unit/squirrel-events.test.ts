import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cancelDeferralOnStart, deadlineSignal, EXIT_CODES, hookDeadlines, prepareSquirrelProcess, PROCESS_POLL_MS, INSTANCE_EXIT_WAIT_MS, parseSquirrelArgs, PROCESS_START_MARGIN_MS, RECEIPT_FORMAT, runSquirrelEvent, settle,
  UNINSTALL_DEADLINE_MS, UNINSTALL_HARD_STOP_MS,
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
    countOtherProcesses: () => Promise.resolve(0),
    deadlineSignal: () => new AbortController().signal,
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

describe('the hard stop and the run claim one result', () => {
  const COMPLETE: UninstallResult = {outcome: 'complete', code: null, plugins: {removed: 1, absent: 0, unrecognized: 0, notes: [], blocked: []},
    data: {removed: 8, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable'};
  /** A gate: `open()` resolves `wait`. */
  function gate() {
    let open: () => void = () => undefined;
    const wait = new Promise<void>(resolve => {open = resolve;});
    return {wait, open: () => open()};
  }
  const flush = async () => {for (let index = 0; index < 20; index++) await Promise.resolve();};

  it('the run settling just after the hard stop neither changes the code nor cuts the hard stop\'s receipt short', async () => {
    const {fixture} = await scene();
    const stop = gate(), engine = gate(), write = gate();
    let settled = false;
    const written: string[] = [];
    const test = harness(fixture, {
      runUninstall: async ports => {await engine.wait; await fsp.rm(ports.roots.ok ? ports.roots.dataRoot : '', {recursive: true}); return COMPLETE;},
      hardStop: () => stop.wait,
      writeReceipt: async (_name, text) => {await write.wait; written.push((JSON.parse(text) as UninstallReceipt).code ?? 'null'); return true;}});
    const result = runSquirrelEvent(event('uninstall'), test.ports).then(code => {settled = true; return code;});
    await vi.waitFor(() => expect(test.lockRequests()).toBe(1));
    stop.open(); await flush();
    // The hard stop owns the result now; its receipt is still being written when the run settles.
    engine.open(); await new Promise(resolve => setTimeout(resolve, 50)); await flush();
    expect(settled).toBe(false);
    write.open();
    expect(await result).toBe(EXIT_CODES.deferred);
    expect(written).toEqual(['BUDGET_EXPIRED']);
  });

  it('the hard stop firing while the run writes its receipt waits for that receipt and keeps the run\'s code', async () => {
    const {fixture} = await scene();
    const stop = gate(), write = gate();
    let settled = false, writing = false;
    const written: string[] = [];
    const test = harness(fixture, {
      hardStop: () => stop.wait,
      writeReceipt: async (_name, text) => {writing = true; await write.wait; written.push((JSON.parse(text) as UninstallReceipt).outcome); return true;}});
    const result = runSquirrelEvent(event('uninstall'), test.ports).then(code => {settled = true; return code;});
    await vi.waitFor(() => expect(writing).toBe(true));
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
      data: {removed: 1n, kept: 0, failed: [], rootRemoved: true}, roaming: 'not-applicable'} as unknown as UninstallResult;
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
    let hardStopped = false;
    const test = harness(fixture, {
      deadlineSignal: milliseconds => {asked.push(milliseconds); return deadline.signal;},
      // A tasklist that does not answer before the deadline: it ends only when the signal it got aborts.
      countOtherProcesses: signal => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(null), {once: true});
        queueMicrotask(() => deadline.abort());
      }),
      hardStop: () => new Promise<void>(resolve => setTimeout(() => {hardStopped = true; resolve();}, 2000))});
    expect(await runSquirrelEvent(event('uninstall'), test.ports)).toBe(EXIT_CODES.complete);
    expect(hardStopped).toBe(false);
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
    expect(await cancelDeferralOnStart({executable: path.win32.join(guard.root, 'node_modules', 'electron', 'dist', 'electron.exe'), env: {},
      fs: fixture.fs})).toBe('NOT_INSTALLED');
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(true);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs})).toBe('cancelled');
    for (const file of deferralFiles(fixture)) expect(await exists(file)).toBe(false);
    expect(await cancelDeferralOnStart({executable: fixture.executable, env: {}, fs: fixture.fs})).toBe('none');
  });
});
