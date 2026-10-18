// S5 (ET-015a PR-3; R3, R10): the telemetry service's HistoryStorage with a synthetic recording target and the bundled
// storage worker under the pinned Electron runtime. The target opens `<LOCALAPPDATA>\ETS2Telemetry\synthetic\<name>.sqlite`
// with the synthetic purpose and never the history file. A read-only target file is refused at open with
// PERMISSION_DENIED: no client is exposed, a V1Ingestion wired like the service then sends a live-only hello over an
// actual Windows pipe, and the file keeps its bytes (REG-007). Expected values are written by hand from docs/storage.md
// and docs/telemetry-service-v1.md.
import {chmodSync, existsSync} from 'node:fs';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FrameDecoder, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import {openStorage} from '../../packages/storage/src/index';
import {workerHandle} from '../../packages/storage/src/client';
import {HISTORY_CLOSE_BUDGET_MS, HistoryStorage, recorderClient} from '../../apps/desktop/src/history-storage';
import {ShutdownSequence} from '../../apps/desktop/src/shutdown-sequence';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {V1Ingestion} from '../../apps/desktop/src/v1-ingestion';
import {ok, readOnly, sha256, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {terminateWorkers, WORKER} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** The service's HistoryStorage for `synthetic:t` under the workspace as LOCALAPPDATA, with the real worker entry. */
function service() {
  const logs: [string, unknown][] = [], exits: Promise<number>[] = [];
  let opened = 0;
  const history = new HistoryStorage({localAppData: ws.directory, appVersion: '0.1.0-test', target: {purpose: 'synthetic', name: 't'}, closeGraceMs: TEST_CLOSE_GRACE_MS,
    log: (event, _detail, facts) => logs.push([event, facts]), onOpened: () => { opened++; },
    createWorker: () => { const worker = new Worker(WORKER, {workerData: {kind: 'storage'}}); exits.push(once(worker, 'exit').then(([code]) => code as number)); return workerHandle(worker); }});
  return {history, logs, exits, opened: () => opened};
}
const target = () => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 't.sqlite');
const historyFile = () => path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
/** Waits until the open settled, counted in state changes of the storage, not in time. */
async function settled(history: HistoryStorage) {
  for (let i = 0; i < 2_000 && (history.state === 'idle' || history.state === 'opening'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  return history.state;
}

describe('S5 recording target through the real storage worker', () => {
  it('opens the synthetic target with the synthetic purpose and never the history file', async () => {
    const s = service();
    s.history.start();
    expect(await settled(s.history)).toBe('open');
    expect(s.opened()).toBe(1);
    expect(ok(await s.history.client!.listTrips())).toEqual({trips: [], nextCursor: null});
    await s.history.close();
    expect(s.history.client).toBeUndefined();
    expect(s.logs).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_OPENED', {schemaVersion: 2, created: true, migratedFrom: null}], ['HISTORY_STORAGE_CLOSED', undefined]]);
    expect(readOnly(target(), db => db.prepare('SELECT purpose FROM database_info WHERE id = 1').pluck().get())).toBe('synthetic');
    expect([existsSync(historyFile()), existsSync(target() + '-wal')]).toEqual([false, false]);
  }, 60_000);

  it('refuses a read-only target with PERMISSION_DENIED: no client, a live-only hello, and unchanged file bytes', async () => {
    // A valid synthetic database at the target path, then made read-only.
    ok(await openStorage({path: target(), purpose: 'synthetic', backupsDirectory: path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'backups'), appVersion: '0.1.0-test'})).close();
    const before = sha256(target());
    chmodSync(target(), 0o444);
    const pipe = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
    const hellos: ClientMessage[] = [], sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => undefined);
      const decoder = new FrameDecoder('client');
      socket.on('data', chunk => { try { decoder.push(chunk, m => { hellos.push(m as ClientMessage); }); } catch { /* only the hello is checked */ } });
    });
    await new Promise<void>(resolve => server.listen(pipe, resolve));
    let ingestion: V1Ingestion | undefined;
    try {
      const s = service();
      s.history.start();
      expect(await settled(s.history)).toBe('unavailable');
      expect([s.history.client, s.opened()]).toEqual([undefined, 0]);
      expect(s.logs).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}]]);
      // The ingestion wired as the service wires it for synthetic:t: durable only for synthetic, only while open (R10).
      ingestion = new V1Ingestion({sink: new TripRecorderSink(recorderClient(s.history)), durableSelections: ['synthetic'], durableReady: () => s.history.state === 'open'});
      ingestion.select('synthetic', pipe);
      for (let i = 0; i < 2_000 && hellos.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(hellos).toHaveLength(1);
      expect(hellos[0]).toMatchObject({kind: 'hello', data: {durableEvents: false}});
      await ingestion.stop(); ingestion = undefined;
      await s.history.close();
      // The refused open ended its worker in order; nothing wrote to the file.
      expect(await Promise.all(s.exits)).toEqual([0]);
      expect(sha256(target())).toBe(before);
      expect(existsSync(historyFile())).toBe(false);
    } finally {
      await ingestion?.stop();
      chmodSync(target(), 0o666);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000);
});

// Regression (history close grace review, October 18, 2026): a service thread stalled past the 1,000 ms step budget
// runs both the grace and the budget timers before the next poll phase delivers the worker's close answer and exit. With
// the production grace and budget and the real ShutdownSequence timers, the step still counts as `ok`.
describe('the history-storage step after a stall past its budget', () => {
  it('counts a close that finished while the service thread was blocked past the step budget', async () => {
    const logs: [string, unknown][] = [];
    const log = (event: string, _detail?: unknown, facts?: unknown) => { logs.push([event, facts]); };
    const history = new HistoryStorage({localAppData: ws.directory, appVersion: '0.1.0-test', target: {purpose: 'synthetic', name: 't'}, log,
      createWorker: () => workerHandle(new Worker(WORKER, {workerData: {kind: 'storage'}}))});
    history.start();
    expect(await settled(history)).toBe('open');
    expect(existsSync(target() + '-wal')).toBe(true);
    const sequence = new ShutdownSequence(log);
    // Registered in the first phase so that run() starts the close synchronously, inside the blocked callback below.
    sequence.register('intake', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => history.close()});
    const cell = new Int32Array(new SharedArrayBuffer(4));
    let walRemoved = false;
    // Run and block in an immediate, outside the worker port's message callback, until the worker removed the WAL and
    // the budget passed, plus a 1,000 ms margin for the answer and exit on a loaded host.
    const result = await new Promise<{clean: boolean}>(resolve => setImmediate(() => {
      const running = sequence.run(), started = Date.now();
      while (existsSync(target() + '-wal') && Date.now() - started < 20_000) Atomics.wait(cell, 0, 0, 5);
      walRemoved = !existsSync(target() + '-wal');
      Atomics.wait(cell, 0, 0, Math.max(0, HISTORY_CLOSE_BUDGET_MS - (Date.now() - started)) + 1_000);
      resolve(running);
    }));
    expect(walRemoved).toBe(true);
    expect(result).toEqual({clean: true});
    const step = logs.find(([event]) => event === 'SHUTDOWN_STEP')?.[1] as {outcome: string; ms: number};
    expect(step.outcome).toBe('ok');
    expect(step.ms).toBeGreaterThan(HISTORY_CLOSE_BUDGET_MS);
    expect(logs.map(([event]) => event)).toContain('HISTORY_STORAGE_CLOSED');
  }, 60_000);
});
