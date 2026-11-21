import {randomUUID} from 'node:crypto';
import {isQualificationDecimal,isQualificationWire,type QualificationPreviewInput} from '../../../../packages/contracts/src/qualification';
import type {LiveObservationV1,CurrentState} from '../../../../packages/contracts/src/protocol-v1';
import type {StorageClient} from '../../../../packages/storage/src/client';
import type {QualificationAuthority} from '../../../../packages/storage/src/qualification';
import type {UploadProjection} from '../../../../packages/storage/src/upload-projection';
import {jobKey as canonicalJobKey} from '../../../../packages/telemetry-core/src/trips/identity';
import {stored} from '../dashboard-upload/scheduler';
export type PreviewStorage=Pick<StorageClient,'readQualificationPreview'|'beginQualificationPreview'|'advanceQualificationPreview'|'releaseQualificationPreview'>;
export type QualificationLive=Pick<LiveObservationV1,'source'|'capture'> & {state:Pick<CurrentState,'configuration'|'simulation'>};
const firstBody=(slots:CurrentState['configuration']['trailers']):string|null=>{
  const first=slots[0];return first?.available&&first.value.bodyType.available&&first.value.bodyType.value.length>0&&first.value.bodyType.value.length<=128?first.value.bodyType.value:null;
};
/** One code per coupling observation: additional physical slots are provenance, never additional restricted types. */
export function qualificationTrailerFacts(slots:CurrentState['configuration']['trailers'],history:(string|null)[]=[]):QualificationPreviewInput['trailers'] {
  const current=firstBody(slots);
  const items:QualificationPreviewInput['trailers']['items']=history.map(code=>({code,provenance:code===null?'unknown':'previous'}));
  let complete=current!==null&&!history.includes(null);
  if(items.length>9){items.splice(8,items.length-8,{code:null,provenance:'unknown'});complete=false;}
  items.push({code:current,provenance:current===null?'unknown':'attached'});
  return {complete:!!complete,items};
}
/** Canonical shortest numeric SDK representation; unavailable/invalid values are never changed to zero. */
export function previewDecimal(value:number):string|null {
  if(!Number.isFinite(value)||value<0)return null;
  const text=String(value);if(isQualificationDecimal(text))return text;
  const match=/^(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);if(!match)return null;
  const digits=match[1]+(match[2]??''),point=match[1].length+Number(match[3]);
  const expanded=point<=0?`0.${'0'.repeat(-point)}${digits}`:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
  return isQualificationDecimal(expanded)?expanded:null;
}
const sourceKey=(live:QualificationLive|null)=>live?`${live.source.game}:${live.source.pluginSessionId}:${live.source.processInstanceId}:${live.capture.clockId}`:'';
/** Owns one uniquely named preparation pin. It never freezes an envelope or consumes another owner's pin. */
export class QualificationPreviewFacts {
  #live:QualificationLive|null=null;#generation=0;#pin:string|null=null;#proof:{key:string;projection:UploadProjection}|null=null;
  #context='';#evidence='';#contextRevision=0;#evidenceRevision=0;#current:QualificationPreviewInput|null=null;
  #reading:Promise<QualificationPreviewInput|null>|null=null;
  #job='';#couplings:(string|null)[]=[];
  constructor(private readonly db:PreviewStorage,private readonly authority:QualificationAuthority){}
  get current():QualificationPreviewInput|null{return this.#current?structuredClone(this.#current):null;}
  observe(live:QualificationLive|null):void {
    const before=this.#live,changed=sourceKey(before)!==sourceKey(live)||JSON.stringify(before?.state.configuration)!==JSON.stringify(live?.state.configuration);
    this.#live=live;
    if(sourceKey(before)!==sourceKey(live)||!live?.state.configuration.job.available){this.#couplings=[];this.#job='';this.#proof=null;}
    else if(before&&this.#job&&JSON.stringify(before.state.configuration.trailers[0])!==JSON.stringify(live.state.configuration.trailers[0])){
      if(this.#couplings.length<9)this.#couplings.push(firstBody(before.state.configuration.trailers));else this.#couplings[8]=null;
    }
    if(changed||!live?.state.configuration.job.available){this.#generation++;this.#current=null;this.#context='';}
  }
  async #release():Promise<void>{const pin=this.#pin;if(!pin)return;for(let turn=0;turn<64;turn++){const value=await this.db.releaseQualificationPreview({...this.authority,pinId:pin});if(!value.ok)throw Error('PREVIEW_RELEASE_FAILED');if(value.value.state==='released'){this.#pin=null;return;}}throw Error('PREVIEW_RELEASE_PENDING');}
  read():Promise<QualificationPreviewInput|null>{
    if(this.#reading)return this.#reading;this.#reading=this.#read().finally(()=>{this.#reading=null;});return this.#reading;
  }
  async refresh():Promise<QualificationPreviewInput|null>{await this.#reading?.catch(()=>undefined);return this.read();}
  async #read():Promise<QualificationPreviewInput|null>{
    const live=this.#live,generation=this.#generation;if(!live||live.source.origin!=='game'||!live.state.configuration.job.available){this.#current=null;return null;}
    const local=await stored(this.db.readQualificationPreview({...this.authority,game:live.source.game,pluginSessionId:live.source.pluginSessionId}));
    if(generation!==this.#generation||!local.current){this.#current=null;return null;}
    const current=local.current,key=`${sourceKey(live)}:${current.tripUuid}:${current.rawTripUuid}:${current.materialVersion}`;
    const jobKey=`${sourceKey(live)}:${current.tripUuid}`;if(this.#job!==jobKey){this.#couplings=[];this.#job=jobKey;}
    if(this.#proof?.key!==key){
      await this.#release();const pin=randomUUID();this.#pin=pin;
      try{
        const begun=await this.db.beginQualificationPreview({...this.authority,pinId:pin,tripUuid:current.tripUuid});
        if(!begun.ok){if(begun.error.code==='STORAGE_BUSY'||begun.error.code==='INVALID_INPUT')this.#pin=null;throw Error('PREVIEW_PREPARATION_FAILED');}
        let preparation=begun.value;
        for(let turn=0;turn<32&&preparation.state==='preparing';turn++){
          if(generation!==this.#generation)return null;
          preparation=await stored(this.db.advanceQualificationPreview({...this.authority,pinId:pin}));
        }
        if(preparation.state!=='ready'||!preparation.projection||preparation.projection.purpose!=='history'||preparation.projection.rootTripUuid!==current.tripUuid){this.#current=null;return null;}
        this.#proof={key,projection:preparation.projection};
      }finally{await this.#release();}
    }
    if(generation!==this.#generation||this.#proof?.key!==key)return null;
    const projection=this.#proof.projection,job=live.state.configuration.job.value;
    if(!projection.facts.job||canonicalJobKey(projection.facts.job)!==canonicalJobKey(job)){this.#current=null;return null;}
    const cargo=job.cargoId.available&&job.cargoId.value.length<=128&&job.cargoId.value.length>0?job.cargoId.value:null;
    const mass=job.cargoMass.available?previewDecimal(job.cargoMass.value):null;
    const trailers=qualificationTrailerFacts(live.state.configuration.trailers,this.#couplings);
    const started=projection.facts.opening?.utcMs;
    const facts={game:live.source.game,cargo:{availability:cargo?'known' as const:'unknown' as const,code:cargo},cargoMassKg:{availability:mass!==null?'known' as const:'unknown' as const,value:mass},trailers,actualDistance:current.actualDistance,hardMode:{final:false,result:'unknown' as const},start:started!==null&&started!==undefined?{basis:'actual' as const,utc:new Date(started).toISOString()}:null,eventId:null};
    const context=JSON.stringify({key,...facts,actualDistance:{...facts.actualDistance,metres:null}}),evidence=JSON.stringify(facts.actualDistance);
    if(context!==this.#context){this.#context=context;this.#contextRevision++;}
    if(evidence!==this.#evidence){this.#evidence=evidence;this.#evidenceRevision++;}
    const input={...facts,requestId:randomUUID(),contextRevision:this.#contextRevision,evidenceRevision:this.#evidenceRevision};
    this.#current=isQualificationWire('PreviewInput',input)?input:null;return this.current;
  }
  async close():Promise<void>{this.#generation++;this.#live=null;this.#current=null;this.#proof=null;await this.#reading?.catch(()=>undefined);await this.#release();}
}
