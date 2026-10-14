import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Summarizes the Job CPU series that BoundedProcess writes as job/cpu.jsonl. Diagnostic only: the
// smoke result never depends on it. "Processors" are CPU-milliseconds per wall millisecond, so the
// Job's hard cap is jobCpuRatePercent / 100 * logicalProcessors.
const round = value => Math.round(value * 100) / 100;

export function summarizeJobCpu(text) {
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
  if (samples.length < 2) return {...summary, elapsedMs: samples[0]?.elapsedMs ?? 0, jobCpuMs: samples[0]?.jobCpuMs ?? 0, perSecond: []};
  // One row per whole second of elapsed time: the Job's and the whole system's average processors in use.
  const perSecond = [];
  let from = samples[0];
  for (const row of samples) {
    if (row.elapsedMs - from.elapsedMs < 1000 && row !== samples.at(-1)) continue;
    const wall = row.elapsedMs - from.elapsedMs;
    if (wall > 0) perSecond.push({fromMs: from.elapsedMs, toMs: row.elapsedMs, jobProcessors: round((row.jobCpuMs - from.jobCpuMs) / wall),
      systemBusyProcessors: round((row.systemBusyMs - from.systemBusyMs) / wall), activeProcesses: row.activeProcesses});
    from = row;
  }
  const last = samples.at(-1), first = samples[0];
  return {...summary, elapsedMs: last.elapsedMs, jobCpuMs: round(last.jobCpuMs),
    averageJobProcessors: round((last.jobCpuMs - first.jobCpuMs) / Math.max(1, last.elapsedMs - first.elapsedMs)),
    peakJobProcessors: Math.max(0, ...perSecond.map(row => row.jobProcessors)),
    peakSystemBusyProcessors: Math.max(0, ...perSecond.map(row => row.systemBusyProcessors)), perSecond};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(JSON.stringify(summarizeJobCpu(await readFile(process.argv[2], 'utf8'))) + '\n');
}
