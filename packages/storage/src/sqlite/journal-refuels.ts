import type Database from 'better-sqlite3';
import type {JournalRefuels} from '../../../contracts/src/journal';
import {FUEL_NOISE_LITERS} from '../../../telemetry-core/src/derived';
import {READING_HOLE_SECONDS, REFUEL_READING_LIMIT} from '../../../telemetry-core/src/trips/accounting';
import {QUANTITY_POINT_LIMIT} from '../../../telemetry-core/src/trips/quantities';
import {matchesSavedEndpoint, type SavedEndpoint} from '../../../telemetry-core/src/trips/saved-endpoint';
import type {LogicalSnapshot} from './logical-snapshot';
import {ACCOUNTING_PATH} from './logical-trips';
import {statement} from './writes';

const NOTE_LIMIT = 5_000;
const READING_HOLE_NS = BigInt(READING_HOLE_SECONDS) * 1_000_000_000n;
interface Bound {
  id: bigint; member: bigint; at: bigint; clock: string; gameClock: string | null;
}
interface Sample extends Bound {
  odometerM: number | null; fuelL: number | null; speedMps: number | null; gameMinutes: string | null;
  x: number | null; y: number | null; z: number | null;
}
interface Run {
  first: bigint; last: bigint; anchor: bigint; depth: bigint; prefix: bigint | null;
  logical: bigint; start: bigint; truck: bigint | null; startOdometer: number | null; cut: number | null;
}
const SAMPLE = `SELECT s.id,s.trip_ref AS member,s.monotonic_ns AS at,c.clock_uuid AS clock,g.clock_uuid AS gameClock,
  s.odometer_m AS odometerM,s.fuel_l AS fuelL,s.speed_mps AS speedMps,CAST(s.game_minutes AS TEXT) AS gameMinutes,s.x,s.y,s.z
  FROM samples s JOIN clocks c ON c.id=s.source_clock_ref LEFT JOIN clocks g ON g.id=s.game_clock_ref`;
const readSample = (db: Database.Database, id: bigint) => statement(db, SAMPLE + ' WHERE s.id=?').get(id) as Sample | undefined;

function endpoint(sample: Sample, truck: string): SavedEndpoint {
  const {x, y, z} = sample;
  return {...sample, truck, position: x === null || y === null || z === null ? null : {x, y, z}};
}

/** Odometer alone cannot order measurements taken while stopped at a pump. */
function cutEnd(db: Database.Database, run: Run): Sample | undefined {
  const loaded = readSample(db, run.anchor);
  if (!loaded || loaded.id <= run.last || run.truck === null) return undefined;
  const filter = ` JOIN logical_progress p ON p.bound_sample_ref=s.id WHERE p.logical_ref=? AND p.truck_ref=?
    AND p.start_odometer_m IS ? AND coalesce(p.start_ref,p.id)=? AND s.id BETWEEN ? AND ?
    AND p.cut_odometer_m IS NULL AND p.anchor_sample_ref=s.id`;
  const args = [run.logical, run.truck, run.startOdometer, run.start, run.first, run.last, run.cut];
  const candidates = statement(db, SAMPLE + filter + ' AND p.odometer_m=? ORDER BY s.id LIMIT ?')
    .all(...args, QUANTITY_POINT_LIMIT + 1) as Sample[];
  const truck = String(run.truck);
  // An exact level avoids including a replenishment smaller than the save matcher’s tolerance.
  const exact = candidates.length <= QUANTITY_POINT_LIMIT && candidates.find(s =>
    s.fuelL === loaded.fuelL && matchesSavedEndpoint(endpoint(s, truck), endpoint(loaded, truck), true, loaded.gameMinutes ?? undefined));
  if (exact) return exact;
  return statement(db, SAMPLE + filter + ' AND p.odometer_m<? ORDER BY p.odometer_m DESC,s.id DESC LIMIT 1')
    .get(...args) as Sample | undefined;
}

interface Window {first: Sample; last: Sample}
interface Span extends Window {run: Run}
function retainedSpans(db: Database.Database, snap: LogicalSnapshot): Span[] {
  const runs = statement(db, ACCOUNTING_PATH + ` SELECT coalesce(b.sample_ref,p.bound_sample_ref) AS first,
    p.bound_sample_ref AS last,p.anchor_sample_ref AS anchor,p.depth,p.prefix_ref AS prefix,p.logical_ref AS logical,
    coalesce(p.start_ref,p.id) AS start,p.truck_ref AS truck,p.start_odometer_m AS startOdometer,p.cut_odometer_m AS cut
    FROM path p LEFT JOIN logical_progress b ON b.id=p.start_ref`).all({head: snap.head}) as Run[];
  if (runs.some(run => run.depth === 256n && run.prefix !== null)) return [];
  return runs.flatMap(run => {
    const first = readSample(db, run.first), last = run.cut === null ? readSample(db, run.anchor) : cutEnd(db, run);
    return first && last && first.id < last.id && last.id <= snap.samples ? [{first, last, run}] : [];
  });
}

/** A ledger run can cross an exact save junction. Each annotation still needs one raw source and game clock. */
function sourceWindows(db: Database.Database, spans: Span[], member: bigint, clock: string, gameClock: string): Window[] {
  const matches = (sample: Sample) => sample.member === member && sample.clock === clock && sample.gameClock === gameClock;
  const scope = ' WHERE s.trip_ref=? AND s.id BETWEEN ? AND ? AND c.clock_uuid=? AND g.clock_uuid=?';
  return spans.flatMap(span => {
    if (matches(span.first) && matches(span.last)) return span.first.at < span.last.at ? [span] : [];
    if (span.first.member === span.last.member && span.first.member !== member) return [];
    const args = [member, span.first.id, span.last.id, clock, gameClock];
    const first = statement(db, SAMPLE + scope + ' ORDER BY s.id ASC LIMIT 1').get(...args) as Sample | undefined;
    if (!first) return [];
    let last = statement(db, SAMPLE + scope + ' ORDER BY s.id DESC LIMIT 1').get(...args) as Sample;
    if (last.id < span.last.id && last.odometerM !== null) {
      const {run} = span;
      const next = statement(db, SAMPLE + ` JOIN logical_progress p ON p.bound_sample_ref=s.id
        WHERE p.logical_ref=? AND p.start_odometer_m IS ? AND p.truck_ref IS ? AND coalesce(p.start_ref,p.id)=?
        AND p.odometer_m=? AND s.id>? AND s.id<=? AND p.cut_odometer_m IS NULL AND p.anchor_sample_ref=s.id ORDER BY s.id LIMIT 1`)
        .get(run.logical, run.startOdometer, run.truck, run.start, last.odometerM, last.id, span.last.id) as Sample | undefined;
      if (next) {
        // A continued run can contain a reload at the same odometer. Stop at the earliest matching level,
        // or before the whole stop when its end is unproven.
        const earlier = cutEnd(db, {...run, first: first.id, last: last.id, anchor: next.id, cut: last.odometerM});
        if (!earlier) return [];
        last = earlier;
      }
    }
    return first.id < last.id && first.at < last.at ? [{first, last}] : [];
  });
}

function measurement(value: unknown): {at: bigint; level: number} | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [at, level] = value as unknown[];
  if (typeof at !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(at) || typeof level !== 'number' || !Number.isFinite(level) || level < 0) return undefined;
  return {at: BigInt(at), level};
}

function retainedAmount(detail: Record<string, unknown>, windows: Window[]): {amount: number; omitted: boolean} {
  const readings: unknown = detail.refuelReadings;
  if (!Array.isArray(readings) || readings.length < 2 || readings.length > REFUEL_READING_LIMIT) return {amount: 0, omitted: true};
  let previous = measurement(readings[0]), amount = 0, omitted = false;
  for (const reading of readings.slice(1)) {
    const next = measurement(reading);
    if (!previous || !next || next.at <= previous.at || next.level - previous.level <= FUEL_NOISE_LITERS) return {amount: 0, omitted: true};
    const from = previous.at, to = next.at;
    if (to - from < READING_HOLE_NS && windows.some(({first, last}) => first.at <= from && to <= last.at)) amount += next.level - previous.level;
    else omitted = true;
    previous = next;
  }
  return {amount, omitted};
}

/** Raw annotations and their original amounts stay readable via the separate interval pages. */
export function journalRefuels(db: Database.Database, trip: bigint, snap?: LogicalSnapshot): JournalRefuels | undefined {
  const where = "c.kind='discontinuity' AND json_type(c.detail_json,'$.annotation')='true' AND json_extract(c.detail_json,'$.cause')='refuel'";
  const notes = (snap ? statement(db, `SELECT c.trip_ref,c.detail_json FROM logical_snapshot_memberships m JOIN completeness_intervals c ON c.trip_ref=m.trip_ref
    WHERE m.logical_ref=? AND m.trip_ref<=? AND m.from_revision<? AND (m.through_revision IS NULL OR m.through_revision>=?)
      AND c.id<=? AND ${where} LIMIT ?`).all(snap.logical, snap.members, snap.revision, snap.revision, snap.intervals, NOTE_LIMIT + 1)
    : statement(db, `SELECT c.trip_ref,c.detail_json FROM completeness_intervals c WHERE c.trip_ref=? AND ${where} LIMIT ?`).all(trip, NOTE_LIMIT + 1)) as
    {trip_ref: bigint; detail_json: string}[];
  if (notes.length === 0) return undefined;
  const total = {dieselL: 0, electricKWh: 0, omitted: false};
  if (notes.length > NOTE_LIMIT) return {...total, omitted: true, unavailableReason: 'annotation-limit'};
  // The legacy projection key is set from logical_trips.reconciliation_unknown. It signals an unproven accounting
  // path independently of whether the trip has any money events.
  if (!snap || snap.head === null || snap.row._moneyIncomplete === true)
    return {...total, omitted: true, unavailableReason: 'retained-path-unproven'};
  const spans = retainedSpans(db, snap), cache = new Map<string, Window[]>();
  for (const note of notes) {
    const detail = JSON.parse(note.detail_json) as Record<string, unknown>;
    const {readingClock, readingGameClock, powertrain} = detail;
    if ((powertrain !== 'diesel' && powertrain !== 'electric') || typeof readingClock !== 'string' || typeof readingGameClock !== 'string') {
      total.omitted = true;
      continue;
    }
    const key = `${note.trip_ref}:${readingClock}:${readingGameClock}`;
    let windows = cache.get(key);
    if (!windows) { windows = sourceWindows(db, spans, note.trip_ref, readingClock, readingGameClock); cache.set(key, windows); }
    const {amount, omitted} = retainedAmount(detail, windows);
    total[powertrain === 'diesel' ? 'dieselL' : 'electricKWh'] += amount;
    total.omitted ||= omitted;
  }
  return Number.isFinite(total.dieselL) && Number.isFinite(total.electricKWh) ? total : {dieselL: 0, electricKWh: 0, omitted: true};
}
