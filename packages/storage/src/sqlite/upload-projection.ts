import type Database from 'better-sqlite3';
import type {Available, Money} from '../../../contracts/src/protocol-v1';
import {fromAvailability, fromU64Key, toReal, toSafeNumber} from '../codec';
import {fail} from '../errors';
import {isUploadPageQuery, isUploadProjection, isUploadProjectionPage, isUploadUuid, uploadSnapshotParts,
  type QualifiedOccurrence, type UploadConfiguration, type UploadFacts, type UploadInterval, type UploadMember, type UploadPageKind,
  type UploadProjection, type UploadProjectionPage, type UploadProjectionPageQuery, type UploadReadiness, type UploadVersions} from '../upload-projection';
import type {StorageConnection} from './connection';
import {jobValues} from './journal';
import {snapshot, type LogicalSnapshot} from './logical-snapshot';
import {ACCOUNTING_PATH, type LogicalRow} from './logical-trips';

const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as LogicalRow | undefined;
const all = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as LogicalRow[];
const required = (row: LogicalRow | undefined): LogicalRow => {if (!row) fail('DATABASE_CORRUPT'); return row;};
const n = (value: unknown) => toSafeNumber(value, Number.MAX_SAFE_INTEGER, 0);
const av = (row: LogicalRow, column: string): Available<number> => fromAvailability(row[column],row[`${column}_state`],toReal);
const text = (row: LogicalRow, column: string): Available<string> => fromAvailability(row[column],row[`${column}_state`],String);
const MEMBERS = `FROM logical_snapshot_memberships x JOIN trips t ON t.id=x.trip_ref
  WHERE x.logical_ref=@logical AND x.trip_ref<=@members AND x.from_revision<@revision AND (x.through_revision IS NULL OR x.through_revision>=@revision)`;
const scope = (snap: LogicalSnapshot) => ({logical: snap.logical, members: snap.members, revision: snap.revision});
const trailerSql = `FROM logical_snapshot_memberships x JOIN trips t ON t.id=x.trip_ref
  JOIN trip_trailers a ON a.trip_ref=t.id JOIN trailer_configurations c ON c.id=a.trailer_configuration_ref JOIN events e ON e.id=c.event_ref
  WHERE x.logical_ref=@logical AND x.trip_ref<=@members AND x.from_revision<@revision AND (x.through_revision IS NULL OR x.through_revision>=@revision) AND e.id<=@events`;
const intervalSql = `FROM logical_snapshot_memberships x JOIN trips t ON t.id=x.trip_ref JOIN completeness_intervals c ON c.trip_ref=t.id
  WHERE x.logical_ref=@logical AND x.trip_ref<=@members AND x.from_revision<@revision AND (x.through_revision IS NULL OR x.through_revision>=@revision) AND c.id<=@intervals`;

function current(db: Database.Database, requested: string): {root: string; readiness: UploadReadiness} {
  const member = get(db, `SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?`,requested);
  if (!member) fail('UNKNOWN_TRIP');
  const root = required(get(db, `SELECT t.trip_uuid,t.outcome,l.retired,m.logical_ref,m.proof_json FROM logical_trips l
    JOIN trips t ON t.id=l.id JOIN logical_memberships m ON m.trip_ref=l.id WHERE l.id=?`,member.logical_ref));
  // An abandoned singleton is retired too. Self-membership must be established before considering retirement/proof.
  if (root.logical_ref !== member.logical_ref) fail('DATABASE_CORRUPT');
  return {root: String(root.trip_uuid), readiness: root.proof_json !== null || root.retired === 1n || root.outcome !== 'open' ? 'ready' : 'identity-pending'};
}
function totals(db: Database.Database, snap: LogicalSnapshot): UploadProjection['totals'] {
  return {members: n(required(get(db,`SELECT count(*) AS total ${MEMBERS}`,scope(snap))).total),
    configurations: n(required(get(db,`SELECT count(DISTINCT e.id) AS total ${trailerSql}`,{...scope(snap),events:snap.events})).total),
    intervals: n(required(get(db,`SELECT count(*) AS total ${intervalSql}`,{...scope(snap),intervals:snap.intervals})).total)};
}
function versions(row: LogicalRow): UploadVersions {
  return {nativeProtocol: {major: 1, minor: n(row.protocol_minor)}, sdkArchive: {available:true,value:String(row.sdk_archive)},
    telemetryApi: {available:true,value:{major:n(row.telemetry_api_major),minor:n(row.telemetry_api_minor)}},
    gameTelemetryApi: {available:true,value:{major:n(row.game_telemetry_major),minor:n(row.game_telemetry_minor)}}};
}
function occurrence(db: Database.Database, ref: unknown, rawTripUuid: string, snap: LogicalSnapshot): QualifiedOccurrence | null {
  if (ref === null || ref === undefined) return null;
  const e = required(get(db, `SELECT e.*,s.plugin_session_uuid FROM events e JOIN plugin_sessions s ON s.id=e.plugin_session_id WHERE e.id=? AND e.id<=?`,ref,snap.events));
  const value = e.occurred_utc_ms_state === 'available' ? BigInt(String(e.occurred_utc_ms)) : null;
  const utcMs = value !== null && value <= 253_402_300_799_999n ? Number(value) : null;
  return {pluginSessionId: String(e.plugin_session_uuid), rawTripUuid, eventSeq: fromU64Key(e.event_seq), type: String(e.type), utcMs};
}
function facts(db: Database.Database, snap: LogicalSnapshot): UploadFacts {
  const row = snap.row, root = required(get(db,'SELECT trip_uuid FROM trips WHERE id=?',snap.logical));
  const openingSession = required(get(db,'SELECT plugin_session_uuid FROM plugin_sessions WHERE id=?',row.plugin_session_ref));
  const job = required(get(db,'SELECT * FROM job_configurations WHERE id=?',row.job_configuration_ref));
  const outcomeRaw = row.outcome_event_ref === null ? undefined : get(db,`SELECT t.trip_uuid ${MEMBERS} AND t.outcome_event_ref=@outcome`,{...scope(snap),outcome:row.outcome_event_ref});
  if (row.outcome_event_ref !== null && !outcomeRaw) fail('DATABASE_CORRUPT');
  const outcome = occurrence(db,row.outcome_event_ref,String(outcomeRaw?.trip_uuid ?? root.trip_uuid),snap);
  const event = row.outcome_event_ref === null ? undefined : required(get(db,'SELECT payload_json FROM events WHERE id=?',row.outcome_event_ref));
  const record = event ? (JSON.parse(String(event.payload_json)) as {record: Record<string, unknown>}).record : {};
  const money = (key: string): Available<Money> => (record[key] ?? {available:false,reason:'not-observed'}) as Available<Money>;
  let close: QualifiedOccurrence | null = null;
  if (row.outcome !== 'open' && row.closed_by_session_ref !== null && row.closed_by_event_seq !== null) {
    const carrier = get(db,'SELECT id FROM events WHERE plugin_session_id=? AND event_seq=? AND id<=?',row.closed_by_session_ref,row.closed_by_event_seq,snap.events);
    // A checkpoint/gap carrier is not an observed event. Its label must not become actual terminal time.
    if (carrier) close = occurrence(db,carrier.id,String(outcomeRaw?.trip_uuid ?? root.trip_uuid),snap);
  }
  const measure = <U extends string>(key: string, unit: U) => ({...av(row,key),unit});
  const unknown = {available:false,reason:'not-observed'} as const;
  const mode = row.game_mode === 'convoy' ? 'unknown' : row.game_mode;
  const opening = occurrence(db,row.opened_event_ref,String(root.trip_uuid),snap);
  return {game: row.game as 'ets2'|'ats', pluginSessionId: String(openingSession.plugin_session_uuid), outcome: row.outcome as UploadFacts['outcome'],
    closeReason: row.close_reason as UploadFacts['closeReason'], recordingCompleteness: row.recording_completeness as UploadFacts['recordingCompleteness'],
    openedBy: row.opened_by as 'event'|'checkpoint', checkpointNextEventSeq: job.source === 'checkpoint' ? fromU64Key(job.checkpoint_next_event_seq) : null,
    checkpointUtcMs: job.source === 'checkpoint' ? n(row.started_utc_ms) : null, opening, outcomeOccurrence: outcome, close,
    gameMode: {mode,method:mode==='unknown'?'none':row.game_mode_method,confidence:mode==='unknown'?'none':row.game_mode_confidence,ambiguous:row.game_mode_ambiguous===1n} as UploadFacts['gameMode'],
    job: jobValues(job), observedDistance: measure('observed_distance_m','m'), fuelUsed: measure('fuel_used_l','L'),
    deliveredDistance: (record.distance ?? {...unknown,unit:'m'}) as UploadFacts['deliveredDistance'], cargoDamage: (record.cargoDamage ?? {...unknown,unit:'fraction'}) as UploadFacts['cargoDamage'],
    revenue: money('revenue'), penalty: money('penalty'), moneyIncomplete: row._moneyIncomplete === true || snap.head !== null
      && !!get(db,`${ACCOUNTING_PATH} SELECT 1 FROM path WHERE cut_odometer_m IS NOT NULL OR depth=256 AND prefix_ref IS NOT NULL LIMIT 1`,{head:snap.head}),
    clockAnomaly: opening?.utcMs !== null && opening?.utcMs !== undefined && opening.utcMs !== n(row.started_utc_ms)
      || outcome?.utcMs !== null && outcome?.utcMs !== undefined && row.ended_utc_ms !== null && outcome.utcMs !== n(row.ended_utc_ms)};
}

export function pinUploadProjection(conn: StorageConnection, tripUuid: string): UploadProjection {
  if (!isUploadUuid(tripUuid)) fail('INVALID_INPUT');
  const db = conn.reader();
  return db.transaction(() => {
    const state = current(db,tripUuid), snap = snapshot(db,state.root), counts = totals(db,snap);
    if (!counts.members) fail('DATABASE_CORRUPT');
    const info = required(get(db,'SELECT database_uuid,purpose FROM database_info WHERE id=1'));
    const token = `u1:${String(info.database_uuid)}:${state.root}:${snap.revision}:${counts.members}:${counts.configurations}:${counts.intervals}:${snap.members}`;
    const value: UploadProjection = {requestedTripUuid:tripUuid, rootTripUuid:state.root, readiness:state.root===tripUuid?state.readiness:'redirected',rootReadiness:state.readiness,
      snapshot:token,databaseUuid:String(info.database_uuid),purpose:info.purpose as UploadProjection['purpose'],revision:String(snap.revision),
      bounds:{members:String(snap.members),events:String(snap.events),gaps:String(snap.gaps),samples:String(snap.samples),intervals:String(snap.intervals),accountingHead:snap.head===null?null:String(snap.head)},
      totals:counts,facts:facts(db,snap)};
    if (!isUploadProjection(value)) fail('DATABASE_CORRUPT');
    return value;
  })();
}

function readPinned(db: Database.Database, token: string): LogicalSnapshot {
  const p = uploadSnapshotParts(token);
  if (!p || required(get(db,'SELECT database_uuid FROM database_info WHERE id=1')).database_uuid !== p[1]) fail('INVALID_INPUT');
  const snap = snapshot(db,p[2],BigInt(p[3])), counts = totals(db,snap);
  // References are immutable within their row bounds. A later attachment of older evidence or staging deletion
  // invalidates this handle explicitly, rather than silently returning a changed or apparently complete set.
  if (p[4] !== String(counts.members) || p[5] !== String(counts.configurations) || p[6] !== String(counts.intervals) || p[7] !== String(snap.members)) fail('INVALID_INPUT');
  return snap;
}

/** Storage-local comparison, for use inside a future owner/freeze transaction. A detached true is not publication permission. */
export function recheckUploadProjection(db: Database.Database, pin: UploadProjection): boolean {
  if (!isUploadProjection(pin)) fail('INVALID_INPUT');
  const info = required(get(db,'SELECT database_uuid FROM database_info WHERE id=1'));
  if (info.database_uuid !== pin.databaseUuid) return false;
  const trip = get(db,'SELECT id FROM trips WHERE trip_uuid=?',pin.requestedTripUuid);
  if (!trip) return false;
  const state = current(db,pin.requestedTripUuid);
  return state.root === pin.rootTripUuid && state.readiness === 'ready' && pin.rootReadiness === 'ready'
    && String(snapshot(db,state.root).revision) === pin.revision;
}

export function readUploadProjectionPage(conn: StorageConnection, query: UploadProjectionPageQuery): UploadProjectionPage {
  if (!isUploadPageQuery(query)) fail('INVALID_INPUT');
  const db = conn.reader();
  return db.transaction(() => {
    const snap = readPinned(db,query.snapshot), after = query.cursor ? BigInt(query.cursor.split(':').at(-1)!) : 0n;
    const params = {...scope(snap),after,limit:query.limit+1};
    let rows: (UploadMember|UploadConfiguration|UploadInterval)[];
    switch (query.kind) {
    case 'members': rows = all(db,`SELECT s.*,t.id AS member_id,t.trip_uuid ${MEMBERS.replace('WHERE','JOIN plugin_sessions s ON s.id=t.plugin_session_ref WHERE')} AND t.id>@after ORDER BY t.id LIMIT @limit`,params)
      .map(r => ({id:String(r.member_id),rawTripUuid:String(r.trip_uuid),pluginSessionId:String(r.plugin_session_uuid),game:r.game as UploadMember['game'],origin:r.origin as UploadMember['origin'],versions:versions(r)})); break;
    case 'configurations': rows = all(db,`SELECT c.*,min(t.trip_uuid) AS trip_uuid ${trailerSql} AND c.event_ref>@after GROUP BY c.event_ref ORDER BY c.event_ref LIMIT @limit`,{...params,events:snap.events})
      .map(r => ({id:String(r.event_ref),occurrence:occurrence(db,r.event_ref,String(r.trip_uuid),snap)!,index:n(r.slot_index),idValue:text(r,'trailer_id'),bodyType:text(r,'body_type'),chainType:text(r,'chain_type')})); break;
    case 'intervals': rows = all(db,`SELECT c.id,c.kind,t.trip_uuid,s.plugin_session_uuid ${intervalSql.replace('WHERE','JOIN plugin_sessions s ON s.id=c.plugin_session_ref WHERE')} AND c.id>@after ORDER BY c.id LIMIT @limit`,{...params,intervals:snap.intervals})
      .map(r => ({id:String(r.id),kind:r.kind as UploadInterval['kind'],rawTripUuid:String(r.trip_uuid),pluginSessionId:String(r.plugin_session_uuid)})); break;
    }
    const more = rows.length > query.limit;
    if (more) rows.pop();
    const kind: UploadPageKind = query.kind, total = Number(uploadSnapshotParts(query.snapshot)![4+['members','configurations','intervals'].indexOf(kind)]);
    const page: UploadProjectionPage = {snapshot:query.snapshot,kind,cursor:query.cursor??null,nextCursor:more?`${query.snapshot}:${kind}:${rows.at(-1)!.id}`:null,total,rows};
    if (!isUploadProjectionPage(page,query)) fail('DATABASE_CORRUPT');
    return page;
  })();
}
