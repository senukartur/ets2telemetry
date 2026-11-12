// History repair (ET-112g, docs/storage.md "History repair"): the owner-attested join of a closed, proof-less singleton
// segment into the root of its earlier recordings. The candidate scan, the facts and fingerprint of one join, the root
// summary and the join action, each in one write transaction on the verified writer connection. The orchestration in
// ../history-repair.ts runs it on a scratch copy (dry run) or, after a verified backup, on the database itself.
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {decideRepairJoin, type RepairJoinDecision} from '../../../telemetry-core/src/trips/membership';
import type {RepairActionResult, RepairJoinAction, RepairListing, RepairOptions, RepairScan, RepairSummary} from '../api';
import {fail} from '../errors';
import {canonicalJson} from '../history-repair-plan';
import type {StorageConnection} from './connection';
import {rootBound} from './identity-pending';
import {journalTrip} from './journal';
import {closedCandidates, decisionsEnabled, encodeRow, joinClosedMember, type LogicalRow} from './logical-trips';
import {startReplayBudget} from './quantities';

const SCAN_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as LogicalRow | undefined;

/** The raw trip `row` is a closed singleton self-root without profile proof: the only shape a repair join may move. */
function closedSingleton(db: Database.Database, row: LogicalRow): boolean {
  const m = get(db, 'SELECT m.logical_ref, m.proof_json, l.member_count FROM logical_memberships m JOIN logical_trips l ON l.id = m.trip_ref WHERE m.trip_ref = ?', row.id);
  return m !== undefined && m.logical_ref === row.id && m.member_count === 1n && m.proof_json === null && row.outcome !== 'open';
}

/** decideRepairJoin for the closed singleton segment `row`, from the stored rows; LogicalRow targets are logical_trips rows. */
function decide(db: Database.Database, row: LogicalRow, attested: boolean): RepairJoinDecision<LogicalRow> {
  const id = row.id as bigint, group = get(db, 'SELECT * FROM logical_trips WHERE id = ?', id)!;
  const stored = decisionsEnabled(db) ? get(db, 'SELECT state, reason FROM logical_membership_decisions WHERE trip_ref = ?', id) : undefined;
  const decision = stored ? {state: stored.state as 'pending' | 'joined' | 'root' | 'separate', reason: String(stored.reason)} : null;
  if (decision?.state === 'pending') return {state: 'wait', reason: 'pending'};
  const {recordedJob, learned, candidates} = closedCandidates(db, row, group, null);
  return decideRepairJoin({decision, attested, ownRootBound: rootBound(db, id)}, {recordedJob, consistent: learned !== null, candidates}, target => {
    const latest = target.latest_trip_ref as bigint;
    return {latest, latestOpen: get(db, 'SELECT outcome FROM trips WHERE id = ?', latest)?.outcome === 'open',
      intervening: get(db, 'SELECT 1 FROM trips WHERE game = ? AND id > ? AND id < ? LIMIT 1', row.game, latest, id) !== undefined};
  }, id);
}

/**
 * Content fingerprint of a join of segment S into target T: S's trip, membership and decision rows, T's logical_trips row,
 * the latest projection state of S and of T, and whether each root is bound. No global revision id is part of it, so an
 * unrelated recording leaves it unchanged while any recording into S or T changes it.
 */
export function repairFingerprint(db: Database.Database, segment: bigint, target: bigint): string {
  const latestState = (logical: bigint) => get(db, `SELECT s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id = r.state_ref
    WHERE r.logical_ref = ? ORDER BY r.id DESC LIMIT 1`, logical)?.row_json ?? null;
  const values = [get(db, 'SELECT * FROM trips WHERE id = ?', segment) ?? null, get(db, 'SELECT * FROM logical_memberships WHERE trip_ref = ?', segment) ?? null,
    (decisionsEnabled(db) ? get(db, 'SELECT * FROM logical_membership_decisions WHERE trip_ref = ?', segment) : undefined) ?? null,
    get(db, 'SELECT * FROM logical_trips WHERE id = ?', target) ?? null, latestState(segment), latestState(target), rootBound(db, segment), rootBound(db, target)];
  return createHash('sha256').update(encodeRow(values)).digest('hex');
}

const available = (value: {available: boolean; value?: unknown; reason?: unknown}) =>
  (value.available ? {available: true, value: value.value} : {available: false, reason: value.reason}) as RepairSummary['distanceM'];
/** The user-visible values of the logical root of raw trip `tripUuid`, from its Journal detail and its upload rows. */
export function repairSummary(conn: StorageConnection, tripUuid: string): RepairSummary {
  const db = conn.reader(), detail = journalTrip(conn, tripUuid), record = detail.outcomeDetails?.record;
  const delivered = record?.type === 'job.delivered' ? record : undefined, audit = detail.trip.hardModeDetails;
  const root = get(db, 'SELECT m.logical_ref AS root FROM trips t JOIN logical_memberships m ON m.trip_ref = t.id WHERE t.trip_uuid = ?', tripUuid)?.root;
  const binding = get(db, 'SELECT held, hold_reason FROM upload_source_bindings WHERE root_ref = ?', root);
  const reservation = get(db, 'SELECT r.hold_reason, r.identity_state FROM upload_reservations r JOIN upload_candidates c ON c.ordinal = r.candidate_ref WHERE c.trip_ref = ?', root);
  return {
    outcome: detail.trip.outcome, recordingCompleteness: detail.trip.recordingCompleteness, sources: detail.exportBounds.sourceTotal ?? 1,
    distanceM: available(detail.trip.observedDistanceM), fuelUsedL: available(detail.trip.fuelUsedL),
    deliveredDistanceM: delivered ? available(delivered.distance) : null,
    revenue: delivered ? (delivered.revenue.available ? {available: true, value: {raw: delivered.revenue.value.raw, sdkType: delivered.revenue.value.sdkType}} : {available: false, reason: delivered.revenue.reason}) : null,
    hardMode: audit?.version === 2 ? {passingChecks: audit.passingChecks, failingChecks: audit.failingChecks, unknownChecks: audit.unknownChecks, qualified: detail.trip.isHardMode} : null,
    upload: {bound: binding !== undefined, held: binding?.held === 1n, holdReason: (binding?.held === 1n ? binding.hold_reason : reservation?.hold_reason ?? null) as string | null,
      identity: (reservation?.identity_state ?? null) as string | null}
  };
}

const ROLLBACK = Symbol('rollback');
/**
 * One join in one BEGIN IMMEDIATE transaction, which first starts the replay budget. In order: an existing membership of
 * the segment in the target is `already-applied`; a fingerprint other than the planned one is `stale`; the rules must
 * still decide this attested join (`refused` otherwise, including a bound segment, F-D7); the join; the after-summary on the
 * same connection must equal the planned one (`differs`, rolled back). Without `planned` (the dry run) the current
 * fingerprint is used and the after-summary is recorded.
 */
function joinTransaction(conn: StorageConnection, segmentUuid: string, targetUuid: string, planned: {fingerprint: string; after: RepairSummary} | undefined, options?: RepairOptions):
  RepairActionResult & {fingerprint?: string; before?: RepairJoinAction['before']} {
  const db = conn.writer();
  let result: RepairActionResult & {fingerprint?: string; before?: RepairJoinAction['before']} = {status: 'stale', after: null};
  try {
    db.transaction(() => {
      startReplayBudget(db);
      const segment = get(db, 'SELECT * FROM trips WHERE trip_uuid = ?', segmentUuid), target = get(db, 'SELECT * FROM trips WHERE trip_uuid = ?', targetUuid);
      if (!segment || !target) return;
      const membership = get(db, 'SELECT logical_ref, previous_logical_ref FROM logical_memberships WHERE trip_ref = ?', segment.id);
      if (membership && membership.logical_ref === target.id && membership.previous_logical_ref === segment.id) { result = {status: 'already-applied', after: null}; return; }
      const fingerprint = repairFingerprint(db, segment.id as bigint, target.id as bigint);
      if (planned && fingerprint !== planned.fingerprint) return;
      if (!closedSingleton(db, segment)) return;
      const decision = decide(db, segment, true);
      if (decision.state !== 'joined' || decision.target.id !== target.id) { result = {status: 'refused', after: null}; return; }
      const before = {segment: repairSummary(conn, segmentUuid), target: repairSummary(conn, targetUuid)};
      const group = get(db, 'SELECT * FROM logical_trips WHERE id = ?', segment.id)!;
      joinClosedMember(db, segment, decision.target, {proof: null, combined: closedCandidates(db, segment, group, null).combinedFor(decision.target), fingerprint: decision.fingerprint});
      options?.testHooks?.beforeCommit?.();
      const after = repairSummary(conn, targetUuid);
      if (planned && canonicalJson(after) !== canonicalJson(planned.after)) { result = {status: 'differs', after}; throw ROLLBACK; }
      result = {status: 'applied', after, fingerprint, before};
    }).immediate();
  } catch (error) { if (error !== ROLLBACK) throw error; }
  return result;
}

/** Applies one planned join of a repair plan; see joinTransaction. */
export function applyRepairAction(conn: StorageConnection, action: RepairJoinAction, options?: RepairOptions): RepairActionResult {
  if (action?.kind !== 'join' || !UUID.test(action.segmentTripUuid) || !UUID.test(action.targetTripUuid) || !/^[0-9a-f]{64}$/.test(action.fingerprint)) fail('INVALID_INPUT');
  const {status, after} = joinTransaction(conn, action.segmentTripUuid, action.targetTripUuid, {fingerprint: action.fingerprint, after: action.after}, options);
  return {status, after};
}

/**
 * The dry run on a scratch copy: scans the closed, proof-less singleton segments in id order, 100 per page, and applies
 * every attested join the rules allow at once, each in its own transaction, so a later segment sees the earlier joins.
 * Unattested candidates, published segments, pending segments and attested segments that cannot join are listed. Never
 * call it on a database that is not a disposable copy.
 */
export function planRepair(conn: StorageConnection, attest: readonly string[], options?: RepairOptions): RepairScan {
  if (!Array.isArray(attest) || attest.some(uuid => typeof uuid !== 'string' || !UUID.test(uuid))) fail('INVALID_INPUT');
  const db = conn.writer(), attested = new Set(attest), seen = new Set<string>(), actions: RepairJoinAction[] = [], listings: RepairListing[] = [];
  const uuidOf = (id: unknown) => String(get(db, 'SELECT trip_uuid FROM trips WHERE id = ?', id)!.trip_uuid);
  for (let after = 0n; ;) {
    const page = db.prepare(`SELECT t.* FROM trips t JOIN logical_memberships m ON m.trip_ref = t.id JOIN logical_trips l ON l.id = t.id
      WHERE t.id > ? AND m.logical_ref = t.id AND l.member_count = 1 AND m.proof_json IS NULL AND t.outcome <> 'open' ORDER BY t.id LIMIT ?`).all(after, SCAN_PAGE) as LogicalRow[];
    for (const row of page) {
      const uuid = String(row.trip_uuid), isAttested = attested.has(uuid);
      seen.add(uuid);
      const decision = decide(db, row, isAttested);
      const target = 'target' in decision ? uuidOf(decision.target.id) : null;
      if (decision.state === 'joined') {
        const joined = joinTransaction(conn, uuid, target!, undefined, options);
        if (joined.status === 'applied') actions.push({kind: 'join', segmentTripUuid: uuid, targetTripUuid: target!, fingerprint: joined.fingerprint!, before: joined.before!, after: joined.after!});
        else listings.push({segmentTripUuid: uuid, targetTripUuid: target, state: 'not-eligible', reason: joined.status});
      } else if (decision.state === 'not-eligible') {
        // Unattested segments without any candidate are ordinary history and are not listed.
        if (isAttested || ['ambiguous-candidates', 'out-of-order', 'target-open', 'intervening-trip'].includes(decision.reason))
          listings.push({segmentTripUuid: uuid, targetTripUuid: null, state: 'not-eligible', reason: decision.reason});
      } else listings.push({segmentTripUuid: uuid, targetTripUuid: target, state: decision.state, reason: decision.state === 'wait' ? decision.reason : null});
    }
    if (page.length < SCAN_PAGE) break;
    after = page.at(-1)!.id as bigint;
  }
  for (const uuid of attest) {
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const row = get(db, 'SELECT t.id, m.logical_ref, m.previous_logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref = t.id WHERE t.trip_uuid = ?', uuid);
    if (!row) listings.push({segmentTripUuid: uuid, targetTripUuid: null, state: 'unknown-trip', reason: null});
    else if (row.logical_ref !== row.id && row.previous_logical_ref === row.id) listings.push({segmentTripUuid: uuid, targetTripUuid: uuidOf(row.logical_ref), state: 'already-joined', reason: null});
    else listings.push({segmentTripUuid: uuid, targetTripUuid: null, state: 'not-eligible', reason: 'not-a-closed-singleton'});
  }
  return {actions, listings};
}
