import {randomUUID} from 'node:crypto';
import {isDashboardUploadStatus,type DashboardUploadStatus} from '../../../../packages/contracts/src/dashboard-upload';
import {isUploadServiceAnswer,uploadReplyMatches,type UploadServiceCommand,type UploadServiceReply} from './service-contract';
export interface UploadRpc {readonly generation:string;call(command:UploadServiceCommand):Promise<UploadServiceReply>;cancel?():void;retire():void}
export class UploadServiceBridge implements UploadRpc {
  readonly generation=randomUUID();#retired=false;#pending:{id:string;command:UploadServiceCommand;resolve:(reply:UploadServiceReply)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  constructor(private readonly send:(value:unknown)=>void,private readonly publish:(status:DashboardUploadStatus)=>void){}
  call(command:UploadServiceCommand):Promise<UploadServiceReply>{if(this.#retired)return Promise.resolve({ok:false,error:'RETIRED'});if(this.#pending)return Promise.resolve({ok:false,error:'BUSY'});
    return new Promise(resolve=>{const id=randomUUID(),timer=setTimeout(()=>{this.#pending=undefined;resolve({ok:false,error:'TIMEOUT'});},65000);timer.unref?.();this.#pending={id,command,resolve,timer};try{this.send({type:'dashboard-upload:request',id,generation:this.generation,command});}catch{clearTimeout(timer);this.#pending=undefined;resolve({ok:false,error:'RETIRED'});}});
  }
  receive(value:unknown):boolean {
    if(!value||typeof value!=='object'||!('type'in value)||typeof value.type!=='string'||!value.type.startsWith('dashboard-upload:'))return false;
    if(this.#retired)return true;
    if(value.type==='dashboard-upload:status'){
      const v=value as Record<string,unknown>;if(Object.keys(v).length===3&&v.generation===this.generation&&isDashboardUploadStatus(v.status))this.publish(v.status);return true;
    }
    if(!isUploadServiceAnswer(value)||value.generation!==this.generation)return true;
    const pending=this.#pending;if(!pending||pending.id!==value.id)return true;clearTimeout(pending.timer);this.#pending=undefined;
    pending.resolve(uploadReplyMatches(pending.command,value.reply)?value.reply:{ok:false,error:'RECONCILIATION'});return true;
  }
  retire():void {this.#retired=true;if(this.#pending){clearTimeout(this.#pending.timer);this.#pending.resolve({ok:false,error:'RETIRED'});this.#pending=undefined;}}
  cancel():void {if(this.#retired)return;try{this.send({type:'dashboard-upload:cancel',generation:this.generation});}catch{/* The utility may already have exited. */}if(this.#pending){clearTimeout(this.#pending.timer);this.#pending.resolve({ok:false,error:'CANCELLED'});this.#pending=undefined;}}
}
