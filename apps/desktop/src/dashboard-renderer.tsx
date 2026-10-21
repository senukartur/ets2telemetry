import {HardModeCard} from './hard-mode/card';
import React, {useEffect, useState} from 'react';
import type {AppLanguage, AppState, LiveTelemetry, SettingsView, SourceSelection, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {dashboardFuel, dashboardSpeed} from './speed-display';
import {createStartupLine} from './dashboard-startup';
import {recordingStatusText} from './recording-status-text';
import {LiveDashboard} from './live-dashboard';
import {LanguageCard} from './language-card';
import {OverlaySettingsCard} from './overlay-settings-card';
import {PluginSetupCard} from './plugin-setup-card';
import {UninstallCard} from './uninstall-card';
import {connectionDiagnosis} from './connection-diagnosis';
import {Journal, JournalBoundary} from './journal';
import {DEFAULT_UNIT_PROFILES, displayProfile, isUnitProfile, UNIT_GAMES, UNIT_PROFILE_IDS} from './unit-profiles';
import {
  getAppErrorText, getServiceHealthText, getSettingsSaveErrorText, getSettingsStateText,
  getStorageHealthText, getStrings, getUnitGameText, getUnitProfileText
} from './strings';
import {t} from './i18n';
import './index.css';

export default function App() {
  const [startup, setStartup] = useState<string>('Starting');
  const [live, setLive] = useState<LiveTelemetry>();
  const [app, setApp] = useState<AppState>();
  const [exit, setExit] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [units, setUnits] = useState<'idle' | 'saving' | 'failed'>('idle');
  // Main reports one `saveError` for the whole settings file; it is shown in the card whose request caused it.
  const [lastCard, setLastCard] = useState<'units' | 'overlay' | 'language'>('units');
  const [startupLine] = useState(() => createStartupLine(() => window.desktop.getStatus(), setStartup));
  useEffect(() => {
    startupLine.start();
    return window.desktop.subscribeLive(setLive);
  }, [startupLine]);
  useEffect(() => window.desktop.subscribeAppState(state => {setApp(state); startupLine.health(state.health);}), [startupLine]);

  const settings = app?.settings;
  const language: AppLanguage = settings?.language ?? 'en';
  const strings = getStrings(language);
  const health = app?.health;
  const problem = health && (health.service === 'failed' || health.service === 'restarting') && health.lastError;
  // ET-015c PR-4 (G8): the recording status text; until main's first push the status is not known.
  const recording = recordingStatusText(health?.recording ?? {state: 'unknown'}, language);
  const recordingAlertVariant = health?.recording.state === 'retrying' ? 'default' : 'destructive';
  // Main pushes the saved settings; until the first push the ET-000 defaults apply.
  const profile = displayProfile(live, settings?.units);
  const saved = (view: SettingsView) => setApp(current => current && {...current, settings: view});
  const choose = (game: UnitGame, value: string) => {
    if (!isUnitProfile(value)) return;
    setLastCard('units'); setUnits('saving');
    void window.desktop.setUnitProfile(game, value).then(view => {
      saved(view); setUnits('idle');
    }, () => setUnits('failed'));
  };

  // ET-016 PR-4 (J12): Live (the default) and Journal tabs. The Live tab stays mounted while hidden, so its cards keep
  // their state; Radix does not hide a force-mounted panel, so its inactive state hides it. The Journal tab mounts when
  // opened, loads its first page then and holds nothing while closed. The tab list is one compact row, so the status,
  // speed and fuel lines stay in the first viewport (B6).
  return <main className="mx-auto max-w-xl p-4"><Tabs defaultValue="live">
  <TabsList><TabsTrigger value="live" data-testid="tab-live">{t('nav.live', undefined, language)}</TabsTrigger>
    <TabsTrigger value="journal" data-testid="tab-journal">{t('nav.journal', undefined, language)}</TabsTrigger></TabsList>
  <TabsContent value="live" forceMount className="space-y-4 data-[state=inactive]:hidden"><Card><CardHeader><CardTitle><h1>ETS2Telemetry</h1></CardTitle></CardHeader><CardContent className="space-y-2"><p>{startup}</p>
    <label>{strings.sourceLabel} <select value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup(strings.sourceSelectionFailed));}}>
      <option value="game">{strings.sourceSelectPrompt}</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">{strings.sourceSyntheticFixture}</option><option value="replay">{strings.sourceReplayFixture}</option>
    </select></label>
    <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? 'Awaiting telemetry service'}</p>
    <p>Origin: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {live?.fresh ? 'current' : 'not current'}; interval coverage unknown.</p>
    <p data-testid="speed">{strings.speedLabel}: {dashboardSpeed(live, profile, language)}</p>
    <p data-testid="fuel">{strings.fuelLabel}: {dashboardFuel(live, profile, language)}</p>
    <p data-testid="prototype-notice">{recording.notice}</p>
  </CardContent></Card>
  <LiveDashboard live={live} units={settings?.units} />
  <HardModeCard />
  <Card size="sm"><CardHeader><CardTitle><h2>{strings.healthTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-2">
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
    <Button variant="destructive" disabled={exit === 'pending'} data-testid="exit-application"
      onClick={() => {setExit('pending'); void window.desktop.exitApplication().catch(() => setExit('failed'));}}>
      {exit === 'pending' ? strings.exitPending : strings.exitAction}
    </Button>
    {exit === 'failed' ? <p role="status">{strings.exitFailed}</p> : null}
  </CardContent></Card>
  {/* ET-017 PR-5 (P18): the Game plugin card, after the Application status card. */}
  <PluginSetupCard view={app?.plugins} diagnosis={app ? connectionDiagnosis(app.plugins, live?.status ?? 'waiting', live?.selection ?? 'game', app.health) : undefined} onView={plugins => setApp(current => current && {...current, plugins})} />
  <LanguageCard settings={settings} onSaved={saved} onRequest={() => setLastCard('language')} showSaveError={lastCard === 'language'} />
  <Card size="sm"><CardHeader><CardTitle><h2>{strings.unitsTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-3">
    {UNIT_GAMES.map(game => <div key={game} className="space-y-2">
      <p id={`units-${game}-label`}>{getUnitGameText(game, language)}</p>
      {/* A choice shows as selected only after main saved it; a failed save leaves the previous one. */}
      <RadioGroup aria-labelledby={`units-${game}-label`} data-testid={`units-${game}`} value={settings?.units[game] ?? DEFAULT_UNIT_PROFILES[game]}
        disabled={!settings?.writable || units === 'saving'} onValueChange={value => choose(game, value)}>
        {UNIT_PROFILE_IDS.map(option => <div key={option} className="flex items-center gap-2">
          <RadioGroupItem value={option} id={`units-${game}-${option}`} /><Label htmlFor={`units-${game}-${option}`}>{getUnitProfileText(option, language)}</Label>
        </div>)}
      </RadioGroup>
    </div>)}
    <p data-testid="settings-state">{settings ? getSettingsStateText(settings.state, language) : '—'}</p>
    {/* A refused save is reported by main in the settings view; other request failures only locally. */}
    {settings?.saveError && lastCard === 'units' ? <p role="status" data-testid="settings-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
      : units === 'failed' ? <p role="status" data-testid="settings-error">{strings.unitsSaveFailed}</p> : null}
  </CardContent></Card>
  <OverlaySettingsCard settings={settings} edit={app?.overlayEdit} onSaved={saved} onRequest={() => setLastCard('overlay')} showSaveError={lastCard === 'overlay'} />
  <UninstallCard />
  </TabsContent>
  <TabsContent value="journal"><JournalBoundary><Journal units={settings?.units} recording={health?.recording.state} language={language} /></JournalBoundary></TabsContent></Tabs></main>;
}
