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

describe('late-attach trips through the real storage worker (ET-016 PR-7, J9)', () => {
  it('opens one late-attach trip and, after a service restart, resumes it instead of opening a second one', async () => {
    // A job accepted and a start while no client is connected (offline gap 1-2), a client from 100 to 200 ms, a service
    // restart, and a second client from 300 ms that receives the identical job configuration at 350 ms.
    const base = readFixtureFile(scenarioPath('app-absent-hydration')) as Json;
    const jobAttributes = (base.steps as Json[])[1].attributes;
    const input = {...base, id: 'late-attach-restart', seed: 'et016-late-attach-restart', steps: [
      {atMs: 10, action: 'configuration', id: 'job', attributes: jobAttributes}, {atMs: 20, action: 'lifecycle', event: 'simulation.started'},
      {atMs: 30, action: 'frame', channels: {speed: 20}}, {atMs: 350, action: 'configuration', id: 'job', attributes: jobAttributes}, {atMs: 360, action: 'frame', channels: {speed: 21}}],
      transport: [{atMs: 100, action: 'connect', client: {durable: true}}, {atMs: 200, action: 'disconnect'}, {atMs: 300, action: 'connect', client: {durable: true}},
        {atMs: 400, action: 'disconnect'}]};
    const {services, tally} = await runRecording(input, {path: ws.database, backups: ws.backups}, {restartAfter: [0]});
    expect(services).toHaveLength(2);
    for (const service of services) {
      expect(await service.client.close()).toEqual({clean: true});
      expect(service.states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
    }
    // Hand-written rows: the checkpoint at 100 ms (nextEventSeq 3) opens attach@3 after the gap 1-2, starting at the label of
    // the frame at 30 ms. The restarted service seeds it with the checkpoint job's key, so its checkpoint at 300 ms opens
    // nothing (RED: a second trip after a service restart) and the identical re-send (3) is the same job: it carries only
    // the resumed trip's queued consumer-restart interval.
    const expected = {
      trips: [{trip: 'attach@3', jobConfigurationEventSeq: null, truckConfigurationEventSeq: null, trailerConfigurationEventSeqs: [], openedEventSeq: null,
        gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', outcomeEventSeq: null, closeReason: null,
        recordingCompleteness: 'partial', startedUtcMs: 1_800_000_000_030, endedUtcMs: null,
        observedDistanceM: {available: false, reason: 'not-observed'}, fuelUsedL: {available: false, reason: 'not-observed'}}],
      attributions: [],
      intervals: [
        {trip: null, kind: 'not-connected', firstEventSeq: '1', lastEventSeq: '2', startMonotonicNs: '1000010000000', endMonotonicNs: '1000020000000', sourceClockId: 'capture-clock',
          detail: {cause: 'gap', causes: {offline: '2', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'},
            firstEventSeq: '1', lastEventSeq: '2', redelivered: false}},
        {trip: 'attach@3', kind: 'not-connected', detail: {cause: 'late-attach', source: 'checkpoint', nextEventSeq: '3'}},
        {trip: 'attach@3', kind: 'not-connected', detail: {cause: 'consumer-restart'}}]
    };
    expect(await storedRows(ws, input.seed)).toEqual(expected);
    expect({coverage: tally.coverage.toString(), committed: tally.committed}).toEqual({coverage: '3', committed: 2});
    expect(viewSummary(services[1].recorder.view('ets2'), input.seed)).toMatchObject({phase: 'active', untrackedJob: false, current: {trip: 'attach@3', recordingCompleteness: 'partial'}});
  }, 90_000);
});
