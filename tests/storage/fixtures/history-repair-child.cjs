// Child process of tests/storage/history-repair.test.ts (ET-112g), run under the pinned Electron runtime in Node mode with
// the storage test bundles (scripts/build-storage-test-bundles.mjs). TerminateProcess on Windows: no exit handlers, no
// SQLite close and no checkpoint. Modes:
//   record  opens `config.open` in process, stores `config.welcome` and commits each `config.stream` item, writes "ready"
//           and blocks with the writer open until the test terminates the process, so its committed WAL stays behind.
//   apply   runs applyHistoryRepair(`config.apply`) and terminates itself inside the transaction of action `config.killAt`,
//           after its join and before its commit.
'use strict';
const {readFileSync} = require('node:fs');
const path = require('node:path');

const [mode, configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
const terminate = () => process.kill(process.pid, 'SIGKILL');
const write = line => new Promise(resolve => process.stdout.write(`${line}\n`, resolve));
function must(result) {
  if (!result.ok) throw new Error(`Storage command failed: ${result.error.code}`);
  return result.value;
}

async function record() {
  const {openStorage} = require(path.join(bundles, 'storage-core.cjs'));
  const storage = must(await openStorage(config.open));
  must(storage.upsertSession({message: config.welcome}));
  for (const item of config.stream) must(storage.commitEvent(item));
  await write('ready');
  // Keep the writer and its exclusive lock until the test terminates this process.
  setInterval(() => undefined, 60_000);
}

async function apply() {
  const {applyHistoryRepair} = require(path.join(bundles, 'storage-core.cjs'));
  await write('ready');
  const result = await applyHistoryRepair({...config.apply, testHooks: {beforeCommit: index => { if (index === config.killAt) terminate(); }}});
  await write(`finished ${JSON.stringify(result)}`);
}

(mode === 'record' ? record() : mode === 'apply' ? apply() : Promise.reject(new Error(`Unknown mode ${mode}`)))
  .catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
