// Child process of tests/storage/crash-recovery.test.ts, run under the pinned Electron runtime in Node mode with the
// storage test bundles (scripts/build-storage-test-bundles.mjs). It commits a prepared synthetic stream and writes
// "ack <lastEventSeq> <committedThrough>" to stdout after each commit result, the point where a consumer would ACK.
// Modes:
//   before-commit  in-process storage core; the process terminates itself inside the transaction of item `killAt`
//   after-commit   storage worker; the process terminates itself after item `killAt` committed, before its ack line
//   worker         storage worker; commits everything, then waits until the test terminates the process
//   migrate        in-process storage core (tests/storage/migration-crash.test.ts, ET-019); opens an older database copy,
//                  and at the barrier `config.barrier` writes "barrier <name> <facts JSON>" synchronously to stdout and
//                  blocks until the test terminates the process. Barriers: afterInspect (the open test hook), afterCopy
//                  (the backup test hook: the partial copy exists), inside0002 (the real migration 0002 SQL has run inside
//                  the migration transaction, before the runner records the step and commits) and afterOpen (the open
//                  returned, the database is never closed). The open runs in this process because the storage worker
//                  copies open options field by field and never receives hooks or migrations (docs/storage.md).
'use strict';
const {readFileSync, statSync, writeSync} = require('node:fs');
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

/** Upper bound of a barrier wait; the test terminates the child long before. Reaching it fails the test through stderr. */
const BARRIER_TIMEOUT_MS = 60_000;
async function migrate() {
  const {MIGRATIONS, openStorage} = require(path.join(bundles, 'storage-core.cjs'));
  const barrier = (name, facts = {}) => {
    if (name !== config.barrier) return;
    // Synchronous on purpose: the main thread blocks right after, so an asynchronous stdout write would never be flushed.
    writeSync(1, `barrier ${name} ${JSON.stringify(facts)}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BARRIER_TIMEOUT_MS);
    writeSync(2, `Barrier ${name} was not ended by the test\n`);
    process.exit(4);
  };
  // The real 0002 statements, then the barrier, still inside the runner's migration transaction. The facts are read on
  // the migrating connection, so they show the uncommitted state; the connection reads 64-bit integers as BigInt.
  const real = MIGRATIONS[1];
  const wrapped = Object.freeze({...real, up(db) {
    // With `spill`, a page cache of a few pages makes SQLite write uncommitted pages of the transaction to the WAL before
    // the barrier, so the kill leaves frames without a commit record on disk instead of nothing at all.
    if (config.spill) db.pragma('cache_size = 1');
    real.up(db);
    let walBytes = 0;
    try { walBytes = statSync(`${config.open.path}-wal`).size; } catch { /* no WAL file */ }
    barrier('inside0002', {
      userVersion: Number(db.pragma('user_version', {simple: true})),
      versions: db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all().map(Number),
      tripsOpenedBy: Number(db.prepare("SELECT count(*) FROM pragma_table_info('trips') WHERE name = 'opened_by'").pluck().get()),
      walBytes
    });
  }});
  const options = {...config.open, now: () => config.nowMs,
    ...(config.barrier === 'inside0002' ? {migrations: [MIGRATIONS[0], wrapped]} : {}),
    testHooks: {afterInspect: () => barrier('afterInspect'), afterCopy: partial => barrier('afterCopy', {partial: path.basename(partial)})}};
  const storage = must(await openStorage(options));
  barrier('afterOpen', {summary: storage.summary});
  writeSync(2, `Barrier ${config.barrier} was never reached\n`);
  process.exit(5);
}

const modes = {'before-commit': inProcess, migrate};
(modes[mode] ?? viaWorker)().catch(error => {
  process.stderr.write(`${error && error.message}\n`);
  process.exit(3);
});
