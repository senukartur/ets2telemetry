import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {serveStorage} from '../../../packages/storage/src/worker/host';
// One entrypoint, two modes. `{kind: 'storage'}` serves the durable history database for the telemetry service
// (ET-013); every other start is the ET-001 readiness probe, which writes only isolated probe data and accepts no
// production history path.
if ((workerData as {kind?: unknown} | undefined)?.kind === 'storage') {
  if (!parentPort) throw new Error('Missing storage worker port');
  serveStorage(parentPort);
} else {
  try {
    const filename = (workerData as {filename: string}).filename;
    let database = new Database(filename);
    database.exec('CREATE TABLE probe (value INTEGER NOT NULL)');
    database.prepare('INSERT INTO probe VALUES (?)').run(42);
    database.close();
    database = new Database(filename, {readonly:true});
    const row = database.prepare('SELECT value FROM probe').get() as {value:number};
    database.close();
    if (row.value !== 42) throw new Error('Probe mismatch');
    parentPort?.postMessage({type:'verified', abi:process.versions.modules});
  } catch (error) {
    console.error(process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR ? error : 'STORAGE_PROBE_FAILED');
    parentPort?.postMessage({type:'failed', code:'STORAGE_PROBE_FAILED'});
  }
}
