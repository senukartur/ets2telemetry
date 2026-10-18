// ET-019 finding F1 (stale checkpoints, docs/trips.md): V1Ingestion with TripRecorderSink and the bundled storage worker
// against the reactive v1 simulator on actual Windows pipes, into a temporary synthetic-purpose database. The checkpoint
// of the second connection carries the state of the last frame (OD-5 S7), which still shows the job that the replayed
// events deliver and clear. Before the fix, the recorder stored a late-attach trip for that finished job, open and
// partial, and attributed the live fine to it. The rows must equal the hand-written
// tests/fixtures/recording/normal-delivery-stale-checkpoint.rows.expected.json. Runs under npm run test:storage; it is a
// file of its own because ET-019 extends tests/storage/trip-recorder-crash.test.ts.
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {reactiveDifferences} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {staleCheckpointExpected, staleCheckpointScenario} from '../shared/stale-checkpoint';
import {ok, readOnly, workspace} from './helpers';
import {replayOf, runRecording, storedRows, terminateWorkers, viewSummary} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

describe('stale checkpoint through the real storage worker (ET-019 F1)', () => {
  it('stores no late-attach trip for the job the replayed events delivered and cleared', async () => {
    const input = staleCheckpointScenario(), replay = replayOf(input), seed = input.seed as string, session = scenarioSource(replay.scenario).pluginSessionId;
    const {report, services, tally, acks} = await runRecording(input, {path: ws.database, backups: ws.backups});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(services).toHaveLength(1);
    expect(await services[0].client.close()).toEqual({clean: true});
    expect(services[0].states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
    // Every ACK handed to the pipe was at or below the coverage storage had reported (REG-005).
    for (const ack of acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
    const expected = staleCheckpointExpected();
    expect({committedThroughEventSeq: tally.coverage.toString(), committed: tally.committed, duplicate: tally.duplicate, covered: tally.covered}).toEqual(expected.coverage);
    const reader = await ws.open(); expect(ok(reader.committedThrough(session))).toBe(expected.coverage.committedThroughEventSeq); reader.close();
    // The live fine (10) is committed after the replay drained, so the attach decision preceded its commit.
    expect(await storedRows(ws, seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    // No checkpoint job configuration was stored (openAttachedTrip never ran).
    expect(readOnly(ws.database, db => db.prepare(`SELECT count(*) FROM job_configurations WHERE source = 'checkpoint'`).pluck().get())).toBe(0);
    expect(viewSummary(services[0].recorder.view('ets2'), seed)).toEqual(expected.view);
  }, 90_000);
});
