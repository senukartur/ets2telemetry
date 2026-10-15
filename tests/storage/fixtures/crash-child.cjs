// Child process of tests/storage/crash-recovery.test.ts, run under the pinned Electron runtime in Node mode with the
// storage test bundles (scripts/build-storage-test-bundles.mjs). It commits a prepared synthetic stream and writes
// "ack <lastEventSeq> <committedThrough>" to stdout after each commit result, the point where a consumer would ACK.
// Modes:
//   before-commit  in-process storage core; the process terminates itself inside the transaction of item `killAt`
//   after-commit   storage worker; the process terminates itself after item `killAt` committed, before its ack line
//   worker         storage worker; commits everything, then waits until the test terminates the process
'use strict';
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const [mode, configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
// TerminateProcess on Windows: no exit handlers, no SQLite close, no checkpoint; every thread stops at once.
const terminate = () => process.kill(process.pid, 'SIGKILL');
function must(result) {
  if (!result.ok) throw new Error(`Storage command failed: ${result.error.code}`);
  return result.value;
}
const write = line => new Promise(resolve => process.stdout.write(`${line}\n`, resolve));

async function inProcess() {
  const {openStorage} = require(path.join(bundles, 'storage-core.cjs'));
  const storage = must(await openStorage(config.open));
  must(storage.upsertSession({message: config.welcome}));
  await write('ready');
  for (const [index, item] of config.stream.entries()) {
    const options = index === config.killAt ? {testHooks: {beforeCommit: terminate}} : undefined;
    const input = {message: item.message, effects: item.effects};
    const result = must(item.kind === 'gap' ? storage.commitGap(input, options) : storage.commitEvent(input, options));
    await write(`ack ${item.last} ${result.committedThroughEventSeq}`);
  }
  await write('done');
}

async function viaWorker() {
  const {StorageClient, workerHandle} = require(path.join(bundles, 'storage-client.cjs'));
  const client = new StorageClient(workerHandle(new Worker(path.join(bundles, 'storage-worker.cjs'), {workerData: {kind: 'storage'}})));
  must(await client.open(config.open));
  must(await client.upsertSession({message: config.welcome}));
  await write('ready');
  for (const [index, item] of config.stream.entries()) {
    const input = {message: item.message, effects: item.effects};
    const result = must(await (item.kind === 'gap' ? client.commitGap(input) : client.commitEvent(input)));
    if (mode === 'after-commit' && index === config.killAt) terminate();
    await write(`ack ${item.last} ${result.committedThroughEventSeq}`);
  }
  await write('done');
  // Stay alive with the database open until the test terminates this process.
  setInterval(() => undefined, 60_000);
}

(mode === 'before-commit' ? inProcess() : viaWorker()).catch(error => {
  process.stderr.write(`${error && error.message}\n`);
  process.exit(3);
});
