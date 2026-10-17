import {it, expect} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

// The index that appends a row to run A's lifecycle main events; ET-011b added three settings rows after the original four.
const MAIN_EVENTS_APPEND = 7;
// ET-015a recording receipts: run A has the terminated service (pid 4100) and its replacement (4200), run B one service
// (4300). The index of run A's recording-flush step, and the index that appends a row to run A's service events.
const RECORDING_FLUSH_A = 11;
const SERVICE_EVENTS_A_APPEND = 16;
// The index that appends a row to run B's service events (ET-015b PR-4).
const RUN_B_SERVICE_EVENTS_APPEND = 12;
const cases = [
  {name: 'missing despite exit zero', body: undefined, code: 0, available: false, reason: 'DRIVER_RESULT_MISSING'},
  {name: 'missing after process failure', body: undefined, code: 1, available: false, reason: 'DRIVER_RESULT_MISSING'},
  {name: 'malformed JSON', body: '{invalid', code: 0, available: false, reason: 'DRIVER_RESULT_MALFORMED'},
  {name: 'nonboolean pass', body: JSON.stringify({passed: 'true'}), code: 0, available: false, reason: 'DRIVER_RESULT_MALFORMED'},
  {name: 'different commit', body: JSON.stringify({passed: true, commit: 'old', mode: 'packaged'}), code: 0, available: true, reason: 'DRIVER_RESULT_IDENTITY_MISMATCH'},
  {name: 'different mode', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'development'}), code: 0, available: true, reason: 'DRIVER_RESULT_IDENTITY_MISMATCH'},
  {name: 'driver failed', body: JSON.stringify({passed: false, commit: 'candidate', mode: 'packaged'}), code: 0, available: true, reason: 'DRIVER_FAILED'},
  {name: 'Job failure overrides driver success', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged'}), code: 125, available: true, reason: 'JOB_FAILED'},
  {name: 'normal intact success', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged'}), code: 0, available: true, reason: null},
  {name: 'scaffold receipt cannot prove telemetry', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'scaffold'}), scenario: 'telemetry', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
  {name: 'telemetry receipt missing scenario', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged'}), scenario: 'telemetry', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
  {name: 'matching telemetry scenario', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'telemetry'}), scenario: 'telemetry', code: 0, available: true, reason: null},
  ...lifecycleCases(),
  ...recordingCases(),
  ...journalCases()
];

// ET-011a lifecycle receipts: one intact receipt, then single-field corruptions that must each fail.
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
function lifecycleReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const orderlyMain = (): Json[] => [{event: 'APP_EXIT', detail: {code: 0}}, {event: 'SERVICE_EXIT', detail: {code: 0}}];
  const orderlyService = (): Json[] => [{event: 'STORAGE_VERIFIED'}, ...['ingestion', 'capture', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})),
    {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
  const reading = (speed: string, fuel: string) => ({source: 'ETS2', origin: 'synthetic', status: 'connected', freshness: 'current', speed, fuel});
  const value: Json = {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'lifecycle', launcherExit: 0, probesAfterExit: [],
    mainEvents: [...orderlyMain(), {event: 'SECOND_INSTANCE', facts: {action: 'created'}}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'renderer'}},
      // ET-011b settings diagnostics of run A; MAIN_EVENTS_APPEND below is the index after them.
      {event: 'SETTINGS_FALLBACK', facts: {state: 'invalid-file'}}, {event: 'SETTINGS_QUARANTINED', facts: {state: 'invalid-file'}},
      {event: 'SETTINGS_SAVED', facts: {game: 'ets2', profile: 'us-customary'}}],
    serviceEvents: orderlyService(),
    lifecycle: {dashboardClosedServiceAlive: true, overlayAliveAfterClose: true, trayPresentAfterClose: true, overlayCurrentAfterClose: true,
      sourceConnectionPreserved: true, secondInstanceRestoredDashboard: true, trayOpenRestoredDashboard: true, explicitExitOrderly: true,
      restartRecovered: true, shutdownClean: true, servicePid: 4100,
      afterClose: {servicePid: 4100, dashboard: false, exiting: false, overlay: true, tray: true, upstream: true},
      overlayChanged: reading('72.0', '71.0'), overlayRestored: reading('90.0', '73.0'),
      secondInstance: {pid: 4200, exitCode: 0, signal: null, exitMilliseconds: 164, wroteLog: false, primaryActions: ['created']},
      explicitExit: {launcherExit: 0, signal: null, exitMilliseconds: 179, requests: ['renderer']},
      restart: {servicePid: 4300, settingsState: 'loaded', dashboardUnits: {speed: 'Speed: 55.9 mph', fuel: 'Fuel: 19.3 US gal'}}, restartLauncherExit: 0,
      settingsSeededInvalidFile: true, settingsStartupUnchanged: true, settingsQuarantinePreserved: true, settingsSavedExact: true, unitsApplied: true,
      settingsRestartLoaded: true, settingsQuarantined: 1, dashboardUnits: {speed: 'Speed: 55.9 mph', fuel: 'Fuel: 19.3 US gal'},
      overlayUnits: {...reading('55.9', '19.3'), speedUnit: 'mph', fuelUnit: 'US gal'},
      restartMainEvents: [...orderlyMain(), {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SETTINGS_LOADED', facts: {state: 'loaded'}}],
      restartServiceEvents: orderlyService()}};
  if (path.length) {
    let target = value as Record<string | number, Json>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete target[last]; else target[last] = replacement;
  }
  return JSON.stringify(value);
}
// Clean late read (October 15, 2026): the intact receipt with one SETTINGS_LOAD_PENDING row before the first settings
// row of each run (index 4 in run A's main events, index 3 in run B's), then an optional corruption.
function pendingRow(): Json {return {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget'}};}
type LateReceipt = {mainEvents: Json[]; lifecycle: {restartMainEvents: Json[]}};
type LateCorruption = (value: LateReceipt) => void;
function lateLifecycleReceipt(corrupt?: LateCorruption): string {
  const value = JSON.parse(lifecycleReceipt()) as LateReceipt;
  value.mainEvents.splice(4, 0, pendingRow()); value.lifecycle.restartMainEvents.splice(3, 0, pendingRow());
  corrupt?.(value);
  return JSON.stringify(value);
}
function lifecycleCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `lifecycle ${name}`, body: lifecycleReceipt(path, replacement), scenario: 'lifecycle', code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'});
  return [
    {name: 'intact lifecycle receipt', body: lifecycleReceipt(), scenario: 'lifecycle', code: 0, available: true, reason: null},
    // Hosted run 38666784946: PowerShell 7 parses JSON integers as Int64, and `-isnot [int]` rejected an intact receipt.
    {name: 'intact lifecycle receipt with PowerShell 7 Int64 integers', body: lifecycleReceipt(), scenario: 'lifecycle', numbers: 'int64' as const, code: 0, available: true, reason: null},
    {name: 'lifecycle second instance exit 1 with Int64 integers', body: lifecycleReceipt(['lifecycle', 'secondInstance', 'exitCode'], 1), scenario: 'lifecycle', numbers: 'int64' as const, code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'},
    {name: 'lifecycle restart closed nonzero with Int64 integers', body: lifecycleReceipt(['lifecycle', 'restartLauncherExit'], 1), scenario: 'lifecycle', numbers: 'int64' as const, code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'},
    {name: 'scaffold receipt cannot prove lifecycle', body: lifecycleReceipt(['scenarioKind'], 'scaffold'), scenario: 'lifecycle', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    invalid('result missing', ['lifecycle']),
    invalid('flag missing', ['lifecycle', 'trayOpenRestoredDashboard']),
    invalid('flag false', ['lifecycle', 'dashboardClosedServiceAlive'], false),
    invalid('flag as string', ['lifecycle', 'restartRecovered'], 'true'),
    invalid('service replaced after close', ['lifecycle', 'afterClose', 'servicePid'], 4101),
    invalid('dashboard still open after close', ['lifecycle', 'afterClose', 'dashboard'], true),
    invalid('overlay gone after close', ['lifecycle', 'afterClose', 'overlay'], false),
    invalid('overlay not current after close', ['lifecycle', 'overlayChanged', 'freshness'], 'stale'),
    invalid('second instance exit 1', ['lifecycle', 'secondInstance', 'exitCode'], 1),
    invalid('second instance wrote a log', ['lifecycle', 'secondInstance', 'wroteLog'], true),
    invalid('second instance slower than 10 s', ['lifecycle', 'secondInstance', 'exitMilliseconds'], 10001),
    invalid('second instance ignored', ['lifecycle', 'secondInstance', 'primaryActions'], []),
    invalid('explicit exit slower than 8 s', ['lifecycle', 'explicitExit', 'exitMilliseconds'], 8001),
    invalid('explicit exit nonzero', ['lifecycle', 'explicitExit', 'launcherExit'], 1),
    invalid('explicit exit through another path', ['lifecycle', 'explicitExit', 'requests'], ['app-quit']),
    invalid('unclean service stop', ['serviceEvents', 4, 'detail', 'clean'], false),
    invalid('shutdown step timed out', ['serviceEvents', 1, 'facts', 'outcome'], 'timeout'),
    invalid('second application exit event', ['mainEvents', MAIN_EVENTS_APPEND], {event: 'APP_EXIT', detail: {code: 0}}),
    invalid('failure event', ['mainEvents', MAIN_EVENTS_APPEND], {event: 'SERVICE_START_FAILED'}),
    invalid('restart reused the service', ['lifecycle', 'restart', 'servicePid'], 4100),
    invalid('restart events missing', ['lifecycle', 'restartMainEvents']),
    invalid('restart closed nonzero', ['lifecycle', 'restartLauncherExit'], 1),
    invalid('probe left behind', ['probesAfterExit', 0], 'ets2telemetry-probe-x'),
    // ET-011b settings evidence.
    invalid('settings seed flag missing', ['lifecycle', 'settingsSeededInvalidFile']),
    invalid('startup changed the settings file', ['lifecycle', 'settingsStartupUnchanged'], false),
    invalid('quarantine not preserved', ['lifecycle', 'settingsQuarantinePreserved'], false),
    invalid('saved content not exact', ['lifecycle', 'settingsSavedExact'], 'true'),
    invalid('units not applied', ['lifecycle', 'unitsApplied'], false),
    invalid('restart flag missing', ['lifecycle', 'settingsRestartLoaded']),
    invalid('two quarantined files', ['lifecycle', 'settingsQuarantined'], 2),
    invalid('quarantine count as string', ['lifecycle', 'settingsQuarantined'], '1'),
    invalid('overlay still metric after the change', ['lifecycle', 'overlayUnits', 'speedUnit'], 'km/h'),
    invalid('overlay fuel not converted', ['lifecycle', 'overlayUnits', 'fuel'], '73.0'),
    invalid('overlay units stale', ['lifecycle', 'overlayUnits', 'freshness'], 'stale'),
    invalid('dashboard still metric after the change', ['lifecycle', 'dashboardUnits', 'speed'], 'Speed: 90.0 km/h'),
    invalid('restart dashboard back to metric', ['lifecycle', 'restart', 'dashboardUnits', 'fuel'], 'Fuel: 73.0 L'),
    invalid('restart settings not loaded', ['lifecycle', 'restart', 'settingsState'], 'defaults'),
    invalid('fallback row missing', ['mainEvents', 4], {event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}),
    invalid('fallback for another state', ['mainEvents', 4, 'facts', 'state'], 'loaded-with-fallbacks'),
    invalid('second save', ['mainEvents', MAIN_EVENTS_APPEND], {event: 'SETTINGS_SAVED', facts: {game: 'ats', profile: 'metric'}}),
    invalid('restart loaded another state', ['lifecycle', 'restartMainEvents', 3, 'facts', 'state'], 'defaults'),
    invalid('restart wrote settings', ['lifecycle', 'restartMainEvents', 4], {event: 'SETTINGS_SAVED', facts: {game: 'ets2', profile: 'us-customary'}}),
    // Clean late read: one leading pending row per run is accepted; anything else about it is not.
    {name: 'intact lifecycle receipt with late settings reads in both runs', body: lateLifecycleReceipt(), scenario: 'lifecycle', code: 0, available: true, reason: null},
    ...([
      ['two pending rows in run B', value => {value.lifecycle.restartMainEvents.splice(3, 0, pendingRow());}],
      ['pending row after the load in run B', value => {value.lifecycle.restartMainEvents.push(value.lifecycle.restartMainEvents.splice(3, 1)[0]);}],
      ['pending row after the fallback in run A', value => {value.mainEvents.splice(5, 0, value.mainEvents.splice(4, 1)[0]);}],
      ['pending row with an extra fact in run A', value => {value.mainEvents[4] = {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget', fields: 'x'}};}],
      ['pending row with another reason in run A', value => {value.mainEvents[4] = {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-limit'}};}],
      ['late read that ended unreadable in run B', value => {value.lifecycle.restartMainEvents[4] = {event: 'SETTINGS_FALLBACK', facts: {state: 'unreadable', reason: 'load-limit'}};}]
    ] satisfies [string, LateCorruption][]).map(([name, corrupt]) => ({name: `lifecycle ${name}`, body: lateLifecycleReceipt(corrupt), scenario: 'lifecycle', code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'})),
    {name: 'lifecycle two quarantined files with Int64 integers', body: lifecycleReceipt(['lifecycle', 'settingsQuarantined'], 2), scenario: 'lifecycle', numbers: 'int64' as const, code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'}
  ];
}

// ET-015a PR-4 recording receipts: one intact receipt shaped like a real development run, then single-field corruptions.
function recordingReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const step = (pid: number, name: string): Json => ({pid, event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}});
  const started = (pid: number, created: boolean): Json[] => [{pid, event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}, {pid, event: 'STORAGE_VERIFIED'},
    {pid, event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 2, created, migratedFrom: null}},
    {pid, event: 'V1_SOURCE_STATUS', facts: {status: 'stale', selection: 'synthetic', durable: 'active', count: 1}}];
  // Seven rows: the intake and flush steps, then the storage steps around the close.
  const stopped = (pid: number): Json[] => [...['ingestion', 'capture', 'v1-ingestion', 'recording-flush', 'storage-probe'].map(name => step(pid, name)),
    {pid, event: 'HISTORY_STORAGE_CLOSED'}, step(pid, 'history-storage'), {pid, event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
  const connection = (index: number, acked: string | null, events: [string, boolean][], forwarded: string[], withheld: string[], closedBy: string | null): Json =>
    ({connection: index, checkpointAckedThrough: acked, events: events.map(([eventSeq, redelivered]) => ({eventSeq, redelivered})), gaps: 0, end: null,
      acks: [...forwarded, ...withheld], forwardedAcks: forwarded, withheldAcks: withheld, closedBy});
  const lifecycleState = {servicePid: 4200, dashboard: false, exiting: false, tray: true, overlay: true};
  const durable: Json = {status: 'stale', selection: 'synthetic', durable: 'active', count: 1};
  // ET-015c PR-4 recording status facts, shaped like a real development run.
  const losses = (notConnected = 0): Json => ({lostEvents: 0, eventLoss: 0, notConnected, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0});
  const note = 'Synthetic test database (never game history)', notice = 'Prototype live display. Only a test database is recorded, never game history.';
  const waitingText = (): Json => ({headline: 'Waiting for the recorded source to connect', detail: [note], losses: null, alert: null, notice});
  const waiting = (): Json => ({dashboard: waitingText(), health: {state: 'waiting', target: 'synthetic', code: null, losses: losses(), trip: null}});
  const row = (state: string, notConnected = 0): Json => ({state, target: 'synthetic', code: null, lostEvents: 0, eventLoss: 0, notConnected, sampleLoss: 0, restoreLoss: 0,
    droppedSamples: 0, tripPhase: 'active', tripCompleteness: 'partial', untrackedJob: false});
  const status: Json = {beforeAdmission: waiting(),
    afterFirstConnection: {dashboard: {headline: 'Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap',
      detail: [note, 'Current trip is partial'], losses: null, alert: null, notice},
    health: {state: 'interrupted', target: 'synthetic', code: null, losses: losses(), trip: {phase: 'active', completeness: 'partial', untrackedJob: false}}},
    firstConnectionRows: [row('opening'), row('waiting'), row('recording'), row('interrupted')],
    afterRestart: waiting(), serviceRestartRows: [{state: 'unknown'}, row('opening'), row('waiting')], afterReload: waitingText(),
    whileClosedRows: [row('recording', 1), row('interrupted', 1)],
    whileClosed: {state: 'recording', target: 'synthetic', code: null, losses: losses(1), trip: {phase: 'idle', completeness: null, untrackedJob: false}},
    reopened: {headline: 'Recording', detail: [note], losses: ['Gaps recorded since ETS2Telemetry started', 'Intervals without a connection: 1'], alert: null, notice},
    closedAgain: lifecycleState,
    firstConnectionTexts: [waitingText(), {headline: 'Recording', detail: [note, 'Current trip is partial'], losses: null, alert: null, notice}],
    serviceRestartTexts: [waitingText(), {headline: 'Not known: the telemetry service is not running or has not reported a valid status', detail: null, losses: null, alert: null,
      notice: 'Prototype live display. The recording status is not known right now.'}, waitingText()]};
  const value: Json = {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'recording', launcherExit: 0, probesAfterExit: ['ets2telemetry-probe-a'],
    mainEvents: [{event: 'DIAGNOSTIC_SERVICE_EXIT_REQUEST'}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'tray'}},
      {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}],
    serviceEvents: [...started(4100, true), ...started(4200, false), ...stopped(4200)],
    recording: {commitsActive: true, serviceRestartRecovered: true, dashboardClosedRecordingContinued: true, trayExitOrderly: true, restartRecovered: true,
      shutdownClean: true, simulatorMatchesReplay: true, historyDatabaseAbsent: true, sidecarsAbsent: true, databaseRowsMatch: true, samplesRecorded: true,
      statusWaitingShown: true, statusRecordingShown: true, statusUnknownAfterServiceExit: true, statusReloadKept: true, statusRecordedWhileClosed: true,
      statusNoEventLoss: true, statusReopenedLosses: true, statusRunBFresh: true, dashboardClosedBeforeTrayExit: true, status,
      servicePid: 4100, restartedServicePid: 4200, afterClose: lifecycleState, whileClosed: lifecycleState,
      restart: {servicePid: 4300, durable, status: {beforeAdmission: waiting(), rows: [row('opening'), row('waiting'), row('recording'), row('paused')],
        texts: [waitingText(), {headline: 'Game paused; recording continues when it resumes', detail: [note], losses: null, alert: null, notice}]}},
      firstServiceDurable: {...durable, status: 'connected'}, restartedServiceDurable: durable,
      firstConnection: connection(1, '0', [['1', false], ['2', false], ['3', false], ['4', false], ['5', false]], ['1', '2', '3', '4'], ['5'], 'server'),
      secondConnection: connection(2, '4', [['5', true], ['6', false], ['7', false], ['8', false], ['9', false], ['10', false]], ['5', '6', '7', '8', '9', '10'], [], 'client'),
      thirdConnection: connection(3, '10', [['11', false], ['12', false], ['13', false]], ['11', '12', '13'], [], 'client'),
      trayExit: {launcherExit: 0, signal: null, exitMilliseconds: 88, requests: ['tray']}, restartLauncherExit: 0,
      simulator: {exit: {code: 0, signal: null}, report: {scenario: 'normal-delivery-runtime-journey', cancelled: false, matchesReplay: true, differences: [],
        connections: [1, 2, 3].map(index => ({connection: index, durable: true, closedBy: index === 1 ? 'disconnect' : 'client'}))}},
      files: {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 2, sidecars: [], syntheticBackups: false, historyDatabase: false, dataDirectory: false},
      database: {integrity: ['ok'], foreignKeyViolations: 0, purpose: 'synthetic', acceptedOrigin: 'synthetic', acknowledgedThrough: '13',
        sessions: [{game: 'ets2', origin: 'synthetic', committedThrough: '13', endReason: null, simulatorSession: true}],
        rows: {trips: [{trip: 'trip@3', outcome: 'delivered', recordingCompleteness: 'partial'}], attributions: [{eventSeq: '8', trip: 'trip@3', attribution: 'trip'}],
          intervals: [{trip: 'trip@3', kind: 'discontinuity', detail: {cause: 'opened-at-load', atEventSeq: '3'}}, {trip: 'trip@3', kind: 'not-connected', detail: {cause: 'consumer-restart'}}],
          events: Array.from({length: 13}, (_, index) => ({eventSeq: String(index + 1)})),
          // ET-015b PR-4: without the optional second-1000 row, which the terminated service stores only when its 5 s flush ran.
          sampleRows: [{second: '1001', trip: null}, {second: '1002', trip: null}]}},
      retainedCrashProbe: ['ets2telemetry-probe-a'],
      restartMainEvents: [{event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}],
      restartServiceEvents: [...started(4300, false), ...stopped(4300)]}};
  if (path.length) {
    let target = value as Record<string | number, Json>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete target[last]; else target[last] = replacement;
  }
  return JSON.stringify(value);
}
function recordingCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `recording ${name}`, body: recordingReceipt(path, replacement), scenario: 'recording', code: 0, available: true, reason: 'RECORDING_RESULT_INCOMPLETE_OR_INVALID'});
  const int64 = (name: string, path: (string | number)[] = [], replacement?: Json) =>
    ({name: `recording ${name} with Int64 integers`, body: recordingReceipt(path, replacement), scenario: 'recording', numbers: 'int64' as const, code: 0, available: true,
      reason: path.length ? 'RECORDING_RESULT_INCOMPLETE_OR_INVALID' : null});
  return [
    {name: 'intact recording receipt', body: recordingReceipt(), scenario: 'recording', code: 0, available: true, reason: null},
    int64('intact receipt'),
    int64('tray exit 1', ['recording', 'trayExit', 'launcherExit'], 1),
    int64('reused service', ['recording', 'restart', 'servicePid'], 4200),
    {name: 'scaffold receipt cannot prove recording', body: recordingReceipt(['scenarioKind'], 'scaffold'), scenario: 'recording', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    {name: 'recording receipt cannot prove lifecycle', body: recordingReceipt(), scenario: 'lifecycle', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    invalid('result missing', ['recording']),
    invalid('rows not matched', ['recording', 'databaseRowsMatch'], false),
    invalid('flag as string', ['recording', 'commitsActive'], 'true'),
    invalid('flag missing', ['recording', 'dashboardClosedRecordingContinued']),
    invalid('service not restarted', ['recording', 'restartedServicePid'], 4100),
    invalid('service replaced while closed', ['recording', 'whileClosed', 'servicePid'], 4201),
    invalid('dashboard open while recording', ['recording', 'whileClosed', 'dashboard'], true),
    invalid('lost ACK delivered', ['recording', 'firstConnection', 'withheldAcks'], []),
    invalid('no redelivery', ['recording', 'secondConnection', 'events', 0, 'redelivered'], false),
    invalid('restart checkpoint past the lost ACK', ['recording', 'secondConnection', 'checkpointAckedThrough'], '5'),
    invalid('run B commit missing', ['recording', 'thirdConnection', 'forwardedAcks'], []),
    invalid('durable not active', ['recording', 'restartedServiceDurable', 'durable'], 'pending'),
    invalid('run B durable not logged', ['recording', 'restart', 'durable']),
    invalid('tray exit through another path', ['recording', 'trayExit', 'requests'], ['renderer']),
    invalid('tray exit slower than 8 s', ['recording', 'trayExit', 'exitMilliseconds'], 8001),
    invalid('simulator differs from the replay', ['recording', 'simulator', 'report', 'matchesReplay'], false),
    invalid('simulator exit 1', ['recording', 'simulator', 'exit', 'code'], 1),
    invalid('live-only connection served', ['recording', 'simulator', 'report', 'connections', 1, 'durable'], false),
    invalid('history database created', ['recording', 'files', 'historyDatabase'], true),
    invalid('WAL file left', ['recording', 'files', 'sidecars'], ['-wal']),
    // ET-016 PR-1: the recording target is created at schema version 2.
    invalid('schema version 1 database', ['recording', 'files', 'userVersion'], 1),
    invalid('integrity failure', ['recording', 'database', 'integrity'], ['row 3 missing from index']),
    invalid('history purpose', ['recording', 'database', 'purpose'], 'history'),
    invalid('coverage short', ['recording', 'database', 'sessions', 0, 'committedThrough'], '12'),
    invalid('acknowledged past coverage', ['recording', 'database', 'acknowledgedThrough'], '14'),
    invalid('event missing', ['recording', 'database', 'rows', 'events'], Array.from({length: 12}, (_, index) => ({eventSeq: String(index + 1)}))),
    // ET-015b PR-4 sample rules.
    {name: 'intact recording receipt with the optional sample', body: recordingReceipt(['recording', 'database', 'rows', 'sampleRows'],
      [{second: '1000', trip: 'trip@3'}, {second: '1001', trip: null}, {second: '1002', trip: null}]), scenario: 'recording', code: 0, available: true, reason: null},
    invalid('samples not recorded', ['recording', 'samplesRecorded'], false),
    invalid('samples flag missing', ['recording', 'samplesRecorded']),
    invalid('run B sample missing', ['recording', 'database', 'rows', 'sampleRows'], [{second: '1001', trip: null}]),
    invalid('exit-flushed sample missing', ['recording', 'database', 'rows', 'sampleRows'], [{second: '1000', trip: 'trip@3'}, {second: '1002', trip: null}]),
    invalid('paused second sampled', ['recording', 'database', 'rows', 'sampleRows'], [{second: '1001', trip: null}, {second: '1002', trip: null}, {second: '1003', trip: null}]),
    invalid('sample after the delivery names the trip', ['recording', 'database', 'rows', 'sampleRows', 0, 'trip'], 'trip@3'),
    invalid('sample rows missing', ['recording', 'database', 'rows', 'sampleRows']),
    invalid('sample rows dropped', ['serviceEvents', SERVICE_EVENTS_A_APPEND], {pid: 4200, event: 'V1_SAMPLES_DROPPED', facts: {count: 1}}),
    invalid('run B sample write retried', ['recording', 'restartServiceEvents', RUN_B_SERVICE_EVENTS_APPEND], {pid: 4300, event: 'V1_SAMPLES_RETRY', facts: {code: 'DISK_FULL', count: 1}}),
    invalid('trip still open', ['recording', 'database', 'rows', 'trips', 0, 'outcome'], 'open'),
    invalid('no consumer-restart interval', ['recording', 'database', 'rows', 'intervals', 1, 'detail', 'cause'], 'disconnected'),
    invalid('flush step timed out', ['serviceEvents', RECORDING_FLUSH_A, 'facts', 'outcome'], 'timeout'),
    invalid('durable failure logged', ['serviceEvents', SERVICE_EVENTS_A_APPEND], {pid: 4200, event: 'V1_DURABLE_UNAVAILABLE', facts: {code: 'PERMISSION_DENIED'}}),
    invalid('history unavailable logged', ['serviceEvents', SERVICE_EVENTS_A_APPEND], {pid: 4200, event: 'HISTORY_STORAGE_UNAVAILABLE', facts: {code: 'DISK_FULL'}}),
    invalid('replacement created a new database', ['serviceEvents', 6, 'facts', 'created'], true),
    invalid('second target rejected', ['recording', 'restartServiceEvents', 0], {pid: 4300, event: 'RECORDING_TARGET_REJECTED'}),
    invalid('run B flush step missing', ['recording', 'restartServiceEvents', 7, 'facts', 'name'], 'flush'),
    invalid('third service exit', ['mainEvents', 5], {event: 'SERVICE_EXIT', detail: {code: 0}}),
    invalid('unclean final stop', ['serviceEvents', 15, 'detail', 'clean'], false),
    invalid('run B exit through another path', ['recording', 'restartMainEvents', 0, 'facts', 'reason'], 'tray'),
    invalid('run B closed nonzero', ['recording', 'restartLauncherExit'], 1),
    invalid('second probe left', ['probesAfterExit', 1], 'ets2telemetry-probe-b'),
    // ET-015c PR-4 recording status rules.
    invalid('status flag missing', ['recording', 'statusRecordingShown']),
    invalid('status flag false', ['recording', 'statusReloadKept'], false),
    invalid('status facts missing', ['recording', 'status']),
    invalid('run B status facts missing', ['recording', 'restart', 'status']),
    invalid('not waiting before admission', ['recording', 'status', 'beforeAdmission', 'health', 'state'], 'not-recorded-source'),
    invalid('waiting without the synthetic note', ['recording', 'status', 'beforeAdmission', 'dashboard', 'detail'], []),
    invalid('waiting for the history target', ['recording', 'status', 'afterRestart', 'health', 'target'], 'history'),
    invalid('loss before admission', ['recording', 'status', 'beforeAdmission', 'health', 'losses', 'lostEvents'], 1),
    invalid('connection 1 never recording', ['recording', 'status', 'firstConnectionRows', 2, 'state'], 'waiting'),
    invalid('trip line missing after connection 1', ['recording', 'status', 'afterFirstConnection', 'dashboard', 'detail'], ['Synthetic test database (never game history)']),
    invalid('no unknown between the services', ['recording', 'status', 'serviceRestartRows', 0, 'state'], 'waiting'),
    invalid('reload lost the status', ['recording', 'status', 'afterReload', 'headline'], '—'),
    invalid('never recording while closed', ['recording', 'status', 'whileClosedRows', 0, 'state'], 'waiting'),
    invalid('redelivered duplicate counted as a lost event', ['recording', 'status', 'whileClosed', 'losses', 'lostEvents'], 1),
    invalid('consumer-restart interval not counted', ['recording', 'status', 'whileClosed', 'losses', 'notConnected'], 0),
    invalid('stopped while closed', ['recording', 'status', 'whileClosed', 'state'], 'stopped'),
    invalid('reopened dashboard without totals', ['recording', 'status', 'reopened', 'losses'], null),
    invalid('run B carried run A totals', ['recording', 'restart', 'status', 'rows', 3, 'notConnected'], 1),
    invalid('run B never recorded', ['recording', 'restart', 'status', 'rows'], [{state: 'opening', target: 'synthetic'}, {state: 'waiting', target: 'synthetic'}, {state: 'interrupted', target: 'synthetic'}]),
    int64('status losses', ['recording', 'status', 'whileClosed', 'losses', 'notConnected'], 2),
    // PR-4 review pass 1: the dashboard text logs and the closed dashboard before the tray exit.
    invalid('connection 1 text log without recording', ['recording', 'status', 'firstConnectionTexts', 1, 'headline'], 'Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap'),
    invalid('restart text log without unknown', ['recording', 'status', 'serviceRestartTexts', 1, 'headline'], 'Not known while the telemetry service is not running'),
    invalid('run B text log without a recorded state', ['recording', 'restart', 'status', 'texts', 1, 'headline'], 'Waiting for the recorded source to connect'),
    invalid('dashboard open at the tray exit', ['recording', 'status', 'closedAgain', 'dashboard'], true),
    invalid('closed-again flag missing', ['recording', 'dashboardClosedBeforeTrayExit'])
  ];
}

// ET-016 PR-4 journal receipts: one intact receipt shaped like a real development run, then single-field corruptions.
function journalReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const main = (): Json[] => [{event: 'APP_START'}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}];
  const service = (created: boolean): Json[] => [...(created ? [] : [{event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}]), {event: 'STORAGE_VERIFIED'},
    {event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 2, created, migratedFrom: null}},
    ...['ingestion', 'capture', 'v1-ingestion', 'recording-flush', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})),
    {event: 'HISTORY_STORAGE_CLOSED'}, {event: 'SHUTDOWN_STEP', facts: {name: 'history-storage', outcome: 'ok'}}, {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
  const trip = (n: number) => `7a000000-0000-4000-8000-00000000000${n}`;
  // ET-016 PR-5: run 2 logs two saved exports, a cancelled one and the refused data-folder target.
  const exportEvents = (): Json[] => [{event: 'JOURNAL_EXPORT_SAVED', facts: {events: 105, samples: 3600}}, {event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples: 3}},
    {event: 'JOURNAL_EXPORT_CANCELLED', facts: null}, {event: 'JOURNAL_EXPORT_FAILED', facts: {code: 'EXPORT_TARGET_REFUSED'}}];
  const restartMain = (): Json[] => [main()[0], ...exportEvents().map(row => (row as {facts: Json}).facts === null ? {event: (row as {event: string}).event} : row), ...main().slice(1)];
  const value: Json = {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'journal', launcherExit: 0, probesAfterExit: [],
    mainEvents: main(), serviceEvents: service(true),
    journal: {liveViewport: {innerHeight: 437, scrollY: 0, status: {top: 158, bottom: 178, visible: true}, speed: {top: 214, bottom: 234, visible: true},
      fuel: {top: 242, bottom: 262, visible: true}},
      liveLinesInViewport: true, liveHiddenInJournal: true, emptyHistoryShown: true, recordingOffNoteShown: true, liveRestored: true, seeded: true, syntheticBannerShown: true,
      pagesWalked: true, anchorRowsMatch: true, anchorDetailsMatch: true, backKeptPage: true, sampleGapShown: true, timelinePaged: true, intervalsPaged: true, samplesPaged: true,
      filtersApplied: true, shutdownClean: true,
      emptyHistory: {page: 'Page 1. The journal does not update by itself; use Refresh.', error: null, empty: 'No trips recorded',
        emptyNote: 'Game history recording is off in this version, so no game trips are recorded yet.', banner: null, next: false, previous: false, rows: []},
      emptyRunExit: {launcherExit: 0, signal: null, closeMilliseconds: 98},
      seed: {trips: 119, fillers: 110, pagingTolls: 104, pagingSamples: 3600, elapsedMs: 618, bundleMs: 128, totalMs: 805},
      pages: [{count: 50, next: true, previous: false}, {count: 50, next: true, previous: true}, {count: 19, next: false, previous: true}],
      anchorRows: [8, 7, 6, 5, 4, 3, 2, 1].map(n => ({trip: trip(n)})), anchorDetails: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({trip: trip(n)})),
      deliveredSamples: [{kind: 'sample', speed: '80.1 km/h'}, {kind: 'sample', speed: '0.0 km/h'}, {kind: 'gap', text: 'no samples for 1 s'}, {kind: 'sample', speed: 'unavailable (invalid reading)'}],
      pagingTimeline: {first: '1', pageTwo: ['101', '102', '103', '104', '105'], nextOnLast: false}, pagingIntervals: {pageTwo: 4, nextOnLast: false},
      pagingSamples: {kinds: ['sample'], firstSpeed: '72.0 km/h', nextOnSecond: true},
      filters: {none: [trip(5), trip(4), trip(3)], noneNext: false, partial: 39, partialNext: false},
      restartLauncherExit: 0, files: {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 2, sidecars: [], syntheticBackups: false},
      exportNoteShown: true, exportsSaved: true, exportCancelledWritesNothing: true, exportTargetRefused: true, dataFolderUnchanged: true,
      exportFolder: ['delivered.json', 'paging.json'],
      pagingExport: {events: 105, firstEvent: '1', lastEvent: '105', intervals: 104, samples: 3600, snapshot: true, outcome: 'open'},
      deliveredExport: {bounds: {committedThroughEventSeq: '29', lastSampleId: '4', lastIntervalId: null, snapshot: false},
        events: [['4', 'job.configured', null], ['5', 'player.fined', 'trip'], ['6', 'player.tollgate.paid', 'trip'], ['7', 'player.use.ferry', 'trip'], ['8', 'player.fined', 'trip'],
          ['9', 'job.delivered', 'trip']], intervals: 0},
      exportEvents: exportEvents(),
      restartMainEvents: restartMain(), restartServiceEvents: service(false)}};
  if (path.length) {
    let target = value as Record<string | number, Json>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete target[last]; else target[last] = replacement;
  }
  return JSON.stringify(value);
}
function journalCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `journal ${name}`, body: journalReceipt(path, replacement), scenario: 'journal', code: 0, available: true, reason: 'JOURNAL_RESULT_INCOMPLETE_OR_INVALID'});
  return [
    {name: 'intact journal receipt', body: journalReceipt(), scenario: 'journal', code: 0, available: true, reason: null},
    {name: 'intact journal receipt with PowerShell 7 Int64 integers', body: journalReceipt(), scenario: 'journal', numbers: 'int64' as const, code: 0, available: true, reason: null},
    {name: 'journal seed of 118 trips with Int64 integers', body: journalReceipt(['journal', 'seed', 'trips'], 118), scenario: 'journal', numbers: 'int64' as const, code: 0, available: true,
      reason: 'JOURNAL_RESULT_INCOMPLETE_OR_INVALID'},
    {name: 'scaffold receipt cannot prove the journal', body: journalReceipt(['scenarioKind'], 'scaffold'), scenario: 'journal', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    {name: 'journal receipt cannot prove recording', body: journalReceipt(), scenario: 'recording', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    invalid('result missing', ['journal']),
    invalid('Live lines outside the viewport', ['journal', 'liveLinesInViewport'], false),
    invalid('Live shown inside the Journal tab', ['journal', 'liveHiddenInJournal'], false),
    invalid('banner flag as string', ['journal', 'syntheticBannerShown'], 'true'),
    invalid('detail flag missing', ['journal', 'anchorDetailsMatch']),
    invalid('empty history without the recording-off note', ['journal', 'emptyHistory', 'emptyNote'], null),
    invalid('empty history with a test-database banner', ['journal', 'emptyHistory', 'banner'], 'Synthetic test database — never game history'),
    invalid('empty history with a row', ['journal', 'emptyHistory', 'rows'], [{trip: '7a000000-0000-4000-8000-000000000001'}]),
    invalid('seed without the paging samples', ['journal', 'seed', 'pagingSamples'], 3599),
    invalid('first page of 51 trips', ['journal', 'pages', 0, 'count'], 51),
    invalid('last page with Next', ['journal', 'pages', 2, 'next'], true),
    invalid('outcome filter applied after the limit', ['journal', 'filters', 'none'], ['7a000000-0000-4000-8000-000000000005', '7a000000-0000-4000-8000-000000000004']),
    invalid('partial filter count', ['journal', 'filters', 'partial'], 38),
    invalid('an anchor detail missing', ['journal', 'anchorDetails'], [1, 2, 3, 4, 5, 6, 7].map(n => ({trip: `7a000000-0000-4000-8000-00000000000${n}`}))),
    invalid('sample gap row missing', ['journal', 'deliveredSamples', 2], {kind: 'sample', speed: '0.0 km/h'}),
    invalid('timeline second page short', ['journal', 'pagingTimeline', 'pageTwo'], ['101']),
    invalid('interval second page empty', ['journal', 'pagingIntervals', 'pageTwo'], 0),
    invalid('a separator in the paging samples', ['journal', 'pagingSamples', 'kinds'], ['sample', 'gap']),
    invalid('run 1 exited nonzero', ['journal', 'emptyRunExit', 'launcherExit'], 1),
    invalid('run 2 exited nonzero', ['journal', 'restartLauncherExit'], 1),
    invalid('a probe left behind', ['probesAfterExit'], ['ets2telemetry-probe-1']),
    invalid('synthetic database left with a WAL file', ['journal', 'files', 'sidecars'], ['-wal']),
    invalid('synthetic database at version 1', ['journal', 'files', 'userVersion'], 1),
    invalid('synthetic database backed up', ['journal', 'files', 'syntheticBackups'], true),
    invalid('run 1 opened a recording target', ['serviceEvents', 0], {event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}),
    invalid('run 1 found an existing history database', ['serviceEvents', 1, 'facts', 'created'], false),
    invalid('run 2 opened history', ['journal', 'restartServiceEvents', 0, 'facts', 'purpose'], 'history'),
    invalid('run 2 created its database', ['journal', 'restartServiceEvents', 2, 'facts', 'created'], true),
    invalid('run 2 with a failure event', ['journal', 'restartServiceEvents', 13], {event: 'HISTORY_STORAGE_UNAVAILABLE_FAILED'}),
    invalid('run 2 events missing', ['journal', 'restartMainEvents']),
    // Review round 1: the viewport bounds and the anchor order themselves, not only the driver's flags.
    invalid('viewport missing', ['journal', 'liveViewport']),
    invalid('fuel line below the viewport', ['journal', 'liveViewport', 'fuel', 'bottom'], 438),
    invalid('status line above the viewport', ['journal', 'liveViewport', 'status', 'top'], -4),
    invalid('speed line not visible', ['journal', 'liveViewport', 'speed', 'visible'], false),
    invalid('speed line box missing', ['journal', 'liveViewport', 'speed']),
    invalid('anchor rows out of order', ['journal', 'anchorRows'], [8, 7, 6, 5, 4, 3, 1, 2].map(n => ({trip: `7a000000-0000-4000-8000-00000000000${n}`}))),
    invalid('a filler instead of an anchor row', ['journal', 'anchorRows', 0, 'trip'], '7f000000-0000-4000-8000-00000000000a'),
    invalid('anchor details out of order', ['journal', 'anchorDetails'], [2, 1, 3, 4, 5, 6, 7, 8].map(n => ({trip: `7a000000-0000-4000-8000-00000000000${n}`}))),
    {name: 'journal fuel line below the viewport with Int64 integers', body: journalReceipt(['journal', 'liveViewport', 'fuel', 'bottom'], 438), scenario: 'journal',
      numbers: 'int64' as const, code: 0, available: true, reason: 'JOURNAL_RESULT_INCOMPLETE_OR_INVALID'},
    // ET-016 PR-5 trip export, additive.
    invalid('export flag missing', ['journal', 'exportsSaved']),
    invalid('uninstall note not shown', ['journal', 'exportNoteShown'], false),
    invalid('data folder changed by a refused export', ['journal', 'dataFolderUnchanged'], false),
    invalid('partial file left in the export folder', ['journal', 'exportFolder'], ['delivered.json', 'paging.json', 'paging.json.0badc0de.partial']),
    invalid('cancelled export wrote a file', ['journal', 'exportFolder'], ['cancelled.json', 'delivered.json', 'paging.json']),
    invalid('paging export short of its samples', ['journal', 'pagingExport', 'samples'], 3599),
    invalid('open trip export not a snapshot', ['journal', 'pagingExport', 'snapshot'], false),
    invalid('delivered export as a snapshot', ['journal', 'deliveredExport', 'bounds', 'snapshot'], true),
    invalid('delivered export with an event after its outcome', ['journal', 'deliveredExport', 'events', 6], ['10', 'job.cleared', null]),
    invalid('cancelled export row missing', ['journal', 'exportEvents', 2], {event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples: 3}}),
    invalid('refused export logged with another code', ['journal', 'exportEvents', 3, 'facts', 'code'], 'EXPORT_WRITE_FAILED'),
    invalid('a second export failure in run 2', ['journal', 'restartMainEvents', 5], {event: 'JOURNAL_EXPORT_FAILED', facts: {code: 'EXPORT_WRITE_FAILED'}}),
    invalid('the refused export row missing from run 2', ['journal', 'restartMainEvents', 4], {event: 'JOURNAL_EXPORT_CANCELLED'})
  ];
}

it('requires an intact current driver receipt and normal Job exit without overwriting failed evidence', async () => {
  const resources = await temporaryResources();
  try {
    const receipts = cases.map((_, index) => path.join(resources.directory, `receipt-${index}.json`));
    for (const [index, scenario] of cases.entries()) if (scenario.body !== undefined) await writeFile(receipts[index], scenario.body);
    // All cases share one PowerShell 5.1 validator process; see tests/shared/runtime-receipt-validator.ts.
    const results = await validateRuntimeReceipts(resources.directory, cases.map((scenario, index) =>
      ({receipt: receipts[index], code: scenario.code, ...('scenario' in scenario ? {scenario: scenario.scenario} : {}),
        ...('numbers' in scenario ? {numbers: scenario.numbers} : {})})));
    for (const [index, scenario] of cases.entries()) {
      expect(results[index], scenario.name).toMatchObject({passed: scenario.reason === null,
        driverResultAvailable: scenario.available, reason: scenario.reason});
      if (scenario.body !== undefined) expect(await readFile(receipts[index], 'utf8'), scenario.name).toBe(scenario.body);
    }
  } finally {await resources.dispose();}
}, receiptBatchTimeout(cases.length) + 5000);
