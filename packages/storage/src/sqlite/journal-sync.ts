import type Database from 'better-sqlite3';
import type {JournalSyncRow, JournalTripSync} from '../../../contracts/src/journal';
import {isDashboardOwner, uploadUuid, type DashboardOwner} from '../../../contracts/src/dashboard-upload';
import {identityPending} from './identity-pending';
import {isQualificationWire} from '../../../contracts/src/qualification';

type Row = Record<string, unknown>;
const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Row | undefined;
export const JOURNAL_SYNC_QUERIES = {
  root: `SELECT t.id,t.trip_uuid,t.game,t.outcome,s.origin,s.plugin_session_uuid,m.logical_ref,m.proof_json,l.retired FROM trips t
    JOIN plugin_sessions s ON s.id=t.plugin_session_ref JOIN logical_memberships m ON m.trip_ref=t.id
    JOIN logical_trips l ON l.id=m.logical_ref WHERE t.trip_uuid=?`,
  claim: 'SELECT * FROM upload_history_claims WHERE first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',
  envelope: 'SELECT * FROM upload_envelopes WHERE root_ref=? ORDER BY revision DESC LIMIT 1',
  attempt: 'SELECT * FROM upload_attempt WHERE active=1',
  /** Schema 9 only: the root's membership decision, by primary key. */
  decision: 'SELECT state FROM logical_membership_decisions WHERE trip_ref=?'
} as const;

/** SELECT-only evidence for precisely the returned page. Caller owns the SQLite read transaction. */
export function journalSync(db: Database.Database, tripUuids: readonly string[]): JournalTripSync | undefined {
  if (tripUuids.length > 50 || Number(db.pragma('user_version', {simple: true})) < 6) return;
  if (get(db, 'SELECT purpose FROM database_info WHERE id=1')?.purpose !== 'history') return;
  const config = get(db, 'SELECT * FROM upload_connection WHERE id=1');
  if (!config?.active_registration || !config.credential_generation || !config.active_run) return;
  const registration = get(db, 'SELECT * FROM upload_registrations WHERE registration_id=?', config.active_registration);
  if (!registration || get(db, 'SELECT registration_ref FROM upload_scan_runs WHERE run_id=?', config.active_run)?.registration_ref !== config.active_registration) return;
  const owner: DashboardOwner = {origin: String(registration.origin), accountId: String(registration.account_id), companyId: String(registration.company_id), identityEpoch: String(registration.identity_epoch)};
  if (!isDashboardOwner(owner)) return;
  const rows = tripUuids.map((tripUuid): JournalSyncRow => {
    const absent: JournalSyncRow = {tripUuid, state: 'unavailable', materialVersion: null, latestRevision: null, lastDurableUploadUtcMs: null, reason: null};
    const root = get(db, JOURNAL_SYNC_QUERIES.root, tripUuid);
    if (!root || root.origin !== 'game' || root.id !== root.logical_ref) return absent;
    const candidate = get(db, 'SELECT * FROM upload_candidates WHERE trip_ref=?', root.id);
    if (candidate && candidate.trip_uuid !== tripUuid) return absent;
    // Legacy roots may not yet have a candidate; their original ID is their reserved ordinal.
    const ordinal = candidate?.ordinal ?? ((root.id as bigint) <= (config.legacy_boundary as bigint) ? root.id : undefined);
    if (ordinal === undefined) return absent;
    const reservation = candidate ? get(db, 'SELECT * FROM upload_reservations WHERE candidate_ref=?', ordinal) : undefined;
    if (candidate && !reservation) return absent;
    if (reservation?.identity_state === 'redirected') return absent;
    const claim = get(db, JOURNAL_SYNC_QUERIES.claim, ordinal);
    const effectiveClaim = claim && (claim.last_ordinal as bigint) >= (ordinal as bigint) ? claim : undefined;
    const effectiveOwner = reservation?.registration_ref ?? effectiveClaim?.registration_ref ?? null;
    const effectiveRun = reservation?.registration_ref ? reservation.run_ref : effectiveClaim?.run_ref;
    const effectiveMode = reservation?.registration_ref ? reservation.mode : effectiveClaim ? 'backfill' : 'unbound';
    const bound = get(db, 'SELECT * FROM upload_source_bindings WHERE root_ref=?', root.id);
    if (effectiveOwner !== null && effectiveOwner !== config.active_registration || bound && bound.registration_ref !== config.active_registration) return absent;
    if (bound && (bound.trip_uuid !== tripUuid || bound.game !== root.game || bound.plugin_session_uuid !== root.plugin_session_uuid || bound.run_ref !== effectiveRun || bound.mode !== effectiveMode)) return absent;
    if (effectiveOwner === null) {
      if (bound || (ordinal as bigint) <= (config.claimed_through as bigint) || reservation?.hold_reason != null || reservation && reservation.identity_state !== 'unbound') return absent;
      return {...absent, state: 'unbound'};
    }
    const head = get(db, 'SELECT * FROM upload_change_heads WHERE root_ref=?', root.id);
    const held = (reason: unknown): JournalSyncRow => ({...absent, state: 'held', materialVersion: head ? String(head.material_version) : null, reason: reason === 'validation' ? 'validation' : 'reconciliation'});
    if (reservation?.hold_reason != null || reservation?.identity_state === 'held' || bound?.held === 1n) return held(bound?.hold_reason);
    const decision = Number(db.pragma('user_version', {simple: true})) >= 9 ? get(db, JOURNAL_SYNC_QUERIES.decision, root.id)?.state as string | undefined : undefined;
    if (reservation?.identity_state === 'pending' || identityPending(root, decision, bound !== undefined)) return {...absent, state: 'identity-pending', materialVersion: head ? String(head.material_version) : null};
    if (bound && reservation?.identity_state !== 'resolved') return absent;
    if (!head) return absent;
    const pending = {...absent, state: 'pending' as const, materialVersion: String(head.material_version)};
    if (!bound) return pending;
    const envelope = get(db, JOURNAL_SYNC_QUERIES.envelope, root.id);
    if (!envelope) return pending;
    if (envelope.registration_ref !== effectiveOwner || envelope.revision !== bound.http_revision || !uploadUuid(envelope.event_id) || bound.material_digest === null) return absent;
    const result = {...pending, latestRevision: Number(envelope.revision)};
    if (envelope.state === 'held') return {...held(envelope.hold_reason), latestRevision: result.latestRevision};
    const work = get(db, 'SELECT * FROM upload_materializations WHERE root_ref=? AND material_version=?', root.id, head.material_version);
    if (work && work.registration_ref !== effectiveOwner) return absent;
    if (work?.state === 'held') return {...held(work.hold_reason), latestRevision: result.latestRevision};
    if (head.dirty !== 0n || bound.pending !== 0n || bound.compared_version !== head.material_version || !work || !['frozen', 'equal'].includes(String(work.state))) return result;
    if (work.state === 'frozen' && work.event_ref !== envelope.event_id) return absent;
    const receipt = get(db, 'SELECT * FROM upload_receipts WHERE event_ref=?', envelope.event_id);
    if (envelope.state === 'delivered' && receipt && uploadUuid(receipt.receipt_id)) return {...result, state: 'sent', lastDurableUploadUtcMs: Number(receipt.first_received)};
    if (receipt) return absent;
    if (envelope.state === 'sending') {
      const attempt = get(db, JOURNAL_SYNC_QUERIES.attempt);
      return attempt && attempt.event_ref === envelope.event_id && attempt.registration_ref === effectiveOwner && attempt.connection_version === config.version && attempt.credential_generation === config.credential_generation && attempt.outcome === null ? {...result, state: 'sending'} : absent;
    }
    return envelope.state === 'queued' ? {...result, state: 'queued'} : absent;
  });
  if(Number(db.pragma('user_version',{simple:true}))>=11){
    const scope=get(db,'SELECT security_scope FROM qualification_refresh_state WHERE registration_ref=?',config.active_registration)?.security_scope;
    let bytes=0;
    if(scope)for(const row of rows){
      if(row.state==='unavailable'||row.state==='unbound'||row.state==='identity-pending')continue;
      const records=db.prepare(`SELECT v.snapshot_json,e.revision FROM qualification_result_heads h JOIN qualification_result_versions v USING(registration_ref,event_ref,security_scope,version)
        JOIN upload_envelopes e ON e.event_id=h.event_ref JOIN upload_source_bindings b ON b.root_ref=e.root_ref
        WHERE h.registration_ref=? AND h.security_scope=? AND b.trip_uuid=? AND b.registration_ref=? ORDER BY e.revision DESC LIMIT 2`).all(config.active_registration,scope,row.tripUuid,config.active_registration) as Row[];
      const results=records.map(record=>{const value:unknown=JSON.parse(String(record.snapshot_json));return isQualificationWire('Result',value)?value:null;});
      const latest=results[0]??null;
      const applicable=latest&&Number(records[0].revision)===row.latestRevision&&row.state==='sent'&&latest.assessmentBasis==='current'&&latest.state==='decided'&&!latest.assessmentPending&&!latest.correctionPending&&latest.assessment!==null;
      const showPrevious=latest&&(Number(records[0].revision)<(row.latestRevision??0)||latest.assessmentBasis==='predecessor'||row.state==='sent'||row.state==='pending');
      let previous=applicable?results[1]??null:showPrevious?latest:null;
      if((applicable||showPrevious)&&!previous?.assessment){
        const retained=get(db,`SELECT v.snapshot_json FROM qualification_result_versions v JOIN upload_envelopes e ON e.event_id=v.event_ref
          JOIN upload_source_bindings b ON b.root_ref=e.root_ref WHERE v.registration_ref=? AND v.security_scope=? AND b.trip_uuid=? AND b.registration_ref=?
          AND json_type(v.snapshot_json,'$.assessment')='object' AND (v.event_ref<>? OR v.version<>?)
          ORDER BY e.revision DESC,length(v.result_revision) DESC,v.result_revision DESC LIMIT 1`,config.active_registration,scope,row.tripUuid,config.active_registration,latest?.requestedEventId??'',latest?.version??'');
        const value:unknown=retained?JSON.parse(String(retained.snapshot_json)):null;previous=isQualificationWire('Result',value)?value:null;
      }
      const decoration={current:applicable?latest:null,previous,...(latest?{latest}:{}),awaiting:row.state==='sent'&&!applicable};
      bytes+=Buffer.byteLength(JSON.stringify(decoration));if(bytes>1048576)continue;
      row.qualification=decoration;
    }
  }
  return {owner, connectionVersion: String(config.version), rows};
}
