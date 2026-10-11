import {EventEmitter} from 'node:events';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import {isUint64} from '../../../packages/contracts/src/protocol-v0';

export interface TelemetrySocket extends Pick<EventEmitter, 'on' | 'once'> {
  authority?: SourceIdentity;
  completion?: Promise<void>;
  write(bytes: Uint8Array): unknown;
  destroy(): unknown;
}
export interface BrokerConfiguration {executable: string; discoveryDirectory: string}
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
  constructor(configuration: BrokerConfiguration, game: 'ets2' | 'ats') {
    super();
    this.child = spawn(configuration.executable, ['--game', game, '--discovery-dir', configuration.discoveryDirectory], {windowsHide: true, stdio: 'pipe'});
    this.completion = new Promise(resolve => this.child.once('close', () => resolve()));
    this.startup = setTimeout(() => this.reject('Native authority deadline exceeded'), 5000);
    // Drain fixed-error diagnostics without forwarding peer data to logs or accumulating text.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.reject('Native control pipe closed'));
    this.child.on('error', () => this.reject('Native client could not start'));
    this.child.once('close', code => {
      clearTimeout(this.startup);
      if (!this.stopped) {
        if (this.buffer.length) this.reject('Incomplete native relay frame');
        else if (code === 2 && !this.authority) this.emit('waiting');
        else if (code !== 0 && code !== 3) this.reject('Native authority or connection rejected');
        else this.emit('end');
        this.stopped = true;
      }
      this.emit('close');
    });
    this.child.stdout.on('data', bytes => {
      if (this.stopped) return;
      try {
        if (this.buffer.length + bytes.length > 65540) throw new Error('Native relay byte bound exceeded');
        this.buffer = Buffer.concat([this.buffer, bytes]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE();
          if (!length || length > (this.receiptSeen ? 65536 : 4096)) throw new Error('Native relay length rejected');
          if (this.buffer.length < length + 4) return;
          const frame = this.buffer.subarray(0, length + 4); this.buffer = this.buffer.subarray(length + 4);
          if (!this.receiptSeen) {
            const receipt = JSON.parse(frame.subarray(4).toString('utf8'));
            this.receiptSeen = true;
            if (receipt.type === 'waiting' && Object.keys(receipt).length === 2 && receipt.schemaVersion === 1) {clearTimeout(this.startup); continue;}
            if (receipt.type !== 'authority' || receipt.schemaVersion !== 1 || Object.keys(receipt).length !== 5 || !isUint64(receipt.processCreationTime) || !/^[0-9a-f]{64}$/.test(receipt.userTag)) throw new Error('Native authority receipt rejected');
            const source = receipt.source as SourceIdentity;
            if (!source || Object.keys(source).length !== 6 || source.game !== game || source.origin !== 'game' || !Number.isInteger(source.processId) || source.processId < 1 || source.processId > 0xffffffff || !Number.isInteger(source.windowsSessionId) || source.windowsSessionId < 0 || source.windowsSessionId > 0xffffffff || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.processInstanceId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.pluginSessionId)) throw new Error('Native source authority rejected');
            this.authority = Object.freeze(source); clearTimeout(this.startup); this.emit('connect');
          } else {
            if (!this.creditOutstanding || !this.authority) throw new Error('Uncredited native relay frame');
            this.creditOutstanding = false;
            this.emit('data', frame);
            // Event listeners synchronously validate/apply; a rejected stream destroys this adapter.
            if (!this.stopped) this.credit();
          }
        }
      } catch {this.reject('Native relay protocol rejected');}
    });
  }
  write(bytes: Uint8Array): void {
    if (this.stopped || !this.authority || this.helloSent || bytes.length > 4100) {this.reject('Native hello rejected'); return;}
    this.helloSent = true; this.child.stdin.write(bytes); this.credit();
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.startup); this.buffer = Buffer.alloc(0);
    // EOF cancels the native owned I/O monitor; completion means the process has actually closed.
    this.child.stdin.end(); this.child.stdout.resume();
  }
  private credit(): void {if (this.creditOutstanding) {this.reject('Duplicate native relay credit'); return;} this.creditOutstanding = true; this.child.stdin.write(Buffer.from([1]));}
  private reject(reason: string): void {if (this.stopped) return; this.destroy(); this.emit('error', new Error(reason));}
}
