import type Database from 'better-sqlite3';
import {matchesSavedEndpoint, type SavedEndpoint} from '../../../telemetry-core/src/trips/saved-endpoint';
import {QUANTITY_POINT_LIMIT} from '../../../telemetry-core/src/trips/quantities';
import {ACCOUNTING_PATH} from './logical-trips';
import {statement} from './writes';

/** Source time is comparable only within the recording's own capture clock. */
export interface MoneyOccurrence {
  member: bigint;
  session: bigint;
  clock: bigint;
  at: bigint | null;
}
interface Sample extends MoneyOccurrence, SavedEndpoint {id: bigint}
interface Cut {
  depth: bigint;
  prefix_ref: bigint | null;
  logical_ref: bigint;
  start_ref: bigint | null;
  truck_ref: bigint | null;
  start_odometer_m: number | null;
  cut_odometer_m: number | null;
  bound_sample_ref: bigint | null;
  anchor_sample_ref: bigint;
}
interface Window {before: Sample | undefined; after: Sample}

const SAMPLE_FIELDS = `s.id,s.trip_ref AS member,s.plugin_session_ref AS session,s.source_clock_ref AS clock,s.monotonic_ns AS at,
  s.odometer_m AS odometerM,s.fuel_l AS fuelL,s.speed_mps AS speedMps,CAST(s.game_minutes AS TEXT) AS gameMinutes,s.x,s.y,s.z`;
type SampleRow = Omit<Sample, 'truck' | 'position' | 'at'> & {at: string | bigint; x: number | null; y: number | null; z: number | null};
function point(row: SampleRow, truck: bigint | null): Sample {
  const {x, y, z, ...sample} = row;
  return {...sample, at: BigInt(sample.at), truck: truck?.toString() ?? null,
    position: x === null || y === null || z === null ? null : {x, y, z}};
}
/** Retained physical readings of the cut's run, using the existing odometer index. */
const RUN_POINTS = `FROM logical_progress p JOIN samples s ON s.id=p.bound_sample_ref
  WHERE p.logical_ref=? AND p.truck_ref IS ? AND p.start_odometer_m IS ? AND coalesce(p.start_ref,p.id)=?
    AND p.bound_sample_ref<=? AND p.anchor_sample_ref=p.bound_sample_ref AND p.cut_odometer_m IS NULL`;

function prefixPoint(db: Database.Database, cut: Cut, loaded: Sample): Sample | undefined {
  if (cut.truck_ref === null || cut.start_ref === null || cut.cut_odometer_m !== loaded.odometerM) return undefined;
  const run = [cut.logical_ref, cut.truck_ref, cut.start_odometer_m, cut.start_ref, cut.bound_sample_ref] as const;
  const candidates = statement(db, `SELECT ${SAMPLE_FIELDS} ${RUN_POINTS}
    AND p.odometer_m=? AND p.bound_sample_ref<? ORDER BY p.id ASC LIMIT ?`)
    .all(...run, cut.cut_odometer_m, loaded.id, QUANTITY_POINT_LIMIT + 1) as SampleRow[];
  if (candidates.length > QUANTITY_POINT_LIMIT) return undefined;
  const saved = candidates.find(row => row.gameMinutes === loaded.gameMinutes && matchesSavedEndpoint(point(row, cut.truck_ref), loaded));
  if (!saved) return undefined;
  // At the saved odometer the truck may already have been stopped for several events. Use a sample strictly before it.
  const earlier = statement(db, `SELECT ${SAMPLE_FIELDS} ${RUN_POINTS}
    AND p.odometer_m<? AND p.bound_sample_ref<? ORDER BY p.odometer_m DESC,p.id DESC LIMIT 1`)
    .get(...run, cut.cut_odometer_m, saved.id) as SampleRow | undefined;
  return earlier ? point(earlier, cut.truck_ref) : undefined;
}

function compareOccurrence(a: MoneyOccurrence, b: MoneyOccurrence): number {
  // Session clocks have unrelated origins. The selected logical membership orders recordings across sessions.
  if (a.session !== b.session) return a.member < b.member ? -1 : a.member > b.member ? 1 : 0;
  if (a.clock !== b.clock || a.at === null || b.at === null || a.at === b.at) return 0;
  return a.at < b.at ? -1 : 1;
}
function retained(event: MoneyOccurrence, {before, after}: Window): boolean {
  return compareOccurrence(event, after) > 0 || !!before && compareOccurrence(event, before) < 0;
}

/**
 * A cut proves the new suffix from its loaded sample. A physical match and a lower odometer sample also prove an
 * earlier prefix. The area between these bounds is excluded from the subtotal; every selected cut must agree.
 */
export function moneyPath(db: Database.Database, head: bigint): {incomplete: boolean; includes?: (event: MoneyOccurrence) => boolean} {
  const cuts = statement(db, `${ACCOUNTING_PATH} SELECT depth,prefix_ref,logical_ref,start_ref,truck_ref,start_odometer_m,
    cut_odometer_m,bound_sample_ref,anchor_sample_ref FROM path WHERE cut_odometer_m IS NOT NULL
      OR depth=256 AND prefix_ref IS NOT NULL`).all({head}) as Cut[];
  const windows: Window[] = [];
  for (const cut of cuts) {
    if (cut.depth === 256n && cut.prefix_ref !== null) return {incomplete: true};
    const loaded = statement(db, `SELECT ${SAMPLE_FIELDS} FROM samples s WHERE s.id=? AND s.trip_ref IS NOT NULL`)
      .get(cut.anchor_sample_ref) as SampleRow | undefined;
    if (!loaded || cut.bound_sample_ref === null || loaded.id <= cut.bound_sample_ref) return {incomplete: true};
    const after = point(loaded, cut.truck_ref);
    windows.push({after, before: prefixPoint(db, cut, after)});
  }
  return windows.length > 0 ? {incomplete: true, includes: event => windows.every(window => retained(event, window))} : {incomplete: false};
}
