// ET-019 PR-4 (REG-006, REG-011, REG-012): shutdown and close stalls are bounded and lose no committed work. Cases (a) and
// (b) drive the telemetry service's production recording wiring (apps/desktop/src/recording-runtime.ts) in process under
// the pinned Electron runtime with the real ShutdownSequence and its production timers, the real or the test-only fault
// storage worker and the reactive v1 simulator on actual Windows pipes; they record `synthetic:t` under a temporary
// LOCALAPPDATA. Case (c) terminates a recording child process (tests/storage/fixtures/trip-recorder-child.cjs) with
// TerminateProcess while its final appendSamples is held inside its transaction, then cold-starts a second process on
// the same database. Every expected value is written by hand from docs/telemetry-service-v1.md, docs/storage.md,
// docs/app-lifecycle.md (service shutdown), docs/trips.md and the scenario fixtures, never read back from the code under
// test. Waits count states, held commands, barrier lines and timer order; real-time values are named hang guards only.
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {decodePayload, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import type {StorageWorkerHandle} from '../../packages/storage/src/client';
import {createRecordingRuntime, type RecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import type {ShutdownTimers} from '../../apps/desktop/src/shutdown-sequence';
import {checkHistoryInvariants, formatViolations, type HistoryAck} from '../../scripts/ci/history-invariants.mjs';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {readHistoryRows} from './history-rows';
import {
  ClientSocket, guarded, RECORDING_FIXTURES, servedAcks, storageWorker, storedRows, storedSamples, terminateWorkers, tracedHandle, tracedShutdown, tripExpected, until
} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a state, a held command, a server run, a worker exit); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
/** Liveness bound for a child's stdout line; never a measured duration. */
const CHILD_LIVENESS_MS = 20_000;
/** A sample flush delay far beyond any run, so the only sample write is the final one at the stop (ET-015b H8, H11). */
const NO_FLUSH_TIMER_MS = 600_000;
/**
 * Cases (a) and (b): a pending sample row is queued for writing 1 ms after it appears, so it is written while the
 * connection is still open and the stop's `recording-flush` has nothing left to write (ET-015b H8, H11).
 */
const EARLY_FLUSH_MS = 1;
/** docs/telemetry-service-v1.md (E9): reconnection delays are 250, 500, 1000, 2000 and then 4000 ms. */
const LONGEST_BACKOFF_MS = 4_000;
/** docs/app-lifecycle.md, service shutdown: `SERVICE_STOP_BUDGET_MS`, the sum of the phase maxima 1000 + 500 + 1000. */
const STOP_BUDGET_MS = 2_500;


/**
 * The longest a lower bound on a timer's wall time can read short: Node starts a timer from the event loop's time cached
 * at the start of the current iteration, which a preempted service thread may have read earlier than the call. It only
 * widens the lower bound; it never bounds how long anything may take.
 */
const LOOP_CLOCK_SLACK_MS = 100;
const CHILD = path.resolve('tests/storage/fixtures/trip-recorder-child.cjs');

const scenario = (id: string) => readFixtureFile(scenarioPath(id)) as Json & {seed: string; steps: Json[]};
const sessionOf = (input: Json) => scenarioSource(replayV1(input).scenario).pluginSessionId;
const target = (name: string) => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', `${name}.sqlite`);
/** The synthetic target as the storage readers of recording-helpers.ts expect it. The database must be closed. */
const reader = (name: string) => ({database: target(name), open: () => ws.open({path: target(name), backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups')})});
/** The lines of `timeline` that are in `lines`, in timeline order. */
const ordered = (timeline: string[], lines: string[]) => timeline.filter(line => lines.includes(line));
/**
 * Game sources record no history (R3), and nothing created the history database under `localAppData`; each case calls it
 * before it starts and after everything ended.
 */
function expectNoGameHistory(localAppData: string) {
  expect(GAME_HISTORY_RECORDING).toBe(false);
  expect(existsSync(path.join(localAppData, 'ETS2Telemetry', 'data', 'telemetry.sqlite'))).toBe(false);
}
/** The invariants I1–I5 of scripts/ci/history-invariants.mjs over a closed database and every ACK written for `session`. */
function expectInvariants(file: string, session: string, acks: string[]) {
  const rows = readHistoryRows(file), written: HistoryAck[] = acks.map(through => ({pluginSessionId: session, throughEventSeq: through}));
  const violations = checkHistoryInvariants(rows, written);
  expect(violations, `${formatViolations(violations)}\nacks ${JSON.stringify(written)}\nrows ${JSON.stringify(rows)}`).toEqual([]);
  return rows;
}
/** `[job eventSeq, outcome, outcome eventSeq, close reason, recording completeness]` of every stored trip. */
async function tripTuples(open: () => ReturnType<typeof ws.open>) {
  const storage = await open();
  const trips = ok(storage.listTrips()).trips.map(t => [t.jobConfigurationEventSeq, t.outcome, t.outcomeEventSeq, t.closeReason, t.recordingCompleteness]);
  storage.close();
  return trips;
}

/** The fixture connect a runtime gets, and the number of connections it opened. */
interface FixtureConnect {connect: (endpoint: string) => ClientSocket; sockets: () => number}
/**
 * The fixture connect of cases (a) and (b): actual pipe sockets whose ACK frames are written to `timeline` as
 * `ack <throughEventSeq>`, as tracedConnect does. The first connection's stream is passed on through ClientSocket with
 * everything after the frame of eventSeq `afterEventSeq` (its end and close included) held until `release` resolves, so
 * the ingestion sees the end of the connection only after a storage state the case waits for.
 */
function gatedConnect(timeline: string[], afterEventSeq: string, release: () => Promise<unknown>, fail: (error: unknown) => void): FixtureConnect {
  let sockets = 0;
  const connect = (endpoint: string) => {
    const socket = new ClientSocket(net.connect(endpoint), sockets++ === 0 ? {afterEventSeq, until: release} : undefined, fail);
    const write = socket.write.bind(socket);
    socket.write = (bytes: Uint8Array, ...rest: unknown[]) => {
      const m = decodePayload(bytes.subarray(4), 'client', {maxMinor: 1}) as ClientMessage;
      if (m.kind === 'ack') timeline.push(`ack ${m.data.throughEventSeq}`);
      return write(bytes, ...rest);
    };
    return socket;
  };
  return {connect, sockets: () => sockets};
}
/**
 * normal-delivery has one sample row: its first reading, the checkpoint at 0 ms, is the plugin session's baseline, and the
 * frame at 100 ms is the first fresh running reading of source second 1000 (simulation started at 40 ms; the frame at
 * 200 ms is in the same second). Source clock 1,000,000,000,000 ns + 100 ms (docs/simulator-v1.md, trips.md H3, H4).
 */
const NORMAL_DELIVERY_SAMPLES = ['1000100000000'];

/**
 * One service's recording runtime for `synthetic:<name>` under the workspace as LOCALAPPDATA, built by the production
 * factory. Only the worker, the fixture connect and, where a case passes it, the close grace are supplied; without
 * `closeGraceMs` the database has the production grace.
 */
function serviceRuntime(name: string, worker: StorageWorkerHandle, socket: FixtureConnect, timeline: string[],
  options: {closeGraceMs?: number; sampleFlushMs?: number; onState?: (state: V1SourceState) => void} = {}) {
  const logs: [string, unknown][] = [];
  const runtime = createRecordingRuntime({env: {ETS2TELEMETRY_RECORDING: `synthetic:${name}`}, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory,
    log: (event, _detail, facts) => { logs.push([event, facts]); if (/^HISTORY_STORAGE_(OPENED|CLOSED)$/.test(event)) timeline.push(event); },
    createWorker: () => worker, connect: socket.connect, ingestionOverrides: {sampleFlushMs: options.sampleFlushMs ?? NO_FLUSH_TIMER_MS},
    historyOverrides: {appVersion: '0.1.0-test', ...(options.closeGraceMs === undefined ? {} : {closeGraceMs: options.closeGraceMs})},
    onV1State: state => options.onState?.(state)});
  return {runtime, logs};
}
/** Starts the runtime and selects the simulator once the database is open, so the first hello is durable (R10). */
async function startDurable(runtime: RecordingRuntime, endpoint: string) {
  runtime.start();
  await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(runtime.history.state).toBe('open');
  runtime.v1.select('synthetic', endpoint);
}
/**
 * Runs the shutdown sequence one macrotask after the first `disconnected` state, when the ingestion has armed its
 * reconnection timer (it arms it right after it reports the state). Resolves with the sequence result, its wall time,
 * the connections made and the state at the stop, and the time from the `history-storage` step's start to the end.
 */
function stopOnDisconnect(shutdown: ReturnType<typeof tracedShutdown>, socket: FixtureConnect, timeline: string[], current: () => V1SourceState) {
  let stopping: Promise<{clean: boolean; elapsedMs: number; atStop: {sockets: number; status: string}}> | undefined;
  const onState = (state: V1SourceState) => {
    if (stopping || state.status !== 'disconnected') return;
    stopping = new Promise(resolve => setImmediate(() => {
      const atStop = {sockets: socket.sockets(), status: current().status}, started = performance.now();
      timeline.push('stop');
      void shutdown.sequence.run().then(result => resolve({...result, elapsedMs: performance.now() - started, atStop}));
    }));
  };
  return {onState, stopped: async () => { await until(() => stopping !== undefined, 'the end of the connection', HANG_GUARD_MS); return guarded(stopping!, 'the stop', HANG_GUARD_MS); }};
}
/** normal-delivery: events 1–9 on one durable connection that commits and acknowledges each; the server closes it at 1,100 ms. */
const NORMAL_DELIVERY_ACKS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Only the sequence clock is controlled; pipes, SQLite transactions and history close remain real. */
function shutdownClock() {
  let now = 0, next = 0;
  const pending = new Map<number, {at: number; callback: () => void}>();
  const schedule = (callback: () => void, delay: number) => {const id = ++next; pending.set(id, {at: now + delay, callback}); return id;};
  const timers: ShutdownTimers = {now: () => now, setTimeout: schedule, clearTimeout: id => {pending.delete(id as number);},
    setImmediate: callback => schedule(callback, 1), clearImmediate: id => {pending.delete(id as number);}};
  const advance = async (target: number) => {
    for (;;) {
      const due = [...pending].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]); now = due[1].at; due[1].callback();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    now = target;
  };
  return {timers, advance, pending: () => pending.size};
}

describe('ET-019 shutdown and close stalls', () => {
  it.each(['released', 'stalled'] as const)('(d) a %s final sample transaction preserves bounded flush allocation and durable history (REG-006, REG-011, REG-012)', async mode => {
    expectNoGameHistory(ws.directory);
    const input = scenario('normal-delivery'), timeline: string[] = [], failures: unknown[] = [];
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker({samplesFault: {hold: true}}), traced = tracedHandle(worker.handle, timeline);
    const clock = shutdownClock(), shutdown = tracedShutdown(timeline, undefined, clock.timers);
    const socket = gatedConnect(timeline, '9', () => Promise.resolve(), error => failures.push(error));
    let runtime!: RecordingRuntime;
    const stop = stopOnDisconnect(shutdown, socket, timeline, () => runtime.v1.current);
    const s = serviceRuntime('t', traced.handle, socket, timeline, {onState: stop.onState}); runtime = s.runtime;
    runtime.register(shutdown.registrar);
    const held = guarded(once(worker.control!, 'message'), 'the final sample transaction', HANG_GUARD_MS);
    held.catch(() => undefined);
    try {
      await startDurable(runtime, server.endpoint);
      expect((await held)[0]).toEqual({type: 'held', command: 'appendSamples'});
      timeline.push('held final sample');
      // The final write is known to exist before advancing any budget. A released real transaction remains held
      // beyond the former 500 ms cap; the negative case expires its entire 1,500 ms effective allocation.
      await clock.advance(mode === 'released' ? 600 : 1501);
      if (mode === 'released') worker.control?.postMessage({type: 'release'});
      const {clean} = await stop.stopped();
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(mode === 'released' ? 0 : 1);
      expect(clean).toBe(mode === 'released');
      expect(shutdown.steps.find(step => step.name === 'recording-flush')?.outcome).toBe(mode === 'released' ? 'ok' : 'timeout');
      expect(shutdown.diagnostics.find(step => step.name === 'recording-flush')).toMatchObject({nominalBudgetMs: 500, effectiveBudgetMs: 1500});
      const close = shutdown.diagnostics.find(step => step.name === 'history-storage')!;
      expect(close.effectiveBudgetMs).toBe(mode === 'released' ? 1900 : 1000);
      expect(close.graceMs).toBe(mode === 'released' ? 1700 : 800);
      const acks = timeline.filter(line => line.startsWith('ack ')).map(line => line.slice(4));
      expect([acks, servedAcks(report, 0)]).toEqual([NORMAL_DELIVERY_ACKS, NORMAL_DELIVERY_ACKS]);
      expect(timeline.slice(timeline.indexOf('stop')).filter(line => line.startsWith('ack '))).toEqual([]);
      expect(failures).toEqual([]);
      if (mode === 'released') {
        expect(s.logs.filter(([event]) => event === 'V1_SAMPLES_EXIT')).toEqual([['V1_SAMPLES_EXIT', {rows: 1, losses: 0, code: 'WRITTEN'}]]);
        expect(timeline).toContain('HISTORY_STORAGE_CLOSED');
      } else {
        expect(timeline).not.toContain('HISTORY_STORAGE_CLOSED');
        expect(s.logs.filter(([event, facts]) => event === 'V1_SAMPLES_EXIT' && (facts as {code?: string})?.code === 'WRITTEN')).toEqual([]);
      }
      const rows = expectInvariants(target('t'), sessionOf(input), acks);
      expect(rows.integrity).toBe('ok');
      expect(rows.events.map(row => row.eventSeq)).toEqual(NORMAL_DELIVERY_ACKS);
      expect(rows.samples.map(row => row.monotonicNs)).toEqual(mode === 'released' ? NORMAL_DELIVERY_SAMPLES : []);
      expect(clock.pending()).toBe(0);
      expectNoGameHistory(ws.directory);
    } finally {worker.control?.close(); await server.stop();}
  }, 90_000);

  it('(a) a stop while a reconnection is armed makes no connection, not even after the longest backoff, writes no ACK after the stop and stays within 2,500 ms (REG-011)', async () => {
    const localAppData = ws.directory;
    expectNoGameHistory(localAppData);
    const input = scenario('normal-delivery'), timeline: string[] = [];
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker(), traced = tracedHandle(worker.handle, timeline), shutdown = tracedShutdown(timeline), failures: unknown[] = [];
    // The end of the connection reaches the ingestion only after the sample row was written (EARLY_FLUSH_MS), so the
    // stop's flush has nothing to wait for or write; the step's 500 ms budget then cannot be reached.
    const socket = gatedConnect(timeline, '9', () => until(() => timeline.includes('done appendSamples'), 'the early sample write', HANG_GUARD_MS), error => failures.push(error));
    let runtime!: RecordingRuntime;
    const stop = stopOnDisconnect(shutdown, socket, timeline, () => runtime.v1.current);
    // The close itself is not under test here: the suite's grace keeps a loaded host from turning it unclean.
    const s = serviceRuntime('t', traced.handle, socket, timeline, {closeGraceMs: TEST_CLOSE_GRACE_MS, sampleFlushMs: EARLY_FLUSH_MS, onState: stop.onState});
    runtime = s.runtime;
    s.runtime.register(shutdown.registrar);
    try {
      await startDurable(s.runtime, server.endpoint);
      const {elapsedMs, atStop} = await stop.stopped();
      // Timer order, not a duration: Node runs due timers in the order they expire. This one is armed after the stop
      // with a delay longer than any backoff step, so a reconnection timer armed before the stop would expire and run
      // first, and its connect (one microtask later) would precede this callback.
      await new Promise(resolve => setTimeout(resolve, LONGEST_BACKOFF_MS + 1));
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      await until(() => timeline.includes('HISTORY_STORAGE_CLOSED'), 'HISTORY_STORAGE_CLOSED', HANG_GUARD_MS);
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);

      // The stop came while the source was disconnected with its reconnection armed, and no connection followed it.
      expect(atStop).toEqual({sockets: 1, status: 'disconnected'});
      expect([socket.sockets(), report.connections.map(c => [c.durable, c.closedBy])]).toEqual([1, [[true, 'disconnect']]]);
      expect(shutdown.steps.slice(0, 2)).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok'}, {phase: 'flush', name: 'recording-flush', outcome: 'ok'}]);
      expect(shutdown.steps.slice(2).map(step => [step.phase, step.name])).toEqual([['storage', 'history-storage']]);
      expect(elapsedMs).toBeLessThanOrEqual(STOP_BUDGET_MS);
      // Every ACK was written before the stop, and the database closed in order after the flush.
      const acks = timeline.filter(line => line.startsWith('ack ')).map(line => line.slice(4));
      expect(acks).toEqual(NORMAL_DELIVERY_ACKS);
      expect(timeline.slice(timeline.indexOf('stop')).filter(line => line.startsWith('ack '))).toEqual([]);
      expect(servedAcks(report, 0)).toEqual(NORMAL_DELIVERY_ACKS);
      expect(ordered(timeline, ['stop', 'step intake v1-ingestion ok', 'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED']))
        .toEqual(['stop', 'step intake v1-ingestion ok', 'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED']);
      // The one sample row was written before the stop, so the flush wrote nothing (no V1_SAMPLES_EXIT, no second write).
      expect([failures, timeline.filter(line => line === 'done appendSamples').length, ordered(timeline, ['done appendSamples', 'stop'])]).toEqual([[], 1, ['done appendSamples', 'stop']]);
      expect(s.logs.filter(([event]) => event.startsWith('V1_SAMPLES_'))).toEqual([]);

      const storage = await reader('t').open(), session = sessionOf(input);
      expect(ok(storage.committedThrough(session))).toBe('9');
      storage.close();
      const expected = tripExpected('normal-delivery');
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(expectInvariants(target('t'), session, acks).samples.map(row => row.monotonicNs)).toEqual(NORMAL_DELIVERY_SAMPLES);
      expectNoGameHistory(localAppData);
    } finally { await server.stop(); }
  }, 90_000);

  // (b1) ET-038 (G18): a slow close held for 1,200 ms (past the old 800 ms grace) completes cleanly under adaptive
  // grace cascaded from prompt intake and flush phases (<50 ms); the stop exits 0 clean, records HISTORY_STORAGE_CLOSED,
  // stays within the 2,500 ms budget, and stores every committed event (REG-006, REG-011).
  it('(b1) ET-038: a slow close held for 1,200 ms (past the old 800 ms grace) completes cleanly under adaptive grace; the stop is clean and bounded, and every committed event survives (REG-006, REG-011)', async () => {
    const localAppData = ws.directory;
    expectNoGameHistory(localAppData);
    const input = scenario('normal-delivery'), timeline: string[] = [];
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker({closeHold: true}), traced = tracedHandle(worker.handle, timeline), failures: unknown[] = [];
    // Failure-only evidence: the grace also includes request/notice/release scheduling and actual worker close/exit.
    const diagnosticStart = performance.now(), stamps: {label: string; ms: number}[] = [];
    const stamp = (label: string) => { stamps.push({label, ms: performance.now() - diagnosticStart}); };
    let closeId: number | undefined, exitCode: number | undefined;
    let context: {budgetMs: number | null; graceMs: number | null} | undefined;
    let verdict: {clean: boolean; elapsedMs: number} | undefined;
    const handle: StorageWorkerHandle = {...traced.handle,
      postMessage: request => { if (request.command.name === 'close') { closeId = request.id; stamp('close-posted'); } traced.handle.postMessage(request); },
      onMessage: listener => traced.handle.onMessage(message => {
        if (closeId !== undefined && (message as {id?: unknown} | null)?.id === closeId) stamp('close-response');
        listener(message);
      }),
      terminate: () => { stamp('terminate-request'); return traced.handle.terminate(); }};
    void worker.exit.then(code => { exitCode = code; stamp('worker-exit'); }, () => stamp('worker-exit-error'));
    const socket = gatedConnect(timeline, '9', () => until(() => timeline.includes('done appendSamples'), 'the early sample write', HANG_GUARD_MS), error => failures.push(error));
    const held = guarded(once(worker.control!, 'message'), 'the held close', HANG_GUARD_MS).then(async ([message]) => {
      timeline.push('held close'); stamp('held-notice');
      await new Promise(resolve => setTimeout(resolve, 1200));
      stamp('release-posted');
      worker.control?.postMessage({type: 'release'});
      return message as unknown;
    });
    held.catch(() => undefined);
    const shutdown = tracedShutdown(timeline);
    let runtime!: RecordingRuntime;
    const stop = stopOnDisconnect(shutdown, socket, timeline, () => runtime.v1.current);
    const s = serviceRuntime('t', handle, socket, timeline, {sampleFlushMs: EARLY_FLUSH_MS, onState: stop.onState});
    runtime = s.runtime;
    s.runtime.register({register: (phase, step) => shutdown.registrar.register(phase, {...step, run: effective => {
      if (step.name === 'history-storage') { context = {budgetMs: effective?.budgetMs ?? null, graceMs: effective?.graceMs ?? null}; stamp('storage-start'); }
      return step.run(effective);
    }})});
    try {
      await startDurable(s.runtime, server.endpoint);
      const {clean, elapsedMs, atStop} = await stop.stopped();
      verdict = {clean, elapsedMs}; stamp('shutdown-result');

      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect(await held).toEqual({type: 'held', command: 'close'});
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);

      expect(atStop).toEqual({sockets: 1, status: 'disconnected'});
      expect(shutdown.steps).toEqual([
        {phase: 'intake', name: 'v1-ingestion', outcome: 'ok'},
        {phase: 'flush', name: 'recording-flush', outcome: 'ok'},
        {phase: 'storage', name: 'history-storage', outcome: 'ok'}
      ]);
      expect(clean).toBe(true);
      expect([failures, timeline.filter(line => line === 'done appendSamples').length, ordered(timeline, ['done appendSamples', 'stop'])]).toEqual([[], 1, ['done appendSamples', 'stop']]);
      expect(s.logs.filter(([event]) => event.startsWith('V1_SAMPLES_'))).toEqual([]);
      expect(ordered(timeline, ['start history-storage', 'held close', 'done close', 'HISTORY_STORAGE_CLOSED', 'step storage history-storage ok']))
        .toEqual(['start history-storage', 'held close', 'done close', 'HISTORY_STORAGE_CLOSED', 'step storage history-storage ok']);
      expect(elapsedMs).toBeLessThanOrEqual(STOP_BUDGET_MS);
      expect(s.logs.filter(([event]) => event === 'HISTORY_STORAGE_CLOSED')).toHaveLength(1);
      await until(() => s.runtime.history.state === 'closed', 'the closed history state', HANG_GUARD_MS);
      const acks = timeline.filter(line => line.startsWith('ack ')).map(line => line.slice(4));
      expect([acks, servedAcks(report, 0), socket.sockets()]).toEqual([NORMAL_DELIVERY_ACKS, NORMAL_DELIVERY_ACKS, 1]);

      const storage = await reader('t').open(), session = sessionOf(input);
      expect(ok(storage.committedThrough(session))).toBe('9');
      storage.close();
      const expected = tripExpected('normal-delivery');
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(expectInvariants(target('t'), session, acks).samples.map(row => row.monotonicNs)).toEqual(NORMAL_DELIVERY_SAMPLES);
      expectNoGameHistory(localAppData);
    } catch (error) {
      console.error('ET038_SLOW_CLOSE_DIAGNOSTIC', JSON.stringify({context, verdict, exitCode, stamps: stamps.slice(-16), steps: shutdown.steps,
        timeline: timeline.slice(-80), logs: s.logs.slice(-32)}));
      throw error;
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  // (b2) G18. docs/storage.md: a close held forever is terminated after the adaptive grace (~2,250 ms when earlier phases
  // take <50 ms, with a 200 ms reserve before the effective budget). The step ends unclean, failed or timeout,
  // the service reports {type: 'stopped', clean: false} and exits 1, the stop stays within the 2,500 ms budget,
  // and every committed event survives in the WAL (REG-006, REG-011).
  it('(b2) G18: a close that would stall forever is terminated after the adaptive grace and before the stop budget; the stop is unclean and bounded, and every committed event survives (REG-006, REG-011)', async () => {
    const localAppData = ws.directory;
    expectNoGameHistory(localAppData);
    const input = scenario('normal-delivery'), timeline: string[] = [];
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    // The fault worker holds the close before its host receives it and is never released: the close would stall forever.
    const worker = storageWorker({closeHold: true}), traced = tracedHandle(worker.handle, timeline), failures: unknown[] = [];
    // As in (a): the sample row is written before the end of the connection, so the flush has nothing slow to do.
    const socket = gatedConnect(timeline, '9', () => until(() => timeline.includes('done appendSamples'), 'the early sample write', HANG_GUARD_MS), error => failures.push(error));
    const held = guarded(once(worker.control!, 'message'), 'the held close', HANG_GUARD_MS).then(([message]) => { timeline.push('held close'); return message as unknown; });
    // Awaited only after the stop; if the case fails earlier, its hang guard must not reject unobserved.
    held.catch(() => undefined);
    let storageStarted = 0, terminatedAfterMs: number | undefined;
    const shutdown = tracedShutdown(timeline, name => { if (name === 'history-storage') storageStarted = performance.now(); });
    // A test-side wrapper of the worker handle (no worker change) that marks the first termination request.
    const handle: StorageWorkerHandle = {...traced.handle, terminate: () => {
      if (terminatedAfterMs === undefined) { terminatedAfterMs = performance.now() - storageStarted; timeline.push('terminate'); }
      return traced.handle.terminate();
    }};
    let runtime!: RecordingRuntime;
    const stop = stopOnDisconnect(shutdown, socket, timeline, () => runtime.v1.current);
    // No close grace is passed: the database has the production grace.
    const s = serviceRuntime('t', handle, socket, timeline, {sampleFlushMs: EARLY_FLUSH_MS, onState: stop.onState});
    runtime = s.runtime;
    s.runtime.register(shutdown.registrar);
    try {
      await startDurable(s.runtime, server.endpoint);
      const {clean, elapsedMs, atStop} = await stop.stopped();

      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect(await held).toEqual({type: 'held', command: 'close'});
      // Terminated before its host received the close: worker_threads reports exit code 1.
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(1);

      expect(atStop).toEqual({sockets: 1, status: 'disconnected'});
      expect(shutdown.steps.slice(0, 2)).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok'}, {phase: 'flush', name: 'recording-flush', outcome: 'ok'}]);
      const verdict = shutdown.steps.slice(2);
      expect(verdict.map(step => [step.phase, step.name])).toEqual([['storage', 'history-storage']]);
      expect(['failed', 'timeout']).toContain(verdict[0].outcome);
      expect(clean).toBe(false);
      // The one sample row was written before the stop, so the flush wrote nothing (no V1_SAMPLES_EXIT, no second write).
      expect([failures, timeline.filter(line => line === 'done appendSamples').length, ordered(timeline, ['done appendSamples', 'stop'])]).toEqual([[], 1, ['done appendSamples', 'stop']]);
      expect(s.logs.filter(([event]) => event.startsWith('V1_SAMPLES_'))).toEqual([]);
      // The close was held, the termination started after the adaptive grace and before the step's verdict: the order of the
      // timeline, not a duration, bounds it by the budget.
      const step = `step storage history-storage ${verdict[0].outcome}`;
      expect(ordered(timeline, ['start history-storage', 'held close', 'terminate', step])).toEqual(['start history-storage', 'held close', 'terminate', step]);
      // Adaptive grace gives ~2,250 ms (well beyond the baseline 800 ms grace), bounded by the stop budget.
      expect(terminatedAfterMs).toBeGreaterThanOrEqual(2000);
      expect(terminatedAfterMs).toBeLessThanOrEqual(STOP_BUDGET_MS);
      // The whole stop stayed inside its budget although the close never ended.
      expect(elapsedMs).toBeLessThanOrEqual(STOP_BUDGET_MS + LOOP_CLOCK_SLACK_MS);
      // No orderly-close row, and the database is closed for the service lifetime.
      expect(s.logs.filter(([event]) => event === 'HISTORY_STORAGE_CLOSED')).toEqual([]);
      await until(() => s.runtime.history.state === 'closed', 'the closed history state', HANG_GUARD_MS);
      const acks = timeline.filter(line => line.startsWith('ack ')).map(line => line.slice(4));
      expect([acks, servedAcks(report, 0), socket.sockets()]).toEqual([NORMAL_DELIVERY_ACKS, NORMAL_DELIVERY_ACKS, 1]);

      // docs/storage.md: every commit the stalled close had reported is durable in the WAL; the next open has all of it.
      const storage = await reader('t').open(), session = sessionOf(input);
      expect(ok(storage.committedThrough(session))).toBe('9');
      storage.close();
      const expected = tripExpected('normal-delivery');
      expect(await storedRows(reader('t'), input.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(expectInvariants(target('t'), session, acks).samples.map(row => row.monotonicNs)).toEqual(NORMAL_DELIVERY_SAMPLES);
      expectNoGameHistory(localAppData);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);
  // (c) one-second-samples (tests/fixtures/recording/one-second-samples.json): connection 1 from 0 to 13,000 ms commits and
  // acknowledges events 1–6, connection 2 from 15,500 to 17,500 ms carries the delivery (7) and the clear (8). The first
  // process never flushes on its timer, so at its stop after connection 1 the final appendSamples carries every pending
  // row: seconds 1000–1005 and 1009–1012, ten rows (the hand-written expectation's authoredFrom). The fault worker holds
  // that batch inside its transaction and the process is terminated there. None of the ten rows may be stored
  // (docs/telemetry-service-v1.md: a killed process loses its pending rows; the batch is one transaction). The second
  // process cold-starts on the same file; its connection-2 checkpoint is its baseline, and its stop stores 1016 and 1017.
  it('(c) a process killed inside its final appendSamples transaction stores none of that batch; the next open recovers without a lost, duplicate or over-acknowledged row (REG-006, REG-012)', async () => {
    const localAppData = path.join(ws.directory, 'localappdata');
    expectNoGameHistory(localAppData);
    const input = JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string};
    const session = sessionOf(input);
    const expected = (JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.rows.expected.json'), 'utf8')) as {samples: {monotonicNs: string}[]}).samples;
    const second = (row: {monotonicNs: string}) => String(BigInt(row.monotonicNs) / 1_000_000_000n);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true}), children: Child[] = [];
    let between: {through: string; events: string[]; samples: number; integrity: string} | undefined;
    try {
      const one = child(server.endpoint, localAppData, {mode: 'fault-worker', barrier: null, maxConnections: 1, stopAfterDisconnect: true, sampleFlushMs: NO_FLUSH_TIMER_MS}, 'first');
      children.push(one);
      await one.until(line => line === 'barrier samples');
      await one.terminate();
      // The next open: the production storage core on the file the killed process left.
      const storage = await ws.open();
      between = {through: ok(storage.committedThrough(session)), events: ok(storage.listEvents(session)).map(event => event.eventSeq),
        samples: ok(storage.listSamples({pluginSessionId: session})).length, integrity: ''};
      storage.close();
      between.integrity = readOnly(ws.database, db => db.pragma('integrity_check', {simple: true}) as string);
      const two = child(server.endpoint, localAppData, {barrier: null, stopAfterDisconnect: true}, 'second');
      children.push(two);
      await two.until(line => line === 'stopped');
      await two.terminate();
      await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);

      // The kill landed inside the final write of the stop: after the disconnection, one batch of all ten pending rows.
      expect(one.lines.filter(line => line === 'disconnected' || line === 'stopping' || line.startsWith('appendSamples ') || line.startsWith('barrier ')))
        .toEqual(['disconnected', 'stopping', 'appendSamples 10', 'barrier samples']);
      expect([one.acks(), two.acks()]).toEqual([['1', '2', '3', '4', '5', '6'], ['7', '8']]);
      for (const recorder of [one, two]) expectAcksAfterCommits(recorder);
    } finally {
      await Promise.all(children.map(c => c.terminate().catch(() => undefined)));
      await server.stop();
    }
    // The next open found connection 1's commits and none of the held batch's rows.
    expect(between).toEqual({through: '6', events: ['1', '2', '3', '4', '5', '6'], samples: 0, integrity: 'ok'});

    // Final: events 1–8 once, no gap, coverage 8; the job configured at load (eventSeq 3, T12) and resumed after the
    // cold start (consumer-restart) is closed by the delivery (7) as partial; the samples are exactly the second
    // process's 1016 and 1017, so no second of the killed batch was stored, fabricated or written twice.
    const rows = expectInvariants(ws.database, session, [...children[0].acks(), ...children[1].acks()]);
    expect(rows.integrity).toBe('ok');
    expect(rows.sessions.map(row => row.committedThroughEventSeq)).toEqual(['8']);
    expect([rows.events.map(event => event.eventSeq), rows.gaps]).toEqual([['1', '2', '3', '4', '5', '6', '7', '8'], []]);
    expect(await tripTuples(() => ws.open())).toEqual([['3', 'delivered', '7', 'outcome', 'partial']]);
    expect(await storedSamples(ws, input.seed, session)).toEqual(expected.filter(row => ['1016', '1017'].includes(second(row))));
    expectNoGameHistory(localAppData);
  }, 60_000);
});

/** A child's config: tests/storage/fixtures/trip-recorder-child.cjs. */
interface ChildConfig {barrier: null; mode?: 'worker' | 'fault-worker'; maxConnections?: number; sampleFlushMs?: number; stopAfterDisconnect?: boolean}
/** One recording process. `until` resolves at the first stdout line that matches; stderr must stay empty. */
function child(endpoint: string, localAppData: string, config: ChildConfig, name: string) {
  const file = path.join(ws.directory, `${name}.json`);
  writeFileSync(file, JSON.stringify({endpoint, mode: 'worker', ...config, open: {path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}}));
  const spawned = spawn(process.execPath, [CHILD, file], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: localAppData}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  // 'close' follows the exit and the end of both pipes, so every line written before the kill has been read.
  const closed = once(spawned, 'close');
  const lines: string[] = [], waiters: {match: (line: string) => boolean; resolve: () => void}[] = [];
  let stdout = '', stderr = '';
  spawned.stderr.on('data', chunk => { stderr += String(chunk); });
  spawned.stdout.on('data', chunk => {
    stdout += String(chunk);
    const parts = stdout.split('\n'); stdout = parts.pop() ?? '';
    for (const line of parts.map(p => p.trim())) {
      lines.push(line);
      for (const w of waiters.splice(0)) if (w.match(line)) w.resolve(); else waiters.push(w);
    }
  });
  const until = (match: (line: string) => boolean) => lines.some(match) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: expected line not reached; stdout ${JSON.stringify(lines)}; stderr ${JSON.stringify(stderr)}`)), CHILD_LIVENESS_MS);
    waiters.push({match, resolve: () => { clearTimeout(timer); resolve(); }});
  });
  // TerminateProcess on Windows: no exit handlers, no SQLite close, no checkpoint.
  let terminated = false;
  const terminate = async () => { if (!terminated) { terminated = true; spawned.kill(); } await closed; expect(stderr).toBe(''); };
  return {lines, until, terminate, acks: () => lines.filter(l => l.startsWith('ack ')).map(l => l.slice(4))};
}
type Child = ReturnType<typeof child>;
/** Every ACK line of a process follows a commit line of the same process whose coverage covers it (REG-005, REG-006). */
function expectAcksAfterCommits(recorder: Child) {
  let coverage = 0n;
  for (const line of recorder.lines) {
    if (line.startsWith('committed ')) { const through = BigInt(line.split(' ')[2]); if (through > coverage) coverage = through; }
    if (line.startsWith('ack ')) expect(BigInt(line.slice(4)), `${line} after coverage ${coverage}`).toBeLessThanOrEqual(coverage);
  }
}
