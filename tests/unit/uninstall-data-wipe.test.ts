import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {dataPaths} from '../../apps/desktop/src/paths';
import {DATA_ALLOWLIST, KEPT_UNTIL_CLEAN, removeOwnedTree, wipeDataRoot, type WipeFileSystem} from '../../apps/desktop/src/uninstall/data-wipe';
import {wipeEverything} from '../../apps/desktop/src/uninstall/engine';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {exists, listTree} from '../shared/uninstall-fixture';

// REG-017 (ET-018 U4): the uninstall data wipe removes only the allowlisted top-level entries of the data root, never
// follows a link, never clears a read-only attribute and keeps every unknown entry. Guarded temporary folders only.

let guard: GuardedRoot;
let dataRoot: string;
beforeEach(async () => {
  guard = await guardedTempRoot('ets2telemetry-uninstall-wipe-');
  dataRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2Telemetry');
  await fsp.mkdir(dataRoot, {recursive: true});
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const fs = () => guard.fs as unknown as WipeFileSystem;
const write = async (relative: string, content = 'synthetic') => {
  const target = path.win32.join(dataRoot, relative);
  await fsp.mkdir(path.win32.dirname(target), {recursive: true});
  await fsp.writeFile(target, content);
  return target;
};
const seedAll = async () => {
  for (const entry of DATA_ALLOWLIST) await write(path.win32.join(entry, 'nested', `${entry}.bin`));
};

describe('allowlist', () => {
  it('removes every allowlisted entry and the empty data root', async () => {
    await seedAll();
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: DATA_ALLOWLIST.length, kept: 0, failed: [], rootRemoved: true});
    expect(await exists(dataRoot)).toBe(false);
  });
  it('keeps every entry outside the allowlist, counts it and then keeps the data root', async () => {
    await seedAll();
    await write('notes\\mine.txt'); await write('telemetry.sqlite.bak'); await write('Logs-old\\x.log');
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: DATA_ALLOWLIST.length, kept: 3, failed: [], rootRemoved: false});
    expect(await listTree(dataRoot)).toEqual(['Logs-old\\', 'Logs-old\\x.log', 'notes\\', 'notes\\mine.txt', 'telemetry.sqlite.bak']);
  });
  it('matches allowlisted names case-insensitively, as Windows does', async () => {
    await write('Logs\\startup.jsonl'); await write('SETTINGS\\settings.json');
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: 2, kept: 0, failed: [], rootRemoved: true});
  });
  it('keeps plugins and uninstall while the plugin cleanup is unfinished', async () => {
    await seedAll();
    expect(await wipeDataRoot(fs(), dataRoot, {keep: KEPT_UNTIL_CLEAN, removeRoot: true})).toEqual({removed: DATA_ALLOWLIST.length - 2, kept: 0, failed: [], rootRemoved: false});
    expect(await listTree(dataRoot)).toEqual(['plugins\\', 'plugins\\nested\\', 'plugins\\nested\\plugins.bin', 'uninstall\\', 'uninstall\\nested\\', 'uninstall\\nested\\uninstall.bin']);
  });
  it('treats a missing data root as already wiped', async () => {
    await fsp.rm(dataRoot, {recursive: true});
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: 0, kept: 0, failed: [], rootRemoved: true});
  });
  it('drift: dataPaths() names nothing outside the allowlist', () => {
    const paths = dataPaths('X:\\Users\\fixture\\AppData\\Local');
    const top = Object.entries(paths).filter(([key]) => key !== 'root').map(([key, value]) => {
      expect(value.toLowerCase().startsWith(`${paths.root.toLowerCase()}\\`), key).toBe(true);
      return path.win32.relative(paths.root, value).split('\\')[0];
    });
    expect(top.filter(name => !(DATA_ALLOWLIST as readonly string[]).includes(name))).toEqual([]);
  });
});

describe('links and attributes', () => {
  it('unlinks a junction inside logs without entering it, and the outside sentinel stays intact', async () => {
    const outside = path.win32.join(guard.root, 'outside');
    await fsp.mkdir(path.win32.join(outside, 'deep'), {recursive: true});
    await fsp.writeFile(path.win32.join(outside, 'sentinel.txt'), 'outside the data root');
    await fsp.writeFile(path.win32.join(outside, 'deep', 'more.txt'), 'deeper');
    await write('logs\\startup.jsonl');
    await guard.fs.symlink(outside, path.win32.join(dataRoot, 'logs', 'linked'), 'junction');
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: 1, kept: 0, failed: [], rootRemoved: true});
    expect(await listTree(outside)).toEqual(['deep\\', 'deep\\more.txt', 'sentinel.txt']);
    expect(await fsp.readFile(path.win32.join(outside, 'sentinel.txt'), 'utf8')).toBe('outside the data root');
  });
  it('unlinks an allowlisted top-level entry that is itself a junction, never its target', async () => {
    const outside = path.win32.join(guard.root, 'outside-captures');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.win32.join(outside, 'keep.cap0'), 'not ours');
    await guard.fs.symlink(outside, path.win32.join(dataRoot, 'captures'), 'junction');
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toMatchObject({removed: 1, failed: []});
    expect(await listTree(outside)).toEqual(['keep.cap0']);
  });
  it('reports a read-only file, keeps it with its attribute and its folders, and removes the rest', async () => {
    const readOnly = await write('settings\\settings.json');
    await write('settings\\other.json'); await write('logs\\startup.jsonl');
    await fsp.chmod(readOnly, 0o444);
    try {
      expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: 1, kept: 0, failed: [{entry: 'settings', code: 'READ_ONLY_FILE'}], rootRemoved: false});
      expect(await listTree(dataRoot)).toEqual(['settings\\', 'settings\\settings.json']);
      expect((await fsp.stat(readOnly)).mode & 0o200).toBe(0);
    } finally {await fsp.chmod(readOnly, 0o666);}
  });
  it('reports an entry it cannot remove with a fixed code and keeps the data root', async () => {
    await write('logs\\startup.jsonl');
    const failing: WipeFileSystem = {...fs(), unlink: target => target.endsWith('startup.jsonl') ? Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'})) : fs().unlink(target)};
    expect(await wipeDataRoot(failing, dataRoot, {removeRoot: true})).toEqual({removed: 0, kept: 0, failed: [{entry: 'logs', code: 'TARGET_LOCKED'}], rootRemoved: false});
  });
  it('stops at an expired budget and reports it', async () => {
    await seedAll();
    let calls = 0;
    const report = await wipeDataRoot(fs(), dataRoot, {removeRoot: true, expired: () => ++calls > 3});
    expect(report.failed.at(-1)).toEqual(expect.objectContaining({code: 'BUDGET_EXPIRED'}));
    expect(report.rootRemoved).toBe(false);
    expect(await exists(dataRoot)).toBe(true);
  });
});

// Review of PR-4: a spent budget must report everything allowlisted that remains, so the in-app result dialog and the
// uninstall hook's receipt are truthful, and must delete nothing more.
describe('a spent budget', () => {
  /** True from the n-th check on: removeTree checks once per entry, folder and file, so three checks per seeded entry. */
  const expiresAt = (n: number) => {let calls = 0; return () => ++calls >= n;};
  const remaining = async () => (await fsp.readdir(dataRoot)).sort();
  it('reports every allowlisted entry not reached and keeps it', async () => {
    await seedAll();
    const report = await wipeDataRoot(fs(), dataRoot, {removeRoot: true, expired: expiresAt(7)});
    expect(report).toEqual({removed: 2, kept: 0, rootRemoved: false,
      failed: ['data', 'logs', 'plugins', 'settings', 'synthetic', 'transport', 'uninstall', 'updates'].map(entry => ({entry, code: 'BUDGET_EXPIRED'}))});
    expect(await remaining()).toEqual(['data', 'logs', 'plugins', 'settings', 'synthetic', 'transport', 'uninstall', 'updates']);
  });
  it('stays spent within one call even if the check would answer false again', async () => {
    await seedAll();
    let calls = 0;
    const report = await wipeDataRoot(fs(), dataRoot, {removeRoot: true, expired: () => ++calls === 7});
    expect(report.removed).toBe(2);
    expect(report.failed.map(entry => entry.entry)).toEqual(['data', 'logs', 'plugins', 'settings', 'synthetic', 'transport', 'uninstall', 'updates']);
    expect(await remaining()).toEqual(['data', 'logs', 'plugins', 'settings', 'synthetic', 'transport', 'uninstall', 'updates']);
  });
  it('in the first step of wipeEverything: lists plugins and uninstall too, and deletes neither', async () => {
    await seedAll();
    const report = await wipeEverything(fs() as never, dataRoot, expiresAt(7), true);
    expect(report.removed).toBe(2);
    expect(report.failed).toEqual(['data', 'logs', 'settings', 'synthetic', 'transport', 'updates', 'plugins', 'uninstall'].map(entry => ({entry, code: 'BUDGET_EXPIRED'})));
    expect(await remaining()).toEqual(['data', 'logs', 'plugins', 'settings', 'synthetic', 'transport', 'uninstall', 'updates']);
  });
  it('right after the first step of wipeEverything: reports plugins and uninstall instead of nothing', async () => {
    await seedAll();
    // The first step removes eight entries with 24 checks (ET-055 added `updates`); the registry step's first check
    // finds the budget spent.
    const report = await wipeEverything(fs() as never, dataRoot, expiresAt(25), true);
    expect(report).toEqual({removed: 8, kept: 0, rootRemoved: false, failed: [{entry: 'plugins', code: 'BUDGET_EXPIRED'}, {entry: 'uninstall', code: 'BUDGET_EXPIRED'}]});
    expect(await remaining()).toEqual(['plugins', 'uninstall']);
  });
  it('a real failure still keeps plugins and uninstall for the deferral, unreported', async () => {
    await seedAll();
    const failing: WipeFileSystem = {...fs(), unlink: target => target.endsWith('logs.bin') ? Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'})) : fs().unlink(target)};
    const report = await wipeEverything(failing as never, dataRoot, () => false, true);
    expect(report.failed).toEqual([{entry: 'logs', code: 'TARGET_LOCKED'}]);
    expect(await remaining()).toEqual(['logs', 'plugins', 'uninstall']);
  });
});

// ET-055 UP18: the in-app update's download folder belongs to the data root's allowlist, and the updater removes its own
// folder with the same no-follow rules.
describe('updates folder', () => {
  it('removes a downloaded update with its partial file as an allowlisted entry', async () => {
    expect(DATA_ALLOWLIST).toContain('updates');
    await write('updates\\0.2.0\\ETS2TelemetryDesktop-0.2.0-full.nupkg.partial'); await write('updates\\0.2.0\\RELEASES');
    expect(await wipeDataRoot(fs(), dataRoot, {removeRoot: true})).toEqual({removed: 1, kept: 0, failed: [], rootRemoved: true});
  });
  it('removeOwnedTree unlinks a junction inside the folder without entering it', async () => {
    const outside = path.win32.join(guard.root, 'outside-updates');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.win32.join(outside, 'keep.nupkg'), 'not ours');
    await write('updates\\0.2.0\\RELEASES');
    await guard.fs.symlink(outside, path.win32.join(dataRoot, 'updates', 'linked'), 'junction');
    expect(await removeOwnedTree(fs(), path.win32.join(dataRoot, 'updates'))).toBeNull();
    expect(await exists(path.win32.join(dataRoot, 'updates'))).toBe(false);
    expect(await listTree(outside)).toEqual(['keep.nupkg']);
  });
});
