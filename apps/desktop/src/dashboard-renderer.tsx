import {recordingTone, connectionTone, pluginTone, hardModeTone, pluginStatusText} from './screens/desktop-ui-view';
import {HardModeCard} from './hard-mode/card';
import React, {useEffect, useRef, useState} from 'react';
import type {AppLanguage, AppState, LiveTelemetry, SettingsView, SourceSelection, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Badge} from '@/components/ui/badge';
import {DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {Gauge, BookOpen, Settings2, Cloud, Globe, Power, ChevronDown, Flame, Plug, CircleHelp} from 'lucide-react';
import {useHardModeStatus} from './hard-mode/use-status';
import {hardModeView} from './hard-mode/view';
import {useLanguageController} from './shell/use-language';
import logo from './assets/logo.png';
import onestLicense from './assets/onest-OFL.txt?raw';
import onestLicenseUrl from './assets/onest-OFL.txt?url';
import {createStartupLine} from './dashboard-startup';
import {recordingStatusText} from './recording-status-text';
import {LiveDashboard} from './live-dashboard';
import {LanguageCard} from './language-card';
import {AutostartCard} from './autostart-card';
import {OverlaySettingsCard} from './overlay-settings-card';
import {GearDisplayCard} from './gear-display-card';
import {PluginSetupCard} from './plugin-setup-card';
import {UninstallCard} from './uninstall-card';
import {connectionDiagnosis} from './connection-diagnosis';
import {Journal, JournalBoundary} from './journal';
import {DEFAULT_UNIT_PROFILES, isUnitProfile, UNIT_GAMES, UNIT_PROFILE_IDS} from './unit-profiles';
import {
  getAppErrorText, getServiceHealthText, getSettingsSaveErrorText, getSettingsStateText,
  getStorageHealthText, getStrings, getUnitGameText, getUnitProfileText
} from './strings';
import {t} from './i18n';
import './index.css';

export default function App() {
  const [route, setRoute] = useState<'live' | 'hardMode' | 'journal' | 'settings' | 'account'>('live');
  const [panel, setPanel] = useState<'general' | 'units' | 'overlay' | 'plugin' | 'data' | 'about'>('general');
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
  const recordingAlertVariant = health?.recording.state === 'retrying' ? 'default' : 'destructive';
  // Main pushes the saved settings; until the first push the ET-000 defaults apply.
  const saved = (view: SettingsView) => setApp(current => current && {...current, settings: view});
  const languageController = useLanguageController(settings, saved, () => setLastCard('language'));
  const hmView = hardModeView(hardMode.status, hardMode.now, language);
  const targets = app ? Object.values(app.plugins.games).flatMap(game => game.targets) : [];
  const installed = targets.filter(target => target.state === 'installed').length;
  const choose = (game: UnitGame, value: string) => {
    if (!isUnitProfile(value)) return;
    setLastCard('units'); setUnits('saving');
    void window.desktop.setUnitProfile(game, value).then(view => {
      saved(view); setUnits('idle');
    }, () => setUnits('failed'));
  };

  const nav = [{id: 'live', Icon: Gauge}, {id: 'hardMode', Icon: Flame}, {id: 'journal', Icon: BookOpen}, {id: 'settings', Icon: Settings2}, {id: 'account', Icon: Cloud}] as const;
  const settingsPanels = ['general', 'units', 'overlay', 'plugin', 'data', 'about'] as const;
  return <div className="yu-app" data-testid="shell.root">
    <div className="yu-titlebar" data-testid="shell.titlebar"><img src={logo} alt="" /><span>Yukon Union Telemetry</span></div>
    <div className="yu-body"><aside className="yu-sidebar" data-testid="shell.sidebar"><div className="yu-lockup" data-testid="shell.sidebar.lockup"><img src={logo} alt="" /><div><strong>Yukon Union</strong><small>{t('app.sub', undefined, language)}</small></div></div>
      <nav aria-label={t('app.window', undefined, language)}>{nav.map(({id, Icon}) => <React.Fragment key={id}>
        {id === 'live' || id === 'settings' || id === 'account' ? <p className="yu-nav-group">{t(id === 'live' ? 'nav.group.drive' : id === 'settings' ? 'nav.group.app' : 'nav.group.company', undefined, language)}{id === 'account' ? ` · ${t('tag.later', undefined, language)}` : ''}</p> : null}
        <button type="button" className="yu-nav-item" aria-current={route === id ? 'page' : undefined} onClick={() => setRoute(id)} data-testid={`tab-${id}`}><Icon aria-hidden="true" />{t(`nav.${id}`, undefined, language)}</button>
      </React.Fragment>)}</nav>
      <div className="yu-sidebar-footer"><div className="yu-recording" data-testid="shell.sidebar.recording"><strong><span className="yu-dot" data-tone={recordingTone(health?.recording.state)} data-testid="shell.recording.indicator" />{recording.short}</strong><p>{recording.detail[0] ?? recording.notice}</p></div>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" className="w-full" data-testid="shell.language"><Globe aria-hidden="true" />{language.toUpperCase()}<ChevronDown aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuRadioGroup value={language} onValueChange={languageController.choose}>{(['en', 'ru'] as const).map(lang => <DropdownMenuRadioItem key={lang} value={lang} disabled={!settings?.writable || languageController.saving} data-testid={`shell.language.${lang}`}>{t(`lang.${lang}`, undefined, language)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent>
        </DropdownMenu>
        {languageController.failed ? <p role="status">{t('lang.saveFailed', undefined, language)}</p> : null}
        <Button variant="ghost" className="mt-2 w-full" disabled={exit === 'pending'} data-testid="exit-application" onClick={() => {setExit('pending'); void window.desktop.exitApplication().catch(() => setExit('failed'));}}><Power aria-hidden="true" />{exit === 'pending' ? strings.exitPending : t('side.exit', undefined, language)}</Button>
        {exit === 'failed' ? <p role="status">{strings.exitFailed}</p> : null}
      </div></aside>
      <div className="yu-column"><header className="yu-topbar" data-testid="shell.topbar"><h1 ref={heading} tabIndex={-1} data-testid="screen-title">{t(`nav.${route}`, undefined, language)}</h1>
        <Badge variant={connectionTone(live?.status)} data-testid="shell.status.connection"><Gauge aria-hidden="true" />{live?.observation?.source.game.toUpperCase() ?? ''} {t(`ui.status.${live?.status ?? 'waiting'}`, undefined, language)}</Badge>
        <Badge variant={pluginTone(targets)} data-testid="shell.status.plugin"><Plug aria-hidden="true" />{t('ui.plugin', undefined, language)} {installed}/{targets.length} · {pluginStatusText(targets, language)}</Badge>
        <Badge variant={hardModeTone(hardMode.status)} data-testid="shell.status.hardMode"><Flame aria-hidden="true" />{hmView.headline}</Badge>
      </header><main ref={content} className="yu-content" data-testid="shell.content">
        <div hidden={route !== 'live'} className="yu-stack" data-testid="live.screen">
          <LiveDashboard live={live} units={settings?.units} gearDisplay={settings?.gearDisplay} gearboxes={settings?.gearboxGearDisplay} language={language} />
          <p data-testid="prototype-notice" className="yu-muted">{recording.notice}</p>
        </div>
        <div hidden={route !== 'hardMode'} className="yu-stack" data-testid="hardMode.screen"><HardModeCard language={language} controller={hardMode} /></div>
        {route === 'journal' ? <JournalBoundary language={language}><Journal units={settings?.units} recording={health?.recording.state} language={language} /></JournalBoundary> : null}
        <div hidden={route !== 'settings'} className="yu-settings" data-testid="settings.screen"><nav className="yu-settings-nav" aria-label={t('nav.settings', undefined, language)} data-testid="settings.nav">{settingsPanels.map(id => <button key={id} type="button" aria-current={panel === id ? 'page' : undefined} data-testid={`settings.nav.${id}`} onClick={() => setPanel(id)}>{t(`s.${id}`, undefined, language)}</button>)}</nav>
          <div className="yu-stack"><div hidden={panel !== 'general'} className="yu-stack" data-testid="settings.general"><LanguageCard settings={settings} onSaved={saved} controller={languageController} showSaveError={lastCard === 'language'} />
            <AutostartCard settings={settings} status={app?.autostart} onSaved={saved} onRequest={() => setLastCard('autostart')} showSaveError={lastCard === 'autostart'} />
            <Card><CardHeader><CardTitle><h2>{t('s.general', undefined, language)}</h2></CardTitle></CardHeader><CardContent className="space-y-3"><p>{t('s.closeD', undefined, language)}</p><p>{t('ui.helpNote', undefined, language)}</p><Button variant="outline" onClick={() => setPanel('plugin')}><CircleHelp aria-hidden="true" />{t('ob.s2', undefined, language)}</Button></CardContent></Card>
          </div><div hidden={panel !== 'units'} className="yu-stack" data-testid="settings.units">  <Card size="sm"><CardHeader><CardTitle><h2>{strings.unitsTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-3">
    {UNIT_GAMES.map(game => <div key={game} className="space-y-2">
      <p id={`units-${game}-label`}>{getUnitGameText(game, language)}</p>
      {/* A choice shows as selected only after main saved it; a failed save leaves the previous one. */}
      <RadioGroup aria-labelledby={`units-${game}-label`} data-testid={`units-${game}`} className="yu-segmented" value={settings?.units[game] ?? DEFAULT_UNIT_PROFILES[game]}
        disabled={!settings?.writable || units === 'saving'} onValueChange={value => choose(game, value)}>
        {UNIT_PROFILE_IDS.map(option => <div key={option} className="yu-segment-option">
          <RadioGroupItem value={option} id={`units-${game}-${option}`} /><Label htmlFor={`units-${game}-${option}`}>{getUnitProfileText(option, language)}</Label>
        </div>)}
      </RadioGroup>
    </div>)}
    <p data-testid="settings-state">{settings ? getSettingsStateText(settings.state, language) : '—'}</p>
    {/* A refused save is reported by main in the settings view; other request failures only locally. */}
    {settings?.saveError && lastCard === 'units' ? <p role="status" data-testid="settings-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
      : units === 'failed' ? <p role="status" data-testid="settings-error">{strings.unitsSaveFailed}</p> : null}
  </CardContent></Card>
  <GearDisplayCard settings={settings} live={live} onSaved={saved} onRequest={() => setLastCard('gear')} showSaveError={lastCard === 'gear'} />
</div>
          <div hidden={panel !== 'overlay'} data-testid="settings.overlay"><OverlaySettingsCard settings={settings} edit={app?.overlayEdit} onSaved={saved} onRequest={() => setLastCard('overlay')} showSaveError={lastCard === 'overlay'} />
            </div>
          <div hidden={panel !== 'plugin'} data-testid="settings.plugin"><PluginSetupCard language={language} view={app?.plugins} diagnosis={app ? connectionDiagnosis(app.plugins, live?.status ?? 'waiting', live?.selection ?? 'game', app.health) : undefined} onView={plugins => setApp(current => current && {...current, plugins})} /></div>
          <div hidden={panel !== 'data'} className="yu-stack" data-testid="settings.data"><Card><CardHeader><CardTitle><h2>{t('ui.diagnostics', undefined, language)}</h2></CardTitle></CardHeader><CardContent className="space-y-3"><p data-testid="startup-status">{startup}</p>
            <label>{strings.sourceLabel} <select data-testid="source-select" value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup(strings.sourceSelectionFailed));}}><option value="game">{strings.sourceSelectPrompt}</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">{strings.sourceSyntheticFixture}</option><option value="replay">{strings.sourceReplayFixture}</option></select></label>
            <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? strings.startupWaiting}</p><p>{t('ui.origin', undefined, language)}: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {t(live?.fresh ? 'ui.current' : 'ui.notCurrent', undefined, language)}; {t('ui.coverageUnknown', undefined, language)}.</p>
            <p>{t('s.d.location', undefined, language)} / {t('s.d.size', undefined, language)} — {t('ui.unavailable', undefined, language)}</p><p>{t('s.d.backupBtn', undefined, language)} — {t('ui.planned', undefined, language)}</p>
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
          <div hidden={panel !== 'about'} className="yu-stack" data-testid="settings.about"><Card><CardContent><div className="flex items-center gap-4 py-4" data-testid="settings.about.brand"><img src={logo} alt="" width={64} height={64} /><div><h2 className="text-lg font-bold">Yukon Union Telemetry</h2><p>{t('app.sub', undefined, language)}</p></div></div><p>{t('s.a.version', undefined, language)} — {t('ui.unavailable', undefined, language)}</p><details className="yu-font-license" data-testid="settings.about.font-license"><summary>Onest · SIL Open Font License 1.1</summary><pre data-license-asset={onestLicenseUrl}>{onestLicense}</pre></details></CardContent></Card><UninstallCard language={language} /></div>
          </div>
        </div>
        <div hidden={route !== 'account'} className="yu-placeholder" data-testid="account.screen"><Cloud aria-hidden="true" className="size-7" /><h2>{t('nav.account', undefined, language)}</h2><Badge variant="later">{t('a.later', undefined, language)}</Badge><p className="mt-3">{t('ui.accountNote', undefined, language)}</p><p className="mt-2">{t('a.note', undefined, language)}</p></div>
      </main></div>
    </div>
  </div>;
}
