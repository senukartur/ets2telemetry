import type {ChildProcess} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {describe, expect, it} from 'vitest';
import {nodeExecFile, type ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';
import {listProcesses, TASKLIST_TIMEOUT_MS} from '../../apps/desktop/src/plugin-setup/game-processes';

// REG-015: the actual host boundary runs after the parallel unit group, with the unchanged product limits.
// Enumeration remains real and unfiltered; only diagnostics omit raw process names/output.
describe('the real fixed tasklist call', () => {
  // A hang guard above TASKLIST_TIMEOUT_MS, so a slow listing on a loaded host fails as the product's own timeout, not as
  // Vitest's default 5 s case timeout.
  const REAL_RUN_GUARD_MS = 20_000;
  it.runIf(process.platform === 'win32')('lists its own node.exe in a real run', async () => {
    expect(REAL_RUN_GUARD_MS).toBeGreaterThan(TASKLIST_TIMEOUT_MS);
    const started = performance.now(), metrics: {spawnMs?: number; exitMs?: number; callbackMs?: number; stdoutBytes?: number; reason?: string} = {};
    const measured: ExecFilePort = (file, args, options, callback) => {
      const child = nodeExecFile(file, args, options, (error, stdout, stderr) => {
        metrics.callbackMs = Math.round(performance.now() - started); metrics.stdoutBytes = stdout.length;
        callback(error, stdout, stderr);
      }) as ChildProcess;
      child.once('spawn', () => {metrics.spawnMs = Math.round(performance.now() - started);});
      child.once('exit', () => {metrics.exitMs = Math.round(performance.now() - started);});
      return child;
    };
    const listing = await listProcesses({execFile: measured});
    if (!listing.ok) metrics.reason = listing.reason;
    // Sanitized host-boundary diagnostics, never process names or raw tasklist output. No latency is asserted.
    console.info('TASKLIST_REAL_RUN', JSON.stringify({ok: listing.ok, ...metrics}));
    expect(listing).toMatchObject({ok: true});
    if (!listing.ok) return;
    expect(listing.rows.filter(entry => entry.pid === process.pid).map(entry => entry.name.toLowerCase())).toEqual(['node.exe']);
  }, REAL_RUN_GUARD_MS);
});
