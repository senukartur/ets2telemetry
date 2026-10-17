import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {DiagnosticFacts} from '../diagnostics';
import {isVdfObject, parseVdf, vdfEntry, VdfError, type VdfObject} from './vdf';

// Steam library discovery for ETS2 and ATS (ET-017 P2, P3; docs/plugin-setup.md, "Steam discovery"). The module only
// reads: it never creates, changes or removes anything, and every file and directory access goes through an injected
// port so tests can confine it to a temporary root. Nothing calls it from main yet (ET-017 PR-4 wires it).

export type PluginGame = 'ets2' | 'ats';
export const PLUGIN_GAMES: readonly PluginGame[] = Object.freeze(['ets2', 'ats']);
/** Steam application ids and the 64-bit executables that identify a game root. */
export const GAME_IDENTITY: Readonly<Record<PluginGame, {appId: string; executable: string}>> = Object.freeze({
  ets2: Object.freeze({appId: '227300', executable: 'eurotrucks2.exe'}),
  ats: Object.freeze({appId: '270880', executable: 'amtrucks.exe'})
});
/** The only file name this application manages in a game's plugins folder. */
export const PLUGIN_FILE_NAME = 'ets2telemetry-plugin.dll';
/** Most libraries accepted from libraryfolders.vdf (P2). */
export const MAX_STEAM_LIBRARIES = 64;
/** Largest accepted appmanifest_<id>.acf (P3). */
export const MAX_APP_MANIFEST_BYTES = 64 * 1024;
/** Most Steam game roots reported per game. Steam installs one copy per library, so more means stale manifests. */
export const MAX_STEAM_ROOTS_PER_GAME = 4;

export interface PluginFsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: bigint;
  dev: bigint;
  ino: bigint;
}
export interface PluginReadHandle {
  stat(options: {bigint: true}): Promise<PluginFsStats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
  close(): Promise<void>;
}
/** The read-only file operations discovery and folder validation use. `node:fs/promises` satisfies it. */
export interface PluginReadFileSystem {
  lstat(target: string, options: {bigint: true}): Promise<PluginFsStats>;
  stat(target: string, options: {bigint: true}): Promise<PluginFsStats>;
  realpath(target: string): Promise<string>;
  open(target: string, flags: 'r'): Promise<PluginReadHandle>;
}
export const nodePluginFs: PluginReadFileSystem = nodeFs;

/** A file identity: the volume serial number and file index Windows reports through Node. */
export interface FileIdentity {readonly dev: bigint; readonly ino: bigint}
export const sameIdentity = (left: FileIdentity, right: FileIdentity) => left.dev === right.dev && left.ino === right.ino;

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
/** True for errors that mean "this path does not exist", including a missing drive or a file used as a folder. */
export const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '');

/**
 * True for an absolute drive path such as `D:\SteamLibrary` (forward slashes allowed). UNC paths, device and
 * namespace forms (`\\?\`, `\\.\`, `\??\`), drive-relative `D:x`, alternate data streams and the characters Windows
 * refuses in names are all false.
 */
export function isDrivePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 32_767) return false;
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  // eslint-disable-next-line no-control-regex -- control characters are refused in Windows path names.
  return !/[:*?"<>|\x00-\x1f]/.test(value.slice(2));
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
/** One plain folder name: no separators, drive colon, `.` or `..`, reserved device name or trailing dot or space. */
export function isSafeComponent(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) return false;
  if (value === '.' || value === '..' || value.endsWith('.') || value.endsWith(' ')) return false;
  // eslint-disable-next-line no-control-regex -- control characters are refused in Windows path names.
  if (/[\\/:*?"<>|\x00-\x1f]/.test(value)) return false;
  return !DEVICE_NAME.test(value.trimEnd());
}

/** Case-insensitive containment of normalized drive paths; `inside(a, a)` is true. */
export function isInsideOrEqual(child: string, parent: string): boolean {
  const normal = (value: string) => path.win32.normalize(value).replace(/[\\]+$/, '').toLowerCase();
  const childPath = normal(child), parentPath = normal(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}\\`);
}

/**
 * The canonical form of an existing directory: normalized with path.win32, resolved through realpath and checked
 * again, so a junction or a mapped network drive that resolves to a UNC path is refused. Undefined when the path is
 * unsupported, missing or not a directory.
 */
export async function canonicalDirectory(fs: PluginReadFileSystem, value: string): Promise<{path: string; identity: FileIdentity} | undefined> {
  if (!isDrivePath(value)) return undefined;
  let real: string;
  try {real = await fs.realpath(path.win32.normalize(value));} catch {return undefined;}
  if (!isDrivePath(real)) return undefined;
  real = path.win32.normalize(real);
  try {
    const stat = await fs.stat(real, {bigint: true});
    return stat.isDirectory() ? {path: real, identity: {dev: stat.dev, ino: stat.ino}} : undefined;
  } catch {return undefined;}
}

export type BoundedReadFailure = 'missing' | 'not-file' | 'too-large' | 'unreadable';
/** Reads a regular, non-link file of at most `limit` bytes. The handle must be the same file lstat saw. */
export async function readBoundedFile(fs: PluginReadFileSystem, target: string, limit: number, signal?: AbortSignal): Promise<{ok: true; bytes: Buffer} | {ok: false; failure: BoundedReadFailure}> {
  let before: PluginFsStats;
  try {before = await fs.lstat(target, {bigint: true});} catch (error) {return {ok: false, failure: isMissing(error) ? 'missing' : 'unreadable'};}
  signal?.throwIfAborted();
  if (before.isSymbolicLink() || !before.isFile()) return {ok: false, failure: 'not-file'};
  if (before.size > BigInt(limit)) return {ok: false, failure: 'too-large'};
  let handle: PluginReadHandle;
  try {handle = await fs.open(target, 'r');} catch (error) {return {ok: false, failure: isMissing(error) ? 'missing' : 'unreadable'};}
  try {
    signal?.throwIfAborted();
    const held = await handle.stat({bigint: true});
    if (!held.isFile() || !sameIdentity(held, before)) return {ok: false, failure: 'not-file'};
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    return length > limit ? {ok: false, failure: 'too-large'} : {ok: true, bytes: bytes.subarray(0, length)};
  } catch (error) {
    if (signal?.aborted) throw error;
    return {ok: false, failure: 'unreadable'};
  } finally {await handle.close().catch(() => undefined);}
}

/**
 * The layout of one game root (P3). `ready`: the executable is a regular file, `bin` and `bin\win_x64` are plain
 * folders, and the plugins folder and the target are absent or a plain folder and a regular file. `linked`: `bin`,
 * `bin\win_x64` or `plugins` is a link or junction. `unexpected-entry`: `plugins` is not a folder, or the target is not
 * a regular file (a link or a folder). Only `not-game` lacks paths.
 */
export type GameLayout = {
  readonly status: 'ready' | 'linked' | 'unexpected-entry';
  readonly game: PluginGame;
  readonly root: string;
  readonly identity: FileIdentity;
  readonly executable: string;
  readonly pluginsDirectory: string;
  readonly target: string;
  readonly pluginsExists: boolean;
  readonly targetExists: boolean;
} | {readonly status: 'not-game'};

type Entry = 'missing' | 'link' | 'file' | 'directory' | 'other';
async function entryKind(fs: PluginReadFileSystem, target: string): Promise<Entry> {
  let stat: PluginFsStats;
  try {stat = await fs.lstat(target, {bigint: true});} catch (error) {
    if (isMissing(error)) return 'missing';
    return 'other';
  }
  // Node reports NTFS junctions and symbolic links alike as symbolic links.
  if (stat.isSymbolicLink()) return 'link';
  return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
}

/** Validates a canonical game root for `game`; never follows a link below the root. */
export async function validateGameLayout(fs: PluginReadFileSystem, root: string, game: PluginGame): Promise<GameLayout> {
  let rootStat: PluginFsStats;
  try {rootStat = await fs.stat(root, {bigint: true});} catch {return {status: 'not-game'};}
  if (!rootStat.isDirectory()) return {status: 'not-game'};
  const bin = path.win32.join(root, 'bin'), win64 = path.win32.join(bin, 'win_x64');
  const executable = path.win32.join(win64, GAME_IDENTITY[game].executable);
  const pluginsDirectory = path.win32.join(win64, 'plugins'), target = path.win32.join(pluginsDirectory, PLUGIN_FILE_NAME);
  const binKind = await entryKind(fs, bin);
  if (binKind === 'link') return linkedOrNotGame(fs, game, root, rootStat, executable, pluginsDirectory, target);
  if (binKind !== 'directory') return {status: 'not-game'};
  const win64Kind = await entryKind(fs, win64);
  if (win64Kind === 'link') return linkedOrNotGame(fs, game, root, rootStat, executable, pluginsDirectory, target);
  if (win64Kind !== 'directory') return {status: 'not-game'};
  if (await entryKind(fs, executable) !== 'file') return {status: 'not-game'};
  const base = {game, root, identity: {dev: rootStat.dev, ino: rootStat.ino}, executable, pluginsDirectory, target};
  const pluginsKind = await entryKind(fs, pluginsDirectory);
  if (pluginsKind === 'missing') return {...base, status: 'ready', pluginsExists: false, targetExists: false};
  if (pluginsKind === 'link') return {...base, status: 'linked', pluginsExists: true, targetExists: false};
  if (pluginsKind !== 'directory') return {...base, status: 'unexpected-entry', pluginsExists: true, targetExists: false};
  const targetKind = await entryKind(fs, target);
  if (targetKind === 'missing') return {...base, status: 'ready', pluginsExists: true, targetExists: false};
  return {...base, status: targetKind === 'file' ? 'ready' : 'unexpected-entry', pluginsExists: true, targetExists: true};
}
// A linked `bin` or `bin\win_x64` is reported as linked only when the executable is reachable through it, so a folder
// that merely has a linked `bin` is still "not a game".
async function linkedOrNotGame(fs: PluginReadFileSystem, game: PluginGame, root: string, rootStat: PluginFsStats, executable: string, pluginsDirectory: string, target: string): Promise<GameLayout> {
  let isFile = false;
  try {isFile = (await fs.stat(executable, {bigint: true})).isFile();} catch {/* missing through the link */}
  if (!isFile) return {status: 'not-game'};
  return {status: 'linked', game, root, identity: {dev: rootStat.dev, ino: rootStat.ino}, executable, pluginsDirectory, target, pluginsExists: false, targetExists: false};
}

export type SteamRootResult = {readonly kind: 'found'; readonly path: string} | {readonly kind: 'not-found'} | {readonly kind: 'failed'; readonly code: string};
export type DiscoveryOutcome = 'found' | 'not-found' | 'steam-not-found' | 'steam-list-invalid';
export interface SteamLibrary {readonly ordinal: number; readonly path: string; readonly identity: FileIdentity}
/** A game root found through a Steam library; `library` is that library's ordinal (0 is the Steam root). */
export type SteamGameRoot = Extract<GameLayout, {root: string}> & {readonly library: number};
export interface GameDiscovery {readonly outcome: DiscoveryOutcome; readonly roots: readonly SteamGameRoot[]}
export interface SteamDiscovery {
  readonly steam: 'found' | 'not-found' | 'list-invalid';
  readonly libraries: readonly SteamLibrary[];
  readonly games: Readonly<Record<PluginGame, GameDiscovery>>;
  /** The injected clock's time when discovery finished, in epoch milliseconds. */
  readonly observedAt: number;
  /** Counts and fixed codes for the PLUGIN_DISCOVERY log line; never a path. */
  readonly facts: DiagnosticFacts;
}
export interface SteamDiscoveryPorts {
  /** Where Steam is installed: the registry reader in production, `<root>\Steam` in the test-root mode. */
  steamRoot: (signal?: AbortSignal) => Promise<SteamRootResult>;
  fs?: PluginReadFileSystem;
  now?: () => number;
  signal?: AbortSignal;
  log?: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
}

type LibraryList = {status: 'absent' | 'ok'; paths: string[]; rejected: number} | {status: 'invalid'; reason: string};

/** Library paths from libraryfolders.vdf, in the current (`"0" {"path" …}`) or legacy (`"1" "D:\\Lib"`) format. */
export function libraryPathsFromVdf(document: VdfObject): {ok: true; paths: string[]; rejected: number} | {ok: false; reason: string} {
  const top = vdfEntry(document, 'libraryfolders');
  if (!isVdfObject(top)) return {ok: false, reason: 'no-libraryfolders'};
  const numbered: {index: number; value: string}[] = [];
  let rejected = 0;
  for (const [key, value] of top.entries) {
    // Legacy files also carry keys such as TimeNextStatsReport and ContentStatsID; only numbered keys are libraries.
    if (!/^\d{1,9}$/.test(key)) continue;
    if (numbered.length >= MAX_STEAM_LIBRARIES) return {ok: false, reason: 'too-many-libraries'};
    let candidate: string;
    if (typeof value === 'string') candidate = value;
    else {
      const entry = vdfEntry(value, 'path');
      if (typeof entry !== 'string') return {ok: false, reason: 'library-without-path'};
      candidate = entry;
    }
    if (!isDrivePath(candidate)) {rejected++; continue;}
    numbered.push({index: Number(key), value: candidate});
  }
  numbered.sort((left, right) => left.index - right.index);
  return {ok: true, paths: numbered.map(entry => entry.value), rejected};
}

async function readLibraryList(fs: PluginReadFileSystem, steamRoot: string, signal?: AbortSignal): Promise<LibraryList> {
  // Current Steam keeps the list in steamapps; some installations keep only the copy in config.
  for (const folder of ['steamapps', 'config']) {
    const file = await readBoundedFile(fs, path.win32.join(steamRoot, folder, 'libraryfolders.vdf'), 1024 * 1024, signal);
    if (!file.ok && file.failure === 'missing') continue;
    if (!file.ok) return {status: 'invalid', reason: file.failure};
    try {
      const listed = libraryPathsFromVdf(parseVdf(file.bytes));
      return listed.ok ? {status: 'ok', paths: listed.paths, rejected: listed.rejected} : {status: 'invalid', reason: listed.reason};
    } catch (error) {
      if (error instanceof VdfError) return {status: 'invalid', reason: error.code};
      throw error;
    }
  }
  return {status: 'absent', paths: [], rejected: 0};
}

/** The parsed identity of appmanifest_<id>.acf: its installdir when appid matches and installdir is one safe name. */
export function installDirectoryFromManifest(document: VdfObject, appId: string): string | undefined {
  const state = vdfEntry(document, 'AppState');
  if (!isVdfObject(state)) return undefined;
  if (vdfEntry(state, 'appid') !== appId) return undefined;
  const installDirectory = vdfEntry(state, 'installdir');
  return isSafeComponent(installDirectory) ? installDirectory : undefined;
}

type ManifestResult = {kind: 'absent' | 'invalid' | 'stale'} | {kind: 'root'; layout: Extract<GameLayout, {root: string}>};
async function gameInLibrary(fs: PluginReadFileSystem, library: string, game: PluginGame, signal?: AbortSignal): Promise<ManifestResult> {
  const {appId} = GAME_IDENTITY[game];
  const manifest = await readBoundedFile(fs, path.win32.join(library, 'steamapps', `appmanifest_${appId}.acf`), MAX_APP_MANIFEST_BYTES, signal);
  if (!manifest.ok) return {kind: manifest.failure === 'missing' ? 'absent' : 'invalid'};
  let installDirectory: string | undefined;
  try {installDirectory = installDirectoryFromManifest(parseVdf(manifest.bytes), appId);} catch (error) {
    if (error instanceof VdfError) return {kind: 'invalid'};
    throw error;
  }
  if (installDirectory === undefined) return {kind: 'invalid'};
  signal?.throwIfAborted();
  const root = await canonicalDirectory(fs, path.win32.join(library, 'steamapps', 'common', installDirectory));
  if (!root) return {kind: 'stale'};
  const layout = await validateGameLayout(fs, root.path, game);
  return layout.status === 'not-game' ? {kind: 'stale'} : {kind: 'root', layout};
}

/**
 * Finds ETS2 and ATS through Steam (P2, P3). The Steam root is always library 0. A list that cannot be read or parsed
 * leaves only the Steam root, with every game's outcome `steam-list-invalid` and the log code STEAM_LIBRARY_LIST_INVALID.
 * Libraries and game roots are deduplicated by canonical path and file identity. StateFlags is ignored.
 */
export async function discoverSteamGames(ports: SteamDiscoveryPorts): Promise<SteamDiscovery> {
  const fs = ports.fs ?? nodePluginFs, now = ports.now ?? Date.now, signal = ports.signal, log = ports.log ?? (() => undefined);
  const notFound = (steam: 'not-found', facts: DiagnosticFacts): SteamDiscovery => ({
    steam, libraries: [], observedAt: now(), facts,
    games: {ets2: {outcome: 'steam-not-found', roots: []}, ats: {outcome: 'steam-not-found', roots: []}}
  });
  signal?.throwIfAborted();
  const located = await ports.steamRoot(signal);
  signal?.throwIfAborted();
  if (located.kind === 'failed') return notFound('not-found', {steam: 'not-found', reason: located.code});
  if (located.kind === 'not-found') return notFound('not-found', {steam: 'not-found', reason: 'not-installed'});
  const steamRoot = await canonicalDirectory(fs, located.path);
  if (!steamRoot) return notFound('not-found', {steam: 'not-found', reason: 'root-missing'});

  const listing = await readLibraryList(fs, steamRoot.path, signal);
  if (listing.status === 'invalid') log('STEAM_LIBRARY_LIST_INVALID', undefined, {reason: listing.reason});
  const libraries: SteamLibrary[] = [{ordinal: 0, path: steamRoot.path, identity: steamRoot.identity}];
  let missingLibraries = 0, duplicateLibraries = 0;
  for (const candidate of listing.status === 'invalid' ? [] : listing.paths) {
    signal?.throwIfAborted();
    const library = await canonicalDirectory(fs, candidate);
    if (!library) {missingLibraries++; continue;}
    if (libraries.some(known => known.path.toLowerCase() === library.path.toLowerCase() || sameIdentity(known.identity, library.identity))) {duplicateLibraries++; continue;}
    libraries.push({ordinal: libraries.length, path: library.path, identity: library.identity});
  }

  let invalidManifests = 0, staleManifests = 0, duplicateRoots = 0, truncatedRoots = 0;
  const games = {} as Record<PluginGame, GameDiscovery>;
  for (const game of PLUGIN_GAMES) {
    const roots: SteamGameRoot[] = [];
    for (const library of libraries) {
      signal?.throwIfAborted();
      const found = await gameInLibrary(fs, library.path, game, signal);
      if (found.kind === 'invalid') invalidManifests++;
      else if (found.kind === 'stale') staleManifests++;
      if (found.kind !== 'root') continue;
      const {layout} = found;
      if (roots.some(known => known.root.toLowerCase() === layout.root.toLowerCase() || sameIdentity(known.identity, layout.identity))) {duplicateRoots++; continue;}
      if (roots.length >= MAX_STEAM_ROOTS_PER_GAME) {truncatedRoots++; continue;}
      roots.push({...layout, library: library.ordinal});
    }
    games[game] = {outcome: listing.status === 'invalid' ? 'steam-list-invalid' : roots.length ? 'found' : 'not-found', roots};
  }
  return {
    steam: listing.status === 'invalid' ? 'list-invalid' : 'found', libraries, games, observedAt: now(),
    facts: {
      steam: listing.status === 'invalid' ? 'list-invalid' : 'found', libraryList: listing.status, libraries: libraries.length,
      missingLibraries, duplicateLibraries, rejectedLibraries: listing.status === 'invalid' ? 0 : listing.rejected,
      invalidManifests, staleManifests, duplicateRoots, truncatedRoots,
      ets2: games.ets2.outcome, ats: games.ats.outcome
    }
  };
}
