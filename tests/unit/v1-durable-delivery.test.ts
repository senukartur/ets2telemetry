// The storage-commit ACK pipeline (ET-006b, E5-E8): ACKs exist only after the sink reported a commit, are written only
// to the connection that received the coverage while it is current, and follow the E7 failure table. Expected values
// are written by hand from docs/protocol/v1.md §9-§10, docs/storage.md and the shared protocol v1 fixtures; the sink
// here is an in-memory stand-in with the storage coverage rules, never the code under test (REG-005, REG-006, REG-007,
// REG-011). Real commits through the storage worker are in tests/storage/v1-durable-ingestion.test.ts.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AckValidator, V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {decodePayload, negotiateV1, validateClientMessage, type ClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {CommitResult, Result, StorageErrorCode} from '../../packages/storage/src/api';
import {ERROR_MESSAGES, storageError} from '../../packages/storage/src/errors';
import {STORAGE_FAILURE_CLASS, StorageDurableSink, failureClass, type CoverageMessage, type DurableSink, type WelcomeMessage} from '../../apps/desktop/src/durable-sink';
import {DurableDelivery, MAX_PENDING_COMMITS, MAX_PENDING_READINGS, SAMPLE_BATCH_ROWS, SAMPLE_FLUSH_MS, type DurableCloseKind, type DurableLink} from '../../apps/desktop/src/v1-durable-delivery';
import type {SampleSink} from '../../apps/desktop/src/durable-sink';

const dir = resolve('tests/fixtures/protocol-v1');
const server = (name: string) => decodePayload(new Uint8Array(readFileSync(resolve(dir, `${name}.json`))), 'server') as ServerMessage;
const client = (name: string) => validateClientMessage(decodePayload(new Uint8Array(readFileSync(resolve(dir, `${name}.json`))), 'client'));
const streams = readFileSync(resolve(dir, 'streams.txt'), 'utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const welcome = (name = 'welcome') => server(name) as WelcomeMessage;
/** An event of session P1 with the given eventSeq, cloned from a shared fixture (the payload differs per `variant`). */
function event(eventSeq: number, variant = 'event-job-configured'): CoverageMessage {
  const m = structuredClone(server(variant)) as Extract<ServerMessage, {kind: 'event'}>;
  m.data.eventSeq = String(eventSeq); m.seq = String(100 + eventSeq); return m;
}
function gap(first: number, last: number): CoverageMessage {
  const m = structuredClone(server('gap')) as Extract<ServerMessage, {kind: 'gap'}>;
  m.data.firstEventSeq = String(first); m.data.lastEventSeq = String(last);
  m.data.causes = {offline: String(last - first + 1), noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'};
  return m;
}
const range = (m: CoverageMessage) => m.kind === 'event' ? {firstEventSeq: m.data.eventSeq, lastEventSeq: m.data.eventSeq} : {firstEventSeq: m.data.firstEventSeq, lastEventSeq: m.data.lastEventSeq};
/** The shared checkpoint of session P1 with the producer's acknowledged point `acked` (A). */
function checkpointAt(acked: string): Extract<ServerMessage, {kind: 'checkpoint'}> {
  const m = structuredClone(server('checkpoint')) as Extract<ServerMessage, {kind: 'checkpoint'}>;
  m.data.status.delivery.ackedThroughEventSeq = acked; return m;
}
/** The consumer's receipt label passed with every item; this pipeline only forwards it (R8). */
const RECEIVED = 1_800_000_000_000;
const flush = () => new Promise<void>(r => setImmediate(r));
/** A storage failure, a rejected promise, or a successful commit that reports the given coverage. */
type Scripted = StorageErrorCode | 'reject' | {committedThroughEventSeq: string};

/**
 * In-memory storage stand-in written from docs/storage.md: event rows keyed by eventSeq, gap rows by range, contiguous
 * coverage that absorbs later rows, `duplicate` for an identical event, `conflict` for a different one (the stored row
 * is kept) and `covered` for a gap wholly inside coverage. `paused` holds every command until `releaseOne`.
 */
class MemorySink implements DurableSink {
  readonly sessions = new Map<string, {events: Map<bigint, string>; gaps: [bigint, bigint][]}>();
  readonly log: string[] = [];
  paused = false; private waiting: (() => void)[] = [];
  /** Scripted outcomes of the next session opens and of the next commits, in order. */
  openFailures: (StorageErrorCode | 'reject')[] = [];
  failures: Scripted[] = [];
  private session(id: string) { let s = this.sessions.get(id); if (!s) this.sessions.set(id, s = {events: new Map(), gaps: []}); return s; }
  through(id: string): bigint {
    const s = this.session(id); let n = 0n;
    for (;;) {
      if (s.events.has(n + 1n)) { n++; continue; }
      const g = s.gaps.find(([a, b]) => a <= n + 1n && n + 1n <= b && b > n);
      if (g) { n = g[1]; continue; }
      return n;
    }
  }
  get waitingCommands(): number { return this.waiting.length; }
  releaseOne(): void { this.waiting.shift()?.(); }
  private async turn(): Promise<void> { if (this.paused) await new Promise<void>(r => this.waiting.push(r)); }
  async openSession(w: WelcomeMessage): Promise<Result<{committedThroughEventSeq: string}>> {
    await this.turn();
    const failure = this.openFailures.shift();
    if (failure === 'reject') throw new Error('sink defect');
    if (failure) return {ok: false, error: storageError(failure)};
    this.log.push(`open ${w.source.pluginSessionId}`);
    return {ok: true, value: {committedThroughEventSeq: this.through(w.source.pluginSessionId).toString()}};
  }
  async commit(m: CoverageMessage): Promise<Result<CommitResult>> {
    await this.turn();
    const failure = this.failures.shift();
    if (failure === 'reject') throw new Error('sink defect');
    if (typeof failure === 'string') { this.log.push(`failed ${range(m).lastEventSeq}`); return {ok: false, error: storageError(failure)}; }
    const s = this.session(m.source.pluginSessionId);
    let status: CommitResult['status'];
    if (m.kind === 'event') {
      const seq = BigInt(m.data.eventSeq), row = JSON.stringify({occurred: m.data.occurred, record: m.data.record}), stored = s.events.get(seq);
      status = stored === undefined ? 'committed' : stored === row ? 'duplicate' : 'conflict';
      if (stored === undefined) s.events.set(seq, row);
    } else {
      const first = BigInt(m.data.firstEventSeq), last = BigInt(m.data.lastEventSeq);
      if (last <= this.through(m.source.pluginSessionId)) status = 'covered';
      else if (s.gaps.some(([a, b]) => a === first && b === last)) status = 'duplicate';
      else { s.gaps.push([first, last]); status = 'committed'; }
    }
    this.log.push(`${status} ${range(m).lastEventSeq}`);
    const through = failure ? failure.committedThroughEventSeq : this.through(m.source.pluginSessionId).toString();
    return {ok: true, value: {status, committedThroughEventSeq: through}};
  }
}

/** A connection as the pipeline sees it; every written frame is decoded and logged into the shared sink log. */
class Link implements DurableLink {
  open = true; readonly acks: string[] = []; readonly closes: [DurableCloseKind, string][] = [];
  constructor(private readonly log: string[], private readonly validator?: AckValidator) {}
  current() { return this.open; }
  write(bytes: Uint8Array) {
    const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage;
    if (m.kind !== 'ack') throw new Error('ACK expected');
    // The producer-side validator proves that every ACK the pipeline writes satisfies the producer rule (§10).
    this.validator?.accept(m);
    this.acks.push(m.data.throughEventSeq); this.log.push(`ack ${m.data.throughEventSeq}`);
  }
  close(kind: DurableCloseKind, code: string) { if (this.open) { this.open = false; this.closes.push([kind, code]); } }
}

/**
 * Replays one shared stream through V1Consumer and the pipeline. `S:` messages are applied as the ingestion applies
 * them; the stream's scripted `C:` ACKs belong to another client, so the pipeline's own ACKs replace them and pass the
 * producer-side AckValidator. `A:<n>` requires the pipeline's last ACK since the previous `A:` or `R` to be n, `A:-` none.
 */
async function replay(steps: string[]) {
  const sink = new MemorySink(), delivery = new DurableDelivery(sink), finals: string[] = [];
  let consumer = new V1Consumer(true), validator: AckValidator | undefined, link: Link | undefined, connection: ReturnType<DurableDelivery['connect']> | undefined, mark = 0;
  const acks = () => link?.acks ?? [];
  for (const step of steps) {
    if (step === 'R') { await delivery.idle(); link!.open = false; consumer = new V1Consumer(true); validator = undefined; mark = 0; continue; }
    if (step.startsWith('A:')) {
      await delivery.idle();
      const since = acks().slice(mark); mark = acks().length;
      expect(since.at(-1) ?? '-', step).toBe(step.slice(2));
      continue;
    }
    const [side, name] = step.split(':');
    if (side === 'C') {
      const m = client(name);
      if (m.kind === 'hello') expect(negotiateV1(m).durableEvents).toBe(true);
      else if (m.kind === 'clock.probe') consumer.expectClockReply(m.data.probeId);
      continue;
    }
    const m = server(name), applied = consumer.accept(m);
    if (m.kind === 'welcome') {
      validator = new AckValidator(m.source.pluginSessionId, m.data.durableEvents);
      link = new Link(sink.log, validator); connection = delivery.connect(m, link); finals.push(m.source.pluginSessionId);
    } else if (m.kind === 'checkpoint') { validator!.checkpoint(m.data.status.delivery.ackedThroughEventSeq); connection!.checkpoint(m, RECEIVED); }
    else if (applied.coverage && (m.kind === 'event' || m.kind === 'gap')) { validator!.sent(applied.coverage.lastEventSeq); expect(connection!.enqueue(applied.coverage, m, RECEIVED)).toBe(true); }
  }
  await delivery.idle();
  return {sink, delivery, finalAck: acks().at(-1) ?? '0', link: link!};
}

describe('ET-006b storage-commit ACK pipeline', () => {
  const durableAccept = streams.filter(([, durable, , outcome]) => durable === '1' && outcome === 'accept');
  it('covers every durable accepted shared stream', () => {
    expect(durableAccept.map(([name]) => name)).toEqual(['normal', 'snapshot-seq-skip', 'clock', 'late-attach', 'reconnect-redelivery', 'retention-expired', 'plugin-restart',
      'end-before-checkpoint', 'end-after-checkpoint', 'ack-repeat', 'normal-cursor-ack', 'lost-ack-reconnect', 'retention-expired-ack', 'queue-count-overflow',
      'queue-bytes-overflow', 'ack-zero-noop', 'ack-inside-gap-record']);
  });
  for (const [name, , steps, , expected] of durableAccept) it(`replays shared stream ${name} with ACKs only after commits (REG-005, REG-006)`, async () => {
    const {finalAck, sink, delivery} = await replay(steps.split(','));
    expect(finalAck).toBe(expected);
    expect(delivery.status.state).not.toBe('failed');
    // Every ACK follows the commit that covers it in the sink's own order of events.
    for (const [index, line] of sink.log.entries()) if (line.startsWith('ack ')) {
      const through = BigInt(line.slice(4));
      expect(sink.log.slice(0, index).some(l => /^(committed|duplicate|covered|conflict) /.test(l) && BigInt(l.split(' ')[1]) >= through), `${name}: ${line}`).toBe(true);
    }
  });
  it('writes the hand-written ACK sequence of the redelivery and gap streams', async () => {
    // reconnect-redelivery: 1 and 2 committed and acknowledged; after the reconnection (A = 1) the redelivered 2 is a
    // duplicate that is acknowledged again, then 3.
    expect((await replay(streams.find(([n]) => n === 'reconnect-redelivery')![2].split(','))).sink.log)
      .toEqual([`open ${P1}`, 'committed 1', 'ack 1', 'committed 2', 'ack 2', `open ${P1}`, 'duplicate 2', 'ack 2', 'committed 3', 'ack 3']);
    // ack-inside-gap-record: the redelivered record [2, 4] lies inside committed coverage, so it is covered, not stored again.
    expect((await replay(streams.find(([n]) => n === 'ack-inside-gap-record')![2].split(','))).sink.log)
      .toEqual([`open ${P1}`, 'committed 1', 'ack 1', 'committed 3', 'ack 3', 'committed 4', 'ack 4', `open ${P1}`, 'covered 4', 'ack 4']);
    // plugin-restart: a new plugin session starts its own cursor from its own storage coverage.
    expect((await replay(streams.find(([n]) => n === 'plugin-restart')![2].split(','))).sink.log)
      .toEqual([`open ${P1}`, 'committed 1', 'ack 1', 'committed 2', 'ack 2', `open ${P2}`, 'committed 1', 'ack 1']);
  });

  function started(sink: MemorySink, options: {maxPendingCommits?: number} = {}) {
    const logs: [string, unknown][] = [], delivery = new DurableDelivery(sink, {...options, log: (event, facts) => logs.push([event, facts])});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    return {delivery, link, connection, logs};
  }
  // One FIFO with one command in flight cannot commit eventSeq 4 before 3, so commits {1, 2, 4} never arise in the
  // pipeline; the contract cursor cases in protocol-v1-delivery.test.ts cover that case. Here 3 is in flight, then fails.
  it('never acknowledges on receipt, only after the sink resolves, and not past a commit in flight or a failed one', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const {link, connection} = started(sink);
    for (const n of [1, 2, 3, 4]) connection.enqueue(range(event(n)), event(n), RECEIVED);
    await flush();
    expect(link.acks).toEqual([]);
    sink.releaseOne(); await flush();                        // open
    sink.releaseOne(); await flush(); expect(link.acks).toEqual(['1']);
    sink.releaseOne(); await flush(); expect(link.acks).toEqual(['1', '2']);
    // eventSeq 3 is still in flight; 4 was received but nothing beyond the contiguous commit 2 is acknowledged.
    expect(sink.waitingCommands).toBe(1);
    expect(link.acks).toEqual(['1', '2']);
    // A retryable failure on 3 closes the connection; 4 is dropped and never committed, so no ACK goes beyond 2.
    sink.failures.push('DISK_FULL'); sink.releaseOne(); await flush(); await flush();
    expect(link.acks).toEqual(['1', '2']);
    expect(link.closes).toEqual([['retryable', 'DISK_FULL']]);
    expect(sink.log).toEqual([`open ${P1}`, 'committed 1', 'ack 1', 'committed 2', 'ack 2', 'failed 3']);
  });
  it('writes nothing for a commit that finishes after its connection closed, and re-ACKs after redelivery', async () => {
    const sink = new MemorySink(), delivery = new DurableDelivery(sink);
    const first = new Link(sink.log), one = delivery.connect(welcome(), first);
    one.checkpoint(checkpointAt('0'), RECEIVED);
    for (const n of [1, 2, 3]) one.enqueue(range(event(n)), event(n), RECEIVED);
    await delivery.idle();
    sink.paused = true;
    one.enqueue(range(event(4)), event(4), RECEIVED); await flush();
    // The connection ends while the commit of 4 is in flight; the commit still completes in storage.
    first.open = false; sink.releaseOne(); sink.paused = false; await delivery.idle();
    expect(first.acks).toEqual(['1', '2', '3']);
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint(checkpointAt('3'), RECEIVED);
    for (const n of [4, 5, 6]) two.enqueue(range(event(n)), event(n), RECEIVED);
    await delivery.idle();
    expect(second.acks).toEqual(['4', '5', '6']);
    expect(sink.log.slice(-7)).toEqual([`open ${P1}`, 'duplicate 4', 'ack 4', 'committed 5', 'ack 5', 'committed 6', 'ack 6']);
  });
  it('acknowledges a conflicting redelivery, keeps the stored row and logs the conflict count', async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.idle();
    link.open = false;
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint(checkpointAt('0'), RECEIVED);
    const different = event(1, 'event-job-cleared');
    two.enqueue(range(different), different, RECEIVED); await delivery.idle();
    expect(second.acks).toEqual(['1']);
    expect(sink.log.slice(-2)).toEqual(['conflict 1', 'ack 1']);
    expect(sink.sessions.get(P1)!.events.get(1n)).toContain('job.configured');
    expect(logs).toEqual([['V1_EVENT_CONFLICT', {count: 1}]]);
  });
  it('acknowledges a gap that is wholly inside committed coverage as covered', async () => {
    const sink = new MemorySink(), {delivery, link, connection} = started(sink);
    for (const m of [event(1), gap(2, 3), event(4)]) connection.enqueue(range(m), m, RECEIVED);
    await delivery.idle();
    link.open = false;
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint(checkpointAt('1'), RECEIVED);
    const merged = gap(2, 4); two.enqueue(range(merged), merged, RECEIVED);
    await delivery.idle();
    expect(second.acks).toEqual(['4']);
    expect(sink.log.slice(-2)).toEqual(['covered 4', 'ack 4']);
  });

  it('classifies every storage error code (E7)', () => {
    // Hand-written from E7: these four keep durable delivery and only reconnect; everything else stops it.
    const retryable = ['DATABASE_LOCKED', 'DISK_FULL', 'IO_ERROR', 'STORAGE_BUSY'];
    expect(Object.keys(STORAGE_FAILURE_CLASS).sort()).toEqual(Object.keys(ERROR_MESSAGES).sort());
    expect(Object.entries(STORAGE_FAILURE_CLASS).filter(([, c]) => c === 'retryable').map(([code]) => code).sort()).toEqual(retryable);
    for (const code of ['WORKER_FAILED', 'TIMEOUT', 'CONSTRAINT_VIOLATION', 'SESSION_CONFLICT', 'INVALID_INPUT', 'INTERNAL']) expect(failureClass({code: code as StorageErrorCode}), code).toBe('unavailable');
    expect(failureClass({code: 'NOT_A_STORAGE_CODE' as StorageErrorCode})).toBe('unavailable');
  });
  for (const code of ['DATABASE_LOCKED', 'DISK_FULL', 'IO_ERROR', 'STORAGE_BUSY'] as const) it(`closes as retryable without an ACK on ${code} and stays durable (REG-007)`, async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    sink.failures.push(code);
    connection.enqueue(range(event(1)), event(1), RECEIVED); connection.enqueue(range(event(2)), event(2), RECEIVED);
    await delivery.idle();
    expect([link.acks, link.closes, sink.log]).toEqual([[], [['retryable', code]], [`open ${P1}`, 'failed 1']]);
    expect(delivery.status).toEqual({state: 'pending', retryCode: code});
    expect(delivery.durableAllowed()).toBe(true);
    expect(logs).toEqual([['V1_DURABLE_RETRY', {code, count: 1}]]);
  });
  for (const code of ['WORKER_FAILED', 'TIMEOUT', 'CONSTRAINT_VIOLATION', 'SESSION_CONFLICT', 'INVALID_INPUT', 'INTERNAL', 'PERMISSION_DENIED'] as const) it(`stops durable delivery for the service lifetime on ${code}`, async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    sink.failures.push(code);
    connection.enqueue(range(event(1)), event(1), RECEIVED); connection.enqueue(range(event(2)), event(2), RECEIVED);
    await delivery.idle();
    expect([link.acks, link.closes, sink.log]).toEqual([[], [['unavailable', code]], [`open ${P1}`, 'failed 1']]);
    expect(delivery.status).toEqual({state: 'failed', code});
    expect([delivery.durableAllowed(), delivery.durableAllowed(P2)]).toEqual([false, false]);
    // A later durable connection is refused at once and logged no second time.
    const later = new Link(sink.log); delivery.connect(welcome('welcome-reconnect'), later);
    expect(later.closes).toEqual([['unavailable', code]]);
    expect(logs).toEqual([['V1_DURABLE_UNAVAILABLE', {code}]]);
  });
  it('treats a rejected sink promise and a failed session open as non-retryable', async () => {
    const rejecting = new MemorySink(); rejecting.failures.push('reject');
    const a = started(rejecting); a.connection.enqueue(range(event(1)), event(1), RECEIVED); await a.delivery.idle();
    expect([a.link.acks, a.link.closes, a.delivery.status]).toEqual([[], [['unavailable', 'INTERNAL']], {state: 'failed', code: 'INTERNAL'}]);
    const refusing = new MemorySink(); refusing.openFailures.push('CONSTRAINT_VIOLATION');
    const b = started(refusing); b.connection.enqueue(range(event(1)), event(1), RECEIVED); await b.delivery.idle();
    expect([b.link.closes, refusing.log]).toEqual([[['unavailable', 'CONSTRAINT_VIOLATION']], []]);
  });
  it('fails closed on COVERAGE_MISMATCH instead of acknowledging', async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    // Storage reports coverage 7 after committing eventSeq 1, while the cursor holds 1.
    sink.failures.push({committedThroughEventSeq: '7'});
    connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.idle();
    expect([link.acks, link.closes, delivery.status, logs]).toEqual([[], [['unavailable', 'COVERAGE_MISMATCH']], {state: 'failed', code: 'COVERAGE_MISMATCH'}, [['V1_DURABLE_UNAVAILABLE', {code: 'COVERAGE_MISMATCH'}]]]);
  });
  it('disables durable delivery for one plugin session when its producer acknowledged beyond storage', async () => {
    const sink = new MemorySink(), logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    // Storage holds nothing for P1 (C = 0) while the checkpoint says the producer released through 3 (A = 3).
    connection.checkpoint(checkpointAt('3'), RECEIVED); connection.enqueue(range(event(4)), event(4), RECEIVED);
    await delivery.idle();
    expect([link.acks, link.closes, sink.log]).toEqual([[], [['ack-ahead', 'ACK_AHEAD_OF_STORAGE']], [`open ${P1}`]]);
    expect(delivery.status).toEqual({state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'});
    expect([delivery.durableAllowed(), delivery.durableAllowed(P1), delivery.durableAllowed(P2)]).toEqual([false, false, true]);
    expect([delivery.observeLiveOnly(P1), delivery.observeLiveOnly(P2), delivery.durableAllowed()]).toEqual([false, true, true]);
    expect(logs).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}]]);
  });
  // ET-015c (G11): the bound is twice the producer's 256 retained entries (docs/native-transport-v1.md, I2), so it was
  // raised from 256; this case closed on the 257th item before.
  it('bounds the backlog at 512 coverage items and closes the connection on the 513th (REG-011)', async () => {
    expect(MAX_PENDING_COMMITS).toBe(512);
    const sink = new MemorySink(); sink.paused = true;
    const {delivery, link, connection, logs} = started(sink);
    // The session open is in flight and held, so the items below queue behind it.
    await flush(); expect(sink.waitingCommands).toBe(1);
    for (let n = 1; n <= 512; n++) expect(connection.enqueue(range(event(n)), event(n), RECEIVED)).toBe(true);
    expect([delivery.pending, link.closes]).toEqual([512, []]);
    expect(connection.enqueue(range(event(513)), event(513), RECEIVED)).toBe(false);
    expect([delivery.pending, link.closes, logs]).toEqual([0, [['retryable', 'BACKLOG_FULL']], [['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]]);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    // The open completed; no queued item of the closed connection was committed or acknowledged.
    expect([sink.log, link.acks]).toEqual([[`open ${P1}`], []]);
  });
  it('keeps the items of an ended connection and a full redelivery with a live gap inside the bound, and commits each item once (G11, REG-011)', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
    const first = new Link(sink.log), one = delivery.connect(welcome(), first);
    one.checkpoint(checkpointAt('0'), RECEIVED);
    for (let n = 1; n <= 200; n++) expect(one.enqueue(range(event(n)), event(n), RECEIVED)).toBe(true);
    // The open completes; the commit of eventSeq 1 is then held in flight with 199 items queued behind it.
    await flush(); sink.releaseOne(); await flush();
    expect([sink.waitingCommands, delivery.pending, sink.log]).toEqual([1, 200, [`open ${P1}`]]);
    // The connection ends without an ACK, so its 200 items stay queued or in flight. The producer still retains its
    // full 256 entries (A = 0; I2: 255 events and the reserved gap record 256-258) and redelivers all of them on the next
    // connection; then one live delta gap extends that trailing record (I3, I6).
    first.open = false;
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint(checkpointAt('0'), RECEIVED);
    for (let n = 1; n <= 255; n++) expect(two.enqueue(range(event(n)), event(n), RECEIVED)).toBe(true);
    expect(two.enqueue(range(gap(256, 258)), gap(256, 258), RECEIVED)).toBe(true);
    expect(two.enqueue(range(gap(259, 260)), gap(259, 260), RECEIVED)).toBe(true);
    // 200 left over, 256 redelivered and one live item: 457, below the 512 bound.
    expect([delivery.pending, first.closes, second.closes, logs]).toEqual([457, [], [], []]);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    // The ended connection's items commit without an ACK; the redelivered 1-200 are duplicates, 201-255 and both gaps
    // are first commits, and the new connection acknowledges each of them in order.
    const numbers = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => from + i);
    expect(sink.log).toEqual([`open ${P1}`, ...numbers(1, 200).map(n => `committed ${n}`), `open ${P1}`,
      ...numbers(1, 200).flatMap(n => [`duplicate ${n}`, `ack ${n}`]), ...numbers(201, 255).flatMap(n => [`committed ${n}`, `ack ${n}`]),
      'committed 258', 'ack 258', 'committed 260', 'ack 260']);
    expect([first.acks, second.acks, second.closes, logs, delivery.pending, delivery.status])
      .toEqual([[], [...numbers(1, 255).map(String), '258', '260'], [], [], 0, {state: 'active'}]);
    expect([sink.sessions.get(P1)!.events.size, sink.sessions.get(P1)!.gaps, sink.through(P1)]).toEqual([255, [[256n, 258n], [259n, 260n]], 260n]);
  });
  it('ignores a session open that completes after stop', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const statuses: unknown[] = [], delivery = new DurableDelivery(sink, {onStatus: status => statuses.push(status)});
    const link = new Link(sink.log); delivery.connect(welcome(), link);
    await flush(); expect(sink.waitingCommands).toBe(1);
    const before = [...statuses];
    const stopped = delivery.stop(); sink.releaseOne(); await stopped;
    // The open reached storage, but the stopped pipeline reports no active session and builds no cursor.
    expect([sink.log, delivery.status, statuses]).toEqual([[`open ${P1}`], {state: 'pending'}, before]);
  });
  it('drops queued work on stop and waits for the command in flight', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const {delivery, link, connection} = started(sink);
    for (const n of [1, 2, 3]) connection.enqueue(range(event(n)), event(n), RECEIVED);
    await flush(); sink.releaseOne(); await flush();
    const stopped = delivery.stop(); let done = false; void stopped.then(() => { done = true; });
    await flush(); expect(done).toBe(false);
    sink.releaseOne(); await stopped;
    // The command in flight completes in storage, but nothing is written after stop.
    expect([sink.log, link.acks, delivery.pending, delivery.durableAllowed()]).toEqual([[`open ${P1}`, 'committed 1'], [], 0, false]);
  });

  // S-3 (ET-015a): the effects hook is gone. StorageDurableSink commits without effects; the trip recorder, which reads
  // coverage before each commit and adopts its state only after it, is covered in tests/unit/trip-recorder.test.ts.
  it('commits through StorageClient commands without trip effects', async () => {
    const calls: string[] = [];
    const ok = <T>(value: T) => Promise.resolve({ok: true as const, value});
    const storage = {
      upsertSession: (input: {message: unknown}) => { calls.push(`upsert ${(input.message as ServerMessage).kind}`); return ok({created: true, committedThroughEventSeq: '2'}); },
      commitEvent: (input: {message: unknown; effects?: unknown[]}) => { calls.push(`event ${input.effects?.length ?? 'none'}`); return ok<CommitResult>({status: 'committed', committedThroughEventSeq: '3'}); },
      commitGap: (input: {message: unknown; effects?: unknown[]}) => { calls.push(`gap ${input.effects?.length ?? 'none'}`); return ok<CommitResult>({status: 'committed', committedThroughEventSeq: '5', previouslyCoveredThrough: '3'}); }
    };
    const sink = new StorageDurableSink(storage);
    expect(await sink.openSession(welcome())).toEqual({ok: true, value: {committedThroughEventSeq: '2'}});
    expect(await sink.commit(event(3))).toEqual({ok: true, value: {status: 'committed', committedThroughEventSeq: '3'}});
    expect(await sink.commit(gap(4, 5))).toEqual({ok: true, value: {status: 'committed', committedThroughEventSeq: '5', previouslyCoveredThrough: '3'}});
    expect(calls).toEqual(['upsert welcome', 'event none', 'gap none']);
    expect(['observe' in sink, 'restoreLoss' in sink]).toEqual([false, false]);
  });

  /** A MemorySink that also observes readings and records restore-loss calls, logging both into the shared log. */
  class ObservingSink extends MemorySink {
    readonly contexts: number[] = [];
    observeFailure?: StorageErrorCode;
    restoreFailure?: StorageErrorCode;
    override async commit(m: CoverageMessage, context?: {receivedUtcMs: number}): Promise<Result<CommitResult>> {
      if (context) this.contexts.push(context.receivedUtcMs);
      return super.commit(m);
    }
    observe(m: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>): Result<undefined> {
      if (this.observeFailure) return {ok: false, error: storageError(this.observeFailure)};
      this.log.push(`observe ${m.kind} ${m.seq}`); return {ok: true, value: undefined};
    }
    restoreLoss(session: string, stored: string, acked: string): Promise<Result<undefined>> {
      this.log.push(`restore-loss ${session === P1 ? 'P1' : session} ${stored} ${acked}`);
      return Promise.resolve(this.restoreFailure ? {ok: false, error: storageError(this.restoreFailure)} : {ok: true, value: undefined});
    }
  }
  const snapshotSeq = (seq: number) => { const m = structuredClone(server('snapshot')) as Extract<ServerMessage, {kind: 'snapshot'}>; m.seq = String(seq); return m; };
  it('observes the checkpoint and snapshots at their place in the FIFO and passes each receipt label (R5, R8)', async () => {
    const sink = new ObservingSink(); sink.paused = true;
    const delivery = new DurableDelivery(sink), link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    connection.enqueue(range(event(1)), event(1), RECEIVED + 1);
    expect(connection.snapshot(snapshotSeq(50), RECEIVED)).toBe(true);
    connection.enqueue(range(event(2)), event(2), RECEIVED + 2);
    expect(connection.snapshot(snapshotSeq(51), RECEIVED)).toBe(true);
    // Nothing is observed at receipt: the open is still held, so every reading waits behind it.
    await flush();
    expect([sink.log, delivery.pendingReadingCount, delivery.pending]).toEqual([[], 2, 2]);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    expect(sink.log).toEqual([`open ${P1}`, `observe checkpoint ${server('checkpoint').seq}`, 'committed 1', 'ack 1', 'observe snapshot 50', 'committed 2', 'ack 2', 'observe snapshot 51']);
    expect([sink.contexts, delivery.pendingReadingCount]).toEqual([[RECEIVED + 1, RECEIVED + 2], 0]);
  });
  it('queues no snapshot for a sink without observe', async () => {
    const sink = new MemorySink(), delivery = new DurableDelivery(sink), link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    expect(connection.snapshot(snapshotSeq(50), RECEIVED)).toBe(true);
    expect(delivery.pendingReadingCount).toBe(0);
    connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.idle();
    expect(sink.log).toEqual([`open ${P1}`, 'committed 1', 'ack 1']);
  });
  it('stops durable delivery when a reading is refused, without an ACK for later items', async () => {
    const sink = new ObservingSink(), logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    connection.enqueue(range(event(1)), event(1), RECEIVED);
    await delivery.idle();
    sink.observeFailure = 'INTERNAL';
    connection.snapshot(snapshotSeq(50), RECEIVED); connection.enqueue(range(event(2)), event(2), RECEIVED);
    await delivery.idle();
    // The checkpoint was observed before the failure was scripted; the refused snapshot drops event 2.
    expect([sink.log, link.closes, delivery.status, logs]).toEqual([[`open ${P1}`, `observe checkpoint ${server('checkpoint').seq}`, 'committed 1', 'ack 1'],
      [['unavailable', 'INTERNAL']], {state: 'failed', code: 'INTERNAL'}, [['V1_DURABLE_UNAVAILABLE', {code: 'INTERNAL'}]]]);
  });
  it('bounds snapshot readings at 512 apart from the coverage items and closes the connection on the 513th (R5, REG-011)', async () => {
    expect(MAX_PENDING_READINGS).toBe(512);
    const sink = new ObservingSink(); sink.paused = true;
    const logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    await flush(); expect(sink.waitingCommands).toBe(1);
    for (let n = 1; n <= 256; n++) expect(connection.enqueue(range(event(n)), event(n), RECEIVED)).toBe(true);
    // Readings do not count against the coverage items, and items do not count against the 512 readings.
    for (let n = 1; n <= 512; n++) expect(connection.snapshot(snapshotSeq(1000 + n), RECEIVED)).toBe(true);
    expect([delivery.pending, delivery.pendingReadingCount, link.closes]).toEqual([256, 512, []]);
    expect(connection.snapshot(snapshotSeq(2000), RECEIVED)).toBe(false);
    expect([delivery.pending, delivery.pendingReadingCount, link.closes, logs]).toEqual([0, 0, [['retryable', 'BACKLOG_FULL']], [['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]]);
    expect(delivery.status).toEqual({state: 'pending', retryCode: 'BACKLOG_FULL'});
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    expect([sink.log, link.acks]).toEqual([[`open ${P1}`], []]);
  });
  it('records the restore loss (C, A] before closing an ACK_AHEAD_OF_STORAGE connection and logs the result (R9)', async () => {
    for (const [failure, code] of [[undefined, 'RECORDED'], ['DISK_FULL', 'DISK_FULL']] as const) {
      const sink = new ObservingSink(); sink.restoreFailure = failure;
      const logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
      // Storage holds 1 and 2 (C = 2) while the checkpoint says the producer released through 5 (A = 5).
      const first = new Link(sink.log), one = delivery.connect(welcome(), first);
      one.checkpoint(checkpointAt('0'), RECEIVED);
      for (const n of [1, 2]) one.enqueue(range(event(n)), event(n), RECEIVED);
      await delivery.idle(); first.open = false;
      const link = new Link(sink.log), connection = delivery.connect(welcome('welcome-reconnect'), link);
      connection.checkpoint(checkpointAt('5'), RECEIVED); connection.enqueue(range(event(6)), event(6), RECEIVED);
      await delivery.idle();
      expect(sink.log.slice(6)).toEqual([`open ${P1}`, 'restore-loss P1 2 5']);
      expect([link.acks, link.closes, delivery.status]).toEqual([[], [['ack-ahead', 'ACK_AHEAD_OF_STORAGE']], {state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'}]);
      // A failure to record it does not unblock the plugin session.
      expect([delivery.durableAllowed(P1), delivery.durableAllowed(P2)]).toEqual([false, true]);
      expect(logs).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}], ['V1_DURABLE_RESTORE_LOSS', {code}]]);
    }
  });
});

/**
 * ET-015b: a MemorySink whose `observe` turns every snapshot into one pending sample row, numbered 1, 2, 3, ..., and
 * whose `samples` writes them in order, logging `samples <first>-<last>` into the shared log. Sample writes can be held
 * or scripted to fail, and can report rows that storage skipped. It stands in for the trip recorder's SampleBuffer.
 */
class SamplingSink extends MemorySink {
  readonly pendingRows: number[] = [];
  readonly writeSizes: number[] = [];
  readonly sampleFailures: (StorageErrorCode | 'reject')[] = [];
  holdSamples = false; skipPerWrite = 0; droppedRows = 0;
  /** Loss intervals pending; only a final write stores them, logging `losses <n>`. */
  pendingLosses = 0;
  readonly finals: boolean[] = [];
  private nextRow = 0;
  private readonly heldSamples: (() => void)[] = [];
  get heldWrites(): number { return this.heldSamples.length; }
  releaseSamples(): void { this.heldSamples.shift()?.(); }
  observe(m: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>): Result<undefined> {
    if (m.kind === 'snapshot') this.pendingRows.push(++this.nextRow);
    return {ok: true, value: undefined};
  }
  readonly samples: SampleSink = {
    pending: () => ({rows: this.pendingRows.length, losses: this.pendingLosses}),
    write: async (maxRows, final) => {
      this.writeSizes.push(maxRows); this.finals.push(final === true);
      if (this.holdSamples) await new Promise<void>(r => this.heldSamples.push(r));
      const failure = this.sampleFailures.shift();
      if (failure === 'reject') throw new Error('sink defect');
      if (failure) { this.log.push(`samples failed ${failure}`); return {ok: false, error: storageError(failure)}; }
      if (final && this.pendingLosses) { this.log.push(`losses ${this.pendingLosses}`); this.pendingLosses = 0; }
      const batch = this.pendingRows.splice(0, maxRows), skipped = Math.min(this.skipPerWrite, batch.length);
      this.log.push(`samples ${batch[0]}-${batch.at(-1)}`);
      return {ok: true, value: {appended: batch.length - skipped, skipped}};
    },
    discard: () => this.pendingRows.splice(0).length,
    dropped: () => this.droppedRows
  };
}

describe('ET-015b samples op in the storage-commit pipeline', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const snapshotAt = (seq: number) => { const m = structuredClone(server('snapshot')) as Extract<ServerMessage, {kind: 'snapshot'}>; m.seq = String(seq); return m; };
  /** An open durable connection of P1 whose checkpoint (A = 0) is queued; `readings(n)` queues n snapshots. */
  function sampling(sink = new SamplingSink(), options: {maxPendingCommits?: number} = {}) {
    const logs: [string, unknown][] = [], delivery = new DurableDelivery(sink, {...options, log: (event, facts) => logs.push([event, facts])});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    let seq = 100;
    const readings = (n: number) => { for (let i = 0; i < n; i++) expect(connection.snapshot(snapshotAt(seq++), RECEIVED)).toBe(true); };
    const writes = () => sink.log.filter(line => line.startsWith('samples'));
    return {sink, delivery, link, connection, logs, readings, writes};
  }

  it('arms the flush timer at the first pending row and queues one samples op 5 s later (H8)', async () => {
    expect([SAMPLE_FLUSH_MS, SAMPLE_BATCH_ROWS]).toEqual([5000, 60]);
    expect(() => new DurableDelivery(new SamplingSink(), {sampleBatchRows: 0})).toThrow('Invalid sample batch size');
    expect(() => new DurableDelivery(new SamplingSink(), {sampleFlushMs: 0})).toThrow('Invalid sample flush delay');
    const {sink, link, logs, readings, writes} = sampling();
    await settle();
    // The session open and the checkpoint add no row, so no timer runs.
    expect(vi.getTimerCount()).toBe(0);
    readings(1); await settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); readings(2); await settle();
    // The timer started with the first row; later rows do not restart it.
    await vi.advanceTimersByTimeAsync(2999); expect(writes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(writes()).toEqual(['samples 1-3']);
    expect([sink.writeSizes, vi.getTimerCount(), link.acks, logs]).toEqual([[60], 0, [], []]);
  });

  it('queues a samples op at once when 60 rows are pending and writes at most 60 rows per op (H8)', async () => {
    const {sink, readings, writes} = sampling();
    readings(130); await settle();
    // Two full batches at once, one after the other; the 10 rows left wait for the timer.
    expect([writes(), sink.writeSizes, vi.getTimerCount()]).toEqual([['samples 1-60', 'samples 61-120'], [60, 60], 1]);
    await vi.advanceTimersByTimeAsync(4999); expect(writes()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(writes()).toEqual(['samples 1-60', 'samples 61-120', 'samples 121-130']);
  });

  it('keeps at most one samples op queued or running (H8)', async () => {
    const sink = new SamplingSink(); sink.holdSamples = true;
    const {readings, writes} = sampling(sink);
    readings(60); await settle();
    expect(sink.heldWrites).toBe(1);
    // More than a full batch and more than the flush delay while that op runs: no second op and no timer.
    readings(70); await vi.advanceTimersByTimeAsync(20_000);
    expect([sink.heldWrites, sink.writeSizes, vi.getTimerCount()]).toEqual([1, [60], 0]);
    sink.releaseSamples(); await settle();
    expect([writes(), sink.heldWrites]).toEqual([['samples 1-60'], 1]);
    sink.releaseSamples(); await settle();
    // No further op was queued meanwhile: the 10 rows left wait for the timer, and no write runs.
    expect([writes(), sink.writeSizes, sink.heldWrites, vi.getTimerCount()]).toEqual([['samples 1-60', 'samples 61-120'], [60, 60], 0, 1]);
  });

  it('commits an item queued behind a samples op right after that one batch; samples never acknowledge or count against the bounds (H10)', async () => {
    const sink = new SamplingSink(); sink.holdSamples = true;
    const {delivery, link, connection, readings} = sampling(sink, {maxPendingCommits: 1});
    readings(60); await settle();
    expect(sink.heldWrites).toBe(1);
    // The bound of one coverage item is free although a samples op is in flight.
    expect(connection.enqueue(range(event(1)), event(1), RECEIVED)).toBe(true);
    expect([delivery.pending, delivery.pendingReadingCount, link.acks]).toEqual([1, 0, []]);
    sink.releaseSamples(); await settle();
    expect(sink.log).toEqual([`open ${P1}`, 'samples 1-60', 'committed 1', 'ack 1']);
  });

  it('keeps the rows after a retryable failure and retries them at the next timer, with the connection open (H12, REG-007)', async () => {
    const sink = new SamplingSink(); sink.sampleFailures.push('DISK_FULL', 'DISK_FULL');
    const {delivery, link, connection, logs, readings, writes} = sampling(sink);
    readings(60); await settle();
    expect([writes(), sink.pendingRows.length, link.closes, delivery.status, logs]).toEqual([['samples failed DISK_FULL'], 60, [], {state: 'active'},
      [['V1_SAMPLES_RETRY', {code: 'DISK_FULL', count: 1}]]]);
    // A full batch is pending, but the rows wait for the timer; events still commit and are acknowledged meanwhile.
    readings(1); connection.enqueue(range(event(1)), event(1), RECEIVED); await settle();
    expect([writes(), link.acks]).toEqual([['samples failed DISK_FULL'], ['1']]);
    await vi.advanceTimersByTimeAsync(5000);
    expect([writes().at(-1), logs.at(-1)]).toEqual(['samples failed DISK_FULL', ['V1_SAMPLES_RETRY', {code: 'DISK_FULL', count: 2}]]);
    await vi.advanceTimersByTimeAsync(5000);
    // The next success ends the backoff: the 61st row is written by its own timer.
    expect(writes().slice(2)).toEqual(['samples 1-60']);
    await vi.advanceTimersByTimeAsync(5000);
    expect([writes().slice(3), link.closes, delivery.durableAllowed()]).toEqual([['samples 61-61'], [], true]);
  });

  for (const [failure, code] of [['PERMISSION_DENIED', 'PERMISSION_DENIED'], ['reject', 'INTERNAL']] as const) it(`stops durable delivery and discards the pending rows on ${code} (H12)`, async () => {
    const sink = new SamplingSink(); sink.sampleFailures.push(failure);
    const {delivery, link, connection, logs, readings} = sampling(sink);
    readings(60); await settle();
    expect([logs, link.closes, delivery.status, sink.pendingRows.length, delivery.durableAllowed()]).toEqual([
      [['V1_DURABLE_UNAVAILABLE', {code}], ['V1_SAMPLES_DISCARDED', {count: 60}]], [['unavailable', code]], {state: 'failed', code}, 0, false]);
    // Nothing more is queued or written, and stop() writes nothing.
    connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.stop();
    expect([sink.log, sink.writeSizes, vi.getTimerCount()]).toEqual([[`open ${P1}`, ...(failure === 'reject' ? [] : ['samples failed PERMISSION_DENIED'])], [60], 0]);
  });

  it('stop() drops queued work, waits for the commit in flight, then writes every pending row once (H11)', async () => {
    const {sink, delivery, link, connection, logs, readings} = sampling();
    readings(5); await settle();
    expect(vi.getTimerCount()).toBe(1);
    sink.paused = true;
    connection.enqueue(range(event(1)), event(1), RECEIVED); await settle();
    expect(sink.waitingCommands).toBe(1);
    connection.enqueue(range(event(2)), event(2), RECEIVED); readings(2);
    const stopped = delivery.stop(); let done = false; void stopped.then(() => { done = true; });
    await settle();
    expect([done, vi.getTimerCount(), sink.writeSizes]).toEqual([false, 0, []]);
    sink.releaseOne(); await stopped;
    // Commit 1 completed in storage without an ACK; event 2 and the two queued snapshots were dropped, not observed.
    expect([sink.log, link.acks, sink.writeSizes, logs]).toEqual([[`open ${P1}`, 'committed 1', 'samples 1-5'], [], [300], [['V1_SAMPLES_EXIT', {rows: 5, losses: 0, code: 'WRITTEN'}]]]);
    expect(sink.finals).toEqual([true]);
    // A second stop returns the same promise and writes nothing more.
    expect(delivery.stop()).toBe(stopped);
  });

  it('stop() reports a failed final write and writes nothing after durable delivery failed (H11)', async () => {
    const one = sampling(); one.sink.sampleFailures.push('DISK_FULL');
    one.readings(5); await settle(); await one.delivery.stop();
    expect([one.writes(), one.logs]).toEqual([['samples failed DISK_FULL'], [['V1_SAMPLES_EXIT', {rows: 5, losses: 0, code: 'DISK_FULL'}]]]);
    // Loss intervals still pending are written by the final write too and reported apart from the rows.
    const three = sampling(); three.sink.pendingLosses = 1;
    three.readings(2); await settle(); await three.delivery.stop();
    expect([three.sink.log.slice(-2), three.logs]).toEqual([['losses 1', 'samples 1-2'], [['V1_SAMPLES_EXIT', {rows: 2, losses: 1, code: 'WRITTEN'}]]]);
    // An unavailable commit failure discards the pending rows; stop() then writes nothing and logs no exit.
    const two = sampling(); two.sink.failures.push('PERMISSION_DENIED');
    two.readings(5); await settle();
    two.connection.enqueue(range(event(1)), event(1), RECEIVED); await settle(); await two.delivery.stop();
    expect([two.writes(), two.logs]).toEqual([[], [['V1_DURABLE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}], ['V1_SAMPLES_DISCARDED', {count: 5}]]]);
  });

  it('logs dropped and skipped rows when their running totals reach 1, 2, 4, 8, ... (H12)', async () => {
    const {sink, logs, readings} = sampling();
    await settle();
    for (const dropped of [1, 2, 3, 4, 5]) { sink.droppedRows = dropped; readings(1); await settle(); }
    expect(logs).toEqual([['V1_SAMPLES_DROPPED', {count: 1}], ['V1_SAMPLES_DROPPED', {count: 2}], ['V1_SAMPLES_DROPPED', {count: 4}]]);
    sink.skipPerWrite = 3; logs.length = 0;
    // 5 rows are pending; three full batches skip 3 rows each: totals 3, 6 and 9.
    readings(55); await settle(); readings(60); await settle(); readings(60); await settle();
    expect(logs).toEqual([['V1_SAMPLES_SKIPPED', {count: 3}], ['V1_SAMPLES_SKIPPED', {count: 6}], ['V1_SAMPLES_SKIPPED', {count: 9}]]);
  });

  it('runs no timer and writes nothing for a sink without samples', async () => {
    const sink = new MemorySink(), logs: unknown[] = [];
    const observing: DurableSink = {openSession: w => sink.openSession(w), commit: m => sink.commit(m), observe: () => ({ok: true, value: undefined})};
    const delivery = new DurableDelivery(observing, {log: (...entry) => logs.push(entry)}), connection = delivery.connect(welcome(), new Link(sink.log));
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    for (let n = 0; n < 70; n++) connection.snapshot(snapshotAt(200 + n), RECEIVED);
    await settle(); await vi.advanceTimersByTimeAsync(10_000); await delivery.stop();
    expect([vi.getTimerCount(), sink.log, logs]).toEqual([0, [`open ${P1}`], []]);
  });
});

// ET-015c (G9): the pipeline's retry code, which the recording status shows as `retrying`. Expectations are written by
// hand from G9: a retryable commit, sample or backlog failure sets it; only a successful commit or sample write clears it.
describe('ET-015c retry code of the storage-commit pipeline', () => {
  function retrying(sink: MemorySink, options: {maxPendingCommits?: number} = {}) {
    const changes: (string | undefined)[] = [], delivery = new DurableDelivery(sink, {...options, onRetryCode: code => changes.push(code)});
    const connect = (name = 'welcome', acked = '0') => {
      const link = new Link(sink.log), connection = delivery.connect(welcome(name), link);
      connection.checkpoint(checkpointAt(acked), RECEIVED);
      return {link, connection};
    };
    return {delivery, changes, connect};
  }

  it('keeps a retryable commit failure through the reconnection and its session open, and clears it at the next successful commit', async () => {
    const sink = new MemorySink(), {delivery, changes, connect} = retrying(sink);
    const first = connect();
    sink.failures.push('DISK_FULL');
    first.connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.idle();
    expect([delivery.retryCode, delivery.status, first.link.closes, changes]).toEqual(['DISK_FULL', {state: 'pending', retryCode: 'DISK_FULL'}, [['retryable', 'DISK_FULL']], ['DISK_FULL']]);
    // The reconnection's welcome and session open clear the status's retryCode, but not the pipeline's.
    const second = connect('welcome-reconnect'); await delivery.idle();
    expect([delivery.status, delivery.retryCode, changes]).toEqual([{state: 'active'}, 'DISK_FULL', ['DISK_FULL']]);
    second.connection.enqueue(range(event(1)), event(1), RECEIVED); await delivery.idle();
    expect([second.link.acks, delivery.retryCode, changes]).toEqual([['1'], undefined, ['DISK_FULL', undefined]]);
    // Later successes change nothing.
    second.connection.enqueue(range(event(2)), event(2), RECEIVED); await delivery.idle();
    expect(changes).toEqual(['DISK_FULL', undefined]);
  });

  it('sets BACKLOG_FULL when a bound closes the connection', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const {delivery, changes, connect} = retrying(sink, {maxPendingCommits: 1});
    const {connection} = connect();
    await flush();
    expect(connection.enqueue(range(event(1)), event(1), RECEIVED)).toBe(true);
    expect(connection.enqueue(range(event(2)), event(2), RECEIVED)).toBe(false);
    expect([delivery.retryCode, changes]).toEqual(['BACKLOG_FULL', ['BACKLOG_FULL']]);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    // The open of the closed connection completed; that is no write that clears it.
    expect(delivery.retryCode).toBe('BACKLOG_FULL');
  });

  describe('sample writes', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const snapshotAt = (seq: number) => { const m = structuredClone(server('snapshot')) as Extract<ServerMessage, {kind: 'snapshot'}>; m.seq = String(seq); return m; };

    it('sets the code of a retryable sample failure with the connection open, and clears it at the next successful sample write', async () => {
      const sink = new SamplingSink(); sink.sampleFailures.push('DATABASE_LOCKED');
      const {delivery, changes, connect} = retrying(sink), {link, connection} = connect();
      for (let seq = 0; seq < 60; seq++) connection.snapshot(snapshotAt(100 + seq), RECEIVED);
      await vi.advanceTimersByTimeAsync(0);
      expect([delivery.retryCode, delivery.status, link.closes, changes]).toEqual(['DATABASE_LOCKED', {state: 'active'}, [], ['DATABASE_LOCKED']]);
      await vi.advanceTimersByTimeAsync(SAMPLE_FLUSH_MS);
      expect([sink.log.at(-1), delivery.retryCode, changes]).toEqual(['samples 1-60', undefined, ['DATABASE_LOCKED', undefined]]);
    });

    it('clears a sample failure code at the next successful commit too', async () => {
      const sink = new SamplingSink(); sink.sampleFailures.push('DISK_FULL');
      const {delivery, changes, connect} = retrying(sink), {link, connection} = connect();
      for (let seq = 0; seq < 60; seq++) connection.snapshot(snapshotAt(100 + seq), RECEIVED);
      await vi.advanceTimersByTimeAsync(0);
      expect(delivery.retryCode).toBe('DISK_FULL');
      connection.enqueue(range(event(1)), event(1), RECEIVED); await vi.advanceTimersByTimeAsync(0);
      expect([link.acks, delivery.retryCode, changes]).toEqual([['1'], undefined, ['DISK_FULL', undefined]]);
    });
  });
});

describe('ET-016 PR-7 attach op in the storage-commit pipeline (J9)', () => {
  /** A sink whose late-attach trip is due once the coverage of P1 reaches `dueAt`, until it opened; every open is logged. */
  class AttachingSink extends MemorySink {
    dueAt?: bigint; opened = false; attachFailure?: StorageErrorCode; status: 'committed' | 'duplicate' | 'none' = 'committed';
    observe(m: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>): Result<undefined> { this.log.push(`observe ${m.kind}`); return {ok: true, value: undefined}; }
    readonly attach = {
      due: () => this.dueAt !== undefined && !this.opened && this.through(P1) >= this.dueAt,
      open: (context: {receivedUtcMs: number}) => {
        this.log.push(`attach ${context.receivedUtcMs - RECEIVED}`);
        if (this.attachFailure) return Promise.resolve({ok: false as const, error: storageError(this.attachFailure)});
        this.opened = true;
        return Promise.resolve({ok: true as const, value: {status: this.status}});
      }
    };
  }
  function attaching(dueAt: bigint, options: {maxPendingCommits?: number} = {}) {
    const sink = new AttachingSink(); sink.dueAt = dueAt; sink.paused = true;
    const delivery = new DurableDelivery(sink, options), link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    connection.checkpoint(checkpointAt('0'), RECEIVED);
    return {sink, delivery, link, connection};
  }
  it('opens the trip right after the commit that drained the replayed events, before the items queued behind it, with no ACK of its own', async () => {
    const {sink, delivery, link, connection} = attaching(1n);
    for (const n of [1, 2, 3]) expect(connection.enqueue(range(event(n)), event(n), RECEIVED + n)).toBe(true);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    // The attach carries the receipt label of the commit that made it due (event 1) and runs before event 2.
    expect(sink.log).toEqual([`open ${P1}`, 'observe checkpoint', 'committed 1', 'ack 1', 'attach 1', 'committed 2', 'ack 2', 'committed 3', 'ack 3']);
    expect([link.acks, delivery.status, link.closes]).toEqual([['1', '2', '3'], {state: 'active'}, []]);
  });
  it('opens the trip right after the checkpoint when nothing is replayed, and counts it against no bound', async () => {
    const {sink, delivery, link, connection} = attaching(0n, {maxPendingCommits: 1});
    expect(connection.enqueue(range(event(1)), event(1), RECEIVED + 1)).toBe(true);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    expect(sink.log).toEqual([`open ${P1}`, 'observe checkpoint', 'attach 0', 'committed 1', 'ack 1']);
    expect([link.acks, delivery.pending]).toEqual([['1'], 0]);
  });
  it('fails the connection like a failed commit: retryable closes it and drops its queued items, unavailable stops durable delivery', async () => {
    const retry = attaching(0n); retry.sink.attachFailure = 'DISK_FULL';
    retry.connection.enqueue(range(event(1)), event(1), RECEIVED + 1);
    retry.sink.paused = false; retry.sink.releaseOne(); await retry.delivery.idle();
    expect([retry.sink.log, retry.link.closes, retry.link.acks, retry.delivery.retryCode]).toEqual([[`open ${P1}`, 'observe checkpoint', 'attach 0'], [['retryable', 'DISK_FULL']], [], 'DISK_FULL']);
    const fatal = attaching(0n); fatal.sink.attachFailure = 'INVALID_INPUT';
    fatal.connection.enqueue(range(event(1)), event(1), RECEIVED + 1);
    fatal.sink.paused = false; fatal.sink.releaseOne(); await fatal.delivery.idle();
    expect([fatal.link.closes, fatal.delivery.status]).toEqual([[['unavailable', 'INVALID_INPUT']], {state: 'failed', code: 'INVALID_INPUT'}]);
  });
  it('treats a malformed attach result as INTERNAL and a duplicate as opened', async () => {
    const dup = attaching(0n); dup.sink.status = 'duplicate';
    dup.connection.enqueue(range(event(1)), event(1), RECEIVED + 1);
    dup.sink.paused = false; dup.sink.releaseOne(); await dup.delivery.idle();
    expect([dup.link.acks, dup.link.closes]).toEqual([['1'], []]);
    const bad = attaching(0n); bad.sink.status = 'opened' as 'committed';
    bad.sink.paused = false; bad.sink.releaseOne(); await bad.delivery.idle();
    expect([bad.link.closes, bad.delivery.status]).toEqual([[['unavailable', 'INTERNAL']], {state: 'failed', code: 'INTERNAL'}]);
  });
});
