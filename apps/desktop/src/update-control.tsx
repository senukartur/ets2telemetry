import React, {useEffect, useState} from 'react';
import {ArrowUpCircle, RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import type {AppLanguage, ApplicationInfo, UpdateView} from '../../../packages/contracts/src';
import {t} from './i18n';
import {ActionResultRegion} from './action-result';
import {ABOUT_CHECK_WAIT_MS, aboutCheckReplied, aboutCheckText, updateControlText, versionLineText, type AboutCheckRequest} from './update-control-text';

// ET-055 UP10 and UP11: the sidebar update control (`shell.sidebar.update`), the version line (`shell.sidebar.version`,
// also on Settings > About) and the About check. Presentational: the words come from update-control-text.ts, the state
// from the validated `AppState.update` and `AppState.application`, and the only actions are the two argument-free bridge
// methods. No URL, path or file name exists here.

const FAILURE_ID = 'shell-update-failure';

interface SidebarUpdateControlProps {
  view: UpdateView | undefined;
  language: AppLanguage;
  /** The dot pulses and the busy icon turns only while the dashboard window has focus (useWindowFocused). */
  windowFocused: boolean;
  /** The click's bridge call; the dashboard bridge by default. */
  apply?: () => Promise<UpdateView>;
}

/**
 * The sidebar update control. Hidden while idle, checking or unsupported, but its polite live region stays in the
 * document from the first render so that the offer and the progress are announced; a failure is an assertive alert.
 * A native button, so Tab, Enter and Space work; while busy it keeps focus through `aria-disabled` and ignores clicks.
 * Hook-free, so tests can call it and use the returned element's click handler.
 */
export function SidebarUpdateControl({view, language, windowFocused, apply}: SidebarUpdateControlProps) {
  const control = updateControlText(view, language);
  const activate = () => {
    if (!control || control.busy) return;
    // The reply is not applied: it can arrive after a newer push. Main pushes every change of the view.
    void (apply ?? (() => window.desktop.updateApplication()))().catch(() => undefined);
  };
  const Icon = control?.icon === 'refresh' ? RefreshCw : ArrowUpCircle;
  const button = control ? <button type="button" className="yu-update" data-testid="shell.sidebar.update" data-update-state={control.state} data-tone={control.tone}
    aria-label={control.accessibleName === control.label ? undefined : control.accessibleName} aria-disabled={control.busy ? 'true' : undefined}
    aria-describedby={control.failure ? FAILURE_ID : undefined} onClick={activate}>
    {control.dot ? <span className="yu-dot" aria-hidden="true" data-tone="accent" data-motion="calm" data-window-focused={windowFocused} data-testid="shell.update.dot" /> : null}
    <Icon className="yu-update-icon" aria-hidden="true" data-motion={control.busy ? 'spin' : 'still'} data-window-focused={windowFocused} />
    <span className="yu-update-label" data-testid="shell.update.label">{control.label}</span>
  </button> : null;
  return <div className="yu-update-region" data-testid="shell.update.region">
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="shell.update.status">{control && !control.failure ? control.announcement : null}</div>
    {/* The tooltip wrapper is always there while the button is, and only its content depends on a failure: a wrapper
        mounted for `failed` alone would change the element type above the button, so React would remount it and the
        focused button would lose keyboard focus whenever the view moves into or out of `failed`. */}
    {button ? <TooltipProvider delayDuration={150} skipDelayDuration={0}><Tooltip><TooltipTrigger asChild>{button}</TooltipTrigger>
      {control?.failure ? <TooltipContent side="right" align="end" data-testid="shell.update.hint">{control.failure}</TooltipContent> : null}</Tooltip></TooltipProvider> : null}
    {control && control.progress !== null ? <div role="progressbar" className="yu-update-progress" data-testid="shell.update.progress" aria-label={t('upd.progressA', undefined, language)}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={control.progress}><i style={{width: `${control.progress}%`}} /></div> : null}
    {control?.failure ? <>
      <span id={FAILURE_ID} className="sr-only" data-testid="shell.update.failure">{control.failure}</span>
      <div role="alert" className="sr-only" data-testid="shell.update.alert">{`${control.label}. ${control.failure}`}</div>
    </> : null}
  </div>;
}

/**
 * The version line: "Version 0.1.1", "Development build" for an unpackaged run, and a warn-toned "Staging" badge for a
 * staging build. The visible words are hidden from assistive technology and one accessible sentence replaces them, so
 * the badge is read as "staging build" rather than as a separate word.
 */
export function VersionLine({info, language, testId}: {info: ApplicationInfo | undefined; language: AppLanguage; testId: string}) {
  const line = versionLineText(info, language);
  if (!line || !info) return null;
  return <p className="yu-version" data-testid={testId} data-channel={info.channel}>
    <span aria-hidden="true" data-testid={`${testId}.text`}>{line.text}</span>
    {line.badge ? <span aria-hidden="true" className="yu-version-badge" data-testid={`${testId}.badge`}>{line.badge}</span> : null}
    <span className="sr-only" data-testid={`${testId}.name`}>{line.accessibleName}</span>
  </p>;
}

/** Settings > About: "Check for updates" and its fixed answer next to the button (ET-045b action result). */
export function AboutUpdateCheck({view, language, check}: {view: UpdateView | undefined; language: AppLanguage; check?: () => Promise<UpdateView>}) {
  const [request, setRequest] = useState<AboutCheckRequest | null>(null);
  // Waiting ends with a newer finished check; until then a bounded timer runs, because a running check that never
  // reports would leave lastCheck unchanged.
  const waiting = request?.phase === 'pending' && (view?.lastCheck?.atUtcMs ?? null) === request.before;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setRequest(current => current && {...current, phase: 'answered'}), ABOUT_CHECK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  const text = aboutCheckText(view, request, language);
  const run = () => {
    if (text.busy || text.unsupported) return;
    setRequest({phase: 'pending', before: view?.lastCheck?.atUtcMs ?? null});
    // The synchronous reply says whether a check started; only then does About wait for its result.
    void (check ?? (() => window.desktop.checkForUpdates()))().then(reply => setRequest(current => current && aboutCheckReplied(current, reply)),
      () => setRequest(current => current && {...current, phase: 'answered'}));
  };
  const slot = 'settings-about-update-check';
  return <div className="space-y-2" data-testid="settings.about.update">
    <Button variant="outline" id={slot} data-testid={slot} disabled={text.unsupported} aria-disabled={text.busy ? 'true' : undefined}
      aria-describedby={text.result ? `${slot}-result` : text.note ? `${slot}-note` : undefined} onClick={run}><RefreshCw aria-hidden="true" />{text.button}</Button>
    {text.note ? <p id={`${slot}-note`} className="yu-muted" data-testid={`${slot}-note`}>{text.note}</p> : null}
    <ActionResultRegion slot={slot} result={text.result} />
  </div>;
}
