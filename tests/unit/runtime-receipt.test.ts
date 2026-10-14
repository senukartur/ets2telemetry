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
  {name: 'matching telemetry scenario', body: JSON.stringify({passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'telemetry'}), scenario: 'telemetry', code: 0, available: true, reason: null}
];

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
