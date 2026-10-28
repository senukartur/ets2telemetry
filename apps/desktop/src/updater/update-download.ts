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
