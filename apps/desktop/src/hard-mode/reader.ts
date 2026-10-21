// Read-only, bounded observation of the current process's persisted settings. Tests inject all roots and process facts.
import {createHash} from 'node:crypto';
import {open, realpath, opendir, stat} from 'node:fs/promises';
import path from 'node:path';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import type {HardModeObservation} from '../../../../packages/contracts/src/hard-mode';
import {evaluateHardMode, parseHardModeConfig} from '../../../../packages/telemetry-core/src/hard-mode';
export const CONFIG_BYTES = 256 * 1024, LOG_BYTES = 4 * 1024 * 1024, MAX_PROFILES = 256;
export interface GameProcess {pid: number; createdUtcMs: number; executable: string; commandLine: string}
export interface HardModeReaderOptions {
  documents: string; steamRoot?: string;
  /** Isolated smoke/test roots only; a fixture reader never accepts a real game source. */
  fixtureOrigin?: 'synthetic' | 'replay';
  process: (source: SourceIdentity, signal: AbortSignal) => Promise<GameProcess | null>;
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
async function boundedDirectory(directory: string, limit: number) {
  const entries = [];
  for await (const entry of await opendir(directory)) {entries.push(entry); if (entries.length > limit) throw new Error('Directory bound');}
  return entries;
}
async function profileDirectory(parent: string, profile: string): Promise<string> {
  const entries = await boundedDirectory(parent, MAX_PROFILES);
  if (entries.length > MAX_PROFILES) throw new Error('Profile bound');
  const matching = entries.filter(e => e.isDirectory() && e.name.toUpperCase() === profile);
  if (matching.length !== 1) throw new Error('Profile ambiguous');
  return path.join(parent, matching[0].name);
}
export class HardModeReader {
  private previous: {process: string; identity: string; text: string} | undefined;
  constructor(private readonly options: HardModeReaderOptions) {}
  async read(source: SourceIdentity, sourceMonotonicNs: string, atUtcMs: number, signal: AbortSignal): Promise<HardModeObservation> {
    if (source.origin !== (this.options.fixtureOrigin ?? 'game')) throw new Error('Real evidence cannot qualify a fixture');
    const process = await this.options.process(source, signal), expected = source.game === 'ets2' ? 'eurotrucks2.exe' : 'amtrucks.exe';
    if (!process || process.pid !== source.processId || path.win32.basename(process.executable).toLowerCase() !== expected || !Number.isFinite(process.createdUtcMs) || process.createdUtcMs > atUtcMs) throw new Error('Process unproven');
    const override = /(?:^|\s)-homedir\s+(?:"([^"]+)"|(\S+))/i.exec(process.commandLine);
    const root = await realpath(override ? override[1] ?? override[2] : path.join(this.options.documents, source.game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator'));
    const log = await readStableFile(path.join(root, 'game.log.txt'), LOG_BYTES, signal);
    if (!Number.isFinite(logCreation(log.text)) || Math.abs(logCreation(log.text) - process.createdUtcMs) > 5000) throw new Error('Stale log generation');
    const processKey = `${source.processId}:${source.windowsSessionId}:${process.createdUtcMs}:${source.processInstanceId}:${source.pluginSessionId}`;
    const previous = this.previous;
    this.previous = {process: processKey, identity: log.identity, text: log.text};
    if (previous?.process === processKey && (previous.identity !== log.identity || !log.text.startsWith(previous.text))) throw new Error('Log replaced or truncated');
    const profile = profileFromLog(log.text);
    if (!profile) throw new Error('Current profile unproven');
    const local = await profileDirectory(path.join(root, profile.storage === 'local' ? 'profiles' : 'steam_profiles'), profile.profile);
    let config = path.join(local, 'config.cfg');
    if (profile.storage === 'cloud') {
      if (!this.options.steamRoot) throw new Error('Cloud root unproven');
      const steam = await realpath(this.options.steamRoot), userdata = path.join(steam, 'userdata'), accounts = await boundedDirectory(userdata, 32);
      if (accounts.length > 32) throw new Error('Account bound');
      const candidates: string[] = [];
      let profiles = 0;
      for (const account of accounts) {
        if (!account.isDirectory() || !/^[0-9]+$/.test(account.name)) continue;
        const parent = path.join(userdata, account.name, source.game === 'ets2' ? '227300' : '270880', 'remote', 'profiles');
        let entries;
        try {entries = await boundedDirectory(parent, MAX_PROFILES);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
        profiles += entries.length;
        if (profiles > MAX_PROFILES) throw new Error('Profile bound');
        for (const entry of entries) if (entry.isDirectory() && entry.name.toUpperCase() === profile.profile) candidates.push(path.join(parent, entry.name, 'config.cfg'));
      }
      if (candidates.length !== 1) throw new Error('Cloud candidate ambiguous');
      config = candidates[0];
    }
    const files = await Promise.all([readStableFile(path.join(root, 'config.cfg'), CONFIG_BYTES, signal), readStableFile(path.join(local, 'config_local.cfg'), CONFIG_BYTES, signal), readStableFile(config, CONFIG_BYTES, signal)]);
    const [global, localSettings, settings] = files.map(f => parseHardModeConfig(f.text));
    const again = await readStableFile(path.join(root, 'game.log.txt'), LOG_BYTES, signal), latest = profileFromLog(again.text);
    if (again.identity !== log.identity || !again.text.startsWith(log.text) || JSON.stringify(latest) !== JSON.stringify(profile)) throw new Error('Profile changed during read');
    const current = await this.options.process(source, signal);
    if (!current || current.pid !== process.pid || current.createdUtcMs !== process.createdUtcMs) throw new Error('Process changed');
    return {assessment: evaluateHardMode({...settings, g_traffic: global.g_traffic, g_brake_intensity: localSettings.g_brake_intensity}, atUtcMs, this.options.fixtureOrigin ? 'fixture' : profile.storage),
      binding: createHash('sha256').update(`${processKey}:${log.identity}:${JSON.stringify(profile)}`).digest('hex'), pluginSessionId: source.pluginSessionId, sourceMonotonicNs};
  }
}
