import type Database from 'better-sqlite3';
import type {JournalGame, TruckPowertrain} from '../../../contracts/src';
import {truckPowertrain} from '../../../telemetry-core/src/truck-powertrain';
import {u64Key} from '../codec';
import {ACCOUNTING_PATH} from './logical-trips';
import {statement} from './writes';

const modelPowertrain = (game: JournalGame, value: unknown) => truckPowertrain(game, typeof value === 'string' ? value : undefined);

/** The model reading in a recorder truck identity (brand, model, plate). */
function recordedPowertrain(game: JournalGame, key: string | null): TruckPowertrain {
  if (key === null) return 'unknown';
  try {
    const fields: unknown = JSON.parse(key);
    const model: unknown = Array.isArray(fields) ? fields[1] : undefined;
    if (model && typeof model === 'object' && 'state' in model && model.state === 'value' && 'value' in model)
      return modelPowertrain(game, model.value);
  } catch { /* Historical test and recovery inputs need not be recorder identities. */ }
  return 'unknown';
}

const MAX_EVENT_ID = 9_223_372_036_854_775_807n;
const AT_TIME = `SELECT c.model_id FROM events e LEFT JOIN truck_configurations c ON c.event_ref=e.id
  WHERE e.plugin_session_id=@session AND e.source_clock_ref=@clock AND e.type IN ('truck.configured','truck.cleared')
  AND e.occurred_monotonic_ns<=@at AND e.id<=@bound
  ORDER BY e.occurred_monotonic_ns DESC,e.event_seq DESC LIMIT 1`;

/** Prefer the sample's own recorded identity. Older samples can use a configuration from their source clock. */
export function samplePowertrain(db: Database.Database, game: JournalGame, identity: unknown, session: unknown, clock: unknown,
  monotonic: bigint, eventBound = MAX_EVENT_ID): TruckPowertrain {
  if (typeof identity === 'string' && identity.startsWith('[')) return recordedPowertrain(game, identity);
  const model = statement(db, AT_TIME).pluck().get({session, clock, at: u64Key(monotonic), bound: eventBound});
  return modelPowertrain(game, model);
}

/** Verify that all retained runs and the trip configuration agree before naming the aggregate's unit. */
export function tripEnergyPowertrain(db: Database.Database, game: JournalGame, truckRef: unknown, head: bigint | null, trip: unknown, openingRef: unknown, eventBound = MAX_EVENT_ID): TruckPowertrain {
  const current = modelPowertrain(game, truckRef == null ? null
    : statement(db, 'SELECT model_id FROM truck_configurations WHERE id=?').pluck().get(truckRef));
  let unitType = current;
  if (head !== null) {
    const runs = statement(db, ACCOUNTING_PATH + ` SELECT t.identity_key, p.depth=256 AND p.prefix_ref IS NOT NULL AS truncated
      FROM path p LEFT JOIN logical_progress a ON a.sample_ref=p.anchor_sample_ref
      LEFT JOIN logical_trucks t ON t.id=coalesce(a.truck_ref,p.truck_ref)`).pluck(false).all({head}) as {identity_key: string | null; truncated: bigint}[];
    if (runs.some(run => run.truncated === 1n)) return 'unknown';
    const types = new Set(runs.map(run => recordedPowertrain(game, run.identity_key)));
    if (unitType !== 'unknown') types.delete('unknown');
    if (types.size > 1 || types.size === 1 && unitType !== 'unknown' && !types.has(unitType)) return 'unknown';
    if (unitType === 'unknown' && types.size === 1) unitType = [...types][0];
  }
  if (unitType === 'unknown') return unitType;

  // A truck may have been configured before the job opened. The latest configuration alone would mislabel a legacy
  // total if it changed during the trip, before the per-sample ledger was introduced.
  const opening = openingRef == null ? undefined : statement(db, `SELECT s.model_id FROM events o JOIN events e
    ON e.plugin_session_id=o.plugin_session_id AND e.event_seq<=o.event_seq
    LEFT JOIN truck_configurations s ON s.event_ref=e.id
    WHERE o.id=? AND e.type IN ('truck.configured','truck.cleared') ORDER BY e.event_seq DESC LIMIT 1`).pluck().get(openingRef);
  if (opening !== undefined && modelPowertrain(game, opening) !== unitType) return 'unknown';

  const observed = statement(db, `SELECT c.model_id FROM event_attributions a JOIN truck_configurations c ON c.event_ref=a.event_ref
    WHERE a.trip_ref=? AND a.event_ref<=?`).pluck().all(trip, eventBound);
  return observed.some(id => modelPowertrain(game, id) !== unitType) ? 'unknown' : unitType;
}
