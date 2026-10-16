// Test-only storage worker entry (ET-015a, R13): the real storage worker host with an in-process commit fault, bundled
// as `fault-storage-worker.cjs` by scripts/build-storage-test-bundles.mjs. It is never part of the application.
//
// The fault is injected through the host's in-process `commitOptions` seam and the storage core's
// `testHooks.beforeCommit`, inside the real `BEGIN IMMEDIATE` transaction of the commit whose event or gap range covers
// the configured eventSeq. A thrown SQLite error code is classified by the core (`SQLITE_FULL` -> DISK_FULL,
// `SQLITE_READONLY` -> PERMISSION_DENIED, `SQLITE_BUSY` -> DATABASE_LOCKED), and the transaction rolls back the event or
// gap row together with its trip effects. A hold blocks that commit inside its transaction until the test posts
// `{type: 'release'}` on the control port, for queue-pressure tests. `samplesFault` (ET-015b) does the same for
// `appendSamples` commands: the transaction rolls back every row of the batch.
import {parentPort, receiveMessageOnPort, workerData, type MessagePort} from 'node:worker_threads';
import type {CommitOptions} from '../../../packages/storage/src/api';
import {serveStorage, type CommitCommand} from '../../../packages/storage/src/worker/host';

export type InjectedSqliteCode = 'SQLITE_FULL' | 'SQLITE_READONLY' | 'SQLITE_BUSY';
export interface FaultWorkerData {
  kind: 'storage';
  /** Throw `code` inside the transaction of the commit covering `eventSeq`, for its first `times` attempts. */
  fault?: {eventSeq: string; code: InjectedSqliteCode; times: number};
  /** Hold the first commit covering `eventSeq` inside its transaction: post `{type: 'held', eventSeq}`, then wait for `{type: 'release'}`. */
  hold?: {eventSeq: string};
  /**
   * ET-015b: throw `code` inside the transaction of the first `times` `appendSamples` commands, or hold the first
   * `appendSamples` command inside its transaction: post `{type: 'held', command: 'appendSamples'}`, then wait for
   * `{type: 'release'}`.
   */
  samplesFault?: {code: InjectedSqliteCode; times: number} | {hold: true};
  /** The test's control port; required with `hold` and with a `samplesFault` hold. */
  control?: MessagePort;
}

const data = workerData as FaultWorkerData;
if (!parentPort || data?.kind !== 'storage') throw new Error('The fault storage worker needs a storage port and workerData {kind: "storage"}');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** Whether the commit's event or gap range covers `eventSeq`. The message is validated by the core afterwards. */
function covers(command: CommitCommand, eventSeq: string): boolean {
  if (command.name === 'appendSamples') return false;
  const message = command.input.message, target = BigInt(eventSeq);
  if (!isRecord(message) || !isRecord(message.data)) return false;
  const {data: d} = message;
  if (command.name === 'commitEvent') return typeof d.eventSeq === 'string' && d.eventSeq === eventSeq;
  return typeof d.firstEventSeq === 'string' && typeof d.lastEventSeq === 'string' && /^[0-9]+$/.test(d.firstEventSeq) && /^[0-9]+$/.test(d.lastEventSeq)
    && BigInt(d.firstEventSeq) <= target && target <= BigInt(d.lastEventSeq);
}

/** Blocks this worker thread until the control port delivers `{type: 'release'}`. */
function holdUntilRelease(control: MessagePort, notice: Record<string, unknown>): void {
  control.postMessage({type: 'held', ...notice});
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const received = receiveMessageOnPort(control);
    if (received && isRecord(received.message) && received.message.type === 'release') return;
    // Returns to JavaScript every 5 ms, so a terminated worker stops here.
    Atomics.wait(pause, 0, 0, 5);
  }
}
const injected = (code: InjectedSqliteCode) => Object.assign(new Error('Injected storage fault'), {code});

const {fault: faultConfig, hold: holdConfig, samplesFault, control} = data;
if ((holdConfig || (samplesFault && 'hold' in samplesFault)) && !control) throw new Error('The fault storage worker needs a control port to hold a commit');
// Only the blocking receive reads the control port; it must not keep the worker alive after the host closed.
control?.unref();
let faultsLeft = faultConfig?.times ?? 0, holdPending = holdConfig !== undefined;
let samplesFaultsLeft = samplesFault && 'code' in samplesFault ? samplesFault.times : 0, samplesHoldPending = samplesFault !== undefined && 'hold' in samplesFault;

/**
 * The in-process options of one `appendSamples` command. Like the event faults, an attempt counts only when it reaches
 * the hook inside its transaction, so a batch the core refused before that does not use up an injected failure.
 */
function sampleOptions(): CommitOptions | undefined {
  if (!samplesHoldPending && samplesFaultsLeft === 0) return undefined;
  return {testHooks: {beforeCommit: () => {
    if (samplesHoldPending && control !== undefined) {
      samplesHoldPending = false;
      holdUntilRelease(control, {command: 'appendSamples'});
    }
    if (samplesFaultsLeft > 0 && samplesFault !== undefined && 'code' in samplesFault) {
      samplesFaultsLeft--;
      throw injected(samplesFault.code);
    }
  }}};
}

serveStorage(parentPort, {
  commitOptions(command): CommitOptions | undefined {
    if (command.name === 'appendSamples') return sampleOptions();
    const hold = holdPending && holdConfig !== undefined && control !== undefined && covers(command, holdConfig.eventSeq);
    const fault = faultsLeft > 0 && faultConfig !== undefined && covers(command, faultConfig.eventSeq);
    if (!hold && !fault) return undefined;
    return {testHooks: {beforeCommit: () => {
      if (hold && holdPending) {
        holdPending = false;
        holdUntilRelease(control, {eventSeq: holdConfig.eventSeq});
      }
      if (fault && faultsLeft > 0) {
        faultsLeft--;
        throw injected(faultConfig.code);
      }
    }}};
  }
});
