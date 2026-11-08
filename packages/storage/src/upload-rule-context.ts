import type {Available, EventRecord} from '../../contracts/src/protocol-v1';

export interface RuleTrailer {index:number;id:Available<string>;bodyType:Available<string>;chainType:Available<string>}
export interface RuleContext {version:1|2;status:'proven'|'changed'|'unavailable'|'unproven';items:RuleTrailer[];recordingLoss:boolean}
export interface RuleReplay {
  version:1;phase:'baseline'|'events'|'gaps'|'losses'|'done';baselineBeforeSeq:string;baselineBeforeId:string;
  lossKind:number;lossAfter:string;eventAfter:string;gapAfterSeq:string;gapAfterId:string;next:string;end:string;opening:string;
  clock:string;openingNs:string;openingOrder:string;items:RuleTrailer[];opened:boolean;changed:boolean;unproven:boolean;recordingLoss:boolean;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uint=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18_446_744_073_709_551_615n;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const field=(v:unknown)=>exact(v,['available','value'])&&v.available===true&&typeof v.value==='string'&&v.value.length<=65_536
  ||exact(v,['available','reason'])&&v.available===false&&['invalid','not-observed','not-supported'].includes(String(v.reason));
export const usable=(v:Available<string>)=>v.available&&v.value.trim().length>0;
export function isRuleItems(v:unknown):v is RuleTrailer[] {
  return Array.isArray(v)&&v.length<=10&&v.every((item,i)=>exact(item,['index','id','bodyType','chainType'])&&Number.isInteger(item.index)
    &&Number(item.index)>=0&&Number(item.index)<=9&&(i===0||(v[i-1] as RuleTrailer).index<Number(item.index))&&field(item.id)&&field(item.bodyType)&&field(item.chainType));
}
export function isRuleBaseline(v:unknown):v is {version:1;slots:Available<RuleTrailer>[]} {
  return exact(v,['version','slots'])&&v.version===1&&Array.isArray(v.slots)&&v.slots.length<=10&&v.slots.every((slot,index)=>
    exact(slot,['available','value'])&&slot.available===true&&isRuleItems([slot.value])&&(slot.value as RuleTrailer).index===index
    ||exact(slot,['available','reason'])&&slot.available===false&&['invalid','not-observed','not-supported'].includes(String(slot.reason)));
}
export interface RulePrefixProof {version:1;unproven:boolean}
export function isRulePrefixProof(v:unknown):v is RulePrefixProof {
  return exact(v,['version','unproven'])&&v.version===1&&typeof v.unproven==='boolean';
}
/** A checkpoint before a new raw opening cannot establish an earlier, unresolved gameplay-job prefix. */
export function unresolvedRulePrefix(kind:string,detail:unknown):boolean {
  if(kind!=='discontinuity'&&kind!=='not-connected')return false;
  const d=object(detail)?detail:{};
  if(Object.hasOwn(d,'decision')||Object.hasOwn(d,'continuationOf'))return true;
  const cause=typeof d.cause==='string'?d.cause:'';
  if(['reload','late-attach','opened-before-attach','loaded-job-unverified','save-load'].includes(cause))return true;
  if(d.annotation===true&&['opened-at-load','menu-job-acceptance','observed-acceptance','loaded-job-coverage-confirmed','paused-reconnect'].includes(cause))return false;
  if(kind==='not-connected')return !['disconnected','consumer-restart'].includes(cause);
  // These measurements do not replace the original job opening; native configuration/gap replay still has to prove it.
  return !['odometer-regressed','odometer-jump','position-jump','game-time-jump','refuel','truck-change','reading-hole','utc-label-jump'].includes(cause);
}
export function isRuleContext(v:unknown):v is RuleContext {
  return exact(v,['version','status','items','recordingLoss'])&&(v.version===1||v.version===2)&&['proven','changed','unavailable','unproven'].includes(String(v.status))
    // Old v1/v2 positives may be sparse. Decode them, then reassess completeness at final mapping.
    &&isRuleItems(v.items)&&typeof v.recordingLoss==='boolean'&&(v.status!=='proven'||!v.recordingLoss&&v.items.length>0&&v.items[0].index===0&&usable(v.items[0].bodyType)&&v.items.every(item=>usable(item.id)));
}
export function isRuleReplay(v:unknown):v is RuleReplay {
  const numbers=['baselineBeforeSeq','baselineBeforeId','eventAfter','gapAfterSeq','gapAfterId','next','end','opening','openingNs','openingOrder','lossAfter'];
  return exact(v,['version','phase',...numbers,'lossKind','clock','items','opened','changed','unproven','recordingLoss'])&&v.version===1
    &&['baseline','events','gaps','losses','done'].includes(String(v.phase))&&numbers.every(k=>uint(v[k]))&&Number.isInteger(v.lossKind)&&Number(v.lossKind)>=0&&Number(v.lossKind)<=3&&uuid(v.clock)&&isRuleItems(v.items)
    &&['opened','changed','unproven','recordingLoss'].every(k=>typeof v[k]==='boolean');
}
export function chainComplete(items:RuleTrailer[]):boolean {
  return items.length>0&&items[0].index===0&&usable(items[0].bodyType)&&items.every((item,index)=>item.index===index&&usable(item.id));
}
export function replayRuleEvent(state:RuleReplay,sequence:string,record:EventRecord,clock:string):void {
  if(sequence!==state.next||clock!==state.clock)state.unproven=true;
  state.next=(BigInt(sequence)+1n).toString();state.eventAfter=sequence;
  if(sequence===state.opening)state.opened=true;
  if(record.type==='trailer.configured'){
    const item={index:record.index,id:record.id,bodyType:record.bodyType,chainType:record.chainType};
    const prior=state.items.find(i=>i.index===item.index);
    const equal=(a:Available<string>,b:Available<string>)=>a.available?b.available&&a.value===b.value:!b.available&&a.reason===b.reason;
    if(state.opened&&(!prior||!equal(prior.id,item.id)||!equal(prior.bodyType,item.bodyType)||!equal(prior.chainType,item.chainType)))state.changed=true;
    state.items=state.items.filter(i=>i.index!==item.index);state.items.push(item);state.items.sort((a,b)=>a.index-b.index);
  }else if(record.type==='trailer.cleared'){
    if(state.opened)state.changed=true;
    state.items=state.items.filter(i=>i.index!==record.index);
  }
}
export function finishRuleReplay(state:RuleReplay):RuleContext {
  const status=state.changed?'changed':state.unproven||!state.opened?'unproven':chainComplete(state.items)?'proven':'unavailable';
  return {version:2,status,items:state.changed?[]:state.items,recordingLoss:state.recordingLoss};
}
