import {expect, it} from 'vitest';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// The summarizer is CI JavaScript outside the application TypeScript project.
const {summarizeJobCpu} = await import(pathToFileURL(path.resolve('scripts/ci/job-cpu-summary.mjs')).href) as
  {summarizeJobCpu(text: string, options?: {bucketMs?: number}): Record<string, unknown>};
const header = {type: 'start', utc: '2026-10-14T19:37:49.400Z', elapsedMs: 0, logicalProcessors: 2, jobCpuRatePercent: 25, intervalMs: 100};
const series = (rows: object[]) => [header, ...rows].map(row => JSON.stringify(row)).join('\r\n') + '\r\n';
const sample = (elapsedMs: number, jobCpuMs: number, systemBusyMs: number) => ({elapsedMs, jobCpuMs, activeProcesses: 8, systemBusyMs, systemIdleMs: 0});

it('reports per-second Job and system processor use against the hard cap', () => {
  // First second: the Job runs at its 0.5-processor cap. Second: the Job is idle while the system is busy.
  const summary = summarizeJobCpu(series([sample(0, 0, 0), sample(500, 250, 500), sample(1000, 500, 1000), sample(2000, 510, 2900)]));
  expect(summary).toEqual({startUtc: header.utc, logicalProcessors: 2, jobCpuRatePercent: 25, capProcessors: 0.5, samples: 4, elapsedMs: 2000,
    jobCpuMs: 510, averageJobProcessors: 0.26, peakJobProcessors: 0.5, peakSystemBusyProcessors: 1.9,
    perSecond: [{fromMs: 0, toMs: 1000, jobProcessors: 0.5, systemBusyProcessors: 1, activeProcesses: 8},
      {fromMs: 1000, toMs: 2000, jobProcessors: 0.01, systemBusyProcessors: 1.9, activeProcesses: 8}]});
});
it('keeps a partial final interval and tolerates a series with no elapsed time', () => {
  const summary = summarizeJobCpu(series([sample(0, 0, 0), sample(1200, 300, 600), sample(1500, 300, 900)]));
  expect(summary.perSecond).toEqual([{fromMs: 0, toMs: 1200, jobProcessors: 0.25, systemBusyProcessors: 0.5, activeProcesses: 8},
    {fromMs: 1200, toMs: 1500, jobProcessors: 0, systemBusyProcessors: 1, activeProcesses: 8}]);
  expect(summarizeJobCpu(series([sample(5, 1, 1)]))).toMatchObject({samples: 1, elapsedMs: 5, perSecond: []});
  expect(summarizeJobCpu(series([sample(5, 1, 1), sample(5, 1, 1)]))).toMatchObject({peakJobProcessors: 0, perSecond: []});
});
// ET-019 PR-12b: the soak summarizes its series in 10 s buckets, so job-result.json stays small for up to 95 minutes.
it('summarizes a long series in buckets on request, beside the unchanged per-second default', () => {
  const rows = series([sample(0, 0, 0), sample(4000, 2000, 4000), sample(10_000, 2600, 10_000), sample(12_000, 2600, 14_000)]);
  expect(summarizeJobCpu(rows, {bucketMs: 10_000})).toEqual({startUtc: header.utc, logicalProcessors: 2, jobCpuRatePercent: 25, capProcessors: 0.5, samples: 4,
    elapsedMs: 12_000, jobCpuMs: 2600, averageJobProcessors: 0.22, peakJobProcessors: 0.26, peakSystemBusyProcessors: 2, bucketMs: 10_000,
    perBucket: [{fromMs: 0, toMs: 10_000, jobProcessors: 0.26, systemBusyProcessors: 1, activeProcesses: 8},
      {fromMs: 10_000, toMs: 12_000, jobProcessors: 0, systemBusyProcessors: 2, activeProcesses: 8}]});
  expect(summarizeJobCpu(rows)).not.toHaveProperty('perBucket');
  expect(summarizeJobCpu(rows).perSecond).toHaveLength(3);
  expect(summarizeJobCpu(series([sample(5, 1, 1)]), {bucketMs: 10_000})).toMatchObject({samples: 1, bucketMs: 10_000, perBucket: []});
  for (const bucketMs of [999, 60_001, 1500.5]) expect(() => summarizeJobCpu(rows, {bucketMs})).toThrow('CPU_SERIES_BUCKET_INVALID');
});
it('rejects a series that is not the BoundedProcess format', () => {
  expect(() => summarizeJobCpu('')).toThrow('CPU_SERIES_HEADER_INVALID');
  expect(() => summarizeJobCpu(JSON.stringify(sample(0, 0, 0)))).toThrow('CPU_SERIES_HEADER_INVALID');
  expect(() => summarizeJobCpu(series([{elapsedMs: 0}]))).toThrow('CPU_SERIES_SAMPLE_INVALID');
  expect(() => summarizeJobCpu(series([sample(0, 10, 0), sample(100, 5, 0)]))).toThrow('CPU_SERIES_NOT_CUMULATIVE');
});
