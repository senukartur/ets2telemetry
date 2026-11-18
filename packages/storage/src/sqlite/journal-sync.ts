import type Database from 'better-sqlite3';
import type {JournalSyncRow, JournalTripSync,JournalQualificationDetailRow} from '../../../contracts/src/journal';
import {isDashboardOwner, uploadUuid, type DashboardOwner} from '../../../contracts/src/dashboard-upload';
import {identityPending} from './identity-pending';
import {isQualificationWire,isQualificationVerdict,isQualificationResultMetadata,QUALIFICATION_DETAIL_BYTES} from '../../../contracts/src/qualification';
import {fail} from '../errors';

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
type DetailSync={owner:DashboardOwner;connectionVersion:string;rows:JournalQualificationDetailRow[]};
export function journalSync(db:Database.Database,tripUuids:readonly string[],details:true):DetailSync|undefined;
export function journalSync(db:Database.Database,tripUuids:readonly string[],details?:false):JournalTripSync|undefined;
export function journalSync(db: Database.Database, tripUuids: readonly string[],details=false): JournalTripSync|DetailSync|undefined {
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
    if(scope)for(const row of rows){
      if(row.state==='unavailable'||row.state==='unbound'||row.state==='identity-pending')continue;
      const head=get(db,`SELECT h.*,${details?'v.snapshot_json,':''}
        EXISTS(SELECT 1 FROM upload_receipts r WHERE r.event_ref=h.event_ref) AS has_receipt,
        json_extract(v.snapshot_json,'$.state') AS result_state,json_extract(v.snapshot_json,'$.assessmentBasis') AS assessment_basis,
        json_extract(v.snapshot_json,'$.assessmentPending') AS assessment_pending,json_extract(v.snapshot_json,'$.correctionPending') AS correction_pending,
        json_type(v.snapshot_json,'$.assessment') AS assessment_type,json_extract(v.snapshot_json,'$.assessment.availability') AS availability,json_extract(v.snapshot_json,'$.assessment.outcome') AS outcome,
        json_extract(v.snapshot_json,'$.companyDecision') AS company_decision,json_extract(v.snapshot_json,'$.credit') AS credit_json FROM upload_source_bindings b
        JOIN qualification_result_heads h ON h.kind='root' AND h.registration_ref=b.registration_ref AND h.root_ref=b.root_ref AND h.security_scope=?
        JOIN qualification_result_versions v ON v.registration_ref=h.registration_ref AND v.security_scope=h.security_scope AND v.event_ref=h.event_ref AND v.view_key=h.view_key
        WHERE b.registration_ref=? AND b.trip_uuid=?`,scope,config.active_registration,row.tripUuid);
      let credit:unknown=null;if(head&&head.credit_json!==null){if(typeof head.credit_json!=='string')fail('DATABASE_CORRUPT');credit=JSON.parse(head.credit_json);}
      const latest=head?{companyDecision:head.company_decision,credit}:undefined;
      if(latest&&!isQualificationResultMetadata(latest))fail('DATABASE_CORRUPT');
      const applicable=!!head&&Number(head.source_revision)===row.latestRevision&&row.state==='sent'&&head.assessment_basis==='current'&&head.result_state==='decided'&&Number(head.assessment_pending)===0&&Number(head.correction_pending)===0&&head.assessment_type==='object';
      const awaiting=row.state==='sent'&&!applicable;
      if(!details){
        const current=applicable?{availability:head.availability,outcome:head.outcome}:null;if(current&&!isQualificationVerdict(current))fail('DATABASE_CORRUPT');
        row.qualification={current,awaiting,...(latest?{latest}: {})};
      }else{
        const read=(json:unknown)=>{if(json===null||json===undefined)return null;if(typeof json!=='string')fail('DATABASE_CORRUPT');const value:unknown=JSON.parse(json);if(!isQualificationWire('Result',value))fail('DATABASE_CORRUPT');return value;};
        const stored=read(head?.snapshot_json),current=applicable&&stored?{...stored,version:String(head.server_version),resultRevision:String(head.result_revision)}:null;
        if(current&&!isQualificationWire('Result',current))fail('DATABASE_CORRUPT');
        let previous=null;
        if(head){
          const beforeReceipt=Number(head.source_revision)===row.latestRevision&&Number(head.has_receipt)===0&&head.assessment_basis==='current'&&head.result_state==='decided';
          const older=applicable||beforeReceipt,show=applicable||beforeReceipt||Number(head.source_revision)<(row.latestRevision??0)||head.assessment_basis==='predecessor'||row.state==='sent'||row.state==='pending';
          const event=older?head.previous_event_ref:head.latest_event_ref,view=older?head.previous_view_key:head.latest_view_key;
          if(show&&event&&view)previous=read(get(db,'SELECT snapshot_json FROM qualification_result_versions WHERE registration_ref=? AND event_ref=? AND security_scope=? AND view_key=?',config.active_registration,event,scope,view)?.snapshot_json);
        }
        const decoration={current,previous,awaiting,...(latest?{latest}: {})};if(Buffer.byteLength(JSON.stringify(decoration))>QUALIFICATION_DETAIL_BYTES)fail('DATABASE_CORRUPT');
        (row as JournalQualificationDetailRow).qualification=decoration;
      }
    }
  }
  return {owner, connectionVersion: String(config.version), rows};
}
