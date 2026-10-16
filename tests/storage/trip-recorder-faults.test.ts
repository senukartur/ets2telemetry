// S4 (ET-015a PR-2): storage failures injected inside the real commit transaction by the test-only fault storage worker
// (tests/storage/fixtures/fault-storage-worker.ts, R13), under the trip recorder and V1Ingestion against the reactive
// simulator on actual pipes. The transport of normal-delivery.json is replaced so that the reconnection the failure
// causes is scripted; the final rows are hand-written in tests/fixtures/recording/<id>.rows.expected.json (REG-007,
// REG-011). Injected SQLite codes are not a full volume, a real permission change or a real lock.
import {once} from 'node:events';
import type {MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, workspace} from './helpers';
import {recordingExpected, replayOf, runRecording, storedRows, terminateWorkers, withTransport, type RecordingRun} from './recording-helpers';

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
const durableLogs =(run: RecordingRun, service = 0) => run.services[service].logs.filter(([event]) => event.startsWith('V1_DURABLE'));

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
