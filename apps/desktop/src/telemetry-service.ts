import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { processEntrypoint } from './entrypoints';
import { ServiceProbe } from './service-probe';
import {existsSync} from 'node:fs';
import {createDiagnostics} from './diagnostics';
import {TelemetryIngestion, initialLive, sourceSelection} from './telemetry-ingestion';
import {LiveSubscriptions} from './live-subscriptions';
const port = process.parentPort;
if (!port) throw new Error('Missing Electron parent port');
const log = createDiagnostics(path.join(process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR || path.join(process.env.LOCALAPPDATA || tmpdir(), 'ETS2Telemetry', 'logs'), 'service'), Boolean(process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR));
log('SERVICE_BOOT');
const subscriptions = new LiveSubscriptions(initialLive());
const ingestion = new TelemetryIngestion(update => subscriptions.publish(update));
const fixtureEndpoint = process.env.ETS2TELEMETRY_SOURCE_PIPE;
let selection = sourceSelection(process.env.ETS2TELEMETRY_SOURCE_KIND || 'game');
const probe = new ServiceProbe({
  diagnose: log,
  createDirectory: () => mkdtemp(path.join(tmpdir(), 'ets2telemetry-probe-')),
  createWorker: directory => {
    const entrypoint = processEntrypoint(__dirname, 'storage-worker');
    if (!existsSync(entrypoint)) throw new Error('Missing physical storage worker entrypoint');
    const worker = new Worker(entrypoint, {workerData: {filename: path.join(directory, 'probe.sqlite')}});
    return {
      onMessage: listener => {worker.once('message', listener);},
      onError: listener => {worker.once('error', listener);},
      onExit: listener => {worker.once('exit', listener);},
      terminate: async () => {await worker.terminate();}
    };
  },
  removeDirectory: directory => rm(directory, {recursive: true, force: true}),
  report: message => {
    log('SERVICE_REPORT', message);
    port.postMessage(message);
    if (message.type === 'ready') ingestion.select(selection, fixtureEndpoint);
    if (message.type === 'stopped') process.exit(0);
    if (message.code === 'SERVICE_STOP_FAILED') process.exit(1);
  }
});
port.on('message', event => {
  if (event.data?.type === 'stop') {subscriptions.close(); void ingestion.stop().then(() => probe.stop());}
  else if (event.data?.type === 'unsubscribe') subscriptions.close();
  else if (event.data?.type === 'subscribe' && event.ports.length === 1) subscriptions.attach(event.ports[0]);
  else if (event.data?.type === 'select') {
    try {selection = sourceSelection(event.data.source); ingestion.configureBroker(event.data.broker); ingestion.select(selection, fixtureEndpoint);}
    catch {port.postMessage({type: 'failed', code: 'INVALID_SOURCE_COMMAND'});}
  } else {for (const transferred of event.ports) transferred.close();}
});
void probe.start();
