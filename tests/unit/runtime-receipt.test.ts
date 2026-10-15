import {it, expect} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

// The index that appends a row to run A's lifecycle main events; ET-011b added three settings rows after the original four.
const MAIN_EVENTS_APPEND = 7;
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
  ...lifecycleCases()
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
