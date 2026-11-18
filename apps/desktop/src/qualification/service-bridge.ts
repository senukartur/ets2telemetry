import {randomUUID} from 'node:crypto';
import {isQualificationServiceAnswer,isQualificationPublication,type QualificationPrivateState} from './service-contract';
import type {QualificationGame,QualificationState} from '../../../../packages/contracts/src/qualification';
export interface QualificationRpc {readonly generation:string;call(action:'get'|'refresh',game:QualificationGame):Promise<QualificationPrivateState>;retire():void}
export class QualificationServiceBridge implements QualificationRpc {
  #retired=false;#pending=new Map<string,{game:QualificationGame;resolve:(state:QualificationPrivateState)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(readonly generation:string,private readonly send:(value:unknown)=>void,private readonly publish:(state:QualificationState,connectionVersion:string|null)=>void){}
  call(action:'get'|'refresh',game:QualificationGame):Promise<QualificationPrivateState>{
    if(this.#retired||this.#pending.size>=4)return Promise.reject(Error('RETIRED'));
    return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{this.#pending.delete(id);reject(Error('TIMEOUT'));},10000);timer.unref?.();this.#pending.set(id,{game,resolve,reject,timer});try{this.send({type:'qualification:request',id,generation:this.generation,action,game});}catch{clearTimeout(timer);this.#pending.delete(id);reject(Error('RETIRED'));}});
  }
  receive(value:unknown):boolean {
    if(!value||typeof value!=='object'||!('type'in value)||typeof value.type!=='string'||!value.type.startsWith('qualification:'))return false;
    if(this.#retired)return true;
    if(isQualificationPublication(value)){const v=value as unknown as QualificationPrivateState & {generation:string};if(v.generation===this.generation)this.publish(v.state,v.connectionVersion);return true;}
    if(!isQualificationServiceAnswer(value)||value.generation!==this.generation)return true;
    const pending=this.#pending.get(value.id);if(!pending)return true;this.#pending.delete(value.id);clearTimeout(pending.timer);
    if(value.state.game!==pending.game)pending.reject(Error('INVALID_QUALIFICATION_REPLY'));else pending.resolve({state:value.state,connectionVersion:value.connectionVersion});return true;
  }
  retire():void{this.#retired=true;for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(Error('RETIRED'));}this.#pending.clear();}
}
