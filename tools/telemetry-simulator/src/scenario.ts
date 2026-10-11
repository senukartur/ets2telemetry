import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PROTOCOL_V0, encodeFrame, validateMessage, normalizeSdkMeasurement, type CurrentState, type ServerMessage, type SourceIdentity, type Continuity, type DiagnosticObservation} from '../../../packages/contracts/src/protocol-v0';

export interface Reading { atMs: number; speedMps: number | null; fuelL: number | null; simulation: CurrentState['simulation']; revision: string; truck: string | null; gameMinute: string; job?:CurrentState['configuration']['job'] }
export interface Scenario { id: string; origin: 'synthetic'; game:'ets2'|'ats'; seed: string; diagnostics?:boolean; steps: Array<{action: 'connect'; atMs: number} | {action: 'disconnect'; atMs: number} | {action:'reading'; reading:Reading} | {action:'diagnostic';atMs:number;observations:DiagnosticObservation[]}> }
export function seededId(seed: string, label: string): string {
  const h = createHash('sha256').update(`simulator-v0:${seed}:${label}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
export function validateScenario(input: unknown): Scenario {
  scenarioKeys(input,['id','origin','game','seed','steps'],['diagnostics']);
  const s = input as Scenario;
  if (s.origin !== 'synthetic' || !['ets2','ats'].includes(s.game) || typeof s.id !== 'string' || !s.id || s.id.length>128 || typeof s.seed !== 'string' || !s.seed || s.seed.length>128 || (s.diagnostics!==undefined&&typeof s.diagnostics!=='boolean') || !Array.isArray(s.steps) || s.steps.length > 1000) throw new Error('Invalid synthetic scenario');
  let last = 0;
  for (const step of s.steps) {
    scenarioKeys(step,['action'],['atMs','reading','observations']);
    if(step.action==='reading') {
      scenarioKeys(step,['action','reading']);
      scenarioKeys(step.reading,['atMs','speedMps','fuelL','simulation','revision','truck','gameMinute'],['job']);
    } else if(step.action==='diagnostic')scenarioKeys(step,['action','atMs','observations']);
    else scenarioKeys(step,['action','atMs']);
    const t = step.action === 'reading' ? step.reading?.atMs : step.atMs;
    if (!Number.isSafeInteger(t) || t < last || t > 86_400_000) throw new Error('Invalid controlled time');
    last = t;
    if (!['connect','disconnect','reading','diagnostic'].includes(step.action)) throw new Error('Invalid scenario action');
    if (step.action === 'reading') validateMessage({version:PROTOCOL_V0,kind:'snapshot',source:identity(s.seed,s.game),seq:'0',capture:{clockId:seededId(s.seed,'capture'),monotonicNs:'0'},data:{state:readingState(s.seed,step.reading),continuity:zeroCounters()}});
    if (step.action === 'diagnostic') validateMessage({version:PROTOCOL_V0,kind:'diagnostic',source:identity(s.seed,s.game),seq:'0',capture:{clockId:seededId(s.seed,'capture'),monotonicNs:'0'},data:{copied:true,observations:step.observations,continuity:zeroCounters()}});
  }
  // Rebuild only declared validated values. In particular, array metadata and
  // prototype/symbol properties cannot become retained replay input.
  return {id:s.id,origin:s.origin,game:s.game,seed:s.seed,...(s.diagnostics===undefined?{}:{diagnostics:s.diagnostics}),steps:s.steps.map(step=>{
    if(step.action==='reading') {
      const r=step.reading;
      return {action:'reading',reading:{atMs:r.atMs,speedMps:r.speedMps,fuelL:r.fuelL,simulation:r.simulation,revision:r.revision,truck:r.truck,gameMinute:r.gameMinute,...(r.job===undefined?{}:{job:copyJob(r.job)})}};
    }
    if(step.action==='diagnostic')return {action:step.action,atMs:step.atMs,observations:step.observations.map(o=>({channel:o.channel,sdkType:o.sdkType,unit:o.unit,value:o.value.available?{available:true,value:o.value.value}:{available:false,reason:o.value.reason}}))};
    return {action:step.action,atMs:step.atMs};
  })};
}
function scenarioKeys(input:unknown,required:string[],optional:string[]=[]):void {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid synthetic scenario object');
  if(Reflect.ownKeys(input).some(k=>typeof k!=='string'||(!required.includes(k)&&!optional.includes(k)))||required.some(k=>!Object.hasOwn(input,k)))throw new Error('Unknown or missing synthetic scenario field');
}
function copyJob(job:CurrentState['configuration']['job']):CurrentState['configuration']['job'] {
  if(!job.available)return {available:false,reason:job.reason};
  const j=job.value,p=j.plannedDistance,c=j.expectedIncome.currency;
  return {available:true,value:{cargoId:j.cargoId,destinationCityId:j.destinationCityId,plannedDistance:p.available?{available:true,value:p.value,unit:p.unit}:{available:false,reason:p.reason,unit:p.unit},expectedIncome:{rawValue:j.expectedIncome.rawValue,currency:c.status==='unknown'?{status:'unknown'}:{status:'verified',code:c.code,source:c.source}}}};
}
function zeroCounters(): Continuity { return {coalescedSnapshots:'0',lostObservations:'0',offlineTransitions:'0'}; }
function identity(seed:string,game:Scenario['game']):SourceIdentity { return {game,pluginSessionId:seededId(seed,'session'),processInstanceId:seededId(seed,'process'),processId:1,windowsSessionId:0,origin:'synthetic'}; }
export function readingState(seed:string,r:Reading):CurrentState {
  const unavailable = {available:false,reason:'not-observed'} as const;
  return {simulation:r.simulation,speed:normalizeSdkMeasurement('speed',r.speedMps === null ? unavailable : {available:true,value:r.speedMps}),fuel:normalizeSdkMeasurement('fuel',r.fuelL === null ? unavailable : {available:true,value:r.fuelL}),fuelCapacity:{...unavailable,unit:'L'},engineRpm:{...unavailable,unit:'rpm'},gear:{...unavailable,unit:'index'},odometer:{...unavailable,unit:'m'},averageConsumption:normalizeSdkMeasurement('averageConsumption',{available:true,value:0.3}),estimatedRange:{...unavailable,unit:'m'},gameTime:{available:true,value:r.gameMinute,unit:'min',clockId:seededId(seed,'game-clock')},captureUtcUnixMs:{available:true,value:(1_800_000_000_000n+BigInt(r.atMs)).toString()},configuration:{revision:r.revision,truckId:r.truck === null ? unavailable : {available:true,value:r.truck},job:r.job===undefined?unavailable:r.job},window:{available:false,reason:'not-supported'}};
}
export interface Emission { atMs:number; connection:number; message:ServerMessage; frame:Uint8Array }
/** One current state is retained offline. This models omissions, never gameplay effects. */
export function replay(input:Scenario):Emission[] {
  const s=validateScenario(input), source=identity(s.seed,s.game), counters=zeroCounters();
  let state=readingState(s.seed,{atMs:0,speedMps:null,fuelL:null,simulation:'unavailable',revision:'0',truck:null,gameMinute:'0'});
  let seq=0n, connected=false, connection=0, offlineReading=false, observed=false, gameClockEpoch=0;
  const result:Emission[]=[];
  function emit(kind:'welcome'|'checkpoint'|'snapshot',atMs:number) {
    const n=(seq++).toString();
    const capturedState={...structuredClone(state),captureUtcUnixMs:{available:true as const,value:(1_800_000_000_000n+BigInt(atMs)).toString()}};
    const data = kind==='welcome' ? {diagnostics:s.diagnostics??false,durableRecording:false} : kind==='checkpoint' ? {boundarySeq:n,state:capturedState,continuity:{...counters}} : {state:capturedState,continuity:{...counters}};
    const message=validateMessage({version:PROTOCOL_V0,kind,source,seq:n,capture:{clockId:seededId(s.seed,'capture'),monotonicNs:(BigInt(atMs)*1_000_000n).toString()},data}) as ServerMessage;
    result.push({atMs,connection,message,frame:encodeFrame(message)});
  }
  for(const step of s.steps) {
    if(step.action==='connect') { if(connected) throw new Error('Already connected'); connected=true; connection++; emit('welcome',step.atMs);emit('checkpoint',step.atMs);offlineReading=false; }
    else if(step.action==='disconnect') { if(!connected) throw new Error('Already disconnected');connected=false; }
    else if(step.action==='diagnostic') {
      if(!connected||!s.diagnostics)counters.lostObservations=(BigInt(counters.lostObservations)+BigInt(step.observations.length)).toString();
      else {
        const message=validateMessage({version:PROTOCOL_V0,kind:'diagnostic',source,seq:(seq++).toString(),capture:{clockId:seededId(s.seed,'capture'),monotonicNs:(BigInt(step.atMs)*1_000_000n).toString()},data:{copied:true,observations:step.observations,continuity:{...counters}}}) as ServerMessage;
        result.push({atMs:step.atMs,connection,message,frame:encodeFrame(message)});
      }
    } else {
      const next=readingState(s.seed,step.reading);
      if(state.gameTime.available&&BigInt(step.reading.gameMinute)<BigInt(state.gameTime.value))gameClockEpoch++;
      next.gameTime.clockId=seededId(s.seed,gameClockEpoch===0?'game-clock':`game-clock-${gameClockEpoch}`);
      if(!connected) {
        if(offlineReading) counters.coalescedSnapshots=(BigInt(counters.coalescedSnapshots)+1n).toString();
        // The placeholder initial state is not an observation, so the first reading is not a transition.
        if(observed && (state.simulation!==next.simulation || !isDeepStrictEqual(state.configuration,next.configuration))) counters.offlineTransitions=(BigInt(counters.offlineTransitions)+1n).toString();
        offlineReading=true;
        seq++; // A source snapshot boundary exists even if no client receives it.
      }
      state=next;observed=true;
      if(connected) emit('snapshot',step.reading.atMs);
    }
  }
  return result;
}
