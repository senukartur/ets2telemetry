// The storage suite loads native better-sqlite3. It must run under the pinned Electron runtime in Node mode, the
// runtime of the telemetry service, never under plain Node: `npm run test:storage` (scripts/run-electron-node.mjs).
const PINNED_ELECTRON = '44.7.0';
const electron = process.versions.electron;
if (electron !== PINNED_ELECTRON) {
  throw new Error(`Storage suite requires Electron ${PINNED_ELECTRON} in Node mode; found ${electron ?? 'plain Node'}. Run npm run test:storage.`);
}
