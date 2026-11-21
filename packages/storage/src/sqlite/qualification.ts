import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {compareQualificationCounter, isQualificationCounter, isQualificationWire, qualificationDecisionJson, qualificationStoredViewJson, qualificationAssessmentJson, qualificationResultMatches, qualificationResultBatchMatches, type QualificationResult, type QualificationSnapshot} from '../../../contracts/src/qualification';
import type {CommitOptions} from '../api';
import {fail} from '../errors';
import {isQualificationCommand, type QualificationAuthority, type QualificationCommands, type QualificationCommandName, type QualificationLocalSource, type QualificationStoredState} from '../qualification';
import {canonicalUpload} from '../upload-envelope';
import {get, type Row} from './upload-discovery';
import {syncTransaction} from './upload-sync';
import type {StorageConnection} from './connection';
import {journalTrip} from './journal';
import {beginUploadProjection,advanceUploadProjection,releaseUploadProjection} from './upload-projection';
type Input<K extends QualificationCommandName> = QualificationCommands[K]['args']['input'];
function check<K extends QualificationCommandName>(name: K, input: Input<K>): void {if (!isQualificationCommand({name,input})) fail('INVALID_INPUT');}
export function qualificationActive(db: Database.Database, input: QualificationAuthority, scope?: string): boolean {
  const config = get(db, 'SELECT active_registration,version FROM upload_connection WHERE id=1');
  return config?.active_registration === input.registrationId && String(config.version) === input.connectionVersion && !!get(db, "SELECT 1 FROM database_info WHERE id=1 AND purpose='history'") && (scope === undefined || get(db, 'SELECT security_scope FROM qualification_refresh_state WHERE registration_ref=?', input.registrationId)?.security_scope === scope);
}
const emptyRefresh = () => ({afterEvent: null, retryAtMs: 0, failureStreak: 0, suspended: false});
export function readQualificationPreviewPins(conn:StorageConnection,input:Input<'readQualificationPreviewPins'>):QualificationCommands['readQualificationPreviewPins']['value'] {
  check('readQualificationPreviewPins',input);const rows=conn.reader().prepare('SELECT registration_ref,connection_version,preview_pin FROM qualification_refresh_state WHERE preview_pin IS NOT NULL ORDER BY registration_ref LIMIT 8').all() as Row[];
  return {items:rows.map(row=>({registrationId:String(row.registration_ref),connectionVersion:String(row.connection_version),pinId:String(row.preview_pin)}))};
}
export function beginQualificationPreview(conn:StorageConnection,input:Input<'beginQualificationPreview'>,options?:CommitOptions):QualificationCommands['beginQualificationPreview']['value'] {
  check('beginQualificationPreview',input);return syncTransaction(conn,db=>{
    if(!qualificationActive(db,input))fail('INVALID_INPUT');
    const state=get(db,'SELECT preview_pin FROM qualification_refresh_state WHERE registration_ref=?',input.registrationId);
    if(!state||state.preview_pin!==null&&state.preview_pin!==input.pinId)fail('STORAGE_BUSY');
    if(!get(db,'SELECT 1 FROM upload_source_bindings WHERE registration_ref=? AND trip_uuid=?',input.registrationId,input.tripUuid))fail('INVALID_INPUT');
    if(state.preview_pin!==input.pinId&&get(db,'SELECT 1 FROM upload_projection_pins WHERE pin_id=?',input.pinId))fail('INVALID_INPUT');
    const value=beginUploadProjection(conn,{pinId:input.pinId,tripUuid:input.tripUuid});
    db.prepare('UPDATE qualification_refresh_state SET preview_pin=? WHERE registration_ref=?').run(input.pinId,input.registrationId);return value;
  },options);
}
export function advanceQualificationPreview(conn:StorageConnection,input:Input<'advanceQualificationPreview'>,options?:CommitOptions):QualificationCommands['advanceQualificationPreview']['value'] {
  check('advanceQualificationPreview',input);return syncTransaction(conn,db=>{
    if(!qualificationActive(db,input)||get(db,'SELECT preview_pin FROM qualification_refresh_state WHERE registration_ref=?',input.registrationId)?.preview_pin!==input.pinId)fail('INVALID_INPUT');
    return advanceUploadProjection(conn,input.pinId);
  },options);
}
export function releaseQualificationPreview(conn:StorageConnection,input:Input<'releaseQualificationPreview'>,options?:CommitOptions):QualificationCommands['releaseQualificationPreview']['value'] {
  check('releaseQualificationPreview',input);return syncTransaction(conn,db=>{
    const state=get(db,'SELECT preview_pin FROM qualification_refresh_state WHERE registration_ref=?',input.registrationId);
    if(!state||state.preview_pin!==input.pinId)fail('INVALID_INPUT');
    db.prepare('UPDATE qualification_refresh_state SET preview_pin=NULL WHERE registration_ref=?').run(input.registrationId);
    const value=releaseUploadProjection(conn,input.pinId);
    if(value.state!=='released')db.prepare('UPDATE qualification_refresh_state SET preview_pin=? WHERE registration_ref=?').run(input.pinId,input.registrationId);return value;
  },options);
}
export function readQualificationPreview(conn:StorageConnection,input:Input<'readQualificationPreview'>):QualificationCommands['readQualificationPreview']['value'] {
  check('readQualificationPreview',input);const db=conn.reader();return db.transaction(():QualificationCommands['readQualificationPreview']['value']=>{
    if(!qualificationActive(db,input))return {current:null};
    const row=get(db,`SELECT t.trip_uuid AS raw_uuid,root.trip_uuid,h.material_version FROM trips t JOIN plugin_sessions s ON s.id=t.plugin_session_ref
      JOIN logical_memberships m ON m.trip_ref=t.id JOIN trips root ON root.id=m.logical_ref JOIN upload_source_bindings b ON b.root_ref=root.id AND b.registration_ref=? LEFT JOIN upload_change_heads h ON h.root_ref=root.id
      WHERE t.outcome='open' AND t.game=? AND s.plugin_session_uuid=? AND s.origin='game' LIMIT 1`,input.registrationId,input.game,input.pluginSessionId);
    if(!row)return {current:null};
    const detail=journalTrip(conn,String(row.trip_uuid));
    const distance=detail.trip.observedDistanceM;
    const text=distance.available?String(distance.value):null;
    const known=text!==null&&isQualificationWire('Decimal',text);
    return {current:{tripUuid:String(row.trip_uuid),rawTripUuid:String(row.raw_uuid),materialVersion:typeof row.material_version==='bigint'?row.material_version.toString():'0',actualDistance:{availability:known?'known':'unknown',metres:known?text:null,final:false,support:detail.trip.accounting?.distance.status==='complete'?'whole-trip':detail.trip.accounting?.distance.status==='partial'?'partial':'unknown'}}};
  })();
}
export function readQualificationCache(conn: StorageConnection, input: Input<'readQualificationCache'>): QualificationStoredState {
  check('readQualificationCache', input);const db = conn.reader();
  return db.transaction(() => {
    if (!qualificationActive(db,input)) return {active:false,securityScope:null,caches:[],refresh:emptyRefresh()};
    const state = get(db, 'SELECT * FROM qualification_refresh_state WHERE registration_ref=?', input.registrationId);
    if (!state) return {active:true,securityScope:null,caches:[],refresh:emptyRefresh()};
    const rows = db.prepare('SELECT snapshot_json,fetched_at FROM qualification_cache WHERE registration_ref=? AND security_scope=? ORDER BY game').all(input.registrationId,state.security_scope) as Row[];
    const caches = rows.map(row => ({snapshot: JSON.parse(String(row.snapshot_json)) as QualificationSnapshot, fetchedUtcMs: Number(row.fetched_at)}));
    const owner=get(db,'SELECT account_id FROM upload_registrations WHERE registration_id=?',input.registrationId);
    if (caches.some(cache => !isQualificationWire('Qualification',cache.snapshot)||cache.snapshot.ownerId!==owner?.account_id)) fail('DATABASE_CORRUPT');
    return {active:true,securityScope:String(state.security_scope),caches,refresh:{afterEvent:state.after_event as string|null,retryAtMs:Number(state.retry_at),failureStreak:Number(state.failure_streak),suspended:state.suspended===1n}};
  })();
}
export function setQualificationScope(conn: StorageConnection, input: Input<'setQualificationScope'>, options?: CommitOptions): {active:boolean} {
  check('setQualificationScope',input);return syncTransaction(conn, db => {
    if (!qualificationActive(db,input)) return {active:false};
    const old = get(db,'SELECT security_scope FROM qualification_refresh_state WHERE registration_ref=?',input.registrationId);
    if (old?.security_scope !== input.securityScope) db.prepare('DELETE FROM qualification_cache WHERE registration_ref=?').run(input.registrationId);
    db.prepare(`INSERT INTO qualification_refresh_state(registration_ref,security_scope,connection_version) VALUES(?,?,?) ON CONFLICT(registration_ref) DO UPDATE SET
      after_event=CASE WHEN security_scope=excluded.security_scope THEN after_event ELSE NULL END,retry_at=0,failure_streak=0,suspended=0,security_scope=excluded.security_scope,connection_version=excluded.connection_version`).run(input.registrationId,input.securityScope,input.connectionVersion);
    return {active:true};
  },options);
}
export function saveQualificationCache(conn: StorageConnection, input: Input<'saveQualificationCache'>, options?: CommitOptions): {saved:boolean} {
  check('saveQualificationCache',input);return syncTransaction(conn, db => {
    const snapshot = input.snapshot;
    if (!qualificationActive(db,input,snapshot.securityScope)) return {saved:false};
    if(get(db,'SELECT account_id FROM upload_registrations WHERE registration_id=?',input.registrationId)?.account_id!==snapshot.ownerId)fail('INVALID_INPUT');
    const old = get(db,'SELECT progress_revision FROM qualification_cache WHERE registration_ref=? AND game=?',input.registrationId,snapshot.game);
    if (old && compareQualificationCounter(snapshot.progressRevision,String(old.progress_revision)) < 0) return {saved:false};
    db.prepare(`INSERT INTO qualification_cache(registration_ref,game,security_scope,progress_revision,snapshot_json,fetched_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(registration_ref,game) DO UPDATE SET security_scope=excluded.security_scope,progress_revision=excluded.progress_revision,snapshot_json=excluded.snapshot_json,fetched_at=excluded.fetched_at`)
      .run(input.registrationId,snapshot.game,snapshot.securityScope,snapshot.progressRevision,canonicalUpload(snapshot),input.fetchedUtcMs);
    return {saved:true};
  },options);
}
function sourceOf(db: Database.Database, registration: string, event: string): Row | undefined {
  return get(db,`SELECT e.*,b.game,b.plugin_session_uuid,b.trip_uuid FROM upload_envelopes e JOIN upload_source_bindings b ON b.root_ref=e.root_ref
    WHERE e.registration_ref=? AND b.registration_ref=? AND e.event_id=?`,registration,registration,event);
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function decoded(value:unknown):QualificationResult {const result:unknown=JSON.parse(String(value));if(!isQualificationWire('Result',result))fail('DATABASE_CORRUPT');return result;}
function eventHead(db:Database.Database,registration:string,scope:string,event:string):Row|undefined {
  return get(db,`SELECT h.*,v.snapshot_json FROM qualification_result_heads h JOIN qualification_result_versions v USING(registration_ref,event_ref,security_scope,view_key)
    WHERE h.kind='event' AND h.registration_ref=? AND h.security_scope=? AND h.event_ref=?`,registration,scope,event);
}
function transported(row:Row):QualificationResult {
  const result={...decoded(row.snapshot_json),version:String(row.server_version),resultRevision:String(row.result_revision)};
  if(!isQualificationWire('Result',result))fail('DATABASE_CORRUPT');return result;
}
function headGeneration(row:Row|undefined):string {const value=row?.generation??'0';if(!isQualificationCounter(value))fail('DATABASE_CORRUPT');return value;}
function advanceRoot(db:Database.Database,registration:string,scope:string,local:Row,result:QualificationResult,viewKey:string,assessmentKey:string|null,assessment:string|null):void {
  const old=get(db,"SELECT * FROM qualification_result_heads WHERE kind='root' AND registration_ref=? AND security_scope=? AND root_ref=?",registration,scope,local.root_ref);
  if(old&&(Number(old.source_revision)>result.requestedRevision||Number(old.source_revision)===result.requestedRevision&&compareQualificationCounter(String(old.result_revision),result.resultRevision)>0))return;
  let latestEvent=old?.latest_event_ref??null,latestView=old?.latest_view_key??null,latestKey=old?.latest_assessment_key??null;
  let previousEvent=old?.previous_event_ref??null,previousView=old?.previous_view_key??null,previousKey=old?.previous_assessment_key??null;
  if(assessmentKey){
    for(const pointer of [{event:latestEvent,view:latestView,key:latestKey},{event:previousEvent,view:previousView,key:previousKey}])if(pointer.key===assessmentKey){
      const retained=get(db,'SELECT snapshot_json FROM qualification_result_versions WHERE registration_ref=? AND event_ref=? AND security_scope=? AND view_key=?',registration,pointer.event,scope,pointer.view);
      if(!retained||qualificationAssessmentJson(decoded(retained.snapshot_json))!==assessment)fail('INVALID_INPUT');
    }
    if(latestKey!==assessmentKey){previousEvent=latestEvent;previousView=latestView;previousKey=latestKey;}
    latestEvent=result.requestedEventId;latestView=viewKey;latestKey=assessmentKey;
  }
  db.prepare(`INSERT INTO qualification_result_heads(kind,registration_ref,event_ref,security_scope,view_key,root_ref,server_version,result_revision,generation,source_revision,latest_event_ref,latest_view_key,latest_assessment_key,previous_event_ref,previous_view_key,previous_assessment_key)
    VALUES('root',?,?,?,?,?,?,?,'0',?,?,?,?,?,?,?) ON CONFLICT(registration_ref,security_scope,root_ref) WHERE kind='root' DO UPDATE SET
    event_ref=excluded.event_ref,view_key=excluded.view_key,server_version=excluded.server_version,result_revision=excluded.result_revision,source_revision=excluded.source_revision,
    latest_event_ref=excluded.latest_event_ref,latest_view_key=excluded.latest_view_key,latest_assessment_key=excluded.latest_assessment_key,
    previous_event_ref=excluded.previous_event_ref,previous_view_key=excluded.previous_view_key,previous_assessment_key=excluded.previous_assessment_key`)
    .run(registration,result.requestedEventId,scope,viewKey,local.root_ref,result.version,result.resultRevision,result.requestedRevision,latestEvent,latestView,latestKey,previousEvent,previousView,previousKey);
}
export function pageQualificationSources(conn: StorageConnection, input: Input<'pageQualificationSources'>): {items:QualificationLocalSource[];next:string|null} {
  check('pageQualificationSources',input);const db=conn.reader();return db.transaction(() => {
    if (!qualificationActive(db,input,input.securityScope)) return {items:[],next:null};
    const rows = db.prepare(`SELECT e.event_id FROM upload_envelopes e JOIN upload_source_bindings b ON b.root_ref=e.root_ref
      WHERE e.registration_ref=? AND b.registration_ref=? AND e.revision=b.http_revision AND e.event_id>? ORDER BY e.event_id LIMIT ?`).all(input.registrationId,input.registrationId,input.afterEvent??'',input.limit) as Row[];
    const items = rows.map(row => {
      const local=sourceOf(db,input.registrationId,String(row.event_id))!;
      const head=eventHead(db,input.registrationId,input.securityScope,String(row.event_id)),result=head?transported(head):null;
      return {request:{source:{provider:'ets2telemetry' as const,game:local.game as 'ets2'|'ats',pluginSessionId:String(local.plugin_session_uuid),tripId:String(local.trip_uuid)},eventId:String(row.event_id),revision:Number(local.revision),...(result?{ifVersion:result.version}:{})},generation:headGeneration(head),localMaterialDigest:String(local.payload_digest),result};
    });
    return {items,next:rows.length===input.limit?String(rows.at(-1)!.event_id):null};
  })();
}
export function commitQualificationResults(conn: StorageConnection, input: Input<'commitQualificationResults'>, options?: CommitOptions): {saved:number;missingBase:string[]} {
  check('commitQualificationResults',input);
  // Prepare incoming serialization and hashes before opening the writer transaction; authority is rechecked below.
  const prepared=input.batch.items.map(result=>{const content=qualificationStoredViewJson(result),assessment=qualificationAssessmentJson(result);return {result,content,assessment,domain:qualificationDecisionJson(result),viewKey:digest(content),assessmentKey:assessment===null?null:digest(assessment),snapshotJson:canonicalUpload({...result,unchanged:false})};});
  return syncTransaction(conn, db => {
    if (!qualificationActive(db,input,input.securityScope)) return {saved:0,missingBase:[]};
    if (!qualificationResultBatchMatches(input.batch,input.request) || input.batch.securityScope!==input.securityScope || input.expectedHeads.length!==input.request.items.length || new Set(input.expectedHeads.map(item=>item.eventId)).size!==input.request.items.length) fail('INVALID_INPUT');
    let saved=0;const missingBase:string[]=[];
    for (const {result,content,domain,viewKey,assessment,assessmentKey,snapshotJson} of prepared) {
      const request=input.request.items.find(item=>item.eventId===result.requestedEventId);
      if (!request || !qualificationResultMatches(result,request)) fail('INVALID_INPUT');
      const local=sourceOf(db,input.registrationId,request.eventId);
      if (!local || local.game!==request.source.game || local.plugin_session_uuid!==request.source.pluginSessionId || local.trip_uuid!==request.source.tripId || Number(local.revision)!==request.revision) fail('INVALID_INPUT');
      const expected=input.expectedHeads.find(item=>item.eventId===request.eventId);if(!expected)fail('INVALID_INPUT');
      const head=eventHead(db,input.registrationId,input.securityScope,request.eventId),old=head?transported(head):null;
      if (result.unchanged) {
        if (!old || old.version!==result.version || old.resultRevision!==result.resultRevision) missingBase.push(request.eventId);
        else if(qualificationDecisionJson({...result,assessment:null,credit:null})!==qualificationDecisionJson({...old,assessment:null,credit:null}))fail('INVALID_INPUT');
        continue;
      }
      if(old&&compareQualificationCounter(result.resultRevision,old.resultRevision)<0)fail('INVALID_INPUT');
      if(old&&result.resultRevision===old.resultRevision&&domain!==qualificationDecisionJson(old))fail('INVALID_INPUT');
      if(old&&result.version===old.version){if(result.resultRevision!==old.resultRevision||content!==qualificationStoredViewJson(old))fail('INVALID_INPUT');continue;}
      if(expected.generation!==headGeneration(head)||request.ifVersion!==old?.version)fail('INVALID_INPUT');
      const known=get(db,"SELECT snapshot_json FROM qualification_result_versions WHERE registration_ref=? AND event_ref=? AND security_scope=? AND json_extract(snapshot_json,'$.version')=?",input.registrationId,request.eventId,input.securityScope,result.version);
      if(known){const value=decoded(known.snapshot_json);if(value.resultRevision!==result.resultRevision||qualificationStoredViewJson(value)!==content)fail('INVALID_INPUT');}
      const retained=get(db,'SELECT snapshot_json,local_material_digest FROM qualification_result_versions WHERE registration_ref=? AND event_ref=? AND security_scope=? AND view_key=?',input.registrationId,request.eventId,input.securityScope,viewKey);
      if(retained){if(retained.local_material_digest!==local.payload_digest||qualificationStoredViewJson(decoded(retained.snapshot_json))!==content)fail('INVALID_INPUT');}
      else db.prepare(`INSERT INTO qualification_result_versions(registration_ref,event_ref,security_scope,view_key,assessment_key,source_revision,local_material_digest,snapshot_json,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(input.registrationId,request.eventId,input.securityScope,viewKey,assessmentKey,request.revision,local.payload_digest,snapshotJson,input.fetchedUtcMs);
      const generation=(BigInt(headGeneration(head))+1n).toString();if(!isQualificationCounter(generation))fail('INVALID_INPUT');
      db.prepare(`INSERT INTO qualification_result_heads(kind,registration_ref,event_ref,security_scope,view_key,server_version,result_revision,generation,source_revision) VALUES('event',?,?,?,?,?,?,?,?)
        ON CONFLICT(registration_ref,security_scope,event_ref) WHERE kind='event' DO UPDATE SET view_key=excluded.view_key,server_version=excluded.server_version,result_revision=excluded.result_revision,generation=excluded.generation`)
        .run(input.registrationId,request.eventId,input.securityScope,viewKey,result.version,result.resultRevision,generation,request.revision);
      advanceRoot(db,input.registrationId,input.securityScope,local,result,viewKey,assessmentKey,assessment);saved++;
    }
    return {saved,missingBase};
  },options);
}
export function saveQualificationRefresh(conn: StorageConnection, input: Input<'saveQualificationRefresh'>, options?: CommitOptions): {saved:boolean} {
  check('saveQualificationRefresh',input);return syncTransaction(conn,db=>{
    if (!qualificationActive(db,input,input.securityScope)) return {saved:false};
    db.prepare('UPDATE qualification_refresh_state SET connection_version=?,after_event=?,retry_at=?,failure_streak=?,suspended=? WHERE registration_ref=? AND security_scope=?')
      .run(input.connectionVersion,input.refresh.afterEvent,input.refresh.retryAtMs,input.refresh.failureStreak,input.refresh.suspended?1:0,input.registrationId,input.securityScope);return {saved:true};
  },options);
}
