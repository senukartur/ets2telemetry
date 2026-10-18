import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {nodeExecFile, runFixedProgram, type ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';

// ET-017 P1/P7, ET-018 PR-3 fifth hosted run: the fixed-program runner on real child processes (this test's own Node).
// An abort, a timeout or output beyond the bound kills the child and answers at once, but never destroys the child's
// output streams: Node's execFile did, and output the dying child still wrote then reached a destroyed pipe, where Node
// raised an uncaught RangeError that ended main with exit code 1.

const node = process.execPath;
const children: ChildProcess[] = [];
/** nodeExecFile, keeping each child so a test can inspect its streams and wait for it. */
const tracked: ExecFilePort = (file, args, options, callback) => {
  const child = nodeExecFile(file, args, options, callback) as ChildProcess;
  children.push(child);
  return child;
};
const closed = (child: ChildProcess) => new Promise<void>(resolve => {if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.on('close', () => resolve());});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed(child);
  }
});
const limits = {timeoutMs: 10_000, maxOutputBytes: 64 * 1024};

it('returns the output of a program that exits 0, and fails one that exits otherwise', async () => {
  expect(await runFixedProgram(tracked, node, ['-e', "process.stdout.write('fixed output')"], limits)).toEqual({ok: true, stdout: Buffer.from('fixed output')});
  expect(await runFixedProgram(tracked, node, ['-e', 'process.exit(3)'], limits)).toEqual({ok: false, failure: 'failed'});
  expect(await runFixedProgram(tracked, path.join(path.dirname(node), 'no-such-program.exe'), [], limits)).toEqual({ok: false, failure: 'failed'});
});

it('reports a timeout and output beyond the bound, and kills the child', async () => {
  expect(await runFixedProgram(tracked, node, ['-e', 'setTimeout(() => undefined, 60_000)'], {...limits, timeoutMs: 300})).toEqual({ok: false, failure: 'timeout'});
  expect(await runFixedProgram(tracked, node, ['-e', "process.stdout.write('x'.repeat(4096))"], {...limits, maxOutputBytes: 1024})).toEqual({ok: false, failure: 'output-too-large'});
  for (const child of children) await closed(child);
});

it('answers an abort at once without destroying the streams of a child that is still writing', async () => {
  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', record);
  try {
    for (let trial = 0; trial < 5; trial++) {
      const controller = new AbortController();
      const running = runFixedProgram(tracked, node, ['-e', "setInterval(() => process.stdout.write('1234567'), 0)"], {...limits, maxOutputBytes: 64 << 20, signal: controller.signal});
      const child = children.at(-1)!;
      await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
      controller.abort();
      expect(await running).toEqual({ok: false, failure: 'aborted'});
      // The child is being killed, but its output is still read and discarded, never pushed into a destroyed stream.
      expect(child.stdout!.destroyed).toBe(false);
      expect(child.stderr!.destroyed).toBe(false);
      await closed(child);
    }
  } finally {process.off('uncaughtException', record);}
  expect(uncaught).toEqual([]);
});

it('starts nothing when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await runFixedProgram(tracked, node, ['-e', ''], {...limits, signal: controller.signal})).toEqual({ok: false, failure: 'aborted'});
  expect(children).toEqual([]);
});
