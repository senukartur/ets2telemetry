import {mkdtemp, readdir, readFile, rm, symlink, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {discoverSteamGames} from '../../apps/desktop/src/plugin-setup/steam-discovery';
import {GuardedFsEscape, guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeSteam} from '../shared/fake-steam';

// Harness for REG-015 (ET-017 P19): the guarded file system that confines plugin-setup tests to their temporary root.
// The "outside" folder is a second temporary folder, never a real Steam, game or data folder.

let guard: GuardedRoot;
let outside: string;
beforeEach(async () => {
  guard = await guardedTempRoot();
  outside = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-guard-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
});
afterEach(async () => {
  await guard.dispose();
  await rm(outside, {recursive: true, force: true});
});

const refused = async (run: () => Promise<unknown>) => {
  try {await run();} catch (error) {return error instanceof GuardedFsEscape ? error.operation : `unexpected ${String(error)}`;}
  return 'allowed';
};

describe('paths', () => {
  it('allows paths inside the root, also through a junction that stays inside', async () => {
    const inner = path.win32.join(guard.root, 'Inner');
    await mkdir(inner);
    await writeFile(path.win32.join(inner, 'file.txt'), 'inside');
    await symlink(inner, path.win32.join(guard.root, 'Alias'), 'junction');
    expect(await guard.fs.readFile(path.win32.join(guard.root, 'Alias', 'file.txt'), 'utf8')).toBe('inside');
    expect(await guard.fs.realpath(path.win32.join(guard.root, 'Alias'))).toBe(inner);
    // A missing path inside the root reaches the real call and fails there, not in the guard.
    await expect(guard.fs.stat(path.win32.join(guard.root, 'Missing', 'deeper'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(guard.violations).toEqual([]);
  });

  it('refuses and records lexical paths outside the root', async () => {
    for (const target of [outside, path.join(outside, 'secret.txt'), tmpdir(), path.win32.join(guard.root, '..'), '\\\\server\\share\\x', 'relative.txt']) {
      expect([target, await refused(() => guard.fs.stat(target))]).toEqual([target, 'stat']);
    }
    expect(guard.violations).toHaveLength(6);
  });

  it('refuses every access through a junction that points outside the root, and records it', async () => {
    const link = path.win32.join(guard.root, 'Outward');
    await symlink(outside, link, 'junction');
    const secret = path.win32.join(link, 'secret.txt');
    expect(await refused(() => guard.fs.stat(secret))).toBe('stat-through-link');
    expect(await refused(() => guard.fs.lstat(secret))).toBe('lstat-through-link');
    expect(await refused(() => guard.fs.readFile(secret))).toBe('readFile-through-link');
    expect(await refused(() => guard.fs.open(secret, 'r'))).toBe('open-through-link');
    expect(await refused(() => guard.fs.readdir(link))).toBe('readdir-through-link');
    expect(await refused(() => guard.fs.stat(link))).toBe('stat-through-link');
    expect(await refused(() => guard.fs.realpath(link))).toBe('realpath-through-link');
    expect(await refused(() => guard.fs.writeFile(path.win32.join(link, 'planted.txt'), 'x'))).toBe('writeFile-through-link');
    expect(await refused(() => guard.fs.mkdir(path.win32.join(link, 'Made')))).toBe('mkdir-through-link');
    // The link entry itself is inside the root.
    expect(await refused(() => guard.fs.lstat(link))).toBe('allowed');
    expect(guard.violations).toHaveLength(9);
    expect((await readdir(outside)).sort()).toEqual(['secret.txt']);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  });

  it('refuses access through a dangling junction whose missing target is outside the root', async () => {
    const gone = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-guard-gone-'));
    const link = path.win32.join(guard.root, 'Dangling');
    await symlink(gone, link, 'junction');
    await rm(gone, {recursive: true});
    expect(await refused(() => guard.fs.mkdir(path.win32.join(link, 'Made', 'Deeper'), {recursive: true}))).toBe('mkdir-through-link');
    expect(await refused(() => guard.fs.writeFile(path.win32.join(link, 'planted.txt'), 'x'))).toBe('writeFile-through-link');
    expect(await refused(() => guard.fs.stat(link))).toBe('stat-through-link');
    // The link entry itself is inside the root and may be inspected or removed.
    expect(await refused(() => guard.fs.lstat(link))).toBe('allowed');
    expect(guard.violations).toHaveLength(3);
    await expect(readdir(gone)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('lets an access through a dangling junction whose missing target is inside the root reach the real call', async () => {
    const target = path.win32.join(guard.root, 'Removed');
    await mkdir(target);
    const link = path.win32.join(guard.root, 'InwardDangling');
    await symlink(target, link, 'junction');
    await rm(target, {recursive: true});
    await expect(guard.fs.stat(path.win32.join(link, 'file.txt'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(guard.violations).toEqual([]);
  });

  it('catches discovery that would read a library outside the root through a junction', async () => {
    const steam = await fakeSteam(guard.root);
    const link = path.win32.join(guard.root, 'OutwardLibrary');
    await symlink(outside, link, 'junction');
    await steam.libraryFolders([steam.steam, link]);
    const result = await discoverSteamGames({steamRoot: () => Promise.resolve({kind: 'found', path: steam.steam}), fs: guard.fs});
    // Discovery swallows the refusal and skips the library; the guard still records it.
    expect(result.libraries.map(library => library.path)).toEqual([steam.steam]);
    expect(guard.violations).toEqual([`realpath-through-link ${link}`]);
  });
});
