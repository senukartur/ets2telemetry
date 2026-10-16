// S2 (ET-015a PR-2): V1Ingestion with TripRecorderSink and the bundled storage worker under the pinned Electron runtime,
// against the reactive v1 simulator on actual Windows pipes, unpaced, into a temporary synthetic-purpose database. The
// stored trips, attributions and completeness intervals must equal the rows of the hand-written
// tests/fixtures/simulator-v1/<id>.trip.expected.json, which ET-014 wrote for the lockstep replay; every ACK must be at or
// below the storage coverage reported when it was written, and the recorder's final view must equal the file's `view`
// block (REG-001, REG-003, REG-004, REG-005, REG-006).
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveDifferences} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {expectedPath, scenarioPath} from '../shared/simulator-v1-expected';
import {ok, workspace} from './helpers';
import {replayOf, runRecording, storedRows, terminateWorkers, tripExpected, viewSummary} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

const SCENARIOS = ['normal-delivery', 'save-load', 'reconnect-lost-ack', 'app-absent-hydration', 'retention-expired', 'timers-truck-refuel', 'ferry-train', 'sleep-teleport',
  'quick-job-profile-change', 'clock-change-suspend'];

describe('S2 trip recorder through the real storage worker against the reactive simulator', () => {
  for (const id of SCENARIOS) it(`records ${id} as its hand-written trip expectation, acknowledging only committed coverage`, async () => {
    const input = readFixtureFile(scenarioPath(id)) as Json, replay = replayOf(input);
    const {report, services, tally, acks} = await runRecording(input, {path: ws.database, backups: ws.backups});
    // The served stream is the replayed one, so the lockstep trip expectation applies to this consumer.
    expect(reactiveDifferences(replay, report)).toEqual([]);
    for (const service of services) {
      expect(await service.client.close()).toEqual({clean: true});
      expect(service.states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
    }
    const expected = tripExpected(id), session = scenarioSource(replay.scenario).pluginSessionId;
    // Every ACK handed to the pipe was at or below the coverage storage had reported (REG-005, REG-006).
    for (const ack of acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
    // The wire expectation's client ledger, where it lists one; some scenarios list only the producer store.
    const ledger = (JSON.parse(readFileSync(expectedPath(id), 'utf8')) as {ledger?: {committedThroughEventSeq: string}}).ledger;
    expect({committedThroughEventSeq: tally.coverage.toString(), committed: tally.committed, duplicate: tally.duplicate, covered: tally.covered}).toEqual(expected.coverage);
    if (ledger) expect(tally.coverage.toString()).toBe(ledger.committedThroughEventSeq);
    const reader = await ws.open(); expect(ok(reader.committedThrough(session))).toBe(expected.coverage.committedThroughEventSeq); reader.close();
    expect(await storedRows(ws, replay.scenario.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    // The recorder's own adopted state: the hand-written view of the scenario's game (one service, no restart).
    expect(services).toHaveLength(1);
    expect(viewSummary(services[0].recorder.view(replay.scenario.game), replay.scenario.seed)).toEqual(expected.view);
  }, 90_000);
});
