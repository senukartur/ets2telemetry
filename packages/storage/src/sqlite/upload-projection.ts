import {beyondRuleTerminal,JOINED_RULE_VERSION,RULE_LOSSES,ruleEventType,ruleLossBounds,ruleNativeBounds,type JoinedRuleFence} from './trailer-baselines';
import {confirmRuleTrailer,finishRuleReplay,isRuleBaseline,isRuleItems,isRulePrefixProof,isRuleReplay,replayRuleEvent,RULE_REPLAY_VERSION,unresolvedRulePrefix,type RuleContext,type RuleReplay,type RuleTrailer} from '../upload-rule-context';
import type {EventOccurrence, EventRecord} from '../../../contracts/src/protocol-v1';
import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {Available, Money} from '../../../contracts/src/protocol-v1';
import {fromAvailability, fromU64Key, toReal, toSafeNumber, u64Key} from '../codec';
import {fail} from '../errors';
import {MAX_UPLOAD_PROJECTION_PINS,isUploadPageQuery, isUploadProjection, isUploadProjectionPage, isUploadUuid, isUploadProjectionBegin, uploadSnapshotParts,
  type QualifiedOccurrence, type UploadConfiguration, type UploadFacts, type UploadInterval, type UploadMember,
  type UploadProjection, type UploadProjectionBegin, type UploadProjectionPreparation, type UploadProjectionPage, type UploadProjectionPageQuery, type UploadReadiness, type UploadVersions} from '../upload-projection';
import type {StorageConnection} from './connection';
import {jobValues} from './journal';
import {snapshot, type LogicalSnapshot} from './logical-snapshot';
import {ACCOUNTING_PATH, admittedProfile, decisionsEnabled, encodeRow, decodeRow, type LogicalRow} from './logical-trips';
import {deriveTripHardModeResult} from '../../../telemetry-core/src/hard-mode';
import type {ProfileObservation} from '../../../telemetry-core/src/trips/continuation';
import {jobKey} from '../../../telemetry-core/src/trips/identity';
import {decisionState, identityPending, rootBound} from './identity-pending';
import {validAcceptanceDetail} from './logical-coverage';
import {quantitiesIncomplete, uploadAccounting} from './quantities';
import {tripEnergyPowertrain} from './truck-energy';

const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as LogicalRow | undefined;
const all = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as LogicalRow[];
const required = (row: LogicalRow | undefined): LogicalRow => {if (!row) fail('DATABASE_CORRUPT'); return row;};
const n = (value: unknown) => toSafeNumber(value, Number.MAX_SAFE_INTEGER, 0);
const av = (row: LogicalRow, column: string): Available<number> => fromAvailability(row[column],row[`${column}_state`],toReal);
const text = (row: LogicalRow, column: string): Available<string> => fromAvailability(row[column],row[`${column}_state`],String);
function current(db: Database.Database, requested: string): {root: string; readiness: UploadReadiness} {
  const member = get(db, `SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?`,requested);
  if (!member) fail('UNKNOWN_TRIP');
  const root = required(get(db, `SELECT t.trip_uuid,t.outcome,l.retired,m.logical_ref,m.proof_json FROM logical_trips l
    JOIN trips t ON t.id=l.id JOIN logical_memberships m ON m.trip_ref=l.id WHERE l.id=?`,member.logical_ref));
  // An abandoned singleton is retired too. Self-membership must be established before considering retirement/proof.
  if (root.logical_ref !== member.logical_ref) fail('DATABASE_CORRUPT');
  return {root: String(root.trip_uuid), readiness: identityPending(root, decisionState(db, member.logical_ref), rootBound(db, member.logical_ref)) ? 'identity-pending' : 'ready'};
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
function facts(db: Database.Database, snap: LogicalSnapshot, pin: LogicalRow): UploadFacts {
  const row = snap.row, root = required(get(db,'SELECT trip_uuid FROM trips WHERE id=?',snap.logical));
  const openingSession = required(get(db,'SELECT plugin_session_uuid FROM plugin_sessions WHERE id=?',row.plugin_session_ref));
  const job = required(get(db,'SELECT * FROM job_configurations WHERE id=?',row.job_configuration_ref));
  const outcomeRaw = pin.outcome_trip_ref === null ? undefined : required(get(db,'SELECT trip_uuid FROM trips WHERE id=?',pin.outcome_trip_ref));
  if (row.outcome_event_ref !== null && !outcomeRaw) fail('DATABASE_CORRUPT');
  const outcome = occurrence(db,row.outcome_event_ref,String(outcomeRaw?.trip_uuid ?? root.trip_uuid),snap);
  const event = row.outcome_event_ref === null ? undefined : required(get(db,'SELECT payload_json FROM events WHERE id=?',row.outcome_event_ref));
  const record = event ? (JSON.parse(String(event.payload_json)) as {record: Record<string, unknown>}).record : {};
  const money = (key: string): Available<Money> => (record[key] ?? {available:false,reason:'not-observed'}) as Available<Money>;
  let close: QualifiedOccurrence | null = null;
  if (row.outcome !== 'open' && row.closed_by_session_ref !== null && row.closed_by_event_seq !== null) {
    // Closed raw rows cannot close again. Membership and carrier equality select the member of this revision,
    // independently of a gameplay outcome or the mutable current logical head.
    const closed = required(get(db,'SELECT id,trip_uuid FROM trips WHERE id=?',pin.close_trip_ref));
    const observation = get(db,'SELECT 1 FROM observation_closes WHERE trip_ref=?',closed.id);
    const carrier = observation ? undefined : get(db,'SELECT id FROM events WHERE plugin_session_id=? AND event_seq=? AND id<=?',row.closed_by_session_ref,row.closed_by_event_seq,snap.events);
    // A checkpoint/gap carrier is not an observed event. Its label must not become actual terminal time.
    if (carrier) close = occurrence(db,carrier.id,String(closed.trip_uuid),snap);
  }
  const measure = <U extends string>(key: string, unit: U) => ({...av(row,key),unit});
  const unknown = {available:false,reason:'not-observed'} as const;
  const mode = row.game_mode === 'convoy' ? 'unknown' : row.game_mode;
  const opening = occurrence(db,row.opened_event_ref,String(root.trip_uuid),snap);
  const game = row.game as 'ets2' | 'ats';
  const diesel = tripEnergyPowertrain(db, game, row.truck_configuration_ref, snap.head, snap.logical, row.opened_event_ref, snap.events) === 'diesel';
  const accounting = uploadAccounting(db, snap.head);
  return {game, pluginSessionId: String(openingSession.plugin_session_uuid), outcome: row.outcome as UploadFacts['outcome'],
    closeReason: row.close_reason as UploadFacts['closeReason'], recordingCompleteness: row.recording_completeness as UploadFacts['recordingCompleteness'],
    openedBy: row.opened_by as 'event'|'checkpoint', checkpointNextEventSeq: job.source === 'checkpoint' ? fromU64Key(job.checkpoint_next_event_seq) : null,
    checkpointUtcMs: job.source === 'checkpoint' ? n(row.started_utc_ms) : null, opening, outcomeOccurrence: outcome, close,
    gameMode: {mode,method:mode==='unknown'?'none':row.game_mode_method,confidence:mode==='unknown'?'none':row.game_mode_confidence,ambiguous:row.game_mode_ambiguous===1n} as UploadFacts['gameMode'],
    job: jobValues(job), observedDistance: measure('observed_distance_m','m'), fuelUsed: diesel ? measure('fuel_used_l','L') : {...unknown,unit:'L'},
    deliveredDistance: (record.distance ?? {...unknown,unit:'m'}) as UploadFacts['deliveredDistance'], cargoDamage: (record.cargoDamage ?? {...unknown,unit:'fraction'}) as UploadFacts['cargoDamage'],
    revenue: money('revenue'), penalty: money('penalty'), moneyIncomplete: row._moneyIncomplete === true || snap.head !== null
      && !!get(db,`${ACCOUNTING_PATH} SELECT 1 FROM path WHERE cut_odometer_m IS NOT NULL OR depth=256 AND prefix_ref IS NOT NULL LIMIT 1`,{head:snap.head}) || quantitiesIncomplete(db,snap.head),
    clockAnomaly: opening?.utcMs !== null && opening?.utcMs !== undefined && opening.utcMs !== n(row.started_utc_ms)
      || outcome?.utcMs !== null && outcome?.utcMs !== undefined && row.ended_utc_ms !== null && outcome.utcMs !== n(row.ended_utc_ms),
    hardModeResult: deriveTripHardModeResult(row.is_hard_mode === 1n), accounting: {...accounting, fuel: diesel ? accounting.fuel : 'unknown'}};
}

const unproven=(recordingLoss=false):RuleContext=>({version:2,status:'unproven',items:[],recordingLoss});
const maxId=(db:Database.Database,table:string)=>(get(db,`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`)?.id??0n) as bigint;
function ruleOpening(db:Database.Database,ref:unknown):LogicalRow|undefined {
  return get(db,'SELECT e.*,c.clock_uuid,c.plugin_session_ref AS clock_session,c.kind AS clock_kind FROM events e JOIN clocks c ON c.id=e.source_clock_ref WHERE e.id=?',ref);
}
function startRuleReplay(opening:LogicalRow,end:string,original:boolean,prefixUnproven:boolean):RuleReplay {
  const sequence=fromU64Key(opening.event_seq);
  return {version:RULE_REPLAY_VERSION,phase:original?'baseline':'events',baselineBeforeSeq:original?(BigInt(sequence)+1n).toString():'0',baselineBeforeId:'0',
    lossKind:0,lossAfter:'0',eventAfter:'0',gapAfterSeq:'0',gapAfterId:'0',next:original?'0':'1',end,opening:sequence,
    clock:String(opening.clock_uuid),openingNs:fromU64Key(opening.occurred_monotonic_ns),openingOrder:fromU64Key(opening.boundary_order),
    items:[],opened:false,changed:false,unproven:prefixUnproven,recordingLoss:false,initializing:false,recovering:false,leadConfiguration:'0'};
}
interface JoinedReplay {
  after:bigint; scope:string|null; items:RuleTrailer[]; comparison:RuleTrailer[];
  source?:{member:bigint;session:bigint;replay:RuleReplay;confirmed:number;pastPin:boolean;prefixAfter:bigint|null;tail:RuleTail;
    jobKey:string;jobCleared:boolean;loadWindow:'before-start'|'after-start'|null};
}
interface RuleTail {eventSeq:string;gapSeq:string}
interface JoinedRule extends JoinedRuleFence {
  events:bigint;gaps:bigint;intervals:bigint;lastTail:RuleTail;replay?:JoinedReplay;
}
function ruleTail(db:Database.Database,session:unknown):RuleTail {
  const event=get(db,'SELECT event_seq FROM events WHERE plugin_session_id=? ORDER BY event_seq DESC LIMIT 1',session)?.event_seq;
  const gap=get(db,'SELECT first_event_seq FROM event_gaps WHERE plugin_session_ref=? ORDER BY first_event_seq DESC,id DESC LIMIT 1',session)?.first_event_seq;
  return {eventSeq:typeof event==='string'?event:u64Key('0'),gapSeq:typeof gap==='string'?gap:u64Key('0')};
}
const qualified=(event:LogicalRow|undefined,session:unknown,bound:bigint):event is LogicalRow =>
  !!event&&(event.id as bigint)<=bound&&event.plugin_session_id===session&&event.clock_session===session&&event.clock_kind==='source-monotonic'
  &&event.occurred_monotonic_ns_state==='available';

function startJoinedSource(db:Database.Database,replay:JoinedReplay,joined:JoinedRule,snap:LogicalSnapshot,saved:LogicalRow,member:bigint):JoinedReplay['source'] {
  const raw=required(get(db,'SELECT * FROM trips WHERE id=?',member)),session=raw.plugin_session_ref as bigint;
  const src=required(get(db,'SELECT * FROM plugin_sessions WHERE id=?',session));
  const membership=required(get(db,'SELECT * FROM logical_memberships WHERE trip_ref=?',member));
  const opening=ruleOpening(db,raw.opened_event_ref);
  if(src.origin!=='game'||src.game!==joined.game||raw.game!==joined.game||src.gameplay_events!=='registered'
    ||raw.opened_by!=='event'||!qualified(opening,session,joined.events)||opening.type!=='job.configured'
    ||get(db,'SELECT event_ref FROM job_configurations WHERE id=?',raw.job_configuration_ref)?.event_ref!==opening.id
    ||membership.logical_ref!==snap.logical||typeof membership.proof_json!=='string')return;
  const proof=admittedProfile(JSON.parse(membership.proof_json) as ProfileObservation,
    {game:joined.game,pluginSessionId:String(src.plugin_session_uuid),processInstanceId:String(src.process_instance_uuid)},
    String(opening.clock_uuid),'18446744073709551615');
  if(!proof)return;
  if(replay.after===0n){
    if(member!==snap.logical)return;
    replay.scope=proof.scope;
  }else{
    if(!decisionsEnabled(db)||proof.scope!==replay.scope)return;
    const decision=get(db,'SELECT * FROM logical_membership_decisions WHERE trip_ref=?',member);
    if(decision?.state!=='joined'||decision.reason!=='matched'||decision.target_logical_ref!==snap.logical
      ||decision.game!==joined.game||decision.plugin_session_ref!==session||typeof decision.decided_revision!=='bigint'
      ||decision.decided_revision>=snap.revision)return;
    const prior=required(get(db,'SELECT * FROM trips WHERE id=?',replay.after));
    const predecessor=required(get(db,'SELECT process_instance_uuid FROM plugin_sessions WHERE id=?',prior.plugin_session_ref));
    if(prior.plugin_session_ref===session||predecessor.process_instance_uuid===src.process_instance_uuid||prior.outcome!=='none'
      ||prior.close_reason!=='restart'||prior.outcome_event_ref!==null||prior.closed_by_session_ref!==session||prior.closed_by_event_seq===null
      ||get(db,'SELECT 1 FROM observation_closes WHERE trip_ref=?',prior.id))return;
    const carrierRef=get(db,'SELECT id FROM events WHERE plugin_session_id=? AND event_seq=?',session,prior.closed_by_event_seq)?.id;
    const carrier=ruleOpening(db,carrierRef??null);
    if(!qualified(carrier,session,joined.events)||carrier.clock_uuid!==opening.clock_uuid
      ||String(carrier.event_seq)>String(opening.event_seq)||String(carrier.occurred_monotonic_ns)>String(opening.occurred_monotonic_ns))return;
  }
  const final=String(member)===joined.lastMember;
  const end=final&&joined.terminalSeq!==null?fromU64Key(joined.terminalSeq)
    :final?String(saved.nativeCoverage):fromU64Key(src.committed_through_event_seq);
  if(BigInt(end)<BigInt(fromU64Key(opening.event_seq))||final&&joined.terminalSeq!==null&&joined.terminalClock!==String(opening.source_clock_ref)
    ||final&&snap.row.outcome!=='open'&&joined.terminalSeq===null)return;
  // An engine may retain a declared missing suffix even when its last visible event is contiguous.
  const missingEnd=!(final&&joined.terminalSeq!==null)&&typeof src.end_next_event_seq==='string'&&BigInt(src.end_next_event_seq)>BigInt(end)+1n;
  const openingJob=(JSON.parse(String(opening.payload_json)) as {record:Extract<EventRecord,{type:'job.configured'}>}).record;
  return {member,session,replay:startRuleReplay(opening,end,replay.after===0n,missingEnd),confirmed:0,pastPin:false,prefixAfter:0n,
    tail:final?joined.lastTail:ruleTail(db,session),jobKey:jobKey(openingJob),jobCleared:false,
    loadWindow:opening.occurred_simulation==='paused'?'before-start':null};
}

function resumedPrefix(db:Database.Database,interval:LogicalRow,source:NonNullable<JoinedReplay['source']>,prior:bigint,joined:JoinedRule):boolean {
  const detail=interval.detail_json===null?{}:JSON.parse(interval.detail_json as string) as Record<string,unknown>;
  const cause=String(detail.cause);
  const sameSource=interval.plugin_session_ref===source.session,opening=detail.atEventSeq===source.replay.opening;
  if(cause==='restart'&&interval.kind==='discontinuity')return !(sameSource&&opening&&detail.decision==='not-merged'
    &&detail.continuationOf===required(get(db,'SELECT trip_uuid FROM trips WHERE id=?',prior)).trip_uuid);
  if(Object.hasOwn(detail,'decision')||Object.hasOwn(detail,'continuationOf'))return true;
  if(cause==='opened-at-load'&&interval.kind==='discontinuity'){
    if(!sameSource)return true;
    if(opening)return false;
    const at=typeof detail.atEventSeq==='string'?detail.atEventSeq.padStart(20,'0'):'';
    if(!/^[0-9]{20}$/.test(at)||at<=u64Key(source.replay.opening)||at>u64Key(source.replay.end))return true;
    const timer=get(db,"SELECT id FROM events WHERE plugin_session_id=? AND event_seq=? AND type='timers.restart' AND occurred_simulation='paused'",source.session,at);
    // Event replay separately rules out a reset after running starts.
    return !timer||(timer.id as bigint)>joined.events;
  }
  if(['late-attach','opened-before-attach'].includes(cause)&&interval.kind==='not-connected')return !(sameSource&&opening);
  if(cause==='menu-job-acceptance'&&interval.kind==='discontinuity')return !(sameSource&&opening&&detail.annotation===true);
  if(cause==='observed-acceptance'&&interval.kind==='discontinuity')
    return !(sameSource&&validAcceptanceDetail(detail)&&BigInt(detail.throughEventSeq as string)<BigInt(source.replay.opening));
  // A load that could not corroborate distance/time does not invalidate independent, gap-free trailer replay.
  if(['loaded-job-unverified','loaded-job-coverage-confirmed'].includes(cause)&&interval.kind==='discontinuity')
    return !(sameSource&&String(source.member)===joined.lastMember&&joined.terminalSeq!==null&&detail.atEventSeq===fromU64Key(joined.terminalSeq));
  return unresolvedRulePrefix(String(interval.kind),detail);
}

/** Walk copied raw member IDs in order, retaining just the original chain and the active source cursor. */
function advanceJoinedRuleContext(db:Database.Database,saved:LogicalRow,snap:LogicalSnapshot,pin:LogicalRow,joined:JoinedRule):RuleContext|null {
  const replay=joined.replay??={after:0n,scope:null,items:[],comparison:[]};
  if(!isRuleItems(replay.items)||!isRuleItems(replay.comparison))fail('DATABASE_CORRUPT');
  if(!replay.source){
    const next=get(db,'SELECT trip_ref FROM upload_projection_members WHERE pin_ref=? AND trip_ref>? ORDER BY trip_ref LIMIT 1',pin.pin_id,replay.after);
    if(!next)return String(replay.after)===joined.lastMember&&replay.items.length?{version:2,status:'proven',items:replay.items,recordingLoss:false}:unproven();
    replay.source=startJoinedSource(db,replay,joined,snap,saved,next.trip_ref as bigint);
    return replay.source?null:unproven();
  }
  const source=replay.source,state=source.replay,original=replay.after===0n;
  if(!isRuleReplay(state))fail('DATABASE_CORRUPT');
  if(source.prefixAfter!==null){
    const interval=get(db,'SELECT * FROM completeness_intervals WHERE trip_ref=? AND id>? AND id<=? ORDER BY id LIMIT 1',source.member,source.prefixAfter,joined.intervals);
    if(!interval)source.prefixAfter=null;
    else{
      source.prefixAfter=interval.id as bigint;
      if(beyondRuleTerminal(joined,interval.plugin_session_ref,interval.first_event_seq,interval.source_clock_ref,interval.start_monotonic_ns))return null;
      if(RULE_LOSSES.some(kind=>kind===interval.kind)&&interval.plugin_session_ref!==source.session){
        state.unproven=true;state.recordingLoss=true;
      }else if(original?unresolvedRulePrefix(String(interval.kind),interval.detail_json===null?null:JSON.parse(interval.detail_json as string))
        :resumedPrefix(db,interval,source,replay.after,joined))state.unproven=true;
    }
    return null;
  }
  const context=replayRuleSource(db,saved,state,source.session,{events:joined.events,gaps:joined.gaps,intervals:joined.intervals},
    source.member,String(source.member)===joined.lastMember&&joined.terminalSeq!==null,{joined,source,replay,original});
  if(!context)return null;
  if(context.status!=='proven')return context;
  if(original){replay.items=context.items;replay.comparison=context.items.map(item=>({...item}));}
  replay.after=source.member;delete replay.source;
  return null;
}

function checkJoinedJob(source:NonNullable<JoinedReplay['source']>,sequence:string,record:EventRecord,terminal:boolean,original:boolean):void {
  const state=source.replay,afterOpening=BigInt(sequence)>BigInt(state.opening);
  if(record.type==='job.configured'&&sequence!==state.opening&&(!original||afterOpening)
    &&(!state.opened||source.jobCleared||jobKey(record)!==source.jobKey))state.unproven=true;
  if(!original||afterOpening){
    if((record.type==='job.delivered'||record.type==='job.cancelled')&&(!terminal||sequence!==state.end))state.unproven=true;
    if(record.type==='job.cleared'&&state.opened)source.jobCleared=true;
  }
  if(!afterOpening)return;
  // The first start can still be followed by its load's regression, as in the recorder's startup window.
  if(source.loadWindow==='after-start'&&record.type!=='source.gameMode'&&record.type!=='gameTime.regression')source.loadWindow=null;
  if((record.type==='timers.restart'||record.type==='gameTime.regression')&&source.loadWindow===null)state.unproven=true;
  if(record.type==='simulation.started'&&source.loadWindow==='before-start')source.loadWindow='after-start';
}

/** One indexed input or transition per call, including rejected baselines, events and gaps. */
function advanceRuleContext(db:Database.Database,saved:LogicalRow,snap:LogicalSnapshot,pin:LogicalRow):RuleContext|null {
  if(saved.trailerBound===undefined||saved.ruleLossBounds===undefined||!isRulePrefixProof(saved.rulePrefix))return unproven(); // Retained preparations without baseline/prefix evidence cannot establish completeness.
  if(pin.member_count!==1n){
    const joined=saved.joinedRule as JoinedRule|undefined;
    return joined?.version===JOINED_RULE_VERSION?advanceJoinedRuleContext(db,saved,snap,pin,joined):unproven();
  }
  if(saved.ruleReplayVersion!==RULE_REPLAY_VERSION){
    // Resume preparations from older builds using the original pinned bounds and the current replay rules.
    delete saved.ruleReplay;
    saved.ruleReplayVersion=RULE_REPLAY_VERSION;
  }
  if(saved.ruleReplay!==undefined&&!isRuleReplay(saved.ruleReplay))fail('DATABASE_CORRUPT');
  if(!saved.ruleReplay){
    if(snap.row.opened_by!=='event'||snap.row.opened_event_ref===null)return unproven();
    const opening=required(ruleOpening(db,snap.row.opened_event_ref));
    if(opening.occurred_monotonic_ns_state!=='available')return unproven();
    const closed=snap.row.outcome!=='open';
    if(closed&&get(db,'SELECT 1 FROM observation_closes WHERE trip_ref=?',snap.logical))return unproven();
    if(closed&&!get(db,'SELECT id FROM events WHERE plugin_session_id=? AND event_seq=? AND id<=?',snap.row.closed_by_session_ref,snap.row.closed_by_event_seq,snap.events))return unproven();
    if(closed&&(snap.row.closed_by_session_ref!==snap.row.plugin_session_ref||snap.row.closed_by_event_seq===null))return unproven();
    saved.ruleReplay=startRuleReplay(opening,closed?fromU64Key(snap.row.closed_by_event_seq):String(saved.nativeCoverage),true,saved.rulePrefix.unproven);
  }
  return replayRuleSource(db,saved,saved.ruleReplay as RuleReplay,snap.row.plugin_session_ref,snap,snap.logical,snap.row.outcome!=='open');
}

function replayRuleSource(db:Database.Database,saved:LogicalRow,state:RuleReplay,session:unknown,bounds:{events:bigint;gaps:bigint;intervals:bigint},
  member:unknown,terminal:boolean,joined?:{joined:JoinedRule;source:NonNullable<JoinedReplay['source']>;replay:JoinedReplay;original:boolean}):RuleContext|null {
  if(state.phase==='baseline'){
    const b=get(db,`SELECT * FROM trailer_baselines WHERE plugin_session_ref=? AND next_event_seq<=?
      AND (next_event_seq,id)<(?,?) ORDER BY next_event_seq DESC,id DESC LIMIT 1`,session,u64Key(state.opening),u64Key(state.baselineBeforeSeq),BigInt(state.baselineBeforeId));
    if(!b)return unproven();
    state.baselineBeforeSeq=fromU64Key(b.next_event_seq);state.baselineBeforeId=String(b.id);
    if((b.id as bigint)>(saved.trailerBound as bigint)||b.source_clock_uuid!==state.clock||String(b.monotonic_ns)>u64Key(state.openingNs)||String(b.boundary_order)>=u64Key(state.openingOrder))return null;
    const body:unknown=JSON.parse(String(b.slots_json));
    if(!isRuleBaseline(body))fail('DATABASE_CORRUPT');
    if(body.slots.length!==10)return unproven();
    state.unproven ||=body.slots.some(slot=>!slot.available&&slot.reason!=='not-observed');
    state.items=body.slots.flatMap(slot=>slot.available?[slot.value]:[]);
    state.next=fromU64Key(b.next_event_seq);state.eventAfter=(BigInt(state.next)-1n).toString();state.phase='events';
    if(!isRuleReplay(state))fail('DATABASE_CORRUPT');
    return null;
  }
  if(state.phase==='events'){
    const e=get(db,`SELECT e.*,c.clock_uuid,c.plugin_session_ref AS clock_session,c.kind AS clock_kind FROM events e JOIN clocks c ON c.id=e.source_clock_ref
      WHERE e.plugin_session_id=? AND e.event_seq>? AND e.event_seq<=? ORDER BY e.event_seq LIMIT 1`,session,u64Key(state.eventAfter),u64Key(state.end));
    if(!e||!joined&&(e.id as bigint)>bounds.events){
      if(BigInt(state.next)<=BigInt(state.end))state.unproven=true;
      state.phase='suffix';if(!joined||terminal)state.phase='gaps';return null;
    }
    const sequence=fromU64Key(e.event_seq);
    const next=u64Key(state.next);
    if(joined&&(e.clock_session!==session||e.clock_kind!=='source-monotonic'))state.unproven=true;
    if(joined&&(e.id as bigint)>bounds.events){
      // Closed predecessor coverage may advance after pin begin. Only a contiguous suffix of routine events can be ignored.
      if(sequence!==state.next||state.clock!==e.clock_uuid||ruleEventType(String(e.type)))state.unproven=true;
      state.eventAfter=sequence;state.next=(BigInt(sequence)+1n).toString();joined.source.pastPin=true;
      return null;
    }
    if(joined?.source.pastPin)state.unproven=true;
    if((!joined||joined.original)&&next<String(e.event_seq)&&String(e.event_seq)<=u64Key(state.opening)){
      // Only documented pre-opening loss can be skipped. A missing row alone is incomplete evidence.
      // A durably stored gap must extend coverage. Check the nearest start and fail closed if it does not cover the hole.
      const gap=get(db,`SELECT id,last_event_seq FROM event_gaps WHERE plugin_session_ref=? AND first_event_seq<=?
        ORDER BY first_event_seq DESC,id DESC LIMIT 1`,session,next);
      if(gap&&(gap.id as bigint)<=bounds.gaps&&String(gap.last_event_seq)>=next){
        const afterGap=BigInt(fromU64Key(gap.last_event_seq))+1n;
        state.next=afterGap<BigInt(sequence)?String(afterGap):sequence;
        state.items=[];
        state.recovering=true;
        return null;
      }
    }
    const record=(JSON.parse(String(e.payload_json)) as {record:EventRecord}).record;
    if(!joined||joined.original)replayRuleEvent(state,sequence,record,String(e.clock_uuid),e.occurred_simulation as EventOccurrence['simulation']);
    else{
      if(sequence!==state.next||state.clock!==e.clock_uuid)state.unproven=true;
      state.eventAfter=sequence;state.next=(BigInt(sequence)+1n).toString();
      if(sequence===state.opening)state.opened=true;
      joined.source.confirmed=confirmRuleTrailer(state,joined.replay.comparison,joined.source.confirmed,record);
    }
    if(joined)checkJoinedJob(joined.source,sequence,record,terminal,joined.original);
    return null;
  }
  if(state.phase==='suffix'){
    const e=get(db,'SELECT id,event_seq FROM events WHERE plugin_session_id=? AND event_seq>? AND event_seq<=? ORDER BY event_seq LIMIT 1',
      session,u64Key(state.eventAfter),joined?.source.tail.eventSeq);
    if(!e){state.phase='gaps';return null;}
    state.eventAfter=fromU64Key(e.event_seq);
    if((e.id as bigint)<=bounds.events){state.unproven=true;state.phase='gaps';}
    return null;
  }
  if(state.phase==='gaps'){
    const gap=get(db,`SELECT id,first_event_seq,last_event_seq FROM event_gaps WHERE plugin_session_ref=? AND first_event_seq<=?
      AND (first_event_seq,id)>(?,?) ORDER BY first_event_seq,id LIMIT 1`,session,joined&&!terminal?joined.source.tail.gapSeq:u64Key(state.end),u64Key(state.gapAfterSeq),BigInt(state.gapAfterId));
    if(!gap){state.phase='losses';return null;}
    state.gapAfterSeq=fromU64Key(gap.first_event_seq);state.gapAfterId=String(gap.id);
    if((gap.id as bigint)<=bounds.gaps&&(joined&&!joined.original||String(gap.last_event_seq)>=u64Key(state.opening))){
      state.unproven=true;state.recordingLoss=true;
    }
    return null;
  }
  if(state.phase==='losses'){
    const kind=RULE_LOSSES[state.lossKind];
    if(!kind){
      state.phase='done';
      if(!joined||joined.original)return finishRuleReplay(state);
      if(state.changed)return {version:2,status:'changed',items:[],recordingLoss:state.recordingLoss};
      return state.unproven||!state.opened||joined.source.confirmed!==(1<<joined.replay.items.length)-1
        ?unproven(state.recordingLoss):{version:2,status:'proven',items:joined.replay.items,recordingLoss:false};
    }
    const sessionBounds=saved.ruleLossBounds as Record<string,string>;
    const interval=get(db,'SELECT * FROM completeness_intervals WHERE plugin_session_ref=? AND kind=? AND id>? AND id<=? ORDER BY id LIMIT 1',session,kind,BigInt(state.lossAfter),joined?bounds.intervals:BigInt(sessionBounds[kind]));
    if(!interval){state.lossKind++;state.lossAfter='0';return null;}
    state.lossAfter=String(interval.id);
    if(interval.trip_ref!==null&&interval.trip_ref!==member)return null;
    if(!joined&&interval.detail_json!==null&&(JSON.parse(interval.detail_json as string) as {annotation?:boolean}).annotation===true)return null;
    if(joined&&beyondRuleTerminal(joined.joined,session,interval.first_event_seq,interval.source_clock_ref,interval.start_monotonic_ns))return null;
    const last=interval.last_event_seq as string|null;
    if((!joined||joined.original)&&last!==null&&last<u64Key(state.opening)){
      if(last>=u64Key(state.baselineBeforeSeq)){
        state.recovering=true;
        if(u64Key(state.leadConfiguration)<=last)state.unproven=true;
      }
      return null;
    }
    if(terminal&&interval.first_event_seq!==null&&(interval.first_event_seq as string)>u64Key(state.end))return null;
    state.unproven=true;state.recordingLoss=true;return null;
  }
  return finishRuleReplay(state);
}
function coverageUnchanged(db:Database.Database,snap:LogicalSnapshot,saved:LogicalRow,strict=false):boolean {
  const joined=saved.joinedRule as JoinedRule|undefined,session=joined?BigInt(joined.lastSession):snap.row.plugin_session_ref;
  if(joined?.stale)return false;
  if((!joined||snap.row.outcome==='open')&&saved.ruleLossBounds!==undefined&&JSON.stringify(ruleLossBounds(db,session))!==JSON.stringify(saved.ruleLossBounds))return false;
  if(snap.row.outcome!=='open')return true;
  if(saved.ruleNativeBounds!==undefined&&JSON.stringify(ruleNativeBounds(db,session,!!joined))!==JSON.stringify(saved.ruleNativeBounds))return false;
  return !strict||saved.nativeCoverage===undefined
    ||fromU64Key(required(get(db,'SELECT committed_through_event_seq FROM plugin_sessions WHERE id=?',session)).committed_through_event_seq)===saved.nativeCoverage;
}

const generation = (db: Database.Database, root: unknown) => get(db,'SELECT generation FROM upload_projection_evidence_versions WHERE root_ref=?',root)?.generation ?? 0n;
const retained = (db: Database.Database, pinId: string) => {const pin=get(db,'SELECT * FROM upload_projection_pins WHERE pin_id=?',pinId);if(!pin)fail('INVALID_INPUT');return pin;};
function status(pin: LogicalRow): UploadProjectionPreparation {
  return {pinId:String(pin.pin_id),state:pin.state as UploadProjectionPreparation['state'],examined:n(pin.examined),
    projection:pin.state==='ready'?JSON.parse(String(pin.metadata_json)) as UploadProjection:null};
}
const checkPinId = (pinId: string) => {if (!isUploadUuid(pinId)) fail('INVALID_INPUT');};

function joinedRuleAtBegin(db:Database.Database,snap:LogicalSnapshot):JoinedRule|undefined {
  const group=required(get(db,'SELECT latest_trip_ref,member_count FROM logical_trips WHERE id=?',snap.logical));
  if(group.member_count===1n)return;
  const last=required(get(db,'SELECT * FROM trips WHERE id=?',group.latest_trip_ref)),session=last.plugin_session_ref;
  const events=maxId(db,'events'),gaps=maxId(db,'event_gaps'),intervals=maxId(db,'completeness_intervals');
  const carrier=snap.row.outcome==='open'||last.closed_by_session_ref!==session||last.closed_by_event_seq===null
    ||last.closed_by_event_seq!==snap.row.closed_by_event_seq||get(db,'SELECT 1 FROM observation_closes WHERE trip_ref=?',last.id)
    ?undefined:get(db,'SELECT id FROM events WHERE plugin_session_id=? AND event_seq=?',session,last.closed_by_event_seq);
  const candidate=ruleOpening(db,carrier?.id??null);
  const type=snap.row.outcome==='delivered'?'job.delivered':snap.row.outcome==='cancelled'?'job.cancelled':null;
  const terminal=qualified(candidate,session,snap.events)&&(type===null||candidate.type===type&&candidate.id===last.outcome_event_ref
    &&candidate.id===snap.row.outcome_event_ref)?candidate:null;
  return {version:JOINED_RULE_VERSION,game:String(snap.row.game),lastMember:String(last.id),lastSession:String(session),
    terminalSeq:terminal?String(terminal.event_seq):null,terminalClock:terminal?String(terminal.source_clock_ref):null,
    terminalNs:terminal?String(terminal.occurred_monotonic_ns):null,minSession:null,maxSession:null,membersCopied:false,stale:false,events,gaps,intervals,lastTail:ruleTail(db,session)};
}
const obsoleteJoinedRule=(db:Database.Database,pin:LogicalRow,saved:LogicalRow):boolean => saved.joinedRuleVersion!==JOINED_RULE_VERSION
  &&((pin.member_count as bigint)>1n||(get(db,'SELECT member_count FROM logical_trips WHERE id=?',pin.root_ref)?.member_count as bigint)>1n);
export function uploadRuleWorkStatus(db:Database.Database,pinId:string):'current'|'obsolete-replay'|'stale-replay' {
  const pin=retained(db,pinId),saved=decodeRow(pin.snapshot_json);
  if(obsoleteJoinedRule(db,pin,saved)||pin.state==='ready'&&saved.ruleReplayVersion!==RULE_REPLAY_VERSION)return 'obsolete-replay';
  return (saved.joinedRule as JoinedRule|undefined)?.stale?'stale-replay':'current';
}

export function beginUploadProjection(conn: StorageConnection, input: UploadProjectionBegin): UploadProjectionPreparation {
  if (!isUploadProjectionBegin(input)) fail('INVALID_INPUT');
  const db=conn.writer();
  return db.transaction(() => {
    const prior=get(db,'SELECT * FROM upload_projection_pins WHERE pin_id=?',input.pinId);
    if(prior){if(prior.requested_trip_uuid!==input.tripUuid)fail('INVALID_INPUT');return status(prior);}
    // The header limit also includes invalidated and partially released preparations.
    if(all(db,'SELECT pin_id FROM upload_projection_pins LIMIT ?',MAX_UPLOAD_PROJECTION_PINS).length===MAX_UPLOAD_PROJECTION_PINS)fail('STORAGE_BUSY');
    const state=current(db,input.tripUuid);
    const root=required(get(db,'SELECT id FROM trips WHERE trip_uuid=?',state.root));
    // Never invoke the Journal's legacy revision repair in a preparation turn.
    if(!get(db,'SELECT id FROM logical_revisions WHERE logical_ref=? ORDER BY id DESC LIMIT 1',root.id))fail('INVALID_INPUT');
    const snap=snapshot(db,state.root),info=required(get(db,'SELECT database_uuid,purpose FROM database_info WHERE id=1'));
    const joinedRule=joinedRuleAtBegin(db,snap),session=joinedRule?BigInt(joinedRule.lastSession):snap.row.plugin_session_ref;
    const incarnation=randomUUID();
    const initial={requestedTripUuid:input.tripUuid,rootTripUuid:state.root,readiness:state.root===input.tripUuid?state.readiness:'redirected',rootReadiness:state.readiness,
      snapshot:`u2:${String(info.database_uuid)}:${input.pinId}:${incarnation}:${state.root}:${snap.revision}`,databaseUuid:String(info.database_uuid),purpose:info.purpose,revision:String(snap.revision),
      bounds:{members:String(snap.members),events:String(snap.events),gaps:String(snap.gaps),samples:String(snap.samples),intervals:String(snap.intervals),accountingHead:snap.head===null?null:String(snap.head)}};
    db.prepare(`INSERT INTO upload_projection_pins(pin_id,incarnation_uuid,requested_trip_uuid,root_ref,revision_ref,evidence_generation,state,phase,snapshot_json)
      VALUES(?,?,?,?,?,?,'preparing','current',?)`).run(input.pinId,incarnation,input.tripUuid,snap.logical,snap.revision,generation(db,snap.logical),encodeRow({snap,initial,rulePrefix:{version:1,unproven:false},
        trailerBound:maxId(db,'trailer_baselines'),joinedRuleVersion:JOINED_RULE_VERSION,joinedRule,
        ruleNativeBounds:ruleNativeBounds(db,session,!!joinedRule),ruleLossBounds:ruleLossBounds(db,session),ruleReplayVersion:RULE_REPLAY_VERSION,
        nativeCoverage:fromU64Key(required(get(db,'SELECT committed_through_event_seq FROM plugin_sessions WHERE id=?',session)).committed_through_event_seq)}));
    return status(retained(db,input.pinId));
  })();
}
export function getUploadProjectionPreparation(conn: StorageConnection, pinId: string): UploadProjectionPreparation {
  checkPinId(pinId);const pin=get(conn.reader(),'SELECT * FROM upload_projection_pins WHERE pin_id=?',pinId);
  if(!pin)fail('INVALID_INPUT');return status(pin);
}

/** Each iteration consumes one input row or an empty-stream/phase transition, including rejected inputs. */
export function advanceUploadProjection(conn: StorageConnection, pinId: string, hooks?: {beforeCommit?: () => void}): UploadProjectionPreparation {
  checkPinId(pinId);const db=conn.writer();
  return db.transaction(() => {
    const pin=retained(db,pinId);
    if(pin.state!=='preparing')return status(pin);
    const saved=decodeRow(pin.snapshot_json),snap=saved.snap as LogicalSnapshot,joined=saved.joinedRule as JoinedRule|undefined;
    if(saved.rulePrefix!==undefined&&!isRulePrefixProof(saved.rulePrefix))fail('DATABASE_CORRUPT');
    let examined=0;
    if(obsoleteJoinedRule(db,pin,saved)||generation(db,pin.root_ref)!==pin.evidence_generation||!coverageUnchanged(db,snap,saved))pin.state='invalidated';
    while(pin.state==='preparing' && examined<100){
      examined++;
      if(pin.phase==='current'||pin.phase==='previous'){
        const previous=pin.phase==='previous',column=previous?'previous_logical_ref':'logical_ref';
        const m=get(db,`SELECT trip_ref,joined_after_revision FROM logical_memberships WHERE ${column}=? AND trip_ref>? AND trip_ref<=? ORDER BY trip_ref LIMIT 1`,pin.root_ref,pin.member_after,snap.members);
        if(!m){
          if(previous&&joined)joined.membersCopied=true;
          pin.phase=previous?'configurations':'previous';pin.member_after=0n;continue;
        }
        pin.member_after=m.trip_ref;
        const joinedAfter=m.joined_after_revision as bigint|null;
        if(previous ? joinedAfter===null || joinedAfter<snap.revision : (joinedAfter??0n)>=snap.revision)continue;
        const t=required(get(db,'SELECT * FROM trips WHERE id=?',m.trip_ref));
        const session=required(get(db,'SELECT * FROM plugin_sessions WHERE id=?',t.plugin_session_ref));
        if(joined){
          const ref=t.plugin_session_ref as bigint;
          if(joined.minSession===null||ref<BigInt(joined.minSession))joined.minSession=String(ref);
          if(joined.maxSession===null||ref>BigInt(joined.maxSession))joined.maxSession=String(ref);
        }
        const row:UploadMember={id:String(t.id),rawTripUuid:String(t.trip_uuid),pluginSessionId:String(session.plugin_session_uuid),game:session.game as UploadMember['game'],origin:session.origin as UploadMember['origin'],versions:versions(session)};
        const inserted=db.prepare('INSERT OR IGNORE INTO upload_projection_members VALUES(?,?,?)').run(pinId,t.id,JSON.stringify(row));
        pin.member_count=BigInt(String(pin.member_count))+BigInt(inserted.changes);
        if(t.outcome_event_ref!==null && t.outcome_event_ref===snap.row.outcome_event_ref && (pin.outcome_trip_ref===null || (t.id as bigint)<(pin.outcome_trip_ref as bigint)))pin.outcome_trip_ref=t.id;
        if(snap.row.outcome!=='open' && t.closed_by_session_ref!==null && t.closed_by_session_ref===snap.row.closed_by_session_ref && t.closed_by_event_seq===snap.row.closed_by_event_seq
          && (pin.close_trip_ref===null || (t.id as bigint)>(pin.close_trip_ref as bigint)))pin.close_trip_ref=t.id;
      }else if(pin.phase==='configurations'||pin.phase==='intervals'){
        // source_after retains the active copied member; member_after is the last completed member.
        if(pin.source_after===0n){
          const member=get(db,'SELECT trip_ref FROM upload_projection_members WHERE pin_ref=? AND trip_ref>? ORDER BY trip_ref LIMIT 1',pinId,pin.member_after);
          if(!member){pin.phase=pin.phase==='configurations'?'intervals':'finalize';pin.member_after=0n;pin.item_after=0n;continue;}
          pin.source_after=member.trip_ref;pin.item_after=0n;continue;
        }
        const member=required(get(db,'SELECT trip_uuid,plugin_session_ref FROM trips WHERE id=?',pin.source_after));
        if(pin.phase==='configurations'){
          const link=get(db,'SELECT trailer_configuration_ref FROM trip_trailers WHERE trip_ref=? AND trailer_configuration_ref>? ORDER BY trailer_configuration_ref LIMIT 1',pin.source_after,pin.item_after);
          if(!link){pin.member_after=pin.source_after;pin.source_after=0n;continue;}
          pin.item_after=link.trailer_configuration_ref;
          const c=required(get(db,'SELECT * FROM trailer_configurations WHERE id=?',link.trailer_configuration_ref));
          if((c.event_ref as bigint)>snap.events)continue;
          const event=required(get(db,'SELECT plugin_session_id FROM events WHERE id=?',c.event_ref));
          const qualified=event.plugin_session_id===member.plugin_session_ref?1:0,uuid=String(member.trip_uuid);
          const prior=get(db,'SELECT qualified,raw_trip_uuid FROM upload_projection_configurations WHERE pin_ref=? AND event_ref=?',pinId,c.event_ref);
          if(prior && (Number(prior.qualified)>qualified || Number(prior.qualified)===qualified && String(prior.raw_trip_uuid)<=uuid))continue;
          const row:UploadConfiguration={id:String(c.event_ref),occurrence:occurrence(db,c.event_ref,uuid,snap)!,index:n(c.slot_index),idValue:text(c,'trailer_id'),bodyType:text(c,'body_type'),chainType:text(c,'chain_type')};
          db.prepare(`INSERT INTO upload_projection_configurations VALUES(?,?,?,?,?) ON CONFLICT(pin_ref,event_ref)
            DO UPDATE SET qualified=excluded.qualified,raw_trip_uuid=excluded.raw_trip_uuid,row_json=excluded.row_json`).run(pinId,c.event_ref,qualified,uuid,JSON.stringify(row));
          if(!prior)pin.configuration_count=BigInt(String(pin.configuration_count))+1n;
        }else{
          const c=get(db,'SELECT id,kind,plugin_session_ref,detail_json FROM completeness_intervals WHERE trip_ref=? AND id>? AND id<=? ORDER BY id LIMIT 1',pin.source_after,pin.item_after,snap.intervals);
          if(!c){pin.member_after=pin.source_after;pin.source_after=0n;continue;}
          pin.item_after=c.id;
          if(!joined&&isRulePrefixProof(saved.rulePrefix)
            &&unresolvedRulePrefix(String(c.kind),c.detail_json===null?null:JSON.parse(c.detail_json as string)))saved.rulePrefix.unproven=true;
          const session=required(get(db,'SELECT plugin_session_uuid FROM plugin_sessions WHERE id=?',c.plugin_session_ref));
          const row:UploadInterval={id:String(c.id),kind:c.kind as UploadInterval['kind'],rawTripUuid:String(member.trip_uuid),pluginSessionId:String(session.plugin_session_uuid)};
          db.prepare('INSERT INTO upload_projection_intervals VALUES(?,?,?)').run(pinId,c.id,JSON.stringify(row));
          pin.interval_count=BigInt(String(pin.interval_count))+1n;
        }
      }else{
        if(pin.member_count===0n)fail('DATABASE_CORRUPT');
        const ruleContext=advanceRuleContext(db,saved,snap,pin);
        if(!ruleContext)continue;
        const value={...saved.initial as object,ruleContext,totals:{members:n(pin.member_count),configurations:n(pin.configuration_count),intervals:n(pin.interval_count)},facts:facts(db,snap,pin)};
        if(!isUploadProjection(value))fail('DATABASE_CORRUPT');
        pin.metadata_json=JSON.stringify(value);pin.state='ready';
      }
    }
    if(generation(db,pin.root_ref)!==pin.evidence_generation){pin.state='invalidated';pin.metadata_json=null;}
    db.prepare(`UPDATE upload_projection_pins SET state=@state,phase=@phase,member_after=@member_after,item_after=@item_after,source_after=@source_after,
      member_count=@member_count,configuration_count=@configuration_count,interval_count=@interval_count,outcome_trip_ref=@outcome_trip_ref,
      close_trip_ref=@close_trip_ref,metadata_json=@metadata_json,snapshot_json=@snapshot_json,examined=@examined WHERE pin_id=@pin_id`).run({...pin,snapshot_json:encodeRow(saved),examined});
    hooks?.beforeCommit?.();
    return status({...pin,examined});
  })();
}

function readPinned(db: Database.Database, token: string): LogicalRow {
  const p=uploadSnapshotParts(token);
  if(!p || required(get(db,'SELECT database_uuid FROM database_info WHERE id=1')).database_uuid!==p[1])fail('INVALID_INPUT');
  const pin=get(db,'SELECT * FROM upload_projection_pins WHERE pin_id=?',p[2]);
  if(!pin || pin.incarnation_uuid!==p[3] || pin.state!=='ready' || (JSON.parse(String(pin.metadata_json)) as UploadProjection).snapshot!==token)fail('INVALID_INPUT');
  return pin;
}
/** Storage-local point checks for a future atomic owner/freeze transaction. Detached true grants no publication authority. */
export function recheckUploadProjection(db: Database.Database, projection: UploadProjection): boolean {
  return recheckContext(db,projection,true)==='current';
}
/** Material work versions independently gate changes; ordinary counter progress may advance the latest revision. */
export function recheckUploadMaterialContext(db:Database.Database,projection:UploadProjection):'current'|'stale'|'obsolete-replay'|'stale-replay' {
  return recheckContext(db,projection,false);
}
function recheckContext(db:Database.Database,projection:UploadProjection,latestRequired:boolean):'current'|'stale'|'obsolete-replay'|'stale-replay' {
  if(!isUploadProjection(projection))fail('INVALID_INPUT');
  const p=uploadSnapshotParts(projection.snapshot)!;
  if(required(get(db,'SELECT database_uuid FROM database_info WHERE id=1')).database_uuid!==p[1])return 'stale';
  const pin=get(db,'SELECT * FROM upload_projection_pins WHERE pin_id=?',p[2]);
  if(!pin || pin.incarnation_uuid!==p[3] || pin.state!=='ready' || pin.metadata_json!==JSON.stringify(projection))return 'stale';
  const state=current(db,projection.requestedTripUuid);
  const saved=decodeRow(pin.snapshot_json);
  if(saved.ruleReplayVersion!==RULE_REPLAY_VERSION||obsoleteJoinedRule(db,pin,saved))return 'obsolete-replay';
  if((saved.joinedRule as JoinedRule|undefined)?.stale)return 'stale-replay';
  const latest=get(db,'SELECT id FROM logical_revisions WHERE logical_ref=? ORDER BY id DESC LIMIT 1',pin.root_ref);
  return state.root===projection.rootTripUuid && state.readiness==='ready' && projection.rootReadiness==='ready'
    && coverageUnchanged(db,saved.snap as LogicalSnapshot,saved,latestRequired)
    && (!latestRequired||latest?.id===pin.revision_ref) && generation(db,pin.root_ref)===pin.evidence_generation
    ?'current':'stale';
}
const copies={members:['upload_projection_members','trip_ref'],configurations:['upload_projection_configurations','event_ref'],intervals:['upload_projection_intervals','interval_ref']} as const;
export function readUploadProjectionPage(conn: StorageConnection, query: UploadProjectionPageQuery): UploadProjectionPage {
  if(!isUploadPageQuery(query))fail('INVALID_INPUT');
  const db=conn.reader();
  return db.transaction(() => {
    const pin=readPinned(db,query.snapshot),projection=JSON.parse(String(pin.metadata_json)) as UploadProjection;
    const [table,key]=copies[query.kind],after=query.cursor?BigInt(query.cursor.split(':').at(-1)!):0n;
    const rows=all(db,`SELECT row_json FROM ${table} WHERE pin_ref=? AND ${key}>? ORDER BY ${key} LIMIT ?`,pin.pin_id,after,query.limit+1)
      .map(r=>JSON.parse(String(r.row_json)) as UploadMember|UploadConfiguration|UploadInterval);
    const more=rows.length>query.limit;if(more)rows.pop();
    const page:UploadProjectionPage={snapshot:query.snapshot,kind:query.kind,cursor:query.cursor??null,nextCursor:more?`${query.snapshot}:${query.kind}:${rows.at(-1)!.id}`:null,total:projection.totals[query.kind],rows};
    if(!isUploadProjectionPage(page,query))fail('DATABASE_CORRUPT');return page;
  })();
}
export function releaseUploadProjection(conn: StorageConnection, pinId: string, hooks?: {beforeCommit?: () => void}): UploadProjectionPreparation {
  checkPinId(pinId);const db=conn.writer();
  return db.transaction(() => {
    if(Number(db.pragma('user_version',{simple:true}))>=6&&get(db,"SELECT 1 FROM upload_materializations WHERE pin_id=? AND state IN ('preparing','folding','complete')",pinId))fail('STORAGE_BUSY');
    const pin=get(db,'SELECT * FROM upload_projection_pins WHERE pin_id=?',pinId);
    let examined=0;
    if(pin){
      db.prepare("UPDATE upload_projection_pins SET state='releasing',metadata_json=NULL WHERE pin_id=?").run(pinId);
      let complete=true;
      for(const [table,key] of Object.values(copies)){
        const rows=all(db,`SELECT ${key} AS id FROM ${table} WHERE pin_ref=? ORDER BY ${key} LIMIT ?`,pinId,100-examined);
        for(const row of rows){db.prepare(`DELETE FROM ${table} WHERE pin_ref=? AND ${key}=?`).run(pinId,row.id);examined++;}
        if(rows.length===0)examined++;
        // No extra existence probe after exhausting the budget: retain the header until the next call.
        if(examined===100){complete=false;break;}
      }
      if(complete){db.prepare('DELETE FROM upload_projection_pins WHERE pin_id=?').run(pinId);examined++;}
      else db.prepare('UPDATE upload_projection_pins SET examined=? WHERE pin_id=?').run(examined,pinId);
      hooks?.beforeCommit?.();
      if(!complete)return {pinId,state:'releasing' as const,examined,projection:null};
    }
    return {pinId,state:'released' as const,examined,projection:null};
  })();
}
