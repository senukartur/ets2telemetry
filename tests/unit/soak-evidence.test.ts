import {describe, expect, it} from 'vitest';
import {
  checkTail, databaseGrowth, leakTrend, listDifferences, logBudget, reconnectCycles, seriesSummary, soakExpectation, soakSessionId, summarizeSoakMetrics, tripUuidOf
} from '../../scripts/ci/soak-evidence.mjs';
import {tripUuidFor} from '../../packages/telemetry-core/src';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';

// ET-019 PR-12b: the application soak's oracle (scripts/ci/soak-evidence.mjs). Every value below is written by hand from
// the schedule table in docs/simulator-v1.md#soak-source-et-019-pr-12a, the frame values there, the clocks of the
// simulator guide (source time 10^12 ns + atMs × 10^6, UTC 1.8 × 10^12 ms + atMs) and docs/trips.md (T4, T13, T14, T16,
// R17 and the one-second sampler), never produced by the expectation it checks.
const UTC = 1_800_000_000_000;
const SPEED = 19.53125;
/** Odometer in metres at a frame time: 1,000 km + atMs / 50 frames × 1,000 / 1,024 m. */
const odometer = (atMs: number) => 1_000_000 + (atMs / 50) * 0.9765625;
/**
 * A sample from the frame at `atMs`. Its time is the snapshot message's capture time: the frame's own time on the first
 * connection, 25 ms later after a reconnection, whose checkpoint at b + 38,025 starts the 50 ms snapshot interval anew.
 */
const sample = (second: number, trip: string | null, atMs: number, delayMs = 0) => ({second: String(second), trip,
  monotonicNs: `${1_000_000_000_000 + (atMs + delayMs) * 1_000_000}`, utcMs: UTC + atMs, speedMps: SPEED, odometerM: odometer(atMs)});
/** Cycle 0 of every run: second 0 from frame 50 (the checkpoint at 0 is the baseline), 21..29 paused, 30 from frame 30,050, the trip through 45. */
const CYCLE_0 = [sample(1000, 'trip@4', 50), ...Array.from({length: 20}, (_, i) => sample(1001 + i, 'trip@4', (1 + i) * 1000)), sample(1030, 'trip@4', 30_050),
  ...Array.from({length: 15}, (_, i) => sample(1031 + i, 'trip@4', (31 + i) * 1000)), ...Array.from({length: 14}, (_, i) => sample(1046 + i, null, (46 + i) * 1000))];

describe('soak expectation', () => {
  it('writes one minute by hand: 9 events, one complete delivered trip and 51 samples', () => {
    const e = soakExpectation(1);
    expect(e.counts).toEqual({events: 9, trips: 1, cancelled: 0, partial: 0, attributions: 2, intervals: 0, cycleSamples: 51});
    expect(e.events).toEqual([
      {eventSeq: '1', type: 'simulation.started', utcMs: UTC + 25}, {eventSeq: '2', type: 'truck.configured', utcMs: UTC + 25},
      {eventSeq: '3', type: 'trailer.configured', utcMs: UTC + 25}, {eventSeq: '4', type: 'job.configured', utcMs: UTC + 25},
      {eventSeq: '5', type: 'player.tollgate.paid', utcMs: UTC + 5_025}, {eventSeq: '6', type: 'simulation.paused', utcMs: UTC + 20_025},
      {eventSeq: '7', type: 'simulation.started', utcMs: UTC + 30_025}, {eventSeq: '8', type: 'job.delivered', utcMs: UTC + 45_025},
      {eventSeq: '9', type: 'job.cleared', utcMs: UTC + 45_525}]);
    // 899 counted steps of 0.9765625 m and 1/4,096 L, from frame 50 to frame 45,000.
    expect(e.trips).toEqual([{trip: 'trip@4', openedBy: 'event', openedEventSeq: '4', jobConfigurationEventSeq: '4', truckConfigurationEventSeq: '2', trailerConfigurationEventSeqs: ['3'],
      outcome: 'delivered', outcomeEventSeq: '8', closeReason: 'outcome', recordingCompleteness: 'complete', startedUtcMs: UTC + 25, endedUtcMs: UTC + 45_025,
      observedDistanceM: {available: true, value: 877.9296875}, fuelUsedL: {available: true, value: 0.219482421875}}]);
    expect(e.attributions).toEqual([{eventSeq: '5', trip: 'trip@4', attribution: 'trip'}, {eventSeq: '8', trip: 'trip@4', attribution: 'trip'}]);
    expect(e.intervals).toEqual([]);
    expect(e.cycleSamples).toEqual(CYCLE_0);
    expect(e.cycleSamples.filter(s => s.trip === 'trip@4')).toHaveLength(37);
    expect({coverage: e.coverage, gaps: e.gaps, tailFromSecond: e.tailFromSecond, connections: e.connections, closes: e.closes, losses: e.losses}).toEqual({coverage: '9', gaps: 0,
      tailFromSecond: 1060, connections: 1, closes: ['end'], losses: {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}});
  });

  it('writes three minutes by hand: the reconnect in cycle 1 and the cancellation in cycle 2', () => {
    const e = soakExpectation(3);
    expect(e.counts).toEqual({events: 21, trips: 3, cancelled: 1, partial: 1, attributions: 6, intervals: 1, cycleSamples: 151});
    expect(e.events.slice(9).map(row => [row.eventSeq, row.type, row.utcMs - UTC])).toEqual([
      ['10', 'job.configured', 60_025], ['11', 'player.tollgate.paid', 65_025], ['12', 'simulation.paused', 80_025], ['13', 'simulation.started', 90_025],
      ['14', 'job.delivered', 105_025], ['15', 'job.cleared', 105_525], ['16', 'job.configured', 120_025], ['17', 'player.tollgate.paid', 125_025],
      ['18', 'simulation.paused', 140_025], ['19', 'simulation.started', 150_025], ['20', 'job.cancelled', 165_025], ['21', 'job.cleared', 165_525]]);
    // Cycle 1 counts 699 steps before the disconnection and 140 after the checkpoint at 98,000: 839.
    expect(e.trips.map(t => [t.trip, t.outcome, t.outcomeEventSeq, t.recordingCompleteness, t.startedUtcMs - UTC, t.endedUtcMs - UTC, t.observedDistanceM.value, t.fuelUsedL.value]))
      .toEqual([['trip@4', 'delivered', '8', 'complete', 25, 45_025, 877.9296875, 0.219482421875], ['trip@10', 'delivered', '14', 'partial', 60_025, 105_025, 819.3359375, 0.204833984375],
        ['trip@16', 'cancelled', '20', 'complete', 120_025, 165_025, 877.9296875, 0.219482421875]]);
    // 60 frames from 95,000 to 98,000.
    expect(e.intervals).toEqual([{trip: 'trip@10', kind: 'not-connected', detail: {cause: 'disconnected', odometerDeltaM: 58.59375}}]);
    expect(e.attributions.map(a => [a.eventSeq, a.trip])).toEqual([['5', 'trip@4'], ['8', 'trip@4'], ['11', 'trip@10'], ['14', 'trip@10'], ['17', 'trip@16'], ['20', 'trip@16']]);
    // Cycle 1: second 60 precedes the job at 60,025; 81..89 paused; 96 and 97 offline; 98 from the reconnection's checkpoint
    // (frame 98,000, sent at 98,025), and every later sample 25 ms after its frame.
    const cycle1 = [sample(1060, null, 60_000), ...[...Array(20).keys()].map(i => sample(1061 + i, 'trip@10', (61 + i) * 1000)), sample(1090, 'trip@10', 90_050),
      ...[91, 92, 93, 94, 95].map(s => sample(1000 + s, 'trip@10', s * 1000)), ...[98, 99, 100, 101, 102, 103, 104, 105].map(s => sample(1000 + s, 'trip@10', s * 1000, 25)),
      ...[...Array(14).keys()].map(i => sample(1106 + i, null, (106 + i) * 1000, 25))];
    expect(e.cycleSamples.slice(51, 100)).toEqual(cycle1);
    expect(e.cycleSamples[100]).toEqual(sample(1120, null, 120_000, 25));
    // Cycle 2 keeps seconds 0..20, so its second 30 is the 22nd row: frame 150,050, sent at 150,075.
    expect(e.cycleSamples[121]).toEqual(sample(1150, 'trip@16', 150_050, 25));
    expect(e.cycleSamples.at(-1)).toEqual(sample(1179, null, 179_000, 25));
    expect({tailFromSecond: e.tailFromSecond, connections: e.connections, closes: e.closes, notConnected: e.losses.notConnected})
      .toEqual({tailFromSecond: 1180, connections: 2, closes: ['disconnect', 'end'], notConnected: 1});
  });

  it('keeps the closed forms for thirty minutes and the bounds of the length', () => {
    const e = soakExpectation(30);
    // Reconnects in cycles 1, 11 and 21; cancellations in 2, 6, 10, 14, 18, 22 and 26.
    expect(e.counts).toEqual({events: 183, trips: 30, cancelled: 7, partial: 3, attributions: 60, intervals: 3, cycleSamples: 1_524});
    expect(e.trips.filter(t => t.outcome === 'cancelled').map(t => t.trip)).toEqual(['trip@16', 'trip@40', 'trip@64', 'trip@88', 'trip@112', 'trip@136', 'trip@160']);
    expect(e.trips.filter(t => t.recordingCompleteness === 'partial').map(t => t.trip)).toEqual(['trip@10', 'trip@70', 'trip@130']);
    expect({coverage: e.coverage, tailFromSecond: e.tailFromSecond, connections: e.connections, closes: e.closes})
      .toEqual({coverage: '183', tailFromSecond: 2800, connections: 4, closes: ['disconnect', 'disconnect', 'disconnect', 'end']});
    expect([1, 2, 10, 11, 12, 90].map(reconnectCycles)).toEqual([0, 1, 1, 1, 2, 9]);
    expect(soakExpectation(90).counts).toEqual({events: 543, trips: 90, cancelled: 22, partial: 9, attributions: 180, intervals: 9, cycleSamples: 4_572});
    for (const minutes of [0, 91, 1.5]) expect(() => soakExpectation(minutes)).toThrow('Soak minutes must be an integer 1..90');
  });

  it('derives the plugin session and trip UUIDs from their documented hashes', () => {
    // SHA-256 of `simulator-v1:soak-v1:plugin-session` and of `ets2telemetry-trip-v1:<session>:<eventSeq>`, first 128 bits as
    // 8-4-4-4-12; the same values as the simulator's seeded identity and telemetry-core's own SHA-256 (T4).
    expect(soakSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(soakSessionId()).toBe(scenarioSource({game: 'ets2', seed: 'soak-v1'}).pluginSessionId);
    for (const eventSeq of ['4', '10', '16']) expect(tripUuidOf(soakSessionId(), eventSeq)).toBe(tripUuidFor(soakSessionId(), eventSeq));
    expect(tripUuidOf(soakSessionId(), 4)).toBe(tripUuidOf(soakSessionId(), '4'));
  });
});

describe('soak tail and differences', () => {
  const tail = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => ({second: String(from + i), trip: null}));
  it('accepts a contiguous tail through the second of the last delivered frame', () => {
    expect(checkTail(tail(1060, 1071), {fromSecond: 1060, stopScenarioMs: 71_400, minimumSeconds: 10})).toEqual({fromSecond: 1060, lastSecond: 1071, samples: 12,
      expectedLastSecond: [1071, 1071], problems: []});
    // A stop within 100 ms after a second boundary may leave that second's frame undelivered.
    expect(checkTail(tail(1060, 1070), {fromSecond: 1060, stopScenarioMs: 71_050, minimumSeconds: 10}).problems).toEqual([]);
  });
  it('names a missing, late, short or trip-bound tail', () => {
    const missing = [...tail(1060, 1064), ...tail(1066, 1071)];
    expect(checkTail(missing, {fromSecond: 1060, stopScenarioMs: 71_400, minimumSeconds: 10}).problems[0]).toBe('tail second 1066 at position 5, expected 1065');
    expect(checkTail(tail(1060, 1069), {fromSecond: 1060, stopScenarioMs: 71_400, minimumSeconds: 10}).problems).toEqual(['last tail second 1069, expected 1071..1071']);
    expect(checkTail(tail(1060, 1065), {fromSecond: 1060, stopScenarioMs: 65_400, minimumSeconds: 10}).problems).toEqual(['6 tail samples, expected at least 10']);
    expect(checkTail([{second: '1060', trip: 'trip@4'}], {fromSecond: 1060, stopScenarioMs: 60_500, minimumSeconds: 1}).problems).toEqual(['a tail sample names a trip']);
  });
  it('lists the first differing, missing and extra rows', () => {
    expect(listDifferences('rows', [1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(listDifferences('rows', [1, 5], [1, 2, 3])).toEqual(['rows[1] is 5, expected 2', 'rows[2] missing: 3', 'rows: 2 rows, expected 3']);
    expect(listDifferences('rows', [1, 2, 4], [1, 2])).toEqual(['rows[2] unexpected: 4', 'rows: 3 rows, expected 2']);
  });
});

describe('soak evidence', () => {
  it('fits the memory trend after the warm-up and needs six points', () => {
    // Every 30 s for ten minutes, growing by 10 bytes per ms: 36,000,000 bytes per hour. The warm-up is five minutes.
    const points = Array.from({length: 21}, (_, i) => ({elapsedMs: i * 30_000, bytes: 100_000_000 + i * 300_000}));
    expect(leakTrend(points, {plannedMs: 600_000})).toEqual({status: 'MEASURED', warmUpMs: 300_000, points: 11, fromMs: 300_000, toMs: 600_000, slopeBytesPerHour: 36_000_000, r2: 1,
      quarterMeansBytes: [103_150_000, 103_900_000, 104_800_000, 105_700_000]});
    const flat = points.map(p => ({...p, bytes: 5}));
    expect(leakTrend(flat, {plannedMs: 600_000})).toMatchObject({status: 'MEASURED', slopeBytesPerHour: 0, r2: 1});
    // Thirty planned minutes warm up for six (20%); three minutes leave nothing after five.
    expect(leakTrend(points, {plannedMs: 1_800_000})).toEqual({status: 'MEASURED', warmUpMs: 360_000, points: 9, fromMs: 360_000, toMs: 600_000, slopeBytesPerHour: 36_000_000, r2: 1,
      quarterMeansBytes: [103_750_000, 104_350_000, 104_950_000, 105_700_000]});
    expect(leakTrend(points.slice(0, 15), {plannedMs: 180_000})).toEqual({status: 'TOO_FEW_POINTS', warmUpMs: 300_000, points: 5});
  });
  it('sums Electron metrics per kind in bytes and summarizes the series', () => {
    const kinds = summarizeSoakMetrics([{type: 'Browser', name: null, serviceName: null, workingSetKiB: 100, privateKiB: 50},
      {type: 'Tab', name: null, serviceName: null, workingSetKiB: 10, privateKiB: 20}, {type: 'Tab', name: null, serviceName: null, workingSetKiB: 30, privateKiB: null}],
    metric => metric.type === 'Browser' ? 'main' : 'renderer');
    expect(kinds).toEqual({main: {processes: 1, workingSetBytes: 102_400, privateBytes: 51_200}, renderer: {processes: 2, workingSetBytes: 40_960, privateBytes: 20_480}});
    const series = [0, 30_000, 60_000].map((elapsedMs, i) => ({elapsedMs, kinds: {main: {processes: 1, workingSetBytes: 10 + i, privateBytes: [7, 3, 5][i]}}}));
    expect(seriesSummary(series, {plannedMs: 60_000})).toEqual({main: {points: 3, processes: {min: 1, max: 1}, privateBytes: {first: 7, min: 3, max: 7, last: 5},
      workingSetBytes: {first: 10, min: 10, max: 12, last: 12}, trend: {status: 'TOO_FEW_POINTS', warmUpMs: 300_000, points: 0}}});
  });
  it('projects a log to ninety minutes and flags a reached budget', () => {
    // 10,000 bytes and 50 records before the soak, 40,000 and 250 in its three minutes: thirty times that in ninety.
    expect(logBudget({bytes: 50_000, records: 300, soakBytes: 40_000, soakRecords: 250, soakMs: 180_000})).toEqual({bytes: 50_000, records: 300, budgetBytes: 262_144,
      budgetRecords: 2_000, reached: false, soak: {bytes: 40_000, records: 250, ms: 180_000},
      projected: {minutes: 90, bytes: 1_210_000, records: 7_550, headroomBytes: -947_856, headroomRecords: -5_550, wouldReach: true}});
    expect(logBudget({bytes: 20_000, records: 100, soakBytes: 1_000, soakRecords: 10, soakMs: 5_400_000}).projected)
      .toEqual({minutes: 90, bytes: 20_000, records: 100, headroomBytes: 242_144, headroomRecords: 1_900, wouldReach: false});
    expect(logBudget({bytes: 253_953, records: 10, soakBytes: 0, soakRecords: 0, soakMs: 1}).reached).toBe(true);
    expect(logBudget({bytes: 253_952, records: 1_999, soakBytes: 0, soakRecords: 0, soakMs: 1}).reached).toBe(false);
    expect(logBudget({bytes: 1_000, records: 2_000, soakBytes: 0, soakRecords: 0, soakMs: 1}).reached).toBe(true);
  });
  it('relates the database size to the measured 534,364 bytes per sample-hour and the allowance', () => {
    expect(databaseGrowth({databaseBytes: 1_069_056, samples: 7_200})).toEqual({databaseBytes: 1_069_056, samples: 7_200, bytesPerSampleHour: 534_528,
      measuredBytesPerSampleHour: 534_364, ratioToMeasured: 1, allowanceBytesPerSampleHour: 1_000_000, ratioToAllowance: 0.535});
    expect(databaseGrowth({databaseBytes: 4_096, samples: 0}).bytesPerSampleHour).toBeNull();
  });
});
