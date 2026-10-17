// REG-015, REG-017 (ET-017 PR-6, P17): the diagnostic bundle export in main, on real temporary folders. The Save dialog is
// scripted; the target checks and the partial-file write are the shared export-file.ts routine. Expected outcomes and log
// rows are written by hand from P17. No real user or data folder is touched: LOCALAPPDATA is a temporary folder.
import {mkdir, readdir, readFile, symlink, writeFile} from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DiagnosticBundleExporter, diagnosticBundleFileName, type DiagnosticBundleExporterOptions} from '../../apps/desktop/src/diagnostic-bundle-writer';
import type {ExportFileSystem} from '../../apps/desktop/src/export-file';
import {temporaryResources} from '../shared/resources';

const BUNDLE = '{"format": "ets2telemetry.diagnostics", "version": 1}\n';
let resources: Awaited<ReturnType<typeof temporaryResources>>;
let local: string, out: string;
beforeEach(async () => {
  resources = await temporaryResources();
  local = path.join(resources.directory, 'local'); out = path.join(resources.directory, 'out');
  await mkdir(path.join(local, 'ETS2Telemetry', 'logs'), {recursive: true}); await mkdir(out);
});
afterEach(async () => { await resources.dispose(); });

function exporter(options: Partial<DiagnosticBundleExporterOptions> & {target?: string | null} = {}) {
  const log = vi.fn();
  const target = options.target === undefined ? path.join(out, 'diagnostics.json') : options.target;
  const showSaveDialog = vi.fn((defaultPath: string) => { void defaultPath; return Promise.resolve(target === null ? {canceled: true, filePath: ''} : {canceled: false, filePath: target}); });
  const build = vi.fn(() => Promise.resolve(BUNDLE));
  const instance = new DiagnosticBundleExporter({build, showSaveDialog, documents: () => 'C:\\Users\\owner\\Documents', localAppData: local, log,
    now: () => Date.UTC(2026, 9, 17, 8, 30, 15, 250), suffix: () => '0badc0de', delay: () => Promise.resolve(), ...options});
  return {instance, log, showSaveDialog, build};
}
const events = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(call => [call[0], call[2] ?? null]);
const listing = async (directory = out) => (await readdir(directory)).sort();
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return {promise, release};
}

it('names the default file by the UTC time and offers it in Documents', async () => {
  expect(diagnosticBundleFileName(Date.UTC(2026, 9, 17, 8, 30, 15, 250))).toBe('ets2telemetry-diagnostics-20261017T083015Z.json');
  const f = exporter({target: null});
  await f.instance.export();
  expect(f.showSaveDialog).toHaveBeenCalledExactlyOnceWith('C:\\Users\\owner\\Documents\\ets2telemetry-diagnostics-20261017T083015Z.json');
});

describe('a cancelled Save dialog', () => {
  it('builds, reads and writes nothing and answers cancelled', async () => {
    const fs: ExportFileSystem = {open: vi.fn(), rename: vi.fn(), unlink: vi.fn(), realpath: vi.fn(), stat: vi.fn()};
    const f = exporter({target: null, fs});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'cancelled'});
    expect(f.build).not.toHaveBeenCalled();
    expect([fs.open, fs.rename, fs.unlink, fs.realpath, fs.stat].map(call => (call as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    expect(await listing()).toEqual([]);
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_CANCELLED', null]]);
  });
});

describe('a saved bundle', () => {
  it('writes exactly the built bundle through a partial file, replacing an existing target, and logs its size only', async () => {
    await writeFile(path.join(out, 'diagnostics.json'), 'old bundle');
    const f = exporter();
    await expect(f.instance.export()).resolves.toEqual({outcome: 'saved'});
    expect(await listing()).toEqual(['diagnostics.json']);
    expect(await readFile(path.join(out, 'diagnostics.json'), 'utf8')).toBe(BUNDLE);
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_SAVED', {bytes: Buffer.byteLength(BUNDLE)}]]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(out);
  });
});

describe('a failed export leaves no partial file and the old target unchanged', () => {
  beforeEach(async () => { await writeFile(path.join(out, 'diagnostics.json'), 'old bundle'); });
  const unchanged = async () => {
    expect(await listing()).toEqual(['diagnostics.json']);
    expect(await readFile(path.join(out, 'diagnostics.json'), 'utf8')).toBe('old bundle');
  };
  it('when the write fails', async () => {
    const fs: ExportFileSystem = {...realFs, open: async (target, flags) => {
      const handle = await realFs.open(target, flags);
      return {writeFile: () => Promise.reject(Object.assign(new Error('disk'), {code: 'EIO'})), sync: () => handle.sync(), close: () => handle.close()};
    }};
    const f = exporter({fs});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'failed', code: 'EXPORT_WRITE_FAILED'});
    await unchanged();
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_FAILED', {outcome: 'failed', code: 'EXPORT_WRITE_FAILED', step: 'write', errno: 'EIO'}]]);
  });
  it('when the sync or the rename keeps failing', async () => {
    const syncing: ExportFileSystem = {...realFs, open: async (target, flags) => {
      const handle = await realFs.open(target, flags);
      return {writeFile: (data: string, encoding: 'utf8') => handle.writeFile(data, encoding), sync: () => Promise.reject(Object.assign(new Error('io'), {code: 'EIO'})), close: () => handle.close()};
    }};
    await expect(exporter({fs: syncing}).instance.export()).resolves.toEqual({outcome: 'failed', code: 'EXPORT_WRITE_FAILED'});
    await unchanged();
    const renaming: ExportFileSystem = {...realFs, rename: vi.fn(() => Promise.reject(Object.assign(new Error('denied'), {code: 'EPERM'})))};
    await expect(exporter({fs: renaming}).instance.export()).resolves.toEqual({outcome: 'failed', code: 'EXPORT_WRITE_FAILED'});
    expect(renaming.rename).toHaveBeenCalledTimes(6);
    await unchanged();
  });
  it('when the bundle cannot be built, before any file is opened', async () => {
    const f = exporter({build: () => Promise.reject(new Error('EACCES: permission denied, open C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\logs\\startup.jsonl'))});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'failed', code: 'BUNDLE_FAILED'});
    await unchanged();
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_FAILED', {outcome: 'failed', code: 'BUNDLE_FAILED'}]]);
  });
  // PR-6 review: a rejected Save dialog is its own failure, not a bundle failure; nothing is built or written.
  it('when the Save dialog rejects, before the bundle is built', async () => {
    const f = exporter({showSaveDialog: () => Promise.reject(new Error('dialog failed'))});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'failed', code: 'DIALOG_FAILED'});
    expect(f.build).not.toHaveBeenCalled();
    await unchanged();
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_FAILED', {outcome: 'failed', code: 'DIALOG_FAILED'}]]);
  });
  it('never removes a file it did not create', async () => {
    await writeFile(path.join(out, 'diagnostics.json.0badc0de.partial'), 'someone else');
    const f = exporter();
    await expect(f.instance.export()).resolves.toEqual({outcome: 'failed', code: 'EXPORT_WRITE_FAILED'});
    expect(await listing()).toEqual(['diagnostics.json', 'diagnostics.json.0badc0de.partial']);
  });
});

describe('refused targets', () => {
  it.each([
    ['the data directory itself', () => path.join(local, 'ETS2Telemetry')],
    ['a file in its logs folder', () => path.join(local, 'ETS2Telemetry', 'logs', 'diagnostics.json')],
    ['another case', () => path.join(local.toUpperCase(), 'ets2telemetry', 'diagnostics.json')],
    ['a device path', () => '\\\\.\\C:\\diagnostics.json'],
    ['a relative path', () => 'diagnostics.json']
  ])('refuses %s, before the bundle is built, and writes nothing', async (_name, target) => {
    const f = exporter({target: target()});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'});
    expect(f.build).not.toHaveBeenCalled();
    expect(await listing(path.join(local, 'ETS2Telemetry', 'logs'))).toEqual([]);
    expect(events(f.log)).toEqual([['DIAGNOSTICS_EXPORT_FAILED', {outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'}]]);
  });
  it('refuses a junction that leads into the data directory', async () => {
    await symlink(path.join(local, 'ETS2Telemetry', 'logs'), path.join(out, 'link'), 'junction');
    const f = exporter({target: path.join(out, 'link', 'diagnostics.json')});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'});
    expect(await listing(path.join(local, 'ETS2Telemetry', 'logs'))).toEqual([]);
  });
  it('refuses every target when LOCALAPPDATA is unknown', async () => {
    const f = exporter({localAppData: undefined});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'});
    expect(await listing()).toEqual([]);
  });
});

describe('one export at a time, and the application exit', () => {
  it('answers a second export EXPORT_IN_PROGRESS while the first runs, then accepts the next', async () => {
    const dialog = held<{canceled: boolean; filePath?: string}>();
    const f = exporter({showSaveDialog: vi.fn(() => dialog.promise)});
    const running = f.instance.export();
    await expect(f.instance.export()).resolves.toEqual({outcome: 'refused', code: 'EXPORT_IN_PROGRESS'});
    dialog.release({canceled: true});
    await expect(running).resolves.toEqual({outcome: 'cancelled'});
    await expect(exporter().instance.export()).resolves.toEqual({outcome: 'saved'});
  });
  it('writes nothing when the application exits while the dialog is open, and refuses later exports', async () => {
    const dialog = held<{canceled: boolean; filePath?: string}>();
    const f = exporter({showSaveDialog: vi.fn(() => dialog.promise)});
    const running = f.instance.export();
    f.instance.abort();
    expect(f.instance.idle()).toBeUndefined();
    dialog.release({canceled: false, filePath: path.join(out, 'diagnostics.json')});
    await expect(running).resolves.toEqual({outcome: 'refused', code: 'EXPORT_INTERRUPTED'});
    await expect(f.instance.export()).resolves.toEqual({outcome: 'refused', code: 'EXPORT_INTERRUPTED'});
    expect(f.build).not.toHaveBeenCalled();
    expect(await listing()).toEqual([]);
  });
  it('removes the partial file when the application exits during the write, and its idle work settles after that', async () => {
    await writeFile(path.join(out, 'diagnostics.json'), 'old bundle');
    const writing = held<void>(), started = held<void>();
    const fs: ExportFileSystem = {...realFs, open: async (target, flags) => {
      const handle = await realFs.open(target, flags);
      return {writeFile: async (data: string, encoding: 'utf8') => { started.release(); await writing.promise; return handle.writeFile(data, encoding); },
        sync: () => handle.sync(), close: () => handle.close()};
    }};
    const f = exporter({fs});
    const running = f.instance.export();
    await started.promise;
    expect(await listing()).toEqual(['diagnostics.json', 'diagnostics.json.0badc0de.partial']);
    f.instance.abort();
    const idle = f.instance.idle();
    expect(idle).toBeInstanceOf(Promise);
    writing.release();
    await idle;
    // The write in flight finished, but the exit stops the export before the rename.
    expect(await listing()).toEqual(['diagnostics.json']);
    expect(await readFile(path.join(out, 'diagnostics.json'), 'utf8')).toBe('old bundle');
    await expect(running).resolves.toEqual({outcome: 'refused', code: 'EXPORT_INTERRUPTED'});
    expect(f.instance.idle()).toBeUndefined();
  });
});
