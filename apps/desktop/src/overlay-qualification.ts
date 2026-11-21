import type {HardModeAssessment} from '../../../packages/contracts/src/hard-mode';
import {compareQualificationCounter,compareQualificationDecimal,type QualificationCue,type QualificationPreview,type QualificationPreviewInput,type QualificationWire} from '../../../packages/contracts/src/qualification';
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

export function qualificationGuideRules(preview:QualificationPreview,hardMode:HardModeAssessment['state']):QualificationWire['Rule'][] {
  if(hardMode==='unknown'||preview.eventExempt)return preview.rules;
  const pending=preview.rules.find(rule=>rule.rule==='hard_mode'&&rule.required&&rule.result==='unknown'&&rule.reasons.includes('hard_mode_not_final'));
  if(pending?.rule!=='hard_mode')return preview.rules;
  return preview.rules.map(rule=>rule===pending
    ? {...pending,result:hardMode,observed:hardMode==='pass'?'qualified':'not-qualified',reasons:[]}
    : rule);
}

export function qualificationGuideCue(preview:QualificationPreview,hardMode:HardModeAssessment['state']):QualificationCue {
  if(!preview.assignment)return 'neutral';
  const rules=qualificationGuideRules(preview,hardMode);
  if(preview.outcome==='fail'||rules.some(rule=>rule.result==='fail'))return 'fail';
  if(preview.outcome==='pass'||(rules!==preview.rules&&rules.every(rule=>rule.result==='pass')&&
    preview.reasons.every(reason=>reason==='hard_mode_not_final')))return 'pass';
  return 'neutral';
}
