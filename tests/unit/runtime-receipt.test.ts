import {it, expect} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

// The index that appends a row to run A's lifecycle main events; ET-011b added three settings rows after the original four.
const MAIN_EVENTS_APPEND = 8;
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
  ...hardModeCases(),
  ...lifecycleCases(),
  ...pluginCases(),
  ...recordingCases(),
  ...journalCases(),
  ...refusalCases(),
  ...installedCases(),
  ...resourceCases()
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
      {event: 'SETTINGS_SAVED', facts: {game: 'ets2', profile: 'us-customary'}}, {event: 'SETTINGS_SAVED', facts: {overlayEnabled: false}}],
    serviceEvents: orderlyService(),
    lifecycle: {dashboardClosedServiceAlive: true, overlayAliveAfterClose: true, trayPresentAfterClose: true, overlayCurrentAfterClose: true,
      sourceConnectionPreserved: true, secondInstanceRestoredDashboard: true, trayOpenRestoredDashboard: true, explicitExitOrderly: true,
      restartRecovered: true, shutdownClean: true, servicePid: 4100,
      afterClose: {servicePid: 4100, dashboard: false, exiting: false, overlay: true, tray: true, upstream: true},
      overlayChanged: reading('72', '71.0'), overlayRestored: reading('90', '73.0'),
      secondInstance: {pid: 4200, exitCode: 0, signal: null, exitMilliseconds: 164, wroteLog: false, primaryActions: ['created']},
      explicitExit: {launcherExit: 0, signal: null, exitMilliseconds: 179, requests: ['renderer']},
      restart: {overlayEnabled: false, servicePid: 4300, settingsState: 'loaded', dashboardUnits: {speed: 'Speed: 56 mph', fuel: 'Fuel: 19.3 US gal', gauge: {number: '56', unit: 'mph', accessibleName: 'Speed: 56 mph; Engine RPM: 600 rpm', visible: true}}}, restartLauncherExit: 0,
      settingsSeededInvalidFile: true, settingsStartupUnchanged: true, settingsQuarantinePreserved: true, settingsSavedExact: true, unitsApplied: true,
      overlayVisibilitySaved: true, overlayVisibilityRestarted: true, syntheticOverlayHiddenAfterOff: true, settingsRestartLoaded: true, settingsQuarantined: 1, dashboardUnits: {speed: 'Speed: 56 mph', fuel: 'Fuel: 19.3 US gal', gauge: {number: '56', unit: 'mph', accessibleName: 'Speed: 56 mph; Engine RPM: 600 rpm', visible: true}},
      overlayUnits: {...reading('56', '19.3'), speedUnit: 'mph', fuelUnit: 'US gal'},
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
// ET-017 PR-5: the plugin scenario's receipt and the scaffold receipt's disabled plugin card. One intact receipt each,
// then single-field corruptions that must each fail.
function corrupt(value: Json, path: (string | number)[], replacement?: Json): string {
  if (path.length) {
    let target = value as Record<string | number, Json>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete target[last]; else target[last] = replacement;
  }
  return JSON.stringify(value);
}
function pluginReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const orderlyMain = (): Json[] => [{event: 'APP_EXIT', detail: {code: 0}}, {event: 'SERVICE_EXIT', detail: {code: 0}}];
  const orderlyService = (): Json[] => [{event: 'STORAGE_VERIFIED'}, ...['ingestion', 'capture', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})),
    {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
  const testRoot = (): Json => ({event: 'PLUGIN_SETUP_MODE', facts: {mode: 'test-root', reason: null}});
  return corrupt({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'plugin', launcherExit: 0, probesAfterExit: [],
    mainEvents: [...orderlyMain(), testRoot()], serviceEvents: orderlyService(),
    plugin: {pluginSteamInstalled: true, pluginUnrelatedUnchanged: true, pluginUnrecognizedUnchanged: true, pluginCardShown: true, pluginNoPathShown: true,
      pluginExclusionRemoved: true, pluginRestartStates: true, pluginRestartUnchanged: true, pluginEventsVerified: true, pluginDiagnosticsExported: true, runAExit: 0, restartLauncherExit: 0,
      restartMainEvents: [...orderlyMain(), testRoot()], restartServiceEvents: orderlyService()}}, path, replacement);
}
function scaffoldReceipt(path: (string | number)[] = [], replacement?: Json): string {
  return corrupt({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'scaffold',
    mainEvents: [{event: 'PLUGIN_SETUP_MODE', facts: {mode: 'disabled', reason: 'isolated-launch'}}],
    pluginCard: {disabledNoteShown: true, controlsDisabled: true, diagnosisShown: true, exportAvailable: true},
    uninstallCard: {warningShown: true, notInstalledShown: true}}, path, replacement);
}
function pluginCases() {
  const invalidPlugin = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `plugin ${name}`, body: pluginReceipt(path, replacement), scenario: 'plugin', code: 0, available: true, reason: 'PLUGIN_RESULT_INCOMPLETE_OR_INVALID'});
  const invalidScaffold = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `scaffold ${name}`, body: scaffoldReceipt(path, replacement), scenario: 'scaffold', code: 0, available: true, reason: 'SCAFFOLD_PLUGIN_CARD_INVALID'});
  return [
    {name: 'intact plugin receipt', body: pluginReceipt(), scenario: 'plugin', code: 0, available: true, reason: null},
    {name: 'scaffold receipt cannot prove the plugin journey', body: pluginReceipt(['scenarioKind'], 'scaffold'), scenario: 'plugin', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    invalidPlugin('journey missing', ['plugin']),
    invalidPlugin('unrecognized file changed', ['plugin', 'pluginUnrecognizedUnchanged'], false),
    invalidPlugin('exclusion left the plugin', ['plugin', 'pluginExclusionRemoved'], false),
    invalidPlugin('restart wrote', ['plugin', 'pluginRestartUnchanged'], false),
    invalidPlugin('diagnostics export not verified', ['plugin', 'pluginDiagnosticsExported']),
    invalidPlugin('card showed a path', ['plugin', 'pluginNoPathShown'], 'true'),
    invalidPlugin('run A exited nonzero', ['plugin', 'runAExit'], 1),
    invalidPlugin('run B exited nonzero', ['plugin', 'restartLauncherExit'], 1),
    invalidPlugin('run A not in the test-root mode', ['mainEvents', 2, 'facts', 'mode'], 'disabled'),
    invalidPlugin('run B not in the test-root mode', ['plugin', 'restartMainEvents', 2], {event: 'PLUGIN_SETUP_MODE', facts: {mode: 'disabled', reason: 'isolated-launch'}}),
    invalidPlugin('path refused outside the root', ['mainEvents', 3], {event: 'PLUGIN_TEST_ROOT_ESCAPE', facts: {count: 1}}),
    invalidPlugin('run B unclean service stop', ['plugin', 'restartServiceEvents', 4, 'detail', 'clean'], false),
    {name: 'intact scaffold receipt with the disabled plugin card', body: scaffoldReceipt(), scenario: 'scaffold', code: 0, available: true, reason: null},
    invalidScaffold('card evidence missing', ['pluginCard']),
    invalidScaffold('disabled note not shown', ['pluginCard', 'disabledNoteShown'], false),
    invalidScaffold('a control left enabled', ['pluginCard', 'controlsDisabled'], false),
    invalidScaffold('diagnosis line not shown', ['pluginCard', 'diagnosisShown'], false),
    invalidScaffold('diagnostics export unavailable', ['pluginCard', 'exportAvailable']),
    invalidScaffold('not in the disabled mode', ['mainEvents', 0, 'facts', 'mode'], 'test-root'),
    invalidScaffold('uninstall card evidence missing', ['uninstallCard']),
    invalidScaffold('uninstall warning not shown', ['uninstallCard', 'warningShown'], false),
    invalidScaffold('not-installed answer not shown', ['uninstallCard', 'notInstalledShown'], 'true')
  ];
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
    ...['overlayVisibilitySaved', 'overlayVisibilityRestarted', 'syntheticOverlayHiddenAfterOff'].flatMap(flag => [
      invalid(`missing visibility ${flag}`, ['lifecycle', flag]),
      invalid(`false visibility ${flag}`, ['lifecycle', flag], false),
      invalid(`nonboolean visibility ${flag}`, ['lifecycle', flag], 'true')
    ]),
    {...invalid('legacy hidden flag cannot replace synthetic invariant', ['lifecycle', 'syntheticOverlayHiddenAfterOff']),
      body: (() => {const value = JSON.parse(lifecycleReceipt()) as {lifecycle: Record<string, unknown>};
        delete value.lifecycle.syntheticOverlayHiddenAfterOff; value.lifecycle.overlayHiddenWhileDisabled = true; return JSON.stringify(value);})()},
    invalid('restart visibility missing', ['lifecycle', 'restart', 'overlayEnabled']),
    invalid('restart visibility enabled', ['lifecycle', 'restart', 'overlayEnabled'], true),
    invalid('restart visibility nonboolean', ['lifecycle', 'restart', 'overlayEnabled'], 'false'),
    invalid('required visibility save missing', ['mainEvents', 7]),
    invalid('visibility save cannot precede units', ['mainEvents', 6, 'facts'], {overlayEnabled: false}),
    invalid('visibility save carries extra facts', ['mainEvents', 7, 'facts'], {overlayEnabled: false, extra: 'invented'}),
    invalid('off-save did not save false', ['mainEvents', 7, 'facts', 'overlayEnabled'], true),
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
    invalid('missing SVG evidence', ['lifecycle', 'dashboardUnits', 'gauge'], null),
    invalid('wrong SVG number', ['lifecycle', 'dashboardUnits', 'gauge', 'number'], '55.9'),
    invalid('wrong SVG unit', ['lifecycle', 'dashboardUnits', 'gauge', 'unit'], 'km/h'),
    invalid('wrong SVG accessible name', ['lifecycle', 'dashboardUnits', 'gauge', 'accessibleName'], 'Speed: unavailable'),
    invalid('SVG hidden', ['lifecycle', 'dashboardUnits', 'gauge', 'visible'], false),
    invalid('SVG visibility as string', ['lifecycle', 'dashboardUnits', 'gauge', 'visible'], 'true'),
    invalid('dashboard still metric after the change', ['lifecycle', 'dashboardUnits', 'speed'], 'Speed: 90 km/h'),
    invalid('restart dashboard back to metric', ['lifecycle', 'restart', 'dashboardUnits', 'fuel'], 'Fuel: 73.0 L'),
    invalid('restart settings not loaded', ['lifecycle', 'restart', 'settingsState'], 'defaults'),
    invalid('fallback row missing', ['mainEvents', 4], {event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}),
    invalid('fallback for another state', ['mainEvents', 4, 'facts', 'state'], 'loaded-with-fallbacks'),
    invalid('unexpected third save', ['mainEvents', MAIN_EVENTS_APPEND], {event: 'SETTINGS_SAVED', facts: {game: 'ats', profile: 'metric'}}),
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
  return recordingReceiptWith(path.length ? [[path, replacement]] : []);
}
type Edit = [(string | number)[], Json | undefined];
/** The intact recording receipt with each edit applied in order; an undefined replacement deletes the field. */
function recordingReceiptWith(edits: Edit[]): string {
  const step = (pid: number, name: string): Json => ({pid, event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}});
  const started = (pid: number, created: boolean): Json[] => [{pid, event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}, {pid, event: 'STORAGE_VERIFIED'},
    {pid, event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 3, created, migratedFrom: null}},
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
  // ET-016 PR-8 journal and export facts of run B, shaped like a real development run without the optional sample.
  const tripUuid = '8bb4178d-82ba-8b84-fcbc-a83799a54662', session = 'd119784f-20da-e413-2065-834bba0a041e', databaseUuid = 'df22c9c6-f7e7-4514-bfbd-2cf6eec01a7a';
  const notObserved = 'unavailable (not observed)', route = `${notObserved} → ${notObserved}`, banner = 'Synthetic test database — never game history';
  const windowSeqs = ['3', '4', '5', '6', '7', '8'];
  const journal: Json = {tripUuid,
    list: {rows: [{trip: tripUuid, started: '2027-01-15 09:00:00', game: 'ETS2', route, outcome: 'Delivered', completeness: 'Partial', observed: '0.0 km', fuel: notObserved,
      cargo: notObserved}], banner, error: null, next: false, previous: false},
    detail: {error: null, title: `ETS2: ${route}`, outcome: 'Delivered', completeness: 'Partial', banner,
      fields: {'trip-openedBy': 'job event 3', 'trip-session': session, 'trip-tripId': tripUuid, 'samples-sampleCount': '0'}, notes: {}},
    sampleCount: 0,
    intervals: {total: 'Completeness intervals recorded for this trip: 2.', rows: [['Discontinuity', 'opened while a save was loading', '—', '—', '—'],
      ['Not connected', 'telemetry service restarted', '—', '—', '—']], error: null, next: false},
    timeline: {window: "Events of the trip's plugin session from eventSeq 3 through 8, the event that closed the trip.", rows: [], eventSeqs: windowSeqs, error: null, next: false},
    samples: {rows: [], error: null, next: false, empty: 'No one-second samples were recorded for this trip.'},
    exportDialog: [{window: true, defaultName: 'ets2telemetry-trip-ets2-20270115-0800-8bb4178d.json', absoluteDirectory: true, filters: [{name: 'JSON', extensions: ['json']}]}],
    exportFolder: ['trip.json'],
    exportEvents: [{event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples: 0}}, {event: 'JOURNAL_EXPORT_CANCELLED', facts: null}], exportProblems: [],
    exportRows: {eventSeqs: windowSeqs, intervalIds: ['1', '2'], sampleIds: [], bounds: {committedThroughEventSeq: '13', lastSampleId: null, lastIntervalId: '2', snapshot: false}},
    storedRows: {tripUuid, pluginSessionId: session, databaseUuid, eventSeqs: windowSeqs, intervalIds: ['1', '2'], sampleIds: []},
    exportIds: {tripUuid, pluginSessionId: session, databaseUuid},
    listMatch: true, detailMatch: true, intervalsMatch: true, timelineMatch: true, samplesMatch: true, exportSaved: true, exportCancelledWritesNothing: true,
    exportUnchangedByCancel: true, sampleCountMatch: true, exportValidated: true, exportReconciled: true};
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
      files: {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 3, sidecars: [], syntheticBackups: false, historyDatabase: false, dataDirectory: false},
      database: {integrity: ['ok'], foreignKeyViolations: 0, purpose: 'synthetic', acceptedOrigin: 'synthetic', acknowledgedThrough: '13',
        sessions: [{game: 'ets2', origin: 'synthetic', committedThrough: '13', endReason: null, simulatorSession: true}],
        // ET-016 PR-8: the schema version 2 columns of a trip opened at its job event.
        rows: {trips: [{trip: 'trip@3', jobSource: 'event', checkpointNextEventSeq: null, openedBy: 'event', outcome: 'delivered', recordingCompleteness: 'partial'}], attributions: [{eventSeq: '8', trip: 'trip@3', attribution: 'trip'}],
          intervals: [{trip: 'trip@3', kind: 'discontinuity', detail: {cause: 'opened-at-load', atEventSeq: '3'}}, {trip: 'trip@3', kind: 'not-connected', detail: {cause: 'consumer-restart'}}],
          events: Array.from({length: 13}, (_, index) => ({eventSeq: String(index + 1)})),
          // ET-015b PR-4: without the optional second-1000 row, which the terminated service stores only when its 5 s flush ran.
          sampleRows: [{second: '1001', trip: null}, {second: '1002', trip: null}]}},
      retainedCrashProbe: ['ets2telemetry-probe-a'], journal,
      restartMainEvents: [{event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}],
      restartServiceEvents: [...started(4300, false), ...stopped(4300)]}};
  for (const [path, replacement] of edits) {
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
    // ET-016 PR-8: the stored optional row belongs to trip@3, so run B's journal shows it and its export holds it.
    {name: 'intact recording receipt with the optional sample', body: recordingReceiptWith([
      [['recording', 'database', 'rows', 'sampleRows'], [{second: '1000', trip: 'trip@3'}, {second: '1001', trip: null}, {second: '1002', trip: null}]],
      ...withTripSample()]), scenario: 'recording', code: 0, available: true, reason: null},
    invalid('optional sample stored but not shown in the journal', ['recording', 'database', 'rows', 'sampleRows'],
      [{second: '1000', trip: 'trip@3'}, {second: '1001', trip: null}, {second: '1002', trip: null}]),
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
    invalid('closed-again flag missing', ['recording', 'dashboardClosedBeforeTrayExit']),
    // ET-016 PR-8 journal and export rules, additive.
    invalid('journal facts missing', ['recording', 'journal']),
    invalid('journal list not matched', ['recording', 'journal', 'listMatch'], false),
    invalid('journal detail flag missing', ['recording', 'journal', 'detailMatch']),
    invalid('timeline flag as string', ['recording', 'journal', 'timelineMatch'], 'true'),
    invalid('export not reconciled', ['recording', 'journal', 'exportReconciled'], false),
    invalid('export not validated', ['recording', 'journal', 'exportValidated']),
    invalid('cancel changed the saved file', ['recording', 'journal', 'exportUnchangedByCancel'], false),
    invalid('trip id not a UUID', ['recording', 'journal', 'tripUuid'], 'trip@3'),
    invalid('a second trip listed', ['recording', 'journal', 'list', 'rows', 1], {trip: '8bb4178d-82ba-8b84-fcbc-a83799a54663', outcome: 'Delivered', completeness: 'Partial'}),
    invalid('list without the synthetic banner', ['recording', 'journal', 'list', 'banner'], null),
    invalid('list outcome inferred from completeness', ['recording', 'journal', 'list', 'rows', 0, 'outcome'], 'No outcome — events were lost'),
    invalid('detail shown as complete', ['recording', 'journal', 'detail', 'completeness'], 'Complete'),
    invalid('detail of another trip', ['recording', 'journal', 'detail', 'fields', 'trip-tripId'], '8bb4178d-82ba-8b84-fcbc-a83799a54663'),
    invalid('detail opened by a checkpoint', ['recording', 'journal', 'detail', 'fields', 'trip-openedBy'], 'checkpoint (recording started during the job)'),
    invalid('one completeness interval shown', ['recording', 'journal', 'intervals', 'rows'], [['Discontinuity', 'opened while a save was loading', '—', '—', '—']]),
    invalid('redelivered event shown twice', ['recording', 'journal', 'timeline', 'eventSeqs'], ['3', '4', '5', '5', '6', '7', '8']),
    invalid('timeline past the delivery', ['recording', 'journal', 'timeline', 'eventSeqs'], ['3', '4', '5', '6', '7', '8', '9']),
    invalid('journal sample count without a stored sample', ['recording', 'journal', 'sampleCount'], 1),
    invalid('cancelled export left a partial file', ['recording', 'journal', 'exportFolder'], ['trip.json', 'trip.json.0badc0de.partial']),
    invalid('cancelled export wrote a file', ['recording', 'journal', 'exportFolder'], ['cancelled.json', 'trip.json']),
    invalid('no file saved', ['recording', 'journal', 'exportFolder'], []),
    invalid('cancelled export row missing', ['recording', 'journal', 'exportEvents'], [{event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples: 0}}]),
    invalid('cancel logged as a second save', ['recording', 'journal', 'exportEvents', 1], {event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples: 0}}),
    invalid('saved export with a duplicate event', ['recording', 'journal', 'exportEvents', 0, 'facts', 'events'], 7),
    invalid('validator problems', ['recording', 'journal', 'exportProblems'], ['events[3]: eventSeq repeats an earlier row']),
    invalid('exported eventSeq repeated after the redelivery', ['recording', 'journal', 'exportRows', 'eventSeqs'], ['3', '4', '5', '5', '6', '7', '8']),
    invalid('exported window short of the delivery', ['recording', 'journal', 'exportRows', 'eventSeqs'], ['3', '4', '5', '6', '7']),
    invalid('stored window with a duplicate', ['recording', 'journal', 'storedRows', 'eventSeqs'], ['3', '4', '5', '5', '6', '7', '8']),
    invalid('exported interval ids differ from the stored ones', ['recording', 'journal', 'exportRows', 'intervalIds'], ['1', '3']),
    invalid('exported interval missing', ['recording', 'journal', 'exportRows', 'intervalIds'], ['1']),
    invalid('exported interval id null', ['recording', 'journal', 'exportRows', 'intervalIds'], [null, '1', '2']),
    invalid('exported sample id null', ['recording', 'journal', 'exportRows', 'sampleIds'], [null]),
    invalid('stored interval id null', ['recording', 'journal', 'storedRows', 'intervalIds'], ['1', '2', null]),
    invalid('exported sample not stored for the trip', ['recording', 'journal', 'exportRows', 'sampleIds'], ['1']),
    invalid('stored rows missing', ['recording', 'journal', 'storedRows']),
    invalid('closed trip exported as a snapshot', ['recording', 'journal', 'exportRows', 'bounds', 'snapshot'], true),
    invalid('bounds short of the coverage', ['recording', 'journal', 'exportRows', 'bounds', 'committedThroughEventSeq'], '12'),
    invalid('bounds before the last interval', ['recording', 'journal', 'exportRows', 'bounds', 'lastIntervalId'], '1'),
    invalid('bounds name a sample the trip lacks', ['recording', 'journal', 'exportRows', 'bounds', 'lastSampleId'], '1'),
    invalid('export of another database', ['recording', 'journal', 'exportIds', 'databaseUuid'], '00000000-0000-4000-8000-000000000001'),
    invalid('export of another plugin session', ['recording', 'journal', 'exportIds', 'pluginSessionId'], '00000000-0000-4000-8000-000000000002'),
    invalid('export of another trip', ['recording', 'journal', 'exportIds', 'tripUuid'], '00000000-0000-4000-8000-000000000003'),
    invalid('database UUID missing', ['recording', 'journal', 'exportIds', 'databaseUuid']),
    invalid('stored trip from a checkpoint job', ['recording', 'database', 'rows', 'trips', 0, 'jobSource'], 'checkpoint'),
    invalid('stored trip opened by a checkpoint', ['recording', 'database', 'rows', 'trips', 0, 'openedBy'], 'checkpoint'),
    invalid('stored trip with a checkpoint nextEventSeq', ['recording', 'database', 'rows', 'trips', 0, 'checkpointNextEventSeq'], '4'),
    int64('saved export of 7 events', ['recording', 'journal', 'exportEvents', 0, 'facts', 'events'], 7),
    int64('journal sample count 1 without a stored sample', ['recording', 'journal', 'sampleCount'], 1),
    {name: 'recording optional sample with Int64 integers', body: recordingReceiptWith([
      [['recording', 'database', 'rows', 'sampleRows'], [{second: '1000', trip: 'trip@3'}, {second: '1001', trip: null}, {second: '1002', trip: null}]],
      ...withTripSample()]), scenario: 'recording', numbers: 'int64' as const, code: 0, available: true, reason: null}
  ];
}
/** ET-016 PR-8: run B's journal and export facts when the optional second-1000 row (id 1) was stored for trip@3. */
function withTripSample(): Edit[] {
  return [
    [['recording', 'journal', 'sampleCount'], 1], [['recording', 'journal', 'detail', 'fields', 'samples-sampleCount'], '1'],
    [['recording', 'journal', 'exportEvents', 0, 'facts', 'samples'], 1], [['recording', 'journal', 'exportRows', 'sampleIds'], ['1']],
    [['recording', 'journal', 'exportRows', 'bounds', 'lastSampleId'], '1'], [['recording', 'journal', 'storedRows', 'sampleIds'], ['1']]];
}

// ET-016 PR-4 journal receipts: one intact receipt shaped like a real development run, then single-field corruptions.
function journalReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const main = (): Json[] => [{event: 'APP_START'}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}, {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}];
  const service = (created: boolean): Json[] => [...(created ? [] : [{event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}]), {event: 'STORAGE_VERIFIED'},
    {event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 3, created, migratedFrom: null}},
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
      pagingSamples: {kinds: ['sample'], firstSpeed: '72 km/h', nextOnSecond: true},
      filters: {none: [trip(5), trip(4), trip(3)], noneNext: false, partial: 39, partialNext: false},
      restartLauncherExit: 0, files: {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 3, sidecars: [], syntheticBackups: false},
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

// ET-019 PR-7 refusal receipts: one intact receipt shaped like a real development run, then single-field corruptions. The
// hash is the manifest entry of tests/fixtures/storage/schema-newer-999.sqlite. A function, because `cases` is built above.
function newerFixtureSha256(): string {return '25588c340d06ef351b6c03cb7cf987fa315b7463e8b67bfcb0b50226eae25331';}
function refusalReceipt(path: (string | number)[] = [], replacement?: Json): string {
  const header = (): Json => ({magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 999});
  const refused = (): Json => ({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'SCHEMA_NEWER'});
  const step = (phase: string, name: string): Json => ({event: 'SHUTDOWN_STEP', facts: {phase, name, outcome: 'ok', ms: 0}});
  return corrupt({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'refusal', launcherExit: 0, probesAfterExit: [],
    mainEvents: [{event: 'APP_START'}, {event: 'RECORDING_STATUS', facts: {state: 'disabled'}}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}},
      {event: 'SERVICE_EXIT', detail: {code: 0}}, {event: 'APP_EXIT', detail: {code: 0}}],
    serviceEvents: [{event: 'SERVICE_BOOT'}, {event: 'HISTORY_STORAGE_UNAVAILABLE', facts: {code: 'SCHEMA_NEWER'}}, {event: 'STORAGE_VERIFIED'},
      {event: 'SERVICE_REPORT', detail: {type: 'ready'}}, step('intake', 'ingestion'), step('intake', 'capture'), step('intake', 'v1-ingestion'),
      step('flush', 'recording-flush'), step('storage', 'history-storage'), step('storage', 'storage-probe'), {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}],
    refusal: {placed: {fixture: 'schema-newer-999.sqlite', manifestSha256: newerFixtureSha256(), fixtureSha256After: newerFixtureSha256(), sha256: newerFixtureSha256(),
      bytes: 8192, header: header()}, fixtureUnchanged: true, placedAtHistoryPath: true,
    bridge: {list: refused(), detail: refused(), events: refused()}, bridgeRefused: true,
    health: {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null}, healthConsistent: true,
    recordingText: {headline: 'Off: this version does not record game history', detail: null, losses: null, alert: null,
      notice: 'Prototype live display. No trip recording or durable history.'}, recordingDisabledShown: true,
    journal: {error: 'The database is unavailable: the database was written by a newer version.', empty: null, emptyNote: null, banner: null, rows: 0, next: false,
      previous: false}, journalRefusalShown: true,
    historyEvents: {unavailable: [{code: 'SCHEMA_NEWER'}], opened: 0, closed: 0, targets: 0, historyStep: ['ok']}, recordingStatusRows: [{state: 'disabled'}],
    file: {sha256After: newerFixtureSha256(), bytesAfter: 8192, header: header(), dataEntries: ['telemetry.sqlite'], backups: false}, fileUnchanged: true, shutdownClean: true}},
  path, replacement);
}
function refusalCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `refusal ${name}`, body: refusalReceipt(path, replacement), scenario: 'refusal', code: 0, available: true, reason: 'REFUSAL_RESULT_INCOMPLETE_OR_INVALID'});
  return [
    {name: 'intact refusal receipt', body: refusalReceipt(), scenario: 'refusal', code: 0, available: true, reason: null},
    {name: 'intact refusal receipt with PowerShell 7 Int64 integers', body: refusalReceipt(), scenario: 'refusal', numbers: 'int64' as const, code: 0, available: true, reason: null},
    {name: 'refusal file grown with Int64 integers', body: refusalReceipt(['refusal', 'file', 'bytesAfter'], 12288), scenario: 'refusal', numbers: 'int64' as const, code: 0,
      available: true, reason: 'REFUSAL_RESULT_INCOMPLETE_OR_INVALID'},
    {name: 'scaffold receipt cannot prove the refusal', body: refusalReceipt(['scenarioKind'], 'scaffold'), scenario: 'refusal', code: 0, available: true,
      reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    {name: 'refusal receipt cannot prove the journal', body: refusalReceipt(), scenario: 'journal', code: 0, available: true, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
    invalid('result missing', ['refusal']),
    invalid('journal flag missing', ['refusal', 'journalRefusalShown']),
    invalid('file flag as string', ['refusal', 'fileUnchanged'], 'true'),
    invalid('another fixture placed', ['refusal', 'placed', 'fixture'], 'schema-v2-representative.sqlite'),
    invalid('fixture changed by the copy', ['refusal', 'placed', 'fixtureSha256After'], '0'.repeat(64)),
    invalid('file changed by the open', ['refusal', 'file', 'sha256After'], 'f'.repeat(64)),
    invalid('file grown', ['refusal', 'file', 'bytesAfter'], 12288),
    invalid('file migrated to version 2', ['refusal', 'file', 'header', 'userVersion'], 2),
    invalid('WAL file beside the database', ['refusal', 'file', 'dataEntries'], ['telemetry.sqlite', 'telemetry.sqlite-wal']),
    invalid('shared-memory file beside the database', ['refusal', 'file', 'dataEntries'], ['telemetry.sqlite', 'telemetry.sqlite-shm']),
    invalid('database removed', ['refusal', 'file', 'dataEntries'], []),
    invalid('backup taken', ['refusal', 'file', 'backups'], true),
    invalid('journal list as an empty page', ['refusal', 'bridge', 'list'], {ok: true, value: {database: {purpose: 'history', schemaVersion: 3}, trips: [], nextCursor: null}}),
    invalid('detail refused with another storage code', ['refusal', 'bridge', 'detail', 'storageCode'], 'DATABASE_UNRECOGNIZED'),
    invalid('events still opening', ['refusal', 'bridge', 'events', 'code'], 'DATABASE_OPENING'),
    invalid('Journal tab shows an empty list', ['refusal', 'journal'], {error: null, empty: 'No trips recorded',
      emptyNote: 'Game history recording is off in this version, so no game trips are recorded yet.', banner: null, rows: 0, next: false, previous: false}),
    invalid('Journal tab shows another cause', ['refusal', 'journal', 'error'], 'The database is unavailable: an internal error occurred.'),
    invalid('Journal tab with a row', ['refusal', 'journal', 'rows'], 1),
    invalid('recording shown as stopped', ['refusal', 'recordingText', 'headline'], 'Stopped: the database was written by a newer version. Restart ETS2Telemetry after fixing it'),
    invalid('recording alert shown', ['refusal', 'recordingText', 'alert'], 'Recording problem'),
    invalid('health recording stopped', ['refusal', 'health', 'recording'], {state: 'stopped', target: 'history', code: 'SCHEMA_NEWER',
      losses: {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}, trip: null}),
    invalid('health with a last error', ['refusal', 'health', 'lastError'], 'STORAGE_FAILED'),
    invalid('health self-test failed', ['refusal', 'health', 'storage'], 'failed'),
    // Fix round: the status rows come from main's log, not from the driver's summary.
    invalid('main reported opening', ['mainEvents', 1, 'facts', 'state'], 'opening'),
    invalid('a second status row', ['mainEvents', 5], {event: 'RECORDING_STATUS', facts: {state: 'unknown'}}),
    invalid('status row missing', ['mainEvents', 1], {event: 'DASHBOARD_WINDOW_CREATED'}),
    invalid('status row with a target', ['mainEvents', 1, 'facts', 'target'], 'history'),
    invalid('exit requested from the tray', ['mainEvents', 2, 'facts', 'reason'], 'tray-exit'),
    invalid('exit request missing', ['mainEvents', 2], {event: 'DASHBOARD_WINDOW_CREATED'}),
    invalid('recording detail shown', ['refusal', 'recordingText', 'detail'], ['Synthetic test database (never game history)']),
    invalid('recording losses shown', ['refusal', 'recordingText', 'losses'], ['Gaps recorded since ETS2Telemetry started']),
    invalid('Journal Next enabled', ['refusal', 'journal', 'next'], true),
    invalid('Journal Previous as string', ['refusal', 'journal', 'previous'], 'false'),
    invalid('history step summary empty', ['refusal', 'historyEvents', 'historyStep'], []),
    invalid('history step missing from the log', ['serviceEvents', 8, 'facts', 'name'], 'history-close'),
    invalid('history step logged twice', ['serviceEvents', 11], {event: 'SHUTDOWN_STEP', facts: {phase: 'storage', name: 'history-storage', outcome: 'ok', ms: 0}}),
    invalid('refusal logged twice', ['serviceEvents', 11], {event: 'HISTORY_STORAGE_UNAVAILABLE', facts: {code: 'SCHEMA_NEWER'}}),
    invalid('refused with another code', ['serviceEvents', 1, 'facts', 'code'], 'DATABASE_UNRECOGNIZED'),
    invalid('history opened', ['serviceEvents', 11], {event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 3, created: false, migratedFrom: 999}}),
    invalid('a recording target opened', ['serviceEvents', 0], {event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}}),
    invalid('history step failed', ['serviceEvents', 8, 'facts', 'outcome'], 'failed'),
    invalid('service stopped unclean', ['serviceEvents', 10, 'detail', 'clean'], false),
    invalid('application exited nonzero', ['launcherExit'], 1),
    invalid('a probe left behind', ['probesAfterExit'], ['ets2telemetry-probe-1'])
  ];
}

// ET-018 PR-1 (U11): the installed mode. An intact scaffold receipt of an installed copy, then single-field corruptions
// that must each fail; a packaged receipt cannot stand in for an installed one, nor the reverse.
function installedReceipt(path: (string | number)[] = [], replacement?: Json): string {
  return corrupt({...JSON.parse(scaffoldReceipt()) as Record<string, Json>, mode: 'installed', runtime: {packaged: true},
    installed: {executableMatches: true, cwdOutsideInstall: true, minimalPath: true, developmentVariablesAbsent: true, packaged: true,
      layout: 'ETS2TelemetryDesktop\\app-0.1.1'}, uninstallCard: {warningShown: true, notInstalledShown: null}}, path, replacement);
}
function installedCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `installed ${name}`, body: installedReceipt(path, replacement), scenario: 'scaffold', mode: 'installed', code: 0, available: true, reason: 'INSTALLED_RESULT_INCOMPLETE_OR_INVALID'});
  return [
    {name: 'intact installed scaffold receipt', body: installedReceipt(), scenario: 'scaffold', mode: 'installed', code: 0, available: true, reason: null},
    {name: 'packaged receipt cannot prove an installed run', body: scaffoldReceipt(), scenario: 'scaffold', mode: 'installed', code: 0, available: true, reason: 'DRIVER_RESULT_IDENTITY_MISMATCH'},
    {name: 'installed receipt cannot prove a packaged run', body: installedReceipt(), scenario: 'scaffold', code: 0, available: true, reason: 'DRIVER_RESULT_IDENTITY_MISMATCH'},
    {name: 'installed scaffold receipt still needs the plugin card', body: installedReceipt(['pluginCard', 'controlsDisabled'], false), scenario: 'scaffold', mode: 'installed', code: 0,
      available: true, reason: 'SCAFFOLD_PLUGIN_CARD_INVALID'},
    // ET-018 PR-4: an installed copy's smoke never presses the uninstall button, so it may not claim the not-installed answer.
    {name: 'installed scaffold receipt cannot claim the not-installed answer', body: installedReceipt(['uninstallCard', 'notInstalledShown'], true), scenario: 'scaffold',
      mode: 'installed', code: 0, available: true, reason: 'SCAFFOLD_PLUGIN_CARD_INVALID'},
    {name: 'installed scaffold receipt still needs the uninstall warning', body: installedReceipt(['uninstallCard', 'warningShown'], false), scenario: 'scaffold',
      mode: 'installed', code: 0, available: true, reason: 'SCAFFOLD_PLUGIN_CARD_INVALID'},
    invalid('facts missing', ['installed']),
    invalid('another executable ran', ['installed', 'executableMatches'], false),
    invalid('working directory inside the install', ['installed', 'cwdOutsideInstall'], false),
    invalid('development PATH', ['installed', 'minimalPath'], false),
    invalid('Node options inherited', ['installed', 'developmentVariablesAbsent'], false),
    invalid('a non-boolean flag', ['installed', 'packaged'], 'true'),
    invalid('the portable package layout', ['installed', 'layout'], 'ETS2Telemetry Desktop-win32-x64'),
    invalid('a layout with a path', ['installed', 'layout'], 'C:\\Users\\fixture\\ETS2TelemetryDesktop\\app-0.1.1'),
    invalid('an unpackaged runtime', ['runtime', 'packaged'], false)
  ];
}

// ET-019 PR-11: resource evidence. With a job-result.json named, as the wrapper always names it, a receipt must also carry
// the Job's peak memory, the cold-launch phases and the per-process peak working sets. One intact receipt and job result
// each (numbers from the first local packaged scaffold run), then single-field corruptions that must each fail.
function coldLaunch(refusal = false): Json {
  return {origin: 'main-process-created', originUtc: '2026-10-19T02:14:29.663Z', launchRequestedToOriginMs: 27,
    phasesMs: {mainStarted: 50, mainReady: 100, serviceReady: 198, storageProbeVerified: 198, historyStorageOpened: refusal ? null : 202, firstWindowShown: 252,
      dashboardLoaded: 350, rendererFirstPaint: 397, rendererFirstContentfulPaint: 521, dashboardReadyVisible: 447},
    unavailable: refusal ? {historyStorageOpened: 'HISTORY_STORAGE_OPENED_NOT_LOGGED'} : {}, observationMs: 76};
}
function processMemory(run = 'first'): Json {
  return {run, kinds: {main: {processes: 1, peakWorkingSetBytes: 119435264}, gpu: {processes: 1, peakWorkingSetBytes: 114659328},
    otherUtility: {processes: 1, peakWorkingSetBytes: 48287744}, telemetryService: {processes: 1, peakWorkingSetBytes: 83406848},
    renderer: {processes: 2, peakWorkingSetBytes: 122617856}}, unavailable: {storageWorker: 'WORKER_THREAD_OF_TELEMETRY_SERVICE'}, observationMs: 3};
}
function withResources(receipt: string, refusal = false, run = 'first'): Json {
  return {...JSON.parse(receipt) as Record<string, Json>, coldLaunch: coldLaunch(refusal), processMemory: processMemory(run)};
}
function resourceReceipt(path: (string | number)[] = [], replacement?: Json): string {
  return corrupt(withResources(scaffoldReceipt()), path, replacement);
}
function jobResult(path: (string | number)[] = [], replacement?: Json): string {
  return corrupt({mode: 'packaged', scenario: 'scaffold', exitCode: 0, retries: 0, cpu: {samples: 30},
    memory: {peakProcessMemoryBytes: 187506688, peakJobMemoryBytes: 593268736}}, path, replacement);
}
// A receipt whose cold-launch phase `name` is `value`, with `unavailable` as its reasons.
function withPhase(name: string, value: Json, unavailable: Json = {}): string {
  const launch = coldLaunch() as {phasesMs: Record<string, Json>};
  return corrupt(withResources(scaffoldReceipt()), ['coldLaunch'], {...launch, phasesMs: {...launch.phasesMs, [name]: value}, unavailable});
}
function resourceCases() {
  const reason = 'RESOURCE_EVIDENCE_INCOMPLETE_OR_INVALID';
  const valid = {scenario: 'scaffold', code: 0, available: true, reason: null};
  const rejected = {scenario: 'scaffold', code: 0, available: true, reason};
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `resource ${name}`, body: resourceReceipt(path, replacement), jobResult: jobResult(), ...rejected});
  const invalidJob = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `resource ${name}`, body: resourceReceipt(), jobResult: jobResult(path, replacement), ...rejected});
  return [
    {name: 'intact scaffold receipt with resource evidence', body: resourceReceipt(), jobResult: jobResult(), ...valid},
    {name: 'intact refusal receipt with resource evidence and no history opening', body: JSON.stringify(withResources(refusalReceipt(), true)), jobResult: jobResult(),
      ...valid, scenario: 'refusal'},
    {name: 'intact lifecycle receipt with the restart run\'s process memory', body: JSON.stringify(withResources(lifecycleReceipt(), false, 'restart')), jobResult: jobResult(),
      ...valid, scenario: 'lifecycle'},
    {name: 'intact resource evidence with PowerShell 7 Int64 integers', body: resourceReceipt(), jobResult: jobResult(), numbers: 'int64' as const, ...valid},
    {name: 'resource Job peak in KiB with Int64 integers', body: resourceReceipt(), jobResult: jobResult(['memory', 'peakJobMemoryBytes'], 579364), numbers: 'int64' as const,
      ...rejected},
    // Timer-tick skew between the V8 launch request and the kernel creation time may measure a little below zero.
    {name: 'intact resource evidence with a small negative clock skew', body: resourceReceipt(['coldLaunch', 'launchRequestedToOriginMs'], -16), jobResult: jobResult(), ...valid},
    {name: 'intact resource evidence at the clock skew bound', body: resourceReceipt(['coldLaunch', 'launchRequestedToOriginMs'], -1000), jobResult: jobResult(), ...valid},
    {name: 'intact resource evidence with the launch request as origin', body: resourceReceipt(['coldLaunch', 'origin'], 'launch-requested'), jobResult: jobResult(), ...valid},
    {name: 'intact resource evidence with an unrecorded paint', jobResult: jobResult(), ...valid,
      body: withPhase('rendererFirstContentfulPaint', null, {rendererFirstContentfulPaint: 'FIRST_CONTENTFUL_PAINT_NOT_RECORDED'})},
    {name: 'resource evidence never hides a failed driver', body: resourceReceipt(['passed'], false), jobResult: jobResult(), ...rejected, reason: 'DRIVER_FAILED'},
    {name: 'resource evidence never hides a failed scaffold card', body: resourceReceipt(['pluginCard', 'controlsDisabled'], false), jobResult: jobResult(), ...rejected,
      reason: 'SCAFFOLD_PLUGIN_CARD_INVALID'},
    {name: 'resource job result missing', body: resourceReceipt(), jobResult: null, ...rejected},
    {name: 'resource job result malformed', body: resourceReceipt(), jobResult: '{invalid', ...rejected},
    {name: 'resource job result as an array', body: resourceReceipt(), jobResult: '[]', ...rejected},
    invalidJob('Job memory missing', ['memory']),
    invalidJob('Job memory unavailable', ['memory'], {error: 'JOB_MEMORY_UNAVAILABLE'}),
    invalidJob('Job peak in KiB', ['memory', 'peakJobMemoryBytes'], 579364),
    invalidJob('Job peak in MiB', ['memory', 'peakJobMemoryBytes'], 566),
    invalidJob('Job peak negative', ['memory', 'peakJobMemoryBytes'], -593268736),
    invalidJob('Job peak above the 2 GiB limit', ['memory', 'peakJobMemoryBytes'], 2147483649),
    invalidJob('Job peak fractional', ['memory', 'peakJobMemoryBytes'], 593268736.5),
    invalidJob('Job peak as string', ['memory', 'peakJobMemoryBytes'], '593268736'),
    invalidJob('process peak missing', ['memory', 'peakProcessMemoryBytes']),
    invalidJob('process peak above the Job peak', ['memory', 'peakProcessMemoryBytes'], 593268737),
    invalidJob('Job memory with an extra field', ['memory', 'path'], 'C:\\Users\\fixture'),
    invalid('cold launch missing', ['coldLaunch']),
    invalid('unknown origin', ['coldLaunch', 'origin'], 'unavailable'),
    invalid('origin time missing', ['coldLaunch', 'originUtc']),
    invalid('origin time not ISO', ['coldLaunch', 'originUtc'], 'Mon Oct 19 2026'),
    invalid('launch request after the origin beyond the clock skew bound', ['coldLaunch', 'launchRequestedToOriginMs'], -1001),
    invalid('a phase missing', ['coldLaunch', 'phasesMs', 'serviceReady']),
    invalid('an extra phase', ['coldLaunch', 'phasesMs', 'installPath'], 10),
    invalid('a phase negative', ['coldLaunch', 'phasesMs', 'firstWindowShown'], -5),
    invalid('a phase in microseconds', ['coldLaunch', 'phasesMs', 'dashboardLoaded'], 350000),
    invalid('a phase fractional', ['coldLaunch', 'phasesMs', 'mainReady'], 100.5),
    invalid('a phase as string', ['coldLaunch', 'phasesMs', 'mainStarted'], '50'),
    invalid('phases missing', ['coldLaunch', 'phasesMs']),
    invalid('reasons missing', ['coldLaunch', 'unavailable']),
    {name: 'resource required phase unavailable', body: withPhase('serviceReady', null, {serviceReady: 'SERVICE_READY_NOT_LOGGED'}), jobResult: jobResult(), ...rejected},
    {name: 'resource paint unavailable without a reason', body: withPhase('rendererFirstPaint', null), jobResult: jobResult(), ...rejected},
    {name: 'resource paint reason not a fixed code', body: withPhase('rendererFirstPaint', null, {rendererFirstPaint: 'not painted in C:\\fixture'}), jobResult: jobResult(),
      ...rejected},
    {name: 'resource reason for a recorded phase', body: withPhase('rendererFirstPaint', 397, {rendererFirstPaint: 'FIRST_PAINT_NOT_RECORDED'}), jobResult: jobResult(), ...rejected},
    {name: 'resource scaffold without a history opening', body: withPhase('historyStorageOpened', null, {historyStorageOpened: 'HISTORY_STORAGE_OPENED_NOT_LOGGED'}),
      jobResult: jobResult(), ...rejected},
    {name: 'resource refusal with a history opening', body: corrupt(withResources(refusalReceipt(), true), ['coldLaunch'], coldLaunch()), jobResult: jobResult(), ...rejected,
      scenario: 'refusal'},
    invalid('process memory missing', ['processMemory']),
    invalid('process memory from the wrong run', ['processMemory', 'run'], 'restart'),
    {name: 'resource lifecycle process memory from the first run', body: JSON.stringify(withResources(lifecycleReceipt())), jobResult: jobResult(), ...rejected,
      scenario: 'lifecycle'},
    invalid('telemetry service missing', ['processMemory', 'kinds', 'telemetryService']),
    invalid('renderer missing', ['processMemory', 'kinds', 'renderer']),
    invalid('main peak in KiB', ['processMemory', 'kinds', 'main', 'peakWorkingSetBytes'], 116636),
    invalid('main peak negative', ['processMemory', 'kinds', 'main', 'peakWorkingSetBytes'], -1),
    invalid('two main processes', ['processMemory', 'kinds', 'main', 'processes'], 2),
    invalid('a kind with no process', ['processMemory', 'kinds', 'gpu', 'processes'], 0),
    invalid('an unknown process kind', ['processMemory', 'kinds', 'storageWorker'], {processes: 1, peakWorkingSetBytes: 1048576}),
    invalid('storage worker note missing', ['processMemory', 'unavailable'])
  ];
}

it('requires an intact current driver receipt and normal Job exit without overwriting failed evidence', async () => {
  const resources = await temporaryResources();
  try {
    const receipts = cases.map((_, index) => path.join(resources.directory, `receipt-${index}.json`));
    for (const [index, scenario] of cases.entries()) if (scenario.body !== undefined) await writeFile(receipts[index], scenario.body);
    // ET-019 PR-11: a case's job-result.json; null names the file without writing it.
    const jobResults = cases.map((_, index) => path.join(resources.directory, `job-result-${index}.json`));
    for (const [index, scenario] of cases.entries()) if ('jobResult' in scenario && typeof scenario.jobResult === 'string') await writeFile(jobResults[index], scenario.jobResult);
    // All cases share one PowerShell 5.1 validator process; see tests/shared/runtime-receipt-validator.ts.
    const results = await validateRuntimeReceipts(resources.directory, cases.map((scenario, index) =>
      ({receipt: receipts[index], code: scenario.code, ...('scenario' in scenario ? {scenario: scenario.scenario} : {}),
        ...('numbers' in scenario ? {numbers: scenario.numbers} : {}), ...('mode' in scenario ? {mode: String(scenario.mode)} : {}),
        ...('jobResult' in scenario ? {jobResult: jobResults[index]} : {})})));
    for (const [index, scenario] of cases.entries()) {
      expect(results[index], scenario.name).toMatchObject({passed: scenario.reason === null,
        driverResultAvailable: scenario.available, reason: scenario.reason});
      if (scenario.body !== undefined) expect(await readFile(receipts[index], 'utf8'), scenario.name).toBe(scenario.body);
    }
  } finally {await resources.dispose();}
}, receiptBatchTimeout(cases.length) + 5000);

function hardModeCases() {
  const hardMode = {unknown: true, fail: true, pass: true, hints: true, hover: true, drawer: true, bilingual: true, languageHotChange: true, keyboard: true, refresh: true, lost: true, restoredLost: true, irreversible: true, badge: true,
    export: true, overlayExcluded: true, persisted: true, schemaVersion: 3, flags: [false, true], errors: []};
  const body = (value: unknown) => JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'hard-mode', hardMode: value});
  const accepted = {scenario: 'hard-mode', code: 0, available: true, reason: null};
  const rejected = {...accepted, reason: 'HARD_MODE_RESULT_INVALID'};
  return [{name: 'intact Hard Mode receipt', body: body(hardMode), ...accepted},
    ...['unknown','fail','pass','hints','hover','drawer','bilingual','languageHotChange','keyboard','refresh','lost','restoredLost','irreversible','badge','export','overlayExcluded','persisted'].flatMap(field => [
      {name: `Hard Mode missing ${field}`, body: body({...hardMode, [field]: undefined}), ...rejected},
      {name: `Hard Mode false ${field}`, body: body({...hardMode, [field]: false}), ...rejected}]),
    {name: 'Hard Mode false delivered flag', body: body({...hardMode, flags: [false, false]}), ...rejected},
    {name: 'Hard Mode numeric flag', body: body({...hardMode, flags: [0, true]}), ...rejected},
    {name: 'Hard Mode old schema', body: body({...hardMode, schemaVersion: 2}), ...rejected}];
}
