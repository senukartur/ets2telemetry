import React,{useState} from 'react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import type {HardModeAssessment} from '../../../../packages/contracts/src/hard-mode';
import {qualificationPercentage,type QualificationGame,type QualificationState,type QualificationWire} from '../../../../packages/contracts/src/qualification';
import {Button} from '../components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '../components/ui/card';
import {qualificationCopy,qualificationNumber,qualificationRuleRows,qualificationKilometres} from './view';
import {QualificationMedal} from './medal';
import {useQualification} from './use-qualification';
import {qualificationCurrentHardMode,qualificationGuideCue} from '../overlay-qualification';
export function QualificationRules({limits,rules,display,language,currentHardMode}:{limits:QualificationWire['Limits'];rules:QualificationWire['Rule'][]|null;display:QualificationWire['TrailerDisplay'][];language:AppLanguage;currentHardMode?:'pass'|'fail'}){
  const c=qualificationCopy[language];return <div className="qualification-rules">{qualificationRuleRows(limits,rules,display,language,currentHardMode).map(row=><div key={row.id} className="qualification-rule" data-testid={`qualification-rule-${row.id}`}>
    <strong>{row.label}</strong><div><span className="text-muted-foreground">{c.limits}: </span>{row.limit}{row.observed!==null?<p><span className="text-muted-foreground">{c.observed}: </span>{row.observed}</p>:null}</div>
    {row.result?<div className="qualification-check"><QualificationMedal cue={row.result==='unknown'?'neutral':row.result} label={row.result==='pass'?c.pass:row.result==='fail'?c.fail:c.unknown}/><span>{row.result==='pass'?c.pass:row.result==='fail'?c.fail:c.unknown}</span>{row.reasons.map(reason=><small key={reason}>{reason}</small>)}</div>:null}
  </div>)}</div>;
}
function Progress({label,credited,required,remaining,language,distance=false}:{label:string;credited:string|number;required:string|number|null;remaining:string|number|null;language:AppLanguage;distance?:boolean}){
  const c=qualificationCopy[language],display=(value:string|number)=>qualificationNumber(distance?qualificationKilometres(value):value,language),percent=qualificationPercentage(String(credited),required===null?null:String(required));return <div className="qualification-progress"><strong>{label}</strong><p>{display(credited)}{required!==null?` / ${display(required)}`:''}</p>
    {percent!==null?<progress aria-label={label} max={100} value={percent}/>:<p className="text-muted-foreground">{c.unset}</p>}{remaining!==null?<small>{c.remaining}: {display(remaining)}</small>:null}</div>;
}
export function QualificationScreenView({state,language,onGame,onRefresh,hardMode='unknown'}:{state:QualificationState;language:AppLanguage;onGame:(game:QualificationGame)=>void;onRefresh:()=>void;hardMode?:HardModeAssessment['state']}){
  const c=qualificationCopy[language],snapshot=state.snapshot,assignment=snapshot?.assignment,progress=snapshot?.progress;
  const preview=state.preview;
  const cue=preview?qualificationGuideCue(preview,hardMode):'neutral';
  const status=state.availability==='permission-required'?c.permission:state.availability==='ready'?state.stale?c.stale:null:state.availability==='unsupported'?c.unsupported:state.availability==='disabled'?c.disabled:state.availability==='offline'?c.offline:state.availability==='disconnected'?c.disconnected:state.availability==='loading'?c.loading:c.unavailable;
  return <div className="yu-stack qualification-screen" data-testid="qualification-screen">
    <div className="qualification-toolbar"><div role="group" aria-label="Game">{(['ets2','ats'] as const).map(game=><Button key={game} variant={state.game===game?'default':'outline'} aria-pressed={state.game===game} onClick={()=>onGame(game)}>{game.toUpperCase()}</Button>)}</div><Button variant="outline" disabled={state.refreshing||!state.owner} onClick={onRefresh}>{c.refresh}</Button></div>
    <p role="status">{status}{state.fetchedUtcMs!==null?<>{status?' · ':''}{c.updated}: <time dateTime={new Date(state.fetchedUtcMs).toISOString()}>{new Date(state.fetchedUtcMs).toLocaleString(language)}</time></>:null}</p>
    {snapshot?.state==='assignment_missing'?<p>{c.missing}</p>:null}
    {assignment?<><Card><CardHeader><CardTitle><QualificationMedal cue={cue} label={`${c.title}: ${cue==='pass'?c.pass:cue==='fail'?c.fail:c.unknown}`}/>{c.current}: {assignment.level.name}</CardTitle></CardHeader><CardContent>
      {progress?<><h2>{progress.terminal?c.terminal:`${c.next}: ${progress.nextLevel?.name??c.unavailable}`}</h2>{!progress.terminal?<p className="text-muted-foreground">{c.both}</p>:null}<div className="qualification-progress-grid"><Progress label={c.trips} credited={progress.creditedTrips} required={progress.terminal?null:progress.conditions.requiredTrips} remaining={progress.remainingTrips} language={language}/><Progress distance label={`${c.distance} (${language==='ru'?'км':'km'})`} credited={progress.creditedDistanceM} required={progress.terminal?null:progress.conditions.requiredDistanceM} remaining={progress.remainingDistanceM} language={language}/></div></>:null}
    </CardContent></Card><Card><CardHeader><CardTitle>{c.requirements}</CardTitle></CardHeader><CardContent><p className="text-muted-foreground">{preview?c.provisional:state.activeJob?c.waitingForCheck:c.noJob}</p>
      {preview?<p data-testid="qualification-preview-basis"><strong>{c.assessed}: {preview.assignment?.level.name??c.unavailable}</strong> · {preview.basis==='historical_assignment'?(language==='ru'?'Назначение на фактическое начало рейса':'Assignment at actual trip start'):preview.basis==='current_projection'?(language==='ru'?'Текущие ограничения (предварительный расчёт)':'Current limits (projection)'):c.unavailable}</p>:null}
      <QualificationRules limits={preview?.assignment?.limits??assignment.limits} rules={preview?.rules??null} currentHardMode={preview?qualificationCurrentHardMode(preview,hardMode):undefined} display={preview?.trailerDisplay??assignment.trailerDisplay} language={language}/>{preview?.eventExempt?<p>{c.exempt}</p>:null}</CardContent></Card></>:null}
    <p className="text-muted-foreground">{c.notAcceptance}</p>
  </div>;
}
export function QualificationScreen({language,enabled,bridge,liveHardMode}:{language:AppLanguage;enabled:boolean;bridge?:import('../../../../packages/contracts/src/qualification').QualificationBridge;liveHardMode?:{game:QualificationGame;state:HardModeAssessment['state']}}){
  const [game,setGame]=useState<QualificationGame>('ets2'),{state,refresh}=useQualification(game,enabled,bridge);
  return <QualificationScreenView state={state} language={language} onGame={setGame} onRefresh={refresh} hardMode={state.game===liveHardMode?.game?liveHardMode.state:'unknown'}/>;
}
