// The storage-commit ACK pipeline (ET-006b, E5-E8): ACKs exist only after the sink reported a commit, are written only
// to the connection that received the coverage while it is current, and follow the E7 failure table. Expected values
// are written by hand from docs/protocol/v1.md §9-§10, docs/storage.md and the shared protocol v1 fixtures; the sink
// here is an in-memory stand-in with the storage coverage rules, never the code under test (REG-005, REG-006, REG-007,
// REG-011). Real commits through the storage worker are in tests/storage/v1-durable-ingestion.test.ts.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {AckValidator, V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {decodePayload, negotiateV1, validateClientMessage, type ClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {CommitResult, Result, StorageErrorCode} from '../../packages/storage/src/api';
import {ERROR_MESSAGES, storageError} from '../../packages/storage/src/errors';
import {STORAGE_FAILURE_CLASS, StorageDurableSink, failureClass, type CoverageMessage, type DurableSink, type WelcomeMessage} from '../../apps/desktop/src/durable-sink';
import {DurableDelivery, MAX_PENDING_COMMITS, type DurableCloseKind, type DurableLink} from '../../apps/desktop/src/v1-durable-delivery';

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
    } else if (m.kind === 'checkpoint') { validator!.checkpoint(m.data.status.delivery.ackedThroughEventSeq); connection!.checkpoint(m.data.status.delivery.ackedThroughEventSeq); }
    else if (applied.coverage && (m.kind === 'event' || m.kind === 'gap')) { validator!.sent(applied.coverage.lastEventSeq); expect(connection!.enqueue(applied.coverage, m)).toBe(true); }
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
    connection.checkpoint('0');
    return {delivery, link, connection, logs};
  }
  it('never acknowledges on receipt, only after the sink resolves, and never beyond contiguous commits', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const {link, connection} = started(sink);
    for (const n of [1, 2, 3, 4]) connection.enqueue(range(event(n)), event(n));
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
    one.checkpoint('0');
    for (const n of [1, 2, 3]) one.enqueue(range(event(n)), event(n));
    await delivery.idle();
    sink.paused = true;
    one.enqueue(range(event(4)), event(4)); await flush();
    // The connection ends while the commit of 4 is in flight; the commit still completes in storage.
    first.open = false; sink.releaseOne(); sink.paused = false; await delivery.idle();
    expect(first.acks).toEqual(['1', '2', '3']);
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint('3');
    for (const n of [4, 5, 6]) two.enqueue(range(event(n)), event(n));
    await delivery.idle();
    expect(second.acks).toEqual(['4', '5', '6']);
    expect(sink.log.slice(-7)).toEqual([`open ${P1}`, 'duplicate 4', 'ack 4', 'committed 5', 'ack 5', 'committed 6', 'ack 6']);
  });
  it('acknowledges a conflicting redelivery, keeps the stored row and logs the conflict count', async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    connection.enqueue(range(event(1)), event(1)); await delivery.idle();
    link.open = false;
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint('0');
    const different = event(1, 'event-job-cleared');
    two.enqueue(range(different), different); await delivery.idle();
    expect(second.acks).toEqual(['1']);
    expect(sink.log.slice(-2)).toEqual(['conflict 1', 'ack 1']);
    expect(sink.sessions.get(P1)!.events.get(1n)).toContain('job.configured');
    expect(logs).toEqual([['V1_EVENT_CONFLICT', {count: 1}]]);
  });
  it('acknowledges a gap that is wholly inside committed coverage as covered', async () => {
    const sink = new MemorySink(), {delivery, link, connection} = started(sink);
    for (const m of [event(1), gap(2, 3), event(4)]) connection.enqueue(range(m), m);
    await delivery.idle();
    link.open = false;
    const second = new Link(sink.log), two = delivery.connect(welcome('welcome-reconnect'), second);
    two.checkpoint('1');
    const merged = gap(2, 4); two.enqueue(range(merged), merged);
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
    connection.enqueue(range(event(1)), event(1)); connection.enqueue(range(event(2)), event(2));
    await delivery.idle();
    expect([link.acks, link.closes, sink.log]).toEqual([[], [['retryable', code]], [`open ${P1}`, 'failed 1']]);
    expect(delivery.status).toEqual({state: 'pending', retryCode: code});
    expect(delivery.durableAllowed()).toBe(true);
    expect(logs).toEqual([['V1_DURABLE_RETRY', {code, count: 1}]]);
  });
  for (const code of ['WORKER_FAILED', 'TIMEOUT', 'CONSTRAINT_VIOLATION', 'SESSION_CONFLICT', 'INVALID_INPUT', 'INTERNAL', 'PERMISSION_DENIED'] as const) it(`stops durable delivery for the service lifetime on ${code}`, async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    sink.failures.push(code);
    connection.enqueue(range(event(1)), event(1)); connection.enqueue(range(event(2)), event(2));
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
    const a = started(rejecting); a.connection.enqueue(range(event(1)), event(1)); await a.delivery.idle();
    expect([a.link.acks, a.link.closes, a.delivery.status]).toEqual([[], [['unavailable', 'INTERNAL']], {state: 'failed', code: 'INTERNAL'}]);
    const refusing = new MemorySink(); refusing.openFailures.push('CONSTRAINT_VIOLATION');
    const b = started(refusing); b.connection.enqueue(range(event(1)), event(1)); await b.delivery.idle();
    expect([b.link.closes, refusing.log]).toEqual([[['unavailable', 'CONSTRAINT_VIOLATION']], []]);
  });
  it('fails closed on COVERAGE_MISMATCH instead of acknowledging', async () => {
    const sink = new MemorySink(), {delivery, link, connection, logs} = started(sink);
    // Storage reports coverage 7 after committing eventSeq 1, while the cursor holds 1.
    sink.failures.push({committedThroughEventSeq: '7'});
    connection.enqueue(range(event(1)), event(1)); await delivery.idle();
    expect([link.acks, link.closes, delivery.status, logs]).toEqual([[], [['unavailable', 'COVERAGE_MISMATCH']], {state: 'failed', code: 'COVERAGE_MISMATCH'}, [['V1_DURABLE_UNAVAILABLE', {code: 'COVERAGE_MISMATCH'}]]]);
  });
  it('disables durable delivery for one plugin session when its producer acknowledged beyond storage', async () => {
    const sink = new MemorySink(), logs: unknown[] = [], delivery = new DurableDelivery(sink, {log: (...entry) => logs.push(entry)});
    const link = new Link(sink.log), connection = delivery.connect(welcome(), link);
    // Storage holds nothing for P1 (C = 0) while the checkpoint says the producer released through 3 (A = 3).
    connection.checkpoint('3'); connection.enqueue(range(event(4)), event(4));
    await delivery.idle();
    expect([link.acks, link.closes, sink.log]).toEqual([[], [['ack-ahead', 'ACK_AHEAD_OF_STORAGE']], [`open ${P1}`]]);
    expect(delivery.status).toEqual({state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'});
    expect([delivery.durableAllowed(), delivery.durableAllowed(P1), delivery.durableAllowed(P2)]).toEqual([false, false, true]);
    expect([delivery.observeLiveOnly(P1), delivery.observeLiveOnly(P2), delivery.durableAllowed()]).toEqual([false, true, true]);
    expect(logs).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}]]);
  });
  it('bounds the backlog at 256 coverage items and closes the connection on the 257th (REG-011)', async () => {
    expect(MAX_PENDING_COMMITS).toBe(256);
    const sink = new MemorySink(); sink.paused = true;
    const {delivery, link, connection, logs} = started(sink);
    // The session open is in flight and held, so the items below queue behind it.
    await flush(); expect(sink.waitingCommands).toBe(1);
    for (let n = 1; n <= 256; n++) expect(connection.enqueue(range(event(n)), event(n))).toBe(true);
    expect([delivery.pending, link.closes]).toEqual([256, []]);
    expect(connection.enqueue(range(event(257)), event(257))).toBe(false);
    expect([delivery.pending, link.closes, logs]).toEqual([0, [['retryable', 'BACKLOG_FULL']], [['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]]);
    sink.paused = false; sink.releaseOne(); await delivery.idle();
    // The open completed; no queued item of the closed connection was committed or acknowledged.
    expect([sink.log, link.acks]).toEqual([[`open ${P1}`], []]);
  });
  it('drops queued work on stop and waits for the command in flight', async () => {
    const sink = new MemorySink(); sink.paused = true;
    const {delivery, link, connection} = started(sink);
    for (const n of [1, 2, 3]) connection.enqueue(range(event(n)), event(n));
    await flush(); sink.releaseOne(); await flush();
    const stopped = delivery.stop(); let done = false; void stopped.then(() => { done = true; });
    await flush(); expect(done).toBe(false);
    sink.releaseOne(); await stopped;
    // The command in flight completes in storage, but nothing is written after stop.
    expect([sink.log, link.acks, delivery.pending, delivery.durableAllowed()]).toEqual([[`open ${P1}`, 'committed 1'], [], 0, false]);
  });

  it('commits through StorageClient commands and reads coverage before a gap that carries effects', async () => {
    const calls: string[] = [];
    const ok = <T>(value: T) => Promise.resolve({ok: true as const, value});
    const storage = {
      upsertSession: (input: {message: unknown}) => { calls.push(`upsert ${(input.message as ServerMessage).kind}`); return ok({created: true, committedThroughEventSeq: '2'}); },
      commitEvent: (input: {message: unknown; effects?: unknown[]}) => { calls.push(`event ${input.effects?.length ?? 'none'}`); return ok<CommitResult>({status: 'committed', committedThroughEventSeq: '3'}); },
      commitGap: (input: {message: unknown; effects?: unknown[]}) => { calls.push(`gap ${input.effects?.length ?? 'none'}`); return ok<CommitResult>({status: 'committed', committedThroughEventSeq: '5', previouslyCoveredThrough: '3'}); },
      committedThrough: (session: string) => { calls.push(`through ${session}`); return ok('3'); }
    };
    expect(await new StorageDurableSink(storage).openSession(welcome())).toEqual({ok: true, value: {committedThroughEventSeq: '2'}});
    await new StorageDurableSink(storage).commit(event(3));
    await new StorageDurableSink(storage).commit(gap(4, 5));
    const seen: string[] = [];
    const hooked = new StorageDurableSink(storage, (m, covered) => { seen.push(`${m.kind} ${covered}`); return m.kind === 'gap' ? [{kind: 'completeness.add', interval: {kind: 'event-loss', firstEventSeq: '4', lastEventSeq: '5'}}] : []; });
    await hooked.commit(gap(4, 5)); await hooked.commit(event(3));
    expect(calls).toEqual(['upsert welcome', 'event none', 'gap none', `through ${P1}`, 'gap 1', `through ${P1}`, 'event none']);
    expect(seen).toEqual(['gap 3', 'event 3']);
  });
});
