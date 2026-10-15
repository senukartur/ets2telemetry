import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

/** `numbers: 'int64'` validates a lifecycle receipt with PowerShell 7's Int64 JSON integers. */
export type RuntimeReceiptCase = {receipt: string; code: number; scenario?: string; numbers?: 'int64'};
export type RuntimeReceiptResult = {passed?: boolean; driverResultAvailable?: boolean; reason?: string | null; error?: string};

// Measured budgets for one batch; docs/ci.md#powershell-validator-test-budgets records the evidence.
// A separate process per case cost 0.44-0.67 s on hosted runners and pushed 46 cases past 30 s. Locally one batch
// costs about 0.5 s to start and 13 ms per case; each budget allows roughly 20x that.
export const RECEIPT_BATCH_STARTUP_MS = 10000;
export const RECEIPT_BATCH_PER_CASE_MS = 250;
export const receiptBatchTimeout = (cases: number) => RECEIPT_BATCH_STARTUP_MS + RECEIPT_BATCH_PER_CASE_MS * cases;

// Validates every case in one Windows PowerShell 5.1 process with the production Test-RuntimeReceipt.
export async function validateRuntimeReceipts(directory: string, cases: RuntimeReceiptCase[]): Promise<RuntimeReceiptResult[]> {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const configuration = path.join(directory, 'receipt-cases.json');
  await writeFile(configuration, JSON.stringify({cases}));
  const {stdout} = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('tests/shared/Read-RuntimeReceipt.ps1'), '-Configuration', configuration],
  {encoding: 'utf8', timeout: receiptBatchTimeout(cases.length), windowsHide: true, env: {...process.env, PSModulePath: ''}});
  const results: unknown = JSON.parse(stdout);
  if (!Array.isArray(results) || results.length !== cases.length) throw new Error(`Expected ${cases.length} receipt results: ${stdout}`);
  return results as RuntimeReceiptResult[];
}
