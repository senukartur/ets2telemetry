// The history repair plan format (ET-112g, docs/storage.md "History repair"): canonical JSON, the confirmation code and
// the strict plan parser. Node-safe: no native SQLite, so the command-line tool's argument checks and its unit tests use it.
import {createHash} from 'node:crypto';
import {REPAIR_PLAN_FORMAT, type RepairPlan} from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with object keys in code-point order at every level: the comparison and hash form of plans and summaries. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** The first 8 hex digits of the SHA-256 of the canonical JSON of the plan's actions. */
export function repairConfirmationCode(actions: RepairPlan['actions']): string {
  return createHash('sha256').update(canonicalJson(actions)).digest('hex').slice(0, 8);
}
/**
 * Parses a plan file strictly enough to apply it; undefined for anything else, including an action whose segment is not
 * among the plan's attested trips. The after-values are compared, not interpreted.
 */
export function parseRepairPlan(text: string): RepairPlan | undefined {
  let plan: unknown;
  try { plan = JSON.parse(text); } catch { return undefined; }
  if (!object(plan) || plan.format !== REPAIR_PLAN_FORMAT || typeof plan.databaseUuid !== 'string' || !UUID.test(plan.databaseUuid) || typeof plan.confirmation !== 'string'
    || !/^[0-9a-f]{8}$/.test(plan.confirmation) || !Array.isArray(plan.actions) || !Array.isArray(plan.listings) || !Array.isArray(plan.attested)
    || !Array.isArray(plan.excluded) || !Array.isArray(plan.quantityListings)) return undefined;
  const uuid = (value: unknown) => typeof value === 'string' && UUID.test(value);
  const attested = plan.attested as unknown[];
  // A join needs its segment attested; a recalculation has no segment and needs no attestation.
  const valid = attested.every(uuid) && plan.actions.every(action => object(action) && typeof action.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(action.fingerprint)
    && object(action.after) && object(action.before)
    && (action.kind === 'join' ? uuid(action.segmentTripUuid) && uuid(action.targetTripUuid) && attested.includes(action.segmentTripUuid)
      : action.kind === 'quantities' && uuid(action.logicalTripUuid)));
  return valid ? plan as unknown as RepairPlan : undefined;
}
