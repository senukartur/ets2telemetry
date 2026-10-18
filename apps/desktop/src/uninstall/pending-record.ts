import path from 'node:path';
import {readAtomicFile, writeAtomicFile, type AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {PLUGIN_TEMP_FILE, pluginsDirectoryOf, sameRoot} from '../plugin-setup/plugin-registry';
import {isDrivePath, type PluginGame} from '../plugin-setup/steam-discovery';

// The uninstall intent `<data root>\uninstall\pending.json` (ET-018 U5 step 2; docs/uninstall.md, "Intent"). It is
// written atomically before anything is deleted and names every game folder the cleanup must finish, with the hashes
// it may remove there. A later run (an interrupted uninstall run again, or the deferred cleanup of PR-5) reads it, so
// the cleanup can finish even after the install registry is gone. Strict parsing: a file that is not a valid v1
// intent is ignored, never trusted.

export const PENDING_FORMAT = 'ets2telemetry.uninstall-pending';
export const PENDING_VERSION = 1;
export const PENDING_DIRECTORY = 'uninstall';
export const PENDING_FILE = 'pending.json';
export const MAX_PENDING_BYTES = 128 * 1024;
export const MAX_PENDING_FOLDERS = 32;
export const MAX_KNOWN_HASHES = 257;
export const MAX_FOLDER_HASHES = 17;
export const MAX_FOLDER_TEMPS = 16;
/** `plugins`: plugin cleanup in progress; `deferred`: plugin folders or data entries were blocked. */
export type PendingPhase = 'plugins' | 'deferred';

/** One game folder the cleanup must finish: the hashes it may remove there and the exact temporary files of intents. */
export interface PendingFolder {
  readonly game: PluginGame;
  readonly root: string;
  readonly hashes: readonly string[];
  readonly temps: readonly string[];
  readonly createdPluginsDirectory: boolean;
}
export interface PendingRecord {
  readonly format: typeof PENDING_FORMAT;
  readonly version: typeof PENDING_VERSION;
  readonly phase: PendingPhase;
  readonly startedUtc: string;
  readonly attempts: number;
  /** The bundle's own and earlier released hashes. */
  readonly known: readonly string[];
  readonly folders: readonly PendingFolder[];
}

const HASH = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys;
const isRoot = (value: unknown): value is string => isDrivePath(value) && path.win32.normalize(value) === value && !/^[A-Za-z]:\\*$/.test(value);

function validFolder(value: unknown): value is PendingFolder {
  if (!isRecord(value) || !keysAre(value, 'createdPluginsDirectory,game,hashes,root,temps')) return false;
  if ((value.game !== 'ets2' && value.game !== 'ats') || !isRoot(value.root) || typeof value.createdPluginsDirectory !== 'boolean') return false;
  if (!Array.isArray(value.hashes) || value.hashes.length > MAX_FOLDER_HASHES || !value.hashes.every(isHash)) return false;
  // A temporary file must be the installer's exact name inside this folder's plugins folder, as in the install registry.
  const root = value.root;
  return Array.isArray(value.temps) && value.temps.length <= MAX_FOLDER_TEMPS && value.temps.every(temp => typeof temp === 'string' && isDrivePath(temp)
    && PLUGIN_TEMP_FILE.test(path.win32.basename(temp)) && sameRoot(path.win32.dirname(temp), pluginsDirectoryOf(root)));
}

/** Strict v1 parsing; undefined for anything else. */
export function parsePendingRecord(bytes: Uint8Array): PendingRecord | undefined {
  if (bytes.byteLength > MAX_PENDING_BYTES) return undefined;
  let value: unknown;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return undefined;}
  if (!isRecord(value) || !keysAre(value, 'attempts,folders,format,known,phase,startedUtc,version')) return undefined;
  if (value.format !== PENDING_FORMAT || value.version !== PENDING_VERSION || (value.phase !== 'plugins' && value.phase !== 'deferred')) return undefined;
  if (typeof value.startedUtc !== 'string' || !UTC.test(value.startedUtc) || !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 1) return undefined;
  if (!Array.isArray(value.known) || value.known.length > MAX_KNOWN_HASHES || !value.known.every(isHash)) return undefined;
  if (!Array.isArray(value.folders) || value.folders.length > MAX_PENDING_FOLDERS || !value.folders.every(validFolder)) return undefined;
  const folders = value.folders;
  if (folders.some((folder, index) => folders.findIndex(other => other.game === folder.game && sameRoot(other.root, folder.root)) !== index)) return undefined;
  return value as unknown as PendingRecord;
}

/** The exact bytes: two-space JSON in a fixed key order with a final newline. */
export function serializePendingRecord(record: PendingRecord): string {
  return `${JSON.stringify({format: PENDING_FORMAT, version: PENDING_VERSION, phase: record.phase, startedUtc: record.startedUtc, attempts: record.attempts,
    known: record.known, folders: record.folders.map(folder => ({game: folder.game, root: folder.root, hashes: folder.hashes, temps: folder.temps,
      createdPluginsDirectory: folder.createdPluginsDirectory}))}, null, 2)}\n`;
}

export type PendingRead = {readonly state: 'absent'} | {readonly state: 'present'; readonly record: PendingRecord} | {readonly state: 'invalid'};
/** Reads the intent; a link, an unreadable file or an invalid document is `invalid` and is not trusted. */
export async function readPendingRecord(fs: AtomicFileSystem, dataRoot: string): Promise<PendingRead> {
  const read = await readAtomicFile(fs, path.win32.join(dataRoot, PENDING_DIRECTORY), PENDING_FILE, MAX_PENDING_BYTES);
  if (read.state === 'absent') return {state: 'absent'};
  if (read.state !== 'present') return {state: 'invalid'};
  const record = parsePendingRecord(read.bytes);
  return record ? {state: 'present', record} : {state: 'invalid'};
}

/** True when the record serializes within every bound of the strict parser, so writePendingRecord accepts it. */
export function pendingRecordFits(record: PendingRecord): boolean {
  return parsePendingRecord(Buffer.from(serializePendingRecord(record), 'utf8')) !== undefined;
}

/** Writes the intent atomically (a synced temporary file renamed over it). Throws AtomicFileError. */
export async function writePendingRecord(fs: AtomicFileSystem, dataRoot: string, record: PendingRecord): Promise<void> {
  const content = serializePendingRecord(record);
  if (!parsePendingRecord(Buffer.from(content, 'utf8'))) throw new Error('Pending uninstall record out of bounds');
  await writeAtomicFile(fs, path.win32.join(dataRoot, PENDING_DIRECTORY), PENDING_FILE, content);
}
