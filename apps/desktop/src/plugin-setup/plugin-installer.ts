import {createHash, randomBytes} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {DiagnosticFacts} from '../diagnostics';
import {blockingProcess, type RunningGames} from './game-processes';
import {failureFor, installRecordFor, MAX_INSTALL_RECORDS, PLUGIN_TEMP_FILE, pluginsDirectoryOf, sameRoot, withFailure, withoutFailure, type FailureRecord,
  type InstallRecord, type PendingIntent, type PluginBlockReason, type PluginRegistry, type TargetSource} from './plugin-registry';
import {PLUGIN_FILE_NAME, validateGameLayout, type PluginGame} from './steam-discovery';

export {PLUGIN_BLOCK_REASONS, type PluginBlockReason} from './plugin-registry';

// Installs, updates and removes this application's own plugin DLL in one game folder at a time (ET-017 P6, P7, P8;
// docs/plugin-setup.md, "Algorithm"). Each change runs only after a fresh running-game check, never replaces or
// removes a file whose hash it does not recognize, writes a durable pending intent into the install registry before
// it touches the game folder, and replaces the target by renaming a verified temporary file over it. The installer
// receives the verified bundle bytes from its caller and never reads the bundle itself; ET-017 PR-4 wires it into main.
// Documented gap: another process of the same user could swap the target, or a folder above it, between the
// classification (step 4) and the rename (step 9).

/** Largest target that can be the plugin; anything bigger is UNRECOGNIZED_FILE without being read (P6). */
export const MAX_PLUGIN_FILE_BYTES = 16 * 1024 * 1024;
/** Delays before each retry of the target rename or unlink on EBUSY (a sharing lock); five retries within 300 ms. */
export const TARGET_RETRY_DELAYS_MS: readonly number[] = Object.freeze([20, 40, 60, 80, 100]);

export type InstallStep = 'process' | 'registry' | 'recover' | 'layout' | 'cleanup' | 'classify' | 'read-only' | 'pending' | 'directory'
  | 'temp' | 'verify' | 'rename' | 'rehash' | 'unlink' | 'record';

export interface InstallerStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}
export interface InstallerHandle {
  stat(options: {bigint: true}): Promise<InstallerStats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesRead: number}>;
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{bytesWritten: number}>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The file operations the installer uses on a game folder; `node:fs/promises` satisfies it. */
export interface InstallerFileSystem {
  lstat(target: string, options: {bigint: true}): Promise<InstallerStats>;
  stat(target: string, options: {bigint: true}): Promise<InstallerStats>;
  realpath(target: string): Promise<string>;
  open(target: string, flags: 'r' | 'wx'): Promise<InstallerHandle>;
  /** Never recursive: only the plugins folder itself is ever created. */
  mkdir(target: string): Promise<unknown>;
  rmdir(target: string): Promise<void>;
  readdir(target: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}
export const nodeInstallerFs: InstallerFileSystem = nodeFs;

/** The verified bundle: bytes already read and hashed by the caller, never re-read from disk (P5). */
export interface VerifiedPluginBundle {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly appVersion: string;
  /** Hashes earlier released versions shipped; a target with one of them is owned (P6). */
  readonly known: readonly {readonly appVersion: string; readonly sha256: string}[];
}
export interface PluginTarget {readonly game: PluginGame; readonly source: TargetSource; readonly root: string}
export type RunningCheck = (signal?: AbortSignal) => Promise<{readonly ok: true; readonly running: RunningGames} | {readonly ok: false; readonly code: 'RUNNING_CHECK_FAILED'}>;

export interface PluginInstallerPorts {
  fs?: InstallerFileSystem;
  registry: PluginRegistry;
  /** The running-game check (game-processes.ts `checkRunningGames` in production), run before every change. */
  checkRunning: RunningCheck;
  delay?: (milliseconds: number) => Promise<void>;
  /** 16 lowercase hex digits for the temporary file name. */
  randomHex?: () => string;
  log?: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
  signal?: AbortSignal;
}

export type PluginOperation = 'install' | 'remove';
export type PluginOutcome = 'installed' | 'updated' | 'unchanged' | 'adopted' | 'removed' | 'absent' | 'blocked';
export interface PluginActionResult {
  readonly op: PluginOperation;
  readonly outcome: PluginOutcome;
  readonly reason: PluginBlockReason | null;
  readonly step: InstallStep | null;
  /** The error code of the failing file operation, for the PLUGIN_ACTION log line; never a path. */
  readonly errno: string | null;
  /** A fresh install found the game running afterwards: it loads the plugin after a restart (P7). */
  readonly loadsAfterRestart: boolean;
}
export interface RecoveryResult {readonly recovered: number; readonly remaining: number; readonly reason: PluginBlockReason | null}

/** What is in a target folder now (P6), from reading only. */
export type TargetInspection =
  | {readonly state: 'missing'}
  | {readonly state: 'owned'; readonly sha256: string; readonly version: string | null; readonly current: boolean}
  | {readonly state: 'blocked'; readonly reason: PluginBlockReason; readonly step: InstallStep; readonly errno: string | null};

const defaultDelay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A failed step with its block reason; thrown inside an operation and turned into its result. */
class StepFailure extends Error {
  constructor(readonly reason: PluginBlockReason, readonly step: InstallStep, readonly errno: string | null) {super(reason);}
}

type ErrorKind = 'default' | 'target-read' | 'target-replace';
/**
 * Maps an errno to a block reason (P8, P16). Creating, writing and verifying the temporary file: EACCES, EPERM and
 * EROFS are PERMISSION_DENIED, ENOSPC is DISK_FULL, anything else IO_ERROR. Reading the target adds EBUSY (a sharing
 * lock) as TARGET_LOCKED. Replacing or removing the target maps EPERM to TARGET_LOCKED: Windows refuses to replace or
 * delete a DLL a running process has mapped, and that is never retried.
 */
export function blockReasonFor(code: string | null, kind: ErrorKind): PluginBlockReason {
  if (kind !== 'default' && code === 'EBUSY') return 'TARGET_LOCKED';
  if (kind === 'target-replace' && code === 'EPERM') return 'TARGET_LOCKED';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'PERMISSION_DENIED';
  if (code === 'ENOSPC') return 'DISK_FULL';
  return 'IO_ERROR';
}

export type HashedFile = {readonly ok: true; readonly sha256: string; readonly mode: bigint} | {readonly ok: false; readonly kind: 'missing' | 'not-file' | 'too-large' | 'error'; readonly errno: string | null};

/**
 * Reads a regular, non-link file of at most 16 MiB through one handle and hashes it. The handle must still be the file
 * lstat saw. Shared with the ET-018 uninstall cleanup (apps/desktop/src/uninstall/plugin-cleanup.ts).
 */
export async function hashPluginFile(fs: InstallerFileSystem, target: string): Promise<HashedFile> {
  let before: InstallerStats;
  try {before = await fs.lstat(target, {bigint: true});} catch (error) {
    const code = errorCode(error);
    return {ok: false, kind: code === 'ENOENT' ? 'missing' : 'error', errno: code};
  }
  if (before.isSymbolicLink() || !before.isFile()) return {ok: false, kind: 'not-file', errno: null};
  if (before.size > BigInt(MAX_PLUGIN_FILE_BYTES)) return {ok: false, kind: 'too-large', errno: null};
  let handle: InstallerHandle;
  try {handle = await fs.open(target, 'r');} catch (error) {return {ok: false, kind: 'error', errno: errorCode(error)};}
  try {
    const held = await handle.stat({bigint: true});
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino) return {ok: false, kind: 'not-file', errno: null};
    const hash = createHash('sha256'), chunk = new Uint8Array(64 * 1024);
    let length = 0;
    while (true) {
      const {bytesRead} = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_PLUGIN_FILE_BYTES) return {ok: false, kind: 'too-large', errno: null};
      hash.update(chunk.subarray(0, bytesRead));
    }
    return {ok: true, sha256: hash.digest('hex'), mode: held.mode};
  } catch (error) {return {ok: false, kind: 'error', errno: errorCode(error)};}
  finally {await handle.close().catch(() => undefined);}
}

/** Removes a plugins folder only when it is a plain, empty folder; any failure leaves it. Shared with the uninstall cleanup. */
export async function removeEmptyPluginsDirectory(fs: InstallerFileSystem, directory: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(directory, {bigint: true});
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await fs.readdir(directory)).length) return false;
    await fs.rmdir(directory);
    return true;
  } catch {return false;}
}

export class PluginInstaller {
  private readonly fs: InstallerFileSystem;
  private readonly registry: PluginRegistry;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly randomHex: () => string;
  private readonly log: NonNullable<PluginInstallerPorts['log']>;

  constructor(private readonly bundle: VerifiedPluginBundle, private readonly ports: PluginInstallerPorts) {
    if (sha256(bundle.bytes) !== bundle.sha256) throw new Error('Plugin bundle bytes differ from their hash');
    this.fs = ports.fs ?? nodeInstallerFs;
    this.registry = ports.registry;
    this.delay = ports.delay ?? defaultDelay;
    this.randomHex = ports.randomHex ?? (() => randomBytes(8).toString('hex'));
    this.log = ports.log ?? (() => undefined);
  }

  /** The bundled, a known or this root's registry hash owns a file; anything else is unrecognized (P6). */
  private owner(game: PluginGame, root: string, hash: string): {version: string | null} | undefined {
    if (hash === this.bundle.sha256) return {version: this.bundle.appVersion};
    const known = this.bundle.known.find(entry => entry.sha256 === hash);
    if (known) return {version: known.appVersion};
    const record = installRecordFor(this.registry.document, game, root);
    return record && record.sha256 === hash ? {version: record.appVersion} : undefined;
  }

  /** Reads a regular, non-link file of at most 16 MiB through one handle and hashes it. */
  private hashFile(target: string): Promise<HashedFile> {return hashPluginFile(this.fs, target);}

  /** P7: the game itself or a TruckersMP client blocks every change; a failed check changes nothing. */
  private async processBlock(game: PluginGame): Promise<StepFailure | {running: RunningGames}> {
    let check: Awaited<ReturnType<RunningCheck>>;
    try {check = await this.ports.checkRunning(this.ports.signal);} catch {return new StepFailure('RUNNING_CHECK_FAILED', 'process', null);}
    if (!check.ok) return new StepFailure('RUNNING_CHECK_FAILED', 'process', null);
    const blocking = blockingProcess(game, check.running);
    return blocking ? new StepFailure(blocking, 'process', null) : {running: check.running};
  }

  /** Classifies the target without changing anything (P6). */
  async inspect(target: PluginTarget): Promise<TargetInspection> {
    try {
      const layout = await this.layout(target);
      const found = await this.classify(target, layout.target, layout.targetExists);
      return found.state === 'owned' ? {state: 'owned', sha256: found.sha256, version: found.version, current: found.current} : found;
    } catch (error) {
      if (error instanceof StepFailure) return {state: 'blocked', reason: error.reason, step: error.step, errno: error.errno};
      throw error;
    }
  }

  private async layout(target: PluginTarget) {
    const layout = await validateGameLayout(this.fs, target.root, target.game);
    if (layout.status === 'not-game') throw new StepFailure('IO_ERROR', 'layout', null);
    if (layout.status === 'linked') throw new StepFailure('LINKED_FOLDER', 'layout', null);
    if (layout.status === 'unexpected-entry') throw new StepFailure('UNRECOGNIZED_FILE', 'layout', null);
    return layout;
  }

  private async classify(target: PluginTarget, file: string, exists: boolean): Promise<TargetInspection & {mode?: bigint}> {
    if (!exists) return {state: 'missing'};
    const hashed = await this.hashFile(file);
    if (!hashed.ok) {
      if (hashed.kind === 'missing') return {state: 'missing'};
      if (hashed.kind === 'error') throw new StepFailure(blockReasonFor(hashed.errno, 'target-read'), 'classify', hashed.errno);
      throw new StepFailure('UNRECOGNIZED_FILE', 'classify', null);
    }
    const owner = this.owner(target.game, target.root, hashed.sha256);
    if (!owner) throw new StepFailure('UNRECOGNIZED_FILE', 'classify', null);
    return {state: 'owned', sha256: hashed.sha256, version: owner.version, current: hashed.sha256 === this.bundle.sha256, mode: hashed.mode};
  }

  /** Removes only regular files with the exact temporary name of an install (P8 step 3). */
  private async removeStaleTemporaries(directory: string): Promise<void> {
    let names: string[];
    try {names = await this.fs.readdir(directory);} catch (error) {
      throw new StepFailure(blockReasonFor(errorCode(error), 'default'), 'cleanup', errorCode(error));
    }
    for (const name of names) {
      if (!PLUGIN_TEMP_FILE.test(name)) continue;
      const temp = path.win32.join(directory, name);
      try {
        const stats = await this.fs.lstat(temp, {bigint: true});
        if (stats.isFile() && !stats.isSymbolicLink()) await this.fs.unlink(temp);
      } catch {/* one that cannot be removed now is removed by a later run */}
    }
  }

  private result(op: PluginOperation, outcome: PluginOutcome, loadsAfterRestart = false): PluginActionResult {
    return {op, outcome, reason: null, step: null, errno: null, loadsAfterRestart};
  }
  private blocked(op: PluginOperation, failure: StepFailure): PluginActionResult {
    return {op, outcome: 'blocked', reason: failure.reason, step: failure.step, errno: failure.errno, loadsAfterRestart: false};
  }

  /** Checks shared by every change: the running games, a writable registry and recovery of this folder's intents. */
  private async preflight(target: PluginTarget): Promise<StepFailure | undefined> {
    const running = await this.processBlock(target.game);
    if (running instanceof StepFailure) return running;
    if (!this.registry.writable) return new StepFailure('REGISTRY_UNAVAILABLE', 'registry', null);
    const own = this.registry.document.pending.filter(intent => intent.game === target.game && sameRoot(intent.root, target.root));
    if (own.length) {
      const recovered = await this.recoverIntents(own);
      if (recovered.reason) return new StepFailure(recovered.reason, 'recover', null);
    }
    return undefined;
  }

  /**
   * Records this folder's failure for the card and clears a finished intent, best effort: a registry that cannot be
   * written keeps its previous state, and the intent then stays for recovery. A failure repeated before any intent
   * was written does not rewrite the file. Failures are kept per game folder, so another root's failure is never
   * replaced or cleared.
   */
  private async recordFailure(target: PluginTarget, failure: StepFailure, cleared: PendingIntent | undefined, force: boolean): Promise<void> {
    const previous = failureFor(this.registry.document, target.game, target.root);
    if (!force && !cleared && previous?.code === failure.reason && previous.step === failure.step) return;
    const entry: FailureRecord = {game: target.game, root: target.root, code: failure.reason, step: failure.step, utc: this.registry.utc()};
    await this.registry.update(document => withFailure({
      ...document, pending: cleared ? document.pending.filter(other => !samePending(other, cleared)) : document.pending
    }, entry)).catch(() => undefined);
  }

  /** True when recording a new folder would exceed the 16-install bound: such an install or adoption is refused up front. */
  private installsFull(target: PluginTarget): boolean {
    return !installRecordFor(this.registry.document, target.game, target.root) && this.registry.document.installs.length >= MAX_INSTALL_RECORDS;
  }

  /**
   * Makes the target hold the bundled plugin (P8): installs it when missing, updates an owned older file, does nothing
   * for an owned current file (recording a manual copy as `adopted`), and never touches an unrecognized file.
   */
  async ensureInstalled(target: PluginTarget): Promise<PluginActionResult> {
    const refused = await this.preflight(target);
    if (refused) return this.blocked('install', refused);
    let intent: PendingIntent | undefined;
    let temp: string | undefined, tempCreated = false, renamed = false, createdDirectory = false;
    let failure: StepFailure | undefined;
    // A folder without a record whose result could not be recorded would leave an orphaned DLL: refuse it before
    // anything in the game folder changes.
    if (this.installsFull(target)) return this.blocked('install', new StepFailure('REGISTRY_UNAVAILABLE', 'pending', null));
    try {
      // Step 2: the layout, without following any link below the root.
      const layout = await this.layout(target);
      const directory = layout.pluginsDirectory, file = layout.target;
      // Step 3: only the exact temporary names of an earlier interrupted install.
      if (layout.pluginsExists) await this.removeStaleTemporaries(directory);
      // Step 4: classify; an unrecognized file stops here.
      const found = await this.classify(target, file, layout.targetExists);
      if (found.state === 'blocked') throw new StepFailure(found.reason, found.step, found.errno);
      const record = installRecordFor(this.registry.document, target.game, target.root);
      if (found.state === 'owned' && found.current) return await this.keepCurrent(target, record);
      // Step 5: a read-only target is refused, and its attribute is never cleared.
      if (found.state === 'owned' && found.mode !== undefined && (found.mode & 0o200n) === 0n) throw new StepFailure('READ_ONLY_FILE', 'read-only', null);
      // Step 6: the durable intent, before anything in the game folder changes. A missing plugins folder is created only
      // after it, so the intent already says whether this run created the folder.
      temp = path.win32.join(directory, `${PLUGIN_FILE_NAME}.${this.temporaryHex()}.tmp`);
      const fromSha256 = found.state === 'owned' ? found.sha256 : null;
      let pending: PendingIntent = {op: fromSha256 ? 'update' : 'install', game: target.game, root: target.root, source: target.source, temp,
        fromSha256, toSha256: this.bundle.sha256, appVersion: this.bundle.appVersion, createdPluginsDirectory: !layout.pluginsExists,
        startedUtc: this.registry.utc()};
      try {await this.registry.update(document => ({...document, pending: [...document.pending, pending]}));} catch (error) {
        temp = undefined;
        throw new StepFailure('REGISTRY_UNAVAILABLE', 'pending', registryErrno(error));
      }
      intent = pending;
      if (!layout.pluginsExists) {
        let existed = false;
        try {await this.fs.mkdir(directory); createdDirectory = true;} catch (error) {
          if (errorCode(error) !== 'EEXIST') throw new StepFailure(blockReasonFor(errorCode(error), 'default'), 'directory', errorCode(error));
          existed = true;
        }
        const stats = await this.fs.lstat(directory, {bigint: true}).catch(() => undefined);
        if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) throw new StepFailure(stats?.isSymbolicLink() ? 'LINKED_FOLDER' : 'UNRECOGNIZED_FILE', 'directory', null);
        if (existed) {
          // Another process created the folder meanwhile: the durable intent must not claim it, or recovery could
          // remove a folder this application did not create.
          const corrected: PendingIntent = {...pending, createdPluginsDirectory: false};
          const previous = pending;
          try {await this.registry.update(document => ({...document, pending: document.pending.map(other => samePending(other, previous) ? corrected : other)}));} catch (error) {
            throw new StepFailure('REGISTRY_UNAVAILABLE', 'directory', registryErrno(error));
          }
          pending = corrected;
          intent = corrected;
        }
      }
      // Step 7: a new temporary file with the verified bytes, synced and closed.
      await this.writeTemporary(temp, () => {tempCreated = true;});
      // Step 8: read the temporary file back.
      const written = await this.hashFile(temp);
      if (!written.ok) {
        if (written.kind === 'error') throw new StepFailure(blockReasonFor(written.errno, 'default'), 'verify', written.errno);
        throw new StepFailure('VERIFY_FAILED', 'verify', null);
      }
      if (written.sha256 !== this.bundle.sha256) throw new StepFailure('VERIFY_FAILED', 'verify', null);
      // Step 9: the atomic replacement; EBUSY is retried, EPERM (a mapped image) never.
      await this.withTargetRetry('rename', () => this.fs.rename(temp!, file));
      renamed = true;
      // Step 10: the target now holds exactly the bundle.
      const placed = await this.hashFile(file);
      if (!placed.ok) {
        if (placed.kind === 'error') throw new StepFailure(blockReasonFor(placed.errno, 'target-read'), 'rehash', placed.errno);
        throw new StepFailure('VERIFY_FAILED', 'rehash', null);
      }
      if (placed.sha256 !== this.bundle.sha256) throw new StepFailure('VERIFY_FAILED', 'rehash', null);
      // Step 11: the result, the cleared intent and the cleared failure in one registry write.
      const installed: InstallRecord = {game: target.game, root: target.root, source: target.source, sha256: this.bundle.sha256, appVersion: this.bundle.appVersion,
        installedUtc: this.registry.utc(), createdPluginsDirectory: (record?.createdPluginsDirectory ?? false) || createdDirectory};
      const done = pending;
      try {
        await this.registry.update(document => withoutFailure({
          ...document,
          installs: [...document.installs.filter(other => !(other.game === target.game && sameRoot(other.root, target.root))), installed],
          pending: document.pending.filter(other => !samePending(other, done))
        }, target.game, target.root));
      } catch (error) {
        // The plugin is in place; the intent stays and the next run's recovery records it.
        intent = undefined;
        return this.blocked('install', new StepFailure('REGISTRY_UNAVAILABLE', 'record', registryErrno(error)));
      }
      intent = undefined;
      // P7: a game started meanwhile keeps the plugin it loaded; the new one loads after its restart.
      const after = await this.processBlock(target.game);
      return this.result('install', fromSha256 ? 'updated' : 'installed', after instanceof StepFailure && after.reason === 'GAME_RUNNING');
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      failure = error;
      return this.blocked('install', error);
    } finally {
      // Step 12: whatever happened, the exact temporary file of this run does not outlive it.
      let tempRemoved = true;
      if (temp && tempCreated && !renamed) tempRemoved = await this.fs.unlink(temp).then(() => true, unlinkError => errorCode(unlinkError) === 'ENOENT');
      if (failure) {
        if (createdDirectory && !renamed) await this.removeEmptyDirectory(pluginsDirectoryOf(target.root));
        // The intent stays for the next run's recovery when its temporary file could not be removed, or once the rename
        // has happened: recovery then records the install from what is on disk, with the created-folder flag.
        if (failure.step !== 'pending') await this.recordFailure(target, failure, intent && tempRemoved && !renamed ? intent : undefined, intent !== undefined);
      }
    }
  }

  /** The target already equals the bundle: record a manual copy as adopted, otherwise change nothing (P12). */
  private async keepCurrent(target: PluginTarget, record: InstallRecord | undefined): Promise<PluginActionResult> {
    const recorded = record?.sha256 === this.bundle.sha256 && record.appVersion === this.bundle.appVersion;
    if (recorded && !failureFor(this.registry.document, target.game, target.root)) return this.result('install', 'unchanged');
    if (this.installsFull(target)) return this.blocked('install', new StepFailure('REGISTRY_UNAVAILABLE', 'record', null));
    const next: InstallRecord = record
      ? {...record, sha256: this.bundle.sha256, appVersion: this.bundle.appVersion}
      : {game: target.game, root: target.root, source: 'adopted', sha256: this.bundle.sha256, appVersion: this.bundle.appVersion,
        installedUtc: this.registry.utc(), createdPluginsDirectory: false};
    try {
      await this.registry.update(document => withoutFailure({
        ...document,
        installs: [...document.installs.filter(other => !(other.game === target.game && sameRoot(other.root, target.root))), next]
      }, target.game, target.root));
    } catch (error) {return this.blocked('install', new StepFailure('REGISTRY_UNAVAILABLE', 'record', registryErrno(error)));}
    return this.result('install', record ? 'unchanged' : 'adopted');
  }

  private temporaryHex(): string {
    const hex = this.randomHex();
    if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error('Temporary file id must be 16 lowercase hex digits');
    return hex;
  }

  private async writeTemporary(temp: string, created: () => void): Promise<void> {
    let handle: InstallerHandle;
    try {handle = await this.fs.open(temp, 'wx');} catch (error) {
      throw new StepFailure(blockReasonFor(errorCode(error), 'default'), 'temp', errorCode(error));
    }
    created();
    try {
      let offset = 0;
      while (offset < this.bundle.bytes.byteLength) {
        const {bytesWritten} = await handle.write(this.bundle.bytes, offset, this.bundle.bytes.byteLength - offset, offset);
        // A write that makes no progress would loop forever; it is a failed write.
        if (bytesWritten <= 0) throw Object.assign(new Error('Write made no progress'), {code: 'EIO'});
        offset += bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw new StepFailure(blockReasonFor(errorCode(error), 'default'), 'temp', errorCode(error));
    }
    try {await handle.close();} catch (error) {
      throw new StepFailure(blockReasonFor(errorCode(error), 'default'), 'temp', errorCode(error));
    }
  }

  /** Runs a target rename or unlink, retrying only EBUSY after 20, 40, 60, 80 and 100 ms. */
  private async withTargetRetry(step: 'rename' | 'unlink', operation: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {await operation(); return;} catch (error) {
        const code = errorCode(error);
        if (code !== 'EBUSY' || attempt >= TARGET_RETRY_DELAYS_MS.length) throw new StepFailure(blockReasonFor(code, 'target-replace'), step, code);
        await this.delay(TARGET_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /** Removes the plugins folder only when it is a plain, empty folder; any failure leaves it. */
  private removeEmptyDirectory(directory: string): Promise<boolean> {return removeEmptyPluginsDirectory(this.fs, directory);}

  /**
   * Removes the owned plugin from the target when its game is excluded (P8 removal, P11): the running check, the
   * classification (an unrecognized file stays), the durable intent, the unlink and the recorded result. The plugins
   * folder is removed only when this application created it and it is empty.
   */
  async remove(target: PluginTarget): Promise<PluginActionResult> {
    const refused = await this.preflight(target);
    if (refused) return this.blocked('remove', refused);
    let intent: PendingIntent | undefined;
    try {
      const layout = await this.layout(target);
      const record = installRecordFor(this.registry.document, target.game, target.root);
      const found = await this.classify(target, layout.target, layout.targetExists);
      if (found.state === 'blocked') throw new StepFailure(found.reason, found.step, found.errno);
      if (found.state === 'missing') {
        if (record?.createdPluginsDirectory && layout.pluginsExists) await this.removeEmptyDirectory(layout.pluginsDirectory);
        if (record || failureFor(this.registry.document, target.game, target.root)) {
          try {
            await this.registry.update(document => withoutFailure({
              ...document, installs: document.installs.filter(other => !(other.game === target.game && sameRoot(other.root, target.root)))
            }, target.game, target.root));
          } catch (error) {throw new StepFailure('REGISTRY_UNAVAILABLE', 'record', registryErrno(error));}
        }
        return this.result('remove', 'absent');
      }
      // The same rule as an update: a read-only file is refused, and its attribute is never cleared.
      if (found.mode !== undefined && (found.mode & 0o200n) === 0n) throw new StepFailure('READ_ONLY_FILE', 'read-only', null);
      const pending: PendingIntent = {op: 'remove', game: target.game, root: target.root, source: target.source, temp: null, fromSha256: found.sha256,
        toSha256: null, appVersion: null, createdPluginsDirectory: record?.createdPluginsDirectory ?? false, startedUtc: this.registry.utc()};
      try {await this.registry.update(document => ({...document, pending: [...document.pending, pending]}));} catch (error) {
        throw new StepFailure('REGISTRY_UNAVAILABLE', 'pending', registryErrno(error));
      }
      intent = pending;
      await this.withTargetRetry('unlink', () => this.fs.unlink(layout.target));
      if (pending.createdPluginsDirectory) await this.removeEmptyDirectory(layout.pluginsDirectory);
      try {
        await this.registry.update(document => withoutFailure({
          ...document,
          installs: document.installs.filter(other => !(other.game === target.game && sameRoot(other.root, target.root))),
          pending: document.pending.filter(other => !samePending(other, pending))
        }, target.game, target.root));
      } catch (error) {
        intent = undefined;
        return this.blocked('remove', new StepFailure('REGISTRY_UNAVAILABLE', 'record', registryErrno(error)));
      }
      return this.result('remove', 'removed');
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      if (error.step !== 'pending') await this.recordFailure(target, error, intent, intent !== undefined);
      return this.blocked('remove', error);
    }
  }

  /**
   * Recovery at the start of each run (P8). It needs a writable registry and a successful running check; the intents of
   * a running game stay. Each other intent is resolved on its own, from what is on disk: the layout must still be ready
   * (no link, still a game), its exact temporary file is removed when that is a regular file, and the target is
   * classified again. A completed rename is recorded as an install, a completed unlink deletes the install record, a
   * plugins folder the intent created and that is empty now is removed, and the intent is cleared with a
   * PLUGIN_RECOVERED log line. An intent whose layout changed, whose temporary file cannot be removed or whose target
   * cannot be read stays for a later run.
   */
  async recover(): Promise<RecoveryResult> {
    const pending = this.registry.document.pending;
    if (!pending.length) return {recovered: 0, remaining: 0, reason: null};
    if (!this.registry.writable) return {recovered: 0, remaining: pending.length, reason: 'REGISTRY_UNAVAILABLE'};
    let check: Awaited<ReturnType<RunningCheck>>;
    try {check = await this.ports.checkRunning(this.ports.signal);} catch {check = {ok: false, code: 'RUNNING_CHECK_FAILED'};}
    if (!check.ok) return {recovered: 0, remaining: pending.length, reason: 'RUNNING_CHECK_FAILED'};
    const running = check.running;
    const free = pending.filter(intent => !blockingProcess(intent.game, running));
    const result = await this.recoverIntents(free);
    return {...result, remaining: this.registry.document.pending.length};
  }

  /**
   * True only when the root itself does not exist (ENOENT) while its parent is still a plain folder. A missing parent,
   * as on an unplugged drive, or any other error keeps the intent, because the folder may come back.
   */
  private async rootGone(root: string): Promise<boolean> {
    try {
      await this.fs.lstat(root, {bigint: true});
      return false;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return false;
    }
    const parent = path.win32.dirname(root);
    if (parent === root) return false;
    try {
      const stats = await this.fs.lstat(parent, {bigint: true});
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {return false;}
  }

  private async recoverIntents(intents: readonly PendingIntent[]): Promise<RecoveryResult> {
    let recovered = 0;
    let reason: PluginBlockReason | null = null;
    for (const intent of intents) {
      const layout = await validateGameLayout(this.fs, intent.root, intent.game);
      if (layout.status === 'not-game' && await this.rootGone(intent.root)) {
        // The game folder was removed (the game or its library uninstalled): its temporary file and target went with it,
        // so nothing is left to clean and the intent no longer holds one of the 16 slots.
        try {
          await this.registry.update(document => ({...document, pending: document.pending.filter(other => !samePending(other, intent))}));
        } catch {reason = 'REGISTRY_UNAVAILABLE'; continue;}
        this.log('PLUGIN_RECOVERED', undefined, {game: intent.game, source: intent.source, op: intent.op, outcome: 'gone'});
        recovered++;
        continue;
      }
      if (layout.status !== 'ready') {
        reason = layout.status === 'linked' ? 'LINKED_FOLDER' : layout.status === 'unexpected-entry' ? 'UNRECOGNIZED_FILE' : 'IO_ERROR';
        continue;
      }
      if (intent.temp) {
        try {
          const stats = await this.fs.lstat(intent.temp, {bigint: true});
          if (stats.isFile() && !stats.isSymbolicLink()) await this.fs.unlink(intent.temp);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {reason = blockReasonFor(errorCode(error), 'default'); continue;}
        }
      }
      // What the target holds now: its hash, `missing`, or `other` for a link, a folder or an oversized file.
      let present = 'missing';
      if (layout.targetExists) {
        const hashed = await this.hashFile(layout.target);
        if (hashed.ok) present = hashed.sha256;
        else if (hashed.kind === 'error') {reason = blockReasonFor(hashed.errno, 'target-read'); continue;}
        else if (hashed.kind !== 'missing') present = 'other';
      }
      if (present === 'missing' && layout.pluginsExists && intent.createdPluginsDirectory) await this.removeEmptyDirectory(layout.pluginsDirectory);
      let outcome = intent.op === 'remove' ? (present === 'missing' ? 'removed' : 'kept') : (present === intent.toSha256 ? 'installed' : 'not-installed');
      const utc = this.registry.utc();
      try {
        await this.registry.update(document => {
          const same = (other: {game: PluginGame; root: string}) => other.game === intent.game && sameRoot(other.root, intent.root);
          const existing = document.installs.find(same);
          let installs = document.installs;
          if (outcome === 'installed' && intent.toSha256 !== null && intent.appVersion !== null) {
            if (!existing && document.installs.length >= MAX_INSTALL_RECORDS) outcome = 'unrecorded';
            // The rename completed before the interruption: the plugin is ours.
            else installs = [...document.installs.filter(other => !same(other)), {game: intent.game, root: intent.root, source: intent.source, sha256: intent.toSha256,
              appVersion: intent.appVersion, installedUtc: utc, createdPluginsDirectory: (existing?.createdPluginsDirectory ?? false) || intent.createdPluginsDirectory}];
          } else if (outcome === 'removed') installs = document.installs.filter(other => !same(other));
          return {...document, installs, pending: document.pending.filter(other => !samePending(other, intent))};
        });
      } catch {reason = 'REGISTRY_UNAVAILABLE'; continue;}
      // `unrecorded`: the install bound left no room for the record; the file stays owned only through the bundled or a
      // known hash.
      this.log('PLUGIN_RECOVERED', undefined, {game: intent.game, source: intent.source, op: intent.op, outcome});
      recovered++;
    }
    return {recovered, remaining: intents.length - recovered, reason};
  }
}

function samePending(left: PendingIntent, right: PendingIntent): boolean {
  return left.op === right.op && left.game === right.game && sameRoot(left.root, right.root) && left.temp === right.temp && left.startedUtc === right.startedUtc;
}
function registryErrno(error: unknown): string | null {
  return error && typeof error === 'object' && 'errno' in error && typeof error.errno === 'string' ? error.errno : null;
}
