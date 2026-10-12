import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, writeFile, type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {Cap0StreamValidator, type Cap0Authority, type Cap0EndData, type Cap0HeaderData, type Cap0LossData, type Cap0Packet} from '../../../packages/contracts/src/capture-cap0';
import {CAPTURE_LIMITS} from './capture-activation';
export {CAPTURE_LIMITS};
export const PACKETS_FILE = 'packets.ndjson';
export const MANIFEST_FILE = 'manifest.json';
const MAX_BOUNDARIES = 1000;
export type CaptureStopReason = 'source-end' | 'disconnect' | 'deadline' | 'pending-cap' | 'file-cap' | 'write-failure' | 'protocol-error' | 'authority-rejected' | 'service-stop' | 'no-source';

export interface CaptureContext {
  captureSessionId: string;
  activation: {mechanism: 'environment'; deadlineMs: number; operatorLabel: string | null};
  code: Record<string, string | null>;
  platform: Record<string, string | number | null>;
  displays: unknown[];
}
export interface CaptureWriterOptions {
  root: string; context: CaptureContext; limits?: Partial<typeof CAPTURE_LIMITS>;
  now?: () => number; utcNow?: () => number;
  open?: (filename: string) => Promise<Pick<FileHandle, 'write' | 'close' | 'sync'>>;
}
export interface CaptureManifest {
  format: 'ets2telemetry-cap0-capture-manifest'; schemaVersion: 1; captureSessionId: string;
  origin: 'game' | 'synthetic' | 'unknown'; status: 'complete' | 'partial';
  stop: {reason: CaptureStopReason; detail: string | null};
  activation: CaptureContext['activation']; authority: (Cap0Authority & {processCreationTime: string}) | null; header: Cap0HeaderData | null;
  clockDomains: Record<string, unknown>;
  timing: {receiptClockId: string; startedMonotonicNs: string; stoppedMonotonicNs: string; startedUtcUnixMs: string; stoppedUtcUnixMs: string};
  counts: {packetsReceived: number; packetsWritten: number; bytesWritten: number; packetsDiscarded: number; bytesDiscarded: number; envelopesCompleted: number};
  loss: {pluginLoss: Cap0LossData | null; end: Cap0EndData | null; endMarkerReceived: boolean; envelopePartial: boolean; lastPacketSeq: string | null; lastEnvelopeSeq: string;
    knownBoundaries: {envelopeSeq: string; droppedBefore: string}[]; boundariesOmitted: number};
  limits: typeof CAPTURE_LIMITS; files: {name: string; bytes: number; sha256: string}[];
  code: CaptureContext['code']; platform: CaptureContext['platform']; displays: unknown[];
  evidence: {durableAck: false; tripEffects: false; history: false; playback: false};
}

/**
 * Bounded evidence writer for one capture session. It writes only under its own capture directory,
 * never telemetry.sqlite, and closes with retained manifest/loss evidence on caps, failures or disconnect.
 */
export class CaptureWriter {
  readonly directory: string;
  readonly limits: typeof CAPTURE_LIMITS;
  private file?: Pick<FileHandle, 'write' | 'close' | 'sync'>;
  private readonly hash = createHash('sha256');
  private readonly receiptClock = randomUUID();
  private readonly now: () => number; private readonly utcNow: () => number;
  private readonly started: {monotonic: bigint; utc: number};
  private readonly validator: Cap0StreamValidator;
  private pending: Buffer[] = []; private pendingBytes = 0; private written = 0; private writing?: Promise<void>;
  private counts = {packetsReceived: 0, packetsWritten: 0, bytesWritten: 0, packetsDiscarded: 0, bytesDiscarded: 0, envelopesCompleted: 0};
  private boundaries: {envelopeSeq: string; droppedBefore: string}[] = []; private boundariesOmitted = 0;
  private lastEnd: Cap0EndData | null = null; private failure?: string;
  private deadline?: ReturnType<typeof setTimeout>;
  private closing?: Promise<CaptureManifest>;
  private authority: CaptureManifest['authority'] = null;
  constructor(private readonly options: CaptureWriterOptions, private readonly onClose: (manifest: CaptureManifest) => void = () => {}) {
    const limits = {...CAPTURE_LIMITS, deadlineMs: options.context.activation.deadlineMs, ...options.limits};
    if (!path.isAbsolute(options.root)) throw new Error('Capture root must be absolute');
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid capture limit');
    if (limits.pendingBytes > CAPTURE_LIMITS.pendingBytes || limits.fileBytes > CAPTURE_LIMITS.fileBytes || limits.deadlineMs > 60 * 60 * 1000) throw new Error('Capture limits exceed approved bounds');
    this.limits = limits;
    this.now = options.now ?? (() => performance.now()); this.utcNow = options.utcNow ?? (() => Date.now());
    this.directory = path.join(options.root, options.context.captureSessionId);
    this.validator = new Cap0StreamValidator(options.context.captureSessionId);
    this.started = {monotonic: this.monotonicNs(), utc: this.utcNow()};
  }
  /** Creates a new private session directory and file; an existing directory is never reused. */
  async start(): Promise<void> {
    await mkdir(this.options.root, {recursive: true});
    await mkdir(this.directory);
    const filename = path.join(this.directory, PACKETS_FILE);
    this.file = this.options.open ? await this.options.open(filename) : await open(filename, 'wx');
    this.deadline = setTimeout(() => void this.close('deadline'), this.limits.deadlineMs);
  }
  bindAuthority(authority: Cap0Authority & {processCreationTime: string}): void { this.authority = authority; this.validator.bindAuthority(authority); }
  get closed(): boolean { return Boolean(this.closing); }
  /**
   * Synchronously validates ordering and admits the packet into bounded pending storage. Returns false
   * once the capture is closed; a cap or invalid packet closes the capture with evidence retained.
   */
  accept(packet: Cap0Packet): boolean {
    if (this.closing || !this.file) return false;
    this.counts.packetsReceived++;
    try { this.validator.accept(packet); }
    catch (error) { this.discard(0); void this.close('protocol-error', error instanceof Error ? error.message : 'Invalid CAP0 stream'); return false; }
    const now = this.monotonicNs();
    const line = Buffer.from(JSON.stringify({receipt: {seq: this.counts.packetsReceived, monotonicNs: now.toString(), utcUnixMs: String(Math.trunc(this.utcNow()))}, packet}) + '\n');
    if (this.pendingBytes + line.length > this.limits.pendingBytes) { this.discard(line.length); void this.close('pending-cap'); return false; }
    if (this.written + this.pendingBytes + line.length > this.limits.fileBytes) { this.discard(line.length); void this.close('file-cap'); return false; }
    if (packet.kind === 'envelope' && packet.data.attributes.final) {
      this.counts.envelopesCompleted++;
      if (packet.data.droppedBefore !== '0') {
        if (this.boundaries.length < MAX_BOUNDARIES) this.boundaries.push({envelopeSeq: packet.data.envelopeSeq, droppedBefore: packet.data.droppedBefore}); else this.boundariesOmitted++;
      }
    }
    if (packet.kind === 'end') this.lastEnd = packet.data;
    this.pending.push(line); this.pendingBytes += line.length; this.flush();
    if (packet.kind === 'end') void this.close('source-end');
    return true;
  }
  /** Idempotent: stops admission, flushes admitted bytes (unless writing failed) and writes the manifest. */
  close(reason: CaptureStopReason, detail?: string): Promise<CaptureManifest> {
    this.closing ??= (async () => {
      clearTimeout(this.deadline);
      while (this.writing) await this.writing;
      if (this.failure) { this.discard(this.pendingBytes, this.pending.length); this.pending = []; this.pendingBytes = 0; }
      try { await this.file?.sync(); } catch { /* Close below still releases the handle; the hash covers bytes written. */ }
      try { await this.file?.close(); } catch { this.failure ??= 'close-failed'; }
      const manifest = this.manifest(this.failure ? 'write-failure' : reason, this.failure ? this.failure : detail ?? null);
      const temporary = path.join(this.directory, `${MANIFEST_FILE}.tmp`);
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
      await rename(temporary, path.join(this.directory, MANIFEST_FILE));
      this.onClose(manifest); return manifest;
    })();
    return this.closing;
  }
  private flush(): void {
    if (this.writing || !this.pending.length || this.failure || !this.file) return;
    const chunk = Buffer.concat(this.pending), count = this.pending.length, length = chunk.length; this.pending = [];
    this.writing = (async () => {
      try {
        let offset = 0;
        while (offset < chunk.length) { const {bytesWritten} = await this.file!.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error('No progress'); offset += bytesWritten; }
        this.hash.update(chunk); this.written += length; this.counts.bytesWritten += length; this.counts.packetsWritten += count;
      } catch (error) {
        // Bytes already admitted are not acknowledged anywhere; record them as discarded evidence.
        this.failure = error instanceof Error ? `write-failed: ${error.message.slice(0, 120)}` : 'write-failed'; this.discard(length, count);
        void this.close('write-failure');
      } finally { this.pendingBytes -= length; this.writing = undefined; }
      this.flush();
    })();
  }
  private discard(bytes: number, packets = 1): void { this.counts.packetsDiscarded += packets; this.counts.bytesDiscarded += bytes; }
  private monotonicNs(): bigint { const ms = this.now(); if (!Number.isFinite(ms) || ms < 0) throw new Error('Receipt clock invalid'); return BigInt(Math.round(ms * 1e6)); }
  private manifest(reason: CaptureStopReason, detail: string | null): CaptureManifest {
    const header = this.validator.header ?? null, endMarkerReceived = this.validator.ended;
    const sha256 = this.hash.copy().digest('hex');
    const complete = reason === 'source-end' && endMarkerReceived && !this.counts.packetsDiscarded && !this.validator.partial;
    return {
      format: 'ets2telemetry-cap0-capture-manifest', schemaVersion: 1, captureSessionId: this.options.context.captureSessionId,
      origin: header?.origin ?? 'unknown', status: complete ? 'complete' : 'partial', stop: {reason, detail},
      activation: this.options.context.activation, authority: this.authority, header,
      clockDomains: {
        sdkFrame: {fields: ['packet.data.sdkFrame'], unit: 'microseconds', meaning: 'SCS frame-start timestamps copied at the callback; game-controlled, may restart'},
        gameTime: {fields: ['packet.data.gameTime'], unit: 'in-game minutes', meaning: 'game clock with its own rotating clockId; not real time'},
        sourceMonotonic: {clockId: header?.clocks.sourceMonotonicClockId ?? null, fields: ['packet.data.callbackMonotonicNs', 'packet.publishMonotonicNs', 'loss.lastDropMonotonicNs'], unit: 'nanoseconds',
          meaning: 'plugin QPC domain: callback copy, drop and worker publication stages of one clock'},
        fileReceipt: {clockId: this.receiptClock, fields: ['receipt.monotonicNs', 'receipt.utcUnixMs'], unit: 'nanoseconds / UTC milliseconds',
          meaning: 'telemetry service receipt before the file write; independent of the source clock and never subtracted from it'},
        sharedBoundaryOrder: {fields: ['packet.data.sharedBoundaryOrder'], meaning: 'adapter counter shared by every SDK callback; increasing, but not a proven per-callback total order'}
      },
      timing: {receiptClockId: this.receiptClock, startedMonotonicNs: this.started.monotonic.toString(), stoppedMonotonicNs: this.monotonicNs().toString(),
        startedUtcUnixMs: String(Math.trunc(this.started.utc)), stoppedUtcUnixMs: String(Math.trunc(this.utcNow()))},
      counts: {...this.counts},
      loss: {pluginLoss: this.validator.loss ?? null, end: this.lastEnd, endMarkerReceived, envelopePartial: this.validator.partial, lastPacketSeq: this.validator.lastPacketSeq ?? null,
        lastEnvelopeSeq: this.validator.lastEnvelopeSeq, knownBoundaries: [...this.boundaries], boundariesOmitted: this.boundariesOmitted},
      limits: this.limits, files: [{name: PACKETS_FILE, bytes: this.written, sha256}],
      code: this.options.context.code, platform: this.options.context.platform, displays: this.options.context.displays,
      evidence: {durableAck: false, tripEffects: false, history: false, playback: false}
    };
  }
}
