import React from 'react';
import {Flame} from 'lucide-react';
import type {HardModeDetails} from '../../../../packages/contracts/src/hard-mode';
import {Button} from '../components/ui/button';
import {Badge} from '../components/ui/badge';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/card';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '../components/ui/tooltip';
import {t, type AppLanguage} from '../i18n';
import {InfoHint} from '../info-hint';
import type {HardModeController} from './use-status';
import {hardModeView, hardModeState, hardModeLossText} from './view';
export function HardModeBadge({short = false, language = 'en'}: {short?: boolean; language?: AppLanguage}) {
  return <Badge data-testid="hard-mode-badge"><Flame className="mr-1 size-3" aria-hidden="true" />{short ? 'HM' : t('hm.title', undefined, language)}</Badge>;
}
/** A trip's Hard Mode result; the audit (opening and latest state, manual delivery, snapshots) is behind the Info icon (ET-057). */
export function HardModeTrip({qualified, details, language = 'en'}: {qualified: boolean; details: HardModeDetails | null; language?: AppLanguage}) {
  const title = t('hm.title', undefined, language);
  return <section className="space-y-1" data-testid="trip-hard-mode"><h4 className="flex items-center gap-1 font-medium"><Flame className="size-4" aria-hidden="true" />{title}</h4>
    <p className="flex flex-wrap items-center gap-1">{t(qualified ? 'hm.tripYes' : 'hm.tripNo', undefined, language)}{qualified ? <> <HardModeBadge language={language} /></> : null}
      <InfoHint label={t('ui.moreAbout', {v: title}, language)}>
        {details ? <><span className="block">{t('hm.audit', {opening: hardModeState(details.opening.state, language), latest: hardModeState(details.latest.state, language), manual: t(details.manualDelivery === null ? 'hm.manual.pending' : details.manualDelivery ? 'hm.manual.yes' : 'hm.manual.no', undefined, language)}, language)}</span>
          <span className="block">{t('hm.snapshots', undefined, language)}</span></> : <span className="block">{t('hm.notEvaluated', undefined, language)}</span>}
        <span className="block text-xs text-muted-foreground">{t('hm.notice', undefined, language)}</span>
      </InfoHint></p>
    {details?.firstLoss ? <p>{t('hm.firstLoss', {loss: hardModeLossText(details.firstLoss, language)}, language)}</p> : null}
  </section>;
}
/**
 * The Hard Mode page (ET-057): the twelve rules as one grid. A passing rule shows its mark and name; a failing or unknown
 * rule also shows its detected and required values. Every rule's full detail (state, values, reason) is in its tooltip,
 * and the read-only caveats are behind one Info icon next to the headline.
 */
export function HardModeCard({language = 'en', controller}: {language?: AppLanguage; controller: HardModeController}) {
  const {status, now, busy, error, loaded, check} = controller;
  const view = hardModeView(status, now, language);
  const failing = view.rows.some(row => row.state !== 'pass');
  return <Card data-testid="hard-mode-card" data-state={status.trip?.firstLoss ? 'lost' : status.assessment.state}><CardHeader><CardTitle><h2 className="flex items-center gap-2"><Flame className="size-5" aria-hidden="true" />{view.headline}
    <InfoHint label={t('hm.howChecked', undefined, language)} side="bottom" align="start" testId="hard-mode-caveats">
      <span className="block">{t('hm.rule', undefined, language)}</span>
      <span className="block">{t('hm.notice', undefined, language)}</span>
      <span className="block">{t('hm.distinction', undefined, language)}</span>
    </InfoHint></h2></CardTitle></CardHeader>
    <CardContent className="yu-hard-mode-summary"><div className="yu-hard-mode-overview"><div><p role="status">{!loaded ? t('hm.reading', undefined, language) : t('hm.configuredCount', {n: view.passed}, language)}</p>
      <progress className="h-2 w-full" value={view.passed} max={12} aria-label={t('hm.progress', undefined, language)} />
      <p data-testid="hard-mode-source" className="yu-muted">{view.source} · {view.age}</p></div>
      <Button disabled={busy} onClick={check} data-testid="hard-mode-refresh">{t(busy ? 'hm.checking' : 'hm.recheck', undefined, language)}</Button></div>
      {error ? <p role="status">{t('hm.unavailable', undefined, language)}</p> : null}
      {view.loss ? <p role="status" data-testid="hard-mode-loss">{view.loss}</p> : null}
      {loaded && failing ? <p className="yu-muted" data-testid="hard-mode-fix">{t('hm.readonly', undefined, language)}</p> : null}
      <TooltipProvider disableHoverableContent delayDuration={100} skipDelayDuration={0}><ol className="yu-hard-mode-grid" data-testid="hard-mode-details">{view.rows.map(row => <li key={row.id} data-testid={`hard-mode-rule-${row.id}`} data-state={row.state}>
        <Tooltip><TooltipTrigger asChild><button type="button" data-testid={`hard-mode-name-${row.id}`} aria-label={`${row.label}: ${row.stateText}`} className="rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span aria-hidden="true">{row.state === 'pass' ? '✓' : row.state === 'fail' ? '✕' : '?'}</span> <span>{row.label}</span>
        </button></TooltipTrigger><TooltipContent data-testid={`hard-mode-hint-${row.id}`}>
          <p className="font-medium">{row.label}: {row.stateText}</p><p>{t('hm.detected', {value: row.detected}, language)}</p><p>{t('hm.required', {value: row.required}, language)}</p>
          <p>{t('hm.reason', {value: row.reason}, language)}</p>
        </TooltipContent></Tooltip>
        {row.state === 'pass' ? null : <div className="yu-hard-mode-values" data-testid={`hard-mode-detail-rule-${row.id}`}>
          <p>{t('hm.detected', {value: row.detected}, language)}</p><p>{t('hm.required', {value: row.required}, language)}</p></div>}
      </li>)}</ol></TooltipProvider>
    </CardContent></Card>;
}
