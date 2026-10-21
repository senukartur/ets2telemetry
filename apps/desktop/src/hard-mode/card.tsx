import React from 'react';
import {Flame} from 'lucide-react';
import type {HardModeDetails} from '../../../../packages/contracts/src/hard-mode';
import {Button} from '../components/ui/button';
import {Badge} from '../components/ui/badge';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/card';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '../components/ui/tooltip';
import {Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger} from '../components/ui/sheet';
import {t, type AppLanguage, type I18nKey} from '../i18n';
import type {HardModeController} from './use-status';
import {hardModeView, hardModeState, hardModeLossText} from './view';
export function HardModeBadge({short = false, language = 'en'}: {short?: boolean; language?: AppLanguage}) {
  return <Badge data-testid="hard-mode-badge"><Flame className="mr-1 size-3" aria-hidden="true" />{short ? 'HM' : t('hm.title', undefined, language)}</Badge>;
}
export function HardModeTrip({qualified, details, language = 'en'}: {qualified: boolean; details: HardModeDetails | null; language?: AppLanguage}) {
  return <section className="space-y-1" data-testid="trip-hard-mode"><h4 className="flex items-center gap-1 font-medium"><Flame className="size-4" aria-hidden="true" />{t('hm.title', undefined, language)}</h4>
    <p>{t(qualified ? 'hm.tripYes' : 'hm.tripNo', undefined, language)}{qualified ? <> <HardModeBadge language={language} /></> : null}</p>
    {details ? <><p>{t('hm.audit', {opening: hardModeState(details.opening.state, language), latest: hardModeState(details.latest.state, language), manual: t(details.manualDelivery === null ? 'hm.manual.pending' : details.manualDelivery ? 'hm.manual.yes' : 'hm.manual.no', undefined, language)}, language)}</p>
      {details.firstLoss ? <p>{t('hm.firstLoss', {loss: hardModeLossText(details.firstLoss, language)}, language)}</p> : null}
      <p>{t('hm.snapshots', undefined, language)}</p></> : <p>{t('hm.notEvaluated', undefined, language)}</p>}
    <p className="text-xs text-muted-foreground">{t('hm.notice', undefined, language)}</p>
  </section>;
}
const compactLabel: Readonly<Record<string, I18nKey>> = {fuel: 'hm.c.fuel', air: 'hm.c.airbrake', police: 'hm.c.police', fatigue: 'hm.c.fatigue', limiter: 'hm.c.limiter', truck: 'hm.c.truckstab', trailer: 'hm.c.trailerstab', parking: 'hm.c.parking', rain: 'hm.c.rain', events: 'hm.c.events', braking: 'hm.c.brake', traffic: 'hm.c.traffic'};
export function HardModeCard({language = 'en', controller}: {language?: AppLanguage; controller: HardModeController}) {
  const {status, now, busy, error, loaded, check} = controller;
  const view = hardModeView(status, now, language);
  return <Card data-testid="hard-mode-card" data-state={status.trip?.firstLoss ? 'lost' : status.assessment.state}><CardHeader><CardTitle><h2 className="flex items-center gap-2"><Flame className="size-5" aria-hidden="true" />{view.headline}</h2></CardTitle></CardHeader>
    <CardContent className="yu-hard-mode-summary"><p role="status">{!loaded ? t('hm.reading', undefined, language) : t('hm.configuredCount', {n: view.passed}, language)}</p>
      <progress className="h-2 w-full" value={view.passed} max={12} aria-label={t('hm.progress', undefined, language)} />
      {view.loss ? <p role="status" data-testid="hard-mode-loss">{view.loss}</p> : null}
      <TooltipProvider disableHoverableContent delayDuration={100} skipDelayDuration={0}><ul className="yu-hard-mode-rules">{view.rows.map(row => <li key={row.id} data-testid={`hard-mode-rule-${row.id}`} data-state={row.state}>
        <Tooltip><TooltipTrigger asChild><button type="button" data-testid={`hard-mode-name-${row.id}`} aria-label={`${row.label}: ${row.stateText}`} className="rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span aria-hidden="true">{row.state === 'pass' ? '✓' : row.state === 'fail' ? '✕' : '?'}</span> <span>{t(compactLabel[row.id], undefined, language)}</span>
        </button></TooltipTrigger><TooltipContent data-testid={`hard-mode-hint-${row.id}`}>
          <p className="font-medium">{row.label}: {row.stateText}</p><p>{t('hm.detected', {value: row.detected}, language)}</p><p>{t('hm.required', {value: row.required}, language)}</p>
          <p>{t('hm.reason', {value: row.reason}, language)}</p><p className="break-words font-mono text-xs text-muted-foreground">{row.keys}</p>
        </TooltipContent></Tooltip>
      </li>)}</ul></TooltipProvider>
      <p data-testid="hard-mode-source" className="text-xs text-muted-foreground">{view.source} · {view.age}</p>
      <div className="yu-hard-mode-actions"><Sheet><SheetTrigger asChild><Button variant="outline" data-testid="hard-mode-checklist">{t('hm.view', undefined, language)}</Button></SheetTrigger>
        <SheetContent closeLabel={t('hm.close', undefined, language)}><SheetTitle className="flex items-center gap-2 pr-6 text-lg font-semibold"><Flame className="size-5" aria-hidden="true" />{t('hm.sheet', undefined, language)}</SheetTitle>
          <SheetDescription>{view.headline}. {t('hm.configuredCount', {n: view.passed}, language)}</SheetDescription>
          <p>{view.source} · {view.age}</p><Button disabled={busy} onClick={check} data-testid="hard-mode-drawer-refresh">{t(busy ? 'hm.checking' : 'hm.recheck', undefined, language)}</Button>
          {error ? <p role="status">{t('hm.unavailable', undefined, language)}</p> : null}{view.loss ? <p role="status">{view.loss}</p> : null}
          <ol className="space-y-4">{view.rows.map(row => <li key={row.id} data-testid={`hard-mode-drawer-rule-${row.id}`} className="space-y-1 border-b pb-3"><p className="font-medium">{row.label}: {row.stateText}</p>
            <p>{t('hm.detected', {value: row.detected}, language)}</p><p>{t('hm.required', {value: row.required}, language)}</p><p>{row.reason}</p><p className="break-words font-mono text-xs text-muted-foreground">{row.keys}</p></li>)}</ol>
          <p className="text-sm text-muted-foreground">{t('hm.notice', undefined, language)}</p><p>{t('hm.distinction', undefined, language)}</p>
        </SheetContent></Sheet>
      <Button variant="outline" disabled={busy} onClick={check} data-testid="hard-mode-refresh">{t(busy ? 'hm.checking' : 'hm.recheck', undefined, language)}</Button></div>
      {error ? <p role="status">{t('hm.unavailable', undefined, language)}</p> : null}
      <p className="text-xs text-muted-foreground">{t('hm.shortNotice', undefined, language)}</p>
    </CardContent></Card>;
}
