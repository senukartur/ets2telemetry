import path from 'node:path';
import {blockingProcess, type RunningGames} from '../plugin-setup/game-processes';
import {blockReasonFor, hashPluginFile, removeEmptyPluginsDirectory, TARGET_RETRY_DELAYS_MS, type InstallerFileSystem} from '../plugin-setup/plugin-installer';
import {PLUGIN_TEMP_FILE, sameRoot, withoutFailure, type PluginBlockReason, type PluginRegistry,
  type PluginRegistryDocument} from '../plugin-setup/plugin-registry';
import {PLUGIN_FILE_NAME, validateGameLayout} from '../plugin-setup/steam-discovery';
import type {PendingFolder} from './pending-record';

// Plugin cleanup on uninstall (ET-018 U5 step 3), the contract ET-017 wrote for ET-018 (docs/plugin-setup.md,
// "Contract with ET-018"). It acts only on a registry that loads as `loaded` or `empty`, and only on the folders an
// install record or a pending install or update names (and those the uninstall intent kept). For each folder, while
// neither that game nor TruckersMP runs: the layout is checked again without following links, the exact temporary
// files of pending intents are removed, the DLL is removed only while its hash is a recorded, pending or known hash
// and the file is not read-only, and the plugins folder only when this application created it and it is now empty.
// Anything else stays. A locked or denied file is reported (EBUSY retried five times within 300 ms, as the installer
// does), never retried in a loop. The registry is updated after each folder.

/** Why a folder could not be cleaned now; the uninstall then defers. */
export type CleanupBlockReason = PluginBlockReason | 'FOLDER_UNAVAILABLE';
/**
 * `removed`: the DLL was removed. `absent`: nothing of this application was left. `unrecognized`: a file with the plugin's
 * name and an unknown hash stays, as do other files; nothing of this application is left. `blocked`: retry later.
 */
export type FolderOutcome = {readonly status: 'removed' | 'absent' | 'unrecognized'; readonly note?: FolderNote}
  /** `errno` is the failing operation's error code, for diagnostics; never a path. */
  | {readonly status: 'blocked'; readonly reason: CleanupBlockReason; readonly errno?: string | null};
/**
 * Why a folder that is no longer a game folder was handled the way it was (fixed codes, never a path):
 * - `GAME_FOLDER_GONE`: the root is gone while its parent remains (the game and its folder were removed);
 * - `GAME_EXECUTABLE_MISSING`: the root remains without the game executable, as Steam leaves it after an uninstall when
 *   files it did not install, such as this plugin, are still there; the plugin was cleaned by hash ownership as usual;
 * - `LAYOUT_NOT_PLAIN`: in such a root, the root, `bin`, `bin\win_x64` or `plugins` is a link or not a folder: nothing
 *   is touched through it, and the folder counts as absent so that it never blocks forever;
 * - `PLUGINS_FOLDER_ABSENT`: in such a root, `bin`, `bin\win_x64` or `plugins` does not exist: nothing is left to clean.
 */
export type FolderNote = 'GAME_FOLDER_GONE' | 'GAME_EXECUTABLE_MISSING' | 'LAYOUT_NOT_PLAIN' | 'PLUGINS_FOLDER_ABSENT';

/** The folders to clean: every install record and pending install or update, merged with the intent's folders. */
export function cleanupFolders(document: PluginRegistryDocument | undefined, kept: readonly PendingFolder[]): PendingFolder[] {
  const folders: {game: PendingFolder['game']; root: string; hashes: Set<string>; temps: Set<string>; created: boolean}[] = [];
  const entry = (game: PendingFolder['game'], root: string) => {
    let found = folders.find(folder => folder.game === game && sameRoot(folder.root, root));
    if (!found) folders.push(found = {game, root, hashes: new Set(), temps: new Set(), created: false});
    return found;
  };
  for (const record of document?.installs ?? []) {
    const folder = entry(record.game, record.root);
    folder.hashes.add(record.sha256);
    folder.created ||= record.createdPluginsDirectory;
  }
  for (const intent of document?.pending ?? []) {
    // A pending removal's folder has an install record or nothing left to remove.
    if (intent.op === 'remove') continue;
    const folder = entry(intent.game, intent.root);
    if (intent.toSha256) folder.hashes.add(intent.toSha256);
    if (intent.temp) folder.temps.add(intent.temp);
    folder.created ||= intent.createdPluginsDirectory;
  }
  for (const pending of kept) {
    const folder = entry(pending.game, pending.root);
    for (const hash of pending.hashes) folder.hashes.add(hash);
    for (const temp of pending.temps) folder.temps.add(temp);
    folder.created ||= pending.createdPluginsDirectory;
  }
  return folders.map(folder => ({game: folder.game, root: folder.root, hashes: [...folder.hashes].sort(), temps: [...folder.temps].sort(),
    createdPluginsDirectory: folder.created}));
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : null;

/** True only when the root is gone (ENOENT) while its parent is still a plain folder, as the installer's recovery decides. */
async function rootGone(fs: InstallerFileSystem, root: string): Promise<boolean> {
  try {await fs.lstat(root, {bigint: true}); return false;} catch (error) {if (errorCode(error) !== 'ENOENT') return false;}
  const parent = path.win32.dirname(root);
  if (parent === root) return false;
  try {
    const stats = await fs.lstat(parent, {bigint: true});
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {return false;}
}

export interface FolderCleanupPorts {
  readonly fs: InstallerFileSystem;
  readonly running: RunningGames;
  /** The bundle's own and earlier released hashes. */
  readonly known: readonly string[];
  readonly delay: (milliseconds: number) => Promise<void>;
}

/** Cleans one game folder (the contract's steps 1 to 4); see the file comment. */
export async function cleanFolder(folder: PendingFolder, ports: FolderCleanupPorts): Promise<FolderOutcome> {
  const blocking = blockingProcess(folder.game, ports.running);
  if (blocking) return {status: 'blocked', reason: blocking};
  const {fs} = ports;
  // Step 1: the layout again, without following any link below the root.
  const layout = await validateGameLayout(fs, folder.root, folder.game);
  if (layout.status === 'not-game') return notGameFolder(folder, ports);
  if (layout.status === 'linked') return {status: 'blocked', reason: 'LINKED_FOLDER'};
  if (layout.status === 'unexpected-entry') return {status: 'blocked', reason: 'UNRECOGNIZED_FILE'};
  return cleanPlugins(folder, ports, layout.pluginsDirectory, layout.target, layout.pluginsExists, layout.targetExists);
}

type EntryKind = 'directory' | 'file' | 'link' | 'missing' | 'other';
async function entryKind(fs: InstallerFileSystem, target: string): Promise<EntryKind> {
  try {
    const stats = await fs.lstat(target, {bigint: true});
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/**
 * A folder that is no longer a game folder. A root that is gone while its parent remains is absent; a missing parent
 * (an unplugged drive) defers. A root that remains without the game executable (Steam leaves it after an uninstall when
 * files it did not install, such as this plugin, are still there) is cleaned by hash ownership exactly as a game folder
 * when the root, `bin`, `bin\win_x64` and `plugins` are plain folders; otherwise it counts as absent with a fixed note,
 * because nothing is touched through a link and a deferral could never end.
 */
async function notGameFolder(folder: PendingFolder, ports: FolderCleanupPorts): Promise<FolderOutcome> {
  const {fs} = ports;
  let rootKind: EntryKind;
  try {rootKind = await entryKind(fs, folder.root);} catch (error) {return {status: 'blocked', reason: blockReasonFor(errorCode(error), 'default'), errno: errorCode(error)};}
  if (rootKind === 'missing') return await rootGone(fs, folder.root) ? {status: 'absent', note: 'GAME_FOLDER_GONE'} : {status: 'blocked', reason: 'FOLDER_UNAVAILABLE'};
  if (rootKind !== 'directory') return {status: 'absent', note: 'LAYOUT_NOT_PLAIN'};
  const bin = path.win32.join(folder.root, 'bin'), win64 = path.win32.join(bin, 'win_x64'), plugins = path.win32.join(win64, 'plugins');
  const target = path.win32.join(plugins, PLUGIN_FILE_NAME);
  let kinds: EntryKind[];
  try {kinds = [await entryKind(fs, bin), await entryKind(fs, win64), await entryKind(fs, plugins)];} catch (error) {
    return {status: 'blocked', reason: blockReasonFor(errorCode(error), 'default'), errno: errorCode(error)};
  }
  if (kinds.includes('missing')) return {status: 'absent', note: 'PLUGINS_FOLDER_ABSENT'};
  if (kinds.some(kind => kind !== 'directory')) return {status: 'absent', note: 'LAYOUT_NOT_PLAIN'};
  let targetKind: EntryKind;
  try {targetKind = await entryKind(fs, target);} catch (error) {return {status: 'blocked', reason: blockReasonFor(errorCode(error), 'target-read'), errno: errorCode(error)};}
  const outcome = await cleanPlugins(folder, ports, plugins, target, true, targetKind !== 'missing');
  return outcome.status === 'blocked' ? outcome : {status: outcome.status, note: 'GAME_EXECUTABLE_MISSING'};
}

/** The contract's steps 2 to 4 in a validated plugins folder. */
async function cleanPlugins(folder: PendingFolder, ports: FolderCleanupPorts, plugins: string, target: string, pluginsExists: boolean,
  targetExists: boolean): Promise<FolderOutcome> {
  const {fs} = ports;
  // Step 2: the exact temporary file of each pending entry, when it is a regular file.
  for (const temp of folder.temps) {
    if (!PLUGIN_TEMP_FILE.test(path.win32.basename(temp)) || !sameRoot(path.win32.dirname(temp), plugins)) continue;
    try {
      const stats = await fs.lstat(temp, {bigint: true});
      if (stats.isFile() && !stats.isSymbolicLink()) await fs.unlink(temp);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return {status: 'blocked', reason: blockReasonFor(errorCode(error), 'target-replace'), errno: errorCode(error)};
    }
  }
  // Step 3: the DLL, only while its hash is one this application installed and it is not read-only.
  let status: 'removed' | 'absent' | 'unrecognized' = 'absent';
  if (targetExists) {
    const hashed = await hashPluginFile(fs, target);
    if (!hashed.ok) {
      if (hashed.kind === 'error') return {status: 'blocked', reason: blockReasonFor(hashed.errno, 'target-read'), errno: hashed.errno};
      if (hashed.kind !== 'missing') status = 'unrecognized';
    } else if (!folder.hashes.includes(hashed.sha256) && !ports.known.includes(hashed.sha256)) status = 'unrecognized';
    // An unlink would clear the read-only attribute, so a read-only DLL is skipped and reported.
    else if ((hashed.mode & 0o200n) === 0n) return {status: 'blocked', reason: 'READ_ONLY_FILE'};
    else {
      const removed = await unlinkWithRetry(fs, target, ports.delay);
      if (removed) return {status: 'blocked', reason: removed.reason, errno: removed.errno};
      status = 'removed';
    }
  }
  // Step 4: the plugins folder only when this application created it and it is now empty.
  if (folder.createdPluginsDirectory && pluginsExists) await removeEmptyPluginsDirectory(fs, plugins);
  return {status};
}

/** Unlinks the DLL, retrying only EBUSY after 20, 40, 60, 80 and 100 ms; EPERM (a mapped image) is TARGET_LOCKED at once. */
async function unlinkWithRetry(fs: InstallerFileSystem, target: string, delay: (milliseconds: number) => Promise<void>): Promise<{reason: PluginBlockReason; errno: string | null} | null> {
  for (let attempt = 0; ; attempt++) {
    try {await fs.unlink(target); return null;} catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return null;
      if (code !== 'EBUSY' || attempt >= TARGET_RETRY_DELAYS_MS.length) return {reason: blockReasonFor(code, 'target-replace'), errno: code};
      await delay(TARGET_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Forgets one cleaned folder in the install registry: its install record, its pending intents and its failure. */
export async function forgetFolder(registry: PluginRegistry, folder: Pick<PendingFolder, 'game' | 'root'>): Promise<boolean> {
  const document = registry.document;
  const same = (other: {game: string; root: string}) => other.game === folder.game && sameRoot(other.root, folder.root);
  if (!document.installs.some(same) && !document.pending.some(same) && !document.failures.some(same)) return true;
  try {
    await registry.update(current => withoutFailure({...current, installs: current.installs.filter(other => !same(other)),
      pending: current.pending.filter(other => !same(other))}, folder.game, folder.root));
    return true;
  } catch {return false;}
}
