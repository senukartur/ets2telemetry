import {defineConfig} from 'vitest/config';
// Storage suite: loads native better-sqlite3, so it runs only under the pinned Electron executable in Node mode
// through `npm run test:storage` (scripts/run-electron-node.mjs). It is not part of `npm test`, whose Node-safe corpus
// must never load native SQLite. This file and tests/storage/setup.ts both refuse any other runtime.
const PINNED_ELECTRON = '44.7.0';
if (process.versions.electron !== PINNED_ELECTRON) {
  throw new Error(`Storage suite requires Electron ${PINNED_ELECTRON} in Node mode; found ${process.versions.electron ?? 'plain Node'}. Run npm run test:storage.`);
}
console.log(`Storage suite runtime: Electron ${process.versions.electron}, Node ${process.versions.node}, module ABI ${process.versions.modules}`);
export default defineConfig({test: {include: ['tests/storage/**/*.test.ts'], setupFiles: ['tests/storage/setup.ts'], pool: 'forks', testTimeout: 30_000, hookTimeout: 30_000}});
