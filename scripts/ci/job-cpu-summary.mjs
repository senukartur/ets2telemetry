import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Summarizes the Job CPU series that BoundedProcess writes as job/cpu.jsonl. Diagnostic only: the
// smoke result never depends on it. "Processors" are CPU-milliseconds per wall millisecond, so the
// Job's hard cap is jobCpuRatePercent / 100 * logicalProcessors.
const round = value => Math.round(value * 100) / 100;
/** ET-019 PR-12b: the allowed bucket lengths of a long series (`--bucket-ms`), which keep job-result.json small. */
export const MIN_BUCKET_MS = 1000;
export const MAX_BUCKET_MS = 60_000;

/**
 * Without options, one row per whole second in `perSecond`, as every runtime smoke records it. With `bucketMs` (ET-019
 * PR-12b, the soak), one row per bucket of that many milliseconds in `perBucket`, and `bucketMs` beside it.
 */
export function summarizeJobCpu(text, {bucketMs} = {}) {
  if (bucketMs !== undefined && (!Number.isSafeInteger(bucketMs) || bucketMs < MIN_BUCKET_MS || bucketMs > MAX_BUCKET_MS)) throw new Error('CPU_SERIES_BUCKET_INVALID');
  const bucket = bucketMs ?? 1000, rowsKey = bucketMs === undefined ? 'perSecond' : 'perBucket', bucketFields = bucketMs === undefined ? {} : {bucketMs};
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const header = rows[0];
  if (header?.type !== 'start' || !Number.isInteger(header.logicalProcessors) || header.logicalProcessors < 1) throw new Error('CPU_SERIES_HEADER_INVALID');
  const samples = rows.slice(1);
  for (const [index, row] of samples.entries()) {
    if (!['elapsedMs', 'jobCpuMs', 'systemBusyMs', 'systemIdleMs', 'activeProcesses'].every(key => Number.isFinite(row[key]))) throw new Error('CPU_SERIES_SAMPLE_INVALID');
    if (index > 0 && (row.elapsedMs < samples[index - 1].elapsedMs || row.jobCpuMs < samples[index - 1].jobCpuMs)) throw new Error('CPU_SERIES_NOT_CUMULATIVE');
  }
  const summary = {startUtc: header.utc, logicalProcessors: header.logicalProcessors, jobCpuRatePercent: header.jobCpuRatePercent,
    capProcessors: round(header.jobCpuRatePercent / 100 * header.logicalProcessors), samples: samples.length};
  if (samples.length < 2) return {...summary, elapsedMs: samples[0]?.elapsedMs ?? 0, jobCpuMs: samples[0]?.jobCpuMs ?? 0, ...bucketFields, [rowsKey]: []};
  // One row per whole second (or bucket) of elapsed time: the Job's and the whole system's average processors in use.
  const perSecond = [];
  let from = samples[0];
  for (const row of samples) {
    if (row.elapsedMs - from.elapsedMs < bucket && row !== samples.at(-1)) continue;
    const wall = row.elapsedMs - from.elapsedMs;
    if (wall > 0) perSecond.push({fromMs: from.elapsedMs, toMs: row.elapsedMs, jobProcessors: round((row.jobCpuMs - from.jobCpuMs) / wall),
      systemBusyProcessors: round((row.systemBusyMs - from.systemBusyMs) / wall), activeProcesses: row.activeProcesses});
    from = row;
  }
  const last = samples.at(-1), first = samples[0];
  return {...summary, elapsedMs: last.elapsedMs, jobCpuMs: round(last.jobCpuMs),
    averageJobProcessors: round((last.jobCpuMs - first.jobCpuMs) / Math.max(1, last.elapsedMs - first.elapsedMs)),
    peakJobProcessors: Math.max(0, ...perSecond.map(row => row.jobProcessors)),
    peakSystemBusyProcessors: Math.max(0, ...perSecond.map(row => row.systemBusyProcessors)), ...bucketFields, [rowsKey]: perSecond};
}

// Usage: node job-cpu-summary.mjs <cpu.jsonl> [--bucket-ms <1000-60000>]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, flag, value] = process.argv.slice(2);
  if (flag !== undefined && (flag !== '--bucket-ms' || !/^[0-9]{4,5}$/.test(value ?? '') || process.argv.length > 6)) throw new Error('Usage: job-cpu-summary.mjs <cpu.jsonl> [--bucket-ms <1000-60000>]');
  process.stdout.write(JSON.stringify(summarizeJobCpu(await readFile(file, 'utf8'), flag === undefined ? {} : {bucketMs: Number(value)})) + '\n');
}
