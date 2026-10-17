import path from 'node:path';
import {canonicalDirectory, isDrivePath, isInsideOrEqual, nodePluginFs, sameIdentity, validateGameLayout, type GameLayout, type PluginGame,
  type PluginReadFileSystem} from './steam-discovery';

// Validation of a game folder the user chose (ET-017 P4; docs/plugin-setup.md, "Manual game folder"). Main passes the
// path from its own folder dialog; this module only reads. A selection of the game root, `bin`, `bin\win_x64` or
// `bin\win_x64\plugins` is normalized to the root by its exact tail, and the canonical root is what is stored.

export type FolderRefusal = 'FOLDER_UNSUPPORTED_PATH' | 'FOLDER_NOT_GAME' | 'FOLDER_WRONG_GAME' | 'FOLDER_LINKED' | 'FOLDER_DUPLICATE';
export type ManualFolderResult = {readonly ok: true; readonly root: string; readonly layout: Extract<GameLayout, {root: string}>} | {readonly ok: false; readonly code: FolderRefusal};

export interface ManualFolderContext {
  fs?: PluginReadFileSystem;
  /** `%LOCALAPPDATA%\ETS2Telemetry`; a folder inside it is refused. */
  dataRoot: string | undefined;
  /** The application's install directory; a folder inside it is refused. */
  installDirectory: string | undefined;
  /** The canonical Steam roots found for this game; choosing one of them again is FOLDER_DUPLICATE. */
  steamRoots: readonly string[];
}

/** Tails that name a folder inside a game root, longest first, compared case-insensitively by whole components. */
const TAILS: readonly (readonly string[])[] = [['bin', 'win_x64', 'plugins'], ['bin', 'win_x64'], ['bin']];

/** The game root a selection names, by exact tail; undefined for a path that is not an absolute drive path. */
export function gameRootFromSelection(selected: string): string | undefined {
  if (!isDrivePath(selected)) return undefined;
  const normalized = path.win32.normalize(selected).replace(/\\+$/, '');
  const parts = normalized.split('\\');
  for (const tail of TAILS) {
    if (parts.length <= tail.length) continue;
    const end = parts.slice(-tail.length).map(part => part.toLowerCase());
    if (end.every((part, index) => part === tail[index])) {
      const root = parts.slice(0, -tail.length).join('\\');
      // A bare drive (`D:`) gains its separator so it stays absolute.
      return /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
    }
  }
  return /^[A-Za-z]:$/.test(normalized) ? `${normalized}\\` : normalized;
}

async function protectedFolders(fs: PluginReadFileSystem, context: ManualFolderContext): Promise<string[]> {
  const folders: string[] = [];
  for (const folder of [context.dataRoot, context.installDirectory]) {
    if (!isDrivePath(folder)) continue;
    folders.push(path.win32.normalize(folder));
    // The real path too, so a junction or another spelling of the same folder is refused.
    try {folders.push(path.win32.normalize(await fs.realpath(folder)));} catch {/* not created yet: the lexical check applies */}
  }
  return folders;
}

/** Validates and normalizes a chosen folder for `game`. Reads only. */
export async function validateManualFolder(selected: string, game: PluginGame, context: ManualFolderContext): Promise<ManualFolderResult> {
  const fs = context.fs ?? nodePluginFs;
  const candidate = gameRootFromSelection(selected);
  if (!candidate) return {ok: false, code: 'FOLDER_UNSUPPORTED_PATH'};
  const protectedPaths = await protectedFolders(fs, context);
  if (protectedPaths.some(folder => isInsideOrEqual(candidate, folder))) return {ok: false, code: 'FOLDER_UNSUPPORTED_PATH'};
  let real: string;
  try {real = await fs.realpath(candidate);} catch {return {ok: false, code: 'FOLDER_NOT_GAME'};}
  // A mapped network drive or a junction to a share resolves to a UNC path.
  if (!isDrivePath(real)) return {ok: false, code: 'FOLDER_UNSUPPORTED_PATH'};
  if (protectedPaths.some(folder => isInsideOrEqual(real, folder))) return {ok: false, code: 'FOLDER_UNSUPPORTED_PATH'};
  const root = await canonicalDirectory(fs, real);
  if (!root) return {ok: false, code: 'FOLDER_NOT_GAME'};
  const layout = await validateGameLayout(fs, root.path, game);
  if (layout.status === 'not-game') {
    const other: PluginGame = game === 'ets2' ? 'ats' : 'ets2';
    const otherLayout = await validateGameLayout(fs, root.path, other);
    return {ok: false, code: otherLayout.status === 'not-game' ? 'FOLDER_NOT_GAME' : 'FOLDER_WRONG_GAME'};
  }
  if (layout.status === 'linked') return {ok: false, code: 'FOLDER_LINKED'};
  for (const steamRoot of context.steamRoots) {
    try {
      const stat = await fs.stat(steamRoot, {bigint: true});
      if (sameIdentity(stat, layout.identity)) return {ok: false, code: 'FOLDER_DUPLICATE'};
    } catch {/* a Steam root that disappeared cannot be a duplicate */}
  }
  return {ok: true, root: layout.root, layout};
}
