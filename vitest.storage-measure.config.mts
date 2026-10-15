import {defineConfig} from 'vitest/config';
// Storage size measurement (ET-013): loads native better-sqlite3 like the storage suite, so it runs only under the
// pinned Electron executable in Node mode through `npm run measure:storage`. It is not part of `npm test` or
// `npm run test:storage`; it writes 100 hours of 1 Hz samples into a temporary database and prints the measured sizes.
const PINNED_ELECTRON = '44.7.0';
if (process.versions.electron !== PINNED_ELECTRON) {
  throw new Error(`Storage measurement requires Electron ${PINNED_ELECTRON} in Node mode; found ${process.versions.electron ?? 'plain Node'}. Run npm run measure:storage.`);
}
export default defineConfig({test: {include: ['tests/measurement/**/*.measure.ts'], setupFiles: ['tests/storage/setup.ts'], pool: 'forks', testTimeout: 1_800_000, hookTimeout: 60_000}});
