import {EventEmitter} from 'node:events';
import path from 'node:path';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import {isUint64} from '../../../packages/contracts/src/protocol-v0';
import {TRANSPORT_DIRECTORY} from './channel';

export interface TelemetrySocket extends Pick<EventEmitter, 'on' | 'once'> {
  authority?: SourceIdentity;
  completion?: Promise<void>;
  write(bytes: Uint8Array): unknown;
  destroy(): unknown;
}
export interface BrokerConfiguration {executable: string; discoveryDirectory: string}
/**
 * The broker mode: `v0` (the live protocol) or `v1` (ET-006b): `--protocol v1`, a six-key receipt marked
 * `protocolMajor: 1`, and after the hello a tagged control stream that also carries the service's client frames.
 */
export type BrokerProtocol = 'v0' | 'v1';
/**
 * ET-006b E12: the v1 discovery directory is the `v1` sibling of the validated v0 directory `...\transport\v0` that main
 * sends with a selection. Any other shape gives no v1 configuration, so a v1 game source stays unavailable instead of
 * guessing a directory. The executable is the same verified broker.
 */
export function v1BrokerConfiguration(configuration: BrokerConfiguration | undefined): BrokerConfiguration | undefined {
  if (!configuration) return undefined;
  const directory = configuration.discoveryDirectory, parent = path.win32.dirname(directory);
  if (!path.win32.isAbsolute(directory) || path.win32.basename(directory) !== 'v0' || path.win32.basename(parent) !== TRANSPORT_DIRECTORY) return undefined;
  return {executable: configuration.executable, discoveryDirectory: path.win32.join(parent, 'v1')};
}
/** Fixed broker stage names. Any other diagnostic text is reported only as unrecognized. */
const BROKER_STAGES = new Set(['arguments', 'identity', 'directory', 'own-image', 'policy-lock', 'policy-image', 'policy-existing', 'policy-json', 'policy-current', 'policy-write',
  'policy-publish', 'discovery', 'server-process', 'server-image', 'connected-peer', 'authority-receipt', 'hello', 'relay', 'retained-authority', 'wire-frame', 'wire-payload',
  'client-frame', 'client-write']);
const DIAGNOSTIC_TAIL_BYTES = 256;
const DIAGNOSTIC_LINE = /diag1 ([a-z-]{1,24}) (\d{1,10}) (\d{1,10}) ([a-z-]{1,24}) (\d{1,10})\r?\n$/;
/** Protocol v1 control-stream tags (docs/telemetry-service-v0.md, Protocol v1 mode). */
const CREDIT_TAG = 0x01, CLIENT_FRAME_TAG = 0x02;
/** Largest protocol v1 client frame payload the broker accepts after the hello. */
const MAX_CLIENT_FRAME_PAYLOAD = 4096;
export type BrokerOutcome = 'ended' | 'busy' | 'rejected' | 'startup-deadline' | 'start-failed' | 'control-closed' | 'incomplete-frame' | 'relay-rejected' | 'hello-rejected' | 'duplicate-credit'
  | 'client-frame-rejected';
/** Only fixed codes and numbers: never paths, identities, receipts or relayed bytes. */
/** serviceMs spans spawn to exit, so launch delay before the broker's own clock starts is visible as serviceMs - elapsedMs. */
export interface BrokerDiagnostic {outcome: BrokerOutcome; exitCode: number | null; serviceMs: number; stage: string; win32Error: number | null; elapsedMs: number | null; slowStage: string; slowMs: number | null}
/**
 * Normal broker exit codes are {0, 1, 2, 3, 4}. Abnormal/crash exits include uncatchable kill signals (null),
 * signed Windows NTSTATUS error codes (< 0), unsigned 32-bit NTSTATUS codes (>= 0x80000000), or unexpected exit codes (> 4).
 */
export function isCrashExitCode(code: number | null): boolean {
  if (code === null) return true;
  if (!Number.isInteger(code)) return true;
  if (code < 0) return true;
  if ((code >>> 0) >= 0x80000000) return true;
  return code > 4;
}
/** A transient failure (pre-receipt contention/deadline, or unexpected mid-session exit/crash) may be retried after the broker has actually exited. */
export class NativeClientError extends Error {
  constructor(message: string, readonly outcome: BrokerOutcome, readonly transient = false) {super(message);}
}
function brokerDiagnostic(outcome: BrokerOutcome, exitCode: number | null, serviceMs: number, tail: Buffer): BrokerDiagnostic {
  const match = DIAGNOSTIC_LINE.exec(tail.toString('latin1'));
  if (!match) return {outcome, exitCode, serviceMs, stage: 'unreported', win32Error: null, elapsedMs: null, slowStage: 'unreported', slowMs: null};
  const known = (stage: string) => BROKER_STAGES.has(stage) ? stage : 'unrecognized';
  return {outcome, exitCode, serviceMs, stage: known(match[1]), win32Error: Number(match[2]), elapsedMs: Number(match[3]), slowStage: known(match[4]), slowMs: Number(match[5])};
}
/**
 * Bounds log growth while a failure repeats: a run of identical outcome/stage/error is recorded at
 * occurrences 1, 2, 4, 8, ... with its running count, so the bounded service log keeps room for other events.
 */
export function coalesceBrokerDiagnostics(record: (diagnostic: BrokerDiagnostic & {repeats: number}) => void): (diagnostic: BrokerDiagnostic) => void {
  let key: string | undefined, repeats = 0;
  return diagnostic => {
    const next = `${diagnostic.outcome}|${diagnostic.stage}|${String(diagnostic.win32Error)}`;
    repeats = next === key ? repeats + 1 : 1; key = next;
    if ((repeats & (repeats - 1)) === 0) record({...diagnostic, repeats});
  };
}
/** An owned fixed native artifact supplies OS authority; stdio credits bound its relay to one frame. */
export class NativePipeClient extends EventEmitter implements TelemetrySocket {
  authority?: SourceIdentity;
  readonly completion: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stopped = false;
  private buffer = Buffer.alloc(0);
  private receiptSeen = false;
  private helloSent = false;
  private creditOutstanding = false;
  private startup: ReturnType<typeof setTimeout>;
  private diagnosticTail = Buffer.alloc(0);
  private outcome?: BrokerOutcome;
  constructor(configuration: BrokerConfiguration, game: 'ets2' | 'ats', diagnose?: (diagnostic: BrokerDiagnostic) => void, private readonly protocol: BrokerProtocol = 'v0') {
    super();
    const spawned = performance.now();
    this.child = spawn(configuration.executable, ['--game', game, '--discovery-dir', configuration.discoveryDirectory, ...(protocol === 'v1' ? ['--protocol', 'v1'] : [])], {windowsHide: true, stdio: 'pipe'});
    this.completion = new Promise(resolve => this.child.once('close', () => resolve()));
    // A slow broker has granted nothing; retrying after its actual exit is safe.
    this.startup = setTimeout(() => this.reject('Native authority deadline exceeded', 'startup-deadline', true), 5000);
    // Retain only a bounded tail; it is parsed into fixed codes and never forwarded as text.
    this.child.stderr.on('data', (bytes: unknown) => {
      // Copy the tail so it never pins a whole stderr chunk.
      if (bytes instanceof Uint8Array) this.diagnosticTail = Buffer.from(Buffer.concat([this.diagnosticTail, bytes]).subarray(-DIAGNOSTIC_TAIL_BYTES));
    });
    this.child.stdin.on('error', () => this.reject('Native control pipe closed', 'control-closed'));
    this.child.on('error', () => this.reject('Native client could not start', 'start-failed'));
    this.child.once('close', code => {
      clearTimeout(this.startup);
      if (!this.stopped) {
        const diag = brokerDiagnostic('rejected', code, 0, this.diagnosticTail);
        const retryableAfterReceipt = Boolean(this.authority && ((code === 1 && diag.stage === 'unreported') || isCrashExitCode(code)));
        if (this.buffer.length) this.reject('Incomplete native relay frame', 'incomplete-frame', retryableAfterReceipt);
        else if (code === 2 && !this.authority) this.emit('waiting');
        // Exit 4 reports local contention before any authority receipt; after a receipt it is a contract violation.
        else if (code === 4 && !this.authority) this.reject('Native authority check met local contention', 'busy', true);
        else if (code !== 0 && code !== 3) {
          const reason = retryableAfterReceipt ? 'Native broker exited unexpectedly' : 'Native authority or connection rejected';
          this.reject(reason, 'rejected', retryableAfterReceipt);
        }
        else {this.outcome = 'ended'; this.emit('end');}
        this.stopped = true;
      }
      // Routine waiting exits and owner cancellation are not logged.
      if (this.outcome) diagnose?.(brokerDiagnostic(this.outcome, code, Math.round(performance.now() - spawned), this.diagnosticTail));
      this.emit('close');
    });
    this.child.stdout.on('data', (bytes: unknown) => {
      if (this.stopped) return;
      try {
        if (!(bytes instanceof Uint8Array)) throw new Error('Native relay bytes rejected');
        if (this.buffer.length + bytes.length > 65540) throw new Error('Native relay byte bound exceeded');
        this.buffer = Buffer.concat([this.buffer, bytes]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE();
          if (!length || length > (this.receiptSeen ? 65536 : 4096)) throw new Error('Native relay length rejected');
          if (this.buffer.length < length + 4) return;
          const frame = this.buffer.subarray(0, length + 4); this.buffer = this.buffer.subarray(length + 4);
          if (!this.receiptSeen) {
            const receipt: unknown = JSON.parse(frame.subarray(4).toString('utf8'));
            this.receiptSeen = true;
            if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Native authority receipt rejected');
            const record = receipt as Record<string, unknown>;
            if (record.type === 'waiting' && Object.keys(record).length === 2 && record.schemaVersion === 1) {
              if (this.buffer.length) throw new Error('Uncredited native receipt suffix');
              clearTimeout(this.startup); continue;
            }
            // A v1 broker marks its receipt with protocolMajor 1 (six keys); a v0 receipt has five. Neither mode accepts the other's.
            const v1 = this.protocol === 'v1';
            if (record.type !== 'authority' || record.schemaVersion !== 1 || Object.keys(record).length !== (v1 ? 6 : 5) || (v1 && record.protocolMajor !== 1) || !isUint64(record.processCreationTime) || typeof record.userTag !== 'string' || !/^[0-9a-f]{64}$/.test(record.userTag)) throw new Error('Native authority receipt rejected');
            if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) throw new Error('Native source authority rejected');
            const source = record.source as Record<string, unknown>;
            if (Object.keys(source).length !== 6 || source.game !== game || source.origin !== 'game' || typeof source.processId !== 'number' || !Number.isInteger(source.processId) || source.processId < 1 || source.processId > 0xffffffff || typeof source.windowsSessionId !== 'number' || !Number.isInteger(source.windowsSessionId) || source.windowsSessionId < 0 || source.windowsSessionId > 0xffffffff || typeof source.processInstanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.processInstanceId) || typeof source.pluginSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.pluginSessionId)) throw new Error('Native source authority rejected');
            // Bytes received before hello/credit cannot become authorized by the synchronous connect listener.
            if (this.buffer.length) throw new Error('Uncredited native receipt suffix');
            this.authority = Object.freeze({game, origin: source.origin, processId: source.processId, windowsSessionId: source.windowsSessionId, processInstanceId: source.processInstanceId, pluginSessionId: source.pluginSessionId}); clearTimeout(this.startup); this.emit('connect');
          } else {
            if (!this.creditOutstanding || !this.authority) throw new Error('Uncredited native relay frame');
            this.creditOutstanding = false;
            this.emit('data', frame);
            // Event listeners synchronously validate/apply; a rejected stream destroys this adapter.
            if (!this.stopped) {
              // The current input must contain only this credited frame, including across fragmented reads.
              if (this.buffer.length) throw new Error('Uncredited native frame suffix');
              this.credit();
            }
          }
        }
      } catch {this.reject('Native relay protocol rejected', 'relay-rejected');}
    });
  }
  /**
   * The first write is the framed hello, sent raw. In v0 and CAP0 any later write is rejected. In v1 each later write is one
   * framed client message (`ack` or `clock.probe`, validated by the broker), sent as tag 0x02 followed by its length prefix
   * and payload, so it can never be confused with a credit byte.
   */
  write(bytes: Uint8Array): void {
    if (this.protocol === 'v1' && this.helloSent && !this.stopped) {
      const length = bytes.length >= 4 ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).readUInt32LE() : 0;
      if (!length || length > MAX_CLIENT_FRAME_PAYLOAD || bytes.length !== length + 4) {this.reject('Native client frame rejected', 'client-frame-rejected'); return;}
      this.child.stdin.write(Buffer.concat([Buffer.from([CLIENT_FRAME_TAG]), bytes]));
      return;
    }
    if (this.stopped || !this.authority || this.helloSent || bytes.length > 4100) {this.reject('Native hello rejected', 'hello-rejected'); return;}
    this.helloSent = true; this.child.stdin.write(bytes); this.credit();
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.startup); this.buffer = Buffer.alloc(0);
    // EOF cancels the native owned I/O monitor; completion means the process has actually closed.
    this.child.stdin.end(); this.child.stdout.resume();
  }
  private credit(): void {if (this.creditOutstanding) {this.reject('Duplicate native relay credit', 'duplicate-credit'); return;} this.creditOutstanding = true; this.child.stdin.write(Buffer.from([CREDIT_TAG]));}
  private reject(reason: string, outcome: BrokerOutcome, transient = false): void {
    if (this.stopped) return; this.outcome = outcome; this.destroy(); this.emit('error', new NativeClientError(reason, outcome, transient));
  }
}
