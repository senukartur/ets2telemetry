// ET-019 PR-6: a database the service must not open is refused end to end through the telemetry service's production
// wiring, in process under the pinned Electron runtime: the recording runtime (apps/desktop/src/recording-runtime.ts) with
// its HistoryStorage and the real storage worker, the recording status as main accepts it (parseRecordingHealth and the
// health reducer), and journal reads through the service's JournalService and main's JournalBroker with its reply check.
// Each case puts a database file under a temporary LOCALAPPDATA, at the history path for the default plan or at the
// `synthetic:t` target, and checks that the open is refused with the documented code, that the worker ends at once and
// the service creates no second worker before its orderly stop, that recording reports the documented state, that every
// journal read answers DATABASE_UNAVAILABLE with that code, and that nothing under the data root changed. Expected values are written by hand from docs/storage.md
// (the open sequence, migrations, backups, the history database in the telemetry service), docs/telemetry-service-v1.md
// (the recording gate and status, journal queries) and docs/journal.md (J11), never read back from the code. Waits count
// state changes, worker exits and hellos; real-time bounds are named hang guards only (REG-007, REG-013, REG-014).
import {once} from 'node:events';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AppHealth, RecordingHealth} from '../../packages/contracts/src';
import {FrameDecoder, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import {initialHealth, reduceHealth} from '../../apps/desktop/src/app-health';
import {JournalBroker, type JournalServiceChannel} from '../../apps/desktop/src/journal-broker';
import type {JournalQuery} from '../../apps/desktop/src/journal-contract';
import {JournalService} from '../../apps/desktop/src/journal-service';
import {createRecordingRuntime} from '../../apps/desktop/src/recording-runtime';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {parseRecordingHealth} from '../../apps/desktop/src/recording-status';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {digestOf, readOnly, REPRESENTATIVE, sha256, STORAGE_FIXTURES, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {guarded, storageWorker, terminateWorkers, tracedShutdown, until} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
/**
 * The service of the running case. A case that fails before its orderly stop leaves its v1 ingestion running, and a
 * synthetic-target case would keep reconnecting to its closed pipe server; afterEach ends the source and the status.
 */
/** Below the 30 s hook timeout, so a stuck source stop reports its own name. */
const CLEANUP_GUARD_MS = 10_000;
let current: {runtime: ReturnType<typeof createRecordingRuntime>; stopped: boolean} | undefined;
afterEach(async () => {
  const left = current; current = undefined;
  try {
    if (left && !left.stopped) { left.runtime.stopStatus(); await guarded(left.runtime.v1.stopSource(), 'the source stop of a failed case', CLEANUP_GUARD_MS); }
  } finally {
    await terminateWorkers(); await ws.dispose();
  }
});

/** The committed storage fixtures are immutable: every listed file keeps its manifest SHA-256 after these cases. */
afterAll(() => {
  const manifest = readFileSync(path.join(STORAGE_FIXTURES, 'manifest.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(' '));
  expect(manifest.map(([, name]) => name)).toEqual(expect.arrayContaining([REPRESENTATIVE, 'schema-newer-999.sqlite', 'foreign-application.sqlite', 'schema-v2-representative.sqlite']));
  for (const [hash, name] of manifest) expect(sha256(path.join(STORAGE_FIXTURES, name)), name).toBe(hash);
});

/** Hang guard of one awaited step (the open settling, a worker exit, a hello, a status); far below the case timeouts. */
const HANG_GUARD_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;
const root = () => path.join(ws.directory, 'ETS2Telemetry');
const historyFile = () => path.join(root(), 'data', 'telemetry.sqlite');
const historyBackups = () => path.join(root(), 'backups');
const target = () => path.join(root(), 'synthetic', 't.sqlite');
const targetBackups = () => path.join(root(), 'synthetic', 'backups');
const DEFAULT_PLAN = {};
const SYNTHETIC_PLAN = {ETS2TELEMETRY_RECORDING: 'synthetic:t'};

/** Every directory and file under `directory`, by relative path: `dir` or the file's SHA-256. "Nothing written" is equality. */
function tree(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name), key = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(full).isDirectory()) { out[key] = 'dir'; walk(full, key); } else out[key] = sha256(full);
    }
  };
  if (existsSync(directory)) walk(directory, '');
  return out;
}
/** Copies a committed storage fixture to `file` (never opened in place) and returns `file`. */
function place(fixture: string, file: string): string {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, readFileSync(path.join(STORAGE_FIXTURES, fixture)));
  return file;
}
/** The ET-001 probe layout (docs/storage.md, OD-10): a SQLite file with user tables but without this application's id. */
function placeProbe(file: string): string {
  mkdirSync(path.dirname(file), {recursive: true});
  const db = new Database(file);
  try { db.exec('CREATE TABLE probe (value INTEGER NOT NULL); INSERT INTO probe VALUES (42)'); } finally { db.close(); }
  return file;
}
/** A file that is no SQLite database at all, larger than the 100-byte header. */
function placeText(file: string): string {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, 'not a database, but larger than one hundred bytes '.repeat(4));
  return file;
}

/** Every journal read the dashboard and the export can ask for (docs/journal.md, J10). */
const TRIP = '7a000000-0000-4000-8000-000000000001';
const QUERIES: JournalQuery[] = [{kind: 'trips', query: {}}, {kind: 'trips', query: {outcome: 'delivered'}}, {kind: 'trip', tripUuid: TRIP},
  {kind: 'events', tripUuid: TRIP, page: {limit: 100}}, {kind: 'intervals', tripUuid: TRIP, page: {limit: 100}}, {kind: 'samples', tripUuid: TRIP, page: {limit: 300}},
  {kind: 'database'}];

/**
 * One telemetry service's recording runtime under the workspace as LOCALAPPDATA, built by the production factory with the
 * real storage worker, and what main does with its messages: a `{type: 'recording', status}` message, cloned as the
 * parent port clones it, is accepted only as exactly those two keys with a status that parseRecordingHealth accepts, and
 * reduced into AppState health; a journal read goes from main's JournalBroker to the service's JournalService and back,
 * both directions cloned, and main forwards only a reply that its check accepts.
 */
function service(env: Record<string, string>) {
  expect(GAME_HISTORY_RECORDING).toBe(false);
  const logs: [string, unknown][] = [], states: V1SourceState[] = [], received: (RecordingHealth | 'rejected')[] = [], brokerLogs: [string, unknown][] = [];
  const worker = storageWorker();
  let workers = 0, stopping = false, health: AppHealth = initialHealth();
  const log = (event: string, _detail?: unknown, facts?: unknown) => { logs.push([event, facts]); };
  const runtime = createRecordingRuntime({env, gameHistory: GAME_HISTORY_RECORDING, localAppData: ws.directory, log,
    createWorker: () => { workers++; return worker.handle; }, historyOverrides: {appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS},
    statusOverrides: {intervalMs: 0}, onV1State: state => { states.push(state); },
    onRecordingStatus: status => {
      const message = structuredClone({type: 'recording', status}) as Record<string, unknown>;
      const parsed = Object.keys(message).length === 2 && Object.hasOwn(message, 'status') ? parseRecordingHealth(message.status) : undefined;
      received.push(parsed ?? 'rejected');
      health = reduceHealth(health, {type: 'recording', status: parsed ?? {state: 'unknown'}});
    }});
  const self = {runtime, stopped: false};
  current = self;
  const journal = new JournalService({history: runtime.history, stopping: () => stopping, log});
  const broker = new JournalBroker({log: (event, _detail, facts) => { brokerLogs.push([event, facts]); }});
  const channel: JournalServiceChannel = {postMessage: message => journal.receive(structuredClone(message), reply => broker.reply(channel, structuredClone(reply) as unknown as Record<string, unknown>))};
  broker.attach(channel);
  /** Starts the runtime and waits until the open settled and the refused open ended its worker. */
  const startRefused = async () => {
    runtime.start();
    await until(() => runtime.history.state !== 'idle' && runtime.history.state !== 'opening', 'the database open settling', HANG_GUARD_MS);
    expect(runtime.history.state).toBe('unavailable');
    // docs/storage.md: a refused open ends the worker at once; it closed in order.
    expect(await guarded(worker.exit, 'the storage worker exit after the refused open', HANG_GUARD_MS)).toBe(0);
  };
  /** The service's orderly stop: the status first, then the real shutdown sequence with the runtime's three steps. */
  const stop = async () => {
    stopping = true; self.stopped = true; runtime.stopStatus();
    const shutdown = tracedShutdown([]);
    runtime.register(shutdown.registrar);
    const result = await shutdown.sequence.run();
    return {result, steps: shutdown.steps};
  };
  return {runtime, logs, states, received, brokerLogs, health: () => health, workers: () => workers, stop,
    startRefused, read: (query: JournalQuery) => broker.request(query)};
}
type Service = ReturnType<typeof service>;

/** The refused database as every reader of the service sees it, with the journal answer of J11 for each read. */
async function expectUnavailable(s: Service, code: string) {
  expect(s.runtime.history.state).toBe('unavailable');
  expect(s.runtime.history.failureCode).toBe(code);
  expect([s.runtime.history.client, s.runtime.history.database, s.runtime.history.databaseUuid]).toEqual([undefined, undefined, undefined]);
  for (const query of QUERIES) expect(await s.read(query), query.kind).toEqual({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: code});
  // Main forwarded every reply: none was ignored or rejected by its check.
  expect(s.brokerLogs).toEqual([]);
  // One worker so far: the service has not re-opened history since the refusal (docs/storage.md, "Nothing retries yet").
  expect(s.workers()).toBe(1);
}
/** The orderly stop after a refused open: clean, every step ok, and the database is never reported as opened or closed. */
async function expectCleanStop(s: Service) {
  const {result, steps} = await s.stop();
  expect(result).toEqual({clean: true});
  expect(steps.map(({phase, name, outcome}) => `${phase} ${name} ${outcome}`)).toEqual(['intake v1-ingestion ok', 'flush recording-flush ok', 'storage history-storage ok']);
  expect(s.logs.map(([event]) => event).filter(event => /^HISTORY_/.test(event))).toEqual(['HISTORY_STORAGE_UNAVAILABLE']);
}

/** A pipe server that records the hellos of the v1 connections the ingestion makes to it, and answers nothing. */
async function helloServer() {
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  const hellos: ClientMessage[] = [], sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => undefined);
    const decoder = new FrameDecoder('client');
    socket.on('data', chunk => { try { decoder.push(chunk, m => { hellos.push(m as ClientMessage); }); } catch { /* only the hello is checked */ } });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  return {endpoint, hellos, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }};
}

const ZERO = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
/** A recording status of the synthetic target before any v1 observation, written by hand from G2 and G3. */
const synthetic = (state: string, code: string | null = null) => ({state, target: 'synthetic', code, losses: ZERO, trip: null});

describe('ET-019 PR-6: refused history databases through the production service wiring (default plan)', () => {
  // docs/storage.md, open sequence step 2-3: a newer schema or a foreign header is refused from the 100-byte header
  // without opening SQLite; a file without this application's schema but with user tables, and a file that is no
  // database, are DATABASE_UNRECOGNIZED; a database stamped for another purpose is PURPOSE_MISMATCH. Each is a refused
  // open whose file is unchanged (error code table), and history mode creates no backup (backups are taken only before a
  // migration). The default plan builds no trip recorder, so the status is `disabled` (G3 rule 1) whatever the database.
  const cases: [string, string, () => string][] = [
    ['a newer schema (user_version 999)', 'SCHEMA_NEWER', () => place('schema-newer-999.sqlite', historyFile())],
    ['a database of another application (application_id FORN)', 'DATABASE_UNRECOGNIZED', () => place('foreign-application.sqlite', historyFile())],
    ['the ET-001 probe layout: user tables without this application\'s schema', 'DATABASE_UNRECOGNIZED', () => placeProbe(historyFile())],
    ['a file that is no SQLite database', 'DATABASE_UNRECOGNIZED', () => placeText(historyFile())],
    ['a synthetic-purpose database at the history path', 'PURPOSE_MISMATCH', () => place('schema-v2-representative.sqlite', historyFile())]
  ];
  it.each(cases)('refuses %s with %s: history unavailable, recording disabled, the journal unavailable, nothing written', async (_name, code, setup) => {
    setup();
    const before = tree(root());
    expect(Object.keys(before)).toEqual(['data', 'data/telemetry.sqlite']);
    const s = service(DEFAULT_PLAN);
    await s.startRefused();
    expect(s.logs).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code}]]);
    await expectUnavailable(s, code);
    expect(s.received).toEqual([{state: 'disabled'}]);
    expect(s.health().recording).toEqual({state: 'disabled'});
    // Byte-identical, no sidecar, no backup directory, no other file under the data root.
    expect(tree(root())).toEqual(before);
    await expectCleanStop(s);
    expect(tree(root())).toEqual(before);
    expect(existsSync(historyBackups())).toBe(false);
  }, CASE_TIMEOUT_MS);

  it('refuses a history database held by another writer with DATABASE_LOCKED and does not re-open it before the orderly stop (second instance)', async () => {
    // docs/storage.md OD-8 and "Second instance": the exclusive lock makes the running writer the only connection; a
    // refused open, DATABASE_LOCKED among them, ends the worker at once and history stays unavailable until the service
    // starts again. The holder is this test's own connection to a new history database in the temporary LOCALAPPDATA.
    const holder = await ws.open({path: historyFile(), purpose: 'history', backupsDirectory: historyBackups()});
    const before = tree(root());
    const s = service(DEFAULT_PLAN);
    await s.startRefused();
    expect(s.logs).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code: 'DATABASE_LOCKED'}]]);
    await expectUnavailable(s, 'DATABASE_LOCKED');
    expect(s.received).toEqual([{state: 'disabled'}]);
    expect(tree(root())).toEqual(before);
    // The lock ends. Up to the orderly stop the service does not re-open history: still unavailable, still one worker.
    // This checks the state at these two points only; no retry mutation was applied, and there is no automatic re-open
    // to test (G10 keeps the status `stopped` for the service lifetime, docs/telemetry-service-v1.md; automatic re-open is a
    // deferred gap in docs/validation/et-015c.md).
    holder.close();
    await expectUnavailable(s, 'DATABASE_LOCKED');
    await expectCleanStop(s);
  }, CASE_TIMEOUT_MS);
});

describe('ET-019 PR-6: refused recording targets through the production service wiring (synthetic:t)', () => {
  /**
   * Starts a `synthetic:t` service on a database that is refused with `code`, then selects a synthetic v1 source: the
   * status reads `opening`, then `stopped <code>` for the service lifetime (G3 rule 3), the v1 hello is live-only and
   * durable delivery stays `off`, never `failed` (docs/telemetry-service-v1.md, "A refused target"), and the history
   * database is neither opened nor created (recording gate R3).
   */
  async function refusedTarget(code: string) {
    const server = await helloServer();
    const s = service(SYNTHETIC_PLAN);
    try {
      await s.startRefused();
      expect(s.logs).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_UNAVAILABLE', {code}]]);
      await until(() => s.received.length === 2, 'the stopped status', HANG_GUARD_MS);
      s.runtime.v1.select('synthetic', server.endpoint);
      await until(() => server.hellos.length === 1, 'the v1 hello', HANG_GUARD_MS);
      expect(server.hellos[0]).toMatchObject({kind: 'hello', data: {durableEvents: false}});
      expect(new Set(s.states.map(state => state.durable.state))).toEqual(new Set(['off']));
      await expectUnavailable(s, code);
      expect(s.received).toEqual([synthetic('opening'), synthetic('stopped', code)]);
      expect(s.health().recording).toEqual(synthetic('stopped', code));
      await expectCleanStop(s);
      // The status stopped before the shutdown, and nothing else reached main.
      expect(s.received).toHaveLength(2);
      expect(server.hellos).toHaveLength(1);
      expect(existsSync(historyFile())).toBe(false);
    } finally { await server.close(); }
    return s;
  }

  it.each([['a newer schema (user_version 999)', 'SCHEMA_NEWER', 'schema-newer-999.sqlite'], ['a database of another application (application_id FORN)', 'DATABASE_UNRECOGNIZED', 'foreign-application.sqlite']])(
    'refuses %s with %s: stopped, live-only, the journal unavailable, nothing written', async (_name, code, fixture) => {
      place(fixture, target());
      const before = tree(root());
      expect(Object.keys(before)).toEqual(['synthetic', 'synthetic/t.sqlite']);
      await refusedTarget(code);
      expect(tree(root())).toEqual(before);
    }, CASE_TIMEOUT_MS);

  // docs/storage.md, migrations and backups: an existing database below the supported version is backed up and verified
  // first; "A file in place of the backup directory is BACKUP_FAILED with cause DATA_PATH_INVALID", "A backup failure
  // migrates nothing" and "Any failure removes the partial files". HistoryStorage reports the code, not its cause. The
  // immutable version 1 fixture has the synthetic purpose, so the case uses the synthetic target and its backups folder.
  it('refuses to migrate a version 1 database whose backup cannot be written (a file in place of the backups folder): BACKUP_FAILED, still version 1, no backup', async () => {
    place(REPRESENTATIVE, target());
    writeFileSync(targetBackups(), 'a file where the backup directory belongs');
    const blocker = sha256(targetBackups()), original = digestOf(target()), bytes = readFileSync(target());
    expect(original.userVersion).toBe(1);
    await refusedTarget('BACKUP_FAILED');
    expectNotMigrated(original, bytes);
    // The blocker is still the same file, and nothing else appeared: no backup, partial, manifest or sidecar.
    expect(lstatSync(targetBackups()).isFile()).toBe(true);
    expect(sha256(targetBackups())).toBe(blocker);
    expect(Object.keys(tree(root()))).toEqual(['synthetic', 'synthetic/backups', 'synthetic/t.sqlite']);
  }, CASE_TIMEOUT_MS);

  it('refuses to migrate a version 1 database whose backup copy fails its verification: BACKUP_FAILED, still version 1, the partial copy removed', async () => {
    // A version 1 job configuration whose event is missing: the backup is copied into the backups folder and its
    // foreign_key_check refuses it before 0002 runs (as in migrations.test.ts); the copy is written, then removed.
    place(REPRESENTATIVE, target());
    const db = new Database(target());
    try {
      db.pragma('foreign_keys = OFF');
      db.exec('CREATE TEMP TABLE j AS SELECT * FROM job_configurations WHERE id = 1; UPDATE j SET id = 2, event_ref = 999; INSERT INTO job_configurations SELECT * FROM j;');
    } finally { db.close(); }
    const original = digestOf(target()), bytes = readFileSync(target());
    await refusedTarget('BACKUP_FAILED');
    expectNotMigrated(original, bytes);
    // The backups folder was created for the copy and is empty again: no backup, partial, manifest or sidecar remains.
    const after = tree(root());
    expect([Object.keys(after), after['synthetic/backups']]).toEqual([['synthetic', 'synthetic/backups', 'synthetic/t.sqlite'], 'dir']);
  }, CASE_TIMEOUT_MS);
});

/**
 * The target after a refused migration: the same logical content at version 1, only migration 0001 recorded, sound, and
 * every byte after the 100-byte file header unchanged. docs/storage.md does not claim a byte-identical file for
 * BACKUP_FAILED: the writer open takes the exclusive lock and sets WAL (open sequence steps 5-10) before the backup, so
 * the header records WAL (file format bytes 18 and 19 are 2) and SQLite's change counter may differ. No page changes.
 */
function expectNotMigrated(original: ReturnType<typeof digestOf>, bytes: Buffer) {
  const now = readFileSync(target());
  expect(now.length).toBe(bytes.length);
  expect(now.subarray(100).equals(bytes.subarray(100))).toBe(true);
  expect([now[18], now[19]]).toEqual([2, 2]);
  expect(digestOf(target())).toEqual(original);
  readOnly(target(), db => {
    expect(db.pragma('user_version', {simple: true})).toBe(1);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all()).toEqual([1]);
    expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
  });
}
