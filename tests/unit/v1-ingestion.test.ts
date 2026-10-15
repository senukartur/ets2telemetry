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
import {V1Ingestion, type V1IngestionOptions, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
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
  write(bytes: Uint8Array) { this.sent.push(decodePayload(bytes.subarray(4), 'client') as ClientMessage); }
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
    expect(latest().sent).toEqual([{version: {major: 1, minor: 0}, kind: 'hello', data: {clientInstanceId: ingestion!.clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: false}}]);
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

  it('reconnects after 250, 500, 1000, 2000, 4000 and 4000 ms and resets after a hydrated checkpoint (E9)', async () => {
    start({sink: new Sink()});
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      latest().emit('close');
      const before = sockets.length; let waited = 0;
      while (sockets.length === before) { await advance(50); waited += 50; }
      delays.push(waited);
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 4000]);
    connectLatest(); latest().feed(frame('welcome'), frame('checkpoint'));
    latest().emit('end');
    expect(state().status).toBe('disconnected');
    const before = sockets.length; await advance(200); expect(sockets.length).toBe(before); await advance(50); expect(sockets.length).toBe(before + 1);
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
    await advance(1000); expect(latest().probes).toEqual(['1', '2']);
  });

  it('accepts a late clock reply without a mapping and probes again only after it arrived', async () => {
    start({sink: new Sink()}); connectLatest();
    latest().feed(frame('welcome'), frame('checkpoint'));
    await advance(3000); expect(latest().probes).toEqual(['1']);
    // t3 - t0 = 1,000,000,001 ns: later than the 1 s deadline, with a valid round trip.
    clock.ns = 2_001_000_000_001n; latest().feed(frame('clock-reply'));
    expect(state().clockMapping).toBeUndefined(); expect(state().status).not.toBe('incompatible');
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

  it('stop() waits for the owned source to complete', async () => {
    let complete!: () => void;
    start({connect: () => { const s = new FakeSocket(); s.completion = new Promise<void>(r => { complete = r; }); sockets.push(s); return s; }});
    const stopped = ingestion!.stop(); let done = false; void stopped.then(() => { done = true; });
    await settle(); expect([done, latest().destroyed]).toEqual([false, true]);
    complete(); await settle(); expect(done).toBe(true);
    ingestion = undefined;
  });
});
