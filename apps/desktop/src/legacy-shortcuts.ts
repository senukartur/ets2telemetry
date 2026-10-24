import path from 'node:path';

// The old-name shortcuts (ET-045h, owner decision D2; docs/release.md, "Shortcut migration"). Squirrel names the
// shortcuts after the executable's ProductName and puts the Start menu entry in `Programs\<CompanyName>` (pinned
// Squirrel.Windows eef37460ae, linkTargetForVersionInfo). Before ET-045h the ProductName was "ETS2Telemetry Desktop";
// it is now "Yukon Union Telemetry". `Update.exe --createShortcut` writes only the current name and `--removeShortcut`
// removes only the current name, so an updated install would keep the old shortcut beside the new one, and an uninstall
// would leave the old one behind.
//
// This module removes an old-name shortcut only when all of these hold:
// - it is at exactly one of Squirrel's two locations (`<Desktop>\<old>.lnk`, `<Programs>\<company>\<old>.lnk`); nothing
//   is enumerated;
// - it is a regular file of at most MAX_SHORTCUT_BYTES, not a link;
// - with `requireCurrent` (install and updated), the new-name shortcut exists beside it, so the user is never left
//   without one;
// - it can be read, and it belongs to this install (`ownsShortcut`): a foreign shortcut with the old name is never
//   deleted.
// Folders, taskbar pins and other files are never touched, and no link is followed.

/** The shortcut name Squirrel derives now: forge.config.cjs `win32metadata.ProductName`. */
export const SHORTCUT_NAME = 'Yukon Union Telemetry';
/** The Start menu folder: forge.config.cjs `win32metadata.CompanyName`, unchanged by ET-045h. */
export const SHORTCUT_COMPANY = 'Artur Sianiuk';
/** The ProductName of every build before ET-045h (package.json `productName`). */
export const LEGACY_SHORTCUT_NAMES: readonly string[] = Object.freeze(['ETS2Telemetry Desktop']);
/** The Squirrel id: forge.config.cjs `squirrel.name`, the install root's folder name and the AUMID's first part. */
export const SQUIRREL_APP_ID = 'ETS2TelemetryDesktop';
/** A shortcut Squirrel writes is a few KiB; a larger file at that name is not one of them. */
export const MAX_SHORTCUT_BYTES = 64 * 1024;
/** The whole step gets at most this long inside a Squirrel hook. */
export const LEGACY_SHORTCUT_BUDGET_MS = 1000;
const APP_DIRECTORY = /^app-\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/i;
const DRIVE_PATH = /^[A-Za-z]:\\/;

export interface ShortcutFolders {
  /** The user's Desktop known folder. */
  readonly desktop: string;
  /** `<Start Menu>\Programs` of the user. */
  readonly startMenuPrograms: string;
}
/** What a shortcut points at (Electron's ShortcutDetails, reduced to what ownership needs). */
export interface ShortcutLink {readonly target: string; readonly args?: string; readonly appUserModelId?: string}
export interface LegacyShortcutPorts {
  readonly fs: {
    /** The uninstall file system's lstat (`node:fs/promises` in production). */
    lstat(target: string, options: {bigint: true}): Promise<{isFile(): boolean; isSymbolicLink(): boolean; size: bigint}>;
    unlink(target: string): Promise<void>;
  };
  /** The two shortcut folders; undefined when they cannot be resolved, and then nothing is touched. */
  folders(): ShortcutFolders | undefined;
  /** The shortcut's target, arguments and AUMID; undefined on any failure. */
  readShortcut(file: string): ShortcutLink | undefined;
  /** Monotonic milliseconds, on the same clock as `deadline`. */
  clock(): number;
}
export interface LegacyShortcutResult {
  /** Owned old-name shortcuts deleted. */
  readonly removed: number;
  /** Old-name files left in place: foreign, not a plain file, without the new shortcut, unresolved (below). */
  readonly kept: number;
  /**
   * The part of `kept` whose ownership was never decided, so it may still be this install's shortcut: candidates left at
   * the deadline, a file that could not be inspected, and a shortcut that could not be read. A shortcut proven foreign or
   * a link, folder or oversize file at the old name is not unresolved.
   */
  readonly unresolved: number;
  /** Owned old-name shortcuts whose deletion failed. */
  readonly failed: number;
}
export interface LegacyShortcutCandidate {readonly location: 'desktop' | 'start-menu'; readonly legacy: string; readonly current: string}

const comparable = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
const isAbsentError = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** Squirrel's two shortcut paths for every legacy name, desktop first, each with its current-name sibling. */
export function legacyShortcutCandidates(folders: ShortcutFolders): readonly LegacyShortcutCandidate[] {
  const startMenu = path.win32.join(folders.startMenuPrograms, SHORTCUT_COMPANY);
  const candidates: LegacyShortcutCandidate[] = [];
  for (const [location, folder] of [['desktop', folders.desktop], ['start-menu', startMenu]] as const) {
    for (const name of LEGACY_SHORTCUT_NAMES) {
      candidates.push({location, legacy: path.win32.join(folder, `${name}.lnk`), current: path.win32.join(folder, `${SHORTCUT_NAME}.lnk`)});
    }
  }
  return candidates;
}

/** Splits shortcut arguments the way Windows does for these simple forms: on whitespace, with double-quoted tokens. */
function tokenize(args: string): string[] | undefined {
  const tokens: string[] = [];
  const pattern = /\s*(?:"([^"]*)"|([^\s"]+))/gy;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2]);
    consumed = pattern.lastIndex;
  }
  return args.slice(consumed).trim() === '' ? tokens : undefined;
}

/**
 * True when `link` belongs to this install: its AUMID is absent or Squirrel's `com.squirrel.<id>.<exe>`, and its target
 * is Squirrel's root stub `<installRoot>\<exe>`, a versioned `<installRoot>\app-<version>\<exe>`, or
 * `<installRoot>\Update.exe` with exactly `--processStart <exe>`, optionally followed by `--process-start-args <one
 * token>`. Paths and names compare normalized and case-insensitively. The target need not exist.
 */
export function ownsShortcut(link: ShortcutLink, installRoot: string, executableName: string): boolean {
  if (typeof link.target !== 'string' || !DRIVE_PATH.test(installRoot)) return false;
  const exe = executableName.toLowerCase();
  const aumid = `com.squirrel.${SQUIRREL_APP_ID}.${executableName.replace(/\.exe$/i, '')}`.toLowerCase();
  if (link.appUserModelId && link.appUserModelId.toLowerCase() !== aumid) return false;
  const root = comparable(installRoot);
  const target = comparable(link.target);
  const args = (link.args ?? '').trim();
  const parent = path.win32.dirname(target);
  const stub = target === `${root}\\${exe}`;
  const versioned = path.win32.dirname(parent) === root && APP_DIRECTORY.test(path.win32.basename(parent)) && path.win32.basename(target) === exe;
  // Squirrel's --createShortcut gives these two forms no arguments; a shortcut with arguments is not one it wrote.
  if (stub || versioned) return args === '';
  if (target !== `${root}\\update.exe`) return false;
  const tokens = tokenize(args);
  if (!tokens || tokens[0] !== '--processStart' || tokens[1]?.toLowerCase() !== exe) return false;
  return tokens.length === 2 || (tokens.length === 4 && tokens[2] === '--process-start-args');
}

/** `not-file`: a link, a folder or an oversize file, never a shortcut Squirrel wrote; `error`: it could not be inspected. */
type Probe = 'file' | 'absent' | 'not-file' | 'error';
async function probe(ports: LegacyShortcutPorts, file: string): Promise<Probe> {
  try {
    const stats = await ports.fs.lstat(file, {bigint: true});
    return stats.isFile() && !stats.isSymbolicLink() && stats.size <= BigInt(MAX_SHORTCUT_BYTES) ? 'file' : 'not-file';
  } catch (error) {
    return isAbsentError(error) ? 'absent' : 'error';
  }
}

/**
 * Removes the owned old-name shortcuts at Squirrel's two locations, in a fixed order (desktop, then Start menu), until
 * `deadline` on `ports.clock()`; candidates left at the deadline are kept and unresolved. An absent file is not counted.
 * Unknown folders touch nothing and count nothing. Never throws, never retries, never removes a folder.
 */
export async function removeLegacyShortcuts(options: {installRoot: string; executableName: string; ports: LegacyShortcutPorts; requireCurrent: boolean;
  deadline: number}): Promise<LegacyShortcutResult> {
  const {installRoot, executableName, ports, requireCurrent, deadline} = options;
  let removed = 0, kept = 0, unresolved = 0, failed = 0;
  let folders: ShortcutFolders | undefined;
  try {folders = ports.folders();} catch {folders = undefined;}
  if (!folders || typeof folders.desktop !== 'string' || typeof folders.startMenuPrograms !== 'string'
    || !DRIVE_PATH.test(folders.desktop) || !DRIVE_PATH.test(folders.startMenuPrograms)) return {removed, kept, unresolved, failed};
  const candidates = legacyShortcutCandidates(folders);
  const pastDeadline = () => {try {return ports.clock() >= deadline;} catch {return true;}};
  for (const [index, candidate] of candidates.entries()) {
    // Every candidate from here on stays unchecked, so it may still be ours.
    if (pastDeadline()) {kept += candidates.length - index; unresolved += candidates.length - index; break;}
    const legacy = await probe(ports, candidate.legacy);
    if (legacy === 'absent') continue;
    if (legacy === 'not-file') {kept++; continue;}
    if (legacy === 'error') {kept++; unresolved++; continue;}
    if (requireCurrent && await probe(ports, candidate.current) !== 'file') {kept++; continue;}
    let link: ShortcutLink | undefined;
    try {link = ports.readShortcut(candidate.legacy);} catch {link = undefined;}
    if (!link) {kept++; unresolved++; continue;}
    if (!ownsShortcut(link, installRoot, executableName)) {kept++; continue;}
    if (pastDeadline()) {kept++; unresolved++; continue;}
    try {await ports.fs.unlink(candidate.legacy); removed++;} catch {failed++;}
  }
  return {removed, kept, unresolved, failed};
}
