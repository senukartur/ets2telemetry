// Protocol v1 ingestion in the telemetry service (ET-006b, E2, E5, E9, E10). It validates each connection's hello,
// welcome, checkpoint, snapshots, events, gaps, clock replies and `end` through the ET-002b V1Consumer, checks every
// envelope against the selected source, keeps service-internal live state, measures the source clock and, when a
// durable sink is configured, hands events, gaps and the durable connection's checkpoint and snapshots to the
// storage-commit ACK pipeline (v1-durable-delivery.ts). The telemetry service runs it beside v0 without a sink, so in
// production it records nothing and sends no ACK. See docs/telemetry-service-v1.md.
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type CaptureTime, type Continuity, type CurrentState, type EndData, type ServerMessage, type SourceIdentity, type SourceStatus, type Uint64} from '../../../packages/contracts/src/protocol-v1';
import {V1Consumer, computeClockMapping, isClockMappingCurrent, type ClockMapping} from '../../../packages/contracts/src/protocol-v1-delivery';
import type {LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
import type {DiagnosticFacts} from './diagnostics';
import type {DurableSink} from './durable-sink';
import {sourceSelection} from './live-state';
import {NativeClientError, type BrokerConfiguration, type TelemetrySocket} from './native-pipe-client';
import {DurableDelivery, type DurableCloseKind, type DurableConnection, type DurableStatus} from './v1-durable-delivery';

/** Desktop-local copy of the simulator's synthetic endpoint pattern: `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}`. */
export const TEST_PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** E9: reconnect delays 250, 500, 1000, 2000, then 4000 ms; they restart at a live-only checkpoint or a durable connection's first commit. */
export const V1_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
export const V1_STALE_MS = 500;
export const V1_HANDSHAKE_MS = 5000;
export const V1_PROBE_INTERVAL_MS = 1000;
const FRESHNESS_TICK_MS = 50;

export type V1Status = Exclude<LiveTelemetry['status'], 'service-failed' | 'restarting'>;
/** The latest checkpoint or snapshot. `receivedMonotonicMs` advances only when `state.boundaryOrder` does (OD-5 S7). */
export interface V1Observation {
  kind: 'checkpoint' | 'snapshot'; source: SourceIdentity; seq: Uint64; capture: CaptureTime;
  state: CurrentState; status: SourceStatus; continuity: Continuity; receivedMonotonicMs: number;
  /** True for the checkpoint: it replaces current state only and never yields an event (REG-003, REG-004). */
  hydration: boolean;
}
/** Service-internal v1 source state (E2). No preload, IPC or renderer receives it yet; ET-010c exposes it. */
export interface V1SourceState {
  selection: SourceSelection; status: V1Status; reason: string; fresh: boolean;
  observation?: V1Observation;
  /** Local-only mapping from the source clock to this service's clock (§11); never a wire field. */
  clockMapping?: ClockMapping;
  /** The last `end` received, kept across reconnections. */
  lastEnd?: EndData;
  durable: DurableStatus;
}
export interface V1IngestionOptions {
  /** Service receive clock in milliseconds; freshness and staleness use it. */
  now?: () => number;
  /** Client monotonic clock in nanoseconds for clock probes; defaults to process.hrtime.bigint. */
  nowNs?: () => bigint;
  /** Fixture sockets for explicitly selected synthetic or replay endpoints. */
  connect?: (endpoint: string) => TelemetrySocket;
  /** The native broker in v1 mode for game selections; without it a game selection stays unavailable. */
  connectGame?: (configuration: BrokerConfiguration, game: 'ets2' | 'ats') => TelemetrySocket;
  broker?: BrokerConfiguration;
  /** Durable storage. Without it every hello is live-only and nothing is acknowledged. */
  sink?: DurableSink;
  /**
   * R10: the selections whose connections may request durable delivery; every selection when omitted. A hello of any
   * other selection is live-only even with a sink.
   */
  durableSelections?: readonly SourceSelection[];
  /** R10: whether storage is open now; a hello requests durable delivery only while it returns true. Default: always. */
  durableReady?: () => boolean;
  /** R8: the consumer's UTC clock in milliseconds for the receipt label of each event and gap; defaults to Date.now. */
  utcNow?: () => number;
  staleMs?: number; handshakeMs?: number; probeIntervalMs?: number; maxPendingCommits?: number; maxPendingReadings?: number;
  /** Fixed codes and numbers only. */
  diagnose?: (event: string, facts?: DiagnosticFacts) => void;
  onState?: (state: V1SourceState) => void;
}

/** The service receive clock went backwards or is not finite; not a protocol violation of the source. */
class ReceiveClockError extends Error {}

function initialState(selection: SourceSelection, durable: DurableStatus): V1SourceState {
  return {selection, status: 'waiting', reason: 'Awaiting selected source', fresh: false, durable};
}

/** One v1 source at a time. Node pipe I/O is confined to explicitly selected synthetic fixtures. */
export class V1Ingestion {
  /** One client instance and one client clock per service lifetime (§4, §11). */
  readonly clientInstanceId = randomUUID();
  readonly clientClockId = randomUUID();
  private readonly now: () => number;
  private readonly nowNs: () => bigint;
  private readonly connect: (endpoint: string) => TelemetrySocket;
  private readonly utcNow: () => number;
  private readonly delivery?: DurableDelivery;
  private socket?: TelemetrySocket;
  /** The current connection while it is open and live-only: its plugin session once known, and how to end it (R10). */
  private liveOnly?: {pluginSessionId?: string; reconnect: () => void};
  /**
   * Whether the latest hello of the current selection requested durable delivery; undefined before its first hello. It
   * is kept after that connection closes: after a retryable storage failure the reconnection reports `pending`, and
   * after a plain source disconnection the pipeline's `active` remains until the next welcome.
   */
  private requestedDurable?: boolean;
  private readonly completions = new Set<Promise<void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private freshness?: ReturnType<typeof setInterval>;
  private probes?: ReturnType<typeof setInterval>;
  private generation = 0;
  private attempt = 0;
  private lastClock = -1;
  private state: V1SourceState;
  private endpoint?: string;
  private disposed = false;
  private pendingSelection?: {selection: SourceSelection; endpoint?: string};
  private transition?: Promise<void>;
  constructor(private readonly options: V1IngestionOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    this.connect = options.connect ?? (endpoint => net.connect(endpoint));
    this.utcNow = options.utcNow ?? (() => Date.now());
    if (options.sink) {
      this.delivery = new DurableDelivery(options.sink, {maxPendingCommits: options.maxPendingCommits, maxPendingReadings: options.maxPendingReadings,
        log: options.diagnose, onStatus: () => this.publish()});
    }
    this.state = initialState('game', this.durableStatus());
  }
  /** The current service-internal state. */
  get current(): V1SourceState { return this.state; }
  configureBroker(configuration: BrokerConfiguration | undefined): void { this.options.broker = configuration; }
  select(selection: SourceSelection, endpoint?: string): void {
    sourceSelection(selection); if (this.disposed) throw new Error('Ingestion stopped');
    this.cancel(); this.requestedDurable = undefined;
    this.state = initialState(selection, this.durableStatus()); this.endpoint = endpoint; this.attempt = 0;
    this.pendingSelection = {selection, endpoint};
    if (this.transition) { this.emit('waiting', 'Previous source is closing'); return; }
    if (this.completions.size) {
      this.emit('waiting', 'Previous source is closing');
      this.transition = Promise.all(this.completions).then(() => {
        this.transition = undefined;
        const pending = this.pendingSelection;
        if (!this.disposed && pending) { this.pendingSelection = undefined; this.applySelection(pending.selection, pending.endpoint); }
      });
      return;
    }
    this.pendingSelection = undefined; this.applySelection(selection, endpoint);
  }
  /**
   * R10: storage became ready (or durable delivery became possible otherwise). A current live-only connection that could
   * now request durable delivery is closed and reconnects at once on the shortest backoff; nothing else changes.
   */
  durableAvailabilityChanged(): void {
    const current = this.liveOnly;
    if (this.disposed || !current || !this.durableWanted(current.pluginSessionId)) return;
    this.attempt = 0; current.reconnect();
  }
  /**
   * Ends the source and waits for owned processes (the intake phase of a shutdown). Nothing is acknowledged afterwards;
   * the storage-commit pipeline keeps its work until `flush`.
   */
  async stopSource(): Promise<void> {
    this.disposed = true; this.pendingSelection = undefined; this.cancel();
    await Promise.all(this.completions); await this.transition;
  }
  /** Drops queued durable work and waits for the one storage command in flight; nothing is written afterwards (R14). */
  async flush(): Promise<void> { await this.delivery?.stop(); }
  /** Ends the source, waits for owned processes and then for the one storage command in flight. */
  async stop(): Promise<void> { await this.stopSource(); await this.flush(); }
  /**
   * The reported durable status. `failed` is always reported, so a failure for the service lifetime (or the
   * ACK_AHEAD_OF_STORAGE block) stays visible on the live-only connections after it. Otherwise the pipeline's `pending`
   * or `active` is reported only when the latest hello requested durable delivery: a connection that did not (a selection
   * outside `durableSelections`, storage not ready, a refused open) and a selection without a hello yet report `off`.
   */
  private durableStatus(): DurableStatus {
    if (!this.delivery) return {state: 'off'};
    const status = this.delivery.status;
    return status.state === 'failed' || this.requestedDurable === true ? status : {state: 'off'};
  }
  /** R10: whether a hello now may request durable delivery for this selection and, when known, plugin session. */
  private durableWanted(pluginSessionId?: string): boolean {
    if (!this.delivery?.durableAllowed(pluginSessionId)) return false;
    const selections = this.options.durableSelections;
    if (selections !== undefined && !selections.includes(this.state.selection)) return false;
    return this.options.durableReady?.() ?? true;
  }
  private applySelection(selection: SourceSelection, endpoint?: string): void {
    this.endpoint = endpoint;
    if (selection === 'game') { this.emit('waiting', 'Select ETS2 or ATS explicitly'); return; }
    if (selection === 'ets2' || selection === 'ats') {
      if (!this.options.broker || !this.options.connectGame) { this.emit('unavailable', 'Verified native v1 game pipe client is not configured'); return; }
      this.emit('waiting', 'Discovering selected game process'); this.open(); return;
    }
    if (!endpoint || !TEST_PIPE_PATTERN_V1.test(endpoint)) { this.emit('unavailable', 'Selected v1 fixture endpoint is not configured'); return; }
    this.emit('waiting', 'Connecting to explicitly selected fixture'); this.open();
  }
  private clock(): number {
    const time = this.now(); if (!Number.isFinite(time) || time < this.lastClock || time < 0) throw new Error('Receive clock regressed');
    this.lastClock = time; return time;
  }
  private publish(): void {
    this.state = {...this.state, durable: this.durableStatus()};
    this.options.onState?.(this.state);
  }
  private emit(status: V1Status, reason: string, fresh = false): void {
    this.state = {...this.state, status, reason, fresh}; this.publish();
  }
  private open(): void {
    const generation = ++this.generation, decoder = new FrameDecoder('server');
    let closed = false, ended = false, hydrated = false, probeId = 0n, probeSentNs = 0n;
    let durable: DurableConnection | undefined;
    const selection = this.state.selection, game = selection === 'ets2' || selection === 'ats';
    const socket = this.socket = game ? this.options.connectGame!(this.options.broker!, selection) : this.connect(this.endpoint!);
    if (socket.completion) { const completion = socket.completion; this.completions.add(completion); void completion.finally(() => this.completions.delete(completion)); }
    const active = () => !closed && !this.disposed && generation === this.generation;
    // Fixed at 'connect', when the hello is written: the native client sets its authority receipt, which names the plugin
    // session, just before it emits 'connect'; a fixture socket has no authority.
    let requested = false, consumer: V1Consumer | undefined, liveOnly: V1Ingestion['liveOnly'];
    const close = (status: V1Status, reason: string, retry: boolean) => {
      if (!active()) return; closed = true;
      if (this.liveOnly === liveOnly) this.liveOnly = undefined;
      clearTimeout(this.handshake); clearInterval(this.freshness); clearInterval(this.probes);
      this.handshake = undefined; this.freshness = undefined; this.probes = undefined;
      socket.destroy(); this.socket = undefined;
      this.emit(status, reason);
      if (retry) this.retry = setTimeout(() => {
        this.retry = undefined;
        // Cancellation requests do not establish that an owned broker has exited.
        void Promise.all(this.completions).then(() => { if (!this.disposed && generation === this.generation) this.open(); });
      }, V1_BACKOFF_MS[Math.min(this.attempt++, V1_BACKOFF_MS.length - 1)]);
    };
    // E9: a durable connection proves itself healthy with its first successful commit, a live-only one with its checkpoint;
    // only then does the reconnect backoff restart, so a persistent retryable storage failure keeps backing off.
    const healthy = () => { if (active()) this.attempt = 0; };
    const link = {
      committed: healthy,
      current: () => active() && !ended,
      write: (bytes: Uint8Array) => { if (active() && !ended) socket.write(bytes); },
      close: (kind: DurableCloseKind, code: string) => close('disconnected', kind === 'retryable' ? `Durable commit not completed (${code}); retrying` : `Durable delivery stopped (${code}); reconnecting live-only`, true)
    };
    const sendProbe = () => {
      if (!active() || ended || !consumer || consumer.clockProbeOutstanding) return;
      // At most one outstanding probe; a late reply still ends it, and no new probe is sent before it arrives (§11).
      probeId++; consumer.expectClockReply(probeId.toString()); probeSentNs = this.nowNs();
      socket.write(encodeFrame({version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: probeId.toString()}}));
    };
    const observe = (message: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>) => {
      let receipt: number;
      try { receipt = this.clock(); } catch { throw new ReceiveClockError(); }
      const previous = this.state.observation;
      // A new SDK boundary is a new observation; a resent state keeps its original receipt time.
      const newBoundary = !hydrated || !previous || BigInt(message.data.state.boundaryOrder) > BigInt(previous.state.boundaryOrder);
      const receivedMonotonicMs = newBoundary || !previous ? receipt : previous.receivedMonotonicMs;
      hydrated = true;
      this.state = {...this.state, observation: {kind: message.kind, source: message.source, seq: message.seq, capture: message.capture, state: message.data.state,
        status: message.data.status, continuity: message.data.continuity, receivedMonotonicMs, hydration: message.kind === 'checkpoint'}};
      const simulation = message.data.state.simulation, staleMs = this.options.staleMs ?? V1_STALE_MS;
      const fresh = simulation !== 'unavailable' && receipt - receivedMonotonicMs < staleMs;
      this.emit(fresh ? simulation === 'paused' ? 'paused' : 'connected' : simulation === 'unavailable' ? 'waiting' : 'stale',
        fresh ? 'Validated current observation' : 'No recent SDK capture', fresh);
      this.freshness ??= setInterval(() => {
        try {
          if (!active()) return;
          const now = this.clock(), observation = this.state.observation!;
          if (this.state.fresh && now - observation.receivedMonotonicMs >= staleMs) this.emit('stale', 'No recent SDK capture');
        } catch { close('incompatible', 'Receive clock failure', false); }
      }, FRESHNESS_TICK_MS);
    };
    this.handshake = setTimeout(() => close('disconnected', 'Hello/checkpoint deadline exceeded', true), this.options.handshakeMs ?? V1_HANDSHAKE_MS);
    socket.once('connect', () => {
      if (!active()) return;
      requested = this.durableWanted(socket.authority?.pluginSessionId); consumer = new V1Consumer(requested);
      if (this.delivery && requested !== this.requestedDurable) { this.requestedDurable = requested; this.publish(); }
      if (!requested && this.delivery) {
        liveOnly = this.liveOnly = {pluginSessionId: socket.authority?.pluginSessionId,
          reconnect: () => close('disconnected', 'Durable delivery available; reconnecting durable', true)};
      }
      socket.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: this.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: requested}}));
    });
    socket.on('data', (bytes: unknown) => {
      if (!active()) return;
      try {
        if (!(bytes instanceof Uint8Array)) throw new Error('Invalid transport bytes');
        decoder.push(bytes, decoded => {
          // A connection the pipeline or a previous message closed applies nothing more from this read.
          if (!active()) return;
          if (decoded.kind === 'hello' || decoded.kind === 'ack' || decoded.kind === 'clock.probe') throw new Error('Unexpected client direction');
          if (!consumer) throw new Error('Server bytes before the hello');
          const message = decoded;
          if (game) {
            const expected = socket.authority;
            if (!expected || expected.origin !== 'game' || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== message.source[key as keyof SourceIdentity])) throw new Error('Native source authority mismatch');
          } else if (message.source.origin !== selection) throw new Error('Selected source origin mismatch');
          const applied = consumer.accept(message);
          switch (message.kind) {
            case 'welcome': {
              const session = message.source.pluginSessionId;
              if (liveOnly) liveOnly.pluginSessionId = session;
              if (this.state.clockMapping && !isClockMappingCurrent(this.state.clockMapping, message.capture.clockId, this.clientClockId)) this.state = {...this.state, clockMapping: undefined};
              if (message.data.durableEvents && this.delivery) durable = this.delivery.connect(message, link);
              // A live-only connection after ACK_AHEAD_OF_STORAGE that names a new plugin session reconnects durable.
              else if (this.delivery && !requested && this.delivery.observeLiveOnly(session)) close('disconnected', 'New plugin session; reconnecting durable', true);
              return;
            }
            case 'checkpoint':
              if (!durable) healthy();
              clearTimeout(this.handshake); this.handshake = undefined;
              // R5: the checkpoint starts the connection's cursor and is the recorder's first reading, in FIFO order.
              durable?.checkpoint(message);
              observe(message);
              this.probes ??= setInterval(sendProbe, this.options.probeIntervalMs ?? V1_PROBE_INTERVAL_MS);
              sendProbe();
              return;
            case 'snapshot': observe(message); durable?.snapshot(message); return;
            case 'event': case 'gap':
              // The consumer accepts coverage only on a durable connection; receipt is never an ACK.
              if (!durable || !applied.coverage) throw new Error('Coverage without a durable connection');
              // R8: the receipt label is taken when the frame is decoded, never when its commit runs.
              durable.enqueue(applied.coverage, message, this.utcNow());
              return;
            case 'clock.reply': {
              const mapping = computeClockMapping({reply: message, probeId: probeId.toString(), clientClockId: this.clientClockId, probeSentNs: probeSentNs.toString(), replyReceivedNs: this.nowNs().toString()});
              // A late reply is accepted but gives no mapping (§11).
              if (mapping) { this.state = {...this.state, clockMapping: mapping}; this.publish(); }
              return;
            }
            case 'end':
              // `end` is terminal: any later frame of this read is rejected by the consumer before the connection closes.
              ended = true; this.state = {...this.state, lastEnd: message.data};
              return;
          }
        });
        if (ended) close('disconnected', `Source ended (${this.state.lastEnd!.reason})`, true);
      } catch (error) { close('incompatible', error instanceof ReceiveClockError ? 'Receive clock failure' : 'Invalid protocol, ordering or selected source identity', false); }
    });
    socket.on('error', (error: unknown) => {
      if (!game) close('disconnected', 'Selected fixture connection failed', true);
      // A broker that granted no authority (deadline, local contention) retries on the normal backoff; rejections stay final.
      else if (error instanceof NativeClientError && error.transient) close('waiting', 'Native authority check did not complete; retrying', true);
      else close('incompatible', 'Native source authority or transport failed', false);
    });
    socket.on('waiting', () => close('waiting', 'No selected game discovery record', true));
    socket.on('end', () => {
      try { decoder.end(); close('disconnected', hydrated ? 'Source disconnected; interval coverage unknown' : 'Source ended before checkpoint', true); }
      catch { close('incompatible', 'Incomplete protocol frame', false); }
    });
    socket.on('close', () => close('disconnected', 'Source closed; interval coverage unknown', true));
  }
  private cancel(): void {
    ++this.generation; this.liveOnly = undefined; clearTimeout(this.retry); clearTimeout(this.handshake); clearInterval(this.freshness); clearInterval(this.probes);
    this.retry = undefined; this.handshake = undefined; this.freshness = undefined; this.probes = undefined;
    this.socket?.destroy(); this.socket = undefined;
  }
}
