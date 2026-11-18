import React from 'react';
import type {AppLanguage,JournalSyncRow} from '../../../../packages/contracts/src';
import type {QualificationResult} from '../../../../packages/contracts/src/qualification';
import {Card,CardContent,CardHeader,CardTitle} from '../components/ui/card';
import {QualificationMedal} from './medal';
import {qualificationCopy} from './view';
import {QualificationRules} from './screen';
export function qualificationResultLabel(result:QualificationResult|null,language:AppLanguage):string{
  const c=qualificationCopy[language];if(!result?.assessment)return c.awaiting;
  const a=result.assessment;if(a.availability==='historical_unavailable')return c.historical;
  return a.outcome==='pass'?c.pass:a.outcome==='fail'?c.fail:c.unknown;
}
export function JournalQualificationBadge({row,language}:{row:JournalSyncRow;language:AppLanguage}){
  if(!row.qualification)return null;const c=qualificationCopy[language],result=row.qualification.current,a=result?.assessment;
  const cue=a?.availability==='retained'&&a.outcome&&a.outcome!=='unknown'?a.outcome:'neutral';
  return <span data-testid="journal-qualification"><QualificationMedal cue={cue} label={`${c.title}: ${qualificationResultLabel(result,language)}`}/></span>;
}
function Assessment({result,previous,language}:{result:QualificationResult;previous:boolean;language:AppLanguage}){
  const c=qualificationCopy[language],a=result.assessment;if(!a)return null;
  return <section className="qualification-assessment" data-testid={previous?'qualification-previous':'qualification-assessment'}>
    {previous?<h3>{c.previous}</h3>:null}<p><strong>{qualificationResultLabel(result,language)}</strong></p>
    {a.availability==='retained'?<><p>{c.assessed}: {a.level?.name??c.unavailable}{a.level?` · ${a.level.editVersion}`:''}</p>
      {a.limits?<QualificationRules limits={a.limits} rules={a.rules} display={a.trailerDisplay} language={language}/>:null}
      {a.eventExempt?<p>{c.exempt}</p>:null}
      {a.trailerDisplay.length?<p className="text-muted-foreground">{c.catalog} · {a.trailerDisplay[0].asOf}</p>:null}</>:null}
    <p>{c.decided}: <time dateTime={a.decidedAt}>{new Date(a.decidedAt).toLocaleString(language)}</time></p>
  </section>;
}
export function JournalQualificationResult({row,language}:{row:JournalSyncRow;language:AppLanguage}){
  const decoration=row.qualification;if(!decoration)return null;const c=qualificationCopy[language],result=decoration.latest??decoration.current??decoration.previous;
  return <Card data-testid="trip-qualification"><CardHeader><CardTitle>{c.title}</CardTitle></CardHeader><CardContent>
    {decoration.awaiting?<p>{c.awaiting}</p>:null}
    {decoration.current?<Assessment result={decoration.current} previous={false} language={language}/>:null}
    {decoration.previous?<Assessment result={decoration.previous} previous={true} language={language}/>:null}
    {result?<><p>{c.company}: {c[result.companyDecision]}</p><p>{c.credit}: {result.credit?.credited?c.yes:result.credit===null?c.unknown:c.no}</p></>:null}
    <p className="text-muted-foreground">{c.notAcceptance}</p>
  </CardContent></Card>;
}
