// ET-112g history repair (REG-001, REG-003, REG-005, REG-006, REG-008, REG-012, REG-013, REG-014): the verified copy, the
// dry run on a scratch copy and the owner-attested join of a closed proof-less segment, applied one action per transaction
// after a verified pre-repair backup. The legacy incident replica is the synthetic ET-112 corpus
// (tests/shared/trip-continuation-incident.ts) recorded at schema 8, its last segment never proven, then reopened at the
// current schema. Expected values are written by hand from docs/storage.md ("History repair") and the corpus.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {validateJournalEventPage, validateJournalTripDetail} from '../../packages/contracts/src/journal';
import {applyHistoryRepair, copyHistory, dryRunHistoryRepair, MIGRATIONS, openStorage, repairConfirmationCode, repairFingerprint, Storage, type Purpose, type RepairPlan,
  type RepairSummary} from '../../packages/storage/src/index';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {tripUuidFor} from '../../packages/telemetry-core/src';
import {INCIDENT_OTHER_JOB, INCIDENT_SEGMENTS, INCIDENT_SESSIONS, incidentTripUuid} from '../shared/trip-continuation-incident';
import {r, Script} from '../shared/trip-messages';
import {digestOf, ok, readOnly, sha256, uploadTestOwner, workspace} from './helpers';
import {drive, EXTRA_SESSIONS, OTHER_SCOPE} from './incident-driver';

const CHILD = path.resolve('tests/storage/fixtures/history-repair-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');

let ws: Awaited<ReturnType<typeof workspace>>;
const opened: Storage[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { for (const storage of opened.splice(0)) if (!storage.closed) storage.close(); await ws.dispose(); });

const [S1, S2, S3] = INCIDENT_SEGMENTS;
/** The incident's last process with its proof never admitted while its raw trip is recorded. */
const UNPROVEN = {...S3, profileFromMs: 99_999};
const T = incidentTripUuid(0), S = incidentTripUuid(2), APP = '0.1.0-test';
const notObserved = {available: false, reason: 'not-observed'} as const;
/** The incident root after the attested join: an engine-0 target keeps distance and fuel not observed in g1. */
const AFTER: RepairSummary = {outcome: 'delivered', recordingCompleteness: 'partial', sources: 3, distanceM: notObserved, fuelUsedL: notObserved,
  deliveredDistanceM: {available: true, value: 187342.01049804688}, revenue: {available: true, value: {raw: '9978', sdkType: 's64'}},
  hardMode: {passingChecks: 178, failingChecks: 0, unknownChecks: 74, qualified: true}, upload: {bound: false, held: false, holdReason: null, identity: null}};

/** Records the incident (or `build`) at schema 8 in `file`, then reopens it once at the current schema. */
async function legacy(file = ws.database, build?: (storage: Storage) => void, purpose: Purpose = 'synthetic'): Promise<void> {
  const old = ok(await openStorage(ws.options({path: file, purpose, migrations: MIGRATIONS.slice(0, 8)})));
  if (build) build(old); else { drive(old, S1, {game: purpose === 'history'}); drive(old, S2, {game: purpose === 'history'}); drive(old, UNPROVEN, {game: purpose === 'history'}); }
  ok(old.close());
  ok(ok(await openStorage(ws.options({path: file, purpose}))).close());
}
const scratchParent = () => { const directory = path.join(ws.directory, 'scratch'); mkdirSync(directory, {recursive: true}); return directory; };
const backups = () => path.join(ws.directory, 'repair-backups');
let files = 0;
const fresh = (name: string) => path.join(ws.directory, `${++files}-${name}`);
async function dryRun(database: string, attest: string[] = [], testHooks?: Parameters<typeof dryRunHistoryRepair>[0]['testHooks']): Promise<{plan: RepairPlan; out: string}> {
  const out = fresh('plan.json'), result = await dryRunHistoryRepair({database, out, attest, appVersion: APP, now: ws.now, scratchParent: scratchParent(), ...(testHooks ? {testHooks} : {})});
  if (!result.ok) throw new Error(`dry run failed: ${result.error.code}`);
  return {plan: result.value, out};
}
/** Applies a plan file; the clock advances first, so every pre-repair backup gets its own name. */
function apply(database: string, out: string, confirm: string, extra: Partial<Parameters<typeof applyHistoryRepair>[0]> = {}) {
  ws.advance(1_000);
  return applyHistoryRepair({database, plan: out, confirm, appVersion: APP, now: ws.now, backupsDirectory: backups(), ...extra});
}
async function applied(database: string, out: string, confirm: string, extra: Partial<Parameters<typeof applyHistoryRepair>[0]> = {}) {
  const result = await apply(database, out, confirm, extra);
  if (!result.ok) throw new Error(`apply failed: ${result.error.code}${'reason' in result.error ? `/${result.error.reason}` : ''}`);
  return result.value;
}
const copyOf = (file: string, name: string) => { const target = fresh(name); copyFileSync(file, target); return target; };
const sidecars = (file: string) => ['-wal', '-shm', '-journal'].filter(suffix => existsSync(file + suffix));
const safe = <T>(file: string, body: (db: Database.Database) => T) => readOnly(file, db => { db.defaultSafeIntegers(true); return body(db); });
const membership = (file: string, uuid: string) => readOnly(file, db => db.prepare(`SELECT t.id, m.logical_ref, m.previous_logical_ref, m.proof_json FROM trips t
  JOIN logical_memberships m ON m.trip_ref = t.id WHERE t.trip_uuid = ?`).get(uuid));
/** SHA-256 per raw table: the repair moves memberships only, never samples, events, attributions or jobs. */
const rawDigest = (file: string) => readOnly(file, db => Object.fromEntries(['samples', 'events', 'event_attributions', 'job_configurations', 'completeness_intervals', 'plugin_sessions'].map(table =>
  [table, createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).raw(true).all())).digest('hex')])));
async function storageOf(file: string, purpose: Purpose = 'synthetic'): Promise<Storage> {
  const storage = ok(await openStorage(ws.options({path: file, purpose})));
  opened.push(storage);
  return storage;
}
let pins = 0;
/** The prepared upload projection of a raw trip's root; its pin is released again. */
function projection(storage: Storage, uuid: string) {
  const pinId = `70000000-0000-4000-8000-${String(++pins).padStart(12, '0')}`;
  let state = ok(storage.beginUploadProjection({pinId, tripUuid: uuid}));
  for (let turn = 0; state.state === 'preparing' && turn < 1000; turn++) state = ok(storage.advanceUploadProjection(pinId));
  const prepared = state.projection;
  let released = ok(storage.releaseUploadProjection(pinId));
  for (let turn = 0; released.state === 'releasing' && turn < 1000; turn++) released = ok(storage.releaseUploadProjection(pinId));
  return prepared;
}
/** The hand-written incident result after the join: one delivered root with three sources, its delivery once. */
async function expectRepaired(file: string) {
  const storage = await storageOf(file);
  expect(ok(storage.journalTrips()).trips.map(trip => trip.tripUuid)).toEqual([T]);
  const detail = validateJournalTripDetail(ok(storage.journalTrip(T)));
  expect(detail.trip).toMatchObject({outcome: 'delivered', recordingCompleteness: 'partial', observedDistanceM: notObserved, fuelUsedL: notObserved,
    isHardMode: true, hardModeDetails: {version: 2, passingChecks: 178, failingChecks: 0, unknownChecks: 74}});
  expect(detail.exportBounds.sources?.map(source => source.pluginSessionId)).toEqual([...INCIDENT_SESSIONS]);
  expect(detail.outcomeDetails?.record).toMatchObject({type: 'job.delivered', revenue: {available: true, value: {raw: '9978', sdkType: 's64'}},
    distance: {available: true, value: 187342.01049804688, unit: 'm'}});
  expect(validateJournalEventPage(ok(storage.journalEvents(T, {limit: 500}))).events.filter(event => event.type === 'job.delivered')).toHaveLength(1);
  const prepared = projection(storage, T);
  expect(prepared?.rootReadiness).toBe('ready');
  expect(prepared?.facts.revenue).toMatchObject({available: true, value: {raw: '9978', sdkType: 's64'}});
  ok(storage.close());
  expect(readOnly(file, db => db.prepare('SELECT member_count FROM logical_trips WHERE id = 1').pluck().get())).toBe(3);
}

/** Runs the child fixture under the same Electron runtime with a named hang guard; resolves at the line `until`, or at exit. */
async function runChild(mode: 'record' | 'apply', config: unknown, until?: string): Promise<{child: ReturnType<typeof spawn>; lines: string[]; stderr: () => string}> {
  const configFile = fresh('child.json');
  writeFileSync(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [CHILD, mode, configFile], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const lines: string[] = [];
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const reached = new Promise<void>((resolve, reject) => {
    // Hang guard: the child answers within seconds; this bound only diagnoses a missing line and never times product behavior.
    const guard = setTimeout(() => { child.kill(); reject(new Error(`Hang guard: history repair child did not print ${until ?? 'exit'}`)); }, 25_000);
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      const parts = stdout.split('\n'); stdout = parts.pop() ?? '';
      for (const line of parts) { lines.push(line.trim()); if (until && line.trim() === until) { clearTimeout(guard); resolve(); } }
    });
    child.on('close', () => { clearTimeout(guard); resolve(); });
  });
  await reached;
  return {child, lines, stderr: () => stderr};
}
/** Terminates the child unless it already exited, and waits for its close. */
async function terminated(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

describe('ET-112g history repair of the legacy incident', () => {
  it('lists the delivered segment as a candidate that needs evidence and plans nothing without --attest', async () => {
    await legacy();
    const {plan} = await dryRun(ws.database);
    expect(plan.actions).toEqual([]);
    expect(plan.listings).toEqual([{segmentTripUuid: S, targetTripUuid: T, state: 'needs-attestation', reason: null}]);
    expect(plan.confirmation).toBe(repairConfirmationCode([]));
  });
  it('never changes the input, its sidecars or the scratch directory, also after an injected failure', async () => {
    await legacy();
    const before = {sha: sha256(ws.database), digest: digestOf(ws.database)};
    const out = fresh('plan.json');
    const failedRun = await dryRunHistoryRepair({database: ws.database, out, attest: [S], appVersion: APP, now: ws.now, scratchParent: scratchParent(),
      testHooks: {beforeCommit: () => { throw new Error('injected'); }}});
    expect(failedRun.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
    for (const run of [false, true]) {
      if (run) expect((await dryRun(ws.database, [S])).plan.actions).toHaveLength(1);
      expect(sha256(ws.database)).toBe(before.sha);
      expect(sidecars(ws.database)).toEqual([]);
      expect(readdirSync(scratchParent())).toEqual([]);
      expect(digestOf(ws.database)).toEqual(before.digest);
    }
  });
  it('joins the attested segment: one delivered trip with three sources, its revenue and Hard Mode once, raw rows unchanged', async () => {
    await legacy();
    expect(ok((await storageOf(ws.database)).journalTrips()).trips.map(trip => trip.tripUuid).sort()).toEqual([T, S].sort());
    opened.splice(0).forEach(storage => storage.close());
    const {plan, out} = await dryRun(ws.database, [S]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({kind: 'join', segmentTripUuid: S, targetTripUuid: T, after: AFTER,
      before: {segment: {outcome: 'delivered', sources: 1, hardMode: {passingChecks: 0, failingChecks: 0, unknownChecks: 74, qualified: false}},
        target: {outcome: 'open', sources: 2, revenue: null, hardMode: {passingChecks: 178, failingChecks: 0, unknownChecks: 0, qualified: false}}}});
    expect(plan.listings).toEqual([]);
    const copy = copyOf(ws.database, 'copy.sqlite'), raw = rawDigest(copy);
    const result = await applied(copy, out, plan.confirmation);
    expect(result.actions).toEqual([{segmentTripUuid: S, targetTripUuid: T, status: 'applied'}]);
    expect(rawDigest(copy)).toEqual(raw);
    expect(membership(copy, S)).toEqual({id: 3, logical_ref: 1, previous_logical_ref: 3, proof_json: null});
    await expectRepaired(copy);
  });
  it('is idempotent: a second dry run plans nothing and reports the segment joined, and the old plan applies as already-applied', async () => {
    await legacy();
    const {plan, out} = await dryRun(ws.database, [S]), copy = copyOf(ws.database, 'copy.sqlite');
    await applied(copy, out, plan.confirmation);
    const second = await dryRun(copy, [S]);
    expect(second.plan.actions).toEqual([]);
    expect(second.plan.listings).toEqual([{segmentTripUuid: S, targetTripUuid: T, state: 'already-joined', reason: null}]);
    const digest = digestOf(copy);
    expect((await applied(copy, out, plan.confirmation)).actions).toEqual([{segmentTripUuid: S, targetTripUuid: T, status: 'already-applied'}]);
    expect(digestOf(copy)).toEqual(digest);
  });
});

describe('ET-112g interrupted repair (REG-006)', () => {
  const T2 = tripUuidFor(EXTRA_SESSIONS[0], '1'), S2nd = tripUuidFor(EXTRA_SESSIONS[2], '1');
  /** Two legacy incidents in one database: the second of another job in another profile scope, so neither is a candidate of the other. */
  const twoIncidents = () => legacy(ws.database, storage => {
    drive(storage, S1); drive(storage, S2); drive(storage, UNPROVEN);
    drive(storage, {...S1, session: EXTRA_SESSIONS[0]}, {job: INCIDENT_OTHER_JOB, scope: OTHER_SCOPE});
    drive(storage, {...S2, session: EXTRA_SESSIONS[1]}, {job: INCIDENT_OTHER_JOB, scope: OTHER_SCOPE});
    drive(storage, {...UNPROVEN, session: EXTRA_SESSIONS[2]}, {job: INCIDENT_OTHER_JOB});
  });
  it('keeps the first join committed when the second throws inside its transaction, and resumes', async () => {
    await twoIncidents();
    const {plan, out} = await dryRun(ws.database, [S, S2nd]);
    expect(plan.actions.map(action => [action.segmentTripUuid, action.targetTripUuid])).toEqual([[S, T], [S2nd, T2]]);
    const copy = copyOf(ws.database, 'copy.sqlite');
    const interrupted = await apply(copy, out, plan.confirmation, {testHooks: {beforeCommit: index => { if (index === 1) throw new Error('injected'); }}});
    expect(interrupted.ok).toBe(false);
    expect(membership(copy, S)).toMatchObject({logical_ref: 1});
    expect(membership(copy, S2nd)).toMatchObject({id: 6, logical_ref: 6, previous_logical_ref: null});
    expect((await applied(copy, out, plan.confirmation)).actions.map(action => action.status)).toEqual(['already-applied', 'applied']);
    expect(membership(copy, S2nd)).toMatchObject({logical_ref: 4, previous_logical_ref: 6});
  });
  it('recovers a child process terminated inside the second join and resumes', async () => {
    await twoIncidents();
    const {plan, out} = await dryRun(ws.database, [S, S2nd]), copy = copyOf(ws.database, 'copy.sqlite');
    const run = await runChild('apply', {killAt: 1, apply: {database: copy, plan: out, confirm: plan.confirmation, appVersion: APP, backupsDirectory: backups()}});
    await terminated(run.child);
    expect(run.stderr()).toBe('');
    expect(run.lines).toEqual(['ready']);
    expect(readOnly(copy, db => db.pragma('integrity_check', {simple: true}))).toBe('ok');
    expect(membership(copy, S)).toMatchObject({logical_ref: 1});
    expect(membership(copy, S2nd)).toMatchObject({logical_ref: 6});
    expect((await applied(copy, out, plan.confirmation, {now: () => Date.now()})).actions.map(action => action.status)).toEqual(['already-applied', 'applied']);
  });
});

describe('ET-112g repair against concurrent recording', () => {
  it('finds a live join of the same job into the target after the dry run stale and applies nothing', async () => {
    await legacy();
    const {plan, out} = await dryRun(ws.database, [S]);
    const storage = await storageOf(ws.database);
    drive(storage, {...S2, session: EXTRA_SESSIONS[0]});
    ok(storage.close());
    expect(membership(ws.database, tripUuidFor(EXTRA_SESSIONS[0], '1'))).toMatchObject({logical_ref: 1});
    const digest = digestOf(ws.database);
    expect((await applied(ws.database, out, plan.confirmation)).actions.map(action => action.status)).toEqual(['stale']);
    expect(membership(ws.database, S)).toMatchObject({logical_ref: 3});
    expect(digestOf(ws.database)).toEqual(digest);
  });
  it('still applies the join after an unrelated trip was recorded', async () => {
    await legacy();
    const {plan, out} = await dryRun(ws.database, [S]);
    const storage = await storageOf(ws.database);
    drive(storage, {...S1, session: EXTRA_SESSIONS[0]}, {job: INCIDENT_OTHER_JOB, scope: OTHER_SCOPE, end: 'delivered'});
    ok(storage.close());
    expect((await applied(ws.database, out, plan.confirmation)).actions.map(action => action.status)).toEqual(['applied']);
    expect(membership(ws.database, S)).toMatchObject({logical_ref: 1});
  });
  it('refuses to apply while another writer holds the database: no backup and no change', async () => {
    await legacy();
    const {plan, out} = await dryRun(ws.database, [S]), digest = digestOf(ws.database);
    const storage = await storageOf(ws.database);
    const result = await apply(ws.database, out, plan.confirmation);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DATABASE_LOCKED');
    ok(storage.close());
    expect(existsSync(backups())).toBe(false);
    expect(digestOf(ws.database)).toEqual(digest);
  });
});

describe('ET-112g old-history ambiguity is never joined', () => {
  const S4 = tripUuidFor(S3.session, '1');
  it.each([
    ['two verified candidates in different scopes', (storage: Storage) => { drive(storage, S1); drive(storage, {...S1, session: EXTRA_SESSIONS[0]}, {scope: OTHER_SCOPE}); drive(storage, UNPROVEN); }, 'ambiguous-candidates'],
    ['another job recorded between the target and the segment', (storage: Storage) => {
      drive(storage, S1); drive(storage, S2); drive(storage, {...UNPROVEN, session: EXTRA_SESSIONS[0]}, {job: INCIDENT_OTHER_JOB}); drive(storage, UNPROVEN);
    }, 'intervening-trip'],
    ['a delivered target', (storage: Storage) => { drive(storage, S1); drive(storage, S2, {end: 'delivered'}); drive(storage, UNPROVEN); }, 'no-candidate'],
    ['a segment of a different job', (storage: Storage) => { drive(storage, S1); drive(storage, S2); drive(storage, UNPROVEN, {job: INCIDENT_OTHER_JOB}); }, 'no-candidate'],
    ['a target whose latest member is still open', (storage: Storage) => { drive(storage, S1, {end: 'open'}); drive(storage, UNPROVEN); }, 'target-open']
  ] as const)('does not join %s', async (_name, build, reason) => {
    await legacy(ws.database, build);
    const {plan} = await dryRun(ws.database, [S4]);
    expect(plan.actions).toEqual([]);
    expect(plan.listings).toEqual([{segmentTripUuid: S4, targetTripUuid: null, state: 'not-eligible', reason}]);
  });
  it.each(['schema-v8-representative.sqlite', 'schema-v9-representative.sqlite'])('plans no join in a copy of %s, even with every closed trip attested', async name => {
    const input = ws.copyFixture(name, fresh(name)), twin = ws.copyFixture(name, fresh(name)), sha = sha256(input);
    const closed = readOnly(input, db => db.prepare("SELECT trip_uuid FROM trips WHERE outcome <> 'open' ORDER BY id").pluck().all() as string[]);
    const purpose = readOnly(input, db => db.prepare('SELECT purpose FROM database_info WHERE id = 1').pluck().get() as Purpose);
    const {plan, out} = await dryRun(input, closed);
    expect(plan.actions).toEqual([]);
    expect(sha256(input)).toBe(sha);
    expect((await applied(input, out, plan.confirmation)).actions).toEqual([]);
    const journal = async (file: string) => { const storage = await storageOf(file, purpose), page = ok(storage.journalTrips()); ok(storage.close()); return page; };
    expect(await journal(input)).toEqual(await journal(twin));
  });
});

describe('ET-112g publication', () => {
  /** A Dashboard owner and a test-only source binding of `root`, as a binding made by an earlier publication. */
  async function bind(file: string, purpose: Purpose, root: number, uuid: string, session: string) {
    const conn = await openConnection(ws.options({path: file, purpose})), storage = new Storage(conn);
    opened.push(storage);
    const owner = await uploadTestOwner(storage);
    ok(storage.confirmUploadOwner({confirmationId: owner.runId, registrationId: owner.registrationId, credentialGeneration: 'generation', expectedVersion: '0'}));
    const db = conn.writer(), run = db.prepare('SELECT active_run FROM upload_connection WHERE id = 1').pluck().get();
    db.prepare(`INSERT INTO upload_source_bindings(root_ref, registration_ref, run_ref, mode, game, plugin_session_uuid, trip_uuid) VALUES (?, ?, ?, 'live', 'ets2', ?, ?)`)
      .run(root, owner.registrationId, run, session, uuid);
    ok(storage.close());
  }
  it('lists a separately published segment as reconciliation-required and refuses a forged action for it (F-D7)', async () => {
    await legacy();
    await bind(ws.database, 'synthetic', 3, S, INCIDENT_SESSIONS[2]);
    const {plan} = await dryRun(ws.database, [S]);
    expect(plan.actions).toEqual([]);
    expect(plan.listings).toEqual([{segmentTripUuid: S, targetTripUuid: T, state: 'reconciliation-required', reason: null}]);
    const fingerprint = safe(ws.database, db => repairFingerprint(db, 3n, 1n));
    const actions: RepairPlan['actions'] = [{kind: 'join', segmentTripUuid: S, targetTripUuid: T, fingerprint, before: {segment: AFTER, target: AFTER}, after: AFTER}];
    const forged = fresh('forged.json'), code = repairConfirmationCode(actions);
    writeFileSync(forged, JSON.stringify({...plan, actions, confirmation: code}));
    const digest = digestOf(ws.database);
    expect((await applied(ws.database, forged, code)).actions.map(action => action.status)).toEqual(['refused']);
    expect(membership(ws.database, S)).toMatchObject({logical_ref: 3});
    expect(digestOf(ws.database)).toEqual(digest);
  });
  it('publishes the join as the next revision of a bound target under its own binding and keeps its receipts', async () => {
    await legacy(ws.database, undefined, 'history');
    await bind(ws.database, 'history', 1, T, INCIDENT_SESSIONS[0]);
    const {plan, out} = await dryRun(ws.database, [S]);
    expect(plan.actions[0]?.after.upload).toEqual({bound: true, held: false, holdReason: null, identity: 'resolved'});
    const upload = () => safe(ws.database, db => ({
      bindings: db.prepare('SELECT root_ref, trip_uuid, held FROM upload_source_bindings ORDER BY root_ref').all(),
      receipts: db.prepare('SELECT * FROM upload_receipts ORDER BY rowid').all(),
      last: db.prepare('SELECT max(position) FROM upload_source_transitions').pluck().get() as bigint
    }));
    const before = upload();
    expect((await applied(ws.database, out, plan.confirmation)).actions.map(action => action.status)).toEqual(['applied']);
    const after = safe(ws.database, db => ({
      bindings: db.prepare('SELECT root_ref, trip_uuid, held FROM upload_source_bindings ORDER BY root_ref').all(),
      receipts: db.prepare('SELECT * FROM upload_receipts ORDER BY rowid').all(),
      transitions: db.prepare('SELECT root_ref, kind FROM upload_source_transitions WHERE position > ? ORDER BY position').all(before.last),
      segment: db.prepare('SELECT r.identity_state FROM upload_reservations r JOIN upload_candidates c ON c.ordinal = r.candidate_ref WHERE c.trip_ref = 3').pluck().get()
    }));
    expect(after.bindings).toEqual([{root_ref: 1n, trip_uuid: T, held: 0n}]);
    expect(after.receipts).toEqual(before.receipts);
    // The membership change bumps the root's evidence version (schema 5 trigger), a context transition, as a live join does;
    // the join's revision is then the root's first terminal one.
    expect(after.transitions.filter(row => (row as {root_ref: bigint}).root_ref === 1n)).toEqual([{root_ref: 1n, kind: 'context'}, {root_ref: 1n, kind: 'terminal'}]);
    expect(after.segment).toBe('redirected');
  });
});

describe('ET-112g backups and refusals', () => {
  it('takes a verified pre-repair backup of the content before the repair, which copy reproduces', async () => {
    await legacy();
    const before = digestOf(ws.database), {plan, out} = await dryRun(ws.database, [S]);
    const result = await applied(ws.database, out, plan.confirmation);
    expect(result.backupFileName).toMatch(/^repair-[0-9a-f]{8}-v10-[0-9]{8}T[0-9]{9}Z\.sqlite$/);
    const backup = path.join(backups(), result.backupFileName), manifest = JSON.parse(readFileSync(backup.replace(/\.sqlite$/, '.json'), 'utf8'));
    expect(manifest).toMatchObject({format: 'ets2telemetry-backup-1', reason: 'pre-repair', databaseUuid: result.databaseUuid, fromVersion: 10, fileName: result.backupFileName,
      fileSha256: sha256(backup), size: statSync(backup).size, logicalDigest: before.logicalDigest, rowCounts: before.rowCounts});
    expect(JSON.parse(readFileSync(backup.replace(/\.sqlite$/, '.result.json'), 'utf8'))).toEqual(result);
    const restored = fresh('restored.sqlite');
    const copy = await copyHistory({from: backup, to: restored});
    expect(copy).toMatchObject({ok: true, value: {databaseUuid: result.databaseUuid, logicalDigest: before.logicalDigest}});
    expect(digestOf(restored)).toEqual(before);
    // An existing target is never overwritten.
    expect(await copyHistory({from: backup, to: restored})).toMatchObject({ok: false, error: {code: 'DATA_PATH_INVALID'}});
  });
  it('refuses a working history file without --working-history and at another schema, and repairs it with the flag', async () => {
    await legacy(ws.database, undefined, 'history');
    const history = path.join(ws.directory, 'profile', 'ETS2TelemetryStaging', 'data', 'telemetry.sqlite');
    mkdirSync(path.dirname(history), {recursive: true});
    copyFileSync(ws.database, history);
    const {plan, out} = await dryRun(history, [S]), sha = sha256(history);
    expect(await apply(history, out, plan.confirmation)).toMatchObject({ok: false, error: {code: 'REPAIR_REFUSED', reason: 'working-history-flag'}});
    expect(await apply(history, out, 'ffffffff', {workingHistory: true})).toMatchObject({ok: false, error: {code: 'REPAIR_REFUSED', reason: 'confirmation-mismatch'}});
    expect(sha256(history)).toBe(sha);
    expect(existsSync(backups())).toBe(false);
    const older = path.join(ws.directory, 'older', 'ETS2TelemetryStaging', 'data', 'telemetry.sqlite');
    mkdirSync(path.dirname(older), {recursive: true});
    ws.copyFixture('schema-v9-representative.sqlite', older);
    const olderSha = sha256(older), olderPlan = await dryRun(older);
    expect(await apply(older, olderPlan.out, olderPlan.plan.confirmation, {workingHistory: true, backupsDirectory: undefined}))
      .toMatchObject({ok: false, error: {code: 'REPAIR_REFUSED', reason: 'working-history-schema'}});
    expect(sha256(older)).toBe(olderSha);
    expect(existsSync(path.join(path.dirname(older), 'repair-backups'))).toBe(false);
    expect((await applied(history, out, plan.confirmation, {workingHistory: true, backupsDirectory: undefined})).actions.map(action => action.status)).toEqual(['applied']);
    expect(readdirSync(path.join(path.dirname(history), 'repair-backups')).filter(name => name.endsWith('.sqlite'))).toHaveLength(1);
  });
  it('copies the committed WAL content a terminated writer left behind', async () => {
    const file = fresh('wal.sqlite'), script = new Script('10000000-0000-4000-8000-0000000000aa');
    const configured = script.event(r.jobConfigured()), uuid = tripUuidFor(script.session, configured.data.eventSeq);
    const run = await runChild('record', {open: ws.options({path: file, now: undefined}), welcome: script.welcome(),
      stream: [{message: configured, effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
        jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1000}]}]}, 'ready');
    await terminated(run.child);
    expect(run.stderr()).toBe('');
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const target = fresh('wal-copy.sqlite'), copy = await copyHistory({from: file, to: target});
    expect(copy.ok).toBe(true);
    expect(sidecars(target)).toEqual([]);
    expect(readOnly(target, db => ({mode: db.pragma('journal_mode', {simple: true}), trips: db.prepare('SELECT trip_uuid FROM trips').pluck().all()}))).toEqual({mode: 'delete', trips: [uuid]});
    expect(sidecars(file)).toEqual(['-wal']);
  });
});

describe('ET-112g schema-9 segments', () => {
  it('lets an attested pending segment wait, and joins it once the next session made it separate/process-ended', async () => {
    let storage = await storageOf(ws.database);
    drive(storage, S1); drive(storage, S2); drive(storage, UNPROVEN);
    ok(storage.close());
    const decision = () => readOnly(ws.database, db => db.prepare('SELECT state, reason FROM logical_membership_decisions WHERE trip_ref = 3').get());
    expect(decision()).toEqual({state: 'pending', reason: 'profile-unverified'});
    const waiting = await dryRun(ws.database, [S]);
    expect(waiting.plan.actions).toEqual([]);
    expect(waiting.plan.listings).toEqual([{segmentTripUuid: S, targetTripUuid: null, state: 'wait', reason: 'pending'}]);
    storage = await storageOf(ws.database);
    ok(storage.upsertSession({message: new Script(EXTRA_SESSIONS[0]).welcome()}));
    ok(storage.close());
    expect(decision()).toEqual({state: 'separate', reason: 'process-ended'});
    const {plan, out} = await dryRun(ws.database, [S]);
    expect(plan.actions.map(action => [action.segmentTripUuid, action.targetTripUuid, action.after.outcome, action.after.sources])).toEqual([[S, T, 'delivered', 3]]);
    expect((await applied(ws.database, out, plan.confirmation)).actions.map(action => action.status)).toEqual(['applied']);
    expect(decision()).toEqual({state: 'separate', reason: 'process-ended'});
  });
});
