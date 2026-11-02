import type Database from 'better-sqlite3';
import {applyProgress, decodeRow, logicalFor, revise, type LogicalRow} from './logical-trips';
import {fail} from '../errors';

export interface LogicalSnapshot {revision: bigint; logical: bigint; row: LogicalRow; members: bigint; events: bigint; gaps: bigint; samples: bigint; intervals: bigint; head: bigint | null}
const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as LogicalRow | undefined;
export function snapshot(db: Database.Database, tripUuid: string, revision?: bigint): LogicalSnapshot {
  const trip = get(db, 'SELECT id FROM trips WHERE trip_uuid = ?', tripUuid);
  if (!trip) fail('UNKNOWN_TRIP');
  let logical = logicalFor(db, trip.id);
  let found = revision === undefined ? get(db, 'SELECT r.*,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref WHERE r.logical_ref = ? ORDER BY r.id DESC LIMIT 1', logical)
    : get(db, 'SELECT r.*,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref WHERE r.id = ?', revision);
  if (found && revision !== undefined) {if (decodeRow(found.row_json).trip_uuid !== tripUuid) fail('INVALID_INPUT'); logical = found.logical_ref as bigint;}
  if (!found && revision === undefined) {revise(db, logical); found = get(db, 'SELECT r.*,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref WHERE r.logical_ref = ? ORDER BY r.id DESC LIMIT 1', logical);}
  if (!found) fail('INVALID_INPUT');
  return {revision: found.id as bigint, logical, row: applyProgress(db,decodeRow(found.row_json),found.progress_head), members: found.member_through as bigint, events: found.event_through as bigint, gaps: found.gap_through as bigint,
    samples: found.sample_through as bigint, intervals: found.interval_through as bigint, head: found.progress_head as bigint | null};
}
export function snapshotToken(db: Database.Database, tripUuid: string, snap: LogicalSnapshot, kind: 'e' | 'i' | 's' | 'r', after: bigint): string {
  const database = get(db, 'SELECT database_uuid FROM database_info WHERE id = 1')!.database_uuid;
  return `v4:${String(database)}:${tripUuid}:${snap.revision}:${kind}:${after}`;
}
export function readSnapshotToken(db: Database.Database, tripUuid: string, token: string | undefined, kind: 'e' | 'i' | 's' | 'r'): {snap: LogicalSnapshot; after: bigint} {
  if (!token?.startsWith('v4:')) return {snap: snapshot(db, tripUuid), after: BigInt(token ?? '0')};
  const parts = token.split(':'), database = get(db, 'SELECT database_uuid FROM database_info WHERE id = 1')!.database_uuid;
  if (parts.length !== 6 || parts[1] !== database || parts[2] !== tripUuid || parts[4] !== kind) fail('INVALID_INPUT');
  return {snap: snapshot(db, tripUuid, BigInt(parts[3])), after: BigInt(parts[5])};
}

export function needsSnapshot(db: Database.Database, tripUuid: string): boolean {
  const row = get(db, `SELECT m.decision_key,l.profile_scope,l.progress_head,l.member_count FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id
    JOIN logical_trips l ON l.id=m.logical_ref WHERE t.trip_uuid=?`,tripUuid);
  return !!row && (!String(row.decision_key).startsWith('migration-v4:') || row.profile_scope !== null || row.progress_head !== null || Number(row.member_count)>1);
}
