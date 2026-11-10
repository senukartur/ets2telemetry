import {AccountScreen} from './dashboard-upload/account-screen';
import {SyncChip} from './dashboard-upload/sync-chip';
import {useDashboardUpload} from './dashboard-upload/use-dashboard-upload';
import {connectionChip, desktopLiveView, hardModeChip, liveGameMode, liveScreenState, liveSourcesPartial, liveSubline, pluginChip, recordingMotion, recordingTone, type ShellRoute} from './screens/desktop-ui-view';
import {HardModeCard} from './hard-mode/card';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {AppLanguage, AppState, LiveTelemetry, SettingsView} from '../../../packages/contracts/src';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {Power, Info} from 'lucide-react';
import {useHardModeStatus} from './hard-mode/use-status';
import {useLanguageController} from './shell/use-language';
import {useWindowFocused} from './shell/use-window-focus';
import {SidebarNav} from './shell/sidebar-nav';
import {ShellSlotsProvider} from './shell/shell-slots';
import {TopBar} from './shell/top-bar';
import {ThemedLogo} from './shell/themed-logo';
import {createStartupLine} from './dashboard-startup';
import {recordingStatusText} from './recording-status-text';
import {LiveDashboard} from './live-dashboard';
import {usePluginActions} from './plugin-setup-card';
import {SettingsScreen, type SettingsCard, type SettingsPanel} from './settings-screen';
import {SidebarUpdateControl, VersionLine} from './update-control';
import {Journal, JournalBoundary} from './journal';
import {getStrings} from './strings';
import {t} from './i18n';
import {CHANNEL} from './channel';
import './index.css';

export default function App() {
  const [route, setRoute] = useState<ShellRoute>('live');
  // The Settings panel stays selected across route changes within a session (ET-078).
  const [panel, setPanel] = useState<SettingsPanel>('general');
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLElement>(null);
  const hardMode = useHardModeStatus();
  const upload = useDashboardUpload(route === 'account');
  useEffect(() => {
    // Each top-level destination starts at its heading, including after the long inline checklist.
    if (content.current) content.current.scrollTop = 0;
    heading.current?.focus();
  }, [route]);
  const [startup, setStartup] = useState<string>('Starting');
  const [live, setLive] = useState<LiveTelemetry>();
  const [app, setApp] = useState<AppState>();
  const [exit, setExit] = useState<'idle' | 'pending' | 'failed'>('idle');
  // Main reports one `saveError` for the whole settings file; it is shown in the card whose request caused it.
  const [lastCard, setLastCard] = useState<SettingsCard>('units');
  // ET-076: the elements of the top bar and page header where the Journal shows its Refresh and totals.
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [sublineSlot, setSublineSlot] = useState<HTMLElement | null>(null);
  // ET-077: the top bar's element where an open trip adds its cargo after the page's crumb.
  const [breadcrumbSlot, setBreadcrumbSlot] = useState<HTMLElement | null>(null);
  // ET-078: one card action controller for the Game plugin card and the diagnostics export on Settings > Diagnostics.
  const pluginActions = usePluginActions();
  const [startupLine] = useState(() => createStartupLine(() => window.desktop.getStatus(), setStartup));
  useEffect(() => {
    startupLine.start();
    return window.desktop.subscribeLive(setLive);
  }, [startupLine]);
  useEffect(() => window.desktop.subscribeAppState(state => {setApp(state); startupLine.health(state.health);}), [startupLine]);

  const settings = app?.settings;
  const language: AppLanguage = settings?.language ?? 'en';
  const strings = getStrings(language);
  useEffect(() => {document.documentElement.lang = language;}, [language]);
  const health = app?.health;
  // ET-015c PR-4 (G8): the recording status text; until main's first push the status is not known.
  const recording = recordingStatusText(health?.recording ?? {state: 'unknown'}, language);
  const windowFocused = useWindowFocused();
  // Main pushes the saved settings; until the first push the ET-000 defaults apply.
  const saved = (view: SettingsView) => setApp(current => current && {...current, settings: view});
  const languageController = useLanguageController(settings, saved, () => setLastCard('language'));
  const targets = app ? Object.values(app.plugins.games).flatMap(game => game.targets) : [];
  // ET-074: one live view for the game chip and the Live subline; the Live page builds its own from the same inputs.
  const liveView = useMemo(() => desktopLiveView(live, settings?.units, settings?.gearDisplay), [live, settings?.units, settings?.gearDisplay]);
  const game = live?.observation?.source.game.toUpperCase() ?? '', mode = liveGameMode(liveView.sources);
  const liveState = liveScreenState(live?.status, liveView.current, liveView.sources.paused, liveSourcesPartial(live));
  return <div className="yu-app" data-testid="shell.root">
    {/* ET-074: the title bar holds the app name and the native window buttons only; the logo is in the sidebar lockup. */}
    <div className="yu-titlebar" data-testid="shell.titlebar"><span>{CHANNEL.displayName}</span></div>
    <div className="yu-body"><aside className="yu-sidebar" data-testid="shell.sidebar"><div className="yu-lockup" data-testid="shell.sidebar.lockup"><ThemedLogo /><div><strong>Yukon Union</strong><small>{t('app.sub', undefined, language)}</small></div></div>
      <SidebarNav route={route} language={language} onNavigate={setRoute} />
      <div className="yu-sidebar-footer"><TooltipProvider delayDuration={150} skipDelayDuration={0}><Tooltip><TooltipTrigger asChild>
        <button type="button" className="yu-recording" data-testid="shell.sidebar.recording" aria-label={recording.testBadge ? `${recording.label}, ${recording.testBadge}` : recording.label}>
          <span className="yu-dot" aria-hidden="true" data-tone={recordingTone(health?.recording.state)} data-motion={recordingMotion(health?.recording.state)} data-window-focused={windowFocused} data-testid="shell.recording.indicator" />
          <span className="yu-recording-label" data-testid="shell.recording.label">{recording.label}</span>
          {recording.testBadge ? <span className="yu-recording-badge" data-testid="shell.recording.badge">{recording.testBadge}</span> : null}
          <Info className="yu-recording-info" aria-hidden="true" />
        </button></TooltipTrigger><TooltipContent side="right" align="end" data-testid="shell.recording.hint"><div className="space-y-1">
          <p className="font-medium">{recording.headline}</p>
          {recording.detail.map(line => <p key={line}>{line}</p>)}
          {recording.alert ? <p>{recording.alert}</p> : null}
          {recording.losses.map(line => <p key={line} className="text-muted-foreground">{line}</p>)}
        </div></TooltipContent></Tooltip></TooltipProvider>
        <SidebarUpdateControl view={app?.update} language={language} windowFocused={windowFocused} />
        <VersionLine info={app?.application} language={language} testId="shell.sidebar.version" />
        {/* ET-057: the language is chosen in Settings > General only; closing to the tray is explained on Exit. */}
        <TooltipProvider delayDuration={150} skipDelayDuration={0}><Tooltip><TooltipTrigger asChild>
          <Button variant="outline" className="yu-exit" disabled={exit === 'pending'} aria-describedby="shell-exit-hint" data-testid="exit-application" onClick={() => {setExit('pending'); void window.desktop.exitApplication().catch(() => setExit('failed'));}}><Power aria-hidden="true" />{exit === 'pending' ? strings.exitPending : t('side.exit', undefined, language)}</Button>
        </TooltipTrigger><TooltipContent side="right" align="end" data-testid="shell.exit.hint">{t('s.closeD', undefined, language)}</TooltipContent></Tooltip></TooltipProvider>
        <span id="shell-exit-hint" className="sr-only" style={{position: 'fixed'}}>{t('s.closeD', undefined, language)}</span>
        {exit === 'failed' ? <p role="status">{strings.exitFailed}</p> : null}
      </div></aside>
      <ShellSlotsProvider actions={actionsSlot} subline={sublineSlot} breadcrumb={breadcrumbSlot}><div className="yu-column"><TopBar route={route} language={language} actionsRef={setActionsSlot} breadcrumbRef={setBreadcrumbSlot} connection={connectionChip(live?.status, game, mode ? t(mode === 'haulmp' ? 'mode.haulmp' : mode === 'truckersmp' ? 'mode.tmp' : 'mode.sp', undefined, language) : null, language)}
        plugin={pluginChip(targets, language)} hardMode={hardModeChip(hardMode.status, hardMode.now, language)}>
        <SyncChip state={upload.state} language={language} onOpen={() => setRoute('account')} />
      </TopBar><main ref={content} className="yu-content" data-testid="shell.content">
        {/* ET-074: the page title opens the content of every route; it takes focus on each route change. */}
        <div className="yu-page-header" data-testid="shell.pageHeader"><h1 ref={heading} tabIndex={-1} data-testid="screen-title">{route === 'journal' ? t('j.title', undefined, language) : t(`nav.${route}`, undefined, language)}</h1>
          {route === 'live' ? <p className="yu-page-sub" data-testid="live.sub">{liveSubline(liveState, game, live?.reason, language)}</p> : null}
          <div ref={setSublineSlot} /></div>
        <div hidden={route !== 'live'} className="yu-live-screen" data-testid="live.screen">
          <LiveDashboard onSelect={game => window.desktop.selectSource(game)} live={live} units={settings?.units} gearDisplay={settings?.gearDisplay} recording={health?.recording} language={language} />
        </div>
        <div hidden={route !== 'hardMode'} className="yu-stack" data-testid="hardMode.screen"><HardModeCard language={language} controller={hardMode} /></div>
        {route === 'journal' ? <JournalBoundary language={language}><Journal uploadStatus={upload.state.status} units={settings?.units} recording={health?.recording.state} language={language} /></JournalBoundary> : null}
        {route === 'account' ? <AccountScreen state={upload.state} controller={upload.controller} language={language} onOpenJournal={() => setRoute('journal')} /> : null}
        <SettingsScreen hidden={route !== 'settings'} language={language} panel={panel} onPanel={setPanel} app={app} live={live} startup={startup} onSaved={saved}
          lastCard={lastCard} onRequest={setLastCard} languageController={languageController} pluginActions={pluginActions}
          onPlugins={plugins => setApp(current => current && {...current, plugins})} onSourceFailed={() => setStartup(strings.sourceSelectionFailed)} />
      </main></div></ShellSlotsProvider>
    </div>
  </div>;
}
