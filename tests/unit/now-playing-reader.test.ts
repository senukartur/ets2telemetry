import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterEach, expect, it, vi} from 'vitest';
import {MediaReader} from '../../apps/desktop/src/now-playing/reader';
import {MediaFrames, snapshotCommand} from '../../apps/desktop/src/now-playing/protocol';
let reader: MediaReader | undefined;
afterEach(async () => {if (reader) {const done = reader.stop(); await vi.advanceTimersByTimeAsync(500); await done;} reader = undefined; vi.useRealTimers();});
function childProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(child, {stdin, stdout, stderr, exitCode: null, signalCode: null, kill: vi.fn(() => {child.emit('close', 0, null); return true;})});
  return {child, stdin, stdout};
}
const frame = (value: unknown) => {const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);};
const empty = (requestId: number) => ({version: 1, type: 'snapshot', requestId, sessions: [], selected: null, error: null});
it('parses split and coalesced frames, rejects oversized lengths before allocation and refuses malformed UTF-8', () => {
  const values: unknown[] = [], frames = new MediaFrames(), bytes = Buffer.concat([frame(empty(1)), frame(empty(2))]);
  for (const byte of bytes) frames.push(Buffer.from([byte]), value => values.push(value));
  expect(values).toEqual([empty(1), empty(2)]);
  const large = Buffer.alloc(4); large.writeUInt32LE(1048577); expect(() => new MediaFrames().push(large, vi.fn())).toThrow();
  expect(() => new MediaFrames().push(Buffer.from([2, 0, 0, 0, 0xc0, 0xaf]), vi.fn())).toThrow();
  expect(() => snapshotCommand(1, 'cmd.exe')).toThrow();
});
it('allows one request in flight, polls once per second and fences a response after source selection changed', async () => {
  vi.useFakeTimers(); const process = childProcess(), snapshot = vi.fn(), failed = vi.fn();
  const writes: Buffer[] = []; process.stdin.on('data', chunk => writes.push(Buffer.from(chunk)));
  reader = new MediaReader({resolve: () => Promise.resolve('fixed.exe'), launch: () => process.child, snapshot, failed});
  reader.setEnabled(true); await Promise.resolve();
  expect(writes).toHaveLength(1); await vi.advanceTimersByTimeAsync(1000); expect(writes).toHaveLength(1);
  reader.select('s2'); process.stdout.write(frame(empty(1))); expect(snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(writes).toHaveLength(2);
  process.stdout.write(frame(empty(2))); expect(snapshot).toHaveBeenCalledWith(empty(2), expect.any(Number));
  expect(failed).not.toHaveBeenCalled();
});
it('clears on the five-second deadline, terminates within 500ms, bounds restarts and rejects late/unsolicited responses', async () => {
  vi.useFakeTimers(); const processes: ReturnType<typeof childProcess>[] = [], failed = vi.fn(), snapshot = vi.fn();
  reader = new MediaReader({resolve: () => Promise.resolve('fixed.exe'), launch: () => {const process = childProcess(); processes.push(process); return process.child;}, snapshot, failed});
  reader.setEnabled(true); await Promise.resolve(); await vi.advanceTimersByTimeAsync(4999); expect(failed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(failed).toHaveBeenLastCalledWith('READER_TIMEOUT');
  processes[0].stdout.write(frame(empty(1))); expect(snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500); expect(processes[0].child.kill).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500); expect(processes).toHaveLength(2);
  processes[1].stdout.write(frame(empty(999))); expect(failed).toHaveBeenLastCalledWith('INVALID_RESPONSE');
  await vi.advanceTimersByTimeAsync(1000); expect(processes).toHaveLength(3);
  processes[2].stdout.write(frame(empty(999))); await vi.advanceTimersByTimeAsync(1000); expect(processes).toHaveLength(3);
});
it('preserves the explicit helper-lifetime token in commands after a helper restart', async () => {
  vi.useFakeTimers(); const processes: ReturnType<typeof childProcess>[] = [], writes: Buffer[][] = [];
  reader = new MediaReader({resolve: () => Promise.resolve('fixed.exe'), launch: () => {
    const process = childProcess(), sent: Buffer[] = []; processes.push(process); writes.push(sent);
    process.stdin.on('data', chunk => sent.push(Buffer.from(chunk))); return process.child;
  }, snapshot: vi.fn(), failed: vi.fn()});
  reader.select('s1'); reader.setEnabled(true); await Promise.resolve();
  expect(JSON.parse(writes[0][0].subarray(4).toString())).toMatchObject({selectedId: 's1'});
  processes[0].child.emit('exit', 1, null); await vi.advanceTimersByTimeAsync(1000);
  expect(processes).toHaveLength(2);
  expect(JSON.parse(writes[1][0].subarray(4).toString())).toMatchObject({selectedId: 's1'});
  reader.select('s2'); processes[1].stdout.write(frame(empty(2))); await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.parse(writes[1][1].subarray(4).toString())).toMatchObject({selectedId: 's2'});
});
