import {compareQualificationCounter,compareQualificationDecimal,type QualificationCue,type QualificationPreview,type QualificationPreviewInput} from '../../../packages/contracts/src/qualification';
export interface QualificationLease {reply:QualificationPreview;input:QualificationPreviewInput;dispatchMonotonicMs:number;authority:string}
export const sanitizeOverlayQualification=(value:unknown):QualificationCue=>value==='pass'||value==='fail'?value:'neutral';
/** Compare only server-issued applicability guards. Rule outcomes are never evaluated locally. */
export function qualificationLeaseCue(lease:QualificationLease|null,current:QualificationPreviewInput|null,authority:string,qualificationRevision:string|null,nowMonotonicMs:number):QualificationCue {
  if(!lease||!current||lease.authority!==authority)return 'neutral';
  const {reply,input}=lease,guard=reply.applicability;
  if(reply.securityScope!==authority)return 'neutral';
  const ttl=Math.min(5000,Date.parse(guard.expiresAt)-Date.parse(reply.evaluatedAt));
  if(!Number.isFinite(ttl)||ttl<=0||nowMonotonicMs<lease.dispatchMonotonicMs||nowMonotonicMs>=lease.dispatchMonotonicMs+ttl||reply.requestId!==input.requestId||reply.contextRevision!==input.contextRevision||guard.contextRevision!==current.contextRevision||reply.contextRevision!==current.contextRevision||reply.evidenceRevision!==input.evidenceRevision||current.evidenceRevision<reply.evidenceRevision||current.game!==input.game||!qualificationRevision||compareQualificationCounter(guard.qualificationRevision,qualificationRevision)!==0)return 'neutral';
  const distance=current.actualDistance;
  if(guard.minimumDistanceM!==null||guard.maximumDistanceM!==null){
    if(distance.availability!=='known'||distance.support==='unknown'||distance.support!==input.actualDistance.support||distance.metres===null)return 'neutral';
    if(guard.minimumDistanceM!==null&&compareQualificationDecimal(distance.metres,guard.minimumDistanceM)<0||guard.maximumDistanceM!==null&&compareQualificationDecimal(distance.metres,guard.maximumDistanceM)>0)return 'neutral';
  }
  return reply.outcome==='unknown'?'neutral':reply.outcome;
}
