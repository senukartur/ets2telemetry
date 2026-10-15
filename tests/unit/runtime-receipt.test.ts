import {it, expect} from 'vitest';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

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
    mainEvents: [...orderlyMain(), {event: 'SECOND_INSTANCE', facts: {action: 'created'}}, {event: 'APP_EXIT_REQUESTED', facts: {reason: 'renderer'}}],
    serviceEvents: orderlyService(),
    lifecycle: {dashboardClosedServiceAlive: true, overlayAliveAfterClose: true, trayPresentAfterClose: true, overlayCurrentAfterClose: true,
      sourceConnectionPreserved: true, secondInstanceRestoredDashboard: true, trayOpenRestoredDashboard: true, explicitExitOrderly: true,
      restartRecovered: true, shutdownClean: true, servicePid: 4100,
      afterClose: {servicePid: 4100, dashboard: false, exiting: false, overlay: true, tray: true, upstream: true},
      overlayChanged: reading('72.0', '71.0'), overlayRestored: reading('90.0', '73.0'),
      secondInstance: {pid: 4200, exitCode: 0, signal: null, exitMilliseconds: 164, wroteLog: false, primaryActions: ['created']},
      explicitExit: {launcherExit: 0, signal: null, exitMilliseconds: 179, requests: ['renderer']},
      restart: {servicePid: 4300}, restartLauncherExit: 0,
      restartMainEvents: [...orderlyMain(), {event: 'APP_EXIT_REQUESTED', facts: {reason: 'app-quit'}}], restartServiceEvents: orderlyService()}};
  if (path.length) {
    let target = value as Record<string | number, Json>;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, Json>;
    const last = path.at(-1)!;
    if (replacement === undefined) delete target[last]; else target[last] = replacement;
  }
  return JSON.stringify(value);
}
function lifecycleCases() {
  const invalid = (name: string, path: (string | number)[], replacement?: Json) =>
    ({name: `lifecycle ${name}`, body: lifecycleReceipt(path, replacement), scenario: 'lifecycle', code: 0, available: true, reason: 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'});
  return [
    {name: 'intact lifecycle receipt', body: lifecycleReceipt(), scenario: 'lifecycle', code: 0, available: true, reason: null},
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
    invalid('second application exit event', ['mainEvents', 4], {event: 'APP_EXIT', detail: {code: 0}}),
    invalid('failure event', ['mainEvents', 4], {event: 'SERVICE_START_FAILED'}),
    invalid('restart reused the service', ['lifecycle', 'restart', 'servicePid'], 4100),
    invalid('restart events missing', ['lifecycle', 'restartMainEvents']),
    invalid('restart closed nonzero', ['lifecycle', 'restartLauncherExit'], 1),
    invalid('probe left behind', ['probesAfterExit', 0], 'ets2telemetry-probe-x')
  ];
}

it('requires an intact current driver receipt and normal Job exit without overwriting failed evidence', async () => {
  const resources = await temporaryResources();
  try {
    const receipts = cases.map((_, index) => path.join(resources.directory, `receipt-${index}.json`));
    for (const [index, scenario] of cases.entries()) if (scenario.body !== undefined) await writeFile(receipts[index], scenario.body);
    // All cases share one PowerShell 5.1 validator process; see tests/shared/runtime-receipt-validator.ts.
    const results = await validateRuntimeReceipts(resources.directory, cases.map((scenario, index) =>
      ({receipt: receipts[index], code: scenario.code, ...('scenario' in scenario ? {scenario: scenario.scenario} : {})})));
    for (const [index, scenario] of cases.entries()) {
      expect(results[index], scenario.name).toMatchObject({passed: scenario.reason === null,
        driverResultAvailable: scenario.available, reason: scenario.reason});
      if (scenario.body !== undefined) expect(await readFile(receipts[index], 'utf8'), scenario.name).toBe(scenario.body);
    }
  } finally {await resources.dispose();}
}, receiptBatchTimeout(cases.length) + 5000);
