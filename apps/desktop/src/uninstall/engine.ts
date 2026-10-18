import path from 'node:path';
import type {AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {confineToRoot} from '../plugin-setup/mode';
import type {InstallerFileSystem, RunningCheck} from '../plugin-setup/plugin-installer';
import {PluginRegistry, sameRoot, type PluginRegistryState} from '../plugin-setup/plugin-registry';
import type {RunningGames} from '../plugin-setup/game-processes';
import type {PluginGame} from '../plugin-setup/steam-discovery';
import {DATA_ALLOWLIST, KEPT_UNTIL_CLEAN, wipeDataRoot, type DataEntry, type WipeFailureCode, type WipeFileSystem} from './data-wipe';
import {MAX_KNOWN_HASHES, pendingRecordFits, readPendingRecord, writePendingRecord, type PendingFolder, type PendingRecord} from './pending-record';
import {cleanFolder, cleanupFolders, forgetFolder, intentFolders, type CleanupBlockReason, type FolderNote} from './plugin-cleanup';
import type {UninstallRoots, UninstallRootsRefusal} from './roots';

// The uninstall cleanup engine (ET-018 U5; docs/uninstall.md). Not wired into the application yet: PR-3 runs it from the
// Squirrel uninstall hook and PR-4 from the in-app uninstall. Order ("metadata and helper last"):
//
// 1. Read-only preflight: the roots (U3), the install registry, the previous intent and the running games (at most 3 s).
// 2. The intent `uninstall\pending.json`, written atomically before anything is deleted.
// 3. Plugin cleanup under the ET-017 contract, the registry updated after each folder.
// 4. Every folder clean: the allowlisted data except `plugins` and `uninstall`, then `plugins`, then `uninstall`, then
//    the empty data root.
// 5. A folder blocked or deferred: everything except `plugins` and `uninstall`; the intent stays for a later run.
//
// Every step can be interrupted and run again: a killed run leaves a state that the next run finishes. The result
// carries fixed codes and counts only, never a path, and `complete` is reported only when nothing of this application
// is left in a plugin folder or an allowlisted data entry.

/** The running-game check gets at most this long; a slower or failed check changes no game folder. */
export const RUNNING_CHECK_BUDGET_MS = 3000;

export type UninstallOutcome = 'complete' | 'deferred' | 'refused';
export type RegistryProblem = 'REGISTRY_INVALID' | 'REGISTRY_NEWER' | 'REGISTRY_UNREADABLE';
/** The result's primary reason: why it was refused or deferred, or null when complete. */
export type UninstallCode = UninstallRootsRefusal | 'INTENT_FAILED' | 'RUNNING_CHECK_FAILED' | 'BUDGET_EXPIRED' | RegistryProblem | CleanupBlockReason
  | 'DATA_ENTRY_BLOCKED' | 'INSTANCE_RUNNING';
export interface UninstallResult {
  readonly outcome: UninstallOutcome;
  readonly code: UninstallCode | null;
  readonly plugins: {
    readonly removed: number;
    readonly absent: number;
    /** Folders where a file with the plugin's name and an unknown hash stays. */
    readonly unrecognized: number;
    /** Folders that are no longer game folders, with the fixed note of how each was handled. */
    readonly notes: readonly {readonly game: PluginGame; readonly note: FolderNote}[];
    readonly blocked: readonly {readonly game: PluginGame; readonly reason: CleanupBlockReason | 'RUNNING_CHECK_FAILED' | 'BUDGET_EXPIRED'}[];
  };
  readonly data: {
    readonly removed: number;
    readonly kept: number;
    readonly failed: readonly {readonly entry: DataEntry; readonly code: WipeFailureCode}[];
    readonly rootRemoved: boolean;
  };
  /** O7: Electron's Roaming userData, removed best effort in production installs only (wired in PR-3 and PR-4). */
  readonly roaming: 'removed' | 'failed' | 'not-applicable' | 'not-run';
}

/** Every file operation the engine uses; `node:fs/promises` satisfies it. */
export type UninstallFileSystem = InstallerFileSystem & AtomicFileSystem & WipeFileSystem;

export interface UninstallPorts {
  readonly roots: UninstallRoots;
  readonly fs: UninstallFileSystem;
  /** The P7 running-game check (game-processes.ts `checkRunningGames` in production). */
  readonly checkRunning: RunningCheck;
  /** The bundle's own and earlier released hashes (plugin-manifest.json `sha256` and `known`). */
  readonly known: readonly string[];
  /** Monotonic milliseconds; the run stops at `deadline` on this clock and defers. */
  readonly clock: () => number;
  readonly deadline: number;
  /** The running-game check budget; RUNNING_CHECK_BUDGET_MS unless a test shortens it. */
  readonly runningCheckBudgetMs?: number;
  readonly now?: () => Date;
  readonly delay?: (milliseconds: number) => Promise<void>;
  /** O7 hook: removes Electron's Roaming userData; called only in production mode and only after a complete wipe. */
  readonly removeRoamingUserData?: () => Promise<boolean>;
  /**
   * Defer everything with this code after the read-only preflight and the intent: no game folder and no data entry is
   * touched. The Squirrel uninstall hook uses it when a running instance did not exit (ET-018 U6).
   */
  readonly deferAll?: 'INSTANCE_RUNNING';
  /** Fixed codes and counts only. */
  readonly log?: (event: string, facts: Record<string, string | number | boolean | null>) => void;
}

const REGISTRY_PROBLEM: Partial<Record<PluginRegistryState, RegistryProblem>> = {'invalid-file': 'REGISTRY_INVALID', 'newer-version': 'REGISTRY_NEWER',
  unreadable: 'REGISTRY_UNREADABLE', unavailable: 'REGISTRY_UNREADABLE'};
const defaultDelay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const EMPTY_DATA = {removed: 0, kept: 0, failed: [], rootRemoved: false} as const;

/** The work's result, or `fallback` after `milliseconds`; `expired` runs then, so the work can be cancelled. */
function withTimeout<T>(work: Promise<T>, milliseconds: number, fallback: T, expired: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work.catch(() => fallback), new Promise<T>(resolve => {timer = setTimeout(() => {expired(); resolve(fallback);}, milliseconds);})])
    .finally(() => clearTimeout(timer));
}

/** Runs one uninstall cleanup; see the file comment. */
export async function runUninstall(ports: UninstallPorts): Promise<UninstallResult> {
  const {roots} = ports;
  const refused = (code: UninstallCode): UninstallResult => ({outcome: 'refused', code, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []},
    data: EMPTY_DATA, roaming: 'not-run'});
  if (!roots.ok) return refused(roots.code);
  const now = ports.now ?? (() => new Date()), delay = ports.delay ?? defaultDelay;
  const expired = () => ports.clock() >= ports.deadline;
  const log = ports.log ?? (() => undefined);
  const dataRoot = roots.dataRoot;
  // Game folders are reached through the test root's confinement in test mode (ET-017 P15), directly in production.
  const gameFs: InstallerFileSystem = roots.mode === 'test-root' ? confineToRoot(ports.fs, roots.testRoot, () => log('UNINSTALL_TEST_ROOT_ESCAPE', {})) : ports.fs;

  // 1. Read-only preflight.
  const registry = await PluginRegistry.load(path.win32.join(dataRoot, 'plugins'), {fs: ports.fs, now, delay});
  const previous = await readPendingRecord(ports.fs, dataRoot);
  const kept = previous.state === 'present' ? previous.record.folders : [];
  const registryProblem = REGISTRY_PROBLEM[registry.state];
  // An invalid, newer or unreadable registry names no folder (the ET-017 contract); it stays for a retry. The folders an
  // earlier run recorded in its own intent do not come from it, so they are still cleaned with the intent's own hashes,
  // exactly as when the registry is gone, and the run stays deferred.
  const folders = cleanupFolders(registryProblem ? undefined : registry.document, kept);
  // The listing is cancelled when its budget expires, so tasklist never outlives the uninstall hook.
  const listing = new AbortController();
  const running: RunningGames | undefined = folders.length ? await withTimeout(ports.checkRunning(listing.signal).then(check => check.ok ? check.running : undefined),
    ports.runningCheckBudgetMs ?? RUNNING_CHECK_BUDGET_MS, undefined, () => listing.abort()) : {ets2: false, ats: false, client: false};
  // A run from another build keeps the earlier released hashes the intent carries: this build's first, then the intent's
  // while the intent's bound allows, so a long list never makes the intent unwritable.
  const knownSet = new Set(ports.known.slice(0, MAX_KNOWN_HASHES));
  for (const hash of previous.state === 'present' ? previous.record.known : []) if (knownSet.size < MAX_KNOWN_HASHES) knownSet.add(hash);
  const known = [...knownSet].sort();

  // Nothing at all to do: no data root and no folder.
  const dataRootPresent = await ports.fs.lstat(dataRoot, {bigint: true}).then(() => true, () => false);
  if (!dataRootPresent && !folders.length) {
    return {outcome: 'complete', code: null, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []}, data: {...EMPTY_DATA, rootRemoved: true},
      roaming: await roaming(ports, roots.mode)};
  }

  // 2. The intent, before the first deletion. It records the folders within its bounds, the intent's own first; the run
  // cleans every folder, and what the intent cannot hold is the registry's alone and stays there (intentFolders).
  const intent: PendingRecord = recordable({format: 'ets2telemetry.uninstall-pending', version: 1, phase: 'plugins',
    startedUtc: previous.state === 'present' ? previous.record.startedUtc : now().toISOString(), attempts: previous.state === 'present' ? previous.record.attempts + 1 : 1,
    known, folders: intentFolders(folders, kept)}, ports.known, kept);
  try {await writePendingRecord(ports.fs, dataRoot, intent);} catch {return refused('INTENT_FAILED');}
  log('UNINSTALL_INTENT', {folders: folders.length, recorded: intent.folders.length, attempts: intent.attempts});
  if (ports.deferAll) {
    try {await writePendingRecord(ports.fs, dataRoot, {...intent, phase: 'deferred'});} catch {/* the first intent stays; still deferred */}
    log('UNINSTALL_RESULT', {outcome: 'deferred', code: ports.deferAll, removed: 0, blocked: 0, dataFailed: 0, kept: 0});
    return {outcome: 'deferred', code: ports.deferAll, plugins: {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []}, data: EMPTY_DATA, roaming: 'not-run'};
  }

  // 3. Plugin cleanup, folder by folder.
  let removed = 0, absent = 0, unrecognized = 0;
  const notes: {game: PluginGame; note: FolderNote}[] = [];
  const blocked: {folder: PendingFolder; reason: CleanupBlockReason | 'RUNNING_CHECK_FAILED' | 'BUDGET_EXPIRED'}[] = [];
  for (const folder of folders) {
    if (!running) {blocked.push({folder, reason: 'RUNNING_CHECK_FAILED'}); continue;}
    if (expired()) {blocked.push({folder, reason: 'BUDGET_EXPIRED'}); continue;}
    const outcome = await cleanFolder(folder, {fs: gameFs, running, known, delay});
    if (outcome.status === 'blocked') {blocked.push({folder, reason: outcome.reason}); continue;}
    if (outcome.status === 'removed') removed++; else if (outcome.status === 'absent') absent++; else unrecognized++;
    if (outcome.note) notes.push({game: folder.game, note: outcome.note});
    if (!registryProblem) await forgetFolder(registry, folder);
  }
  const plugins = {removed, absent, unrecognized, notes, blocked: blocked.map(entry => ({game: entry.folder.game, reason: entry.reason}))};
  const pluginsClean = !blocked.length && !registryProblem;

  // 4 and 5. The data: everything but the registry and the intent first.
  const first = await wipeDataRoot(ports.fs, dataRoot, {keep: KEPT_UNTIL_CLEAN, expired});
  let data = first;
  if (pluginsClean && !first.failed.length && !expired()) {
    // The registry, then the intent, then the empty root: an interruption before the last step still has the intent.
    const registryWipe = await wipeDataRoot(ports.fs, dataRoot, {keep: DATA_ALLOWLIST.filter(entry => entry !== 'plugins'), expired});
    const intentWipe = registryWipe.failed.length ? undefined : await wipeDataRoot(ports.fs, dataRoot, {keep: [], removeRoot: true, expired});
    data = {removed: first.removed + registryWipe.removed + (intentWipe?.removed ?? 0), kept: first.kept,
      failed: [...first.failed, ...registryWipe.failed, ...(intentWipe?.failed ?? [])], rootRemoved: intentWipe?.rootRemoved ?? false};
  }
  const budgetSpent = expired() || data.failed.some(entry => entry.code === 'BUDGET_EXPIRED');
  const complete = pluginsClean && !data.failed.length && !budgetSpent;
  if (!complete) {
    // The intent keeps only what is left to clean, for the next run or the deferred cleanup (PR-5).
    const left = intentFolders(blocked.map(entry => entry.folder), kept);
    try {await writePendingRecord(ports.fs, dataRoot, recordable({...intent, phase: 'deferred', folders: left}, ports.known, kept));} catch {/* the earlier intent stays; still deferred */}
  }
  const code: UninstallCode | null = complete ? null : budgetSpent ? 'BUDGET_EXPIRED' : registryProblem ?? blocked[0]?.reason ?? (data.failed.length ? 'DATA_ENTRY_BLOCKED' : null);
  const result: UninstallResult = {outcome: complete ? 'complete' : 'deferred', code, plugins, data, roaming: complete ? await roaming(ports, roots.mode) : 'not-run'};
  log('UNINSTALL_RESULT', {outcome: result.outcome, code: result.code, removed, blocked: blocked.length, dataFailed: data.failed.length, kept: data.kept});
  return result;
}

/**
 * The record within the intent's byte bound: long roots can make even 32 folders exceed 128 KiB. The registry's folders
 * drop from the end first (intentFolders puts the intent's own first); then the known hashes only an earlier intent
 * carried, from the end, while this build's own stay; only then the intent's own folders. The record never becomes
 * unwritable.
 */
export function recordable(record: PendingRecord, ownKnown: readonly string[], kept: readonly PendingFolder[]): PendingRecord {
  const fits = pendingRecordFits;
  if (fits(record)) return record;
  const isOwn = (folder: PendingFolder) => kept.some(other => other.game === folder.game && sameRoot(other.root, folder.root));
  let current = record;
  while (current.folders.length && !isOwn(current.folders.at(-1)!) && !fits(current)) current = {...current, folders: current.folders.slice(0, -1)};
  const own = new Set(ownKnown);
  while (!fits(current)) {
    let last = current.known.length - 1;
    while (last >= 0 && own.has(current.known[last])) last--;
    if (last < 0) break;
    current = {...current, known: current.known.filter((_hash, index) => index !== last)};
  }
  while (current.folders.length && !fits(current)) current = {...current, folders: current.folders.slice(0, -1)};
  return current;
}

async function roaming(ports: UninstallPorts, mode: 'production' | 'test-root'): Promise<UninstallResult['roaming']> {
  if (mode !== 'production' || !ports.removeRoamingUserData) return 'not-applicable';
  try {return await ports.removeRoamingUserData() ? 'removed' : 'failed';} catch {return 'failed';}
}
