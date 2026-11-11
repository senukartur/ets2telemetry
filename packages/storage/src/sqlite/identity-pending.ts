import type Database from 'better-sqlite3';

/** Schema 9: the membership decision state of a raw trip by its primary key, or undefined without a decision row. */
export function decisionState(db: Database.Database, tripRef: unknown): 'pending' | 'joined' | 'root' | 'separate' | undefined {
  if (Number(db.pragma('user_version', {simple: true})) < 9) return undefined;
  return db.prepare('SELECT state FROM logical_membership_decisions WHERE trip_ref = ?').pluck().get(tripRef) as 'pending' | 'joined' | 'root' | 'separate' | undefined;
}
/** Whether a logical root already has an upload source binding (schema 6); a bound root keeps its publication. */
export function rootBound(db: Database.Database, rootRef: unknown): boolean {
  return Number(db.pragma('user_version', {simple: true})) >= 6 && db.prepare('SELECT 1 FROM upload_source_bindings WHERE root_ref = ?').get(rootRef) !== undefined;
}
/**
 * The one upload identity guard of a logical self-root: an open raw trip without proof that nothing retired, or a schema 9
 * membership decision that is still pending, such as a closed segment that a later proof of its session may still move.
 * A bound root is never pending again. Legacy rows without a decision keep the open-trip rule alone.
 */
export function identityPending(trip: Readonly<Record<string, unknown>>, decision: string | undefined, bound: boolean): boolean {
  return !bound && ((trip.proof_json === null && trip.retired === 0n && trip.outcome === 'open') || decision === 'pending');
}
