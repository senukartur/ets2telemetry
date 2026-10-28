import {readFileSync, statSync, lstatSync, existsSync, type BigIntStats} from 'node:fs';
import {open, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {BrokerConfiguration} from './native-pipe-client';
import {CHANNEL, TRANSPORT_DIRECTORY} from './channel';
function boundedJson(filename: string): Record<string, unknown> {
  if (lstatSync(filename).isSymbolicLink() || statSync(filename).size > 1024 * 1024) throw new Error('Native artifact metadata bound rejected');
  return JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
}
/** Fixed build paths only. The receipt binds reviewed build inputs and executable bytes in the same-user model. */
export function brokerConfiguration(directory: string, resources: string, packaged: boolean, localAppData: string | undefined): BrokerConfiguration | undefined {
  if (!localAppData || !path.isAbsolute(localAppData)) return undefined;
  const root = packaged ? path.join(resources, 'telemetry-client') : path.resolve(directory, '../../../native/telemetry-client/build/Release');
  const executable = path.join(root, 'telemetry-pipe-client.exe');
  if (!existsSync(executable)) return undefined;
  const receipt = boundedJson(path.join(root, 'build-evidence.json'));
  const desktop = boundedJson(path.join(directory, 'build-evidence.json'));
  if (typeof receipt.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.executableSha256) || !receipt.sources || JSON.stringify(receipt.sources) !== JSON.stringify(desktop.sources) || lstatSync(executable).isSymbolicLink() || statSync(executable).size > 64 * 1024 * 1024) throw new Error('Native artifact build provenance rejected');
  if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== receipt.executableSha256) throw new Error('Native artifact byte hash rejected');
  return {executable, discoveryDirectory: path.join(localAppData, CHANNEL.dataRootName, TRANSPORT_DIRECTORY, 'v0')};
}

async function receiptBytes(filename: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if ((await lstat(filename)).isSymbolicLink()) throw new Error('Native artifact metadata link rejected');
  signal.throwIfAborted();
  const file = await open(filename, 'r');
  try {
    signal.throwIfAborted(); const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Native artifact metadata bound rejected');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    signal.throwIfAborted();
    if (length !== stat.size) throw new Error('Native artifact metadata changed during read');
    return bytes.subarray(0, length);
  } finally {await file.close();}
}
function sameImage(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameImageSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameImage(left, right) && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Fixed-artifact work is coalesced only while in flight; file metadata is never content authority. */
export function createBrokerResolver(directory: string, resources: string, packaged: boolean, localAppData: string | undefined, rejected: (error: unknown) => void) {
  const root = packaged ? path.join(resources, 'telemetry-client') : path.resolve(directory, '../../../native/telemetry-client/build/Release');
  const executable = path.join(root, 'telemetry-pipe-client.exe');
  const nativeReceipt = path.join(root, 'build-evidence.json'), desktopReceipt = path.join(directory, 'build-evidence.json');
  let inFlight: Promise<BrokerConfiguration | undefined> | undefined;
  return (): Promise<BrokerConfiguration | undefined> => {
    if (inFlight) return inFlight;
    if (!localAppData || !path.isAbsolute(localAppData)) return Promise.resolve(undefined);
    const abort = new AbortController(); let reported = false;
    const report = (error: unknown) => {if (!reported) {reported = true; rejected(error);}};
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<undefined>(resolve => {deadline = setTimeout(() => {
      const error = new Error('Native artifact verification deadline exceeded'); abort.abort(error); report(error); resolve(undefined);
    }, 5000);});
    const work = (async (): Promise<BrokerConfiguration> => {
      const pathBefore = await lstat(executable, {bigint: true}); abort.signal.throwIfAborted();
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > 64n * 1024n * 1024n) throw new Error('Native artifact image bound rejected');
      const image = await open(executable, 'r');
      try {
        abort.signal.throwIfAborted(); const stat = await image.stat({bigint: true});
        if (!stat.isFile() || stat.size > 64n * 1024n * 1024n || !sameImage(stat, pathBefore)) throw new Error('Native artifact image changed before verification');
        const rawNative = await receiptBytes(nativeReceipt, abort.signal), rawDesktop = await receiptBytes(desktopReceipt, abort.signal);
        const receipt = JSON.parse(rawNative.toString('utf8')) as Record<string, unknown>, desktop = JSON.parse(rawDesktop.toString('utf8')) as Record<string, unknown>;
        if (typeof receipt.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.executableSha256) || !receipt.sources || JSON.stringify(receipt.sources) !== JSON.stringify(desktop.sources)) throw new Error('Native artifact build provenance rejected');
        const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let length = 0;
        while (true) {
          abort.signal.throwIfAborted();
          const read = await image.read(chunk, 0, Math.min(chunk.length, Number(stat.size) - length + 1), length);
          abort.signal.throwIfAborted();
          if (!read.bytesRead) break;
          length += read.bytesRead;
          if (length > Number(stat.size)) throw new Error('Native artifact image grew during verification');
          hash.update(chunk.subarray(0, read.bytesRead));
        }
        abort.signal.throwIfAborted();
        if (BigInt(length) !== stat.size || hash.digest('hex') !== receipt.executableSha256) throw new Error('Native artifact byte hash rejected');
        if (!rawNative.equals(await receiptBytes(nativeReceipt, abort.signal)) || !rawDesktop.equals(await receiptBytes(desktopReceipt, abort.signal))) throw new Error('Native artifact receipts changed during verification');
        const heldAfter = await image.stat({bigint: true}), pathAfter = await lstat(executable, {bigint: true});
        abort.signal.throwIfAborted();
        if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || !sameImageSnapshot(stat, heldAfter) || !sameImageSnapshot(heldAfter, pathAfter)) throw new Error('Native artifact image changed during verification');
        return {executable, discoveryDirectory: path.join(localAppData, CHANNEL.dataRootName, TRANSPORT_DIRECTORY, 'v0')};
      } finally {await image.close();}
    })().catch(error => {report(error); return undefined;});
    const result = inFlight = Promise.race([work, timeout]);
    // A deadline cancels further reads, not pending OS I/O. Keep the slot until owned I/O and close settle.
    void work.finally(() => {clearTimeout(deadline); if (inFlight === result) inFlight = undefined;});
    return result;
  };
}
