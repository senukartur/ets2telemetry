import {mkdir, readdir, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {removeIncompleteVersion, type IncompleteVersionPorts, type UpdateFileSystem} from '../../apps/desktop/src/updater/update-download';
import {listProcessImages, PROCESS_IMAGES_TIMEOUT_MS} from '../../apps/desktop/src/updater/update-ports';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// ET-055 risk R1 (REG-019; hosted run 40710991951): after a killed apply the half-written app-<version> folder made the
// installation unlaunchable, because the pinned Squirrel writes no completion marker and its stub starts the highest
// app-* folder. removeIncompleteVersion removes exactly that target folder, and only while Squirrel has not recorded
// the release and nothing runs that could still write or use it (review of 33d60d2f). Every case runs in a guarded
// temporary root; expected results are written by hand.

let guard: GuardedRoot;
let installRoot: string;
const PACKAGE = 'ETS2TelemetryDesktopStaging-0.1.2-stg000000-full.nupkg';
const ports = (changes: Partial<IncompleteVersionPorts> = {}): IncompleteVersionPorts => ({fs: guard.fs,
  realpath: target => guard.fs.realpath(target), readFile: target => guard.fs.readFile(target), processImages: () => Promise.resolve([]), ...changes});
beforeEach(async () => {
  guard = await guardedTempRoot('ets2telemetry-incomplete-version-');
  installRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2TelemetryDesktopStaging');
  for (const version of ['0.1.0-stg000000', '0.1.1-stg000000', '0.1.2-stg000000', '0.1.2-stg000000-extra']) {
    await mkdir(path.win32.join(installRoot, `app-${version}`, 'resources'), {recursive: true});
    await writeFile(path.win32.join(installRoot, `app-${version}`, 'ETS2TelemetryDesktopStaging.exe'), 'MZ');
  }
  // Squirrel's local release list of the installed versions; the target is not recorded in it.
  await mkdir(path.win32.join(installRoot, 'packages'));
  await writeFile(path.win32.join(installRoot, 'packages', 'RELEASES'), `\uFEFF${'A'.repeat(40)} ETS2TelemetryDesktopStaging-0.1.1-stg000000-full.nupkg 166075665\r\n`);
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const running = () => path.win32.join(installRoot, 'app-0.1.1-stg000000');
const apps = async () => (await readdir(installRoot)).filter(name => name.startsWith('app-')).sort();
const remove = (changes: Partial<IncompleteVersionPorts> = {}, version = '0.1.2-stg000000', name = PACKAGE, from = running()) =>
  removeIncompleteVersion(ports(changes), installRoot, version, name, from);

it('removes exactly the target version folder, whatever it holds, and keeps every other folder', async () => {
  expect(await remove()).toBe('removed');
  // A folder whose name only starts with the target's is another folder.
  expect(await apps()).toEqual(['app-0.1.0-stg000000', 'app-0.1.1-stg000000', 'app-0.1.2-stg000000-extra']);
  expect(await remove()).toBe('absent');
});

it('never removes the folder the application runs from or one that contains it, by path or by real path', async () => {
  const own = (version: string, from: string) => remove({}, version, `ETS2TelemetryDesktopStaging-${version}-full.nupkg`, from);
  expect(await own('0.1.1-stg000000', running())).toBe('refused');
  expect(await own('0.1.1-stg000000', `${running().toUpperCase()}\\`)).toBe('refused');
  expect(await own('0.1.1-stg000000', path.win32.join(running(), 'resources'))).toBe('refused');
  // The running folder reached through a junction of another name is the same folder.
  const alias = path.win32.join(guard.root, 'alias');
  await symlink(running(), alias, 'junction');
  expect(await own('0.1.1-stg000000', alias)).toBe('refused');
  expect(await apps()).toContain('app-0.1.1-stg000000');
});

it('keeps a folder whose release Squirrel has recorded, as a full or a delta package (review a)', async () => {
  const releases = path.win32.join(installRoot, 'packages', 'RELEASES');
  for (const line of [`${'B'.repeat(40)} ${PACKAGE} 166075665`, `${'C'.repeat(40)} ETS2TelemetryDesktopStaging-0.1.2-stg000000-delta.nupkg 4096`,
    `${'D'.repeat(40)} etx2telemetrydesktopstaging-0.1.1-stg000000-full.nupkg 1\n${'E'.repeat(40)} ets2telemetrydesktopstaging-0.1.2-STG000000-full.nupkg 2`]) {
    await writeFile(releases, `${'A'.repeat(40)} ETS2TelemetryDesktopStaging-0.1.1-stg000000-full.nupkg 166075665\n${line}\n`);
    expect(await remove(), line).toBe('recorded');
  }
  expect(await apps()).toContain('app-0.1.2-stg000000');
  // A list that cannot be read keeps the folder; a missing one records nothing.
  expect(await remove({readFile: () => Promise.reject(Object.assign(new Error('denied'), {code: 'EPERM'}))})).toBe('releases-unreadable');
  expect(await remove({readFile: () => Promise.resolve(new Uint8Array(1024 * 1024 + 1))})).toBe('releases-unreadable');
  expect(await remove({readFile: () => Promise.reject(Object.assign(new Error('missing'), {code: 'ENOENT'}))})).toBe('removed');
});

it('keeps the folder while Update.exe runs or a process runs from inside it, and when the listing fails (review b, c)', async () => {
  const updater = path.win32.join(installRoot, 'Update.exe').toUpperCase();
  expect(await remove({processImages: () => Promise.resolve(['C:\\Windows\\explorer.exe', updater])})).toBe('updater-running');
  expect(await remove({processImages: () => Promise.resolve([path.win32.join(installRoot, 'app-0.1.2-stg000000', 'ETS2TelemetryDesktopStaging.exe')])})).toBe('in-use');
  expect(await remove({processImages: () => Promise.resolve(undefined)})).toBe('listing-failed');
  expect(await remove({processImages: () => Promise.reject(new Error('listing'))})).toBe('listing-failed');
  expect(await apps()).toContain('app-0.1.2-stg000000');
  // Another Update.exe, the running application and a folder whose name only starts with the target's do not keep it.
  expect(await remove({processImages: () => Promise.resolve([path.win32.join(guard.root, 'Other', 'Update.exe'), path.win32.join(running(), 'ETS2TelemetryDesktopStaging.exe'),
    path.win32.join(installRoot, 'app-0.1.2-stg000000-extra', 'ETS2TelemetryDesktopStaging.exe')])})).toBe('removed');
});

it('refuses a version that is not one NuGet folder version, another package name and relative roots (review nit)', async () => {
  for (const version of ['..', '0.1.2\\..\\..', '0.1.2/x', '', 'v0.1.2', '0.1', '0.1.2-stg.000000', '0.1.2-stg000000.', '0.1.2-stg000000 ', '0.1.2--x', '0.1.2-'])
    expect(await remove({}, version, `ETS2TelemetryDesktopStaging-${version}-full.nupkg`), JSON.stringify(version)).toBe('refused');
  expect(await remove({}, '0.1.2-stg000000', 'ETS2TelemetryDesktopStaging-0.1.3-stg000000-full.nupkg')).toBe('refused');
  expect(await remove({}, '0.1.2-stg000000', `..\\${PACKAGE}`)).toBe('refused');
  expect(await removeIncompleteVersion(ports(), 'LocalAppData\\ETS2TelemetryDesktopStaging', '0.1.2-stg000000', PACKAGE, running())).toBe('refused');
  expect(await remove({}, '0.1.2-stg000000', PACKAGE, 'app-0.1.1-stg000000')).toBe('refused');
  expect(await apps()).toHaveLength(4);
});

it('unlinks a target that is a junction without entering it', async () => {
  const outside = path.win32.join(guard.root, 'outside');
  await mkdir(outside);
  await writeFile(path.win32.join(outside, 'kept.txt'), 'kept');
  await symlink(outside, path.win32.join(installRoot, 'app-0.1.3-stg000000'), 'junction');
  expect(await remove({}, '0.1.3-stg000000', 'ETS2TelemetryDesktopStaging-0.1.3-stg000000-full.nupkg')).toBe('removed');
  expect(await readdir(outside)).toEqual(['kept.txt']);
  expect(await apps()).not.toContain('app-0.1.3-stg000000');
});

it('reports a folder it could not remove completely as failed', async () => {
  const held: UpdateFileSystem = {...(guard.fs as unknown as UpdateFileSystem), unlink: () => Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'}))};
  expect(await remove({fs: held})).toBe('failed');
  expect(await apps()).toContain('app-0.1.2-stg000000');
});

it('lists the running images through Windows PowerShell from System32, and answers undefined when that fails', async () => {
  const calls: {file: string; args: readonly string[]; timeoutMs: number}[] = [];
  const run = ((_port: unknown, file: string, args: readonly string[], limits: {timeoutMs: number}) => {
    calls.push({file, args, timeoutMs: limits.timeoutMs});
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    return Promise.resolve({ok: true, stdout: Buffer.concat([bom, Buffer.from('C:\\Windows\\explorer.exe\r\n\r\nrelative\\x.exe\r\nD:\\a\\_temp\\R\\Update.exe\r\n', 'utf8')])});
  }) as unknown as Parameters<typeof listProcessImages>[1];
  expect(await listProcessImages({SystemRoot: 'C:\\Windows'}, run)).toEqual(['C:\\Windows\\explorer.exe', 'D:\\a\\_temp\\R\\Update.exe']);
  expect(calls).toEqual([{file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path } | Where-Object { $_ }'], timeoutMs: PROCESS_IMAGES_TIMEOUT_MS}]);
  for (const failure of ['timeout', 'failed', 'output-too-large'])
    expect(await listProcessImages({}, (() => Promise.resolve({ok: false, failure})) as unknown as Parameters<typeof listProcessImages>[1])).toBeUndefined();
});
