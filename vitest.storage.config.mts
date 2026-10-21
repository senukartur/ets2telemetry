import path from 'node:path';
import {BaseSequencer, type TestSpecification} from 'vitest/node';
import {configDefaults, defineConfig} from 'vitest/config';
// Storage suite: loads native better-sqlite3, so it runs only under the pinned Electron executable in Node mode
// through `npm run test:storage` (scripts/run-electron-node.mjs). It is not part of `npm test`, whose Node-safe corpus
// must never load native SQLite. This file and tests/storage/setup.ts both refuse any other runtime.
const PINNED_ELECTRON = '44.7.0';
if (process.versions.electron !== PINNED_ELECTRON) {
  throw new Error(`Storage suite requires Electron ${PINNED_ELECTRON} in Node mode; found ${process.versions.electron ?? 'plain Node'}. Run npm run test:storage.`);
}
console.log(`Storage suite runtime: Electron ${process.versions.electron}, Node ${process.versions.node}, module ABI ${process.versions.modules}`);

/**
 * Known-long storage files, started first in this order. CI keeps no Vitest results cache, so the default order runs
 * larger files first, so journal-scale.test.ts (24th of 33 by size) started late and finished last; its build was the tail of the hosted step
 * (docs/validation/et-019.md, storage suite headroom). File times in the hosted JUnit of green run 39174886200 and the
 * failed attempt 1 of run 39174985694, October 18, 2026: journal-scale 34.8 / 99.1 s, events-commit 20.6 / 58.1 s,
 * producer-loss 13.9 / 42.2 s, trip-recorder-crash 25.7 / 41.5 s, journal-export 12.8 / 29.7 s, worker 19.7 / 20.3 s,
 * trip-recorder 17.0 / 19.4 s, journal-reads 18.2 / 18.1 s. A listed file that no longer exists is ignored.
 */
const LONG_FIRST = [
  'tests/storage/journal-scale.test.ts', 'tests/storage/events-commit.test.ts', 'tests/storage/producer-loss.test.ts', 'tests/storage/trip-recorder-crash.test.ts',
  'tests/storage/journal-export.test.ts', 'tests/storage/worker.test.ts', 'tests/storage/trip-recorder.test.ts', 'tests/storage/journal-reads.test.ts'
];
/** The default order with LONG_FIRST moved to the front; sharding is inherited from BaseSequencer unchanged. */
class LongFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (file: TestSpecification) => {
      const index = LONG_FIRST.indexOf(path.relative(file.project.config.root, file.moduleId).split(path.sep).join('/'));
      return index === -1 ? LONG_FIRST.length : index;
    };
    // Array.prototype.sort is stable, so the files outside the list keep the default order.
    return (await super.sort(files)).sort((a, b) => rank(a) - rank(b));
  }
}

const runtime = {setupFiles: ['tests/storage/setup.ts'], pool: 'forks' as const, testTimeout: 30_000, hookTimeout: 30_000};
export default defineConfig({test: {sequence: {sequencer: LongFirstSequencer}, projects: [
  {test: {...runtime, name: 'storage', include: ['tests/storage/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/storage/shutdown-stalls.test.ts'], sequence: {groupOrder: 0}}},
  // Keep real shutdown deadlines independent of this suite's other file forks, as for the unit host-boundary group.
  // All four scenarios retain their real timers, worker/pipe concurrency, limits and assertions.
  {test: {...runtime, name: 'storage-shutdown', include: ['tests/storage/shutdown-stalls.test.ts'],
    sequence: {groupOrder: 1}, fileParallelism: false, maxWorkers: 1}}
]}});
