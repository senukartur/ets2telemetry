import React from 'react';
import {Check,Medal,X} from 'lucide-react';
import type {QualificationCue} from '../../../../packages/contracts/src/qualification';
/** Owner-selected Lucide Medal, with an independent non-colour server-result cue. */
export function QualificationMedal({cue,label,className=''}:{cue:QualificationCue;label:string;className?:string}){
  return <span className={`qualification-medal ${className}`} data-state={cue} role="img" aria-label={label} title={label}>
    <Medal width={22} height={26} strokeWidth={1.7} aria-hidden="true" focusable="false"/>
    <span className="qualification-medal-mark" aria-hidden="true">{cue==='pass'?<Check size={12}/>:cue==='fail'?<X size={12}/>:null}</span>
  </span>;
}
