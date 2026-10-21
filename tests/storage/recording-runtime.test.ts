// ET-015c PR-1 (G13, G14, G20): the telemetry service's recording runtime (apps/desktop/src/recording-runtime.ts), the
// production wiring of the recording plan, HistoryStorage, TripRecorderSink and V1Ingestion, driven in process under the
// pinned Electron runtime with the real or the fault storage worker, the real ShutdownSequence (production timers except the explicit controlled-shutdown-clock regression)
// and the reactive v1 simulator on actual Windows pipes. Every case records `synthetic:<name>` under a temporary
// LOCALAPPDATA and must never create its history database. Waits count held requests, commits and ACKs; real-time bounds
// are named hang guards only. Expected values are written by hand from R10, R14, H11 and the simulator scenarios.
import {existsSync, readFileSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {StorageWorkerHandle} from '../../packages/storage/src/client';
import {createRecordingRuntime, type RecordingIngestionOverrides, type RecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {ShutdownSequence, type ShutdownTimers, SERVICE_STOP_BUDGET_MS} from '../../apps/desktop/src/shutdown-sequence';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {
  guarded, RECORDING_FIXTURES, recordingExpected, replayOf, servedAcks, storageWorker, storedGaps, storedRows, storedSamples, terminateWorkers, tracedConnect,
  tracedHandle, tracedShutdown, until, withTransport
} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a held request, a server run, a log line); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
/** A flush delay far beyond any run, so the only sample write is the one at the stop (ET-015b H8, H11). */
const NO_FLUSH_TIMER_MS = 600_000;
const connect = (atMs: number, client: Json = {durable: true}) => ({atMs, action: 'connect', client});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
const scenario = (id: string) => readFixtureFile(scenarioPath(id)) as Json & {seed: string; steps: Json[]};
/** ET-015b's sample scenario (not in the simulator manifest). */
const samplesScenario = () => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string};
const sessionOf = (input: Json) => scenarioSource(replayOf(input).scenario).pluginSessionId;
const target = (name: string) => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', `${name}.sqlite`);
const historyFile = () => path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
/** The synthetic target as the storage readers of recording-helpers.ts expect it. The database must be closed. */
const reader = (name: string) => ({database: target(name), open: () => ws.open({path: target(name), backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups')})});
/** The lines of `timeline` that are in `lines`, in timeline order. */
const ordered = (timeline: string[], lines: string[]) => timeline.filter(line => lines.includes(line));

/** Codes the runtime logs that a case orders against its other observations. */
const TIMELINE_CODES = /^(HISTORY_STORAGE_OPENED|HISTORY_STORAGE_CLOSED|V1_DURABLE_RESTORE_LOSS)$/;
/**
 * One service's recording runtime for `synthetic:<name>` under the workspace as LOCALAPPDATA, built by the production
 * factory. Only the worker, the fixture connect, the test close grace and ingestion test knobs are supplied.
 */
function serviceRuntime(name: string, worker: StorageWorkerHandle, socket: ReturnType<typeof tracedConnect>, timeline: string[],
  options: {onState?: (state: V1SourceState) => void; ingestionOverrides?: RecordingIngestionOverrides} = {}) {
  const logs: [string, unknown][] = [], states: V1SourceState[] = [];
  const runtime = createRecordingRuntime({env: {ETS2TELEMETRY_RECORDING: `synthetic:${name}`}, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory,
    log: (event, _detail, facts) => { logs.push([event, facts]); if (TIMELINE_CODES.test(event)) timeline.push(event); },
    createWorker: () => worker, connect: socket.connect, ingestionOverrides: options.ingestionOverrides,
    historyOverrides: {appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS},
    onV1State: state => { states.push(state); options.onState?.(state); }});
  return {runtime, logs, states};
}
/** Starts the runtime and selects the simulator once the database is open, so the first hello is durable (R10). */
async function startDurable(runtime: RecordingRuntime, endpoint: string) {
  runtime.start();
  await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(runtime.history.state).toBe('open');
  runtime.v1.select('synthetic', endpoint);
}
const durableLogs = (logs: [string, unknown][]) => logs.filter(([event]) => /^V1_(DURABLE|SAMPLES)_/.test(event));

/** Only the shutdown policy clock is controlled: pipe, ingestion, SQLite worker and close use their real event loops. */
function shutdownClock() {
  let now = 0;
  type Timer = {at: number; callback: () => void};
  const pending = new Set<Timer>();
  const schedule = (callback: () => void, ms: number) => {const timer = {at: now + ms, callback}; pending.add(timer); return timer;};
  const clear = (handle: unknown) => {pending.delete(handle as Timer);};
  const timers: ShutdownTimers = {now: () => now, setTimeout: schedule, clearTimeout: clear,
    setImmediate: callback => schedule(callback, 0), clearImmediate: clear};
  return {timers, advanceTo(value: number) {
    now = value;
    for (;;) {const due = [...pending].find(timer => timer.at <= now); if (!due) break; pending.delete(due); due.callback();}
  }};
}

describe('ET-015c recording runtime with the real storage worker and the real shutdown sequence', () => {
  it('persists the held final sample after 829 ms of controlled shutdown time without an ACK after stop', async () => {
    const base = samplesScenario();
    // The first five authored steps end at the 100 ms running frame, yielding exactly source second 1000.
    const input = {...base, steps: (base.steps as Json[]).slice(0, 5), transport: [connect(0, {durable: true, commit: 'each', ack: 'each'}), disconnect(10_000)]};
    const timeline: string[] = [], worker = storageWorker(), traced = tracedHandle(worker.handle, timeline, 'appendSamples'), socket = tracedConnect(timeline);
    const server = await serveV1Reactive(input, {scale: 1, awaitScriptedAcks: true});
    const clock = shutdownClock(), steps: {name: string; outcome: string; ms: unknown}[] = [];
    const sequence = new ShutdownSequence((_event, _detail, facts) => {
      if (!facts) return; steps.push({name: String(facts.name), outcome: String(facts.outcome), ms: facts.ms});
      timeline.push(`step ${facts.phase} ${facts.name} ${facts.outcome}`);
    }, clock.timers);
    const s = serviceRuntime('held-final-sample', traced.handle, socket, timeline, {ingestionOverrides: {sampleFlushMs: NO_FLUSH_TIMER_MS}});
    s.runtime.register({register: (phase, step) => sequence.register(phase, {...step, run: context => {timeline.push(`start ${step.name}`); return step.run(context);}})});
    let stopping: Promise<{clean: boolean}> | undefined;
    try {
      await startDurable(s.runtime, server.endpoint);
      await until(() => s.states.some(state => state.observation?.kind === 'snapshot' && state.observation.state.simulation === 'running'), 'the authored running frame', HANG_GUARD_MS);
      expect(timeline).not.toContain('held appendSamples'); timeline.push('stop'); stopping = sequence.run();
      await guarded(traced.held, 'the final appendSamples barrier', HANG_GUARD_MS);
      clock.advanceTo(829); await Promise.resolve(); await Promise.resolve();
      expect(steps.find(step => step.name === 'recording-flush')).toBeUndefined();
      expect(timeline).not.toContain('start history-storage'); traced.release();
      expect(await guarded(stopping, 'the recording stop', HANG_GUARD_MS)).toEqual({clean: true});
      expect(await guarded(worker.exit, 'the real storage worker exit', HANG_GUARD_MS)).toBe(0);
      await server.stop(); const report = await server.done;
      expect(steps).toEqual([{name: 'v1-ingestion', outcome: 'ok', ms: 0}, {name: 'recording-flush', outcome: 'ok', ms: 829},
        {name: 'history-storage', outcome: 'ok', ms: 0}]);
      expect(ordered(timeline, ['stop', 'start recording-flush', 'held appendSamples', 'release', 'done appendSamples',
        'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED'])).toEqual(['stop', 'start recording-flush',
        'held appendSamples', 'release', 'done appendSamples', 'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED']);
      expect(timeline.slice(timeline.indexOf('stop')).filter(line => line.startsWith('ack '))).toEqual([]);
      expect(servedAcks(report, 0)).toEqual(['1', '2', '3', '4']);
      expect(report.connections.map(connection => [connection.durable, connection.closedBy])).toEqual([[true, 'client']]);
      // Independently authored source-frame row: no later frame or source second is admitted.
      expect(await storedSamples(reader('held-final-sample'), base.seed, sessionOf(input))).toEqual([{
        monotonicNs: '1000100000000', utcMs: 1800000000100, trip: 'trip@3', sourceClockId: 'capture-clock',
        gameTime: {minutes: {available: true, value: 600}, clockId: 'game-clock-0'}, speed: {available: true, value: 25.5},
        fuel: {available: true, value: 400.5}, averageConsumption: {available: true, value: 37.5}, estimatedRange: {available: true, value: 1000500},
        engineRpm: {available: true, value: 1250.5}, gear: {available: true, value: 5}, odometer: {available: true, value: 1000500},
        position: {available: true, value: {x: -31234.5, y: 42.25, z: 18800.75}}
      }]);
      expect(readOnly(target('held-final-sample'), db => ({integrity: db.pragma('integrity_check', {simple: true}), foreignKeys: db.pragma('foreign_key_check')})))
        .toEqual({integrity: 'ok', foreignKeys: []});
      expect(existsSync(historyFile())).toBe(false);
    } finally {traced.release(); if (stopping) await guarded(stopping, 'stop cleanup', HANG_GUARD_MS); await server.stop();}
  }, 90_000);

  it('(a) recording-flush waits for the commit in flight, no ACK follows the source stop, and the database closes after the flush (REG-011, REG-012)', async () => {
    // normal-delivery with one durable client that commits and acknowledges each item: the fault worker holds the commit
    // of simulation.started (eventSeq 4) inside its transaction, after 1-3 were committed and acknowledged. The server
    // writes nothing more until it sees the ACK of 4 or the client leaves.
    const input = scenario('normal-delivery'), timeline: string[] = [];
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const worker = storageWorker({hold: {eventSeq: '4'}}), traced = tracedHandle(worker.handle, timeline), socket = tracedConnect(timeline);
    const held = once(worker.control!, 'message');
    // The hold is released after the intake phase logged and the flush step started, one macrotask later, so a flush
    // step that did not wait would already have ended.
    const shutdown = tracedShutdown(timeline, name => {
      if (name === 'recording-flush') setImmediate(() => { timeline.push('release'); worker.control!.postMessage({type: 'release'}); });
    });
    const s = serviceRuntime('t', traced.handle, socket, timeline);
    s.runtime.register(shutdown.registrar);
    try {
      await startDurable(s.runtime, server.endpoint);
      expect((await guarded(held, 'the held commit of eventSeq 4', HANG_GUARD_MS))[0]).toEqual({type: 'held', eventSeq: '4'});
      timeline.push('stop');
      await shutdown.sequence.run();
      // The close may outlast its step's 1,000 ms budget on a loaded host; its log line is what this case orders.
      await until(() => timeline.includes('HISTORY_STORAGE_CLOSED'), 'HISTORY_STORAGE_CLOSED', HANG_GUARD_MS);
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);

      expect(shutdown.steps.slice(0, 2)).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok'}, {phase: 'flush', name: 'recording-flush', outcome: 'ok'}]);
      expect(shutdown.steps.slice(2).map(step => [step.phase, step.name])).toEqual([['storage', 'history-storage']]);
      // R14 in order: the source stops, the flush step starts while 4 is held, the commit completes only after the
      // release, the flush step ends after it, and the database closes after the flush.
      expect(ordered(timeline, ['ack 1', 'ack 2', 'ack 3', 'stop', 'step intake v1-ingestion ok', 'start recording-flush', 'release', 'done commitEvent 4',
        'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED'])).toEqual(['ack 1', 'ack 2', 'ack 3', 'stop', 'step intake v1-ingestion ok',
        'start recording-flush', 'release', 'done commitEvent 4', 'step flush recording-flush ok', 'start history-storage', 'HISTORY_STORAGE_CLOSED']);
      // No ACK after the stop: neither written by the ingestion nor received by the simulator.
      expect(timeline.slice(timeline.indexOf('stop')).filter(line => line.startsWith('ack '))).toEqual([]);
      expect(servedAcks(report, 0)).toEqual(['1', '2', '3']);
      expect(report.connections.map(c => [c.durable, c.closedBy])).toEqual([[true, 'client']]);
      expect(socket.sockets()).toBe(1);
      expect(durableLogs(s.logs)).toEqual([]);
      // The held commit was stored; the producer will redeliver 4, which storage then reports as a duplicate.
      const storage = await reader('t').open(), session = sessionOf(input);
      expect([ok(storage.committedThrough(session)), ok(storage.listEvents(session)).map(event => event.eventSeq)]).toEqual(['4', ['1', '2', '3', '4']]);
      storage.close();
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(b) R10: a live-only connection made while the database opens reconnects durable once it opens; its events arrive as one committed noDurableConsumer gap (REG-003)', async () => {
    // live-only.json's source steps: simulation.started (1) and a cleared job (2) while only a live-only client is
    // connected. Frames every 100 ms to 10,000 ms keep the server, paced in real time while a client is connected, at
    // most one frame behind the client's own close. The scripted disconnect at 10,050 ms is a hang guard of the
    // upgrade: a client that never closes the live-only connection is disconnected by the server, which the
    // `closedBy: client` check below rejects.
    const base = scenario('live-only');
    const input = {...base, id: 'r10-upgrade', purpose: 'ET-015c G14: a live-only connection while storage opens, then the durable reconnection R10 makes.',
      steps: [...base.steps, ...Array.from({length: 98}, (_, i) => ({atMs: 300 + 100 * i, action: 'frame'}))],
      transport: [connect(0, {durable: false}), disconnect(10_050), connect(10_100), disconnect(10_200)]};
    const expected = recordingExpected('r10-upgrade') as ReturnType<typeof recordingExpected> & {gaps: unknown[]};
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 1, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker(), traced = tracedHandle(worker.handle, timeline, 'open'), socket = tracedConnect(timeline);
    // The open is released once the live-only connection saw both events counted as noDurableConsumer loss.
    const s = serviceRuntime('t', traced.handle, socket, timeline, {onState: state => {
      if (state.observation?.status.eventLoss.noDurableConsumer === '2' && !timeline.includes('release')) traced.release();
    }});
    const shutdown = tracedShutdown(timeline);
    s.runtime.register(shutdown.registrar);
    try {
      s.runtime.start();
      await guarded(traced.held, 'the held open', HANG_GUARD_MS);
      expect(s.runtime.history.state).toBe('opening');
      s.runtime.v1.select('synthetic', server.endpoint);
      const report = await guarded(server.done, 'the reactive server run', 60_000);
      await shutdown.sequence.run();
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);

      // The first hello was live-only and its connection was closed by the client, not by the scripted disconnect; the
      // second, durable connection acknowledged the committed gap.
      expect(report.connections.map(c => [c.durable, c.closedBy])).toEqual([[false, 'client'], [true, 'disconnect']]);
      expect([servedAcks(report, 0), servedAcks(report, 1)]).toEqual([[], ['2']]);
      expect(ordered(timeline, ['held open', 'release', 'done open', 'HISTORY_STORAGE_OPENED', 'ack 2'])).toEqual(['held open', 'release', 'done open', 'HISTORY_STORAGE_OPENED', 'ack 2']);
      // Before the open finished the connection reported no durable delivery; the open closed it for the durable reconnection.
      const upgrade = s.states.findIndex(state => state.reason === 'Durable delivery available; reconnecting durable');
      expect(upgrade).toBeGreaterThan(0);
      expect(s.states.slice(0, upgrade).map(state => state.durable.state).filter(state => state !== 'off')).toEqual([]);
      expect(s.states.at(-1)?.durable).toEqual({state: 'active'});
      expect(durableLogs(s.logs)).toEqual([]);

      const storage = await reader('t').open();
      expect(ok(storage.committedThrough(sessionOf(input)))).toBe(expected.coverage.committedThroughEventSeq);
      storage.close();
      expect(await storedRows(reader('t'), base.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
      expect(storedGaps(target('t'))).toEqual(expected.gaps);
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);

  it('(c) a stop during a retryable backoff ends the source, reports the pending samples with their storage code and stays within 2,500 ms', async () => {
    // one-second-samples with a single durable connection; the commit of simulation.paused (eventSeq 5, 5,900 ms) and
    // every sample write fail with SQLITE_FULL inside their transactions (DISK_FULL, retryable), as on a full volume.
    // Rows of seconds 1000-1005 were sampled before 5 and are pending; the stop comes while the reconnection waits for
    // its first 250 ms backoff step.
    const input = withTransport(samplesScenario(), 'one-second-samples-disk-full-stop', [connect(0), disconnect(13_000)]);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    const timeline: string[] = [], worker = storageWorker({fault: {eventSeq: '5', code: 'SQLITE_FULL', times: 1_000}, samplesFault: {code: 'SQLITE_FULL', times: 1_000}});
    const socket = tracedConnect(timeline), shutdown = tracedShutdown(timeline);
    let stopping: Promise<{elapsedMs: number; atStop: {sockets: number; state: V1SourceState}}> | undefined;
    const s = serviceRuntime('t', worker.handle, socket, timeline, {ingestionOverrides: {sampleFlushMs: NO_FLUSH_TIMER_MS}, onState: state => {
      if (stopping || state.status !== 'disconnected' || state.reason !== 'Durable commit not completed (DISK_FULL); retrying') return;
      // One macrotask later the retry timer is armed; the stop then lands inside the backoff.
      stopping = new Promise(resolve => setImmediate(() => {
        const atStop = {sockets: socket.sockets(), state: s.runtime.v1.current}, started = performance.now();
        timeline.push('stop');
        void shutdown.sequence.run().then(() => resolve({elapsedMs: performance.now() - started, atStop}));
      }));
    }});
    s.runtime.register(shutdown.registrar);
    try {
      await startDurable(s.runtime, server.endpoint);
      await until(() => stopping !== undefined, 'the retryable commit failure', HANG_GUARD_MS);
      const {elapsedMs, atStop} = await guarded(stopping!, 'the stop', HANG_GUARD_MS);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);
      expect(await guarded(worker.exit, 'the storage worker exit', HANG_GUARD_MS)).toBe(0);

      expect(atStop).toMatchObject({sockets: 1, state: {status: 'disconnected', durable: {state: 'pending', retryCode: 'DISK_FULL'}}});
      expect(shutdown.steps.slice(0, 2)).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok'}, {phase: 'flush', name: 'recording-flush', outcome: 'ok'}]);
      expect(elapsedMs).toBeLessThanOrEqual(SERVICE_STOP_BUDGET_MS);
      // The source stopped: no reconnection was made, nothing was acknowledged after 4.
      expect([socket.sockets(), report.connections.length, servedAcks(report, 0)]).toEqual([1, 1, ['1', '2', '3', '4']]);
      // H11: the final write of the six pending rows failed with the storage code, and nothing else was retried.
      expect(durableLogs(s.logs)).toEqual([['V1_DURABLE_RETRY', {code: 'DISK_FULL', count: 1}], ['V1_SAMPLES_EXIT', {rows: 6, losses: 0, code: 'DISK_FULL'}]]);
      const storage = await reader('t').open(), session = sessionOf(input);
      expect(ok(storage.committedThrough(session))).toBe('4');
      storage.close();
      expect(await storedSamples(reader('t'), input.seed as string, session)).toEqual([]);
      expect(existsSync(historyFile())).toBe(false);
    } finally { worker.control?.close(); await server.stop(); }
  }, 90_000);

  it('(d) a stop while the restore-loss row is in flight waits for it, stores it once and acknowledges nothing (R9, R14)', async () => {
    // normal-delivery with a second durable connection. Service A records connection 1 (events 1-8, all acknowledged)
    // into synthetic:a and stops when the server closes it. Service B records into a new synthetic:b, a database behind
    // the plugin: its checkpoint reports ACK 8 against stored coverage 0 (ACK_AHEAD_OF_STORAGE), and the restore-loss
    // row it then records is held before the worker until the flush step started.
    const input = withTransport(scenario('normal-delivery'), 'normal-delivery-restore-loss-stop', [connect(0), disconnect(605), connect(606), disconnect(1100)]);
    expect(reactiveConflicts(input)).toEqual([]);
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
    try {
      const first: string[] = [], workerA = storageWorker(), socketA = tracedConnect(first), shutdownA = tracedShutdown(first);
      let stoppedA: Promise<unknown> | undefined;
      const a = serviceRuntime('a', workerA.handle, socketA, first, {onState: state => {
        if (!stoppedA && state.status === 'disconnected') stoppedA = new Promise(resolve => setImmediate(() => { void shutdownA.sequence.run().then(resolve); }));
      }});
      a.runtime.register(shutdownA.registrar);
      await startDurable(a.runtime, server.endpoint);
      await until(() => stoppedA !== undefined, 'the end of connection 1', HANG_GUARD_MS);
      await guarded(stoppedA!, 'the stop of service A', HANG_GUARD_MS);
      expect(await guarded(workerA.exit, 'the storage worker exit of service A', HANG_GUARD_MS)).toBe(0);
      expect(socketA.sockets()).toBe(1);

      const timeline: string[] = [], workerB = storageWorker(), traced = tracedHandle(workerB.handle, timeline, 'recordCompleteness'), socketB = tracedConnect(timeline);
      const shutdownB = tracedShutdown(timeline, name => { if (name === 'recording-flush') setImmediate(() => traced.release()); });
      const b = serviceRuntime('b', traced.handle, socketB, timeline);
      b.runtime.register(shutdownB.registrar);
      await startDurable(b.runtime, server.endpoint);
      await guarded(traced.held, 'the held restore-loss row', HANG_GUARD_MS);
      timeline.push('stop');
      await shutdownB.sequence.run();
      await until(() => timeline.includes('HISTORY_STORAGE_CLOSED'), 'HISTORY_STORAGE_CLOSED', HANG_GUARD_MS);
      expect(await guarded(workerB.exit, 'the storage worker exit of service B', HANG_GUARD_MS)).toBe(0);
      const report = await guarded(server.done, 'the reactive server run', HANG_GUARD_MS);

      expect(shutdownB.steps.slice(0, 2)).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok'}, {phase: 'flush', name: 'recording-flush', outcome: 'ok'}]);
      expect(ordered(timeline, ['held recordCompleteness', 'stop', 'step intake v1-ingestion ok', 'start recording-flush', 'release', 'done recordCompleteness',
        'V1_DURABLE_RESTORE_LOSS', 'step flush recording-flush ok', 'HISTORY_STORAGE_CLOSED'])).toEqual(['held recordCompleteness', 'stop', 'step intake v1-ingestion ok',
        'start recording-flush', 'release', 'done recordCompleteness', 'V1_DURABLE_RESTORE_LOSS', 'step flush recording-flush ok', 'HISTORY_STORAGE_CLOSED']);
      expect(durableLogs(b.logs)).toEqual([['V1_DURABLE_ACK_AHEAD', {code: 'ACK_AHEAD_OF_STORAGE'}], ['V1_DURABLE_RESTORE_LOSS', {code: 'RECORDED'}]]);
      expect([servedAcks(report, 0), servedAcks(report, 1)]).toEqual([['1', '2', '3', '4', '5', '6', '7', '8'], []]);
      expect(timeline.filter(line => line.startsWith('ack '))).toEqual([]);
      expect(socketB.sockets()).toBe(1);

      // R9: one session-level restore-loss interval for the released range (0, 8]; nothing else in the new database.
      const session = sessionOf(input), storageA = await reader('a').open(), storageB = await reader('b').open();
      expect([ok(storageA.committedThrough(session)), ok(storageB.committedThrough(session))]).toEqual(['8', '0']);
      storageA.close(); storageB.close();
      expect(await storedRows(reader('b'), input.seed as string)).toEqual({trips: [], attributions: [], intervals: [
        {trip: null, kind: 'restore-loss', firstEventSeq: '1', lastEventSeq: '8', detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq: '0', ackedThroughEventSeq: '8'}}]});
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.stop(); }
  }, 90_000);
});

