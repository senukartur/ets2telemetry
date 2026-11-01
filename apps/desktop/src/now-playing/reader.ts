import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {NowPlayingError} from '../../../../packages/contracts/src/now-playing';
import {MediaFrames, parseSnapshot, snapshotCommand, type MediaSnapshot} from './protocol';
import {record} from './contract';

export const MEDIA_DEADLINE_MS = 5000, MEDIA_POLL_MS = 1000, MEDIA_SHUTDOWN_MS = 500;
/** Fixed resource names and matching source/channel evidence, never an executable override. */
export async function verifiedMediaReader(packaged: boolean, resources: string, desktopDirectory: string, channel: string): Promise<string> {
  const directory = packaged ? path.join(resources, 'media-session-reader') : path.resolve(desktopDirectory, '../../..', '.local/package-native/media-session-reader');
  const executable = path.join(directory, 'media-session-reader.exe');
  const evidenceFile = path.join(directory, 'build-evidence.json'), desktopFile = path.join(desktopDirectory, 'build-evidence.json');
  for (const [file, max] of [[executable, 16 * 1024 * 1024], [evidenceFile, 1024 * 1024], [desktopFile, 1024 * 1024]] as const) {
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Media reader unavailable');
  }
  const [bytes, evidenceBytes, desktopBytes] = await Promise.all([readFile(executable), readFile(evidenceFile, 'utf8'), readFile(desktopFile, 'utf8')]);
  const evidence: unknown = JSON.parse(evidenceBytes), desktop: unknown = JSON.parse(desktopBytes);
  if (!record(evidence) || !record(desktop) || evidence.channel !== channel || desktop.channel !== channel || JSON.stringify(evidence.sources) !== JSON.stringify(desktop.sources) || evidence.executableSha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Media reader evidence mismatch');
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  if (pe < 0 || pe + 6 > bytes.length || bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Media reader is not x64');
  return executable;
}
export interface MediaReaderOptions {
  resolve(): Promise<string>;
  snapshot(value: MediaSnapshot, generation: number): void;
  failed(code: NowPlayingError): void;
  /** Injected by unit tests only; the application never accepts a renderer/environment executable. */
  launch?: (executable: string) => ChildProcessWithoutNullStreams;
  now?: () => number;
}
export class MediaReader {
  private enabled = false;
  private child?: ChildProcessWithoutNullStreams;
  private generation = 0;
  private request = 0;
  private pending?: number;
  private selectedId: string | null = null;
  private poll?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private restarts: number[] = [];
  private retirement = new Set<Promise<void>>();
  private selectionGeneration = 0;
  private pendingSelection = 0;
  constructor(private readonly options: MediaReaderOptions) {}
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {this.restarts = []; void this.start(false);} else this.retire();
  }
  select(id: string | null): void {this.selectedId = id; this.selectionGeneration++;}
  stop(): Promise<void> | undefined {this.enabled = false; this.retire(); return this.retirement.size ? Promise.all([...this.retirement]).then(() => undefined) : undefined;}
  private async start(restart: boolean): Promise<void> {
    if (!this.enabled) return;
    if (restart) {
      const now = (this.options.now ?? Date.now)(); this.restarts = this.restarts.filter(at => now - at < 60000);
      if (this.restarts.length >= 2) {this.poll = setTimeout(() => {this.poll = undefined; void this.start(true);}, Math.max(1, 60000 - (now - this.restarts[0]))); return;}
      this.restarts.push(now);
    }
    const generation = ++this.generation;
    try {
      const executable = await this.options.resolve();
      if (!this.enabled || generation !== this.generation) return;
      const child = this.child = (this.options.launch ?? (file => spawn(file, ['--parent', String(process.pid)], {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})))(executable);
      const frames = new MediaFrames();
      child.stderr.resume(); // Native diagnostics never enter the application log.
      const live = () => this.enabled && this.child === child && this.generation === generation;
      child.stdout.on('data', (chunk: Buffer) => {
        if (!live()) return;
        try {frames.push(chunk, value => {
          if (!live() || this.pending === undefined) throw new Error('Unsolicited snapshot');
          const snapshot = parseSnapshot(value, this.pending);
          if (!snapshot) throw new Error('Invalid snapshot');
          this.pending = undefined; clearTimeout(this.deadline); this.deadline = undefined;
          if (this.pendingSelection === this.selectionGeneration) this.options.snapshot(snapshot, generation);
          if (live()) this.poll = setTimeout(() => {this.poll = undefined; this.send();}, MEDIA_POLL_MS);
        });} catch {if (live()) this.fail('INVALID_RESPONSE');}
      });
      child.on('error', () => {if (live()) this.fail('READER_UNAVAILABLE');});
      child.on('exit', () => {if (live()) this.fail('READER_UNAVAILABLE');});
      child.stdin.on('error', () => {if (live()) this.fail('READER_UNAVAILABLE');});
      this.send();
    } catch {if (this.enabled && generation === this.generation) this.fail('READER_UNAVAILABLE');}
  }
  private send(): void {
    if (!this.enabled || !this.child || this.pending !== undefined) return;
    this.pending = ++this.request; this.pendingSelection = this.selectionGeneration;
    this.deadline = setTimeout(() => this.fail('READER_TIMEOUT'), MEDIA_DEADLINE_MS);
    try {this.child.stdin.write(snapshotCommand(this.pending, this.selectedId));} catch {this.fail('READER_UNAVAILABLE');}
  }
  private fail(code: NowPlayingError): void {
    this.retire(); this.options.failed(code);
    if (this.enabled) this.poll = setTimeout(() => {this.poll = undefined; void this.start(true);}, MEDIA_POLL_MS);
  }
  private retire(): void {
    this.generation++; this.pending = undefined;
    clearTimeout(this.poll); clearTimeout(this.deadline); this.poll = this.deadline = undefined;
    const child = this.child; this.child = undefined; if (!child) return;
    let done!: () => void;
    const retired = new Promise<void>(resolve => {done = resolve;}); this.retirement.add(retired);
    const kill = setTimeout(() => {if (child.exitCode === null && child.signalCode === null) child.kill();}, MEDIA_SHUTDOWN_MS);
    const finish = () => {clearTimeout(kill); this.retirement.delete(retired); done();};
    if (child.exitCode !== null || child.signalCode !== null) finish(); else child.once('close', finish);
    child.stdin.end();
  }
}
