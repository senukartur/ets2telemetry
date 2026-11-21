import {isQualificationGame,isQualificationState,type QualificationBridge,type QualificationState} from '../../../../packages/contracts/src/qualification';
export const QUALIFICATION_CHANNELS=Object.freeze({get:'qualification:get',refresh:'qualification:refresh',status:'qualification:status'});
export type QualificationAction='get'|'refresh';
export const validQualificationArguments=(args:unknown[])=>args.length===1&&isQualificationGame(args[0]);
export interface QualificationPreloadPort {invoke(channel:string,...args:unknown[]):Promise<unknown>;on(channel:string,listener:(event:unknown,value:unknown)=>void):unknown;removeListener(channel:string,listener:(event:unknown,value:unknown)=>void):unknown}
export function qualificationPreload(port:QualificationPreloadPort):QualificationBridge {
  const call=async(action:QualificationAction,args:unknown[]):Promise<QualificationState>=>{
    if(!validQualificationArguments(args))throw Error('INVALID_QUALIFICATION_REQUEST');const value=await port.invoke(QUALIFICATION_CHANNELS[action],...args);
    if(!isQualificationState(value)||value.game!==args[0])throw Error('INVALID_QUALIFICATION_REPLY');return value;
  };
  return {getQualification:(...args:unknown[])=>call('get',args),refreshQualification:(...args:unknown[])=>call('refresh',args),subscribeQualification:(...args:unknown[])=>{
    if(args.length!==1||typeof args[0]!=='function')throw Error('INVALID_QUALIFICATION_REQUEST');
    const callback=args[0] as (state:QualificationState)=>void,receive=(_event:unknown,value:unknown)=>{if(isQualificationState(value))callback(value);};
    port.on(QUALIFICATION_CHANNELS.status,receive);return ()=>{port.removeListener(QUALIFICATION_CHANNELS.status,receive);};
  }};
}
