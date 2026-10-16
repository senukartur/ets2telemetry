// Child process of tests/storage/trip-recorder-crash.test.ts (ET-015a, S3): one telemetry-service instance with the trip
// recorder, run under the pinned Electron runtime in Node mode with the storage test bundles
// (scripts/build-storage-test-bundles.mjs). It runs the bundled V1Ingestion with TripRecorderSink against the parent's
// reactive simulator endpoint, over storage in one of two modes:
//   worker      the real storage worker through StorageClient, as in the telemetry service
//   in-process  the storage core in this process, so a hook can stop inside a real commit transaction
// It reports on stdout:
//   ready                               the database is open and the ingestion selected the endpoint
//   committed <lastEventSeq> <through>  a commit result returned, before any ACK built from it
//   ack <throughEventSeq>               an ACK was handed to the pipe
//   barrier <kind> <eventSeq|commit>    the configured barrier was reached; the child then waits to be terminated
//   disconnected                        a connection that had a checkpoint ended
// Barriers are counted in commits, never in time:
//   {kind: 'before', eventSeq} | {kind: 'before', commit: k}  before the commit of that item (or the k-th commit) starts
//   {kind: 'after', eventSeq}  | {kind: 'after', commit: k}   after its result returned, before the ACK built from it
//   {kind: 'inside', eventSeq}                               in-process mode only: inside the commit's transaction
// After a barrier no further storage command runs. `maxConnections` bounds the connections this process opens, so a
// process held at a barrier never takes a later scripted connection that belongs to the next process. With
// `commitAfterFirstEnd`, no commit starts before the first connection has ended, so the server has written that whole
// connection (and retains everything unacknowledged) before any barrier can be reached.
// ET-015b: `sampleFlushMs` sets the pipeline's sample flush delay, and with `stopAfterDisconnect` the process stops its
// ingestion at its first `disconnected` (the final sample write included) and then reports:
//   stopped                             the orderly stop finished
'use strict';
const {readFileSync, writeSync} = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const [configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
const {TripRecorderSink} = require(path.join(bundles, 'trip-recorder.cjs'));
const {V1Ingestion} = require(path.join(bundles, 'v1-ingestion.cjs'));

// Every line is written synchronously, so lines keep their order and none is lost when the process blocks or is killed.
const write = line => { writeSync(1, `${line}\n`); return Promise.resolve(); };
const forever = () => new Promise(() => undefined);
const range = message => message.kind === 'event' ? [message.data.eventSeq, message.data.eventSeq] : [message.data.firstEventSeq, message.data.lastEventSeq];
const covers = (message, eventSeq) => { const [first, last] = range(message); return BigInt(first) <= BigInt(eventSeq) && BigInt(eventSeq) <= BigInt(last); };
const barrier = config.barrier;

/** Blocks this thread inside the transaction until the parent terminates the process. */
function holdInside(eventSeq) {
  writeSync(1, `barrier inside ${eventSeq}\n`);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(pause, 0, 0, 1000);
}

async function openStorage() {
  if (config.mode === 'in-process') {
    const core = require(path.join(bundles, 'storage-core.cjs'));
    const opened = await core.openStorage(config.open);
    if (!opened.ok) throw new Error(`Storage open failed: ${opened.error.code}`);
    const storage = opened.value;
    const options = message => barrier && barrier.kind === 'inside' && covers(message, barrier.eventSeq) ? {testHooks: {beforeCommit: () => holdInside(barrier.eventSeq)}} : undefined;
    return {
      upsertSession: input => Promise.resolve(storage.upsertSession(input)), committedThrough: session => Promise.resolve(storage.committedThrough(session)),
      commitEvent: input => Promise.resolve(storage.commitEvent(input, options(input.message))), commitGap: input => Promise.resolve(storage.commitGap(input, options(input.message))),
      recordCompleteness: (session, interval, completeness) => Promise.resolve(storage.recordCompleteness(session, interval, completeness)),
      listTrips: page => Promise.resolve(storage.listTrips(page)), getEvent: (session, eventSeq) => Promise.resolve(storage.getEvent(session, eventSeq)),
      listEvents: (session, page) => Promise.resolve(storage.listEvents(session, page)),
      appendSamples: (session, rows, sampleOptions) => Promise.resolve(storage.appendSamples(session, rows, sampleOptions))
    };
  }
  const {StorageClient, workerHandle} = require(path.join(bundles, 'storage-client.cjs'));
  const client = new StorageClient(workerHandle(new Worker(path.join(bundles, 'storage-worker.cjs'), {workerData: {kind: 'storage'}})));
  const opened = await client.open(config.open);
  if (!opened.ok) throw new Error(`Storage open failed: ${opened.error.code}`);
  return client;
}

async function main() {
  const recorder = new TripRecorderSink(await openStorage());
  let commits = 0, frozen = false, firstEnded;
  const firstEnd = new Promise(resolve => { firstEnded = resolve; });
  const hit = (message, count) => barrier && barrier.kind !== 'inside' && (barrier.commit !== undefined ? count === barrier.commit : covers(message, barrier.eventSeq));
  const stop = async label => { frozen = true; await write(`barrier ${barrier.kind} ${label}`); await forever(); };
  const sink = {
    async openSession(welcome) { if (frozen) await forever(); return recorder.openSession(welcome); },
    async commit(message, context) {
      if (config.commitAfterFirstEnd) await firstEnd;
      if (frozen) await forever();
      const count = ++commits, label = barrier && barrier.commit !== undefined ? count : barrier && barrier.eventSeq;
      if (hit(message, count) && barrier.kind === 'before') await stop(label);
      const result = await recorder.commit(message, context);
      if (result.ok) await write(`committed ${range(message)[1]} ${result.value.committedThroughEventSeq}`);
      if (hit(message, count) && barrier.kind === 'after') await stop(label);
      return result;
    },
    observe: (message, context) => recorder.observe(message, context),
    // ET-015b: the recorder's pending one-second samples, written by the pipeline's samples op and at stop.
    samples: recorder.samples,
    async restoreLoss(session, stored, acked) { if (frozen) await forever(); return recorder.restoreLoss(session, stored, acked); }
  };
  let connections = 0;
  const connect = endpoint => {
    // Beyond its bound the process connects nowhere and keeps retrying, so it never takes another process's connection.
    const index = ++connections, target = config.maxConnections !== undefined && index > config.maxConnections ? `${endpoint}-closed` : endpoint;
    const socket = net.connect(target), send = socket.write.bind(socket);
    if (index === 1) socket.once('close', () => firstEnded());
    socket.write = (bytes, ...rest) => {
      const payload = JSON.parse(Buffer.from(bytes.subarray(4)).toString('utf8'));
      // Reported synchronously before the write, so the parent never reads an ACK the pipe has not been handed.
      if (payload.kind === 'ack') writeSync(1, `ack ${payload.data.throughEventSeq}\n`);
      return send(bytes, ...rest);
    };
    return socket;
  };
  let previous, stopping = false;
  const ingestion = new V1Ingestion({connect, sink, sampleFlushMs: config.sampleFlushMs, onState: state => {
    // Only a connection that delivered a checkpoint counts; a refused connection attempt has no observation yet.
    if (state.status === 'disconnected' && previous !== 'disconnected' && state.observation) {
      writeSync(1, 'disconnected\n');
      // After the state callback returns, so the closing connection finishes first.
      if (config.stopAfterDisconnect && !stopping) { stopping = true; setImmediate(() => void ingestion.stop().then(() => write('stopped'))); }
    }
    previous = state.status;
  }});
  ingestion.select('synthetic', config.endpoint);
  await write('ready');
}

main().catch(error => {
  process.stderr.write(`${error && error.message}\n`);
  process.exit(3);
});
