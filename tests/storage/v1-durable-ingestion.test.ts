// Protocol v1 ingestion committing through the real storage worker (ET-006b, E1): the bundled storage worker in a real
// worker thread under the pinned Electron runtime, StorageClient, StorageDurableSink and V1Ingestion, against the
// reactive v1 simulator on actual Windows pipes, into a temporary synthetic-purpose database. Expected rows and ACKs are
// written by hand from the scenario expectations in tests/fixtures/simulator-v1 (REG-003, REG-005, REG-006, REG-007).
import net from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FrameDecoder, decodePayload, type ClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import {StorageDurableSink, type DurableStorageClient} from '../../apps/desktop/src/durable-sink';
import {V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, reactiveDifferences, serveV1Reactive, type ReactiveReport} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';

const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if (!bundles) throw new Error('Storage test bundles are missing; run npm run test:storage.');
const WORKER = path.join(bundles, 'storage-worker.cjs');
type Json = Record<string, unknown>;

let ws: Awaited<ReturnType<typeof workspace>>;
const workers: Worker[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.terminate())); await ws.dispose(); });

/** One telemetry-service instance: its own storage worker on the shared database file and its own ingestion. */
interface Service {ingestion: V1Ingestion; client: StorageClient; worker: Worker; exit: Promise<number>; states: V1SourceState[]; progress: Progress}
/** Coverage items (events and gap markers) the service's connection delivered, and its commit commands that settled. */
interface Progress {received: number; settled: number; waiters: (() => void)[]}
interface Plan {
  /** Connections (0-based, in welcome order) whose ACKs are lost on the way to the pipe. */
  dropAcks?: number[];
  /** Stop the service and start a new one, with a new worker on the same file, after every connection but the last. */
  restart?: boolean;
  /** Terminate the service's storage worker right before its n-th commit command (1-based) on the given connection. */
  terminate?: {connection: number; commit: number};
}

async function run(input: Json, plan: Plan) {
  expect(reactiveConflicts(input)).toEqual([]);
  const replay = replayV1(input), sessions = replay.connections.filter(c => !c.helloFault).length;
  // A connection scripted to acknowledge each commit is awaited until it did or left, however long the real storage
  // worker takes: the 1,000 ms quiesce bound alone let a slow commit decide which ACKs the server recorded.
  const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true});
  const services: Service[] = [];
  let connection = -1, commits = 0, finished!: () => void;
  const allClosed = new Promise<void>(r => { finished = r; });
  // Work started from socket callbacks is tracked; its first rejection fails the run instead of being lost.
  let fail!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { fail = reject; }), background: Promise<unknown>[] = [];
  failed.catch(() => undefined);
  const track = (work: Promise<unknown>) => { background.push(work.catch(error => fail(error))); };
  const connect = (endpoint: string, progress: Progress) => {
    const socket = net.connect(endpoint), write = socket.write.bind(socket), decoder = new FrameDecoder('server');
    let index: number | undefined;
    // Registered before the ingestion's listeners: a welcome is numbered before the ingestion applies it.
    socket.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk, m => {
          if (m.kind === 'event' || m.kind === 'gap') progress.received++;
          if (m.kind !== 'welcome' || index !== undefined) return;
          const own = index = ++connection; commits = 0;
          socket.once('close', () => {
            // A stopped ingestion never reconnects: its pending reconnection checks that it was stopped.
            if (own === sessions - 1) { track(services.at(-1)!.ingestion.stop()); finished(); }
            else if (plan.restart) {
              const old = services.at(-1)!;
              // Selecting no source cancels the old service's pending reconnection at once, while its durable pipeline
              // keeps committing what this connection delivered. It is stopped once every delivered item's commit
              // command has settled, counted in commands, never in time, so the coverage the restarted service reads
              // does not depend on how fast storage was. The next service opens the file only after the old worker
              // closed it and released its exclusive lock.
              old.ingestion.select('game');
              track(drained(old).then(() => old.ingestion.stop()).then(() => old.client.close()).then(() => start()));
            }
          });
        });
      } catch { /* the ingestion's own decoder reports the violation */ }
    });
    socket.write = ((bytes: Uint8Array, ...rest: unknown[]) => {
      const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage;
      if (m.kind === 'ack' && index !== undefined && plan.dropAcks?.includes(index)) return true;
      return (write as (...args: unknown[]) => boolean)(bytes, ...rest);
    });
    return socket;
  };
  const start = async () => {
    const worker = new Worker(WORKER, {workerData: {kind: 'storage'}}); workers.push(worker);
    const exit = once(worker, 'exit').then(([code]) => code as number), client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
    const progress: Progress = {received: 0, settled: 0, waiters: []};
    const notify = () => { for (const waiter of progress.waiters.splice(0)) waiter(); };
    const settled = <T>(command: Promise<T>) => command.finally(() => { progress.settled++; notify(); });
    const storage: DurableStorageClient = {
      upsertSession: input => client.upsertSession(input),
      committedThrough: session => client.committedThrough(session),
      commitGap: input => settled(client.commitGap(input)),
      commitEvent: async input => {
        commits++;
        // Counted in commit commands, never in time: the worker is gone before this command is sent.
        if (plan.terminate && connection === plan.terminate.connection && commits === plan.terminate.commit) await worker.terminate();
        return settled(client.commitEvent(input));
      }
    };
    const states: V1SourceState[] = [];
    const ingestion = new V1Ingestion({connect: endpoint => connect(endpoint, progress), sink: new StorageDurableSink(storage), onState: s => { states.push(s); notify(); }});
    services.push({ingestion, client, worker, exit, states, progress});
    ingestion.select('synthetic', server.endpoint);
  };
  /** Every delivered item's commit command settled, or a durable failure dropped what was still queued. */
  const drained = async ({progress, states}: Service) => {
    const dropped = () => { const s = states.at(-1)?.durable; return s?.state === 'failed' || (s?.state === 'pending' && s.retryCode !== undefined); };
    while (progress.settled < progress.received && !dropped()) await new Promise<void>(resolve => progress.waiters.push(resolve));
  };
  try {
    await start();
    const report = await Promise.race([server.done, failed]);
    await Promise.race([allClosed, failed]);
    await Promise.all(background);
    // A failure of tracked work that settled after the races above still fails the run.
    await Promise.race([failed, Promise.resolve()]);
    for (const service of services) await service.ingestion.stop();
    return {replay, report, services};
  } finally { await server.stop(); }
}
const acks = (report: ReactiveReport, connection: number) => report.transcript.filter(l => l.connection === connection && l.direction === 'client' && l.message.kind === 'ack')
  .map(l => (l.message as Extract<ClientMessage, {kind: 'ack'}>).data.throughEventSeq);
const served = (report: ReactiveReport, connection: number, kind: 'checkpoint') => report.transcript.find(l => l.connection === connection && l.direction === 'server' && l.message.kind === kind)?.message as Extract<ServerMessage, {kind: 'checkpoint'}>;
async function stored(session: string) {
  const reader = await ws.open();
  const result = {through: ok(reader.committedThrough(session)), events: ok(reader.listEvents(session)).map(e => `${e.eventSeq} ${e.type}${e.firstRedelivered ? ' r' : ''}`)};
  reader.close();
  const gaps = readOnly(ws.database, db => db.prepare('SELECT first_event_seq AS f, last_event_seq AS l, cause_offline AS offline, redelivered AS r FROM event_gaps ORDER BY id').all() as {f: string; l: string; offline: string; r: bigint}[])
    .map(g => `${BigInt(g.f)}-${BigInt(g.l)} offline ${BigInt(g.offline)}${g.r ? ' r' : ''}`);
  const integrity = readOnly(ws.database, db => db.pragma('integrity_check', {simple: true}));
  return {...result, gaps, integrity};
}
const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
const inline = (id: string, steps: Json[], transport: Json[]): Json => ({format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id, purpose: 'ET-006b storage ingestion test', reg: ['REG-006'],
  origin: 'synthetic', game: 'ets2', seed: id, provenance: null, source: SOURCE, steps, transport});

describe('ET-006b ingestion through the real storage worker', () => {
  it('commits hydration-free offline gaps and a live event, and acknowledges each only after its commit (REG-003)', async () => {
    const input = readFixtureFile(scenarioPath('app-absent-hydration')) as Json;
    const {replay, report, services} = await run(input, {});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    // Hand-written from app-absent-hydration.expected.json: gaps [1, 3] and [4, 4], then job.cleared 5.
    expect(acks(report, 1)).toEqual(['3', '4', '5']);
    expect(await services[0].client.close()).toEqual({clean: true});
    expect(await services[0].exit).toBe(0);
    // The checkpoint's job configuration hydrated live state only: no job.configured row exists.
    expect(await stored(scenarioSource(replay.scenario).pluginSessionId)).toEqual({through: '5', events: ['5 job.cleared'], gaps: ['1-3 offline 3', '4-4 offline 1'], integrity: 'ok'});
    expect(services[0].states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
  }, 60_000);

  it('is duplicate-free after a service restart with a new worker on the same file (REG-005, REG-006)', async () => {
    // Every ACK of the first connection is lost, so the producer redelivers all three events to the restarted service.
    const input = inline('et006b-restart', [{atMs: 10, action: 'lifecycle', event: 'simulation.started'},
      {atMs: 20, action: 'gameplay', id: 'player.tollgate.paid', attributes: [{name: 'pay.amount', sdkType: 's64', value: '15'}]},
      {atMs: 30, action: 'lifecycle', event: 'simulation.paused'}],
    [{atMs: 0, action: 'connect', client: {durable: true, ack: 'withhold'}}, {atMs: 50, action: 'disconnect'},
      {atMs: 100, action: 'connect', client: {durable: true}}, {atMs: 150, action: 'disconnect'}]);
    const {replay, report, services} = await run(input, {dropAcks: [0], restart: true});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(services).toHaveLength(2);
    // The restarted service's cursor starts from storage (C = 3): each redelivered duplicate is acknowledged again.
    expect([served(report, 2, 'checkpoint').data.status.delivery.ackedThroughEventSeq, acks(report, 2)]).toEqual(['0', ['1', '2', '3']]);
    expect(await services[1].client.close()).toEqual({clean: true});
    // Coverage is unchanged by the redelivery and no row was added.
    expect(await stored(scenarioSource(replay.scenario).pluginSessionId)).toEqual({through: '3', events: ['1 simulation.started', '2 player.tollgate.paid', '3 simulation.paused'], gaps: [], integrity: 'ok'});
  }, 60_000);

  it('sends no ACK after the storage worker is terminated, so the next checkpoint keeps the last acknowledged point (REG-007)', async () => {
    // crash-before-commit: the worker is terminated before the commit of eventSeq 2, the service fails durable delivery
    // and leaves; a restarted service with a new worker receives eventSeq 2 again from A = 1.
    const input = readFixtureFile(scenarioPath('crash-before-commit')) as Json;
    const {replay, report, services} = await run(input, {restart: true, terminate: {connection: 0, commit: 2}});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(services[0].states.at(-1)?.durable).toEqual({state: 'failed', code: 'WORKER_FAILED'});
    expect(await services[0].exit).not.toBe(0);
    expect([acks(report, 1), served(report, 2, 'checkpoint').data.status.delivery.ackedThroughEventSeq, acks(report, 2)]).toEqual([['1'], '1', ['2', '3']]);
    expect(await services[1].client.close()).toEqual({clean: true});
    // Hand-written from crash-before-commit.expected.json: event 2 is a first commit on the second connection, 3 an offline gap.
    expect(await stored(scenarioSource(replay.scenario).pluginSessionId)).toEqual({through: '3', events: ['1 job.configured', '2 simulation.started r'], gaps: ['3-3 offline 1'], integrity: 'ok'});
  }, 60_000);
});
