import {mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync} from 'node:fs';
import fs from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createBrokerResolver} from '../../apps/desktop/src/broker-artifact';

// Mock the actual named bindings, retaining real isolated filesystem I/O by default.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, readFileSync: vi.fn(actual.readFileSync)};
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open)};
});
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(open).mockImplementation(fs.promises.open);
  vi.mocked(readFileSync).mockImplementation(fs.readFileSync); vi.mocked(lstat).mockImplementation(fs.promises.lstat);
});
const directories: string[] = [];
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ets2-broker-receipt-')); directories.push(directory);
  const root = path.join(directory, 'telemetry-client'); mkdirSync(root);
  const executable = path.join(root, 'telemetry-pipe-client.exe'), native = path.join(root, 'build-evidence.json'), desktop = path.join(directory, 'build-evidence.json');
  const bytes = Buffer.from('isolated-test-artifact');
  const receipt = {executableSha256: createHash('sha256').update(bytes).digest('hex'), sources: {'fixture.ts': 'a'.repeat(64)}};
  writeFileSync(executable, bytes); writeFileSync(native, JSON.stringify(receipt)); writeFileSync(desktop, JSON.stringify(receipt));
  const rejected = vi.fn(); const resolve = createBrokerResolver(directory, directory, true, directory, rejected);
  return {directory, executable, native, desktop, bytes, receipt, rejected, resolve};
}
it('streams current image bytes on each new verification and rejects changed receipts and image', async () => {
  const f = fixture(); const first = await f.resolve(); expect(f.rejected.mock.calls).toEqual([]); expect(first?.executable).toBe(f.executable);
  expect((await f.resolve())?.executable).toBe(f.executable);
  expect(vi.mocked(open).mock.calls.filter(call => String(call[0]) === f.executable)).toHaveLength(2); expect(readFileSync).not.toHaveBeenCalled();
  writeFileSync(f.native, JSON.stringify({...f.receipt, executableSha256: 'b'.repeat(64)}));
  expect(await f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledOnce();
  writeFileSync(f.native, JSON.stringify(f.receipt)); expect(await f.resolve()).toBeDefined();
  writeFileSync(f.desktop, JSON.stringify({sources: {'other-input.ts': 'c'.repeat(64)}}));
  expect(await f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledTimes(2);
  writeFileSync(f.desktop, JSON.stringify(f.receipt)); expect(await f.resolve()).toBeDefined();
  writeFileSync(f.executable, 'tampered-image'); expect(await f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledTimes(3);
});
it('rechecks a missing image when installed and a same-size image replaced at the fixed path', async () => {
  const f = fixture(); const parked = path.join(f.directory, 'parked.exe'); renameSync(f.executable, parked);
  expect(await f.resolve()).toBeUndefined(); renameSync(parked, f.executable); expect(await f.resolve()).toBeDefined();
  const replacement = path.join(f.directory, 'replacement.exe'); writeFileSync(replacement, Buffer.alloc(f.bytes.length, 1));
  rmSync(f.executable); renameSync(replacement, f.executable);
  expect(await f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledTimes(2);
});
it.each(['native', 'desktop', 'executable'] as const)('rejects changed %s content with every stat field held identical', async which => {
  const f = fixture(); const original = fs.promises.lstat;
  const fixedStats = new Map(await Promise.all([f.executable, f.native, f.desktop].map(async filename => [filename, await original(filename)] as const)));
  const fixedBigStats = new Map(await Promise.all([f.executable, f.native, f.desktop].map(async filename => [filename, await original(filename, {bigint: true})] as const)));
  vi.mocked(lstat).mockImplementation((async (filename: fs.PathLike, options?: {bigint?: boolean}) => options?.bigint ? fixedBigStats.get(String(filename)) ?? original(filename, {bigint: true}) : fixedStats.get(String(filename)) ?? original(filename)) as typeof lstat);
  expect(await f.resolve()).toBeDefined(); expect(lstat).toHaveBeenCalledWith(f.native);
  const filename = f[which], before = fs.readFileSync(filename);
  const changed = which === 'native' ? {...f.receipt, executableSha256: 'b'.repeat(64)} : {...f.receipt, sources: {'fixture.ts': 'b'.repeat(64)}};
  const after = which === 'executable' ? Buffer.alloc(before.length, 1) : Buffer.from(JSON.stringify(changed));
  expect(after.length).toBe(before.length); writeFileSync(filename, after);
  expect(await f.resolve()).toBeUndefined(); expect(f.rejected).toHaveBeenCalledOnce();
});
function holdRead() {
  let release!: () => void, started = false, closed = false, calls = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  vi.mocked(open).mockImplementation(async (filename, flags) => {
    const handle = await fs.promises.open(filename, flags);
    if (String(filename).endsWith('.exe')) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) => {
        calls++; expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(65536); started = true;
        return gate.then(() => read(buffer, offset, length, position));
      }) as unknown as typeof handle.read);
      vi.spyOn(handle, 'close').mockImplementation(async () => {await close(); closed = true;});
    }
    return handle;
  });
  return {release: () => release(), started: () => started, closed: () => closed, calls: () => calls};
}
it('coalesces overlapping requests into one bounded owned verification', async () => {
  const f = fixture(); const held = holdRead(); const first = f.resolve(), second = f.resolve();
  expect(second).toBe(first); await vi.waitFor(() => expect(held.started()).toBe(true));
  expect(vi.mocked(open).mock.calls.filter(call => String(call[0]) === f.executable)).toHaveLength(1); held.release();
  expect((await first)?.executable).toBe(f.executable); expect(await second).toEqual(await first);
});
it('retires a silent read at five seconds but holds its slot until real read and close complete', async () => {
  vi.useFakeTimers(); const f = fixture(); const held = holdRead(); const pending = f.resolve();
  await vi.waitFor(() => expect(held.started()).toBe(true)); await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBeUndefined(); expect(held.closed()).toBe(false); expect(f.rejected).toHaveBeenCalledOnce();
  expect(f.resolve()).toBe(pending); expect(held.calls()).toBe(1);
  held.release(); await vi.waitFor(() => expect(held.closed()).toBe(true));
  expect(held.calls()).toBe(1); // No further chunk was scheduled after abort.
  vi.mocked(open).mockImplementation(fs.promises.open);
  expect(await f.resolve()).toBeDefined(); expect(vi.getTimerCount()).toBe(0);
});
it('rejects receipt changes while hashing instead of approving a mixed generation', async () => {
  const f = fixture(); const held = holdRead(); const pending = f.resolve();
  await vi.waitFor(() => expect(held.started()).toBe(true));
  writeFileSync(f.native, JSON.stringify({...f.receipt, sources: {'fixture.ts': 'b'.repeat(64)}}));
  held.release(); expect(await pending).toBeUndefined(); expect(f.rejected).toHaveBeenCalledOnce();
});

it('rejects an atomic path replacement even when both images have identical approved bytes', async () => {
  const f = fixture(); const held = holdRead(); const pending = f.resolve();
  await vi.waitFor(() => expect(held.started()).toBe(true));
  renameSync(f.executable, path.join(f.directory, 'retained-old.exe')); writeFileSync(f.executable, f.bytes);
  held.release(); expect(await pending).toBeUndefined();
  expect(f.rejected.mock.lastCall?.[0].message).toBe('Native artifact image changed during verification');
});
it('rejects an image that grows after opening using at most one extra byte beyond its observed size', async () => {
  const f = fixture(); const held = holdRead(); const pending = f.resolve();
  await vi.waitFor(() => expect(held.started()).toBe(true));
  writeFileSync(f.executable, Buffer.concat([f.bytes, f.bytes])); held.release();
  expect(await pending).toBeUndefined(); expect(held.calls()).toBe(1);
  expect(f.rejected.mock.lastCall?.[0].message).toBe('Native artifact image grew during verification');
});
it('keeps the slot reserved after a result deadline until pending owned stat I/O settles', async () => {
  vi.useFakeTimers(); const f = fixture();
  const stat = await fs.promises.lstat(f.executable, {bigint: true}); let complete!: (stat: fs.BigIntStats) => void;
  vi.mocked(lstat).mockImplementationOnce((() => new Promise<fs.BigIntStats>(resolve => {complete = resolve;})) as unknown as typeof lstat);
  const first = f.resolve(); await vi.advanceTimersByTimeAsync(5000);
  expect(await first).toBeUndefined(); expect(f.resolve()).toBe(first); expect(lstat).toHaveBeenCalledOnce();
  complete(stat); await vi.advanceTimersByTimeAsync(0);
  expect(await f.resolve()).toBeDefined(); expect(vi.getTimerCount()).toBe(0);
});
it('rejects oversized image metadata and bounded receipt bytes before hashing', async () => {
  const f = fixture(); writeFileSync(f.native, Buffer.alloc(1024 * 1024 + 1));
  expect(await f.resolve()).toBeUndefined();
  writeFileSync(f.native, JSON.stringify(f.receipt)); const original = fs.promises.lstat;
  vi.mocked(lstat).mockImplementation((async (filename: fs.PathLike, options?: {bigint?: boolean}) => {
    const stat = await original(filename, options as {bigint: true});
    if (String(filename) === f.executable) stat.size = 65n * 1024n * 1024n;
    return stat;
  }) as typeof lstat);
  const opens = vi.mocked(open).mock.calls.length;
  expect(await f.resolve()).toBeUndefined(); expect(open).toHaveBeenCalledTimes(opens);
});
