import {spawn as nodeSpawn} from 'node:child_process';
import * as nodeFsPromises from 'node:fs/promises';
import path from 'node:path';
import type {ChannelIdentity} from '../channel';
import {nodeExecFile, runFixedProgram} from '../plugin-setup/fixed-program';
import {checkRunningGames} from '../plugin-setup/game-processes';
import {powershellPath, windowsPowerShellEnvironment} from '../plugin-setup/steam-registry';
import {resolveUninstallRoots, type RootsFileSystem} from '../uninstall/roots';
import {resolveUpdateContext} from './update-context';
import {APPLY_TIMEOUT_MS, type UpdatePorts} from './update-controller';
import {UNREADABLE_UPDATER_IMAGE, type UpdateFileSystem} from './update-download';
import type {FetchResponse} from './update-feed';

// The production ports of the update controller (ET-055 UP3, UP4, UP8). Requests go through Electron's net.fetch, so the
// system proxy and certificate store apply; they carry a fixed User-Agent without a version or any identifier, no
// cookies and no cache. Update.exe runs through runFixedProgram with fixed arguments under the 180 s deadline and is
// never aborted by the exit. The restart helper starts `Update.exe --processStartAndWait <executable>` detached, which
// waits for this process to end and then starts the newest installed version.

/** The fixed User-Agent of every update request; GitHub's REST API requires one. */
export const UPDATE_USER_AGENT = 'YukonUnionTelemetry-Updater';
/** Update.exe writes little to stdout; the bound is generous so that output never ends a running apply. */
const APPLY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Electron's `net.fetch` (or any WHATWG fetch); main passes it in, so this module never loads Electron itself. */
export type NetFetch = (url: string, init: RequestInit) => Promise<FetchResponse>;

export interface ProductionUpdatePortsInput {
  readonly fetch: NetFetch;
  readonly packaged: boolean;
  /** process.execPath. */
  readonly executable: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly identity: ChannelIdentity;
}

export function productionUpdatePorts(input: ProductionUpdatePortsInput): UpdatePorts {
  const fs = nodeFsPromises as unknown as UpdateFileSystem & RootsFileSystem;
  return {
    resolveContext: async () => resolveUpdateContext({packaged: input.packaged, env: input.env, executable: input.executable, identity: input.identity,
      roots: input.packaged ? await resolveUninstallRoots({executable: input.executable, env: input.env, fs}) : {ok: false, code: 'NOT_INSTALLED'}}),
    fetch: (url, init) => input.fetch(url, {signal: init.signal, method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store',
      headers: {'User-Agent': UPDATE_USER_AGENT, Accept: init.kind === 'json' ? 'application/vnd.github+json' : 'application/octet-stream'}}),
    fs,
    runUpdate: (updateExe, folder) => runFixedProgram(nodeExecFile, updateExe, ['--update', folder], {timeoutMs: APPLY_TIMEOUT_MS, maxOutputBytes: APPLY_MAX_OUTPUT_BYTES}),
    install: {realpath: target => nodeFsPromises.realpath(target), readFile: target => nodeFsPromises.readFile(target), processImages: () => listProcessImages(input.env)},
    checkRunning: async () => {
      const listing = await checkRunningGames();
      return listing.ok ? {ok: true, running: listing.running} : {ok: false};
    },
    clock: {
      now: () => performance.now(),
      utcNow: () => Date.now(),
      setTimeout: (callback, milliseconds) => {const timer = setTimeout(callback, milliseconds); timer.unref(); return timer;},
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  };
}

/** The R1 cleanup's process listing: Windows PowerShell 5.1 from System32 with one fixed command, 15 s and 4 MiB at most. */
export const PROCESS_IMAGES_TIMEOUT_MS = 15_000;
const PROCESS_IMAGES_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * One line per process: its image path, or UNREADABLE_UPDATER_IMAGE for a process named Update or Squirrel whose path
 * this user cannot read (review of ebe3395b: an elevated updater must not disappear from the check). Other processes
 * without a readable path write nothing.
 */
export const PROCESS_IMAGES_COMMAND = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { ' +
  `if ($_.Path) { $_.Path } elseif (@('Update', 'Squirrel') -contains $_.ProcessName) { '${UNREADABLE_UPDATER_IMAGE}' } }`;
/**
 * The image paths of the running processes this user can read, one per line, plus UNREADABLE_UPDATER_IMAGE lines;
 * undefined when the listing failed (a non-zero exit, the deadline or the output bound), so the cleanup keeps the folder.
 * The program is `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` from the validated SystemRoot, and its
 * PSModulePath is Windows PowerShell's own, as for the Steam registry read.
 */
export async function listProcessImages(env: Readonly<Record<string, string | undefined>>, run: typeof runFixedProgram = runFixedProgram): Promise<readonly string[] | undefined> {
  const result = await run(nodeExecFile, powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_IMAGES_COMMAND],
    {timeoutMs: PROCESS_IMAGES_TIMEOUT_MS, maxOutputBytes: PROCESS_IMAGES_MAX_OUTPUT_BYTES, env: windowsPowerShellEnvironment(env)}).catch(() => undefined);
  if (!result?.ok) return undefined;
  return result.stdout.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line === UNREADABLE_UPDATER_IMAGE || path.win32.isAbsolute(line));
}

/** How long main waits for the restart helper to spawn before it exits anyway. */
export const RESTART_SPAWN_TIMEOUT_MS = 2000;
export type SpawnPort = typeof nodeSpawn;

/**
 * Starts `<installRoot>\Update.exe --processStartAndWait <executableName>` detached (UP3, UP8). Resolves true once it
 * spawned, false when it could not start or did not spawn within RESTART_SPAWN_TIMEOUT_MS.
 */
export function startUpdatedApplication(installRoot: string, executableName: string, spawn: SpawnPort = nodeSpawn): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), RESTART_SPAWN_TIMEOUT_MS);
    const done = (started: boolean) => {clearTimeout(timer); resolve(started);};
    try {
      const child = spawn(path.win32.join(installRoot, 'Update.exe'), ['--processStartAndWait', executableName], {detached: true, stdio: 'ignore', windowsHide: true});
      child.once('spawn', () => {child.unref(); done(true);});
      child.once('error', () => done(false));
    } catch {done(false);}
  });
}
