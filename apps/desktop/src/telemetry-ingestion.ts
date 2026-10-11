import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {NativePipeClient, type TelemetrySocket, type BrokerConfiguration} from './native-pipe-client';
import {FrameDecoder, V0Consumer, encodeFrame, PROTOCOL_V0} from '../../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
import {initialLive, sourceSelection} from './live-state';
export {initialLive, sourceSelection} from './live-state';

export const TEST_PIPE_PATTERN = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface IngestionOptions {now?: () => number; connect?: (endpoint: string) => TelemetrySocket; staleMs?: number; handshakeMs?: number; broker?: BrokerConfiguration; connectGame?: (configuration: BrokerConfiguration, game: 'ets2' | 'ats') => TelemetrySocket}
/** Node pipe I/O is confined to explicitly selected isolated fixtures. Game authentication requires a native helper. */
export class TelemetryIngestion {
  private readonly clientInstanceId = randomUUID();
  private readonly now: () => number;
  private readonly connect: (endpoint: string) => TelemetrySocket;
  private socket?: TelemetrySocket;
  private readonly completions = new Set<Promise<void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private freshness?: ReturnType<typeof setInterval>;
  private generation = 0;
  private attempt = 0;
  private lastClock = -1;
  private live = initialLive();
  private endpoint?: string;
  private disposed = false;
  private pendingSelection?: {selection: SourceSelection; endpoint?: string};
  private transition?: Promise<void>;
  constructor(private readonly publish: (state: LiveTelemetry) => void, private readonly options: IngestionOptions = {}) {
    this.now = options.now ?? (() => performance.now()); this.connect = options.connect ?? (endpoint => net.connect(endpoint));
  }
  configureBroker(configuration: BrokerConfiguration | undefined): void {this.options.broker = configuration;}
  select(selection: SourceSelection, endpoint?: string): void {
    sourceSelection(selection); if (this.disposed) throw new Error('Ingestion stopped');
    this.cancel(); this.live = initialLive(selection); this.endpoint = endpoint; this.attempt = 0;
    this.pendingSelection = {selection, endpoint};
    if (this.transition) {this.emit('waiting', 'Previous source is closing'); return;}
    if (this.completions.size) {
      this.emit('waiting', 'Previous source is closing');
      this.transition = Promise.all(this.completions).then(() => {
        this.transition = undefined;
        const pending = this.pendingSelection;
        if (!this.disposed && pending) {this.pendingSelection = undefined; this.applySelection(pending.selection, pending.endpoint);}
      });
      return;
    }
    this.pendingSelection = undefined; this.applySelection(selection, endpoint);
  }
  private applySelection(selection: SourceSelection, endpoint?: string): void {
    this.endpoint = endpoint;
    if (selection === 'game') {this.emit('waiting', 'Select ETS2 or ATS explicitly'); return;}
    if (selection === 'ets2' || selection === 'ats') {
      if (!this.options.broker) {this.emit('unavailable', 'Verified native game pipe client is not configured'); return;}
      this.emit('waiting', 'Discovering selected game process'); this.open(); return;
    }
    if (!endpoint || !TEST_PIPE_PATTERN.test(endpoint)) {this.emit('unavailable', 'Selected fixture endpoint is not configured'); return;}
    this.emit('waiting', 'Connecting to explicitly selected fixture'); this.open();
  }
  async stop(): Promise<void> {this.disposed = true; this.pendingSelection = undefined; this.cancel(); await Promise.all(this.completions); await this.transition;}
  private clock(): number {
    const time = this.now(); if (!Number.isFinite(time) || time < this.lastClock || time < 0) throw new Error('Receive clock regressed');
    this.lastClock = time; return time;
  }
  private emit(status: LiveTelemetry['status'], reason: string, fresh = false): void {
    this.live = {...this.live, status, reason, fresh}; this.publish(this.live);
  }
  private open(): void {
    const generation = ++this.generation, decoder = new FrameDecoder(), consumer = new V0Consumer(false);
    let closed = false, hydrated = false;
    const selection = this.live.selection;
    const socket = this.socket = selection === 'ets2' || selection === 'ats' ? (this.options.connectGame ?? ((config, game) => new NativePipeClient(config, game)))(this.options.broker!, selection) : this.connect(this.endpoint!);
    if (socket.completion) {const completion = socket.completion; this.completions.add(completion); void completion.finally(() => this.completions.delete(completion));}
    const active = () => !closed && !this.disposed && generation === this.generation;
    const close = (status: LiveTelemetry['status'], reason: string, retry: boolean) => {
      if (!active()) return; closed = true;
      clearTimeout(this.handshake); clearInterval(this.freshness); this.handshake = undefined; this.freshness = undefined;
      socket.destroy(); this.socket = undefined; this.emit(status, reason);
      if (retry) this.retry = setTimeout(() => {
        this.retry = undefined;
        // Cancellation requests do not establish that the owned broker has exited.
        void Promise.all(this.completions).then(() => {
          if (!this.disposed && generation === this.generation) this.open();
        });
      }, Math.min(250 * 2 ** Math.min(this.attempt++, 4), 4000));
    };
    this.handshake = setTimeout(() => close('disconnected', 'Hello/checkpoint deadline exceeded', true), this.options.handshakeMs ?? 5000);
    socket.once('connect', () => {
      if (active()) socket.write(encodeFrame({version: PROTOCOL_V0, kind: 'hello', data: {clientInstanceId: this.clientInstanceId, minMinor: 0, maxMinor: 0, diagnostics: false}}));
    });
    socket.on('data', (bytes: unknown) => {
      if (!active()) return;
      try {
        if (!(bytes instanceof Uint8Array)) throw new Error('Invalid transport bytes');
        decoder.push(bytes, message => {
          if (message.kind === 'hello') throw new Error('Unexpected client direction');
          if (selection === 'ets2' || selection === 'ats') {
            const expected = socket.authority;
            if (!expected || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== message.source[key as keyof typeof expected])) throw new Error('Native source authority mismatch');
          } else if (message.source.origin !== selection) throw new Error('Selected source origin mismatch');
          const applied = consumer.accept(message);
          // Welcome does not establish a current observation or freshness.
          if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') return;
          const receivedMonotonicMs = this.clock();
          hydrated = true; this.attempt = 0; clearTimeout(this.handshake); this.handshake = undefined;
          this.live = {...this.live, observation: {source: message.source, state: message.data.state, seq: message.seq, receivedMonotonicMs, applied: applied!}};
          this.emit(message.data.state.simulation === 'paused' ? 'paused' : message.data.state.simulation === 'running' ? 'connected' : 'waiting', 'Validated current observation', message.data.state.simulation !== 'unavailable');
          if (!this.freshness) this.freshness = setInterval(() => {
            try {if (active() && this.live.fresh && this.clock() - this.live.observation!.receivedMonotonicMs >= (this.options.staleMs ?? 500)) this.emit('stale', 'No recent current observation');}
            catch {close('incompatible', 'Receive clock failure', false);}
          }, 50);
        });
      } catch {close('incompatible', 'Invalid protocol, ordering or selected source identity', false);}
    });
    socket.on('error', () => close(selection === 'ets2' || selection === 'ats' ? 'incompatible' : 'disconnected', selection === 'ets2' || selection === 'ats' ? 'Native source authority or transport failed' : 'Selected fixture connection failed', selection !== 'ets2' && selection !== 'ats'));
    socket.on('waiting', () => close('waiting', 'No selected game discovery record', true));
    socket.on('end', () => {
      try {decoder.end(); close('disconnected', hydrated ? 'Source disconnected; interval coverage unknown' : 'Source ended before checkpoint', true);}
      catch {close('incompatible', 'Incomplete protocol frame', false);}
    });
    socket.on('close', () => close('disconnected', 'Source closed; interval coverage unknown', true));
  }
  private cancel(): void {
    ++this.generation; clearTimeout(this.retry); clearTimeout(this.handshake); clearInterval(this.freshness);
    this.retry = undefined; this.handshake = undefined; this.freshness = undefined;
    this.socket?.destroy(); this.socket = undefined;
  }
}
