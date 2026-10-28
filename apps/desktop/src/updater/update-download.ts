import {createHash} from 'node:crypto';
import path from 'node:path';
import type {UpdateFailure} from '../../../../packages/contracts/src/app-state';
import {removeOwnedTree, type WipeFileSystem} from '../uninstall/data-wipe';
import type {FeedTimers, FetchPort} from './update-feed';
import type {UpdateManifest} from './update-manifest';

// The verified package download (ET-055 UP3, UP18; docs/app-lifecycle.md, "In-app updates"). After the user's click the
// nupkg is written to `<data root>\updates\<NuGet version>\<name>.partial`, hashed while it arrives, and renamed to its
// name only when its size, SHA-256 and SHA-1 equal the signed manifest. A one-line RELEASES file beside it makes the
// folder a local Squirrel feed for `Update.exe --update`. The `updates` folder holds at most this one version: it is
// removed before a download, after a successful or failed apply and at startup. Links are never followed.

export const UPDATES_DIRECTORY = 'updates';
/** No data for this long ends the download (UP3). */
export const DOWNLOAD_STALL_MS = 60_000;
/** The whole download ends after this long (UP3). */
export const DOWNLOAD_TOTAL_MS = 30 * 60_000;
export const PARTIAL_SUFFIX = '.partial';

/** The file operations of the download; `node:fs/promises` satisfies them. */
export interface UpdateFileSystem extends WipeFileSystem {
  mkdir(target: string, options: {recursive: true}): Promise<unknown>;
  open(target: string, flags: 'wx'): Promise<{write(data: Uint8Array): Promise<{bytesWritten: number}>; close(): Promise<void>}>;
  rename(from: string, to: string): Promise<void>;
  writeFile(target: string, data: string, options: {flag: 'wx'}): Promise<void>;
}

export const updatesDirectory = (dataRoot: string) => path.win32.join(dataRoot, UPDATES_DIRECTORY);
export const versionDirectory = (dataRoot: string, nugetVersion: string) => path.win32.join(updatesDirectory(dataRoot), nugetVersion);

/** Removes the whole `updates` folder; true when it is gone (or never existed). */
export async function clearUpdates(fs: UpdateFileSystem, dataRoot: string): Promise<boolean> {
  return await removeOwnedTree(fs, updatesDirectory(dataRoot)).catch(() => 'IO_ERROR' as const) === null;
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

/**
 * What removeIncompleteVersion did. `removed` and `absent`: no target folder is left. Kept, each with its fixed reason:
 * `refused` (a folder it may not touch, or an input of the wrong form), `recorded` (Squirrel already lists the release),
 * `releases-unreadable`, `updater-running`, `in-use` (a process runs from the folder), `listing-failed` and `failed` (a
 * removal that did not finish).
 */
export type IncompleteRemoval = 'removed' | 'absent' | 'refused' | 'recorded' | 'releases-unreadable' | 'updater-running' | 'in-use' | 'listing-failed' | 'failed';
/** Kept outcomes that can change within seconds (a process ending, a file let go); the controller asks again for those. */
export const RETRYABLE_REMOVALS: ReadonlySet<IncompleteRemoval> = new Set<IncompleteRemoval>(['updater-running', 'in-use', 'listing-failed', 'failed']);
/**
 * The line the process listing writes for a process named Update or Squirrel whose image path it cannot read (an
 * elevated updater seen from a non-elevated application); removeIncompleteVersion counts it as a running updater.
 */
export const UNREADABLE_UPDATER_IMAGE = '?unreadable-updater';
/** What removeIncompleteVersion reads beyond the file operations of the download. */
export interface IncompleteVersionPorts {
  readonly fs: UpdateFileSystem;
  realpath(target: string): Promise<string>;
  readFile(target: string): Promise<Uint8Array>;
  /** The image paths of the running processes this user can read; undefined when the listing failed. */
  processImages(): Promise<readonly string[] | undefined>;
}
const normalFolder = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
const within = (candidate: string, folder: string) => {const child = normalFolder(candidate), parent = normalFolder(folder); return child === parent || child.startsWith(`${parent}\\`);};
/** The NuGet form Squirrel names folders with: no dot in the prerelease label, nothing after it. */
const NUGET_FOLDER_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z][0-9A-Za-z-]{0,59})?$/;
/** Squirrel's local release list is a few lines; a larger one is not read. */
const RELEASES_MAX_BYTES = 1024 * 1024;

/**
 * ET-055 risk R1 (the hosted update-from-feed run 40710991951): `Update.exe --update` that ends early, killed by the
 * 180 s deadline or by anything else, leaves the half-written `<install root>\app-<NuGet version>` folder behind. The
 * pinned Squirrel writes no completion marker, and its stub (every shortcut) and `--processStart` start the highest
 * `app-*` folder whatever it holds, so that folder makes the installation unlaunchable until an apply completes.
 *
 * After a failed apply the still-running application removes exactly that target folder (`packageName` is the signed
 * manifest's nupkg name), and only when all of these hold (review of 33d60d2f):
 * - it is a direct child of the install root, and neither the folder this application runs from nor one that contains
 *   it, compared by path and by real path;
 * - `<install root>\packages\RELEASES` does not list the release yet: Squirrel records it after it has written the folder,
 *   and once recorded, a removed folder would make the next apply of that version a no-op that keeps restarting the old
 *   version;
 * - no `<install root>\Update.exe` runs (a second apply could still be writing the folder: Squirrel's update lock), and no
 *   process runs from inside the folder (the `--squirrel-updated` hook of a killed apply, for example).
 * Links are unlinked and never entered. A refused or failed check keeps the folder, with its fixed reason.
 */
export async function removeIncompleteVersion(ports: IncompleteVersionPorts, installRoot: string, nugetVersion: string, packageName: string, runningDirectory: string): Promise<IncompleteRemoval> {
  if (!NUGET_FOLDER_VERSION.test(nugetVersion) || !packageName.endsWith(`-${nugetVersion}-full.nupkg`) || /[\\/]/.test(packageName) ||
    !path.win32.isAbsolute(installRoot) || !path.win32.isAbsolute(runningDirectory)) return 'refused';
  const folder = path.win32.join(installRoot, `app-${nugetVersion}`);
  if (normalFolder(path.win32.dirname(folder)) !== normalFolder(installRoot) || within(runningDirectory, folder)) return 'refused';
  try {await ports.fs.lstat(folder, {bigint: true});} catch (error) {return errorCode(error) === 'ENOENT' ? 'absent' : 'failed';}
  // The same check by real path: a junction or a different spelling cannot make the running folder look like another.
  let realFolder: string, realRunning: string;
  try {[realFolder, realRunning] = await Promise.all([ports.realpath(folder), ports.realpath(runningDirectory)]);} catch {return 'refused';}
  if (within(realRunning, realFolder) || within(realRunning, folder)) return 'refused';
  // Recorded by Squirrel: the full or a delta package of this version in the local release list.
  const releases = path.win32.join(installRoot, 'packages', 'RELEASES');
  let text = '';
  try {
    const bytes = await ports.readFile(releases);
    if (bytes.byteLength > RELEASES_MAX_BYTES) return 'releases-unreadable';
    text = new TextDecoder('utf-8').decode(bytes);
  } catch (error) {if (errorCode(error) !== 'ENOENT') return 'releases-unreadable';}
  const names = new Set([packageName, packageName.replace(/-full\.nupkg$/, '-delta.nupkg')].map(name => name.toLowerCase()));
  // Each non-empty line is `<SHA-1> <file name or URL> <size>`; the name is the URL's last path segment without its query
  // or fragment. A line of another shape makes the list unreadable, so the folder stays (fail closed).
  const listed: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
    const match = /^[0-9A-Fa-f]{40}\s+(\S+)\s+\d+(?:\s|$)/.exec(line);
    if (!match) return 'releases-unreadable';
    listed.push((match[1].replace(/[?#].*$/, '').split(/[\\/]/).at(-1) ?? '').toLowerCase());
  }
  if (listed.some(name => names.has(name))) return 'recorded';
  let realRoot: string;
  try {realRoot = await ports.realpath(installRoot);} catch {return 'refused';}
  const images = await ports.processImages().catch(() => undefined);
  if (!images) return 'listing-failed';
  // An Update.exe or Squirrel process whose image this user cannot read (an elevated one) counts as this updater.
  const updaters = new Set([path.win32.join(installRoot, 'Update.exe'), path.win32.join(realRoot, 'Update.exe')].map(normalFolder));
  if (images.some(image => image === UNREADABLE_UPDATER_IMAGE || updaters.has(normalFolder(image)))) return 'updater-running';
  if (images.some(image => within(image, folder) || within(image, realFolder))) return 'in-use';
  return await removeOwnedTree(ports.fs, folder).catch(() => 'IO_ERROR' as const) === null ? 'removed' : 'failed';
}
const writeFailure = (error: unknown): UpdateFailure => errorCode(error) === 'ENOSPC' ? 'DISK_FULL' : 'DOWNLOAD_FAILED';

export type DownloadResult = {readonly ok: true; readonly folder: string}
  | {readonly ok: false; readonly failure: UpdateFailure; readonly code: string}
  | {readonly ok: false; readonly failure: 'ABORTED'; readonly code: 'ABORTED'};

export interface DownloadRequest {
  readonly fetch: FetchPort;
  readonly fs: UpdateFileSystem;
  readonly timers: FeedTimers;
  readonly dataRoot: string;
  readonly manifest: UpdateManifest;
  readonly packageUrl: string;
  /** Aborted when the exit begins: the download stops and its `.partial` is removed. */
  readonly signal: AbortSignal;
  /** Called with a whole percentage whenever it changes. */
  progress(percent: number): void;
}

/**
 * Downloads and verifies the manifest's package into its version folder and writes the RELEASES line; see the file
 * comment. A refused or failed download leaves no `.partial` behind.
 */
export async function downloadPackage(request: DownloadRequest): Promise<DownloadResult> {
  const {fs, manifest, timers} = request, expected = manifest.package;
  if (!(await clearUpdates(fs, request.dataRoot))) return {ok: false, failure: 'DOWNLOAD_FAILED', code: 'UPDATES_NOT_CLEARED'};
  const folder = versionDirectory(request.dataRoot, manifest.nugetVersion);
  const partial = path.win32.join(folder, expected.name + PARTIAL_SUFFIX), final = path.win32.join(folder, expected.name);
  try {await fs.mkdir(folder, {recursive: true});} catch (error) {return {ok: false, failure: writeFailure(error), code: 'FOLDER_FAILED'};}
  let handle: Awaited<ReturnType<UpdateFileSystem['open']>> | undefined;
  try {handle = await fs.open(partial, 'wx');} catch (error) {return {ok: false, failure: writeFailure(error), code: 'OPEN_FAILED'};}

  const controller = new AbortController();
  let reason: 'stall' | 'total' | undefined;
  const stopFor = (why: 'stall' | 'total') => {reason ??= why; controller.abort();};
  const total = timers.setTimeout(() => stopFor('total'), DOWNLOAD_TOTAL_MS);
  let stall = timers.setTimeout(() => stopFor('stall'), DOWNLOAD_STALL_MS);
  const forward = () => controller.abort();
  request.signal.addEventListener('abort', forward, {once: true});
  if (request.signal.aborted) controller.abort();
  const aborted = new Promise<'aborted'>(resolve => controller.signal.addEventListener('abort', () => resolve('aborted'), {once: true}));
  const stopped = (): DownloadResult => request.signal.aborted ? {ok: false, failure: 'ABORTED', code: 'ABORTED'}
    : reason ? {ok: false, failure: 'DOWNLOAD_FAILED', code: reason === 'stall' ? 'STALLED' : 'TOTAL_TIMEOUT'} : {ok: false, failure: 'OFFLINE', code: 'NETWORK'};
  const sha256 = createHash('sha256'), sha1 = createHash('sha1');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, received = 0, reported = -1, renamed = false;
  const result = await (async (): Promise<DownloadResult> => {
    let response;
    try {response = await Promise.race([request.fetch(request.packageUrl, {signal: controller.signal, kind: 'binary'}), aborted]);} catch {return stopped();}
    if (response === 'aborted') return stopped();
    if (response.status === 403 || response.status === 429) return {ok: false, failure: 'OFFLINE', code: 'RATE_LIMITED'};
    if (response.status < 200 || response.status > 299 || !response.body) return {ok: false, failure: 'DOWNLOAD_FAILED', code: 'HTTP_STATUS'};
    reader = response.body.getReader();
    request.progress(reported = 0);
    for (;;) {
      let next;
      try {next = await Promise.race([reader.read(), aborted]);} catch {return stopped();}
      if (next === 'aborted') return stopped();
      if (next.done) break;
      timers.clearTimeout(stall); stall = timers.setTimeout(() => stopFor('stall'), DOWNLOAD_STALL_MS);
      received += next.value.byteLength;
      // More bytes than the signed size: stop at once, never write past it.
      if (received > expected.size) return {ok: false, failure: 'HASH_MISMATCH', code: 'SIZE_EXCEEDED'};
      sha256.update(next.value); sha1.update(next.value);
      try {
        for (let offset = 0; offset < next.value.byteLength;) offset += (await handle.write(next.value.subarray(offset))).bytesWritten;
      } catch (error) {return {ok: false, failure: writeFailure(error), code: 'WRITE_FAILED'};}
      if (controller.signal.aborted) return stopped();
      const percent = Math.floor(received * 100 / expected.size);
      if (percent !== reported) request.progress(reported = percent);
    }
    if (received !== expected.size) return {ok: false, failure: 'HASH_MISMATCH', code: 'SIZE_MISMATCH'};
    if (sha256.digest('hex') !== expected.sha256 || sha1.digest('hex') !== expected.sha1) return {ok: false, failure: 'HASH_MISMATCH', code: 'HASH_MISMATCH'};
    try {await handle.close(); handle = undefined; await fs.rename(partial, final); renamed = true;} catch (error) {return {ok: false, failure: writeFailure(error), code: 'RENAME_FAILED'};}
    // Squirrel's RELEASES line: the upper-case SHA-1, the file name and its size.
    try {await fs.writeFile(path.win32.join(folder, 'RELEASES'), `${expected.sha1.toUpperCase()} ${expected.name} ${expected.size}`, {flag: 'wx'});}
    catch (error) {return {ok: false, failure: writeFailure(error), code: 'RELEASES_FAILED'};}
    return {ok: true, folder};
  })();
  timers.clearTimeout(total); timers.clearTimeout(stall);
  request.signal.removeEventListener('abort', forward);
  if (!controller.signal.aborted) controller.abort();
  void reader?.cancel().catch(() => undefined);
  if (handle) await handle.close().catch(() => undefined);
  if (!result.ok) {
    // Nothing of a refused or interrupted download stays: the `.partial` first, then the version folder.
    if (!renamed) await removeOwnedTree(fs, partial).catch(() => undefined);
    await clearUpdates(fs, request.dataRoot);
  }
  return result;
}
