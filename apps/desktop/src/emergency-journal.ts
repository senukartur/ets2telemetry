import {mkdir, lstat, open, readdir, rename, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {MAX_FRAME_BYTES, isUint64} from '../../../packages/contracts/src/protocol-v0';
import {V1_MAX_MINOR, validateServerMessage, type ServerMessage, type Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CoverageMessage, ReadingMessage, WelcomeMessage} from './durable-sink';

type Checkpoint = Extract<ReadingMessage, {kind: 'checkpoint'}>;
export type JournalFrame = ReadingMessage | CoverageMessage;
export interface EmergencyEntry {
  connection: string;
  welcome: WelcomeMessage;
  checkpoint: Checkpoint;
  checkpointReceivedUtcMs: number;
  /** Coverage which preceded this frame on the wire, including already consumed spool files. */
  before: Uint64;
  message: JournalFrame;
  receivedUtcMs: number;
}

const PREFIX = /^([0-9]{12})\.frame$/;
const HELD = /^([0-9]{12})\.held$/;
const TEMP = /^([0-9]{12})\.partial$/;
const PROBE = '.write-probe';
const PROBE_PARTIAL = `${PROBE}.partial`;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_FILES = 24_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 3 * MAX_FRAME_BYTES + 512;
type PendingFile = {name: string; bytes: number};
export class EmergencyJournalFull extends Error {}
export class EmergencyJournalIntegrityError extends Error {}

function checkMissing(error: unknown): never {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new EmergencyJournalIntegrityError('Missing journal file');
  throw error;
}

function decode(raw: string, origin: WelcomeMessage['source']['origin']): EmergencyEntry {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const utc = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  if (!value || value.version !== 1 || typeof value.connection !== 'string' || !UUID.test(value.connection)
    || !isUint64(value.before) || !utc(value.receivedUtcMs) || !utc(value.checkpointReceivedUtcMs)) {
    throw new Error('Invalid journal entry');
  }
  const read = (input: unknown) => validateServerMessage(input, {maxMinor: V1_MAX_MINOR});
  const welcome = read(value.welcome), checkpoint = read(value.checkpoint), message = read(value.message);
  if (welcome.kind !== 'welcome' || checkpoint.kind !== 'checkpoint'
    || !welcome.data.durableEvents || !checkpoint.data.status.delivery.durable
    || (message.kind !== 'checkpoint' && message.kind !== 'snapshot' && message.kind !== 'event' && message.kind !== 'gap')) {
    throw new Error('Invalid journal frame');
  }
  const {source} = welcome;
  const matches = (frame: ServerMessage) => frame.source.origin === origin && frame.source.game === source.game
    && frame.source.processInstanceId === source.processInstanceId && frame.source.pluginSessionId === source.pluginSessionId
    && frame.capture.clockId === welcome.capture.clockId && frame.version.minor === welcome.version.minor;
  if (!matches(welcome) || !matches(checkpoint) || !matches(message)) throw new Error('Journal source mismatch');
  const before = BigInt(value.before);
  if (before < BigInt(checkpoint.data.status.delivery.ackedThroughEventSeq)
    || message.kind === 'event' && BigInt(message.data.eventSeq) !== before + 1n
    || message.kind === 'gap' && BigInt(message.data.firstEventSeq) !== before + 1n) {
    throw new Error('Journal coverage mismatch');
  }
  return {connection: value.connection, welcome, checkpoint, checkpointReceivedUtcMs: value.checkpointReceivedUtcMs,
    before: value.before, message, receivedUtcMs: value.receivedUtcMs};
}

/**
 * Single writer, single reader. Publish an entry only after syncing its bytes. A crash before publication leaves an
 * unacknowledged partial file. A crash before deletion leaves the same head for idempotent replay.
 */
export class EmergencyJournal {
  private readonly files = new Map<string, PendingFile>();
  private bytes = 0;
  private held = 0;
  private next = 0;

  constructor(private readonly directory: string, private readonly origin: WelcomeMessage['source']['origin']) {}

  get pending(): number { return this.files.size; }
  get hasRoom(): boolean {
    return this.files.size + this.held < MAX_FILES && this.bytes + MAX_ENTRY_BYTES <= MAX_BYTES;
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid emergency journal directory');
    const entries = await readdir(this.directory, {withFileTypes: true});
    if (entries.length > MAX_FILES + 2) throw new Error('Emergency journal contains too many files');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const pending = PREFIX.exec(entry.name);
      const match = pending ?? HELD.exec(entry.name);
      if (!match && !TEMP.test(entry.name) && entry.name !== PROBE && entry.name !== PROBE_PARTIAL) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new EmergencyJournalIntegrityError('Invalid journal file');
      const location = path.join(this.directory, entry.name);
      if (!match) { await unlink(location); continue; }
      const {size} = await lstat(location);
      if (pending) this.add({name: entry.name, bytes: size});
      else {
        this.checkCapacity(size);
        this.held++;
        this.bytes += size;
      }
      this.next = Math.max(this.next, Number(match[1]) + 1);
    }
  }

  private add(file: PendingFile): void {
    this.checkCapacity(file.bytes);
    this.files.set(file.name, file);
    this.bytes += file.bytes;
  }

  private checkCapacity(bytes: number): void {
    if (bytes <= 0 || bytes > MAX_ENTRY_BYTES) throw new EmergencyJournalIntegrityError('Invalid emergency journal entry size');
    if (this.files.size + this.held >= MAX_FILES || this.bytes + bytes > MAX_BYTES) throw new EmergencyJournalFull('Emergency journal limit');
  }

  async append(entry: EmergencyEntry): Promise<number> {
    const raw = JSON.stringify({version: 1, ...entry});
    const checksum = createHash('sha256').update(raw, 'utf8').digest('hex');
    const body = Buffer.from(`${checksum}\n${raw}`);
    this.checkCapacity(body.length);
    decode(raw, this.origin);
    if (this.next >= 1e12) throw new Error('Emergency journal sequence exhausted');
    const sequence = this.next++;
    const number = String(sequence).padStart(12, '0');
    const file = {name: `${number}.frame`, bytes: body.length};
    await this.publish(body, `${number}.partial`, file.name);
    this.add(file);
    return sequence;
  }

  /** Only retry durable ingestion once sync and publication work again. This never publishes a replay entry. */
  async probe(): Promise<void> {
    await this.publish(Buffer.from('1'), PROBE_PARTIAL, PROBE);
    await unlink(path.join(this.directory, PROBE));
  }

  private async publish(body: Buffer, temporary: string, name: string): Promise<void> {
    const partial = path.join(this.directory, temporary);
    const handle = await open(partial, 'wx');
    try {
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(partial, path.join(this.directory, name));
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }
  }

  async head(): Promise<{name: string; sequence: number; entry: EmergencyEntry} | undefined> {
    const file = this.files.values().next().value;
    if (!file) return undefined;
    const location = path.join(this.directory, file.name);
    const info = await lstat(location).catch(checkMissing);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) throw new EmergencyJournalIntegrityError('Invalid journal file');
    const handle = await open(location, 'r').catch(checkMissing);
    const raw = Buffer.alloc(file.bytes + 1);
    try {
      let offset = 0;
      while (offset < raw.length) {
        const {bytesRead} = await handle.read(raw, offset, raw.length - offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== file.bytes) throw new EmergencyJournalIntegrityError('Invalid journal file length');
    } finally { await handle.close(); }
    const checksum = raw.subarray(0, 64).toString('ascii'), body = raw.subarray(65, file.bytes);
    if (raw[64] !== 10 || checksum !== createHash('sha256').update(body).digest('hex')) throw new EmergencyJournalIntegrityError('Invalid journal checksum');
    let entry: EmergencyEntry;
    try { entry = decode(new TextDecoder('utf-8', {fatal: true}).decode(body), this.origin); }
    catch (error) { throw new EmergencyJournalIntegrityError('Invalid journal entry', {cause: error}); }
    return {name: file.name, sequence: Number(file.name.slice(0, 12)), entry};
  }

  async consume(name: string): Promise<void> {
    const file = this.files.values().next().value;
    if (!file || file.name !== name) throw new Error('Journal consumed out of order');
    await unlink(path.join(this.directory, name));
    this.files.delete(name);
    this.bytes -= file.bytes;
  }

  /** An acknowledged prefix missing from SQLite cannot be reconstructed from its suffix. Keep that suffix on disk. */
  async hold(name: string): Promise<void> {
    const file = this.files.values().next().value;
    if (!file || file.name !== name) throw new Error('Journal held out of order');
    await rename(path.join(this.directory, name), path.join(this.directory, name.replace(/\.frame$/, '.held')));
    this.files.delete(name);
    this.held++;
  }
}
