// Read-only, bounded observation of the current process's persisted settings. Tests inject all roots and process facts.
import {createHash} from 'node:crypto';
import {open, realpath, opendir, stat} from 'node:fs/promises';
import path from 'node:path';
import {ProfileLogTail} from './log-tail';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import type {HardModeObservation} from '../../../../packages/contracts/src/hard-mode';
import {evaluateHardMode, parseHardModeConfig} from '../../../../packages/telemetry-core/src/hard-mode';
export const CONFIG_BYTES = 256 * 1024, LOG_BYTES = 4 * 1024 * 1024, MAX_PROFILES = 256;
const REQUIRED_GUARD_NS = 5_000_000_000n + 2_000_000_000n;
export interface GameProcess {pid: number; createdUtcMs: number; executable: string; commandLine?: string; homeDirectory?: string | null}
/** Fixed privacy-safe diagnostics. No file text, identity, hashes, paths or arbitrary errors cross this seam. */
export type ProfileDiagnosticCode = 'PROFILE_SOURCE_UNPROVEN' | 'PROFILE_PROCESS_QUERY_FAILED' | 'PROFILE_PROCESS_QUERY_DEADLINE' | 'PROFILE_PROCESS_QUERY_INVALID' | 'PROFILE_PROCESS_UNPROVEN' | 'PROFILE_LOG_GENERATION' | 'PROFILE_LOG_CHANGED' |
  'PROFILE_SELECTION_UNPROVEN' | 'PROFILE_LOCATION_UNPROVEN' | 'PROFILE_PROCESS_CHANGED' | 'PROFILE_DEADLINE' | 'PROFILE_CANCELLED' |
  'PROFILE_EPOCH_RETIRED' | 'PROFILE_VERIFIED' | 'PROFILE_SETTINGS_UNAVAILABLE' | 'PROFILE_PROBE_PENDING' | 'PROFILE_PROBE_EXPIRED' | 'PROFILE_PROOF_EXPIRED' | 'PROFILE_ADMITTED';
export interface ProfileDiagnostic {code: ProfileDiagnosticCode; durationMs?: number}
/** Log transitions and the first rejection of every source epoch; repeated identical states use powers of two. */
export function coalesceProfileDiagnostics(write: (value: ProfileDiagnostic & {count: number; epoch: number}) => void): (value: ProfileDiagnostic) => void {
  const counts = new Map<ProfileDiagnosticCode, number>(); let state: ProfileDiagnosticCode | undefined, epoch = 0;
  return value => {
    if (value.code === 'PROFILE_EPOCH_RETIRED') {epoch = Math.min(0x7fffffff, epoch + 1); counts.clear();}
    const changed = state !== value.code; state = value.code;
    const count = Math.min(0x7fffffff, (counts.get(value.code) ?? 0) + 1); counts.set(value.code,count);
    if (changed || (count & (count - 1)) === 0) write({code:value.code,count,epoch,
      ...(value.durationMs === undefined ? {} : {durationMs:Math.min(2000,Math.max(0,Math.floor(value.durationMs)))})});
  };
}
export interface HardModeReaderOptions {
  diagnostic?: (value: ProfileDiagnostic) => void;
  processLifetime?: (source: SourceIdentity) => string | undefined;
  documents: string; steamRoot?: string;
  /** Isolated smoke/test roots only; a fixture reader never accepts a real game source. */
  fixtureOrigin?: 'synthetic' | 'replay';
  process: (source: SourceIdentity, signal: AbortSignal) => Promise<GameProcess | null>;
  /** Controlled clocks/file gates for isolated tests only. */
  nowNs?: () => bigint;
  file?: typeof readStableFile;
  profileDirectory?: (directory: string) => ReturnType<typeof opendir>;
}
export interface BoundProfile {profile: string; storage: 'local' | 'cloud'; generation: number}
/** New selections invalidate preceding save markers; a later save namespace supersedes old profile-type markers. */
export function profileFromLog(log: string): BoundProfile | null {
  let selected: string | null = null, loaded: BoundProfile | null = null, generation = 0;
  for (const line of log.split(/\r?\n/)) {
    if (line.length > 8192) throw new Error('Unbounded log line');
    if (line.includes('Set profile finished:')) {selected = null; loaded = null; generation++;}
    const selection = /New profile selected:\s*(.*?)\s*$/.exec(line);
    if (selection) {
      let name = selection[1];
      if (name.startsWith("'") && name.endsWith("'") || name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
      selected = name.length > 0 && name.length <= 128 ? Buffer.from(name, 'utf8').toString('hex').toUpperCase() : null;
      loaded = null; generation++;
    }
    if (line.includes('Loading save.')) {
      generation++;
      const save = /\/(home|steam)\/profiles\/([0-9a-f]+)\/save\//i.exec(line);
      loaded = save && selected && save[2].toUpperCase() === selected ? {profile: selected, storage: save[1] === 'home' ? 'local' : 'cloud', generation} : null;
    }
  }
  return loaded;
}
/** Node/libuv opens with shared read/write/delete on Windows. Identity, size and bytes are checked across both reads. */
export async function readStableFile(filename: string, limit: number, signal: AbortSignal): Promise<{text: string; identity: string; birthtimeMs: number}> {
  signal.throwIfAborted();
  const resolved = await realpath(filename);
  // A redirected Documents root is canonicalized before this call. Cloud placeholders that retain their path work;
  // links redirecting a requested file outside that canonical tree are unsupported rather than followed silently.
  if (path.resolve(resolved).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new Error('Redirected file');
  const file = await open(filename, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Unbounded file');
    const bytes = Buffer.alloc(before.size + 1), second = Buffer.alloc(before.size + 1);
    const read = async (buffer: Buffer) => {
      let offset = 0;
      while (offset < buffer.length) {signal.throwIfAborted(); const {bytesRead} = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead;}
      return buffer.subarray(0, offset);
    };
    const a = await read(bytes), b = await read(second), after = await file.stat(), current = await stat(filename);
    if (a.length !== before.size || !a.equals(b) || before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== current.ino || after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error('Changing file');
    signal.throwIfAborted();
    return {text: new TextDecoder('utf-8', {fatal: true}).decode(a), identity: `${before.dev}:${before.ino}:${before.birthtimeMs}`, birthtimeMs: before.birthtimeMs};
  } finally {await file.close();}
}
function logCreation(log: string): number {
  const header = /log created on : \w+ (\w+) (\d{1,2}) (\d{4}) @ (\d{2}):(\d{2}):(\d{2})/.exec(log.slice(0, 8192));
  if (!header) return NaN;
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(header[1]);
  if (month < 0) return NaN;
  return new Date(Number(header[3]), month, Number(header[2]), Number(header[4]), Number(header[5]), Number(header[6])).getTime();
}
async function boundedDirectory(directory: string, limit: number, openDirectory = (directory: string) => opendir(directory)) {
  const entries = [];
  for await (const entry of await openDirectory(directory)) {entries.push(entry); if (entries.length > limit) throw new Error('Directory bound');}
  return entries;
}
async function profileDirectory(parent: string, profile: string, openDirectory?: HardModeReaderOptions['profileDirectory']): Promise<string> {
  const entries = await boundedDirectory(parent, MAX_PROFILES, openDirectory);
  if (entries.length > MAX_PROFILES) throw new Error('Profile bound');
  const matching = entries.filter(e => e.isDirectory() && e.name.toUpperCase() === profile);
  if (matching.length !== 1) throw new Error('Profile ambiguous');
  return path.join(parent, matching[0].name);
}
export interface ReadTiming {startedClientNs: bigint; completedClientNs: bigint}
export interface TimedHardModeObservation {observation: HardModeObservation; timing: ReadTiming}
/** Shared verification failure, distinct from an independently unavailable settings assessment. */
export class ProfileVerificationError extends Error {
  constructor(cause: unknown, readonly code: ProfileDiagnosticCode = 'PROFILE_PROCESS_UNPROVEN') {super(cause instanceof Error ? cause.message : 'Profile verification failed', {cause});}
}
/** Only independent unchanged-generation guards authorize retaining an admitted proof on a timed-out reread. */
export class UnchangedVerificationError extends ProfileVerificationError {}
/** A same-source hint supersedes control flow; it is not a failed filesystem or identity observation. */
export class ProfileSuperseded extends Error {}
interface ResolvedProfile {root: string; local: string; config: string; directories?: string[]; profile: BoundProfile; scope: string; binding: string; timing: ReadTiming}
interface ProfileScan {profile: ResolvedProfile; settings: HardModeObservation | null; settingsError?: unknown}
interface ScanOperation {
  key: string; source: SourceIdentity; atUtcMs: number; startedClientNs: bigint; controller: AbortController; generation: number;
  force: boolean; cheap: boolean; preserve?: boolean; promise: Promise<ProfileScan>; resolve: (value: ProfileScan) => void; reject: (error: unknown) => void;
  consumers: Set<object>; timer: ReturnType<typeof setTimeout>; settled: boolean; drain?: Promise<void>;
}
const readError = (cause: unknown): Error => cause instanceof Error ? cause : new Error('Profile read failed', {cause});
/** One physical operation and one pending epoch; only independently unchanged generations reuse completed evidence. */
export class HardModeReader {
  private boundProfile: {process: string; generation: number; profile: string; scope: string} | undefined;
  private previous: {process: string; identity: string; text: string} | undefined;
  private running: ScanOperation | undefined;
  private queued: ScanOperation | undefined;
  private readonly processes = new Map<string, {value?: GameProcess; failures: number; nextNs: bigint}>();
  private starts: bigint[] = [];
  private tail: {process: string; value: ProfileLogTail} | undefined;
  private admitted: {key: string; scan: ProfileScan; metadata: string; profileIdentity: string; fullNs: bigint} | undefined;
  private guard: {startedNs: bigint; deadlineNs: bigint} | undefined;
  private guardTimer: ReturnType<typeof setTimeout> | undefined;
  private guardGeneration = 0;
  private guardSource: string | undefined;
  private guardSelected = false;
  private readonly invalidations = new Set<(profileChanged: boolean) => void>();
  constructor(private readonly options: HardModeReaderOptions) {}
  requestFull(): void {if (this.running && !this.running.settled) this.running.force = true;}
  canRetain(): boolean {return this.guardEligible() && this.admitted !== undefined && this.running?.preserve === true;}
  /** Both evidence providers check this synchronously; event-loop delay cannot lend overdue guard eligibility. */
  guardEligible(): boolean {
    const guard = this.guard, now = this.nowNs();
    if (guard && (now < guard.startedNs || now >= guard.deadlineNs)) {
      this.options.diagnostic?.({code: 'PROFILE_DEADLINE'});
      this.retireGuards();
    }
    return this.guard !== undefined;
  }
  selectGuardSource(key: string | undefined): void {
    if (this.guardSelected && key === this.guardSource) return;
    const initial = !this.guardSelected; this.guardSelected = true; this.guardSource = key;
    if (!initial || key === undefined) this.retireGuards(true);
  }
  private retireGuards(retainBaseline = false): void {
    clearTimeout(this.guardTimer); this.guardTimer = undefined; this.guard = undefined; this.guardGeneration++;
    this.invalidate(true, retainBaseline);
    const reason = retainBaseline ? new Error('Source guard eligibility retired') : new ProfileVerificationError(new Error('Required guard eligibility retired'), 'PROFILE_DEADLINE');
    if (this.queued) this.cancel(this.queued, false, true, reason);
    if (this.running) this.cancel(this.running, false, true, reason);
  }
  private armGuardTimer(): void {
    clearTimeout(this.guardTimer);
    if (!this.guard) return;
    const generation = this.guardGeneration, remaining = this.guard.deadlineNs - this.nowNs();
    this.guardTimer = setTimeout(() => {
      this.guardTimer = undefined;
      if (generation === this.guardGeneration && this.guardEligible()) this.armGuardTimer();
    }, Math.max(0, Math.ceil(Number(remaining) / 1_000_000)));
    this.guardTimer.unref();
  }
  private current(work: ScanOperation): void {
    this.guardEligible();
    if (work.generation !== this.guardGeneration) throw new ProfileVerificationError(new Error('Retired guard generation'), 'PROFILE_DEADLINE');
    work.controller.signal.throwIfAborted();
  }
  private guarded(work: ScanOperation): void {
    this.current(work);
    const deadlineNs = work.startedClientNs + REQUIRED_GUARD_NS;
    if (this.nowNs() >= deadlineNs) throw new ProfileVerificationError(new Error('Required guard deadline'), 'PROFILE_DEADLINE');
    this.guard = {startedNs: work.startedClientNs, deadlineNs}; this.armGuardTimer();
  }
  drain(): Promise<void> {return this.running?.drain ?? Promise.resolve();}
  onInvalidate(listener: (profileChanged: boolean) => void): () => void {this.invalidations.add(listener); return () => this.invalidations.delete(listener);}
  private invalidate(profileChanged = true, retainBaseline = false): void {if (!retainBaseline) this.admitted = undefined; for (const listener of this.invalidations) listener(profileChanged);}
  private lifetime(source: SourceIdentity): string | undefined {
    return this.options.processLifetime ? this.options.processLifetime(source)
      : JSON.stringify([source.game, source.origin, source.processId, source.windowsSessionId, source.processInstanceId]);
  }
  private async process(source: SourceIdentity, signal: AbortSignal, cheap: boolean): Promise<GameProcess> {
    const key = this.lifetime(source), now = this.nowNs();
    if (!key) throw new Error('Process lifetime unproven');
    let entry = this.processes.get(key);
    if (entry?.value) return entry.value;
    if (cheap) throw new Error('Process inspection unavailable for tail guard');
    this.starts = this.starts.filter(start => now < start || now - start < 300_000_000_000n);
    if (entry && now < entry.nextNs || this.starts.length >= 8 || !entry && this.processes.size >= 256) throw new Error('Process inspection deferred');
    if (!entry) {entry = {failures: 0, nextNs: now}; this.processes.set(key, entry);}
    this.starts.push(now);
    try {
      const value = await this.options.process(source, signal);
      signal.throwIfAborted();
      if (!value || this.lifetime(source) !== key || value.pid !== source.processId
        || path.win32.basename(value.executable).toLowerCase() !== (source.game === 'ets2' ? 'eurotrucks2.exe' : 'amtrucks.exe')
        || !Number.isSafeInteger(value.createdUtcMs) || value.createdUtcMs < 0
        || value.homeDirectory === undefined && typeof value.commandLine !== 'string') throw new Error('Process unproven');
      entry.value = {...value}; return entry.value;
    } catch (error) {
      const delay = [5, 15, 30, 60][Math.min(entry.failures++, 3)];
      entry.nextNs = this.nowNs() + BigInt(delay) * 1_000_000_000n;
      throw error;
    }
  }
  private async metadata(resolved: ResolvedProfile): Promise<{fingerprint: string; profileIdentity: string}> {
    const required = new Set([resolved.local, path.dirname(resolved.config)]);
    const paths = [resolved.root, path.join(resolved.root, 'profiles'), path.join(resolved.root, 'steam_profiles'),
      resolved.local, path.dirname(resolved.local), path.dirname(resolved.config), ...(resolved.directories ?? []),
      path.join(resolved.root, 'config.cfg'), path.join(resolved.local, 'config_local.cfg'), resolved.config];
    const values = await Promise.all(paths.map(async filename => {
      try {
        if (path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new Error('Redirected path');
        const value = await stat(filename, {bigint: true});
        if (required.has(filename) && !value.isDirectory()) throw new Error('Profile directory unproven');
        return [filename, value.dev, value.ino, value.birthtimeNs, value.size, value.mtimeNs, value.ctimeNs].map(String);
      } catch (error) {if (!required.has(filename) && (error as NodeJS.ErrnoException).code === 'ENOENT') return [filename, 'missing']; throw error;}
    }));
    // Physical profile identity excludes settings-file replacements and directory content-change hints.
    return {fingerprint: JSON.stringify(values), profileIdentity: JSON.stringify(values.filter(value => required.has(value[0])).map(value => value.slice(0, 4)))};
  }
  private nowNs(): bigint {return (this.options.nowNs ?? (() => process.hrtime.bigint()))();}
  private file(filename: string, limit: number, signal: AbortSignal) {return (this.options.file ?? readStableFile)(filename, limit, signal);}
  private request(source: SourceIdentity, atUtcMs: number, signal: AbortSignal, force = false, cheap = false): Promise<ProfileScan> {
    signal.throwIfAborted();
    this.guardEligible();
    const key = JSON.stringify([source.game, source.origin, source.processId, source.windowsSessionId, source.processInstanceId, source.pluginSessionId]);
    let operation = this.running?.key === key && !this.running.settled && !this.running.controller.signal.aborted ? this.running
      : this.queued?.key === key && !this.queued.controller.signal.aborted ? this.queued : undefined;
    if (!operation) {
      // A boundary tail guard cannot bootstrap process inspection or occupy the full consumer's scan slot.
      // It may still join a normal operation above, whose authenticated inspection is already owned.
      if (cheap && (this.running || this.queued || !this.processes.get(this.lifetime(source) ?? '')?.value)) throw new ProfileVerificationError(new Error('Process inspection unavailable for tail guard'));
      if (this.running) this.cancel(this.running, false, true);
      if (this.queued) this.cancel(this.queued, false, true);
      const controller = new AbortController();
      let resolve!: ScanOperation['resolve'], reject!: ScanOperation['reject'];
      const promise = new Promise<ProfileScan>((yes, no) => {resolve = yes; reject = no;});
      void promise.catch(() => undefined);
      operation = {key, source: {...source}, atUtcMs, startedClientNs: this.nowNs(), controller, generation: this.guardGeneration, promise, resolve, reject,
        force, cheap, consumers: new Set(), timer: setTimeout(() => this.cancel(operation!, true), 2000), settled: false};
      if (this.running) this.queued = operation; else this.run(operation);
    }
    const work = operation;
    if (force) work.force = true;
    if (!cheap) work.cheap = false;
    return new Promise<ProfileScan>((resolve, reject) => {
      const consumer = {}; work.consumers.add(consumer);
      let finished = false;
      const finish = (action: () => void, reason?: unknown) => {
        if (finished) return;
        finished = true; signal.removeEventListener('abort', cancel); work.controller.signal.removeEventListener('abort', cancelled);
        work.consumers.delete(consumer); action();
        if (!work.settled && work.consumers.size === 0) this.cancel(work, false, false, reason);
      };
      const cancel = () => {
        // A consumer timer may run first at the shared deadline. Preserve the physical timeout instead of masking it
        // as ordinary cancellation; an earlier consumer cancellation still has no authority over the other proofs.
        if (!work.settled && this.nowNs() - work.startedClientNs >= 2_000_000_000n) this.cancel(work, true);
        else finish(() => reject(readError(signal.reason)), signal.reason);
      };
      const cancelled = () => finish(() => reject(readError(work.controller.signal.reason)));
      signal.addEventListener('abort', cancel, {once: true}); work.controller.signal.addEventListener('abort', cancelled, {once: true});
      if (signal.aborted) cancel(); else if (work.controller.signal.aborted) cancelled();
      work.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(readError(error))));
    });
  }
  private cancel(work: ScanOperation, timedOut = false, retired = false, reason?: unknown): void {
    if (work.controller.signal.aborted) {
      if (timedOut && !work.settled && work.controller.signal.reason instanceof ProfileSuperseded && !work.preserve) this.invalidate();
      return;
    }
    const code = timedOut ? 'PROFILE_DEADLINE' : retired ? 'PROFILE_EPOCH_RETIRED' : 'PROFILE_CANCELLED';
    this.options.diagnostic?.({code, durationMs: Math.min(2000, Math.max(0, Number(this.nowNs() - work.startedClientNs) / 1e6))});
    if (timedOut && !work.preserve || reason instanceof ProfileVerificationError && !work.preserve) this.invalidate();
    work.controller.abort(timedOut ? new (work.preserve ? UnchangedVerificationError : ProfileVerificationError)(new Error('Read deadline'), code) : reason);
    if (this.queued === work) {
      this.queued = undefined; clearTimeout(work.timer); work.settled = true; work.reject(work.controller.signal.reason);
    }
  }
  private run(work: ScanOperation): void {
    this.running = work;
    work.drain = this.scan(work).then(value => {work.settled = true; work.resolve(value);}, error => {
      work.settled = true;
      if (!work.controller.signal.aborted) this.options.diagnostic?.({code: error instanceof ProfileVerificationError ? error.code : 'PROFILE_PROCESS_UNPROVEN',
        durationMs: Math.min(2000, Math.max(0, Number(this.nowNs() - work.startedClientNs) / 1e6))});
      work.reject(work.controller.signal.aborted ? work.controller.signal.reason : error instanceof ProfileVerificationError ? error : new ProfileVerificationError(error));
    }).finally(() => {
      clearTimeout(work.timer); this.running = undefined;
      const next = this.queued; this.queued = undefined;
      if (next) {
        if (next.controller.signal.aborted) {clearTimeout(next.timer); next.settled = true; next.reject(next.controller.signal.reason);}
        else this.run(next);
      }
    });
  }
  private async location(source: SourceIdentity, root: string, profile: BoundProfile) {
    const local = await profileDirectory(path.join(root, profile.storage === 'local' ? 'profiles' : 'steam_profiles'), profile.profile, this.options.profileDirectory);
    let config = path.join(local, 'config.cfg');
    const directories: string[] = [];
    if (profile.storage === 'cloud') {
      if (!this.options.steamRoot) throw new Error('Cloud root unproven');
      const steam = await realpath(this.options.steamRoot), userdata = path.join(steam, 'userdata'), accounts = await boundedDirectory(userdata, 32);
      directories.push(steam, userdata);
      if (accounts.length > 32) throw new Error('Account bound');
      const candidates: string[] = [];
      let profiles = 0;
      for (const account of accounts) {
        if (!account.isDirectory() || !/^[0-9]+$/.test(account.name)) continue;
        const parent = path.join(userdata, account.name, source.game === 'ets2' ? '227300' : '270880', 'remote', 'profiles');
        directories.push(path.join(userdata, account.name), parent);
        let entries;
        try {entries = await boundedDirectory(parent, MAX_PROFILES);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
        profiles += entries.length;
        if (profiles > MAX_PROFILES) throw new Error('Profile bound');
        for (const entry of entries) if (entry.isDirectory() && entry.name.toUpperCase() === profile.profile) candidates.push(path.join(parent, entry.name, 'config.cfg'));
      }
      if (candidates.length !== 1) throw new Error('Cloud candidate ambiguous');
      config = candidates[0];
    }
    const directory = await realpath(path.dirname(config)), localDirectory=await realpath(local);
    if (path.resolve(directory).toLowerCase()!==path.resolve(path.dirname(config)).toLowerCase() || path.resolve(localDirectory).toLowerCase()!==path.resolve(local).toLowerCase()) throw new Error('Redirected profile');
    const identity = await stat(directory), localIdentity = await stat(local);
    if (!identity.isDirectory() || !localIdentity.isDirectory()) throw new Error('Profile directory unproven');
    const scope = createHash('sha256').update(JSON.stringify([1, source.game, root.toLowerCase(), profile.storage, directory.toLowerCase(),
      identity.dev, identity.ino, identity.birthtimeMs, localIdentity.dev, localIdentity.ino, localIdentity.birthtimeMs])).digest('hex');
    return {root, local, config, directories, profile, scope};
  }
  private async scan(work: ScanOperation): Promise<ProfileScan> {
    const {source, atUtcMs, controller} = work, signal = controller.signal;
    let stage: ProfileDiagnosticCode = 'PROFILE_SOURCE_UNPROVEN';
    let guardedUnchanged = false;
    try {
    signal.throwIfAborted();
    if (source.origin !== (this.options.fixtureOrigin ?? 'game')) throw new Error('Real evidence cannot qualify a fixture');
    stage = 'PROFILE_PROCESS_UNPROVEN';
    const process = await this.process(source, signal, work.cheap), expected = source.game === 'ets2' ? 'eurotrucks2.exe' : 'amtrucks.exe';
    if (!process || process.pid !== source.processId || path.win32.basename(process.executable).toLowerCase() !== expected || !Number.isFinite(process.createdUtcMs) || process.createdUtcMs > atUtcMs) throw new Error('Process unproven');
    stage = 'PROFILE_LOCATION_UNPROVEN';
    const override = process.homeDirectory === undefined ? /(?:^|\s)-homedir\s+(?:"([^"]+)"|(\S+))/i.exec(process.commandLine ?? '') : null;
    const root = await realpath(process.homeDirectory ?? (override ? override[1] ?? override[2] : path.join(this.options.documents, source.game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator')));
    stage = 'PROFILE_LOG_GENERATION';
    const processKey = this.lifetime(source)!;
    if (this.tail?.process !== processKey) this.tail = {process: processKey, value: new ProfileLogTail()};
    const log = this.options.file ? await this.file(path.join(root, 'game.log.txt'), LOG_BYTES, signal) : await this.tail.value.read(path.join(root, 'game.log.txt'), signal);
    if (!Number.isFinite(logCreation(log.text)) || Math.abs(logCreation(log.text) - process.createdUtcMs) > 5000) throw new Error('Stale log generation');
    stage = 'PROFILE_LOG_CHANGED';
    const previous = this.previous, bound = this.boundProfile;
    if (this.options.file && previous?.process === processKey && (previous.identity !== log.identity || !log.text.startsWith(previous.text))) throw new Error('Log replaced or truncated');
    stage = 'PROFILE_SELECTION_UNPROVEN';
    const profile = 'profile' in log ? log.profile : profileFromLog(log.text);
    if (!profile) throw new Error('Current profile unproven');
    stage = 'PROFILE_LOCATION_UNPROVEN';
    const old = this.admitted;
    const sameProfile = old?.key === work.key && JSON.stringify(old.scan.profile.profile) === JSON.stringify(profile) && old.scan.profile.root === root;
    let resolved = sameProfile ? old.scan.profile : await this.location(source, root, profile);
    let metadata = await this.metadata({...resolved, binding: '', timing: {startedClientNs: work.startedClientNs, completedClientNs: this.nowNs()}});
    const sameIdentity = sameProfile && old.profileIdentity === metadata.profileIdentity;
    const unchanged = sameIdentity && old.metadata === metadata.fingerprint;
    guardedUnchanged = unchanged === true;
    work.preserve = guardedUnchanged;
    if (old && !unchanged) this.invalidate(!sameIdentity);
    // Required guards renew before optional byte verification. A hung settings read cannot renew this bound again.
    this.guarded(work);
    const full = work.force || !unchanged || !work.cheap && (this.nowNs() < old.fullNs || this.nowNs() - old.fullNs >= 60_000_000_000n);
    if (!full) return {...structuredClone(old.scan), profile: {...structuredClone(old.scan.profile), timing: {startedClientNs: work.startedClientNs, completedClientNs: this.nowNs()}}};
    if (unchanged) old.fullNs = work.startedClientNs;
    // Full rediscovery also checks newly created Cloud candidates and directory replacement.
    resolved = await this.location(source, root, profile);
    metadata = await this.metadata({...resolved, binding: '', timing: {startedClientNs: work.startedClientNs, completedClientNs: this.nowNs()}});
    if (old && (old.metadata !== metadata.fingerprint || old.profileIdentity !== metadata.profileIdentity || old.scan.profile.scope !== resolved.scope || old.scan.profile.config !== resolved.config)) {
      this.invalidate(!sameProfile || old.profileIdentity !== metadata.profileIdentity || old.scan.profile.scope !== resolved.scope || old.scan.profile.config !== resolved.config);
    }
    if (bound?.process === processKey && bound.generation === profile.generation && bound.profile === profile.profile && bound.scope !== resolved.scope) throw new Error('Profile directory replaced');
    let settings: HardModeObservation | null = null, settingsError: unknown;
    try {
      const files = await Promise.allSettled([this.file(path.join(root, 'config.cfg'), CONFIG_BYTES, signal), this.file(path.join(resolved.local, 'config_local.cfg'), CONFIG_BYTES, signal), this.file(resolved.config, CONFIG_BYTES, signal)]);
      const [global, localSettings, values] = files.map(file => {if (file.status === 'rejected') throw file.reason; return parseHardModeConfig(file.value.text);});
      settings = {assessment: evaluateHardMode({...values, g_traffic: global.g_traffic, g_brake_intensity: localSettings.g_brake_intensity}, atUtcMs, this.options.fixtureOrigin ? 'fixture' : profile.storage),
        binding: '', pluginSessionId: source.pluginSessionId, sourceMonotonicNs: null};
    } catch (error) {settingsError = error;}
    if (settingsError) this.options.diagnostic?.({code: 'PROFILE_SETTINGS_UNAVAILABLE'});
    stage = 'PROFILE_LOG_CHANGED';
    const again = this.options.file ? await this.file(path.join(root, 'game.log.txt'), LOG_BYTES, signal) : await this.tail.value.read(path.join(root, 'game.log.txt'), signal);
    const latest = 'profile' in again ? again.profile : profileFromLog(again.text);
    if (again.identity !== log.identity || this.options.file && !again.text.startsWith(log.text) || JSON.stringify(latest) !== JSON.stringify(profile)) throw new Error('Profile changed during read');
    stage = 'PROFILE_LOCATION_UNPROVEN';
    const checked = await this.location(source, root, profile);
    if (checked.scope !== resolved.scope || checked.config !== resolved.config) throw new Error('Profile directory changed during read');
    stage = 'PROFILE_PROCESS_CHANGED';
    if (this.lifetime(source) !== processKey) throw new Error('Process changed');
    const afterMetadata = await this.metadata({...resolved, binding: '', timing: {startedClientNs: work.startedClientNs, completedClientNs: this.nowNs()}});
    if (afterMetadata.fingerprint !== metadata.fingerprint || afterMetadata.profileIdentity !== metadata.profileIdentity) throw new Error('Settings changed during read');
    this.current(work);
    stage = 'PROFILE_DEADLINE';
    const timing = {startedClientNs: work.startedClientNs, completedClientNs: this.nowNs()};
    if (timing.completedClientNs - timing.startedClientNs >= 2_000_000_000n) throw new Error('Read deadline');
    const binding = createHash('sha256').update(processKey + ':' + log.identity + ':' + JSON.stringify(profile) + ':' + resolved.scope).digest('hex');
    // Commit both baselines only after this ordered operation has passed every shared verification.
    this.previous = {process: processKey, identity: again.identity, text: again.text};
    this.boundProfile = {process: processKey, generation: profile.generation, profile: profile.profile, scope: resolved.scope};
    if (settings) settings.binding = binding;
    this.options.diagnostic?.({code: 'PROFILE_VERIFIED', durationMs: Number(timing.completedClientNs - timing.startedClientNs) / 1e6});
    const result = {profile: {...resolved, binding, timing}, settings, settingsError};
    if (settingsError && unchanged && this.admitted === old && old.scan.settings) {
      // Independent tail, process and metadata guards above established the same generation.
      return {...structuredClone(old.scan), profile: {...result.profile}};
    }
    this.admitted = {key: work.key, scan: structuredClone(result), metadata: metadata.fingerprint, profileIdentity: metadata.profileIdentity, fullNs: work.startedClientNs};
    return result;
    } catch (cause) {
      if (cause instanceof ProfileSuperseded && signal.aborted && cause === signal.reason) throw cause;
      if (guardedUnchanged && this.admitted && stage === 'PROFILE_DEADLINE') throw new UnchangedVerificationError(cause, stage);
      if (!guardedUnchanged || !signal.aborted || cause !== signal.reason) this.invalidate();
      throw cause instanceof ProfileVerificationError ? cause : new ProfileVerificationError(cause, stage);
    }
  }
  async resolveProfile(source: SourceIdentity, atUtcMs: number, signal: AbortSignal, cheap = false): Promise<ResolvedProfile> {
    return structuredClone((await this.request(source, atUtcMs, signal, false, cheap)).profile);
  }
  async readTimed(source: SourceIdentity, sourceMonotonicNs: string, atUtcMs: number, signal: AbortSignal, verified?: (binding: string) => void, force = false): Promise<TimedHardModeObservation> {
    const result = await this.request(source, atUtcMs, signal, force);
    verified?.(result.profile.binding);
    if (!result.settings) throw result.settingsError;
    return {observation: {...structuredClone(result.settings), sourceMonotonicNs}, timing: {...result.profile.timing}};
  }
  async read(source: SourceIdentity, sourceMonotonicNs: string, atUtcMs: number, signal: AbortSignal, force = false): Promise<HardModeObservation> {
    return (await this.readTimed(source, sourceMonotonicNs, atUtcMs, signal, undefined, force)).observation;
  }
}
