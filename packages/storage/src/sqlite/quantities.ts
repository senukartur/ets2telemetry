// Engine 1 distance and fuel in storage (ET-112c): the per-sample ledger of a logical trip in logical_progress, the replay
// of a joining member's recorded samples into its target (the splice), the reads of a ledger head and the read-only
// reconstruction that package g reuses. The rules are advanceQuantities in telemetry-core; live recording, the splice and
// the reconstruction feed it the same stored inputs (the sample, its truck and the recorder link bit 15), and apply the
// same gap rule to a member whose pre-join samples are not replayed, so the reconstruction equals the live head.
// See docs/storage.md, Schema version 10.
import type Database from 'better-sqlite3';
import {advanceQuantities, completeAnchor, DISTANCE_BREAK_FLAGS, FUEL_BREAK_FLAGS, memoryPath, QUANTITY_FLAGS, QUANTITY_POINT_LIMIT, QUANTITY_RUN_LIMIT, quantityStatus,
  type QuantityAdvance, type QuantityAnchor, type QuantityPath, type QuantityPoint, type QuantityRun, type QuantityStep} from '../../../telemetry-core/src/trips/quantities';
import {MAX_RESOLVE_MEMBERSHIPS, MAX_SAMPLE_BATCH, type SampleInput} from '../api';
import {registeredAccountingEngine} from './connection';
import {cleanLoadWindow, COVERAGE_LOSS, type LogicalCoverage} from './logical-coverage';

type Row = Record<string, unknown>;
const F = QUANTITY_FLAGS, CUMULATIVE = 0x3fff, BREAKS = DISTANCE_BREAK_FLAGS | FUEL_BREAK_FLAGS;
/**
 * The most recorded samples one splice replays, and the replay budget of one resolve call: a full resolve page of members
 * with one sample batch each. A longer member keeps the target's subtotal as partial instead.
 */
export const SPLICE_SAMPLE_LIMIT = MAX_RESOLVE_MEMBERSHIPS * MAX_SAMPLE_BATCH;
const STATEMENTS = new WeakMap<Database.Database, Map<string, Database.Statement>>();
/** The connection's prepared statement for `sql`, prepared once. */
function statement(db: Database.Database, sql: string): Database.Statement {
  let cache = STATEMENTS.get(db);
  if (!cache) STATEMENTS.set(db, cache = new Map<string, Database.Statement>());
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, prepared = db.prepare(sql));
  return prepared;
}
const get = (db: Database.Database, sql: string, ...args: unknown[]) => statement(db, sql).get(...args) as Row | undefined;
const all = (db: Database.Database, sql: string, ...args: unknown[]) => statement(db, sql).all(...args) as Row[];
const run = (db: Database.Database, sql: string, ...args: unknown[]) => statement(db, sql).run(...args);
const real = (value: unknown) => value === null || value === undefined ? null : Number(value);

/** Schema 10 records the engine of each group. */
export const quantitiesEnabled = (db: Database.Database) => Number(db.pragma('user_version', {simple: true})) >= 10;
/** The engine of groups created from now on: 1, unless an in-process test registered engine 0 (OpenOptions.accountingEngine). */
export const defaultEngine = (db: Database.Database): 0 | 1 => registeredAccountingEngine(db) ?? 1;

/** One stored sample as the engine reads it, with its references for the evidence queries. */
interface Stored {id: bigint; trip: unknown; session: unknown; clock: unknown; utcMs: unknown; anchor: QuantityAnchor}
function stored(db: Database.Database, id: unknown, truck: string | null): Stored {
  const s = get(db, `SELECT s.id,s.trip_ref,s.plugin_session_ref,s.source_clock_ref,s.utc_ms,s.fuel_l,s.odometer_m,s.speed_mps,s.game_minutes,s.monotonic_ns,s.x,s.y,s.z,
    c.clock_uuid,g.clock_uuid AS game_clock_uuid,p.plugin_session_uuid FROM samples s JOIN clocks c ON c.id=s.source_clock_ref LEFT JOIN clocks g ON g.id=s.game_clock_ref
    JOIN plugin_sessions p ON p.id=s.plugin_session_ref WHERE s.id=?`, id)!;
  return {id: s.id as bigint, trip: s.trip_ref, session: s.plugin_session_ref, clock: s.source_clock_ref, utcMs: s.utc_ms, anchor: {pluginSessionId: String(s.plugin_session_uuid),
    sourceClockId: String(s.clock_uuid), monotonicNs: String(s.monotonic_ns), gameClockId: s.game_clock_uuid === null ? null : s.game_clock_uuid as string,
    gameMinutes: s.game_minutes === null ? null : (s.game_minutes as bigint).toString(), truck, odometerM: real(s.odometer_m), fuelL: real(s.fuel_l), speedMps: real(s.speed_mps),
    position: s.x === null ? null : {x: Number(s.x), y: Number(s.y), z: Number(s.z)}}};
}
const truckOf = (db: Database.Database, ref: unknown) => ref === null || ref === undefined ? null : String(get(db, 'SELECT identity_key FROM logical_trucks WHERE id=?', ref)!.identity_key);
/** The truck input of a sample is on its own ledger row, in whichever chain recorded it. */
const sampleTruckRef = (db: Database.Database, sample: unknown) => get(db, 'SELECT truck_ref FROM logical_progress WHERE sample_ref=?', sample)?.truck_ref ?? null;

/**
 * The step from the last complete anchor `a` to `b`: another raw member, a source, capture or game clock change or a
 * non-positive time, or running time since the later of `a` and the latest simulation start, with a ferry or train event
 * in (a, b] on the same capture clock (one with an unknown time cannot be placed and is ignored, D7) and the recorder link.
 */
function stepOf(db: Database.Database, a: Stored, b: Stored, linked: boolean): QuantityStep {
  if (a.trip !== b.trip) return {kind: 'member'};
  const x = a.anchor, y = b.anchor;
  if (x.pluginSessionId !== y.pluginSessionId || x.sourceClockId !== y.sourceClockId || x.gameClockId !== y.gameClockId || BigInt(y.monotonicNs) <= BigInt(x.monotonicNs)) return {kind: 'boundary'};
  const range = [b.session, b.clock, x.monotonicNs.padStart(20, '0'), y.monotonicNs.padStart(20, '0')];
  const started = get(db, `SELECT max(occurred_monotonic_ns) AS at FROM events WHERE plugin_session_id=? AND type='simulation.started' AND source_clock_ref=?
    AND occurred_monotonic_ns>? AND occurred_monotonic_ns<=?`, ...range)!.at;
  const transfer = get(db, `SELECT 1 FROM events WHERE plugin_session_id=? AND type IN ('player.use.ferry','player.use.train') AND source_clock_ref=?
    AND occurred_monotonic_ns>? AND occurred_monotonic_ns<=? LIMIT 1`, ...range) !== undefined;
  return {kind: 'running', seconds: Number(BigInt(y.monotonicNs) - BigInt(started === null ? x.monotonicNs : started as string)) / 1e9, transfer, linked};
}

/**
 * A ledger row with `member`, the raw trip its run belongs to: the trip of the anchor for a hold row (as the in-memory path
 * leaves a run with the member of its last complete point), and `trip_ref` otherwise.
 */
const ROW = `SELECT p.*,CASE WHEN p.cut_odometer_m IS NULL AND p.anchor_sample_ref<>p.bound_sample_ref THEN (SELECT trip_ref FROM samples WHERE id=p.anchor_sample_ref)
  ELSE p.trip_ref END AS member FROM logical_progress p WHERE p.id=?`;
const ledgerRow = (db: Database.Database, id: unknown) => get(db, ROW, id)!;
function pointOf(db: Database.Database, row: Row): QuantityPoint {
  return {anchor: stored(db, row.anchor_sample_ref, truckOf(db, sampleTruckRef(db, row.anchor_sample_ref))).anchor, distanceM: real(row.distance_m), fuelUsedL: real(row.fuel_used_l),
    flags: Number(row.quantity_flags)};
}
interface LedgerRun extends QuantityRun {row: Row}
/**
 * The retained runs of a ledger: its prefix chain from the head, at most QUANTITY_RUN_LIMIT run ends. A run's points are
 * its self-anchored rows, found through logical_progress_cut by truck, run start odometer and odometer.
 */
function ledgerPath(db: Database.Database, logical: bigint, head: Row | undefined): QuantityPath<LedgerRun> {
  return {
    runs(scope) {
      const runs: LedgerRun[] = [];
      for (let row = head; row && runs.length < QUANTITY_RUN_LIMIT; row = row.prefix_ref === null ? undefined : ledgerRow(db, row.prefix_ref)) {
        if (scope === 'member' && row.member !== head!.member) break;
        runs.push({row, startOdometerM: real(row.start_odometer_m), end: pointOf(db, row)});
      }
      return runs;
    },
    points(run, odometerM) {
      const rows = all(db, `SELECT * FROM logical_progress WHERE logical_ref=? AND truck_ref IS ? AND start_odometer_m=? AND odometer_m<=? AND coalesce(start_ref,id)=?
        AND cut_odometer_m IS NULL AND anchor_sample_ref=bound_sample_ref ORDER BY odometer_m DESC, id DESC LIMIT ?`,
      logical, sampleTruckRef(db, run.row.anchor_sample_ref), run.row.start_odometer_m, odometerM, run.row.start_ref ?? run.row.id, QUANTITY_POINT_LIMIT);
      return rows.map(row => pointOf(db, row));
    }
  };
}

/** A replayed member sample: its own row in the member's chain, and the break bits that chain already annotated there. */
interface Replay {own: unknown; annotated: number}
/** The ledger head of a group as a replay carries it: the head row's id and its last complete anchor. */
interface Carried {headId: unknown; a: Stored | undefined}
/** The last complete anchor of a head row. */
const anchorOf = (db: Database.Database, head: Row | undefined) => head ? stored(db, head.anchor_sample_ref, truckOf(db, sampleTruckRef(db, head.anchor_sample_ref))) : undefined;
const pointAt = (head: Row | undefined, a: Stored | undefined): QuantityPoint | null => head && a
  ? {anchor: a.anchor, distanceM: real(head.distance_m), fuelUsedL: real(head.fuel_used_l), flags: Number(head.quantity_flags)} : null;
/**
 * The junction of a member whose recorded samples before the join are not replayed (more than SPLICE_SAMPLE_LIMIT, an
 * engine-0 member, or no complete reading): a new run at `anchor` that keeps the supported subtotal, marked partial.
 */
function gapAdvance<R extends QuantityRun>(previous: QuantityPoint | null, anchor: QuantityAnchor): QuantityAdvance<R> {
  const gap = F.distanceGap | F.fuelBoundary;
  const point = previous ? {anchor, distanceM: previous.distanceM, fuelUsedL: previous.fuelUsedL, flags: (previous.flags & CUMULATIVE) | gap}
    : {anchor, distanceM: 0, fuelUsedL: 0, flags: F.base | gap};
  return {point, run: 'new', cut: null, unproven: false, savePoint: false, added: gap & ~(previous?.flags ?? 0) & BREAKS};
}
/**
 * Advances the engine-1 ledger of `logical` by the stored sample `b` of raw trip `trip` (or by the gap point, with `gap`),
 * then writes its row, a cut row for a rollback, the progress head, the unproven latch and one version 2 annotation of the
 * newly set break bits. A sample before the first complete anchor writes nothing. A replayed sample keeps `sample_ref`
 * NULL (its row in the member's chain owns it) and starts a run at its own row there, so ACCOUNTING_PATH reads the run's
 * sample range. `carried` is the head a replay keeps in memory; live recording reads it. Returns the savePoint of a member
 * junction, null for any other step and undefined when nothing was written, with the head after the step.
 */
function advanceLedger(db: Database.Database, logical: bigint, trip: Row, b: Stored, truckRef: unknown, link: (a: Stored) => boolean, replay: Replay | null, now: unknown,
  carried?: Carried, gap?: true): {decided: boolean | null | undefined; carried: Carried} {
  const headId = carried ? carried.headId : get(db, 'SELECT progress_head FROM logical_trips WHERE id=?', logical)!.progress_head;
  const head = headId === null ? undefined : ledgerRow(db, headId), a = carried ? carried.a : anchorOf(db, head);
  const previous = pointAt(head, a);
  const linked = !gap && !!a && link(a), step: QuantityStep = a ? stepOf(db, a, b, linked) : {kind: 'member'};
  const advance: QuantityAdvance<LedgerRun> = gap ? gapAdvance(previous, b.anchor) : advanceQuantities(previous, b.anchor, step, ledgerPath(db, logical, head));
  const point = advance.point;
  if (!point) return {decided: undefined, carried: {headId, a}};
  const own = replay?.own ?? null;
  let prefix: unknown, start: unknown, startOdometer: unknown, flags = point.flags;
  if (!completeAnchor(b.anchor)) {
    // A hold continues its run with the previous values; bit 15 is the recorder link of this sample, not the inherited one.
    prefix = head!.prefix_ref; start = head!.start_ref ?? head!.id; startOdometer = head!.start_odometer_m;
    flags = (Number(head!.quantity_flags) & CUMULATIVE) | (linked ? F.linked : 0);
  } else if (advance.cut) {
    // The cut ends the restored run at the loaded odometer, in the engine-0 cut row shape.
    const end = advance.cut.run.row, x = advance.cut.odometerM;
    prefix = run(db, `INSERT INTO logical_progress(logical_ref,trip_ref,anchor_sample_ref,sample_ref,bound_sample_ref,prefix_ref,start_ref,cut_odometer_m,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l,quantity_flags)
      VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)`, logical, end.member, b.id, end.bound_sample_ref, end.prefix_ref, end.start_ref ?? end.id, x, truckRef, x, end.start_odometer_m,
    point.distanceM, point.fuelUsedL, point.flags & CUMULATIVE).lastInsertRowid;
    start = own; startOdometer = b.anchor.odometerM;
  } else if (advance.run === 'new') {
    prefix = head?.id ?? null; start = own; startOdometer = b.anchor.odometerM;
  } else {
    prefix = head!.prefix_ref; start = head!.start_ref ?? head!.id; startOdometer = head!.start_odometer_m;
  }
  const inserted = run(db, `INSERT INTO logical_progress(logical_ref,trip_ref,anchor_sample_ref,sample_ref,bound_sample_ref,prefix_ref,start_ref,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l,quantity_flags)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, logical, trip.id, completeAnchor(b.anchor) ? b.id : head!.anchor_sample_ref, replay ? null : b.id, b.id, prefix, start, truckRef,
  b.anchor.odometerM, startOdometer, point.distanceM, point.fuelUsedL, flags);
  run(db, 'UPDATE logical_trips SET progress_head=? WHERE id=?', inserted.lastInsertRowid, logical);
  // D11: an unproven quantity latches the money totals incomplete, as an unresolved engine-0 rollback does.
  if (advance.unproven) run(db, 'UPDATE logical_trips SET reconciliation_unknown=1 WHERE id=?', logical);
  const added = advance.added & ~(replay?.annotated ?? 0);
  if (added) {
    const detail = {annotation: true, cause: 'accounting-chain-break', version: 2, engine: 1, distanceFlags: added & DISTANCE_BREAK_FLAGS, fuelFlags: added & FUEL_BREAK_FLAGS};
    run(db, `INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,end_utc_ms,end_monotonic_ns,source_clock_ref,detail_json,created_utc_ms)
      VALUES(?,?,'discontinuity',?,?,?,?,?)`, b.session, trip.id, b.utcMs, b.anchor.monotonicNs.padStart(20, '0'), b.clock, JSON.stringify(detail), now);
  }
  const decided = gap ? false : previous && step.kind === 'member' && completeAnchor(b.anchor) ? advance.savePoint : null;
  return {decided, carried: {headId: inserted.lastInsertRowid, a: completeAnchor(b.anchor) ? b : a}};
}

/**
 * Records one live sample of raw trip `row` into the engine-1 group `logical`. The recorder link holds when the sample's
 * recorded predecessor is the ledger's last complete anchor of the same raw trip. Returns the savePoint of a member junction.
 */
export function projectQuantitySample(db: Database.Database, logical: bigint, row: Row, sample: SampleInput, sampleId: bigint, truckRef: unknown, now: number): boolean | null {
  const previous = sample.recording?.previous;
  const link = (a: Stored) => !!previous && previous.tripUuid === sample.tripUuid && a.trip === row.id && previous.sourceClockId === a.anchor.sourceClockId
    && previous.monotonicNs === a.anchor.monotonicNs;
  return advanceLedger(db, logical, row, stored(db, sampleId, sample.recording?.truck ?? null), truckRef, link, null, now).decided ?? null;
}

/** The engine-1 rows of raw member `member` in its own chain, at most SPLICE_SAMPLE_LIMIT + 1, in sample order; none for engine 0. */
function ownRows(db: Database.Database, member: unknown): Row[] {
  if (get(db, 'SELECT * FROM logical_trips WHERE id=?', member)?.accounting_engine !== 1n) return [];
  return all(db, `SELECT p.* FROM samples s JOIN logical_progress p ON p.sample_ref=s.id WHERE s.trip_ref=? AND p.logical_ref=? ORDER BY s.id LIMIT ?`,
    member, member, SPLICE_SAMPLE_LIMIT + 1);
}
/** The samples one splice of `member` replays, as a resolve call counts them against SPLICE_SAMPLE_LIMIT: one when none are replayed. */
export function spliceCost(db: Database.Database, member: unknown): number {
  const rows = ownRows(db, member).length;
  return rows === 0 || rows > SPLICE_SAMPLE_LIMIT ? 1 : rows;
}
const headRow = (db: Database.Database, logical: unknown) => get(db, 'SELECT p.* FROM logical_trips l JOIN logical_progress p ON p.id=l.progress_head WHERE l.id=?', logical);

/**
 * Splices raw member `member`, which has just joined engine-1 group `target`, into the target's ledger: its samples
 * recorded in its own engine-1 chain before the join are replayed in order through the same step as live samples, with
 * their stored truck and link inputs and the head carried in memory. The member's own chain stays unchanged. A member
 * whose earlier samples are not replayed (more than SPLICE_SAMPLE_LIMIT own rows, an engine-0 member, or samples without
 * a complete reading) keeps the target's subtotal as partial instead: one gap row at its own last anchor, or at the
 * target head. A member without samples before the join (`current` is the sample being recorded) is not spliced, and
 * nothing is spliced into an engine-0 target or before the target's first complete reading. Returns the junction's
 * savePoint, or null.
 */
export function spliceMember(db: Database.Database, target: bigint, member: Row, current?: bigint): boolean | null {
  // SELECT *: below schema 10 the column is absent, and nothing is spliced.
  if (get(db, 'SELECT * FROM logical_trips WHERE id=?', target)?.accounting_engine !== 1n) return null;
  const rows = ownRows(db, member.id), now = member.updated_utc_ms;
  if (rows.length === 0 || rows.length > SPLICE_SAMPLE_LIMIT) {
    const own = rows.length ? headRow(db, member.id) : undefined, head = own ? undefined : headRow(db, target);
    if (!own && (!head || !get(db, 'SELECT 1 FROM samples WHERE trip_ref=? AND id IS NOT ? LIMIT 1', member.id, current ?? null))) return null;
    const anchor = anchorOf(db, own ?? head)!;
    return advanceLedger(db, target, member, anchor, sampleTruckRef(db, anchor.id), () => false, {own: null, annotated: 0}, now, undefined, true).decided ?? null;
  }
  let junction: boolean | null = null, previousFlags = 0, carried: Carried | undefined;
  for (const row of rows) {
    const flags = Number(row.quantity_flags), annotated = flags & ~previousFlags & BREAKS;
    previousFlags = flags;
    const b = stored(db, row.sample_ref, truckOf(db, row.truck_ref));
    const step = advanceLedger(db, target, member, b, row.truck_ref, () => (flags & F.linked) !== 0, {own: row.id, annotated}, now, carried);
    carried = step.carried;
    if (junction === null && step.decided !== undefined && step.decided !== null) junction = step.decided;
  }
  return junction;
}

/**
 * Engine 1 (docs/trips.md): the junction of a pending member decides its resume. The same save point with an admitted
 * proof and a clean load window resumes the coverage; any other junction records an unknown loss. Undefined when this
 * coverage is not pending for the member or `savePoint` is not a junction's.
 */
export function junctionCoverage(db: Database.Database, row: Row, coverage: LogicalCoverage | undefined, savePoint: boolean | null, proof: boolean): LogicalCoverage | undefined {
  if (savePoint === null || coverage?.phase !== 'pending' || coverage.member !== String(row.id) || coverage.window?.session !== String(row.plugin_session_ref)) return undefined;
  return savePoint && proof && cleanLoadWindow(db, row) ? {...coverage, phase: 'resumed', window: null, sampleResumePending: false}
    : {...coverage, sampleResumePending: false, losses: coverage.losses | COVERAGE_LOSS.unknown};
}

/** The head row when it is an engine-1 row; SELECT * because below schema 10 the flags column is absent. */
function quantityHead(db: Database.Database, head: unknown): Row | undefined {
  const point = head === null || head === undefined ? undefined : get(db, 'SELECT * FROM logical_progress WHERE id=?', head);
  return point?.quantity_flags === null || point?.quantity_flags === undefined ? undefined : point;
}
/**
 * Engine 1 reads its head row: the values are the row's, not observed when NULL and invalid when negative; the coverage
 * endpoint and the raw totals are not used. Undefined for an engine-0 head, which keeps its own read.
 */
export function applyQuantities(db: Database.Database, row: Row, head: unknown): Row | undefined {
  const point = quantityHead(db, head);
  if (!point) return undefined;
  for (const [column, value] of [['observed_distance_m', real(point.distance_m)], ['fuel_used_l', real(point.fuel_used_l)]] as const) {
    const invalid = value !== null && value < 0;
    row[column] = value === null || invalid ? null : value;
    row[`${column}_state`] = invalid ? 'invalid' : value === null ? 'not-observed' : 'available';
  }
  return row;
}
/** Upload: a partial or unavailable engine-1 quantity at the snapshot head keeps the money totals incomplete (accounting-unavailable). */
export function quantitiesIncomplete(db: Database.Database, head: bigint | null): boolean {
  const point = quantityHead(db, head);
  if (!point) return false;
  const flags = Number(point.quantity_flags);
  return quantityStatus(real(point.distance_m), flags, 'distance') !== 'complete' || quantityStatus(real(point.fuel_used_l), flags, 'fuel') !== 'complete';
}

/**
 * Read-only reconstruction of a logical trip's engine-1 quantities from its stored samples: the members in join order,
 * each member's samples with a ledger row in id order, through advanceQuantities and memoryPath(). A joined member's
 * own-chain rows come first, as the splice replayed them; where the splice wrote a gap row instead (more than
 * SPLICE_SAMPLE_LIMIT own rows, an engine-0 member, or earlier samples without a complete reading), the same gap point
 * replaces them. It writes nothing. Returns the last point, or null before any complete anchor.
 */
export function reconstructQuantities(db: Database.Database, logical: bigint): QuantityPoint | null {
  const path = memoryPath();
  let last: Stored | undefined;
  const fold = (member: bigint, rows: Row[]) => {
    for (const row of rows) {
      const b = stored(db, row.sample_ref, truckOf(db, row.truck_ref));
      const step = last ? stepOf(db, last, b, (Number(row.quantity_flags ?? 0) & F.linked) !== 0) : {kind: 'member' as const};
      path.record(String(member), b.anchor, advanceQuantities(path.head, b.anchor, step, path));
      if (completeAnchor(b.anchor)) last = b;
    }
  };
  const members = db.prepare('SELECT trip_ref FROM logical_memberships WHERE logical_ref=? ORDER BY coalesce(joined_after_revision,0),trip_ref').pluck().all(logical) as bigint[];
  for (const member of members) {
    // The member's rows recorded into this trip, live or after its join; replayed rows have no sample_ref.
    const rows = all(db, `SELECT p.sample_ref,p.truck_ref,p.quantity_flags FROM samples s JOIN logical_progress p ON p.sample_ref=s.id WHERE s.trip_ref=? AND p.logical_ref=?
      ORDER BY s.id`, member, logical);
    const own = member === logical ? [] : ownRows(db, member);
    if (own.length > SPLICE_SAMPLE_LIMIT) {
      last = anchorOf(db, headRow(db, member))!;
      path.record(String(member), last.anchor, gapAdvance(path.head, last.anchor));
    } else if (own.length > 0) fold(member, own);
    else if (member !== logical && path.head && get(db, 'SELECT 1 FROM samples WHERE trip_ref=? AND id<coalesce(?,id+1) LIMIT 1', member, rows[0]?.sample_ref ?? null)) {
      // Samples before the member's first row in this trip were recorded before its join and not replayed.
      const anchor = path.head.anchor;
      path.record(String(member), anchor, gapAdvance(path.head, anchor));
    }
    fold(member, rows);
  }
  return path.head;
}
