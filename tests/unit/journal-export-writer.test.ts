// ET-016 PR-5 (J16, J17): the trip export flow in main, against real temporary directories. The journal reads and the
// Save dialog are scripted; the file system is the real one, wrapped only where a case injects a failure. Expected
// results, files and log rows are written by hand from J16 (REG-014).
import {existsSync} from 'node:fs';
import {mkdir, readdir, readFile, symlink, writeFile} from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {JournalCallResult, JournalTripDetail} from '../../packages/contracts/src';
import {exportTargetRefused, JournalExporter, type ExportFileSystem, type JournalExporterOptions} from '../../apps/desktop/src/journal-export-writer';
import type {JournalQuery} from '../../apps/desktop/src/journal-contract';
import {changed, DETAIL, EVENT, INTERVAL, SAMPLE, TRIP} from '../shared/journal-replies';
import {temporaryResources} from '../shared/resources';
import {tripExportProblems} from '../shared/trip-export-validator';

const DATABASE = {purpose: 'synthetic', schemaVersion: 2};
const DATABASE_UUID = 'f0000000-0000-4000-8000-000000000001';
let resources: Awaited<ReturnType<typeof temporaryResources>>;
let root: string, local: string, out: string;
beforeEach(async () => {
  resources = await temporaryResources();
  root = resources.directory; local = path.join(root, 'local'); out = path.join(root, 'out');
  await mkdir(path.join(local, 'ETS2Telemetry', 'data'), {recursive: true}); await mkdir(out);
});
afterEach(async () => { await resources.dispose(); });

/** `count` samples of the trip from id `first`. */
const samples = (first: number, count: number) => Array.from({length: count}, (_, index) => ({...SAMPLE, id: String(first + index)}));
/** The scripted journal: the detail, the database and the pages of each read; any other read fails the case. */
function journal(overrides: Partial<Record<string, (query: JournalQuery) => JournalCallResult<unknown> | Promise<JournalCallResult<unknown>>>> = {}) {
  const queries: JournalQuery[] = [];
  const answers: Record<string, (query: JournalQuery) => JournalCallResult<unknown> | Promise<JournalCallResult<unknown>>> = {
    trip: () => ({ok: true, value: DETAIL}),
    database: () => ({ok: true, value: {database: DATABASE, databaseUuid: DATABASE_UUID}}),
    intervals: () => ({ok: true, value: {database: DATABASE, intervals: [INTERVAL], total: 1, nextCursor: null}}),
    events: () => ({ok: true, value: {database: DATABASE, window: DETAIL.window, events: [EVENT, {...EVENT, eventSeq: '4', attribution: null}], nextCursor: null}}),
    samples: () => ({ok: true, value: {database: DATABASE, samples: [SAMPLE], nextCursor: null}}),
    ...overrides
  };
  const read = vi.fn((query: JournalQuery) => { queries.push(query); return Promise.resolve(answers[query.kind](query)); });
  return {read, queries};
}
function exporter(options: Partial<JournalExporterOptions> & {target?: string | null} = {}) {
  const log = vi.fn(), j = journal();
  const target = options.target === undefined ? path.join(out, 'trip.json') : options.target;
  const showSaveDialog = vi.fn((defaultPath: string) => { void defaultPath; return Promise.resolve(target === null ? {canceled: true, filePath: ''} : {canceled: false, filePath: target}); });
  const delays: number[] = [];
  const instance = new JournalExporter({read: j.read, showSaveDialog, documents: () => 'C:\\Users\\owner\\Documents', localAppData: local, appVersion: '0.1.0-test', log,
    now: () => 1_800_000_000_000, suffix: () => '0badc0de', delay: ms => { delays.push(ms); return Promise.resolve(); }, ...options});
  return {instance, log, showSaveDialog, delays, queries: j.queries, read: j.read};
}
const events = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(call => [call[0], call[2] ?? null]);
const listing = async (directory = out) => (await readdir(directory)).sort();

describe('a cancelled Save dialog (J16)', () => {
  it('writes nothing and answers cancelled', async () => {
    const fs: ExportFileSystem = {open: vi.fn(), rename: vi.fn(), unlink: vi.fn(), realpath: vi.fn()};
    const f = exporter({target: null, fs});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: true, value: {outcome: 'cancelled'}});
    expect(f.showSaveDialog).toHaveBeenCalledExactlyOnceWith('C:\\Users\\owner\\Documents\\ets2telemetry-trip-ets2-20261011-0000-7a000000.json');
    expect([fs.open, fs.rename, fs.unlink, fs.realpath].map(call => (call as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 0, 0, 0]);
    expect(await listing()).toEqual([]);
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_CANCELLED', null]]);
    // The detail and the database header were read before the dialog; no page was.
    expect(f.queries.map(query => query.kind)).toEqual(['trip', 'database']);
  });
});

describe('a saved export (J16, J17)', () => {
  it('writes the trip through a partial file and leaves exactly the valid document', async () => {
    const f = exporter();
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 2, intervals: 1, samples: 1}});
    expect(await listing()).toEqual(['trip.json']);
    const document = JSON.parse(await readFile(path.join(out, 'trip.json'), 'utf8')) as {header: unknown; samples: {id: string}[]};
    expect(tripExportProblems(document)).toEqual([]);
    expect(document.header).toEqual({application: {name: 'ETS2Telemetry', version: '0.1.0-test'}, exportedUtcMs: 1_800_000_000_000,
      database: {uuid: DATABASE_UUID, purpose: 'synthetic', schemaVersion: 2}, sessionOrigin: 'synthetic'});
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_SAVED', {events: 2, samples: 1}]]);
    // Each read at the export page size of its kind (J5, J16).
    expect(f.queries).toEqual([{kind: 'trip', tripUuid: TRIP}, {kind: 'database'}, {kind: 'intervals', tripUuid: TRIP, page: {limit: 500}},
      {kind: 'events', tripUuid: TRIP, page: {limit: 500}}, {kind: 'samples', tripUuid: TRIP, page: {limit: 3_600}}]);
  });
  it('replaces an existing target', async () => {
    await writeFile(path.join(out, 'trip.json'), 'old export');
    const f = exporter();
    expect((await f.instance.export(TRIP)).ok).toBe(true);
    expect(await listing()).toEqual(['trip.json']);
    expect((await readFile(path.join(out, 'trip.json'), 'utf8')).startsWith('{\n"format": "ets2telemetry.trip-export",\n')).toBe(true);
  });
  it('pages each section and stops at the bounds of the detail read, leaving out rows written after it', async () => {
    // The detail saw samples up to id 3700, intervals up to id 7 and events up to eventSeq 4; later rows exist.
    const bounded = changed(DETAIL, d => { d.exportBounds = {committedThroughEventSeq: '4', lastSampleId: '3700', lastIntervalId: '7'}; d.samples = {count: 3_700, firstUtcMs: 1, lastUtcMs: 2}; });
    const read = journal({
      trip: () => ({ok: true, value: bounded}),
      samples: query => {
        const cursor = 'page' in query ? query.page.cursor : undefined;
        if (cursor === undefined) return {ok: true, value: {database: DATABASE, samples: samples(1, 3_600), nextCursor: '3600'}};
        if (cursor === '3600') return {ok: true, value: {database: DATABASE, samples: samples(3_601, 3_600), nextCursor: '7200'}};
        throw new Error('A page after the bound was read');
      },
      intervals: () => ({ok: true, value: {database: DATABASE, intervals: [INTERVAL, {...INTERVAL, id: '8'}], total: 2, nextCursor: null}}),
      events: () => ({ok: true, value: {database: DATABASE, window: DETAIL.window, events: [EVENT, {...EVENT, eventSeq: '4'}, {...EVENT, eventSeq: '5'}], nextCursor: null}})
    });
    const f = exporter({read: read.read});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 2, intervals: 1, samples: 3_700}});
    const document = JSON.parse(await readFile(path.join(out, 'trip.json'), 'utf8')) as {samples: {id: string}[]; events: {eventSeq: string}[]; intervals: {id: string}[]; bounds: unknown};
    expect([document.samples.length, document.samples.at(-1)!.id, document.events.map(e => e.eventSeq), document.intervals.map(i => i.id)]).toEqual([3_700, '3700', ['3', '4'], ['7']]);
    expect(document.bounds).toEqual({committedThroughEventSeq: '4', lastSampleId: '3700', lastIntervalId: '7', snapshot: true});
    expect(tripExportProblems(document)).toEqual([]);
    expect(read.queries.filter(query => query.kind === 'samples')).toEqual([{kind: 'samples', tripUuid: TRIP, page: {limit: 3_600}},
      {kind: 'samples', tripUuid: TRIP, page: {cursor: '3600', limit: 3_600}}]);
  });
  it('reads no samples or intervals when the detail saw none', async () => {
    const empty = changed(DETAIL as unknown as JournalTripDetail, d => { d.exportBounds = {committedThroughEventSeq: '4', lastSampleId: null, lastIntervalId: null}; d.samples = {count: 0, firstUtcMs: null, lastUtcMs: null};
      d.intervals = {items: [], total: 0, nextCursor: null}; });
    const read = journal({trip: () => ({ok: true, value: empty})});
    const f = exporter({read: read.read});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 2, intervals: 0, samples: 0}});
    expect(read.queries.map(query => query.kind)).toEqual(['trip', 'database', 'events']);
  });
  it('retries the final rename while Windows holds the new file, as settings saves do', async () => {
    let failures = 2;
    const fs: ExportFileSystem = {...realFs, rename: vi.fn((from: string, to: string) => failures-- > 0 ? Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'})) : realFs.rename(from, to))};
    const f = exporter({fs});
    expect((await f.instance.export(TRIP)).ok).toBe(true);
    expect(f.delays).toEqual([20, 40]);
    expect(await listing()).toEqual(['trip.json']);
  });
});

describe('a failed export leaves no partial file and the old target unchanged (J16)', () => {
  beforeEach(async () => { await writeFile(path.join(out, 'trip.json'), 'old export'); });
  const unchanged = async () => {
    expect(await listing()).toEqual(['trip.json']);
    expect(await readFile(path.join(out, 'trip.json'), 'utf8')).toBe('old export');
  };
  it('when a write fails in the middle of a page', async () => {
    let writes = 0;
    const fs: ExportFileSystem = {...realFs, open: async (target, flags) => {
      const handle = await realFs.open(target, flags);
      return {write: (data: string) => ++writes === 3 ? Promise.reject(Object.assign(new Error('disk'), {code: 'EIO'})) : handle.write(data), sync: () => handle.sync(), close: () => handle.close()};
    }};
    const f = exporter({fs});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_WRITE_FAILED'});
    await unchanged();
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_WRITE_FAILED', step: 'write', errno: 'EIO'}]]);
  });
  it('when a later page is refused, with the read\'s own code', async () => {
    const read = journal({samples: () => ({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'TIMEOUT'})});
    const f = exporter({read: read.read});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'TIMEOUT'});
    await unchanged();
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'DATABASE_UNAVAILABLE'}]]);
  });
  it('when the rename keeps failing', async () => {
    const fs: ExportFileSystem = {...realFs, rename: vi.fn(() => Promise.reject(Object.assign(new Error('denied'), {code: 'EPERM'})))};
    const f = exporter({fs});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_WRITE_FAILED'});
    expect(fs.rename).toHaveBeenCalledTimes(6);
    await unchanged();
  });
  it('when a page names another database or the timeline another session', async () => {
    for (const override of [{samples: () => ({ok: true, value: {database: {purpose: 'replay', schemaVersion: 2}, samples: [SAMPLE], nextCursor: null}})},
      {events: () => ({ok: true, value: {database: DATABASE, window: {...DETAIL.window, pluginSessionId: '10000000-0000-4000-8000-000000000002'}, events: [], nextCursor: null}})}]) {
      const f = exporter({read: journal(override as never).read});
      await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'FAILED'});
      await unchanged();
    }
  });
  it('never removes a file it did not create', async () => {
    // The partial name is taken: opening with `wx` fails, and that file stays.
    await writeFile(path.join(out, 'trip.json.0badc0de.partial'), 'someone else');
    const f = exporter();
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_WRITE_FAILED'});
    expect(await listing()).toEqual(['trip.json', 'trip.json.0badc0de.partial']);
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_WRITE_FAILED', step: 'open', errno: 'EEXIST'}]]);
  });
});

describe('refused targets (J16)', () => {
  it.each([
    ['the data directory itself', () => path.join(local, 'ETS2Telemetry')],
    ['a file in its data folder', () => path.join(local, 'ETS2Telemetry', 'data', 'trip.json')],
    ['another case', () => path.join(local.toUpperCase(), 'ets2telemetry', 'trip.json')],
    ['trailing dots and spaces Windows drops', () => path.join(local, 'ETS2Telemetry. ', 'data', 'trip.json')],
    ['a relative walk into it', () => path.join(out, '..', 'local', 'ETS2Telemetry', 'trip.json')],
    ['forward slashes', () => path.join(local, 'ETS2Telemetry', 'trip.json').replaceAll('\\', '/')]
  ])('refuses %s and writes nothing', async (_name, target) => {
    const f = exporter({target: target()});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_TARGET_REFUSED'});
    expect(await listing(path.join(local, 'ETS2Telemetry'))).toEqual(['data']);
    expect(await listing(path.join(local, 'ETS2Telemetry', 'data'))).toEqual([]);
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_TARGET_REFUSED'}]]);
  });
  it('refuses a junction that leads into the data directory', async () => {
    await symlink(path.join(local, 'ETS2Telemetry', 'data'), path.join(out, 'link'), 'junction');
    const f = exporter({target: path.join(out, 'link', 'trip.json')});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_TARGET_REFUSED'});
    expect(await listing(path.join(local, 'ETS2Telemetry', 'data'))).toEqual([]);
  });
  it.each([
    '\\\\?\\C:\\exports\\trip.json', '\\\\.\\C:\\exports\\trip.json', '\\\\.\\pipe\\trip', '//?/C:/exports/trip.json', '\\??\\C:\\exports\\trip.json', 'C:\\exports\\NUL.json',
    'C:\\exports\\con', 'C:\\COM1\\trip.json', 'C:\\exports\\lpt9.txt', 'trip.json', '.\\trip.json', 'C:trip.json', '', 'C:\\exports\\trip\0.json'
  ])('refuses the device, relative or malformed path %j', target => {
    expect(exportTargetRefused(target, 'C:\\Users\\owner\\AppData\\Local')).toBe(true);
  });
  it.each(['C:\\Users\\owner\\Documents\\trip.json', 'D:\\exports\\ETS2Telemetry\\trip.json', 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry-exports\\trip.json',
    '\\\\server\\share\\trip.json', 'C:\\exports\\console.json'])('allows %j', target => {
    expect(exportTargetRefused(target, 'C:\\Users\\owner\\AppData\\Local')).toBe(false);
  });
  it('refuses every target when LOCALAPPDATA is unknown', () => {
    expect(exportTargetRefused('C:\\Users\\owner\\Documents\\trip.json', undefined)).toBe(true);
    expect(exportTargetRefused('C:\\Users\\owner\\Documents\\trip.json', 'relative')).toBe(true);
  });
});

describe('one export at a time, and the application exit (J16)', () => {
  /** A Save dialog that answers when the case says so. */
  function heldDialog() {
    let answer!: (value: {canceled: boolean; filePath?: string}) => void;
    const showSaveDialog = vi.fn(() => new Promise<{canceled: boolean; filePath?: string}>(resolve => { answer = resolve; }));
    return {showSaveDialog, answer: (value: {canceled: boolean; filePath?: string}) => answer(value)};
  }
  it('answers a second export EXPORT_IN_PROGRESS while the first runs, then accepts the next', async () => {
    const dialog = heldDialog(), f = exporter({showSaveDialog: dialog.showSaveDialog});
    const first = f.instance.export(TRIP);
    await vi.waitFor(() => expect(dialog.showSaveDialog).toHaveBeenCalled());
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_IN_PROGRESS'});
    dialog.answer({canceled: false, filePath: path.join(out, 'trip.json')});
    expect((await first).ok).toBe(true);
    dialog.showSaveDialog.mockImplementationOnce(() => Promise.resolve({canceled: true, filePath: ''}));
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: true, value: {outcome: 'cancelled'}});
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_IN_PROGRESS'}], ['JOURNAL_EXPORT_SAVED', {events: 2, samples: 1}], ['JOURNAL_EXPORT_CANCELLED', null]]);
  });
  it('writes nothing when the application exits while the dialog is open, and refuses later exports', async () => {
    const dialog = heldDialog(), f = exporter({showSaveDialog: dialog.showSaveDialog});
    const running = f.instance.export(TRIP);
    await vi.waitFor(() => expect(dialog.showSaveDialog).toHaveBeenCalled());
    f.instance.abort();
    // Nothing is on disk, so the exit does not wait for the dialog.
    expect(f.instance.idle()).toBeUndefined();
    dialog.answer({canceled: false, filePath: path.join(out, 'trip.json')});
    await expect(running).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
    expect(await listing()).toEqual([]);
  });
  it('removes the partial file when the application exits during a page read, and its idle work settles after that', async () => {
    await writeFile(path.join(out, 'trip.json'), 'old export');
    let release!: (result: JournalCallResult<unknown>) => void;
    const read = journal({events: () => new Promise(resolve => { release = resolve; })});
    const f = exporter({read: read.read});
    const running = f.instance.export(TRIP);
    await vi.waitFor(() => expect(read.queries.some(query => query.kind === 'events')).toBe(true));
    expect(await listing()).toEqual(['trip.json', 'trip.json.0badc0de.partial']);
    f.instance.abort();
    const idle = f.instance.idle();
    expect(idle).toBeInstanceOf(Promise);
    // Main's exit retires the journal broker, which answers the read in flight SERVICE_UNAVAILABLE.
    release({ok: false, code: 'SERVICE_UNAVAILABLE'});
    await idle;
    expect(await listing()).toEqual(['trip.json']);
    expect(await readFile(path.join(out, 'trip.json'), 'utf8')).toBe('old export');
    await expect(running).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
    expect(f.instance.idle()).toBeUndefined();
    expect(events(f.log)).toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_INTERRUPTED'}]]);
  });
  it('answers the detail read\'s refusal without a dialog', async () => {
    const f = exporter({read: journal({trip: () => ({ok: false, code: 'NOT_FOUND'})}).read});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'NOT_FOUND'});
    expect(f.showSaveDialog).not.toHaveBeenCalled();
    expect(existsSync(path.join(out, 'trip.json'))).toBe(false);
  });
  it('answers FAILED when the detail and the header name different databases', async () => {
    const f = exporter({read: journal({database: () => ({ok: true, value: {database: {purpose: 'history', schemaVersion: 2}, databaseUuid: DATABASE_UUID}})}).read});
    await expect(f.instance.export(TRIP)).resolves.toEqual({ok: false, code: 'FAILED'});
    expect(f.showSaveDialog).not.toHaveBeenCalled();
  });
});
