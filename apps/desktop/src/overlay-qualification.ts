import type {HardModeAssessment} from '../../../packages/contracts/src/hard-mode';
import {compareQualificationCounter,compareQualificationDecimal,type QualificationCue,type QualificationPreview,type QualificationPreviewInput} from '../../../packages/contracts/src/qualification';
export interface QualificationLease {reply:QualificationPreview;input:QualificationPreviewInput;dispatchMonotonicMs:number;authority:string}
export const sanitizeOverlayQualification=(value:unknown):QualificationCue=>value==='pass'||value==='fail'?value:'neutral';
/** Accept a fresh response only within the server's request lifetime. */
export function isFreshQualificationReply(lease:QualificationLease,nowMonotonicMs:number):boolean {
  const {reply,dispatchMonotonicMs}=lease;
  const ttl=Math.min(5000,Date.parse(reply.applicability.expiresAt)-Date.parse(reply.evaluatedAt));
  return Number.isFinite(ttl)&&nowMonotonicMs>=dispatchMonotonicMs&&nowMonotonicMs<dispatchMonotonicMs+ttl;
}

/** A retained guide still belongs to the same trip and must respect the server's applicability guards. */
export function qualificationPreviewApplies(lease:QualificationLease,current:QualificationPreviewInput|null,authority:string,qualificationRevision:string|null):boolean {
  if(!current||lease.authority!==authority)return false;
  const {reply,input}=lease,guard=reply.applicability;
  if(reply.securityScope!==authority||reply.requestId!==input.requestId||reply.contextRevision!==input.contextRevision||
    guard.contextRevision!==current.contextRevision||reply.contextRevision!==current.contextRevision||reply.evidenceRevision!==input.evidenceRevision||
    current.evidenceRevision<reply.evidenceRevision||current.game!==input.game||!qualificationRevision||
    compareQualificationCounter(guard.qualificationRevision,qualificationRevision)<0)return false;
  const distance=current.actualDistance;
  if(guard.minimumDistanceM!==null||guard.maximumDistanceM!==null){
    if(distance.availability!=='known'||distance.support==='unknown'||distance.support!==input.actualDistance.support||distance.metres===null)return false;
    if(guard.minimumDistanceM!==null&&compareQualificationDecimal(distance.metres,guard.minimumDistanceM)<0||guard.maximumDistanceM!==null&&compareQualificationDecimal(distance.metres,guard.maximumDistanceM)>0)return false;
  }
  return true;
}

export function qualificationCurrentHardMode(preview:QualificationPreview,hardMode:HardModeAssessment['state']):'pass'|'fail'|undefined {
  if(hardMode==='unknown'||preview.eventExempt)return;
  const rule=preview.rules.find(rule=>rule.rule==='hard_mode');
  if(rule?.required&&rule.result==='unknown'&&rule.reasons.includes('hard_mode_not_final'))return hardMode;
}

export function qualificationGuideCue(preview:QualificationPreview,hardMode:HardModeAssessment['state']):QualificationCue {
  if(!preview.assignment)return 'neutral';
  if(preview.outcome!=='unknown')return preview.outcome;
  const currentHardMode=qualificationCurrentHardMode(preview,hardMode);
  if(currentHardMode==='fail')return 'fail';
  if(currentHardMode==='pass'&&preview.rules.every(rule=>rule.rule==='hard_mode'||rule.result==='pass')&&
    preview.reasons.every(reason=>reason==='hard_mode_not_final'))return 'pass';
  return 'neutral';
}
