// Child process of tests/storage/v1-ingestion-crash.test.ts: one telemetry-service instance, run under the pinned
// Electron runtime in Node mode with the storage test bundles (scripts/build-storage-test-bundles.mjs). It opens the
// synthetic database in a real storage worker and runs the bundled V1Ingestion with StorageDurableSink against the
// parent's reactive simulator endpoint. It reports on stdout:
//   ready                               the database is open and the ingestion selected the endpoint
//   committed <lastEventSeq> <through>  a commit result returned, before any ACK built from it
//   ack <throughEventSeq>               an ACK was handed to the pipe
//   barrier <before|after> <eventSeq>   the configured barrier was reached; the child then waits to be terminated
//   disconnected                        a connection that had a checkpoint ended
// Barriers are counted in commits, never in time: `before` stops before the commit command of the item covering the
// eventSeq is sent, `after` stops after its result returned and before the ACK built from it.
'use strict';
const {readFileSync} = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const [configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
const {StorageClient, workerHandle} = require(path.join(bundles, 'storage-client.cjs'));
const {StorageDurableSink} = require(path.join(bundles, 'durable-sink.cjs'));
const {V1Ingestion} = require(path.join(bundles, 'v1-ingestion.cjs'));

const write = line => new Promise(resolve => process.stdout.write(`${line}\n`, resolve));
const forever = () => new Promise(() => undefined);
const covers = (message, eventSeq) => {
  const first = BigInt(message.kind === 'event' ? message.data.eventSeq : message.data.firstEventSeq), last = BigInt(message.kind === 'event' ? message.data.eventSeq : message.data.lastEventSeq);
  return first <= BigInt(eventSeq) && BigInt(eventSeq) <= last;
};

async function main() {
  const client = new StorageClient(workerHandle(new Worker(path.join(bundles, 'storage-worker.cjs'), {workerData: {kind: 'storage'}})));
  const opened = await client.open(config.open);
  if (!opened.ok) throw new Error(`Storage open failed: ${opened.error.code}`);
  const inner = new StorageDurableSink(client), barrier = config.barrier;
  const sink = {
    openSession: welcome => inner.openSession(welcome),
    async commit(message) {
      const hit = barrier && covers(message, barrier.eventSeq);
      if (hit && barrier.kind === 'before') { await write(`barrier before ${barrier.eventSeq}`); await forever(); }
      const result = await inner.commit(message);
      const last = message.kind === 'event' ? message.data.eventSeq : message.data.lastEventSeq;
      if (result.ok) await write(`committed ${last} ${result.value.committedThroughEventSeq}`);
      if (hit && barrier.kind === 'after') { await write(`barrier after ${barrier.eventSeq}`); await forever(); }
      return result;
    }
  };
  const connect = endpoint => {
    const socket = net.connect(endpoint), send = socket.write.bind(socket);
    socket.write = (bytes, ...rest) => {
      const payload = JSON.parse(Buffer.from(bytes.subarray(4)).toString('utf8'));
      // Reported synchronously before the write, so the parent never reads an ACK the pipe has not been handed.
      if (payload.kind === 'ack') process.stdout.write(`ack ${payload.data.throughEventSeq}\n`);
      return send(bytes, ...rest);
    };
    return socket;
  };
  let previous;
  const ingestion = new V1Ingestion({connect, sink, onState: state => {
    // Only a connection that delivered a checkpoint counts; a refused connection attempt has no observation yet.
    if (state.status === 'disconnected' && previous !== 'disconnected' && state.observation) process.stdout.write('disconnected\n');
    previous = state.status;
  }});
  ingestion.select('synthetic', config.endpoint);
  await write('ready');
}

main().catch(error => {
  process.stderr.write(`${error && error.message}\n`);
  process.exit(3);
});
