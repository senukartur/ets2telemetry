import {randomUUID} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {AppLanguage, OverlayLayout, OverlayPlacement, OverlaySections, SettingsSaveError, SettingsState, SettingsView, UnitGame, UnitProfile} from '../../../packages/contracts/src';
import {withPlacement} from './overlay-placement';
import {enabledSectionCount} from './overlay-sections';
import type {DiagnosticFacts} from './diagnostics';
import {dataPaths} from './paths';
import {DEFAULT_SETTINGS, MAX_SETTINGS_BYTES, parseSettings, serializeSettings, type Settings} from './settings-schema';

// Persistent settings in %LOCALAPPDATA%\ETS2Telemetry\settings\settings.json (docs/settings.md). Main owns the only
// instance. Loading never writes; a change is applied in memory only after its atomic write and rename succeeded.

export const SETTINGS_FILE = 'settings.json';
/** `load()` returns within this budget; a read still pending then continues in the `loading` state. */
export const SETTINGS_LOAD_BUDGET_MS = 1000;
/**
 * From the start of loading: a read that has not settled by then is treated as hung. The session stays `unreadable`
 * and the read's later result is ignored. A bounded read of a file of at most 64 KiB that takes this long is not
 * CPU starvation (in hosted run 38755116140 both windows had loaded about 6 s after start) but a stuck file system.
 */
export const SETTINGS_READ_LIMIT_MS = 30_000;
/** Delays before each retry of the final rename; five retries within 300 ms. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([20, 40, 60, 80, 100]);
/** Outstanding writes, including the one in progress; further requests are refused at once. */
export const MAX_PENDING_SETTINGS_WRITES = 4;
export const KEPT_QUARANTINE_FILES = 3;
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TEMPORARY_FILE = /^settings\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
const QUARANTINE_FILE = /^settings\.rejected-(\d{8}T\d{6}Z)(?:-(\d+))?\.json$/;

export type SettingsErrorCode = SettingsSaveError;
/** A rejected save with a fixed settings error code; it never carries a path. */
export class SettingsError extends Error {
  constructor(readonly code: SettingsErrorCode) {super(code === 'SETTINGS_READ_ONLY' ? 'Settings are read-only' : 'Settings could not be saved'); this.name = 'SettingsError';}
}
/** A request refused because too many saves are outstanding; the settings view is unchanged. */
export class SettingsBusyError extends Error {
  constructor() {super('Settings request limit exceeded'); this.name = 'SettingsBusyError';}
}

interface Stats {isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; size: number}
interface FileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The file operations the store uses; tests wrap the real ones to inject failures. */
export interface SettingsFileSystem {
  lstat(target: string): Promise<Stats>;
  open(target: string, flags: 'r' | 'wx'): Promise<FileHandle>;
  mkdir(target: string, options: {recursive: true}): Promise<unknown>;
  readdir(target: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}
export interface SettingsTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface SettingsStoreOptions {
  log?: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
  fs?: SettingsFileSystem;
  timers?: SettingsTimers;
  /** Waits between rename retries. */
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  /**
   * Called once when a read that outlasted the load budget is applied: its own result, or `unreadable` at the read
   * limit. Never called for a load that finished within the budget, or for a save.
   */
  changed?: () => void;
}
const systemTimers: SettingsTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** The settings directory, or undefined when LOCALAPPDATA is missing or not absolute. */
export function settingsDirectory(localAppData: string | undefined): string | undefined {
  if (!localAppData) return undefined;
  try {return dataPaths(localAppData).settings;} catch {return undefined;}
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const READ_ONLY_STATES: readonly SettingsState[] = ['loading', 'newer-version', 'unreadable', 'unavailable'];
const QUARANTINED_STATES: readonly SettingsState[] = ['invalid-file', 'unsupported-older'];
type Loaded = {state: SettingsState; settings: Settings; facts?: DiagnosticFacts};

export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private state: SettingsState = 'loading';
  private quarantinePending = false;
  private loadSettled = false;
  private saveError: SettingsSaveError | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly fs: SettingsFileSystem;
  private readonly timers: SettingsTimers;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly log: NonNullable<SettingsStoreOptions['log']>;
  private readonly changed: () => void;
  constructor(private readonly directory: string | undefined, options: SettingsStoreOptions = {}) {
    this.fs = options.fs ?? nodeFs;
    this.timers = options.timers ?? systemTimers;
    this.delay = options.delay ?? (milliseconds => new Promise(resolve => this.timers.setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.changed = options.changed ?? (() => undefined);
  }

  /** True once `load()` has returned: with the read's result, or with the pending `loading` state after the budget. */
  get settled(): boolean {return this.loadSettled;}

  view(): SettingsView {
    return {language: this.settings.language, units: this.settings.units, overlay: this.settings.overlay, state: this.state, writable: !READ_ONLY_STATES.includes(this.state), saveError: this.saveError};
  }

  /**
   * Reads and classifies the file; never creates, changes or removes anything. Returns within 1000 ms: with the read's
   * result, or with the read-only `loading` state while the read continues. That same read is applied when it settles
   * (reported through `changed`), unless the 30 s read limit made the session `unreadable` first.
   */
  load(): Promise<SettingsView> {
    let phase: 'budget' | 'late' | 'done' = 'budget', budget: unknown, limit: unknown;
    let returned!: (view: SettingsView) => void, applied!: () => void;
    const result = new Promise<SettingsView>(resolve => {returned = resolve;});
    // Saves requested before load() returned queue until the read is applied or declared hung. Later saves meet the
    // loading state and are refused at once, so neither they nor the exit wait for a pending read.
    this.tail = new Promise<void>(resolve => {applied = resolve;});
    const apply = (loaded: Loaded) => {
      const late = phase === 'late';
      phase = 'done';
      this.settings = loaded.settings; this.state = loaded.state;
      this.quarantinePending = QUARANTINED_STATES.includes(loaded.state);
      this.loadSettled = true;
      // Neither event name may look like a failure: a fallback is a supported outcome, not an error.
      this.log(loaded.state === 'defaults' || loaded.state === 'loaded' ? 'SETTINGS_LOADED' : 'SETTINGS_FALLBACK', undefined, {state: loaded.state, ...loaded.facts});
      applied();
      if (late) this.changed(); else returned(this.view());
    };
    void this.classify().catch((): Loaded => ({state: 'unreadable', settings: DEFAULT_SETTINGS, facts: {reason: 'read'}})).then(loaded => {
      // A read that settles after the read limit is ignored: the session already reported it as unreadable.
      if (phase === 'done') return;
      this.timers.clearTimeout(phase === 'budget' ? budget : limit);
      apply(loaded);
    });
    budget = this.timers.setTimeout(() => {
      if (phase !== 'budget') return;
      phase = 'late'; this.loadSettled = true;
      this.log('SETTINGS_LOAD_PENDING', undefined, {state: 'loading', reason: 'load-budget'});
      limit = this.timers.setTimeout(() => {if (phase === 'late') apply({state: 'unreadable', settings: DEFAULT_SETTINGS, facts: {reason: 'load-limit'}});},
        SETTINGS_READ_LIMIT_MS - SETTINGS_LOAD_BUDGET_MS);
      returned(this.view());
    }, SETTINGS_LOAD_BUDGET_MS);
    return result;
  }

  /** Serialized save of the user interface language (ET-029). */
  setLanguage(language: AppLanguage): Promise<SettingsView> {
    return this.enqueue(settings => ({next: {...settings, language}, facts: {language}}));
  }

  /** Serialized save of one game's profile. Resolves with the applied settings only after the durable rename. */
  setUnitProfile(game: UnitGame, profile: UnitProfile): Promise<SettingsView> {
    return this.enqueue(settings => ({next: {...settings, units: Object.freeze({...settings.units, [game]: profile})}, facts: {game, profile}}));
  }

  /** Serialized save of the overlay layout; the sections and units stay as they are at the time of the write. */
  setOverlayLayout(layout: OverlayLayout): Promise<SettingsView> {
    return this.enqueue(settings => ({next: {...settings, overlay: Object.freeze({...settings.overlay, layout})}, facts: {overlayLayout: layout}}));
  }

  /** Serialized save of a complete, already validated section record (main checks it with `parseOverlaySections`). */
  setOverlaySections(sections: OverlaySections): Promise<SettingsView> {
    const copy: OverlaySections = Object.freeze({...sections});
    return this.enqueue(settings => ({next: {...settings, overlay: Object.freeze({...settings.overlay, sections: copy})},
      facts: {overlaySections: enabledSectionCount(copy)}}));
  }

  /**
   * Serialized save of one layout's placement from the overlay edit mode (ET-012b), already validated by main. Only that
   * layout's placement changes, normalised to four decimals for x and y and two for the scale; the facts name the layout
   * and the scale, never a position.
   */
  setOverlayPlacement(layout: OverlayLayout, placement: OverlayPlacement): Promise<SettingsView> {
    return this.enqueue(settings => {
      const placements = withPlacement(settings.overlay.placements, layout, placement);
      return {next: {...settings, overlay: Object.freeze({...settings.overlay, placements})}, facts: {overlayPlacement: layout, overlayScale: placements[layout].scale}};
    });
  }

  /**
   * Queues one save. Every kind of change shares the queue and its four-request bound, and each computes its new
   * settings from those that apply when its write starts, so a unit save and an overlay save never undo each other.
   */
  private async enqueue(change: (settings: Settings) => {next: Settings; facts: DiagnosticFacts}): Promise<SettingsView> {
    // Once load() returned, a read-only state, including a pending read, is refused at once instead of queuing.
    if (this.loadSettled && READ_ONLY_STATES.includes(this.state)) throw this.refusal();
    if (this.pending >= MAX_PENDING_SETTINGS_WRITES) throw new SettingsBusyError();
    this.pending++;
    const run = this.tail.then(() => this.save(change));
    this.tail = run.catch(() => undefined);
    try {return await run;} finally {this.pending--;}
  }

  /** Settles when every queued save has finished; undefined when none is outstanding. */
  idle(): Promise<void> | undefined {
    return this.pending > 0 ? this.tail.then(() => undefined) : undefined;
  }

  private async classify(): Promise<Loaded> {
    if (!this.directory) return {state: 'unavailable', settings: DEFAULT_SETTINGS};
    const directory = await this.inspect(this.directory, 'directory');
    if (directory !== 'present') return directory === 'absent' ? {state: 'defaults', settings: DEFAULT_SETTINGS} : {state: 'unreadable', settings: DEFAULT_SETTINGS, facts: {reason: directory}};
    const file = path.join(this.directory, SETTINGS_FILE);
    const entry = await this.inspect(file, 'file');
    if (entry === 'absent') return {state: 'defaults', settings: DEFAULT_SETTINGS};
    if (entry !== 'present') return {state: 'unreadable', settings: DEFAULT_SETTINGS, facts: {reason: entry}};
    let bytes: Uint8Array;
    try {bytes = await this.readBounded(file);} catch {return {state: 'unreadable', settings: DEFAULT_SETTINGS, facts: {reason: 'read'}};}
    const parsed = parseSettings(bytes);
    // A migrated older file is reported as such; it stays unchanged on disk until the first save writes the current format.
    const migrated = parsed.state === 'loaded' || parsed.state === 'loaded-with-fallbacks' ? parsed.migratedFrom : undefined;
    const migration: DiagnosticFacts = migrated === undefined ? {} : {migratedFrom: migrated};
    if (parsed.state === 'loaded') return {state: 'loaded', settings: parsed.settings, ...(migrated === undefined ? {} : {facts: migration})};
    if (parsed.state === 'loaded-with-fallbacks') return {state: parsed.state, settings: parsed.settings, facts: {fields: parsed.fallbackFields.join(','), ...migration}};
    return {state: parsed.state, settings: DEFAULT_SETTINGS};
  }

  /** lstat without following links: a symbolic link or junction is refused, never read or written through. */
  private async inspect(target: string, kind: 'file' | 'directory'): Promise<'present' | 'absent' | 'reparse-point' | 'not-file' | 'not-directory' | 'stat'> {
    try {
      const stats = await this.fs.lstat(target);
      if (stats.isSymbolicLink()) return 'reparse-point';
      if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return kind === 'file' ? 'not-file' : 'not-directory';
      return 'present';
    } catch (error) {return errorCode(error) === 'ENOENT' ? 'absent' : 'stat';}
  }

  /** Reads at most one byte beyond the size cap, so an oversized file is classified without reading it all. */
  private async readBounded(file: string): Promise<Uint8Array> {
    const handle = await this.fs.open(file, 'r');
    try {
      const buffer = new Uint8Array(MAX_SETTINGS_BYTES + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const {bytesRead} = await handle.read(buffer, length, buffer.byteLength - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } finally {await handle.close();}
  }

  /** The refusal for a read-only state: `SETTINGS_READ_ONLY` for a newer version, otherwise `SETTINGS_WRITE_FAILED`. */
  private refusal(): SettingsError {
    if (this.state === 'newer-version') this.log('SETTINGS_SAVE_REFUSED', undefined, {state: this.state});
    else this.log('SETTINGS_WRITE_FAILED', undefined, {step: 'unavailable', state: this.state});
    this.saveError = this.state === 'newer-version' ? 'SETTINGS_READ_ONLY' : 'SETTINGS_WRITE_FAILED';
    return new SettingsError(this.saveError);
  }

  private async save(change: (settings: Settings) => {next: Settings; facts: DiagnosticFacts}): Promise<SettingsView> {
    const directory = this.directory;
    // A save queued before load() returned meets the applied state here, or `unreadable` at the read limit.
    if (!directory || READ_ONLY_STATES.includes(this.state)) throw this.refusal();
    const {next, facts} = change(this.settings);
    const target = path.join(directory, SETTINGS_FILE);
    let temporary: string | undefined;
    let step = 'directory';
    try {
      await this.fs.mkdir(directory, {recursive: true});
      if (await this.inspect(directory, 'directory') !== 'present') throw new Error('Settings directory is not a plain directory');
      step = 'cleanup';
      await this.removeStaleTemporaries(directory);
      step = 'target';
      const existing = await this.inspect(target, 'file');
      if (existing !== 'present' && existing !== 'absent') throw new Error('Settings file is not a plain file');
      if (this.quarantinePending) {
        step = 'quarantine';
        if (existing === 'present') await this.quarantine(directory, target);
        this.quarantinePending = false;
      }
      step = 'temporary';
      temporary = path.join(directory, `${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await this.fs.open(temporary, 'wx');
      try {
        await handle.writeFile(serializeSettings(next), 'utf8');
        await handle.sync();
      } finally {await handle.close();}
      step = 'rename';
      await this.renameWithRetry(temporary, target);
      temporary = undefined;
    } catch (error) {
      if (temporary) await this.fs.unlink(temporary).catch(() => undefined);
      this.log('SETTINGS_WRITE_FAILED', error, {step, code: errorCode(error) ?? null});
      this.saveError = 'SETTINGS_WRITE_FAILED';
      throw new SettingsError('SETTINGS_WRITE_FAILED');
    }
    this.settings = next; this.state = 'loaded'; this.saveError = null;
    this.log('SETTINGS_SAVED', undefined, facts);
    return this.view();
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {await this.fs.rename(from, to); return;}
      catch (error) {
        // Antivirus scanners and indexers briefly hold new files open on Windows.
        const code = errorCode(error);
        if (attempt >= RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME.has(code)) throw error;
        await this.delay(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /** Only temporaries left by an interrupted earlier save; saves are serialized and the application is single-instance. */
  private async removeStaleTemporaries(directory: string): Promise<void> {
    for (const name of await this.fs.readdir(directory)) {
      if (TEMPORARY_FILE.test(name)) await this.fs.unlink(path.join(directory, name)).catch(() => undefined);
    }
  }

  /** Renames the rejected file byte-identically beside the new one and keeps the newest three such files. */
  private async quarantine(directory: string, target: string): Promise<void> {
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    let name: string | undefined;
    for (let suffix = 1; suffix <= 100 && !name; suffix++) {
      const candidate = `settings.rejected-${stamp}${suffix === 1 ? '' : `-${suffix}`}.json`;
      if (await this.inspect(path.join(directory, candidate), 'file') === 'absent') name = candidate;
    }
    if (!name) throw new Error('No free quarantine name');
    await this.renameWithRetry(target, path.join(directory, name));
    this.log('SETTINGS_QUARANTINED', undefined, {state: this.state});
    const rejected = (await this.fs.readdir(directory)).flatMap(file => {
      const match = QUARANTINE_FILE.exec(file);
      return match ? [{file, stamp: match[1], suffix: match[2] ? Number(match[2]) : 1}] : [];
    }).sort((left, right) => left.stamp === right.stamp ? right.suffix - left.suffix : left.stamp < right.stamp ? 1 : -1);
    for (const old of rejected.slice(KEPT_QUARANTINE_FILES)) await this.fs.unlink(path.join(directory, old.file)).catch(() => undefined);
  }
}
