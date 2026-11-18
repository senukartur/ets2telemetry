import {uploadShape,uploadOne,uploadUuid,uploadNull} from '../../../../packages/contracts/src/dashboard-upload';
import {isQualificationGame,isQualificationState,isQualificationCounter,type QualificationGame,type QualificationState} from '../../../../packages/contracts/src/qualification';
export interface QualificationServiceRequest {type:'qualification:request';id:string;generation:string;action:'get'|'refresh';game:QualificationGame}
export interface QualificationPrivateState {state:QualificationState;connectionVersion:string|null}
export interface QualificationServiceAnswer extends QualificationPrivateState {type:'qualification:answer';id:string;generation:string}
export const isQualificationServiceRequest=(v:unknown):v is QualificationServiceRequest=>uploadShape({type:uploadOne('qualification:request'),id:uploadUuid,generation:uploadUuid,action:uploadOne('get','refresh'),game:isQualificationGame})(v);
export const isQualificationServiceAnswer=(v:unknown):v is QualificationServiceAnswer=>uploadShape({type:uploadOne('qualification:answer'),id:uploadUuid,generation:uploadUuid,state:isQualificationState,connectionVersion:uploadNull(isQualificationCounter)})(v);
export const isQualificationPublication=uploadShape({type:uploadOne('qualification:status'),generation:uploadUuid,state:isQualificationState,connectionVersion:uploadNull(isQualificationCounter)});
