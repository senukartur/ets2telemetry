import {randomUUID} from 'node:crypto';
import {encodeFrame} from '../../../packages/contracts/src/protocol-v1';
import type {StorageClient} from '../../../packages/storage/src/client';
import type {DiagnosticFacts} from './diagnostics';
import type {CommitContext, DurableSink, HardModeCapture, ReadingMessage, SinkResult, WelcomeMessage} from './durable-sink';
import {EmergencyJournal, EmergencyJournalFull, EmergencyJournalIntegrityError, type EmergencyEntry, type JournalFrame} from './emergency-journal';
import type {DurableLink, DurableStatus} from './v1-durable-delivery';
import type {IngestionDelivery, IngestionConnection} from './v1-ingestion';

const MAX_INTAKE = 512;
const MIRROR_RETRY_MS = 1000;
const WRITE_RETRY_MS = [250, 500, 1000, 2000, 4000];
const MAX_WRITE_RETRIES = 60;
type IntakeLink = {connection: string; welcome: WelcomeMessage; link: DurableLink; acknowledged: bigint; trusted: boolean};
type ProjectionSink = {client: StorageClient; sink: DurableSink};
type LiveEntry = {owner: ProjectionSink; capture?: HardModeCapture};

class ProjectionError extends Error {
  constructor(readonly code: string) { super(code); }
}
function stored<T>(result: SinkResult<T>): T {
  if (!result.ok) throw new ProjectionError(result.error.code);
  return result.value;
}

/**
 * Intake can keep writing files while the SQLite worker is busy or unavailable. The database consumes the journal in
 * order and removes each entry only after its event, attach work and samples are stored.
 */
export class EmergencyDelivery implements IngestionDelivery {
  private current: DurableStatus = {state: 'pending'};
  private retrying?: string;
  private ready = false;
  private initialized = false;
  private full = false;
  private invalid = false;
  private stopped = false;
  private accepting = Promise.resolve();
  private projected?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private writeRetry?: ReturnType<typeof setTimeout>;
  private probing?: Promise<void>;
  private queued = 0;
  private latest?: IntakeLink;
  private trusted?: {session: string; through: bigint};
  private blockedSession?: string;
  private recorder?: ProjectionSink;
  private context?: {connection: string; owner: ProjectionSink};
  private readonly live = new Map<number, LiveEntry>();
  private reported?: string;

  constructor(
    private readonly journal: EmergencyJournal,
    private readonly client: () => StorageClient | undefined,
    private readonly sink: (client: StorageClient) => DurableSink,
    private readonly changed: () => void,
    private readonly sourceReady: () => void,
    private readonly log: (event: string, facts: DiagnosticFacts) => void
  ) {}

  get status(): DurableStatus { return this.current; }
  get retryCode(): string | undefined { return this.retrying; }
  get buffered(): boolean { return this.journal.pending > 0; }
  durableAllowed(pluginSessionId?: string): boolean {
    return this.ready && !this.stopped && (!this.blockedSession || pluginSessionId !== undefined && pluginSessionId !== this.blockedSession);
  }
  observeLiveOnly(pluginSessionId: string): boolean {
    if (!this.blockedSession || this.blockedSession === pluginSessionId) return false;
    this.blockedSession = undefined;
    this.current = {state: 'pending'};
    this.changed();
    return true;
  }

  async start(): Promise<void> {
    try {
      await this.journal.initialize();
      await this.journal.head();
    } catch (error) {
      this.failJournal(error instanceof EmergencyJournalIntegrityError ? 'INTEGRITY' : 'OPEN');
      return;
    }
    if (this.stopped) return;
    this.initialized = true;
    this.ready = true;
    this.log('EMERGENCY_JOURNAL_READY', {pending: this.journal.pending});
    this.changed();
    this.sourceReady();
    this.kick();
  }

  connect(welcome: WelcomeMessage, link: DurableLink): IngestionConnection {
    const connection = randomUUID();
    const active = {connection, welcome, link, acknowledged: 0n, trusted: false};
    this.latest = active;
    if (this.ready) {
      this.current = {state: 'pending'};
      this.changed();
    }
    let checkpoint: Extract<ReadingMessage, {kind: 'checkpoint'}> | undefined;
    let checkpointReceivedUtcMs = 0;
    let before = '0';
    let second: bigint | undefined;
    let boundaryOrder = 0n;
    let boundaryKey: string | undefined;
    const key = (frame: ReadingMessage) => {
      const {state, continuity} = frame.data;
      return `${state.simulation}/${state.configuration.revision}/${state.gameTime.clockId}/${continuity.offlineTransitions}`;
    };
    let dropped = false;
    let cannotPublish = false;
    const drop = (code: string) => {
      dropped = true;
      if (link.current()) link.close('retryable', code);
    };
    const queue = (message: JournalFrame, receivedUtcMs: number) => {
      if (!checkpoint || dropped || !this.durableAllowed(welcome.source.pluginSessionId)) return;
      if (this.queued >= MAX_INTAKE) {
        this.log('EMERGENCY_JOURNAL_INTAKE_LIMIT', {pending: this.queued});
        drop('BACKLOG_FULL');
        return;
      }
      const entry = {connection, welcome, checkpoint, checkpointReceivedUtcMs, before, message, receivedUtcMs};
      if (message.kind === 'event') before = message.data.eventSeq;
      if (message.kind === 'gap') before = message.data.lastEventSeq;
      let live: LiveEntry | undefined;
      const client = this.client();
      if (client && !this.retrying && this.queued + this.live.size < MAX_INTAKE) {
        const owner = this.recorderFor(client);
        const capture = message.kind === 'event' || message.kind === 'gap' ? owner.sink.capture?.(message) : undefined;
        live = {owner, capture};
      }
      this.queued++;
      this.accepting = this.accepting.then(async () => {
        if (cannotPublish) return;
        if (!this.ready) { cannotPublish = true; if (!this.invalid) drop('IO_ERROR'); return; }
        let sequence: number;
        try { sequence = await this.journal.append(entry); }
        catch (error) {
          cannotPublish = true;
          this.full = error instanceof EmergencyJournalFull;
          const code = this.full ? 'STORAGE_BUSY' : 'IO_ERROR';
          this.failJournal(this.full ? 'LIMIT' : 'WRITE', code);
          drop(code);
          if (!this.full) this.retryWrite(0);
          return;
        }
        if (!this.ready) return;
        if (live && live.owner === this.recorder && this.client() === live.owner.client) {
          this.live.set(sequence, live);
          live = undefined;
        }
        if (message.kind === 'checkpoint') {
          const point = BigInt(entry.before), session = welcome.source.pluginSessionId;
          active.acknowledged = point;
          active.trusted = point === 0n || (this.trusted?.session === session && this.trusted.through >= point);
          if (link.current()) {
            this.current = {state: 'active'};
            this.changed();
            link.committed?.();
          }
        } else if (active.trusted) {
          if (message.kind === 'event') this.ack(active, message.data.eventSeq);
          if (message.kind === 'gap') this.ack(active, message.data.lastEventSeq);
        }
        if (message.kind !== 'checkpoint' && this.buffered && !this.client()) this.changed();
        this.kick();
      }).finally(() => {
        this.releaseCapture(live);
        this.queued--;
      });
    };
    return {
      checkpoint: (frame, receivedUtcMs) => {
        checkpoint = frame;
        checkpointReceivedUtcMs = receivedUtcMs;
        boundaryOrder = BigInt(frame.data.state.boundaryOrder);
        boundaryKey = key(frame);
        before = frame.data.status.delivery.ackedThroughEventSeq;
        queue(frame, receivedUtcMs);
      },
      snapshot: (frame, receivedUtcMs) => {
        const order = BigInt(frame.data.state.boundaryOrder);
        if (order <= boundaryOrder) return;
        boundaryOrder = order;
        const currentSecond = BigInt(frame.capture.monotonicNs) / 1_000_000_000n;
        const frameKey = key(frame);
        if (second === currentSecond && boundaryKey === frameKey) return;
        second = currentSecond;
        boundaryKey = frameKey;
        queue(frame, receivedUtcMs);
      },
      enqueue: (_coverage, frame, receivedUtcMs) => { queue(frame, receivedUtcMs); }
    };
  }

  /** History opened or was replaced. A retired recorder cannot process the next entry on the new worker. */
  storageChanged(): void {
    this.releaseLiveEntries();
    clearTimeout(this.retry);
    this.retry = undefined;
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.writeRetry);
    await this.accepting;
    await this.projected;
    await this.probing;
    this.releaseLiveEntries();
  }

  private failJournal(stage: string, code = 'IO_ERROR'): void {
    this.ready = false;
    this.current = {state: 'failed', code};
    this.log('EMERGENCY_JOURNAL_UNAVAILABLE', {stage});
    this.changed();
  }

  private retryWrite(attempt: number): void {
    if (this.stopped || this.invalid || attempt >= MAX_WRITE_RETRIES) return;
    this.writeRetry = setTimeout(() => {
      this.probing = this.journal.probe().then(() => {
        if (!this.stopped && !this.invalid) this.resumeIntake();
      }, () => this.retryWrite(attempt + 1)).finally(() => { this.probing = undefined; });
    }, WRITE_RETRY_MS[Math.min(attempt, WRITE_RETRY_MS.length - 1)]);
  }

  private resumeIntake(): void {
    this.full = false;
    this.ready = true;
    this.current = {state: 'pending'};
    this.changed();
    this.sourceReady();
  }

  private ack(active: IntakeLink, through: string): void {
    const point = BigInt(through);
    if (this.invalid || !active.link.current() || point <= active.acknowledged) return;
    active.acknowledged = point;
    const {welcome} = active;
    this.trusted = {session: welcome.source.pluginSessionId, through: point};
    try {
      active.link.write(encodeFrame({kind: 'ack', version: welcome.version,
        data: {pluginSessionId: welcome.source.pluginSessionId, throughEventSeq: through}}, {maxMinor: welcome.version.minor}));
    } catch { active.link.close('retryable', 'IO_ERROR'); }
  }

  private kick(): void {
    if (!this.initialized || this.invalid || this.stopped || this.projected || this.retry || this.journal.pending === 0 || !this.client()) return;
    this.projected = this.drain().finally(() => {
      this.projected = undefined;
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const client = this.client();
        if (!client) return;
        const pending = await this.journal.head();
        if (!pending || this.stopped) return;
        const session = pending.entry.welcome.source.pluginSessionId;
        const through = session === this.blockedSession ? undefined : await this.apply(client, pending.entry, pending.sequence);
        // A deadline may retire the client while an operation is finishing. Leave the entry for the new client.
        if (this.client() !== client) return;
        this.releaseCapture(this.live.get(pending.sequence));
        this.live.delete(pending.sequence);
        if (session === this.blockedSession) { await this.journal.hold(pending.name); continue; }
        await this.journal.consume(pending.name);
        if (this.full && this.journal.hasRoom && !this.stopped) this.resumeIntake();
        this.setRetry(undefined);
        const current = this.latest;
        if (current?.connection === pending.entry.connection) {
          // A prior ACK from an earlier process is trusted only after the database verifies the preceding coverage.
          current.trusted = true;
          if (through) this.ack(current, through);
        }
      }
    } catch (error) {
      if (error instanceof EmergencyJournalIntegrityError) {
        this.invalid = true;
        this.releaseLiveEntries();
        clearTimeout(this.writeRetry);
        this.failJournal('INTEGRITY');
        this.latest?.link.close('unavailable', 'IO_ERROR');
        return;
      }
      const code = error instanceof ProjectionError ? error.code : 'IO_ERROR';
      if (code !== this.reported) this.log('EMERGENCY_JOURNAL_REPLAY_WAIT', {code});
      this.reported = code;
      this.context = undefined;
      this.recorder = undefined;
      this.releaseLiveEntries();
      this.setRetry(code);
      if (this.client() && !this.stopped) this.retry = setTimeout(() => {
        this.retry = undefined;
        this.kick();
      }, MIRROR_RETRY_MS);
    }
  }

  private setRetry(code: string | undefined): void {
    if (code === this.retrying) return;
    this.retrying = code;
    if (code === undefined) this.reported = undefined;
    this.changed();
  }

  private recorderFor(client: StorageClient): ProjectionSink {
    if (this.recorder?.client !== client) this.recorder = {client, sink: this.sink(client)};
    return this.recorder;
  }

  private releaseCapture(live: LiveEntry | undefined): void {
    if (live?.capture) live.owner.sink.releaseCapture?.(live.capture);
  }

  private releaseLiveEntries(): void {
    for (const live of this.live.values()) this.releaseCapture(live);
    this.live.clear();
  }

  private async apply(client: StorageClient, entry: EmergencyEntry, sequence: number): Promise<string | undefined> {
    const {checkpoint, checkpointReceivedUtcMs, welcome, message, receivedUtcMs} = entry;
    const owner = this.recorderFor(client), {sink} = owner;
    const live = this.live.get(sequence);
    const historyReplay = live?.owner !== owner || this.latest?.connection !== entry.connection || !this.latest.link.current();
    const input: CommitContext = {receivedUtcMs, historyReplay, hardModeCapture: historyReplay ? undefined : live?.capture};
    if (this.context?.connection !== entry.connection || this.context.owner !== owner) {
      const {committedThroughEventSeq: through} = stored(await sink.openSession(welcome));
      if (BigInt(through) < BigInt(entry.before)) {
        const session = welcome.source.pluginSessionId;
        if (sink.restoreLoss) stored(await sink.restoreLoss(session, through, entry.before));
        this.blockSession(session);
        return;
      }
      const restoreCheckpoint = message.kind !== 'checkpoint';
      const baselineContext = {receivedUtcMs: checkpointReceivedUtcMs, historyReplay: historyReplay || restoreCheckpoint, restoreCheckpoint};
      stored(await sink.checkpoint!(checkpoint, baselineContext));
      // The live prefix of the old checkpoint was already consumed. Hydrate without opening a trip from an old job.
      const prefixConsumed = restoreCheckpoint && BigInt(entry.before) >= BigInt(checkpoint.data.status.delivery.nextEventSeq) - 1n;
      const baseline = prefixConsumed ? {...checkpoint, data: {...checkpoint.data, state: {...checkpoint.data.state,
        configuration: {...checkpoint.data.state.configuration, job: {available: false as const, reason: 'not-observed' as const}}}}} : checkpoint;
      stored(sink.observe!(baseline, baselineContext));
      await this.flushSink(sink, baselineContext);
      this.context = {connection: entry.connection, owner};
    }
    if (message.kind === 'checkpoint') return;
    if (message.kind === 'snapshot') {
      stored(sink.observe!(message, input));
      await this.flushSink(sink, input);
      return;
    }
    const result = stored(await sink.commit(message, input));
    if (result.status === 'conflict') this.log('EMERGENCY_JOURNAL_CONFLICT', {code: 'EVENT_CONFLICT'});
    const through = message.kind === 'event' ? message.data.eventSeq : message.data.lastEventSeq;
    if (BigInt(result.committedThroughEventSeq) < BigInt(through)) throw new ProjectionError('COVERAGE_MISMATCH');
    await this.flushSink(sink, input);
    return through;
  }

  private blockSession(session: string): void {
    this.context = undefined;
    this.blockedSession = session;
    this.log('EMERGENCY_JOURNAL_HELD', {code: 'ACK_AHEAD_OF_STORAGE'});
    if (this.latest?.welcome.source.pluginSessionId !== session) return;
    this.current = {state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'};
    this.changed();
    this.latest.link.close('ack-ahead', 'ACK_AHEAD_OF_STORAGE');
  }

  private async flushSink(sink: DurableSink, context: CommitContext): Promise<void> {
    if (sink.attach?.due()) stored(await sink.attach.open(context));
    if (sink.samples?.pending().rows) stored(await sink.samples.write(3600));
  }
}
