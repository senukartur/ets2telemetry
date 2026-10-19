import {it, expect} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

// ET-019 PR-12b: Test-SoakReceipt in scripts/ci/RuntimeReceipt.ps1, through the production Test-RuntimeReceipt in one
// Windows PowerShell 5.1 batch (tests/shared/runtime-receipt-validator.ts). The intact receipt is a three-minute soak
// written by hand from the schedule's closed forms (docs/simulator-v1.md): 21 events, three trips (one cancelled, one
// partial), one reconnection, 151 cycle samples and a tail of 13. Each other case corrupts one field and must fail with
// SOAK_RESULT_INCOMPLETE_OR_INVALID; the soak tightens no other scenario.
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
const REASON = 'SOAK_RESULT_INCOMPLETE_OR_INVALID';

const kinds = (renderer: number): Json => ({main: {processes: 1, workingSetBytes: 116_449_280, privateBytes: 76_517_376}, gpu: {processes: 1, workingSetBytes: 101_896_192,
  privateBytes: 114_184_192}, telemetryService: {processes: 1, workingSetBytes: 87_941_120, privateBytes: 84_430_848},
renderer: {processes: 2, workingSetBytes: 256_626_688, privateBytes: renderer}});
const row = (elapsedMs: number, scenarioMs: number | null, recording: string, renderer: number): Json => ({elapsedMs, scenarioMs, lastEventSeq: scenarioMs === null ? null : '12',
  ackThrough: scenarioMs === null ? null : '12', snapshots: 1791, connections: 1, refusedLiveOnly: 1, sourceHeapBytes: 8_248_240, mainProbeMs: 2, rendererProbeMs: 1, recording,
  recordingCode: null, databaseBytes: 4096, walBytes: 704_552, kinds: kinds(renderer)});
const range = (first: number, min: number, max: number, last: number): Json => ({first, min, max, last});
const kindSummary = (processes: number): Json => ({points: 2, processes: {min: processes, max: processes}, privateBytes: range(1, 1, 2, 2), workingSetBytes: range(1, 1, 2, 2),
  trend: {status: 'TOO_FEW_POINTS', warmUpMs: 300_000, points: 0}});
const log = (bytes: number, records: number, soakBytes: number, soakRecords: number): Json => ({bytes, records, budgetBytes: 262_144, budgetRecords: 2_000, reached: false,
  soak: {bytes: soakBytes, records: soakRecords, ms: 189_684},
  projected: {minutes: 90, bytes: 123_325, records: 420, headroomBytes: 138_819, headroomRecords: 1_580, wouldReach: false}});

function soakReceipt(): Json {
  return {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'soak', launcherExit: 0, probesAfterExit: [],
    mainEvents: [{event: 'APP_START'}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}],
    serviceEvents: [{event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}, {event: 'STORAGE_VERIFIED'},
      {event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 2, created: true, migratedFrom: null}},
      ...['ingestion', 'capture', 'v1-ingestion'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})),
      {event: 'V1_SAMPLES_EXIT', facts: {rows: 5, losses: 0, code: 'WRITTEN'}}, ...['recording-flush', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})),
      {event: 'HISTORY_STORAGE_CLOSED'}, {event: 'SHUTDOWN_STEP', facts: {name: 'history-storage', outcome: 'ok'}}, {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}],
    soak: {minutes: 3, target: 'synthetic:soak', recordingStatusMatch: true, journalMatch: true, sourceStopped: true, logBudgetKept: true, shutdownClean: true, sourceMatch: true,
      historyDatabaseAbsent: true, sidecarsAbsent: true, rowsMatch: true, invariantsHold: true,
      recordingAtTail: {state: 'recording', target: 'synthetic', code: null, losses: {lostEvents: 0, eventLoss: 0, notConnected: 1, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0},
        trip: {phase: 'idle', completeness: null, untrackedJob: false}},
      journal: {pages: [3], database: {purpose: 'synthetic', schemaVersion: 2}},
      sourceFacts: {cancelled: true, scenarioMs: 192_516, lastEventSeq: '21', maxAckThroughEventSeq: '21', ackCount: 21, snapshots: 3_789, connections: 2, refusedLiveOnly: 1,
        refusedClients: 0, events: 21, gaps: 0, ends: 1, closes: ['disconnect', 'end'], heapUsedBytes: 10_679_920, progressLines: 19, invalidLines: 0},
      files: {magic: 'SQLite format 3', applicationId: 1_163_154_226, userVersion: 2, sidecars: [], syntheticBackups: false, historyDatabase: false},
      database: {integrity: 'ok', foreignKeyViolations: 0, purpose: 'synthetic', acceptedOrigin: 'synthetic',
        counts: {events: 21, trips: 3, cancelled: 1, partial: 1, attributions: 6, intervals: 1, cycleSamples: 151, tailSamples: 13, gaps: 0},
        tail: {fromSecond: 1180, lastSecond: 1192, samples: 13, expectedLastSecond: [1192, 1192], problems: []}, differences: [], violations: 0},
      sampleExits: [{rows: 5, losses: 0, code: 'WRITTEN'}],
      logs: {main: log(6_804, 35, 4_242, 14), service: log(3_256, 25, 793, 5)},
      growth: {databaseBytes: 217_088, samples: 164, bytesPerSampleHour: 4_765_346, measuredBytesPerSampleHour: 534_364, ratioToMeasured: 8.918,
        allowanceBytesPerSampleHour: 1_000_000, ratioToAllowance: 4.765, walPeakBytes: 1_108_312},
      series: [row(6, null, 'waiting', 94_056_448), row(90_137, 89_575, 'recording', 125_468_672)],
      seriesSummary: {main: kindSummary(1), renderer: kindSummary(2), telemetryService: kindSummary(1), gpu: kindSummary(1)}}};
}
function corrupt(path: (string | number)[], replacement?: Json, value: Json = soakReceipt()): string {
  let target = value as Record<string | number, Json>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
  const last = path.at(-1)!;
  if (replacement === undefined) delete target[last]; else target[last] = replacement;
  return JSON.stringify(value);
}
/** A one-minute soak: 9 events, one complete trip, no reconnection, 51 cycle samples. */
function oneMinute(): string {
  const value = soakReceipt();
  const edits: [(string | number)[], Json][] = [[['soak', 'minutes'], 1], [['soak', 'sourceFacts', 'scenarioMs'], 79_700], [['soak', 'sourceFacts', 'lastEventSeq'], '9'],
    [['soak', 'sourceFacts', 'maxAckThroughEventSeq'], '9'], [['soak', 'sourceFacts', 'events'], 9], [['soak', 'sourceFacts', 'connections'], 1],
    [['soak', 'sourceFacts', 'closes'], ['end']], [['soak', 'recordingAtTail', 'losses', 'notConnected'], 0], [['soak', 'journal', 'pages'], [1]],
    [['soak', 'database', 'counts'], {events: 9, trips: 1, cancelled: 0, partial: 0, attributions: 2, intervals: 0, cycleSamples: 51, tailSamples: 20, gaps: 0}],
    [['soak', 'database', 'tail'], {fromSecond: 1060, lastSecond: 1079, samples: 20, expectedLastSecond: [1079, 1079], problems: []}], [['soak', 'growth', 'samples'], 71]];
  for (const [path, replacement] of edits) corrupt(path, replacement, value);
  return JSON.stringify(value);
}
const invalid = (name: string, path: (string | number)[], replacement?: Json) => ({name: `soak ${name}`, body: corrupt(path, replacement), scenario: 'soak', reason: REASON});

const cases: {name: string; body: string; scenario: string; reason: string | null; numbers?: 'int64'}[] = [
  {name: 'intact three-minute soak', body: JSON.stringify(soakReceipt()), scenario: 'soak', reason: null},
  {name: 'intact one-minute soak without a reconnection', body: oneMinute(), scenario: 'soak', reason: null},
  {name: 'intact soak without an exit flush row', body: corrupt(['soak', 'sampleExits'], []), scenario: 'soak', reason: null},
  {name: 'intact soak with PowerShell 7 Int64 integers', body: JSON.stringify(soakReceipt()), scenario: 'soak', reason: null, numbers: 'int64'},
  {name: 'soak with Int64 integers and the wrong sample count', body: corrupt(['soak', 'database', 'counts', 'cycleSamples'], 153), scenario: 'soak', reason: REASON, numbers: 'int64'},
  {name: 'soak receipt never hides a failed driver', body: corrupt(['passed'], false), scenario: 'soak', reason: 'DRIVER_FAILED'},
  {name: 'soak receipt cannot prove recording', body: JSON.stringify(soakReceipt()), scenario: 'recording', reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
  invalid('section missing', ['soak']),
  invalid('minutes out of range', ['soak', 'minutes'], 91),
  invalid('minutes fractional', ['soak', 'minutes'], 2.5),
  invalid('minutes not matching the counts', ['soak', 'minutes'], 4),
  invalid('rows not matched', ['soak', 'rowsMatch'], false),
  invalid('invariants not checked', ['soak', 'invariantsHold']),
  invalid('journal not matched', ['soak', 'journalMatch'], false),
  invalid('source not stopped by the driver', ['soak', 'sourceStopped'], false),
  invalid('recording status not matched', ['soak', 'recordingStatusMatch'], 'true'),
  invalid('another target', ['soak', 'target'], 'synthetic:smoke'),
  invalid('source not cancelled', ['soak', 'sourceFacts', 'cancelled'], false),
  invalid('source short of the last eventSeq', ['soak', 'sourceFacts', 'lastEventSeq'], '20'),
  invalid('an event not acknowledged', ['soak', 'sourceFacts', 'maxAckThroughEventSeq'], '20'),
  invalid('a redelivered event', ['soak', 'sourceFacts', 'events'], 22),
  invalid('a gap written', ['soak', 'sourceFacts', 'gaps'], 1),
  invalid('no end', ['soak', 'sourceFacts', 'ends'], 0),
  invalid('the last connection closed by the client', ['soak', 'sourceFacts', 'closes'], ['disconnect', 'client']),
  invalid('a write deadline instead of the disconnect', ['soak', 'sourceFacts', 'closes'], ['writeDeadline', 'end']),
  invalid('an extra connection', ['soak', 'sourceFacts', 'connections'], 3),
  invalid('stopped before the tail', ['soak', 'sourceFacts', 'scenarioMs'], 185_000),
  invalid('status interrupted in the tail', ['soak', 'recordingAtTail', 'state'], 'interrupted'),
  invalid('status with a lost event', ['soak', 'recordingAtTail', 'losses', 'lostEvents'], 1),
  invalid('status without the reconnection interval', ['soak', 'recordingAtTail', 'losses', 'notConnected'], 0),
  invalid('status with a dropped sample', ['soak', 'recordingAtTail', 'losses', 'droppedSamples'], 1),
  invalid('status with an open trip in the tail', ['soak', 'recordingAtTail', 'trip', 'phase'], 'active'),
  invalid('status with an untracked job', ['soak', 'recordingAtTail', 'trip', 'untrackedJob'], true),
  invalid('journal short of a trip', ['soak', 'journal', 'pages'], [2]),
  invalid('journal from another database', ['soak', 'journal', 'database', 'purpose'], 'history'),
  invalid('integrity not ok', ['soak', 'database', 'integrity'], 'corrupt'),
  invalid('a foreign key violation', ['soak', 'database', 'foreignKeyViolations'], 1),
  invalid('an invariant violation', ['soak', 'database', 'violations'], 1),
  invalid('a row difference', ['soak', 'database', 'differences'], ['cycle samples[78] differs']),
  invalid('a missing event', ['soak', 'database', 'counts', 'events'], 20),
  invalid('an extra trip', ['soak', 'database', 'counts', 'trips'], 4),
  invalid('no cancellation', ['soak', 'database', 'counts', 'cancelled'], 0),
  invalid('no partial trip', ['soak', 'database', 'counts', 'partial'], 0),
  invalid('a missing attribution', ['soak', 'database', 'counts', 'attributions'], 5),
  invalid('an extra interval', ['soak', 'database', 'counts', 'intervals'], 2),
  invalid('a paused sample', ['soak', 'database', 'counts', 'cycleSamples'], 152),
  invalid('a gap row', ['soak', 'database', 'counts', 'gaps'], 1),
  invalid('a tail of nine samples', ['soak', 'database', 'counts', 'tailSamples'], 9),
  invalid('a tail problem', ['soak', 'database', 'tail', 'problems'], ['tail second 1186 at position 5, expected 1185']),
  invalid('a tail that does not end at its last sample', ['soak', 'database', 'tail', 'lastSecond'], 1191),
  invalid('a history database', ['soak', 'files', 'historyDatabase'], true),
  invalid('a WAL file left', ['soak', 'files', 'sidecars'], ['-wal']),
  invalid('an exit flush that lost rows', ['soak', 'sampleExits', 0, 'losses'], 1),
  invalid('an exit flush that failed', ['soak', 'sampleExits', 0, 'code'], 'IO_ERROR'),
  invalid('main log reached its budget', ['soak', 'logs', 'main', 'reached'], true),
  invalid('service log at 2,000 records', ['soak', 'logs', 'service', 'records'], 2000),
  invalid('a log projection missing', ['soak', 'logs', 'main', 'projected']),
  invalid('growth in KiB', ['soak', 'growth', 'databaseBytes'], 212),
  invalid('growth for another sample count', ['soak', 'growth', 'samples'], 151),
  invalid('growth against another reference', ['soak', 'growth', 'measuredBytesPerSampleHour'], 534_000),
  invalid('a single probe', ['soak', 'series'], [row(6, null, 'waiting', 94_056_448)]),
  invalid('a probe without the telemetry service', ['soak', 'series', 1, 'kinds', 'telemetryService']),
  invalid('a probe in KiB', ['soak', 'series', 1, 'kinds', 'main', 'privateBytes'], 74_724),
  invalid('a trend with an unknown status', ['soak', 'seriesSummary', 'renderer', 'trend', 'status'], 'LEAK'),
  invalid('another exit request', ['mainEvents', 1, 'facts', 'reason'], 'tray'),
  invalid('an unclean stop', ['serviceEvents', 11, 'detail', 'clean'], false),
  invalid('a leftover probe', ['probesAfterExit'], ['ets2telemetry-probe-1'])
];

it('requires the soak receipt to match the closed forms of the schedule', async () => {
  const resources = await temporaryResources();
  try {
    const receipts = cases.map((_, index) => path.join(resources.directory, `soak-receipt-${index}.json`));
    for (const [index, scenario] of cases.entries()) await writeFile(receipts[index], scenario.body);
    const results = await validateRuntimeReceipts(resources.directory, cases.map((scenario, index) =>
      ({receipt: receipts[index], code: 0, scenario: scenario.scenario, ...(scenario.numbers ? {numbers: scenario.numbers} : {})})));
    for (const [index, scenario] of cases.entries()) {
      expect(results[index], scenario.name).toMatchObject({passed: scenario.reason === null, driverResultAvailable: true, reason: scenario.reason});
      expect(await readFile(receipts[index], 'utf8'), scenario.name).toBe(scenario.body);
    }
  } finally {await resources.dispose();}
}, receiptBatchTimeout(cases.length) + 5000);
