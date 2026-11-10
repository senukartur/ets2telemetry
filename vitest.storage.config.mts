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
 * Start the known-long files first: hosted runs 42532653711 / 42524195583 took 191 / 134 s for continuation,
 * 99 / 74 s for scale, 84 / 57 s for upload queue and 76 / 41 s for upload projection. Continuation previously
 * started about 68 s into the storage step. Keep the remaining established order and the inherited fallback.
 */
const LONG_FIRST = [
  'tests/storage/trip-continuation.test.ts', 'tests/storage/journal-scale.test.ts', 'tests/storage/upload-queue.test.ts', 'tests/storage/upload-projection.test.ts',
  'tests/storage/trip-recorder-crash.test.ts', 'tests/storage/upload-projection-crash.test.ts', 'tests/storage/events-commit.test.ts', 'tests/storage/trip-recorder.test.ts',
  'tests/storage/worker.test.ts', 'tests/storage/producer-loss.test.ts', 'tests/storage/stale-checkpoint.test.ts', 'tests/storage/history-refusal.test.ts',
  'tests/storage/crash-recovery.test.ts', 'tests/storage/journal-export.test.ts', 'tests/storage/journal-reads.test.ts', 'tests/storage/trip-recorder-faults.test.ts',
  'tests/storage/trip-effects.test.ts', 'tests/storage/trip-deletion.test.ts'
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

const runtime = {setupFiles: ['tests/shared/build-channel-environment.ts', 'tests/storage/setup.ts'], pool: 'forks' as const, testTimeout: 30_000, hookTimeout: 30_000};
export default defineConfig({test: {sequence: {sequencer: LongFirstSequencer}, projects: [
  {test: {...runtime, name: 'storage', include: ['tests/storage/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/storage/shutdown-stalls.test.ts'], sequence: {groupOrder: 0}}},
  // Keep real shutdown deadlines independent of this suite's other file forks, as for the unit host-boundary group.
  // All four scenarios retain their real timers, worker/pipe concurrency, limits and assertions.
  {test: {...runtime, name: 'storage-shutdown', include: ['tests/storage/shutdown-stalls.test.ts'],
    sequence: {groupOrder: 1}, fileParallelism: false, maxWorkers: 1}}
]}});
