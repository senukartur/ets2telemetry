// ET-015c PR-2 (G11, REG-011): a reconnection's full redelivery stays inside the commit backlog bound while the items of
// the connection that ended are still queued. The test-only fault storage worker holds the commit of eventSeq 1 inside
// its transaction while the first connection carries 200 events; after a scripted disconnect the same service's next
// connection receives all 200 again as redeliveries. The commit is released only once the redelivered eventSeq 200 has
// reached the ingestion, so 400 items are pending at once: more than the old bound of 256, which closed that connection
// with BACKLOG_FULL, and inside 512. The trip recorder and V1Ingestion run against the reactive simulator on actual
// pipes; the final rows are hand-written in tests/fixtures/recording/backlog-redelivery.rows.expected.json. Waits are
// counted in held messages, redelivered frames and ACKs; real-time bounds are named hang guards only.
import {existsSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import type {MessagePort} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, workspace} from './helpers';
import {recordingExpected, replayOf, runRecording, storedRows, terminateWorkers, type RecordingRun, type Service} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

const SEED = 'et005b-normal-delivery';
/** Identical truck re-sends inserted into normal-delivery, so that its first connection carries eventSeq 1-200. */
const RESENDS = 194;
const connect = (atMs: number, client: Json = {durable: true}) => ({atMs, action: 'connect', client});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
/**
 * normal-delivery.json with RESENDS copies of its truck configuration at 250 ms (eventSeq 5-198), before the job
 * re-send at 300 ms. The first connection's client does not wait for ACKs and ends after simulation.paused (200) at
 * 450 ms; the second connection at 460 ms receives 1-200 as redeliveries and then the live 201-203.
 */
function scenario(): Json {
  const base = readFixtureFile(scenarioPath('normal-delivery')) as Json & {steps: Json[]};
  const resend = base.steps.findIndex(step => step.atMs === 300);
  const truck = base.steps.find(step => step.action === 'configuration' && step.id === 'truck')!;
  const steps = [...base.steps.slice(0, resend), {...truck, atMs: 250, repeat: RESENDS}, ...base.steps.slice(resend)];
  return {...structuredClone(base), id: 'backlog-redelivery', steps, transport: [connect(0, {durable: true, ack: 'withhold'}), disconnect(450), connect(460), disconnect(1100)]};
}
/**
 * The fault worker's first control message, `{type: 'held'}` once the commit is held inside its transaction. The bound
 * is a named hang guard only, far below the case timeout: a worker that never holds fails the case with its cause.
 */
const HELD_HANG_GUARD_MS = 15_000;
async function heldOrHang(control: MessagePort): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The fault worker never reported a held commit within ${HELD_HANG_GUARD_MS} ms`)), HELD_HANG_GUARD_MS);
  });
  try { return (await Promise.race([once(control, 'message'), guard]))[0]; } finally { clearTimeout(timer); }
}
const durableLogs = (run: RecordingRun) => run.services[0].logs.filter(([event]) => event.startsWith('V1_DURABLE'));
const numbers = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => String(from + i));

describe('ET-015c backlog bound under a reconnection with a held commit', () => {
  it('commits the ended connection\'s items and the full redelivery once, without BACKLOG_FULL (G11, REG-011)', async () => {
    const input = scenario(), session = scenarioSource(replayOf(input).scenario).pluginSessionId;
    let released = false, atRelease: unknown;
    const release = (service: Service) => { if (!released) { released = true; service.control!.postMessage({type: 'release'}); } };
    const run = await runRecording(input, {path: ws.database, backups: ws.backups}, {fault: {hold: {eventSeq: '1'}}, serve: {quiesceMs: 0},
      gate: {afterEventSeq: '200', redelivered: true, until: async service => {
        // The redelivered 200 has been enqueued, and the commit of 1 is held with the first connection's 1-200 pending.
        expect(await heldOrHang(service.control!)).toEqual({type: 'held', eventSeq: '1'});
        const state = service.states.at(-1);
        atRelease = {observation: state?.observation?.kind, capture: state?.observation?.capture.monotonicNs, durable: state?.durable};
        release(service);
      }},
      // Without the bound fix the redelivery is refused before the gate: release the commit so that the run still ends.
      onState: (state, service) => { if (state.durable.state === 'pending' && state.durable.retryCode === 'BACKLOG_FULL') release(service); }});
    run.services[0].control?.close();
    expect(durableLogs(run)).toEqual([]);
    expect(run.services).toHaveLength(1);
    // While the commit was held, the live state advanced to the second connection's checkpoint (460 ms).
    expect(atRelease).toEqual({observation: 'checkpoint', capture: '1000460000000', durable: {state: 'pending'}});
    // The second connection received 1-200 as redeliveries (I6) and the live 201-203; it acknowledged each of them.
    const second = run.report.transcript.filter(l => l.connection === 2 && l.direction === 'server' && l.message.kind === 'event').map(l => l.message as Extract<ServerMessage, {kind: 'event'}>);
    expect(second.map(m => `${m.data.eventSeq}${m.data.redelivered ? 'r' : ''}`)).toEqual([...numbers(1, 200).map(n => `${n}r`), ...numbers(201, 203)]);
    expect([run.served(0), run.served(1)]).toEqual([[], numbers(1, 203)]);
    for (const ack of run.acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
    expect(await run.services[0].client.close()).toEqual({clean: true});

    const expected = recordingExpected('backlog-redelivery');
    const reader = await ws.open(); const through = ok(reader.committedThrough(session)); reader.close();
    expect(through).toBe(expected.coverage.committedThroughEventSeq);
    expect({committed: run.tally.committed, duplicate: run.tally.duplicate, covered: run.tally.covered, conflict: run.tally.conflict})
      .toEqual({committed: expected.coverage.committed, duplicate: expected.coverage.duplicate, covered: expected.coverage.covered, conflict: 0});
    expect(await storedRows(ws, SEED)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    // Only the temporary synthetic database was written: no history file under the workspace used as LOCALAPPDATA.
    expect(readOnly(ws.database, db => db.prepare('SELECT purpose FROM database_info WHERE id = 1').pluck().get())).toBe('synthetic');
    expect([existsSync(path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite')), existsSync(path.join(ws.directory, 'data', 'telemetry.sqlite'))]).toEqual([false, false]);
  }, 90_000);
});
