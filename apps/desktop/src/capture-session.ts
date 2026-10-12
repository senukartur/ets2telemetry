import {EventEmitter} from 'node:events';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {decodeCap0Payload, encodeCap0Hello, CAP0_MAX_PACKET_BYTES, type Cap0Authority} from '../../../packages/contracts/src/capture-cap0';
import {isUint64} from '../../../packages/contracts/src/protocol-v0';
import type {BrokerConfiguration} from './native-pipe-client';
import {CaptureWriter, type CaptureContext, type CaptureManifest} from './capture-writer';

export type CaptureAuthority = Cap0Authority & {processCreationTime: string};
/** Events: authority(CaptureAuthority), packet(Uint8Array), waiting, end, error(Error), close. */
export interface CaptureTransport extends Pick<EventEmitter, 'on' | 'once'> {
  readonly completion: Promise<void>;
  sendHello(frame: Uint8Array): void;
  credit(): void;
  destroy(): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Validates the broker's CAP0-marked authority receipt; a v0 receipt can never authorize capture. */
export function captureAuthority(receipt: unknown, game: 'ets2' | 'ats'): CaptureAuthority {
  const record = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt as Record<string, unknown> : undefined;
  if (!record || record.type !== 'authority' || record.schemaVersion !== 1 || record.evidence !== 'cap0' || Object.keys(record).length !== 6 || !isUint64(record.processCreationTime) || typeof record.userTag !== 'string' || !/^[0-9a-f]{64}$/.test(record.userTag)) throw new Error('Capture authority receipt rejected');
  const source = record.source && typeof record.source === 'object' && !Array.isArray(record.source) ? record.source as Record<string, unknown> : undefined;
  const id = (value: unknown, max: number, min: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (!source || Object.keys(source).length !== 6 || source.game !== game || source.origin !== 'game' || !id(source.processId, 0xffffffff, 1) || !id(source.windowsSessionId, 0xffffffff, 0) ||
    typeof source.processInstanceId !== 'string' || !UUID.test(source.processInstanceId) || typeof source.pluginSessionId !== 'string' || !UUID.test(source.pluginSessionId)) throw new Error('Capture source authority rejected');
  return Object.freeze({game, processId: source.processId as number, windowsSessionId: source.windowsSessionId as number, processInstanceId: source.processInstanceId, pluginSessionId: source.pluginSessionId, processCreationTime: record.processCreationTime});
}
/** The fixed native broker in its explicit CAP0 mode; one stdio credit permits one relayed packet. */
export class NativeCaptureClient extends EventEmitter implements CaptureTransport {
  readonly completion: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0); private authority?: CaptureAuthority; private receiptSeen = false;
  private helloSent = false; private creditOutstanding = false; private stopped = false;
  private readonly startup: ReturnType<typeof setTimeout>;
  constructor(configuration: BrokerConfiguration, private readonly game: 'ets2' | 'ats') {
    super();
    this.child = spawn(configuration.executable, ['--game', game, '--discovery-dir', configuration.discoveryDirectory, '--capture', 'cap0'], {windowsHide: true, stdio: 'pipe'});
    this.completion = new Promise(resolve => this.child.once('close', () => resolve()));
    this.startup = setTimeout(() => this.reject('Capture authority deadline exceeded'), 5000);
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.reject('Capture control pipe closed'));
    this.child.on('error', () => this.reject('Capture broker could not start'));
    this.child.once('close', code => {
      clearTimeout(this.startup);
      if (!this.stopped) {
        this.stopped = true;
        if (this.buffer.length) this.emit('error', new Error('Incomplete capture relay frame'));
        else if (code === 2 && !this.authority) this.emit('waiting');
        else if (code !== 0 && code !== 3) this.emit('error', new Error('Capture authority or connection rejected'));
        else this.emit('end');
      }
      this.emit('close');
    });
    this.child.stdout.on('data', (bytes: unknown) => {
      if (this.stopped) return;
      try {
        if (!(bytes instanceof Uint8Array) || this.buffer.length + bytes.length > CAP0_MAX_PACKET_BYTES + 4) throw new Error('Capture relay bound exceeded');
        this.buffer = Buffer.concat([this.buffer, bytes]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE();
          if (!length || length > (this.receiptSeen ? CAP0_MAX_PACKET_BYTES : 4096)) throw new Error('Capture relay length rejected');
          if (this.buffer.length < length + 4) return;
          const payload = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
          if (!this.receiptSeen) {
            this.receiptSeen = true;
            const receipt: unknown = JSON.parse(payload.toString('utf8'));
            if (this.buffer.length) throw new Error('Uncredited capture receipt suffix');
            const record = receipt as Record<string, unknown> | null;
            if (record && record.type === 'waiting' && record.schemaVersion === 1 && Object.keys(record).length === 2) { clearTimeout(this.startup); continue; }
            this.authority = captureAuthority(receipt, this.game); clearTimeout(this.startup); this.emit('authority', this.authority);
          } else {
            if (!this.creditOutstanding || !this.authority) throw new Error('Uncredited capture packet');
            this.creditOutstanding = false;
            if (this.buffer.length) throw new Error('Uncredited capture packet suffix');
            this.emit('packet', new Uint8Array(payload));
          }
        }
      } catch { this.reject('Capture relay protocol rejected'); }
    });
  }
  sendHello(frame: Uint8Array): void {
    if (this.stopped || !this.authority || this.helloSent || frame.length > 4100) { this.reject('Capture hello rejected'); return; }
    this.helloSent = true; this.child.stdin.write(frame); this.credit();
  }
  credit(): void {
    if (this.stopped) return;
    if (this.creditOutstanding || !this.helloSent) { this.reject('Duplicate capture relay credit'); return; }
    this.creditOutstanding = true; this.child.stdin.write(Buffer.from([1]));
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.startup); this.buffer = Buffer.alloc(0); this.child.stdin.end(); this.child.stdout.resume();
  }
  private reject(reason: string): void { if (this.stopped) return; this.destroy(); this.emit('error', new Error(reason)); }
}

export interface CaptureSessionOptions {
  root: string; game: 'ets2' | 'ats';
  context: Omit<CaptureContext, 'captureSessionId'>;
  connect: () => CaptureTransport;
  retryMs?: number; now?: () => number; utcNow?: () => number;
  captureSessionId?: string;
}
/**
 * One explicitly activated capture interval. It retries discovery only until its fixed deadline,
 * never reconnects after an authorized source ends, and has no durable ACK or playback path.
 */
export class CaptureSession {
  readonly captureSessionId: string;
  private writer?: CaptureWriter; private transport?: CaptureTransport; private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0; private connected = false; private finished = false;
  private readonly completions = new Set<Promise<void>>();
  private resolveDone!: (manifest: CaptureManifest | undefined) => void;
  readonly done = new Promise<CaptureManifest | undefined>(resolve => { this.resolveDone = resolve; });
  constructor(private readonly options: CaptureSessionOptions) { this.captureSessionId = options.captureSessionId ?? randomUUID(); }
  async start(): Promise<void> {
    const writer = this.writer = new CaptureWriter({root: this.options.root, context: {...this.options.context, captureSessionId: this.captureSessionId},
      now: this.options.now, utcNow: this.options.utcNow}, manifest => this.finish(manifest));
    try { await writer.start(); } catch (error) { this.finished = true; this.resolveDone(undefined); throw error; }
    this.attempt();
  }
  async stop(): Promise<CaptureManifest | undefined> {
    if (!this.writer) { this.finished = true; this.resolveDone(undefined); return undefined; }
    const manifest = await this.writer.close(this.connected ? 'service-stop' : 'no-source', this.connected ? undefined : `${this.attempts} discovery attempts`);
    await Promise.all(this.completions); return manifest;
  }
  private attempt(): void {
    const writer = this.writer!;
    if (writer.closed || this.finished) return;
    this.attempts++;
    const transport = this.transport = this.options.connect(); let authorized = false;
    const completion = transport.completion; this.completions.add(completion); void completion.finally(() => this.completions.delete(completion));
    const retry = () => {
      transport.destroy(); if (this.transport === transport) this.transport = undefined;
      if (!writer.closed) this.retry = setTimeout(() => { this.retry = undefined; void completion.then(() => this.attempt()); }, this.options.retryMs ?? 1000);
    };
    transport.on('authority', (authority: CaptureAuthority) => {
      if (writer.closed) return;
      authorized = this.connected = true; writer.bindAuthority(authority); transport.sendHello(encodeCap0Hello(this.captureSessionId));
    });
    transport.on('packet', (payload: Uint8Array) => {
      if (writer.closed) return;
      let packet;
      try { packet = decodeCap0Payload(payload); } catch (error) { void writer.close('protocol-error', error instanceof Error ? error.message : 'Invalid CAP0 packet'); return; }
      // Credit only after synchronous validation and bounded admission: the writer is the backpressure point.
      if (writer.accept(packet) && !writer.closed) transport.credit();
    });
    transport.on('waiting', retry);
    transport.on('end', () => { if (authorized) void writer.close('disconnect', 'source closed before an end marker'); else retry(); });
    transport.on('error', (error: Error) => { void writer.close(authorized ? 'disconnect' : 'authority-rejected', error.message.slice(0, 120)); });
  }
  private finish(manifest: CaptureManifest): void {
    clearTimeout(this.retry); this.retry = undefined; this.transport?.destroy(); this.transport = undefined;
    if (!this.finished) { this.finished = true; this.resolveDone(manifest); }
  }
}
