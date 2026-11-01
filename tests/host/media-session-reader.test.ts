import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {MediaFrames, parseSnapshot, snapshotCommand} from '../../apps/desktop/src/now-playing/protocol';
import {MediaReader} from '../../apps/desktop/src/now-playing/reader';
const children = new Set<ChildProcessWithoutNullStreams>();
// Bounds a real process hang; assertions wait for stdout/exit, never host-speed sleeps.
const PROCESS_GUARD_MS = 10000;
afterEach(async () => {await Promise.all([...children].map(async child => {if (child.exitCode === null && child.signalCode === null) {const closed = once(child, 'close'); child.kill(); await closed;} children.delete(child);}));});
function fixture() {
  const child = spawn(path.resolve('native/media-session-reader/build/Release/media-session-reader-fixture.exe'), ['--parent', String(process.pid)], {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  children.add(child); return child;
}
it('crosses real anonymous stdio with split commands, Unicode-safe JSON and EOF shutdown without media observation', async () => {
  const child = fixture(), frames = new MediaFrames();
  const received = new Promise<unknown>(resolve => child.stdout.on('data', (chunk: Buffer) => frames.push(chunk, resolve)));
  const command = snapshotCommand(7, null);
  for (const byte of command) child.stdin.write(Buffer.from([byte]));
  expect(parseSnapshot(await received, 7)).toEqual({version: 1, type: 'snapshot', requestId: 7, sessions: [], selected: null, error: null});
  const closed = once(child, 'close'); child.stdin.end(); expect((await closed)[0]).toBe(0);
}, PROCESS_GUARD_MS);
it.each([{id: 's999', error: 'READER_TIMEOUT'}, {id: 's998', error: 'INVALID_RESPONSE'}])('supervises a real $error fixture and retires its subprocess', async ({id, error}) => {
  let failed!: (value: string) => void;
  const failure = new Promise<string>(resolve => {failed = resolve;});
  let child: ChildProcessWithoutNullStreams | undefined;
  const reader = new MediaReader({resolve: () => Promise.resolve('fixed nonshipping fixture'), launch: () => {child = fixture(); return child;}, snapshot: () => {throw new Error('Unexpected snapshot');}, failed});
  try {
    reader.select(id); reader.setEnabled(true); expect(await failure).toBe(error);
    await reader.stop(); expect(child?.exitCode).toBe(0);
  } finally {await reader.stop();}
}, PROCESS_GUARD_MS);
it('exits on parent death even while its anonymous stdin remains open', async () => {
  const parent = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  children.add(parent); await once(parent.stdout, 'data');
  const child = spawn(path.resolve('native/media-session-reader/build/Release/media-session-reader-fixture.exe'), ['--parent', String(parent.pid)], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  children.add(child); const frames = new MediaFrames();
  const ready = new Promise<void>(resolve => child.stdout.on('data', (chunk: Buffer) => frames.push(chunk, () => resolve())));
  child.stdin.write(snapshotCommand(1, null)); await ready;
  expect(child.stdin.writableEnded).toBe(false); const closed = once(child, 'close'); parent.kill(); expect((await closed)[0]).toBe(0);
}, PROCESS_GUARD_MS);
it.each([Buffer.from([1, 4, 0, 0]), Buffer.from([2, 0, 0, 0, 0xff, 0xff]), Buffer.from([2, 0, 0, 0, 123, 125])])('rejects malformed/oversized input with bounded process retirement', async bytes => {
  const child = fixture(), closed = once(child, 'close'); child.stdin.on('error', () => undefined); child.stdin.write(bytes);
  expect((await closed)[0]).toBe(3);
}, PROCESS_GUARD_MS);
