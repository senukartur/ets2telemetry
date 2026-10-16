// S4 (ET-015a PR-2): storage failures injected inside the real commit transaction by the test-only fault storage worker
// (tests/storage/fixtures/fault-storage-worker.ts, R13), under the trip recorder and V1Ingestion against the reactive
// simulator on actual pipes. The transport of normal-delivery.json is replaced so that the reconnection the failure
// causes is scripted; the final rows are hand-written in tests/fixtures/recording/<id>.rows.expected.json (REG-007,
// REG-011). Injected SQLite codes are not a full volume, a real permission change or a real lock.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import type {MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, workspace} from './helpers';
import {RECORDING_FIXTURES, recordingExpected, replayOf, runRecording, storedRows, storedSamples as readSamples, terminateWorkers, withTransport, type RecordingRun} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

const base = () => readFixtureFile(scenarioPath('normal-delivery')) as Json;
const SEED = 'et005b-normal-delivery';
const connect = (atMs: number, client: Json = {durable: true}) => ({atMs, action: 'connect', client});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
/** The rows, coverage and ACK bound shared by every case. */
async function expectRows(run: RecordingRun, id: string) {
  const expected = recordingExpected(id), session = scenarioSource(replayOf(base()).scenario).pluginSessionId;
  for (const ack of run.acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
  for (const service of run.services) expect(await service.client.close()).toEqual({clean: true});
  const reader = await ws.open(); const through = ok(reader.committedThrough(session)); reader.close();
  expect(through).toBe(expected.coverage.committedThroughEventSeq);
  expect({committed: run.tally.committed, duplicate: run.tally.duplicate, covered: run.tally.covered, conflict: run.tally.conflict})
    .toEqual({committed: expected.coverage.committed, duplicate: expected.coverage.duplicate, covered: expected.coverage.covered, conflict: 0});
  expect(await storedRows(ws, SEED)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
}
/**
 * The fault worker's first control message, normally `{type: 'held'}` once a commit is held inside its transaction. The
 * bound is a named hang guard only, far below the case timeout: a worker that never holds fails the case with its cause.
 */
const HELD_HANG_GUARD_MS = 15_000;
async function heldOrHang(control: MessagePort): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The fault worker never reported a held commit within ${HELD_HANG_GUARD_MS} ms`)), HELD_HANG_GUARD_MS);
  });
  try { return (await Promise.race([once(control, 'message'), guard]))[0]; } finally { clearTimeout(timer); }
}
const durableLogs = (run: RecordingRun, service = 0) => run.services[service].logs.filter(([event]) => event.startsWith('V1_DURABLE'));

describe('S4 injected storage failures under the trip recorder', () => {
  // A retryable failure of job.delivered (eventSeq 8): the connection closes without its ACK and the redelivery on the
  // scripted second connection (606 ms) commits it once, carrying the reconnection's not-connected interval.
  for (const [code, storageCode] of [['SQLITE_FULL', 'DISK_FULL'], ['SQLITE_BUSY', 'DATABASE_LOCKED']] as const) it(`(${code === 'SQLITE_FULL' ? 'a' : 'd'}) ${code} once at job.delivered is retried and committed once (${storageCode})`, async () => {
    const input = withTransport(base(), `normal-delivery-${storageCode.toLowerCase()}`, [connect(0), disconnect(605), connect(606), disconnect(1100)]);
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {fault: {eventSeq: '8', code, times: 1}}});
    expect(durableLogs(run)).toEqual([['V1_DURABLE_RETRY', {code: storageCode, count: 1}]]);
    // No ACK reached 8 on the first connection; the second acknowledged the redelivered 8, then the live 9.
    expect([run.served(0), run.served(1)]).toEqual([['1', '2', '3', '4', '5', '6', '7'], ['8', '9']]);
    expect(run.services[0].states.filter(s => s.durable.state === 'failed')).toEqual([]);
    await expectRows(run, 'normal-delivery-retry');
  }, 90_000);

  it('(b) SQLITE_READONLY at job.delivered stops durable delivery; a new service cold-starts and resumes the trip (PERMISSION_DENIED)', async () => {
    // The second connection is live-only, as the failed service reconnects; the third belongs to a new service. A frame
    // at 650 ms ends the SDK frame after the clear (610), so the producer publishes its noDurableConsumer loss as a gap
    // record (docs/simulator-v1.md: loss runs leave the channel at frame_end).
    const input = withTransport(base(), 'normal-delivery-permission-denied', [connect(0), disconnect(605), connect(606, {durable: false}), disconnect(700), connect(800), disconnect(1100)],
      [{atMs: 650, action: 'frame'}]);
    let between: unknown;
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {fault: {eventSeq: '8', code: 'SQLITE_READONLY', times: 1}}, restartAfter: [1],
      between: async () => {
        // The failed service committed nothing from eventSeq 8 on and left the trip open.
        const reader = await ws.open(), session = scenarioSource(replayOf(base()).scenario).pluginSessionId;
        between = {through: ok(reader.committedThrough(session)), trips: ok(reader.listTrips()).trips.map(t => [t.outcome, t.outcomeEventSeq])};
        reader.close();
      }});
    expect(between).toEqual({through: '7', trips: [['open', null]]});
    expect(run.services).toHaveLength(2);
    expect(durableLogs(run)).toEqual([['V1_DURABLE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}]]);
    expect(run.services[0].states.at(-1)?.durable).toEqual({state: 'failed', code: 'PERMISSION_DENIED'});
    // The live-only connection sends no ACK; the job.cleared it observed (9) is lost as noDurableConsumer.
    expect([run.served(0), run.served(1), run.served(2)]).toEqual([['1', '2', '3', '4', '5', '6', '7'], [], ['8', '9']]);
    const third = run.report.transcript.filter(l => l.connection === 3 && l.direction === 'server' && (l.message.kind === 'event' || l.message.kind === 'gap')).map(l => l.message as ServerMessage);
    expect(third.map(m => m.kind === 'event' ? `${m.data.eventSeq}${m.data.redelivered ? 'r' : ''}` : m.kind === 'gap' ? `gap ${m.data.firstEventSeq}-${m.data.lastEventSeq} ${m.data.causes.noDurableConsumer}` : ''))
      .toEqual(['8r', 'gap 9-9 1']);
    expect(durableLogs(run, 1)).toEqual([]);
    await expectRows(run, 'normal-delivery-permission-denied');
  }, 90_000);

  it('(c) queue pressure: a held commit and a bound of 4 close the connection, and nothing is acknowledged before the release (REG-011)', async () => {
    // The first connection's client does not wait for ACKs, so the server writes events 1-5 while eventSeq 1 is held; the
    // fifth closes the connection with BACKLOG_FULL. Every item it received is redelivered, one more than the bound, so
    // the same service with a bound of four would refuse that burst again at every reconnection. The redelivery goes to
    // a restarted service with the production bound of 256, which starts with nothing queued. Equality of that bound with
    // the producer's 256 retained entries is not enough on its own: items still queued or in flight from an earlier
    // connection count against a redelivery too, which can give a transient BACKLOG_FULL (docs/telemetry-service-v1.md).
    // The frames after eventSeq 1 reach the ingestion only once the worker reports the commit of 1 held inside its
    // transaction. Without that gate a slow session open (hosted CI run 38907225873) let all five items arrive first: 1-4
    // were queued, the fifth dropped them, nothing was committed or held, and the restarted service committed 1-9 anew.
    const input = withTransport(base(), 'normal-delivery-backlog', [connect(0, {durable: true, ack: 'withhold'}), disconnect(350), connect(360), disconnect(1100)]);
    let released = false;
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {hold: {eventSeq: '1'}}, maxPendingCommits: 4, serve: {quiesceMs: 0}, restartAfter: [0],
      gate: {afterEventSeq: '1', until: async service => { expect(await heldOrHang(service.control!)).toEqual({type: 'held', eventSeq: '1'}); }},
      onState: (state, service, mark) => {
        if (released || state.durable.state !== 'pending' || state.durable.retryCode !== 'BACKLOG_FULL') return;
        released = true; mark('release'); service.control!.postMessage({type: 'release'});
      }});
    expect(released).toBe(true);
    const release = run.timeline.indexOf('release');
    expect(run.timeline.slice(0, release)).toEqual([]);
    expect(durableLogs(run)).toEqual([['V1_DURABLE_RETRY', {code: 'BACKLOG_FULL', count: 1}]]);
    // The first connection never received an ACK; the second acknowledged every redelivered and live item.
    expect([run.served(0), run.served(1)]).toEqual([[], ['1', '2', '3', '4', '5', '6', '7', '8', '9']]);
    await expectRows(run, 'normal-delivery-backlog');
  }, 90_000);
});

// ET-015b (H10, H12): failures injected inside the real appendSamples transaction by the fault worker's `samplesFault`,
// under the same recorder and ingestion, with tests/fixtures/recording/one-second-samples.json. Its events are 1-6 on
// connection 1 and 7-8 on connection 2; its stored rows are hand-written in one-second-samples.rows.expected.json.
describe('ET-015b injected sample failures under the trip recorder', () => {
  const samplesInput = () => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string};
  const samplesExpected = () => (JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.rows.expected.json'), 'utf8')) as {samples: unknown[]}).samples;
  /** The stored samples in the expectation's shape; every client must be closed first. */
  const storedSamples = (seed: string, session: string) => readSamples(ws, seed, session);
  const failureLogs = (run: RecordingRun) => run.services[0].logs.filter(([event]) => /^V1_(DURABLE|SAMPLES_(RETRY|DROPPED|DISCARDED|SKIPPED))/.test(event));
  const allEvents = [['1', '2', '3', '4', '5', '6'], ['7', '8']];
  /**
   * A flush delay far beyond any run (review pass 1), so the first sample batch is the one the batch size queues; a slow
   * runner's 5 s timer could otherwise write a smaller batch first and take the injected fault or hold.
   */
  const NO_FLUSH_TIMER_MS = 600_000;

  it('(e) SQLITE_FULL twice in appendSamples keeps the rows and stores each once later, while events commit and are acknowledged (DISK_FULL)', async () => {
    const input = samplesInput(), session = scenarioSource(replayOf(input).scenario).pluginSessionId;
    // A 1 ms flush writes and retries each pending row almost at once, so both failures happen during the run.
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {samplesFault: {code: 'SQLITE_FULL', times: 2}}, sampleFlushMs: 1});
    expect(failureLogs(run)).toEqual([['V1_SAMPLES_RETRY', {code: 'DISK_FULL', count: 1}], ['V1_SAMPLES_RETRY', {code: 'DISK_FULL', count: 2}]]);
    expect([run.served(0), run.served(1)]).toEqual(allEvents);
    expect(run.services[0].states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
    expect(await run.services[0].client.close()).toEqual({clean: true});
    expect(await storedSamples(input.seed, session)).toEqual(samplesExpected());
  }, 90_000);

  it('(f) SQLITE_READONLY in appendSamples stops durable delivery for the service lifetime and discards the pending rows (PERMISSION_DENIED)', async () => {
    // The first batch is queued when the seventh row (second 1009, after simulation.started, eventSeq 6) is pending. The
    // reconnection after the failure is live-only.
    const base = samplesInput(), input = withTransport(base, 'one-second-samples-permission-denied', [connect(0), disconnect(13000), connect(15500, {durable: false}), disconnect(17500)]);
    const session = scenarioSource(replayOf(input).scenario).pluginSessionId;
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {samplesFault: {code: 'SQLITE_READONLY', times: 1}}, sampleBatchRows: 7,
      sampleFlushMs: NO_FLUSH_TIMER_MS});
    const logs = failureLogs(run), discarded = logs.find(([event]) => event === 'V1_SAMPLES_DISCARDED')?.[1] as {count: number} | undefined;
    expect(logs).toEqual([['V1_DURABLE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}], ['V1_SAMPLES_DISCARDED', {count: discarded?.count}]]);
    // Rows 1000-1005 and 1009 at least, and at most 1010-1012 that were observed before the batch ran.
    expect(discarded!.count).toBeGreaterThanOrEqual(7); expect(discarded!.count).toBeLessThanOrEqual(10);
    expect(run.services[0].states.at(-1)?.durable).toEqual({state: 'failed', code: 'PERMISSION_DENIED'});
    // Events 1-6 were committed and acknowledged before the batch; the live-only connection acknowledges nothing.
    expect([run.served(0), run.served(1)]).toEqual([allEvents[0], []]);
    expect(await run.services[0].client.close()).toEqual({clean: true});
    const reader = await ws.open(); expect(ok(reader.committedThrough(session))).toBe('6'); reader.close();
    expect(await storedSamples(base.seed, session)).toEqual([]);
  }, 90_000);

  it('(g) a held sample batch holds the FIFO: no event is acknowledged until it is released, then every item and row is stored (REG-007)', async () => {
    const input = samplesInput(), session = scenarioSource(replayOf(input).scenario).pluginSessionId;
    let listening = false;
    // The first appendSamples (six rows, 1000-1005, queued by the batch size, never by the timer) is held inside its
    // transaction for 300 ms of real time.
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {samplesFault: {hold: true}}, sampleBatchRows: 6, sampleFlushMs: NO_FLUSH_TIMER_MS,
      onState: (_state, service, mark) => {
        if (listening || !service.control) return;
        listening = true;
        service.control.on('message', (message: {type?: string}) => {
          if (message.type !== 'held') return;
          mark('held');
          setTimeout(() => { mark('release'); service.control!.postMessage({type: 'release'}); }, 300);
        });
      }});
    run.services[0].control?.close();
    const held = run.timeline.indexOf('held'), release = run.timeline.indexOf('release');
    expect([held >= 0, release - held]).toEqual([true, 1]);
    // Some event was waiting behind the batch: it is acknowledged only after the release.
    expect(run.timeline.slice(release + 1).filter(line => line.startsWith('ack')).length).toBeGreaterThan(0);
    expect([run.served(0), run.served(1)]).toEqual(allEvents);
    expect(failureLogs(run)).toEqual([]);
    expect(await run.services[0].client.close()).toEqual({clean: true});
    expect(await storedSamples(input.seed, session)).toEqual(samplesExpected());
  }, 90_000);
});
