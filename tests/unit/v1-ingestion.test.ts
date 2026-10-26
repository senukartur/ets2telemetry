// Protocol v1 ingestion with fake sockets and fake timers. The shared durable fixtures need a durable hello, so most
// cases run with an in-memory sink (ET-006b, E2, E9, E10): the hello, hydration without coverage,
// freshness on the service receive clock, fail-closed validation, reconnect backoff, clock probes and the ACK wiring.
// Expected values are written by hand from docs/protocol/v1.md and the shared fixtures (REG-003, REG-004, REG-005,
// REG-010, REG-011). Actual pipes are in v1-ingestion-pipe.test.ts.
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {decodePayload, encodeFrame, type ClientMessage, type ServerMessage, type SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import type {CommitResult, Result, StorageErrorCode} from '../../packages/storage/src/api';
import {storageError} from '../../packages/storage/src/errors';
import type {CoverageMessage, DurableSink} from '../../apps/desktop/src/durable-sink';
import type {TelemetrySocket} from '../../apps/desktop/src/native-pipe-client';
import {V1_CLIENT_MAX_MINOR, V1Ingestion, type V1IngestionOptions, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {header, payload} from '../shared/cap0-fixtures';

const V1 = resolve('tests/fixtures/protocol-v1');
const fileBytes = (path: string) => new Uint8Array(readFileSync(path));
const server = (name: string) => decodePayload(fileBytes(resolve(V1, `${name}.json`)), 'server') as ServerMessage;
const prefix = (bytes: Uint8Array) => { const out = new Uint8Array(4 + bytes.length); new DataView(out.buffer).setUint32(0, bytes.length, true); out.set(bytes, 4); return out; };
/** A shared fixture framed exactly as the producer writes it. */
const frame = (name: string) => prefix(fileBytes(resolve(V1, `${name}.json`)));
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const ENDPOINT = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-1-00000000-0000-4000-8000-000000000000';
const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const CAPTURE_CLOCK = '30000000-0000-4000-8000-000000000001';

class FakeSocket extends EventEmitter implements TelemetrySocket {
  readonly sent: ClientMessage[] = []; destroyed = false; authority?: SourceIdentity; completion?: Promise<void>;
  // Any minor decodes here; the ET-050b and ET-052 cases check which minor each message carries.
  write(bytes: Uint8Array) { this.sent.push(decodePayload(bytes.subarray(4), 'client', {maxMinor: 2}) as ClientMessage); }
  destroy() { this.destroyed = true; }
  feed(...parts: Uint8Array[]) { this.emit('data', concat(...parts)); }
  get hello() { const h = this.sent[0]; if (h?.kind !== 'hello') throw new Error('hello expected'); return h.data; }
  get acks() { return this.sent.flatMap(m => m.kind === 'ack' ? [m.data.throughEventSeq] : []); }
  get probes() { return this.sent.flatMap(m => m.kind === 'clock.probe' ? [m.data.probeId] : []); }
}

/** A minimal in-memory sink: every commit succeeds with contiguous coverage, unless held or scripted to fail. */
class Sink implements DurableSink {
  through = 0n; commits: string[] = []; held: (() => void)[] = []; hold = false; fail?: StorageErrorCode;
  openSession(): Promise<Result<{committedThroughEventSeq: string}>> { return Promise.resolve({ok: true, value: {committedThroughEventSeq: this.through.toString()}}); }
  async commit(m: CoverageMessage): Promise<Result<CommitResult>> {
    if (this.hold) await new Promise<void>(r => this.held.push(r));
    if (this.fail) return {ok: false, error: storageError(this.fail)};
    const last = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.lastEventSeq);
    const status = last <= this.through ? 'duplicate' : 'committed';
    if (last > this.through) this.through = last;
    this.commits.push(`${m.kind} ${last}`);
    return {ok: true, value: {status, committedThroughEventSeq: this.through.toString()}};
  }
}

/** A Sink that also observes readings; `trace` lists observed readings and commits with their receipt labels in order. */
class ObservingSink extends Sink {
  readonly trace: string[] = [];
  override async commit(m: CoverageMessage, context?: {receivedUtcMs: number}): Promise<Result<CommitResult>> {
    const result = await super.commit(m);
    this.trace.push(`commit ${m.kind === 'event' ? m.data.eventSeq : m.data.lastEventSeq} ${context?.receivedUtcMs}`);
    return result;
  }
  observe(m: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>): Result<undefined> { this.trace.push(`observe ${m.kind} ${m.seq}`); return {ok: true, value: undefined}; }
}

let clock: {ms: number; ns: bigint};
let sockets: FakeSocket[];
let states: V1SourceState[];
let ingestion: V1Ingestion | undefined;
beforeEach(() => { vi.useFakeTimers(); clock = {ms: 0, ns: 2_000_000_000_000n}; sockets = []; states = []; });
afterEach(async () => { await ingestion?.stop(); ingestion = undefined; vi.useRealTimers(); });
function start(options: V1IngestionOptions = {}, selection: 'synthetic' | 'replay' | 'ets2' = 'synthetic') {
  ingestion = new V1Ingestion({now: () => clock.ms, nowNs: () => clock.ns, connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onState: state => states.push(state), ...options});
  ingestion.select(selection, ENDPOINT);
  return ingestion;
}
const latest = () => sockets.at(-1)!;
const connectLatest = () => latest().emit('connect');
const state = () => ingestion!.current;
const advance = (ms: number) => { clock.ms += ms; return vi.advanceTimersByTimeAsync(ms); };
const settle = () => vi.advanceTimersByTimeAsync(0);
/** A fixture re-encoded with a changed envelope or data; encodeFrame validates it first. */
function edited(name: string, edit: (m: ServerMessage & {data: Record<string, unknown>}) => void) {
  const m = structuredClone(server(name)) as ServerMessage & {data: Record<string, unknown>}; edit(m); return encodeFrame(m);
}

describe('ET-006b protocol v1 ingestion', () => {
  it('sends one live-only hello without a sink and a durable hello with one', () => {
    start(); connectLatest();
    // ET-050b B1, ET-052: the hello is version 1.0 and offers minor 2 (it offered 0 before ET-050b PR-5 and 1 before ET-052 PR-4).
    expect(latest().sent).toEqual([{version: {major: 1, minor: 0}, kind: 'hello', data: {clientInstanceId: ingestion!.clientInstanceId, minMinor: 0, maxMinor: 2, durableEvents: false}}]);
    void ingestion!.stop();
    start({sink: new Sink()}); connectLatest();
    expect(latest().hello.durableEvents).toBe(true);
    expect(state().durable).toEqual({state: 'pending'});
  });

  it('is never fresh from a welcome alone; the checkpoint hydrates current state without coverage (REG-003, REG-004)', async () => {
    const sink = new Sink(); start({sink}); connectLatest();
    latest().feed(frame('welcome'));
    expect([state().status, state().fresh, state().observation]).toEqual(['waiting', false, undefined]);
    latest().feed(frame('checkpoint-late'));
    await settle();
    expect([state().status, state().fresh, state().observation?.kind, state().observation?.hydration]).toEqual(['connected', true, 'checkpoint', true]);
    // The late checkpoint carries an available job configuration: it replaces state only, never a commit or an ACK.
    expect(state().observation?.state.configuration.job.available).toBe(true);
    expect([sink.commits, latest().acks]).toEqual([[], []]);
    expect(state().durable).toEqual({state: 'active'});
    // Its offline gap is coverage and is acknowledged only after the sink committed it.
    latest().feed(frame('gap-offline')); await settle();
    expect([sink.commits, latest().acks]).toEqual([['gap 3'], ['3']]);
  });

  it('goes stale 500 ms after the last new SDK boundary and reports a paused simulation', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'));
    expect(state().status).toBe('connected');
    await advance(450); expect(state().status).toBe('connected');
    await advance(50); expect([state().status, state().fresh]).toEqual(['stale', false]);
    // A snapshot with a later boundary is a new observation.
    latest().feed(frame('snapshot')); expect([state().status, state().observation?.receivedMonotonicMs]).toEqual(['connected', 500]);
    // A snapshot that repeats the boundary keeps its original receipt time and does not refresh.
    await advance(300);
    latest().feed(edited('snapshot', m => { m.seq = '6'; m.capture.monotonicNs = '1000260000000'; }));
    expect(state().observation?.receivedMonotonicMs).toBe(500);
    await advance(200); expect(state().status).toBe('stale');
    latest().feed(edited('snapshot', m => { m.seq = '7'; m.capture.monotonicNs = '1000270000000'; (m.data.state as {simulation: string; boundaryOrder: string}).simulation = 'paused'; (m.data.state as {boundaryOrder: string}).boundaryOrder = '103'; }));
    expect([state().status, state().fresh]).toEqual(['paused', true]);
  });

  const v0Frame = () => frame('../protocol-v0/checkpoint');
  const cap0Frame = () => prefix(payload(header()));
  const rejections: [string, () => Uint8Array[], 'synthetic' | 'replay', boolean][] = [
    ['an origin that differs from the selection', () => [frame('welcome')], 'replay', false],
    ['a v0 frame', () => [v0Frame()], 'synthetic', false],
    ['a CAP0 frame', () => [cap0Frame()], 'synthetic', false],
    ['a frame after end', () => [frame('welcome'), frame('checkpoint'), concat(frame('end-early'), frame('snapshot'))], 'synthetic', true],
    ['a duplicate eventSeq', () => [frame('welcome'), frame('checkpoint'), frame('event-job-configured'), frame('event-job-configured-repeat')], 'synthetic', true],
    ['a skipped eventSeq', () => [frame('welcome'), frame('checkpoint'), frame('event-job-configured'), frame('event-simulation-paused-e5')], 'synthetic', true],
    ['an event on a live-only connection', () => [frame('welcome-live'), frame('checkpoint-live'), frame('event-job-configured')], 'synthetic', false],
    ['a client message from the server', () => [frame('ack-1')], 'synthetic', false]
  ];
  for (const [name, frames, selection, durable] of rejections) it(`fails closed on ${name} without reconnecting (REG-005, REG-010)`, async () => {
    const sink = durable ? new Sink() : undefined;
    start({sink}, selection); connectLatest();
    const all = frames();
    // Every frame before the last is valid on its own; only the last read violates the contract.
    for (const f of all.slice(0, -1)) latest().feed(f);
    expect(state().status).not.toBe('incompatible');
    latest().feed(all.at(-1)!);
    await settle();
    expect([state().status, latest().destroyed]).toEqual(['incompatible', true]);
    await advance(10_000);
    expect(sockets).toHaveLength(1);
    // The valid event before the violation still commits, but its ACK is never written to the closed connection (E8).
    if (sink && name.includes('eventSeq')) expect([sink.commits, latest().acks]).toEqual([['event 1'], []]);
  });

  it('accepts a game source only when every envelope matches the broker authority', () => {
    const asGame = (name: string, edit: (m: ServerMessage & {data: Record<string, unknown>}) => void = () => undefined) => edited(name, m => { m.source.origin = 'game'; edit(m); });
    const authority = {...server('welcome').source, origin: 'game' as const};
    const games: FakeSocket[] = [];
    const connectGame = () => { const s = new FakeSocket(); s.authority = authority; games.push(s); return s; };
    start({broker: {executable: 'broker.exe', discoveryDirectory: 'transport'}, connectGame, sink: new Sink()}, 'ets2');
    games[0].emit('connect');
    games[0].feed(asGame('welcome'), asGame('checkpoint'));
    expect(state().status).toBe('connected');
    games[0].feed(asGame('snapshot', m => { m.source.processId = 999; }));
    expect(state().status).toBe('incompatible');
    // A fixture origin under game authority fails closed (E14).
    void ingestion!.stop();
    start({broker: {executable: 'broker.exe', discoveryDirectory: 'transport'}, connectGame, sink: new Sink()}, 'ets2');
    games[1].emit('connect'); games[1].feed(frame('welcome'));
    expect(state().status).toBe('incompatible');
    // Without the native v1 client a game selection stays unavailable; a fixture endpoint must be synthetic v1.
    void ingestion!.stop();
    start({broker: {executable: 'broker.exe', discoveryDirectory: 'transport'}}, 'ets2');
    expect([state().status, sockets.length]).toEqual(['unavailable', 0]);
    void ingestion!.stop();
    ingestion = new V1Ingestion({connect: () => { throw new Error('never'); }}); ingestion.select('synthetic', ENDPOINT.replace('-v1-', '-v0-'));
    expect(ingestion.current.status).toBe('unavailable');
  });

  /** Waits in 50 ms steps until the ingestion opens its next socket and returns the delay. */
  async function nextDelay() {
    const before = sockets.length; let waited = 0;
    while (sockets.length === before) { await advance(50); waited += 50; if (waited > 10_000) throw new Error('no reconnection'); }
    return waited;
  }
  it('reconnects after 250, 500, 1000, 2000, 4000 and 4000 ms and resets after the first commit of a durable connection (E9)', async () => {
    start({sink: new Sink()});
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      latest().emit('close');
      const before = sockets.length; let waited = 0;
      while (sockets.length === before) { await advance(50); waited += 50; }
      delays.push(waited);
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 4000]);
    // A durable checkpoint alone does not prove the connection healthy; the backoff keeps its step.
    connectLatest(); latest().feed(frame('welcome'), frame('checkpoint')); await settle();
    latest().emit('end');
    expect(state().status).toBe('disconnected');
    expect(await nextDelay()).toBe(4000);
    // The first successful commit does: the next reconnection waits 250 ms again.
    connectLatest(); latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured')); await settle();
    expect(latest().acks).toEqual(['1']);
    latest().emit('end');
    expect(await nextDelay()).toBe(250);
  });

  it('resets the backoff at the checkpoint of a live-only connection (E9)', async () => {
    start();
    for (const expected of [250, 500]) { latest().emit('close'); expect(await nextDelay()).toBe(expected); }
    connectLatest(); latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    latest().emit('end');
    expect(await nextDelay()).toBe(250);
  });

  it('keeps backing off while a retryable storage failure persists, instead of reconnecting every 250 ms (E7, E9)', async () => {
    const sink = new Sink(); sink.fail = 'DISK_FULL'; start({sink});
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      connectLatest();
      latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured')); await settle();
      expect([latest().destroyed, latest().acks]).toEqual([true, []]);
      delays.push(await nextDelay());
    }
    // Hand-written from E9: each hydrated connection is closed by the failed commit before it proves healthy.
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 4000]);
    sink.fail = undefined;
    connectLatest(); latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured')); await settle();
    expect(latest().acks).toEqual(['1']);
    latest().emit('close');
    expect(await nextDelay()).toBe(250);
  });

  it('reports a receive clock regression as a clock failure, not a protocol violation', () => {
    start({sink: new Sink()}); connectLatest();
    clock.ms = 10; latest().feed(frame('welcome'), frame('checkpoint'));
    clock.ms = 5; latest().feed(frame('snapshot'));
    expect([state().status, state().reason]).toEqual(['incompatible', 'Receive clock failure']);
  });

  it('chooses the hello durability from the broker authority that arrives with connect (ACK_AHEAD_OF_STORAGE)', async () => {
    const asGame = (name: string) => edited(name, m => { m.source.origin = 'game'; });
    const sessions = [P1, P2, P1], games: FakeSocket[] = [];
    // Like NativePipeClient, the authority receipt is set only when the broker reports it, right before 'connect'.
    const arrive = (socket: FakeSocket, pluginSessionId: string) => { socket.authority = {...server('welcome').source, origin: 'game', pluginSessionId}; socket.emit('connect'); };
    const connectGame = () => { const s = new FakeSocket(); games.push(s); return s; };
    start({broker: {executable: 'broker.exe', discoveryDirectory: 'transport'}, connectGame, sink: new Sink()}, 'ets2');
    expect(games[0].authority).toBeUndefined();
    arrive(games[0], sessions[0]);
    expect(games[0].hello.durableEvents).toBe(true);
    // Storage holds nothing (C = 0) while the producer released through 1 (A = 1): P1 continues live-only.
    games[0].feed(asGame('welcome'), asGame('checkpoint-reconnect')); await settle();
    expect(state().durable).toEqual({state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'});
    await advance(250); arrive(games[1], sessions[1]);
    expect(games[1].hello.durableEvents).toBe(true);
    games[1].emit('close'); await advance(500); arrive(games[2], sessions[2]);
    expect(games[2].hello.durableEvents).toBe(false);
  });

  it('keeps the end marker, disconnects and reconnects', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('end-early'));
    expect([state().status, state().lastEnd]).toEqual(['disconnected', {reason: 'source-retired', nextEventSeq: '1', ackedThroughEventSeq: '0', retainedUnacked: '0'}]);
    await advance(250); expect(sockets).toHaveLength(2);
    expect(state().lastEnd?.reason).toBe('source-retired');
  });

  it('probes the source clock once per second after the checkpoint and maps the hand-computed reply (§11)', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame('welcome'));
    expect(latest().probes).toEqual([]);
    latest().feed(frame('checkpoint'));
    expect(latest().probes).toEqual(['1']);
    // The probe is outstanding: no second probe, however long the reply takes.
    await advance(1000); expect(latest().probes).toEqual(['1']);
    // t0 = 2,000,000,000,000; t1 = 1,000,449,700,000; t2 = 1,000,449,900,000; t3 = t0 + 500,000.
    // RTT = 500,000 - 200,000 = 300,000; offset = floor((-999,550,300,000 + -999,550,600,000) / 2) = -999,550,450,000; uncertainty = 150,000.
    clock.ns = 2_000_000_500_000n; latest().feed(frame('clock-reply'));
    expect(state().clockMapping).toEqual({sourceClockId: CAPTURE_CLOCK, clientClockId: ingestion!.clientClockId, offsetNs: '-999550450000', uncertaintyNs: '150000', measuredAtClientNs: '2000000500000'});
    expect(state().clockBoundary).toEqual({clockId: CAPTURE_CLOCK, probeSentClientNs: '2000000000000', receivedSourceNs: '1000449700000'});
    await advance(1000); expect(latest().probes).toEqual(['1', '2']);
  });

  it.each(['unsolicited', 'mismatched'] as const)('does not expose a causal boundary for an %s reply', async kind => {
    start(); latest().feed(frame('welcome'), frame('checkpoint'));
    if (kind === 'mismatched') await advance(1000);
    const reply = server('clock-reply'); if (reply.kind !== 'clock.reply') throw new Error('fixture');
    if (kind === 'mismatched') reply.data.probeId = '2';
    latest().feed(encodeFrame(reply));
    expect(state().status).toBe('incompatible'); expect(state().clockBoundary).toBeUndefined();
  });
  it('accepts a late clock reply without a mapping and probes again only after it arrived', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'));
    await advance(3000); expect(latest().probes).toEqual(['1']);
    // t3 - t0 = 1,000,000,001 ns: later than the 1 s deadline, with a valid round trip.
    clock.ns = 2_001_000_000_001n; latest().feed(frame('clock-reply'));
    expect(state().clockMapping).toBeUndefined(); expect(state().clockBoundary).toBeUndefined(); expect(state().status).not.toBe('incompatible');
    await advance(1000); expect(latest().probes).toEqual(['1', '2']);
  });

  it('writes an ACK only after the commit and never for a commit that finishes after the connection closed (E8)', async () => {
    const sink = new Sink(); start({sink}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured'));
    expect(latest().acks).toEqual([]);
    await settle(); expect(latest().acks).toEqual(['1']);
    sink.hold = true;
    latest().feed(frame('snapshot'), frame('event-truck-configured-e2'));
    await settle(); expect(latest().acks).toEqual(['1']);
    const first = latest(); first.emit('close');
    sink.held.shift()!(); await settle();
    expect([sink.commits, first.acks]).toEqual([['event 1', 'event 2'], ['1']]);
    // The next connection receives 2 again (A = 1) and acknowledges it once its duplicate commit returns.
    sink.hold = false; await advance(250); connectLatest();
    latest().feed(frame('welcome-reconnect'), frame('checkpoint-reconnect'), frame('event-truck-configured-redelivered'));
    await settle(); expect(latest().acks).toEqual(['2']);
  });

  it('closes on a retryable storage failure and stays durable; reconnects live-only after a non-retryable one (E7)', async () => {
    const sink = new Sink(); sink.fail = 'DISK_FULL'; start({sink}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured')); await settle();
    expect([latest().acks, latest().destroyed, state().status, state().durable]).toEqual([[], true, 'disconnected', {state: 'pending', retryCode: 'DISK_FULL'}]);
    await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(true);
    sink.fail = 'WORKER_FAILED';
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured')); await settle();
    expect([latest().acks, latest().destroyed, state().durable]).toEqual([[], true, {state: 'failed', code: 'WORKER_FAILED'}]);
    await advance(500); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
    // The live-only connections after a failure for the service lifetime keep reporting it, never `off`.
    latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    expect([state().status, state().durable]).toEqual(['connected', {state: 'failed', code: 'WORKER_FAILED'}]);
  });

  it('reports `off`, never `pending`, while storage never becomes ready, as after a refused open (R10, PR-3 review pass 1)', async () => {
    start({sink: new Sink(), durableSelections: ['synthetic'], durableReady: () => false}); connectLatest();
    expect(latest().hello.durableEvents).toBe(false);
    latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    latest().emit('close'); await advance(250); connectLatest();
    expect(latest().hello.durableEvents).toBe(false);
    latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    expect(state().status).toBe('connected');
    expect([...new Set(states.map(s => s.durable.state))]).toEqual(['off']);
  });

  it('continues live-only after ACK_AHEAD_OF_STORAGE until another plugin session appears', async () => {
    const sink = new Sink(); start({sink}); connectLatest();
    // Storage holds nothing (C = 0) while the producer released through 1 (A = 1).
    latest().feed(frame('welcome'), frame('checkpoint-reconnect')); await settle();
    expect([latest().destroyed, state().durable]).toEqual([true, {state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'}]);
    await advance(250); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
    latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    expect([state().status, latest().destroyed]).toEqual(['connected', false]);
    latest().emit('close'); await advance(500); connectLatest(); expect(latest().hello.durableEvents).toBe(false);
    // A live-only welcome of another plugin session lifts the block and reconnects durable.
    latest().feed(edited('welcome-restart', m => { m.data.durableEvents = false; }));
    expect(latest().destroyed).toBe(true);
    await advance(1000); connectLatest(); expect(latest().hello.durableEvents).toBe(true);
    expect(server('welcome-restart').source.pluginSessionId).toBe(P2);
    expect(server('welcome').source.pluginSessionId).toBe(P1);
  });

  it('requests durable delivery only while storage is ready and reconnects once when it becomes ready (R10)', async () => {
    let ready = false;
    start({sink: new Sink(), durableReady: () => ready}); connectLatest();
    expect(latest().hello.durableEvents).toBe(false);
    latest().feed(frame('welcome-live'), frame('checkpoint-live'));
    // The connection did not request durable delivery, so it reports `off` (PR-3 review pass 1), not `pending`.
    expect([state().status, state().durable]).toEqual(['connected', {state: 'off'}]);
    // Nothing is possible yet: the live-only connection stays.
    ingestion!.durableAvailabilityChanged();
    expect([latest().destroyed, sockets]).toEqual([false, [latest()]]);
    ready = true; ingestion!.durableAvailabilityChanged();
    expect([latest().destroyed, state().status]).toEqual([true, 'disconnected']);
    // Exactly one reconnection, on the shortest backoff, with a durable hello.
    expect(await nextDelay()).toBe(250);
    connectLatest(); expect(latest().hello.durableEvents).toBe(true);
    expect(state().durable).toEqual({state: 'pending'});
    latest().feed(frame('welcome'), frame('checkpoint'));
    ingestion!.durableAvailabilityChanged();
    await advance(5_000);
    expect([sockets.length, latest().destroyed, state().durable]).toEqual([2, false, {state: 'active'}]);
  });

  it('keeps a selection that is not durable live-only, also for a game source (R10)', async () => {
    start({sink: new Sink(), durableSelections: ['synthetic']}, 'replay');
    expect(state().durable).toEqual({state: 'off'});
    connectLatest();
    // A selection that is not durable reports `off` although a sink exists (PR-3 review pass 1).
    expect([latest().hello.durableEvents, state().durable]).toEqual([false, {state: 'off'}]);
    ingestion!.durableAvailabilityChanged();
    expect(latest().destroyed).toBe(false);
    void ingestion!.stop();
    // A game selection with a synthetic-only plan: the hello stays live-only although the broker names the session.
    const games: FakeSocket[] = [], authority = {...server('welcome').source, origin: 'game' as const};
    start({broker: {executable: 'broker.exe', discoveryDirectory: 'transport'}, connectGame: () => { const s = new FakeSocket(); s.authority = authority; games.push(s); return s; },
      sink: new Sink(), durableSelections: ['synthetic']}, 'ets2');
    games[0].emit('connect');
    expect([games[0].hello.durableEvents, state().durable]).toEqual([false, {state: 'off'}]);
    void ingestion!.stop();
    start({sink: new Sink(), durableSelections: ['synthetic']}); connectLatest();
    expect(latest().hello.durableEvents).toBe(true);
    await settle();
  });

  it('hands the durable checkpoint and snapshots to the sink in stream order and labels each item at its receipt (R5, R8)', async () => {
    let utc = 1_900_000_000_000;
    const sink = new ObservingSink(); sink.hold = true;
    start({sink, utcNow: () => utc}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured'));
    utc += 5_000;
    latest().feed(frame('snapshot'), frame('event-truck-configured-e2'));
    // The label is the receipt time, even though the commit runs only after the hold is released (R8).
    utc += 60_000;
    await settle(); expect(sink.held).toHaveLength(1);
    sink.hold = false; sink.held.shift()!(); await settle();
    expect(sink.trace).toEqual([`observe checkpoint ${server('checkpoint').seq}`, 'commit 1 1900000000000', `observe snapshot ${server('snapshot').seq}`, 'commit 2 1900000005000']);
    expect(latest().acks).toEqual(['1', '2']);
    // A live-only connection hands nothing to the sink.
    const live = new ObservingSink();
    void ingestion!.stop();
    start({sink: live, durableReady: () => false}); connectLatest();
    latest().feed(frame('welcome-live'), frame('checkpoint-live'), frame('snapshot'));
    await settle(); expect(live.trace).toEqual([]);
  });

  it('labels each durable checkpoint and snapshot with utcNow() at its decode, not when it is observed (H13)', async () => {
    let utc = 1_900_000_000_000;
    const labels: string[] = [];
    class LabellingSink extends ObservingSink {
      override observe(m: Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>, context?: {receivedUtcMs: number}): Result<undefined> {
        labels.push(`${m.kind} ${context?.receivedUtcMs}`); return super.observe(m);
      }
    }
    const sink = new LabellingSink(); sink.hold = true;
    start({sink, utcNow: () => utc}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured'));
    utc += 5_000;
    // The snapshot is decoded now but observed only after the held commit before it.
    latest().feed(frame('snapshot'));
    utc += 60_000;
    await settle(); expect(labels).toEqual(['checkpoint 1900000000000']);
    sink.hold = false; sink.held.shift()!(); await settle();
    expect(labels).toEqual(['checkpoint 1900000000000', 'snapshot 1900000005000']);
  });

  it('stopSource() ends the source without a later ACK; flush() waits for the commit in flight (R14)', async () => {
    const sink = new Sink(); sink.hold = true; start({sink}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'), frame('event-job-configured'));
    await settle(); expect(sink.held).toHaveLength(1);
    const socket = latest();
    await ingestion!.stopSource();
    expect(socket.destroyed).toBe(true);
    const flushed = ingestion!.flush(); let done = false; void flushed.then(() => { done = true; });
    await settle(); expect(done).toBe(false);
    sink.held.shift()!(); await flushed;
    // The commit completed in storage, but nothing is written after the source stopped.
    expect([sink.commits, socket.acks]).toEqual([['event 1'], []]);
    await advance(10_000); expect(sockets).toHaveLength(1);
  });

  it('stop() waits for the owned source to complete', async () => {
    let complete!: () => void;
    start({connect: () => { const s = new FakeSocket(); s.completion = new Promise<void>(r => { complete = r; }); sockets.push(s); return s; }});
    const stopped = ingestion!.stop(); let done = false; void stopped.then(() => { done = true; });
    await settle(); expect([done, latest().destroyed]).toEqual([false, true]);
    complete(); await settle(); expect(done).toBe(true);
    ingestion = undefined;
  });
});

// ET-050b B1, B7: one negotiated minor per connection. The minor-1 fixtures are in tests/fixtures/protocol-v1/minor1;
// the original fixtures are minor 0, as a plugin from before ET-050b sends them. Expected values are written by hand.
const M1 = resolve(V1, 'minor1');
const frame1 = (name: string) => prefix(fileBytes(resolve(M1, `${name}.json`)));
const server1 = (name: string) => decodePayload(fileBytes(resolve(M1, `${name}.json`)), 'server', {maxMinor: 1}) as ServerMessage;
// ET-052: the minor-2 corpus (tests/fixtures/protocol-v1/minor2), hand-authored from the minor-1 bytes.
const M2 = resolve(V1, 'minor2');
const frame2 = (name: string) => prefix(fileBytes(resolve(M2, `${name}.json`)));
const server2 = (name: string) => decodePayload(fileBytes(resolve(M2, `${name}.json`)), 'server', {maxMinor: 2}) as ServerMessage;
describe('ET-050b protocol v1 minor negotiation', () => {
  it('derives the hello offer, the probe and ACK minors and the clock mapping from one negotiated minor', async () => {
    // ET-052: the service offers minor 2, and a minor-1 plugin (ET-050b) still selects 1 for the whole connection.
    expect(V1_CLIENT_MAX_MINOR).toBe(2);
    const sink = new Sink(); start({sink}); connectLatest();
    expect(latest().hello.maxMinor).toBe(V1_CLIENT_MAX_MINOR);
    latest().feed(frame1('welcome'), frame1('checkpoint'), frame1('event-job-configured'));
    await settle();
    expect(state().status).toBe('connected');
    // The checkpoint's probe and the ACK after the commit carry the welcome's minor 1.
    expect(latest().sent.slice(1).map(m => [m.kind, m.version])).toEqual([['clock.probe', {major: 1, minor: 1}], ['ack', {major: 1, minor: 1}]]);
    expect([sink.commits, latest().acks]).toEqual([['event 1'], ['1']]);
    // t0 = 2,000,000,000,000; the minor-1 reply has the same times as the minor-0 fixture, so the mapping is the same.
    clock.ns = 2_000_000_500_000n; latest().feed(frame1('snapshot'), frame1('clock-reply'));
    expect(state().status).toBe('connected');
    expect(state().clockMapping).toEqual({sourceClockId: CAPTURE_CLOCK, clientClockId: ingestion!.clientClockId, offsetNs: '-999550450000', uncertaintyNs: '150000', measuredAtClientNs: '2000000500000'});
    await advance(1000);
    expect(latest().sent.at(-1)).toEqual({version: {major: 1, minor: 1}, kind: 'clock.probe', data: {probeId: '2'}});
  });

  it('accepts a minor-0 welcome from an older plugin and then writes every probe and ACK at minor 0', async () => {
    const sink = new Sink(); start({sink}); connectLatest();
    expect(latest().hello.maxMinor).toBe(2);
    latest().feed(frame1('welcome-minor-0'), frame1('checkpoint-minor-0'), frame1('event-job-configured-minor-0'));
    await settle();
    expect(state().status).toBe('connected');
    expect(latest().sent.slice(1).map(m => [m.kind, m.version])).toEqual([['clock.probe', {major: 1, minor: 0}], ['ack', {major: 1, minor: 0}]]);
    // A minor-0 state carries no gearbox; the live projection reports it as not-supported (live-v1.test.ts).
    expect(state().observation && Object.hasOwn(state().observation!.state, 'gearbox')).toBe(false);
    clock.ns = 2_000_000_500_000n; latest().feed(frame('clock-reply'));
    expect(state().clockMapping?.offsetNs).toBe('-999550450000');
  });

  it.each([
    ['a minor-1 frame after a minor-0 welcome', () => concat(frame1('welcome-minor-0'), frame1('checkpoint'))],
    ['a minor-0 frame after a minor-1 welcome', () => concat(frame1('welcome'), frame1('checkpoint-minor-0'))],
    ['a minor-0 state with a gearbox', () => concat(frame1('welcome-minor-0'), frame1('checkpoint-minor-0-with-gearbox'))],
    ['a minor-1 state without a gearbox', () => concat(frame1('welcome'), frame1('checkpoint-without-gearbox'))],
    ['a welcome above the offer', () => frame2('welcome-minor-3')]
  ])('closes the connection as incompatible on %s', (_name, bytes) => {
    start({sink: new Sink()}); connectLatest(); latest().feed(bytes());
    expect([state().status, state().fresh, state().observation]).toEqual(['incompatible', false, undefined]);
  });

  it('replaces the gearbox with every new state: snapshots within a connection and the hydrating checkpoint of the next', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame1('welcome'), frame1('checkpoint'));
    const checkpoint = server1('checkpoint'), snapshot = server1('snapshot-counts-not-observed');
    if (checkpoint.kind !== 'checkpoint' || snapshot.kind !== 'snapshot') throw new Error('fixture');
    expect(state().observation?.state.gearbox).toEqual(checkpoint.data.state.gearbox);
    latest().feed(frame1('snapshot-counts-not-observed'));
    expect(state().observation?.state.gearbox).toEqual(snapshot.data.state.gearbox);
    expect(state().observation?.state.gearbox?.forwardGears).toEqual({available: false, reason: 'not-observed'});
    // The next connection's checkpoint, from an older plugin, hydrates a state without any gearbox.
    latest().emit('close'); await advance(250); connectLatest();
    latest().feed(frame1('welcome-minor-0'), frame1('checkpoint-minor-0'));
    expect(state().observation?.hydration).toBe(true);
    expect(Object.hasOwn(state().observation!.state, 'gearbox')).toBe(false);
  });
});

// ET-052 MB3, MB4, MB5: the service offers minor 2 and the connection keeps the one minor its welcome selected. The
// minor-2 fixtures carry the next mandatory break; the expected readings are written by hand from docs/protocol/v1.md.
describe('ET-052 protocol v1 minor 2', () => {
  it('offers minor 2 and writes every probe and ACK, and reads the clock reply, at the minor-2 welcome\'s minor', async () => {
    const sink = new Sink(); start({sink}); connectLatest();
    expect(latest().hello.maxMinor).toBe(2);
    latest().feed(frame2('welcome'), frame2('checkpoint'), frame2('event-job-configured'));
    await settle();
    expect(state().status).toBe('connected');
    expect(latest().sent.slice(1).map(m => [m.kind, m.version])).toEqual([['clock.probe', {major: 1, minor: 2}], ['ack', {major: 1, minor: 2}]]);
    expect([sink.commits, latest().acks]).toEqual([['event 1'], ['1']]);
    // The checkpoint hydrates the state with the break exactly as sent: 95 minutes.
    expect(state().observation).toMatchObject({kind: 'checkpoint', hydration: true});
    expect(state().observation!.state.nextMandatoryBreak).toEqual({available: true, value: 95, unit: 'min'});
    clock.ns = 2_000_000_500_000n; latest().feed(frame2('snapshot'), frame2('clock-reply'));
    expect(state().status).toBe('connected');
    expect(state().clockMapping).toEqual({sourceClockId: CAPTURE_CLOCK, clientClockId: ingestion!.clientClockId, offsetNs: '-999550450000', uncertaintyNs: '150000', measuredAtClientNs: '2000000500000'});
    await advance(1000);
    expect(latest().sent.at(-1)).toEqual({version: {major: 1, minor: 2}, kind: 'clock.probe', data: {probeId: '2'}});
  });

  it('replaces the break with every new state, zero and negative included, and unavailable readings keep their reason', () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame2('welcome'), frame2('checkpoint'));
    const breakOf = () => state().observation!.state.nextMandatoryBreak;
    for (const [name, expected] of [
      ['snapshot-break-zero', {available: true, value: 0, unit: 'min'}],
      ['snapshot-break-negative', {available: true, value: -30, unit: 'min'}],
      ['snapshot-break-int32-max', {available: true, value: 2147483647, unit: 'min'}],
      ['snapshot-break-int32-min', {available: true, value: -2147483648, unit: 'min'}],
      ['snapshot-break-not-observed', {available: false, reason: 'not-observed', unit: 'min'}],
      ['snapshot-break-not-supported', {available: false, reason: 'not-supported', unit: 'min'}],
      ['snapshot-break-invalid', {available: false, reason: 'invalid', unit: 'min'}]
    ] as const) {
      latest().feed(frame2(name));
      expect([name, breakOf()]).toEqual([name, expected]);
    }
    expect(state().status).toBe('connected');
  });

  it('accepts a welcome at minor 0 and at minor 1 from an older plugin, whose states carry no break', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame2('welcome-minor-1'), frame2('checkpoint-minor-1'), frame2('event-job-configured-minor-1'));
    await settle();
    expect([state().status, latest().sent.slice(1).map(m => m.version.minor)]).toEqual(['connected', [1, 1]]);
    expect(state().observation && Object.hasOwn(state().observation!.state, 'nextMandatoryBreak')).toBe(false);
    latest().emit('close'); await advance(250); connectLatest();
    latest().feed(frame2('welcome-minor-0'), frame2('checkpoint-minor-0'), frame2('event-job-configured-minor-0'));
    await settle();
    expect([state().status, latest().sent.slice(1).map(m => m.version.minor)]).toEqual(['connected', [0, 0]]);
    expect(Object.hasOwn(state().observation!.state, 'nextMandatoryBreak')).toBe(false);
  });

  it.each([
    ['a minor-1 frame after a minor-2 welcome', () => concat(frame2('welcome'), frame2('checkpoint-minor-1'))],
    ['a minor-2 frame after a minor-1 welcome', () => concat(frame2('welcome-minor-1'), frame2('checkpoint'))],
    ['a minor-2 frame after a minor-0 welcome', () => concat(frame2('welcome-minor-0'), frame2('checkpoint'))],
    ['a minor-2 state without the break', () => concat(frame2('welcome'), frame2('checkpoint-without-break'))],
    ['a minor-1 state with the break', () => concat(frame2('welcome-minor-1'), frame2('checkpoint-minor-1-with-break'))],
    ['a welcome above the offer', () => frame2('welcome-minor-3')]
  ])('closes the connection as incompatible on %s', (_name, bytes) => {
    start({sink: new Sink()}); connectLatest(); latest().feed(bytes());
    expect([state().status, state().fresh, state().observation]).toEqual(['incompatible', false, undefined]);
  });

  it.each([
    ['snapshot-break-above-int32'], ['snapshot-break-below-int32'], ['snapshot-break-fraction'], ['snapshot-break-string'], ['snapshot-break-unit-m'],
    ['snapshot-break-extra-key'], ['snapshot-without-break'], ['snapshot-minor-1']
  ])('closes a minor-2 connection as incompatible on the later state %s', name => {
    start({sink: new Sink()}); connectLatest(); latest().feed(frame2('welcome'), frame2('checkpoint'));
    expect(state().status).toBe('connected');
    latest().feed(frame2(name));
    expect(state().status).toBe('incompatible');
  });

  it('keeps the minor-1 readings of server2 fixtures decoding at the service\'s own maximum', () => {
    // The fixtures are the ones the contract tests read; a service pinned below minor 2 could not decode this welcome.
    expect(server2('welcome').version).toEqual({major: 1, minor: 2});
    expect(server2('welcome-minor-1').version).toEqual({major: 1, minor: 1});
  });
});
