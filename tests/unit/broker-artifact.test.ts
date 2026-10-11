import {mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync} from 'node:fs';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {createBrokerResolver} from '../../apps/desktop/src/broker-artifact';

const directories: string[] = [];
afterEach(() => {vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ets2-broker-receipt-')); directories.push(directory);
  const root = path.join(directory, 'telemetry-client'); mkdirSync(root);
  const executable = path.join(root, 'telemetry-pipe-client.exe'); const native = path.join(root, 'build-evidence.json'); const desktop = path.join(directory, 'build-evidence.json');
  const bytes = Buffer.from('isolated-test-artifact');
  const receipt = {executableSha256: createHash('sha256').update(bytes).digest('hex'), sources: {'fixture.ts': 'a'.repeat(64)}};
  writeFileSync(executable, bytes); writeFileSync(native, JSON.stringify(receipt)); writeFileSync(desktop, JSON.stringify(receipt));
  const rejected = vi.fn(); const resolve = createBrokerResolver(directory, directory, true, directory, rejected);
  return {directory, executable, native, desktop, bytes, receipt, rejected, resolve};
}
it('avoids repeated byte reads but rejects changed native receipt, desktop inputs and executable bytes', () => {
  const f = fixture(); const reads = vi.spyOn(fs, 'readFileSync');
  expect(f.resolve()?.executable).toBe(f.executable); const count = reads.mock.calls.length;
  expect(f.resolve()?.executable).toBe(f.executable); expect(reads).toHaveBeenCalledTimes(count);
  writeFileSync(f.native, JSON.stringify({...f.receipt, executableSha256: 'b'.repeat(64)}));
  expect(f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledOnce();
  const failedReads = reads.mock.calls.length; expect(f.resolve()).toBeUndefined(); expect(reads).toHaveBeenCalledTimes(failedReads);
  writeFileSync(f.native, JSON.stringify(f.receipt)); expect(f.resolve()?.executable).toBe(f.executable);
  writeFileSync(f.desktop, JSON.stringify({sources: {'other-input.ts': 'c'.repeat(64)}}));
  expect(f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledTimes(2);
  writeFileSync(f.desktop, JSON.stringify(f.receipt)); expect(f.resolve()?.executable).toBe(f.executable);
  writeFileSync(f.executable, 'tampered-image'); expect(f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledTimes(3);
});
it('rechecks a missing image when installed and a same-size file replaced at the fixed path', () => {
  const f = fixture(); const parked = path.join(f.directory, 'parked.exe'); renameSync(f.executable, parked);
  expect(f.resolve()).toBeUndefined(); renameSync(parked, f.executable); expect(f.resolve()).toBeDefined();
  const replacement = path.join(f.directory, 'replacement.exe'); writeFileSync(replacement, Buffer.alloc(f.bytes.length, 1));
  rmSync(f.executable); renameSync(replacement, f.executable);
  expect(f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledOnce();
});
