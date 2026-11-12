import React from 'react';
import {Flame, TriangleAlert, Check, X, CircleHelp, Info} from 'lucide-react';
import type {HardModeDetails} from '../../../../packages/contracts/src/hard-mode';
import {Button} from '../components/ui/button';
import {Badge} from '../components/ui/badge';
import {Card, CardContent, CardTitle, CardHeader} from '../components/ui/card';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '../components/ui/tooltip';
import {t, type AppLanguage} from '../i18n';
import {InfoHint} from '../info-hint';
import type {HardModeController} from './use-status';
import {hardModeView, hardModeState, hardModeLossText, hardModeRatioText, hardModeDiagnosticText} from './view';

export function HardModeBadge({short = false, language = 'en'}: {short?: boolean; language?: AppLanguage}) {
  return <Badge data-testid="hard-mode-badge"><Flame className="mr-1 size-3" aria-hidden="true" />{short ? 'HM' : t('hm.title', undefined, language)}</Badge>;
}

const HM_MARKS = {pass: '✓', fail: '✕', unknown: '?'} as const;
/** One evaluation of a trip: its mark and state in words and how many of the twelve rules passed then. */
function HardModeEvaluation({label, assessment, language, testId}: {label: string; assessment: HardModeDetails['opening']; language: AppLanguage; testId: string}) {
  const passed = assessment.rules.filter(rule => rule.state === 'pass').length;
  return <div className="yu-trip-row"><dt>{label}</dt><dd data-testid={testId} data-state={assessment.state}><span aria-hidden="true">{HM_MARKS[assessment.state]} </span><span className="sr-only">{hardModeState(assessment.state, language)}: </span>{t('hm.configuredCount', {n: passed}, language)}</dd></div>;
}

/** A trip's Hard Mode card (ET-077, mockup T4): the result, the evaluation at job start and the latest one, and the v2 and first-loss evidence. */
export function HardModeTrip({qualified, details, delivered = false, language = 'en'}: {qualified: boolean; details: HardModeDetails | null; delivered?: boolean; language?: AppLanguage}) {
  const title = t('hm.title', undefined, language);
  return <section className="yu-trip-card" data-testid="trip-hard-mode" aria-labelledby="yu-trip-hard-mode">
    <div className="yu-trip-card-head"><h2 id="yu-trip-hard-mode">{title}</h2></div>
    <div className="yu-trip-card-body">
      <p className="yu-trip-verdict" data-state={qualified ? 'pass' : 'neutral'}>{qualified ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}<span>{t(qualified ? 'hm.tripYes' : 'hm.tripNo', undefined, language)}</span>
        <InfoHint label={t('ui.moreAbout', {v: title}, language)}><span className="block text-xs text-muted-foreground">{t('hm.notice', undefined, language)}</span></InfoHint></p>
      {details ? <><dl><HardModeEvaluation label={t('tr.hmStart', undefined, language)} assessment={details.opening} language={language} testId="trip.hardMode.opening" />
        <HardModeEvaluation label={t(delivered ? 'tr.hmEnd' : 'tr.hmLatest', undefined, language)} assessment={details.latest} language={language} testId="trip.hardMode.latest" /></dl>
        <p className="yu-trip-note">{t('tr.hmSnapshot', undefined, language)}</p></> : <p className="yu-trip-note" data-testid="trip.hardMode.notEvaluated">{t('hm.notEvaluated', undefined, language)}</p>}
      {details?.version === 2 ? <><p>{hardModeRatioText(details, language)}</p>{details.firstDiagnostic ? <p className="yu-trip-note">{hardModeDiagnosticText(details.firstDiagnostic, language)}</p> : null}{details.latestDiagnostic && JSON.stringify(details.latestDiagnostic) !== JSON.stringify(details.firstDiagnostic) ? <p className="yu-trip-note">{hardModeDiagnosticText(details.latestDiagnostic, language)}</p> : null}</> : null}
      {details?.firstLoss ? <p>{t('hm.firstLoss', {loss: hardModeLossText(details.firstLoss, language)}, language)}</p> : null}
    </div>
  </section>;
}

export function HardModeCard({language = 'en', controller}: {language?: AppLanguage; controller: HardModeController}) {
  const {status, now, busy, error, loaded, check} = controller;
  const view = hardModeView(status, now, language);
  const failing = view.rows.filter(row => row.state === 'fail');
  const isLost = Boolean(status.trip?.firstLoss);
  const isPass = loaded && !error && status.assessment.state === 'pass';
  const isUnknown = !loaded || error || (!isLost && status.assessment.state === 'unknown');

  const badgeVariant = !loaded || error ? 'neutral' : isLost ? 'error' : isPass ? 'ok' : isUnknown ? 'neutral' : 'warn';
  const badgeIcon = !loaded || error ? (
    <CircleHelp className="size-3 mr-1" aria-hidden="true" />
  ) : isLost ? (
    <X className="size-3 mr-1" aria-hidden="true" />
  ) : isPass ? (
    <Check className="size-3 mr-1" aria-hidden="true" />
  ) : isUnknown ? (
    <CircleHelp className="size-3 mr-1" aria-hidden="true" />
  ) : (
    <TriangleAlert className="size-3 mr-1" aria-hidden="true" />
  );
  const badgeText = !loaded
    ? t('hm.reading', undefined, language)
    : error
      ? t('hm.unavailable', undefined, language)
      : isUnknown
        ? view.verification.headline ?? view.headline
        : `${view.headline} · ${t('hm.configuredCount', {n: view.passed}, language)}`;

  return (
    <div className="yu-stack" data-testid="hard-mode-card" data-state={isLost ? 'lost' : status.assessment.state}>
      {/* 1. Top Summary Card */}
      <Card>
        <CardContent className="yu-hard-mode-summary p-4">
          <div className="yu-hard-mode-head">
            <CardTitle>
              <h2 className="flex items-center gap-2">
                <Flame className="size-5 text-[var(--yu-accent)]" aria-hidden="true" />
                <span>{t('hm.currentSettings', undefined, language)}</span>
                <InfoHint label={t('hm.howChecked', undefined, language)} side="bottom" align="start" testId="hard-mode-caveats">
                  <span className="block">{t('hm.rule', undefined, language)}</span>
                  <span className="block">{t('hm.notice', undefined, language)}</span>
                  <span className="block">{t('hm.distinction', undefined, language)}</span>
                </InfoHint>
              </h2>
            </CardTitle>
            <div className="yu-hard-mode-badge-wrap ml-auto">
              <Badge variant={badgeVariant}>
                {badgeIcon}
                <span>{badgeText}</span>
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--yu-text-secondary)]">
            <p data-testid="hard-mode-source" className="yu-muted">
              {view.source} · {view.age}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={check}
              data-testid="hard-mode-refresh"
            >
              {t(busy || status.verification.checking ? 'hm.checking' : 'hm.recheck', undefined, language)}
            </Button>
          </div>
          {view.verification.checkResult ? (
            <p data-testid="hard-mode-check-result" className="text-xs text-[var(--yu-text-muted)]">
              {view.verification.checkResult}
            </p>
          ) : null}

          <div className="yu-hard-mode-progress">
            <progress
              value={view.passed}
              max={12}
              aria-label={t('hm.progress', undefined, language)}
              data-state={status.assessment.state}
            />
            <p role="status" className="text-xs font-medium">
              {!loaded ? t('hm.reading', undefined, language) : t('hm.configuredCount', {n: view.passed}, language)}
            </p>
          </div>

          {loaded && !error && view.verification.line ? (
            <p role="status" data-testid="hard-mode-verification" data-state={status.verification.state} data-reason={status.verification.reason ?? undefined} className="text-sm text-[var(--yu-text-secondary)]">
              {view.verification.line}
            </p>
          ) : null}

          {error ? <p role="status" className="text-sm text-[var(--yu-err-fg)]">{t('hm.unavailable', undefined, language)}</p> : null}
        </CardContent>
      </Card>

      {/* 2. Status Explanation Banners */}
      {view.ratio ? (
        <div className="rounded-lg border border-[var(--yu-border)] bg-[var(--yu-bg-card)] p-3 text-sm">
          <p role="status" data-testid="hard-mode-trip-ratio">
            {view.ratio} {t('hm.recoverable', undefined, language)}
          </p>
        </div>
      ) : null}

      {view.diagnostic ? (
        <p data-testid="hard-mode-diagnostic" className="text-xs text-[var(--yu-text-muted)]">
          {view.diagnostic}
        </p>
      ) : null}

      {view.loss ? (
        <div className="yu-hard-mode-loss flex items-start gap-2 rounded-lg border border-[var(--yu-err-border)] bg-[var(--yu-err-bg)] p-3 text-sm text-[var(--yu-err-fg)]" role="status">
          <X className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
          <p data-testid="hard-mode-loss">{view.loss}</p>
        </div>
      ) : null}

      {loaded && failing.length > 0 ? (
        <div className="yu-hard-mode-fix flex items-start gap-2 rounded-lg border border-[var(--yu-warn-border)] bg-[var(--yu-warn-bg)] p-3 text-sm text-[var(--yu-warn-fg)]">
          <TriangleAlert className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
          <p data-testid="hard-mode-fix">{t('hm.fix', {settings: failing.map(row => row.label).join(', ')}, language)}</p>
        </div>
      ) : null}

      {/* 3. Conditions List */}
      <Card>
        <CardHeader className="py-3 px-4 border-b border-[var(--yu-border)]">
          <h3 className="text-sm font-semibold text-[var(--yu-text-strong)]">
            {t('hm.conditionsTitle', undefined, language)}
          </h3>
        </CardHeader>
        <CardContent className="p-4">
          <TooltipProvider disableHoverableContent delayDuration={100} skipDelayDuration={0}>
            <ol className="yu-hard-mode-grid" data-testid="hard-mode-details">
              {view.rows.map(row => {
                const mark = row.state === 'pass' ? '✓' : row.state === 'fail' ? '✕' : '?';
                return (
                  <li key={row.id} data-testid={`hard-mode-rule-${row.id}`} data-state={row.state} className="yu-hard-mode-item">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-testid={`hard-mode-name-${row.id}`}
                          aria-label={`${row.label}: ${row.stateText}`}
                          className="font-medium text-sm text-left truncate flex items-center gap-1.5 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span className="yu-hard-mode-mark" aria-hidden="true">{mark}</span>
                          <span>{row.label}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent data-testid={`hard-mode-hint-${row.id}`}>
                        <p className="font-medium">{row.label}: {row.stateText}</p>
                        <p>{t('hm.detected', {value: row.detected}, language)}</p>
                        <p>{t('hm.required', {value: row.required}, language)}</p>
                        <p>{t('hm.reason', {value: row.reason}, language)}</p>
                      </TooltipContent>
                    </Tooltip>
                    <p className="text-xs font-mono text-[var(--yu-text-muted)] truncate">{row.keys}</p>
                    <div className="text-xs mt-1 space-y-0.5 text-[var(--yu-text-secondary)]">
                      <p><span className="text-[var(--yu-text-muted)]">{t('hm.col.required', undefined, language)}:</span> {row.required}</p>
                      <p><span className="text-[var(--yu-text-muted)]">{t('hm.col.detected', undefined, language)}:</span> {row.detected}</p>
                    </div>
                    {row.state === 'fail' ? (
                      <div className="yu-hard-mode-values" data-testid={`hard-mode-detail-rule-${row.id}`}>
                        <p>{row.inline}</p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </TooltipProvider>
        </CardContent>
      </Card>

      {/* 4. "What is checked" Caveats Card */}
      <Card>
        <CardHeader className="py-3 px-4 border-b border-[var(--yu-border)]">
          <h3 className="text-sm font-semibold flex items-center gap-1.5 text-[var(--yu-text-strong)]">
            <Info className="size-4 text-[var(--yu-text-muted)]" aria-hidden="true" />
            <span>{t('hm.howChecked', undefined, language)}</span>
          </h3>
        </CardHeader>
        <CardContent className="p-4 text-xs text-[var(--yu-text-secondary)] space-y-1.5">
          <p>1. {t('hm.noticePersisted', undefined, language)}</p>
          <p>2. {t('hm.noticeParking', undefined, language)}</p>
          <p>3. {t('hm.noticeSnapshots', undefined, language)}</p>
        </CardContent>
      </Card>
    </div>
  );
}
