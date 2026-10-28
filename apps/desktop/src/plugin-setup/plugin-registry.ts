import path from 'node:path';
import type {DiagnosticFacts} from '../diagnostics';
import {AtomicFileError, nodeAtomicFs, readAtomicFile, writeAtomicFile, type AtomicFileSystem} from './atomic-json-file';
import {isDrivePath, PLUGIN_FILE_NAME, PLUGIN_GAMES, type PluginGame} from './steam-discovery';
import {pluginTempFilePattern} from '../channel';

// The plugin install registry `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json` (ET-017 P9; docs/plugin-setup.md,
// "Install registry"). It holds the per-game exclusions and manual folders, one record per game folder this application
// installed into or adopted, the pending intents of operations in progress and the last failure per game and source.
// Loading never writes. An invalid file is moved aside byte-identically by the first write; a newer version is
// read-only. Main's single-instance lock guarantees one writer, and this class serializes its own writes.

export const PLUGIN_REGISTRY_FORMAT = 'ets2telemetry.plugin-setup';
export const PLUGIN_REGISTRY_VERSION = 1;
export const PLUGIN_REGISTRY_FILE = 'setup.json';
export const PLUGIN_REGISTRY_QUARANTINE_PREFIX = 'setup.rejected-';
export const MAX_PLUGIN_REGISTRY_BYTES = 256 * 1024;
export const MAX_INSTALL_RECORDS = 16;
export const MAX_PENDING_INTENTS = 16;
/** At most one failure per game folder is kept; the oldest is dropped first (failures are informational). */
export const MAX_FAILURE_RECORDS = 16;
export const KEPT_REJECTED_REGISTRIES = 3;
/** Longest root path accepted in a record; far beyond any game folder, it only bounds a hostile file. */
const MAX_ROOT_LENGTH = 4096;

/** Why a target is blocked (P16). ET-017 PR-4 exposes the same codes in the AppState contract. */
export const PLUGIN_BLOCK_REASONS = Object.freeze(['GAME_RUNNING', 'CLIENT_RUNNING', 'TARGET_LOCKED', 'PERMISSION_DENIED', 'READ_ONLY_FILE',
  'UNRECOGNIZED_FILE', 'LINKED_FOLDER', 'DISK_FULL', 'IO_ERROR', 'VERIFY_FAILED', 'RUNNING_CHECK_FAILED', 'REGISTRY_UNAVAILABLE',
  'BUNDLE_UNAVAILABLE'] as const);
export type PluginBlockReason = typeof PLUGIN_BLOCK_REASONS[number];

export type TargetSource = 'steam' | 'manual';
/** `adopted`: a file with the bundled hash that this application found in place (a manual copy, P12). */
export type InstallSource = TargetSource | 'adopted';
export type PendingOperation = 'install' | 'update' | 'remove';

export interface GameSetupRecord {readonly excluded: boolean; readonly manualRoot: string | null}
export interface InstallRecord {
  readonly game: PluginGame;
  readonly root: string;
  readonly source: InstallSource;
  readonly sha256: string;
  readonly appVersion: string;
  readonly installedUtc: string;
  /** This application created `bin\win_x64\plugins`; only then may a removal delete the folder, and only when empty. */
  readonly createdPluginsDirectory: boolean;
}
/** Written durably before the game folder is changed, cleared after the result is recorded (P8 steps 6 and 11). */
export interface PendingIntent {
  readonly op: PendingOperation;
  readonly game: PluginGame;
  readonly root: string;
  readonly source: TargetSource;
  /** The exact temporary file of an install or update; null for a removal. */
  readonly temp: string | null;
  readonly fromSha256: string | null;
  readonly toSha256: string | null;
  /** The version of `toSha256`; null for a removal. */
  readonly appVersion: string | null;
  readonly createdPluginsDirectory: boolean;
  readonly startedUtc: string;
}
/** The last failure of one game folder: one entry per game and root, so the targets of one game never share it. */
export interface FailureRecord {
  readonly game: PluginGame;
  readonly root: string;
  readonly code: PluginBlockReason;
  readonly step: string;
  readonly utc: string;
}
export interface PluginRegistryDocument {
  readonly format: typeof PLUGIN_REGISTRY_FORMAT;
  readonly version: typeof PLUGIN_REGISTRY_VERSION;
  readonly games: Readonly<Record<PluginGame, GameSetupRecord>>;
  readonly installs: readonly InstallRecord[];
  readonly pending: readonly PendingIntent[];
  readonly failures: readonly FailureRecord[];
}

export const EMPTY_PLUGIN_REGISTRY: PluginRegistryDocument = deepFreeze({
  format: PLUGIN_REGISTRY_FORMAT, version: PLUGIN_REGISTRY_VERSION,
  games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}},
  installs: [], pending: [], failures: []
});

const HASH = /^[0-9a-f]{64}$/;
const APP_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STEP = /^[a-z][a-z-]{0,31}$/;
/** The exact temporary file name an install or update writes beside the target (P8 step 3). */
export const PLUGIN_TEMP_FILE = pluginTempFilePattern();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Case-insensitive comparison of normalized Windows paths, as game roots are compared everywhere in plugin setup. */
export function sameRoot(left: string, right: string): boolean {
  const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
  return normal(left) === normal(right);
}

/** `<root>\bin\win_x64\plugins`, the only folder the installer writes into. */
export const pluginsDirectoryOf = (root: string) => path.win32.join(root, 'bin', 'win_x64', 'plugins');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
const isGame = (value: unknown): value is PluginGame => value === 'ets2' || value === 'ats';
const isRoot = (value: unknown): value is string => isDrivePath(value) && value.length <= MAX_ROOT_LENGTH && path.win32.normalize(value) === value;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const isVersion = (value: unknown): value is string => typeof value === 'string' && APP_VERSION.test(value);
const isUtc = (value: unknown): value is string => typeof value === 'string' && UTC.test(value) && !Number.isNaN(Date.parse(value));

const GAME_KEYS = ['excluded', 'manualRoot'];
const INSTALL_KEYS = ['game', 'root', 'source', 'sha256', 'appVersion', 'installedUtc', 'createdPluginsDirectory'];
const PENDING_KEYS = ['op', 'game', 'root', 'source', 'temp', 'fromSha256', 'toSha256', 'appVersion', 'createdPluginsDirectory', 'startedUtc'];
const FAILURE_KEYS = ['game', 'root', 'code', 'step', 'utc'];
const DOCUMENT_KEYS = ['format', 'version', 'games', 'installs', 'pending', 'failures'];

function validGames(value: unknown): value is Record<PluginGame, GameSetupRecord> {
  if (!exactKeys(value, PLUGIN_GAMES)) return false;
  return PLUGIN_GAMES.every(game => {
    const entry = value[game];
    return exactKeys(entry, GAME_KEYS) && typeof entry.excluded === 'boolean' && (entry.manualRoot === null || isRoot(entry.manualRoot));
  });
}
function validInstall(value: unknown): value is InstallRecord {
  return exactKeys(value, INSTALL_KEYS) && isGame(value.game) && isRoot(value.root) && (value.source === 'steam' || value.source === 'manual' || value.source === 'adopted')
    && isHash(value.sha256) && isVersion(value.appVersion) && isUtc(value.installedUtc) && typeof value.createdPluginsDirectory === 'boolean';
}
function validPending(value: unknown): value is PendingIntent {
  if (!exactKeys(value, PENDING_KEYS) || !isGame(value.game) || !isRoot(value.root) || (value.source !== 'steam' && value.source !== 'manual')) return false;
  if (typeof value.createdPluginsDirectory !== 'boolean' || !isUtc(value.startedUtc)) return false;
  if (value.op === 'remove') return value.temp === null && isHash(value.fromSha256) && value.toSha256 === null && value.appVersion === null;
  if (value.op !== 'install' && value.op !== 'update') return false;
  // The temporary file must be the exact name in this root's plugins folder, so recovery can never remove anything else.
  const temp = value.temp;
  if (typeof temp !== 'string' || !isDrivePath(temp) || !PLUGIN_TEMP_FILE.test(path.win32.basename(temp))
    || !sameRoot(path.win32.dirname(temp), pluginsDirectoryOf(value.root))) return false;
  const from = value.op === 'install' ? value.fromSha256 === null : isHash(value.fromSha256);
  return from && isHash(value.toSha256) && isVersion(value.appVersion);
}
function validFailure(value: unknown): value is FailureRecord {
  return exactKeys(value, FAILURE_KEYS) && isGame(value.game) && isRoot(value.root) && (PLUGIN_BLOCK_REASONS as readonly unknown[]).includes(value.code)
    && typeof value.step === 'string' && STEP.test(value.step) && isUtc(value.utc);
}
/** True when two records name the same game and root, compared case-insensitively. */
const sameFolder = (left: {game: PluginGame; root: string}, right: {game: PluginGame; root: string}) => left.game === right.game && sameRoot(left.root, right.root);
const unique = (records: readonly {game: PluginGame; root: string}[]) => records.every((record, index) => records.findIndex(other => sameFolder(other, record)) === index);

/**
 * The registry is written with `format` and `version` first. A file over the size bound is classified from its first
 * bytes only: one that starts like a later version of this format is `newer-version` and is never quarantined.
 */
const NEWER_PREFIX = /^\uFEFF?\s*\{\s*"format"\s*:\s*"ets2telemetry\.plugin-setup"\s*,\s*"version"\s*:\s*(\d{1,9})\s*[,}]/;
function oversized(bytes: Uint8Array): ParsedRegistry {
  const prefix = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  const version = NEWER_PREFIX.exec(prefix)?.[1];
  return version !== undefined && Number(version) > PLUGIN_REGISTRY_VERSION ? {state: 'newer-version'} : {state: 'invalid-file'};
}

export type ParsedRegistry = {readonly state: 'loaded'; readonly document: PluginRegistryDocument} | {readonly state: 'invalid-file' | 'newer-version'};

/**
 * Strict parsing: UTF-8 JSON (a leading byte order mark is accepted) of at most 256 KiB with exactly the v1 keys, at
 * most 16 installs, 16 pending intents and 16 failures, one install and one failure per game folder and valid values. The
 * same format with a higher integer version is `newer-version`, also for a file over the size bound whose first bytes
 * say so; anything else that is not a valid v1 document is `invalid-file`.
 */
export function parsePluginRegistry(bytes: Uint8Array): ParsedRegistry {
  if (bytes.byteLength > MAX_PLUGIN_REGISTRY_BYTES) return oversized(bytes);
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes);} catch {return {state: 'invalid-file'};}
  let value: unknown;
  try {value = JSON.parse(text);} catch {return {state: 'invalid-file'};}
  if (!isRecord(value) || value.format !== PLUGIN_REGISTRY_FORMAT) return {state: 'invalid-file'};
  if (Number.isSafeInteger(value.version) && (value.version as number) > PLUGIN_REGISTRY_VERSION) return {state: 'newer-version'};
  if (value.version !== PLUGIN_REGISTRY_VERSION || !exactKeys(value, DOCUMENT_KEYS) || !validGames(value.games)) return {state: 'invalid-file'};
  const {installs, pending, failures} = value;
  if (!Array.isArray(installs) || installs.length > MAX_INSTALL_RECORDS || !installs.every(validInstall) || !unique(installs)) return {state: 'invalid-file'};
  if (!Array.isArray(pending) || pending.length > MAX_PENDING_INTENTS || !pending.every(validPending)) return {state: 'invalid-file'};
  if (!Array.isArray(failures) || failures.length > MAX_FAILURE_RECORDS || !failures.every(validFailure) || !unique(failures)) return {state: 'invalid-file'};
  return {state: 'loaded', document: deepFreeze(canonical(value as unknown as PluginRegistryDocument))};
}

/** A copy with every key in the canonical order, so the bytes of a document never depend on how it was built. */
function canonical(document: PluginRegistryDocument): PluginRegistryDocument {
  const game = (entry: GameSetupRecord): GameSetupRecord => ({excluded: entry.excluded, manualRoot: entry.manualRoot});
  const failures = document.failures.map(entry => ({game: entry.game, root: entry.root, code: entry.code, step: entry.step, utc: entry.utc}));
  return {
    format: PLUGIN_REGISTRY_FORMAT, version: PLUGIN_REGISTRY_VERSION,
    games: {ets2: game(document.games.ets2), ats: game(document.games.ats)},
    installs: document.installs.map(record => ({game: record.game, root: record.root, source: record.source, sha256: record.sha256,
      appVersion: record.appVersion, installedUtc: record.installedUtc, createdPluginsDirectory: record.createdPluginsDirectory})),
    pending: document.pending.map(intent => ({op: intent.op, game: intent.game, root: intent.root, source: intent.source, temp: intent.temp,
      fromSha256: intent.fromSha256, toSha256: intent.toSha256, appVersion: intent.appVersion, createdPluginsDirectory: intent.createdPluginsDirectory,
      startedUtc: intent.startedUtc})),
    failures
  };
}

/** The exact file bytes: two-space JSON in the canonical key order with a final newline, UTF-8 without a BOM. */
export function serializePluginRegistry(document: PluginRegistryDocument): string {
  return `${JSON.stringify(canonical(document), null, 2)}\n`;
}

export type PluginRegistryState = 'empty' | 'loaded' | 'invalid-file' | 'newer-version' | 'unreadable' | 'unavailable';
const WRITABLE: readonly PluginRegistryState[] = ['empty', 'loaded', 'invalid-file'];

/** A refused or failed registry change; the in-memory document is unchanged. Never carries a path. */
export class PluginRegistryError extends Error {
  readonly code = 'REGISTRY_UNAVAILABLE';
  constructor(readonly step: string, readonly errno: string | null) {
    super(`Plugin registry unavailable at ${step}`);
    this.name = 'PluginRegistryError';
  }
}

export interface PluginRegistryOptions {
  fs?: AtomicFileSystem;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  log?: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
}

export class PluginRegistry {
  private current: PluginRegistryDocument = EMPTY_PLUGIN_REGISTRY;
  private registryState: PluginRegistryState = 'unavailable';
  private tail: Promise<unknown> = Promise.resolve();
  private readonly fs: AtomicFileSystem;
  private readonly now: () => Date;
  private readonly options: PluginRegistryOptions;

  private constructor(private readonly directory: string | undefined, options: PluginRegistryOptions) {
    this.fs = options.fs ?? nodeAtomicFs;
    this.now = options.now ?? (() => new Date());
    this.options = options;
  }

  /** Reads and classifies `<directory>\setup.json`; never creates, changes or removes anything. */
  static async load(directory: string | undefined, options: PluginRegistryOptions = {}): Promise<PluginRegistry> {
    const registry = new PluginRegistry(directory, options);
    if (!directory || !isDrivePath(directory)) return registry;
    const read = await readAtomicFile(registry.fs, directory, PLUGIN_REGISTRY_FILE, MAX_PLUGIN_REGISTRY_BYTES);
    if (read.state === 'absent') registry.registryState = 'empty';
    else if (read.state === 'unreadable') registry.registryState = 'unreadable';
    else {
      const parsed = parsePluginRegistry(read.bytes);
      registry.registryState = parsed.state;
      if (parsed.state === 'loaded') registry.current = parsed.document;
    }
    return registry;
  }

  get state(): PluginRegistryState {return this.registryState;}
  /** False for a newer version, an unreadable file or folder and a missing location: every change is refused. */
  get writable(): boolean {return WRITABLE.includes(this.registryState);}
  /** The document in use: the file's, or the empty registry for a missing or invalid file. Deeply frozen. */
  get document(): PluginRegistryDocument {return this.current;}

  /**
   * Serialized change. `change` receives the document in use when the write starts; the result is checked against the
   * v1 bounds, written atomically and applied in memory only after the rename. The first write after an invalid file
   * moves that file aside as `setup.rejected-<UTC>.json` and keeps the newest three. Throws PluginRegistryError.
   */
  update(change: (document: PluginRegistryDocument) => PluginRegistryDocument): Promise<PluginRegistryDocument> {
    const run = this.tail.then(() => this.write(change));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** The UTC timestamp format of every record, from the injected clock. */
  utc(): string {return this.now().toISOString();}

  private async write(change: (document: PluginRegistryDocument) => PluginRegistryDocument): Promise<PluginRegistryDocument> {
    if (!this.directory || !this.writable) throw new PluginRegistryError(this.registryState, null);
    const content = serializePluginRegistry(change(this.current));
    const parsed = parsePluginRegistry(Buffer.from(content, 'utf8'));
    if (parsed.state !== 'loaded') throw new PluginRegistryError('bounds', null);
    const quarantinePending = this.registryState === 'invalid-file';
    try {
      await writeAtomicFile(this.fs, this.directory, PLUGIN_REGISTRY_FILE, content, {
        delay: this.options.delay,
        ...(quarantinePending ? {quarantine: {prefix: PLUGIN_REGISTRY_QUARANTINE_PREFIX, keep: KEPT_REJECTED_REGISTRIES, now: this.now}} : {}),
        quarantined: () => this.options.log?.('PLUGIN_REGISTRY_QUARANTINED', undefined, {state: 'invalid-file'})
      });
    } catch (error) {
      if (error instanceof AtomicFileError) throw new PluginRegistryError(error.step, error.code);
      throw new PluginRegistryError('write', null);
    }
    this.current = parsed.document;
    this.registryState = 'loaded';
    return this.current;
  }
}

/** The install record of `game` in exactly this root, if any. */
export function installRecordFor(document: PluginRegistryDocument, game: PluginGame, root: string): InstallRecord | undefined {
  return document.installs.find(record => sameFolder(record, {game, root}));
}

/** The last failure recorded for `game` in exactly this root, if any. ET-017 PR-4 shows it as the target's last failure. */
export function failureFor(document: PluginRegistryDocument, game: PluginGame, root: string): FailureRecord | undefined {
  return document.failures.find(record => sameFolder(record, {game, root}));
}

/** The document with this folder's failure replaced; beyond the bound the oldest failures of other folders are dropped. */
export function withFailure(document: PluginRegistryDocument, failure: FailureRecord): PluginRegistryDocument {
  const others = document.failures.filter(record => !sameFolder(record, failure));
  const kept = [...others].sort((left, right) => left.utc < right.utc ? 1 : left.utc > right.utc ? -1 : 0).slice(0, MAX_FAILURE_RECORDS - 1);
  return {...document, failures: [...others.filter(record => kept.includes(record)), failure]};
}

/** The document without this folder's failure; another folder's failure is never touched. */
export function withoutFailure(document: PluginRegistryDocument, game: PluginGame, root: string): PluginRegistryDocument {
  return failureFor(document, game, root) ? {...document, failures: document.failures.filter(record => !sameFolder(record, {game, root}))} : document;
}

/** The target file of a root; the installer never names any other file in a game folder. */
export const pluginTargetOf = (root: string) => path.win32.join(pluginsDirectoryOf(root), PLUGIN_FILE_NAME);
