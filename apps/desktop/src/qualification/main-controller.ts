import {initialQualificationState,isQualificationState,type QualificationGame,type QualificationState} from '../../../../packages/contracts/src/qualification';
import {sameDashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
import type {JournalUploadScope} from '../dashboard-upload/journal-sync-guard';
import {validQualificationArguments,type QualificationAction} from './contract';
import type {QualificationRpc} from './service-bridge';
const sameScope=(left:JournalUploadScope|undefined,right:JournalUploadScope|undefined)=>!!left&&!!right&&left.connectionVersion===right.connectionVersion&&left.documentEpoch===right.documentEpoch&&left.utilityGeneration===right.utilityGeneration&&sameDashboardOwner(left.owner,right.owner);
/** Main owns all document/connection/utility authority; IPC accepts only a fixed game enum. */
export class QualificationMainController {
  #rpc:QualificationRpc|undefined;
  constructor(private readonly scope:()=>JournalUploadScope|undefined,private readonly publish:(state:QualificationState)=>void){}
  attach(rpc:QualificationRpc):void{this.#rpc?.retire();this.#rpc=rpc;}
  detach():void{this.#rpc?.retire();this.#rpc=undefined;this.retireVisible();}
  retireVisible():void{for(const game of ['ets2','ats'] as const)this.publish(initialQualificationState(game));}
  accept(state:QualificationState,connectionVersion:string|null):void{const scope=this.scope();if(isQualificationState(state)&&scope&&connectionVersion===scope.connectionVersion&&this.#rpc?.generation===scope.utilityGeneration&&state.owner&&sameDashboardOwner(state.owner,scope.owner))this.publish(state);}
  async handle(action:QualificationAction,args:unknown[]):Promise<QualificationState>{
    if(!validQualificationArguments(args))throw Error('INVALID_QUALIFICATION_REQUEST');const game=args[0] as QualificationGame,before=this.scope(),rpc=this.#rpc;
    if(!before||!rpc||rpc.generation!==before.utilityGeneration)return initialQualificationState(game);
    try{const {state,connectionVersion}=await rpc.call(action,game),after=this.scope();return this.#rpc===rpc&&sameScope(before,after)&&connectionVersion===before.connectionVersion&&state.owner&&sameDashboardOwner(state.owner,before.owner)?state:initialQualificationState(game);}
    catch{return sameScope(before,this.scope())?{...initialQualificationState(game,before.owner),availability:'offline'}:initialQualificationState(game);}
  }
}
