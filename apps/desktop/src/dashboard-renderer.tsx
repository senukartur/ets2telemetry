import {NowPlayingSettingsCard} from './now-playing/settings-card';
import {recordingMotion, recordingTone, connectionTone, pluginTone, hardModeTone, pluginStatusText} from './screens/desktop-ui-view';
import {HardModeCard} from './hard-mode/card';
import React, {useEffect, useRef, useState} from 'react';
import type {AppLanguage, AppState, LiveTelemetry, SettingsView, SourceSelection, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Badge} from '@/components/ui/badge';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {Gauge, BookOpen, Settings2, Power, Flame, Plug, Info} from 'lucide-react';
import {useHardModeStatus} from './hard-mode/use-status';
import {hardModeView} from './hard-mode/view';
import {useLanguageController} from './shell/use-language';
import {useWindowFocused} from './shell/use-window-focus';
import logo from './assets/logo.png';
import huninnFontLicense from './assets/huninn-OFL.txt?raw';
import huninnFontLicenseUrl from './assets/huninn-OFL.txt?url';
import {createStartupLine} from './dashboard-startup';
import {recordingStatusText} from './recording-status-text';
import {LiveDashboard} from './live-dashboard';
import {LanguageCard} from './language-card';
import {AutostartCard} from './autostart-card';
import {OverlaySettingsCard} from './overlay-settings-card';
import {GearDisplayCard} from './gear-display-card';
import {PluginSetupCard} from './plugin-setup-card';
import {UninstallCard} from './uninstall-card';
import {AboutUpdateCheck, SidebarUpdateControl, VersionLine} from './update-control';
import {connectionDiagnosis} from './connection-diagnosis';
import {Journal, JournalBoundary} from './journal';
import {DEFAULT_UNIT_PROFILES, isUnitProfile, UNIT_GAMES, UNIT_PROFILE_IDS} from './unit-profiles';
import {
  getAppErrorText, getServiceHealthText, getSettingsSaveErrorText, getSettingsStateText,
  getStorageHealthText, getStrings, getUnitGameText, getUnitProfileText
} from './strings';
import {t} from './i18n';
import {CHANNEL} from './channel';
import './index.css';

export default function App() {
  const [route, setRoute] = useState<'live' | 'hardMode' | 'journal' | 'settings'>('live');
  const [panel, setPanel] = useState<'general' | 'overlay' | 'plugin' | 'about' | 'data'>('general');
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLElement>(null);
  const hardMode = useHardModeStatus();
  useEffect(() => {
    // Each top-level destination starts at its heading, including after the long inline checklist.
    if (content.current) content.current.scrollTop = 0;
    heading.current?.focus();
  }, [route]);
  const [startup, setStartup] = useState<string>('Starting');
  const [live, setLive] = useState<LiveTelemetry>();
  const [app, setApp] = useState<AppState>();
  const [exit, setExit] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [units, setUnits] = useState<'idle' | 'saving' | 'failed'>('idle');
  // Main reports one `saveError` for the whole settings file; it is shown in the card whose request caused it.
  const [lastCard, setLastCard] = useState<'units' | 'gear' | 'overlay' | 'language' | 'autostart'>('units');
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
  const problem = health && (health.service === 'failed' || health.service === 'restarting') && health.lastError;
  // ET-015c PR-4 (G8): the recording status text; until main's first push the status is not known.
  const recording = recordingStatusText(health?.recording ?? {state: 'unknown'}, language);
  const windowFocused = useWindowFocused();
  const recordingAlertVariant = health?.recording.state === 'retrying' ? 'default' : 'destructive';
  // Main pushes the saved settings; until the first push the ET-000 defaults apply.
  const saved = (view: SettingsView) => setApp(current => current && {...current, settings: view});
  const languageController = useLanguageController(settings, saved, () => setLastCard('language'));
  const hmView = hardModeView(hardMode.status, hardMode.now, language);
  const targets = app ? Object.values(app.plugins.games).flatMap(game => game.targets) : [];
  const choose = (game: UnitGame, value: string) => {
    if (!isUnitProfile(value)) return;
    setLastCard('units'); setUnits('saving');
    void window.desktop.setUnitProfile(game, value).then(view => {
      saved(view); setUnits('idle');
    }, () => setUnits('failed'));
  };

  // ET-057: the Account placeholder returns with the server phase; Diagnostics comes last, apart from the driver's settings.
  const nav = [{id: 'live', Icon: Gauge}, {id: 'hardMode', Icon: Flame}, {id: 'journal', Icon: BookOpen}, {id: 'settings', Icon: Settings2}] as const;
  const settingsPanels = ['general', 'overlay', 'plugin', 'about', 'data'] as const;
  const showSettingsState = settings && settings.state !== 'loaded' && settings.state !== 'defaults';
  return <div className="yu-app" data-testid="shell.root">
    <div className="yu-titlebar" data-testid="shell.titlebar"><img src={logo} alt="" /><span>{CHANNEL.displayName}</span></div>
    <div className="yu-body"><aside className="yu-sidebar" data-testid="shell.sidebar"><div className="yu-lockup" data-testid="shell.sidebar.lockup"><img src={logo} alt="" /><div><strong>Yukon Union</strong><small>{t('app.sub', undefined, language)}</small></div></div>
      <nav aria-label={t('app.window', undefined, language)}>{nav.map(({id, Icon}) => <React.Fragment key={id}>
        {id === 'live' || id === 'settings' ? <p className="yu-nav-group">{t(id === 'live' ? 'nav.group.drive' : 'nav.group.app', undefined, language)}</p> : null}
        <button type="button" className="yu-nav-item" aria-current={route === id ? 'page' : undefined} onClick={() => setRoute(id)} data-testid={`tab-${id}`}><Icon aria-hidden="true" />{t(`nav.${id}`, undefined, language)}</button>
      </React.Fragment>)}</nav>
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
          <Button variant="ghost" className="w-full" disabled={exit === 'pending'} aria-describedby="shell-exit-hint" data-testid="exit-application" onClick={() => {setExit('pending'); void window.desktop.exitApplication().catch(() => setExit('failed'));}}><Power aria-hidden="true" />{exit === 'pending' ? strings.exitPending : t('side.exit', undefined, language)}</Button>
        </TooltipTrigger><TooltipContent side="right" align="end" data-testid="shell.exit.hint">{t('s.closeD', undefined, language)}</TooltipContent></Tooltip></TooltipProvider>
        <span id="shell-exit-hint" className="sr-only" style={{position: 'fixed'}}>{t('s.closeD', undefined, language)}</span>
        {exit === 'failed' ? <p role="status">{strings.exitFailed}</p> : null}
      </div></aside>
      <div className="yu-column"><header className="yu-topbar" data-testid="shell.topbar"><h1 ref={heading} tabIndex={-1} data-testid="screen-title">{t(`nav.${route}`, undefined, language)}</h1>
        <Badge variant={connectionTone(live?.status)} data-testid="shell.status.connection"><Gauge aria-hidden="true" />{live?.observation?.source.game.toUpperCase() ?? ''} {t(`ui.status.${live?.status ?? 'waiting'}`, undefined, language)}</Badge>
        <Badge variant={pluginTone(targets)} data-testid="shell.status.plugin"><Plug aria-hidden="true" />{t('ui.plugin', undefined, language)} · {pluginStatusText(targets, language)}</Badge>
        <Badge variant={hardModeTone(hardMode.status)} data-testid="shell.status.hardMode"><Flame aria-hidden="true" />{hmView.headline}</Badge>
      </header><main ref={content} className="yu-content" data-testid="shell.content">
        <div hidden={route !== 'live'} className="yu-stack" data-testid="live.screen">
          <LiveDashboard onSelect={game => window.desktop.selectSource(game)} live={live} units={settings?.units} gearDisplay={settings?.gearDisplay} language={language} />
        </div>
        <div hidden={route !== 'hardMode'} className="yu-stack" data-testid="hardMode.screen"><HardModeCard language={language} controller={hardMode} /></div>
        {route === 'journal' ? <JournalBoundary language={language}><Journal units={settings?.units} recording={health?.recording.state} language={language} /></JournalBoundary> : null}
        <div hidden={route !== 'settings'} className="yu-settings" data-testid="settings.screen"><nav className="yu-settings-nav" aria-label={t('nav.settings', undefined, language)} data-testid="settings.nav">{settingsPanels.map(id => <button key={id} type="button" aria-current={panel === id ? 'page' : undefined} data-testid={`settings.nav.${id}`} onClick={() => setPanel(id)}>{t(`s.${id}`, undefined, language)}</button>)}</nav>
          <div className="yu-stack"><div hidden={panel !== 'general'} className="yu-stack" data-testid="settings.general">
            {/* ET-057: how the saved settings were read is shown only when it matters (defaults kept, read-only or invalid file). */}
            {showSettingsState ? <Alert><AlertDescription data-testid="settings-state">{getSettingsStateText(settings.state, language)}</AlertDescription></Alert> : null}
            <Card size="sm"><CardHeader><CardTitle><h2>{t('s.interface', undefined, language)}</h2></CardTitle></CardHeader><CardContent>
              <LanguageCard settings={settings} onSaved={saved} controller={languageController} showSaveError={lastCard === 'language'} />
              <AutostartCard settings={settings} status={app?.autostart} onSaved={saved} onRequest={() => setLastCard('autostart')} showSaveError={lastCard === 'autostart'} />
            </CardContent></Card>
            <Card size="sm" data-testid="settings.units"><CardHeader><CardTitle><h2>{strings.unitsTitle}</h2></CardTitle></CardHeader><CardContent>
    {UNIT_GAMES.map(game => <div key={game} className="yu-setting-row">
      <span id={`units-${game}-label`}>{getUnitGameText(game, language)}</span>
      {/* A choice shows as selected only after main saved it; a failed save leaves the previous one. */}
      <RadioGroup aria-labelledby={`units-${game}-label`} data-testid={`units-${game}`} className="yu-segmented" value={settings?.units[game] ?? DEFAULT_UNIT_PROFILES[game]}
        disabled={!settings?.writable || units === 'saving'} onValueChange={value => choose(game, value)}>
        {UNIT_PROFILE_IDS.map(option => <div key={option} className="yu-segment-option">
          <RadioGroupItem value={option} id={`units-${game}-${option}`} /><Label htmlFor={`units-${game}-${option}`}>{getUnitProfileText(option, language)}</Label>
        </div>)}
      </RadioGroup>
    </div>)}
    {/* A refused save is reported by main in the settings view; other request failures only locally. */}
    {settings?.saveError && lastCard === 'units' ? <p role="status" data-testid="settings-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
      : units === 'failed' ? <p role="status" data-testid="settings-error">{strings.unitsSaveFailed}</p> : null}
            </CardContent></Card>
            <NowPlayingSettingsCard settings={settings} view={app?.nowPlaying} onSaved={saved} />
            <GearDisplayCard settings={settings} onSaved={saved} onRequest={() => setLastCard('gear')} showSaveError={lastCard === 'gear'} />
          </div>
          <div hidden={panel !== 'overlay'} data-testid="settings.overlay"><OverlaySettingsCard settings={settings} edit={app?.overlayEdit} onSaved={saved} onRequest={() => setLastCard('overlay')} showSaveError={lastCard === 'overlay'} />
            </div>
          <div hidden={panel !== 'plugin'} data-testid="settings.plugin"><PluginSetupCard language={language} view={app?.plugins} diagnosis={app ? connectionDiagnosis(app.plugins, live?.status ?? 'waiting', live?.selection ?? 'game', app.health) : undefined} onView={plugins => setApp(current => current && {...current, plugins})} /></div>
          <div hidden={panel !== 'data'} className="yu-stack" data-testid="settings.data"><Card><CardHeader><CardTitle><h2>{t('ui.diagnostics', undefined, language)}</h2></CardTitle></CardHeader><CardContent className="space-y-3"><p data-testid="startup-status">{startup}</p><p data-testid="prototype-notice" className="yu-muted">{recording.notice}</p>
            <label>{strings.sourceLabel} <select data-testid="source-select" value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup(strings.sourceSelectionFailed));}}><option value="game">{strings.sourceSelectPrompt}</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">{strings.sourceSyntheticFixture}</option><option value="replay">{strings.sourceReplayFixture}</option></select></label>
            <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? strings.startupWaiting}</p><p>{t('ui.origin', undefined, language)}: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {t(live?.fresh ? 'ui.current' : 'ui.notCurrent', undefined, language)}; {t('ui.coverageUnknown', undefined, language)}.</p>
          </CardContent></Card>  <Card size="sm"><CardHeader><CardTitle><h2>{strings.healthTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-2">
    {problem ? <Alert variant="destructive" data-testid="health-alert"><AlertTitle>{strings.serviceFailedTitle}</AlertTitle><AlertDescription>{getAppErrorText(problem, language)}</AlertDescription></Alert> : null}
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="app-health">
      <dt>{strings.serviceLabel}</dt><dd data-testid="health-service">{health ? getServiceHealthText(health.service, language) : '—'}</dd>
      <dt>{strings.storageLabel}</dt><dd data-testid="health-storage">{health ? getStorageHealthText(health.storage, language) : '—'}</dd>
      <dt>{strings.recordingLabel}</dt><dd data-testid="health-recording">{health ? recording.headline : '—'}</dd>
      {health && recording.detail.length ? <dd className="col-start-2" data-testid="health-recording-detail">{recording.detail.map(line => <p key={line}>{line}</p>)}</dd> : null}
      {health && recording.losses.length ? <dd className="col-start-2" data-testid="health-recording-losses">{recording.losses.map(line => <p key={line}>{line}</p>)}</dd> : null}
      {health?.lastError && !problem ? <><dt>{strings.lastErrorLabel}</dt><dd>{getAppErrorText(health.lastError, language)}</dd></> : null}
    </dl>
    {health && recording.alert ? <Alert variant={recordingAlertVariant}><AlertTitle>{strings.recordingProblemTitle}</AlertTitle>
      <AlertDescription data-testid="health-recording-alert">{recording.alert}</AlertDescription></Alert> : null}
    <Alert><AlertDescription data-testid="close-to-tray">{strings.closeToTray}</AlertDescription></Alert>
  </CardContent></Card></div>
          <div hidden={panel !== 'about'} className="yu-stack" data-testid="settings.about"><Card><CardContent><div className="flex items-center gap-4 py-4" data-testid="settings.about.brand"><img src={logo} alt="" width={64} height={64} /><div><h2 className="text-lg font-bold">{CHANNEL.displayName}</h2><p>{t('app.sub', undefined, language)}</p></div></div><div className="space-y-3 pb-4"><VersionLine info={app?.application} language={language} testId="settings.about.version" /><AboutUpdateCheck view={app?.update} language={language} /></div><details className="yu-font-license" data-testid="settings.about.font-license"><summary>Huninn · SIL Open Font License 1.1</summary><pre data-license-asset={huninnFontLicenseUrl}>{huninnFontLicense}</pre></details></CardContent></Card><UninstallCard language={language} /></div>
          </div>
        </div>
      </main></div>
    </div>
  </div>;
}
