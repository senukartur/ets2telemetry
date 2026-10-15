import React, {useEffect, useState} from 'react';
import type {AppState, LiveTelemetry, SourceSelection, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {dashboardFuel, dashboardSpeed} from './speed-display';
import {createStartupLine} from './dashboard-startup';
import {DEFAULT_UNIT_PROFILES, displayProfile, isUnitProfile, UNIT_GAMES, UNIT_PROFILE_IDS} from './unit-profiles';
import {APP_ERROR_TEXT, SERVICE_HEALTH_TEXT, SETTINGS_SAVE_ERROR_TEXT, SETTINGS_STATE_TEXT, STORAGE_HEALTH_TEXT, STRINGS, UNIT_GAME_TEXT, UNIT_PROFILE_TEXT} from './strings';
import './index.css';

export default function App() {
  const [startup, setStartup] = useState<string>(STRINGS.startupPending);
  const [live, setLive] = useState<LiveTelemetry>();
  const [app, setApp] = useState<AppState>();
  const [exit, setExit] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [units, setUnits] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [startupLine] = useState(() => createStartupLine(() => window.desktop.getStatus(), setStartup));
  useEffect(() => {
    startupLine.start();
    return window.desktop.subscribeLive(setLive);
  }, [startupLine]);
  useEffect(() => window.desktop.subscribeAppState(state => {setApp(state); startupLine.health(state.health);}), [startupLine]);
  const health = app?.health;
  const problem = health && (health.service === 'failed' || health.service === 'restarting') && health.lastError;
  const settings = app?.settings;
  // Main pushes the saved settings; until the first push the ET-000 defaults apply.
  const profile = displayProfile(live, settings?.units);
  const choose = (game: UnitGame, value: string) => {
    if (!isUnitProfile(value)) return;
    setUnits('saving');
    void window.desktop.setUnitProfile(game, value).then(view => {
      setApp(current => current && {...current, settings: view}); setUnits('idle');
    }, () => setUnits('failed'));
  };
  return <main className="mx-auto max-w-xl space-y-4 p-4"><Card><CardHeader><CardTitle><h1>ETS2Telemetry</h1></CardTitle></CardHeader><CardContent className="space-y-2"><p>{startup}</p>
    <label>Source <select value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup(STRINGS.sourceSelectionFailed));}}>
      <option value="game">Select a game</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">Synthetic fixture</option><option value="replay">Replay fixture</option>
    </select></label>
    <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? 'Awaiting telemetry service'}</p>
    <p>Origin: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {live?.fresh ? 'current' : 'not current'}; interval coverage unknown.</p>
    <p data-testid="speed">Speed: {dashboardSpeed(live, profile)}</p>
    <p data-testid="fuel">Fuel: {dashboardFuel(live, profile)}</p>
    <p>{STRINGS.prototypeNotice}</p>
  </CardContent></Card>
  <Card size="sm"><CardHeader><CardTitle><h2>{STRINGS.healthTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-2">
    {problem ? <Alert variant="destructive" data-testid="health-alert"><AlertTitle>{STRINGS.serviceFailedTitle}</AlertTitle><AlertDescription>{APP_ERROR_TEXT[problem]}</AlertDescription></Alert> : null}
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="app-health">
      <dt>{STRINGS.serviceLabel}</dt><dd data-testid="health-service">{health ? SERVICE_HEALTH_TEXT[health.service] : '—'}</dd>
      <dt>{STRINGS.storageLabel}</dt><dd data-testid="health-storage">{health ? STORAGE_HEALTH_TEXT[health.storage] : '—'}</dd>
      <dt>{STRINGS.recordingLabel}</dt><dd data-testid="health-recording">{STRINGS.recordingUnavailable}</dd>
      {health?.lastError && !problem ? <><dt>{STRINGS.lastErrorLabel}</dt><dd>{APP_ERROR_TEXT[health.lastError]}</dd></> : null}
    </dl>
    <Alert><AlertDescription data-testid="close-to-tray">{STRINGS.closeToTray}</AlertDescription></Alert>
    <Button variant="destructive" disabled={exit === 'pending'} data-testid="exit-application"
      onClick={() => {setExit('pending'); void window.desktop.exitApplication().catch(() => setExit('failed'));}}>
      {exit === 'pending' ? STRINGS.exitPending : STRINGS.exitAction}
    </Button>
    {exit === 'failed' ? <p role="status">{STRINGS.exitFailed}</p> : null}
  </CardContent></Card>
  <Card size="sm"><CardHeader><CardTitle><h2>{STRINGS.unitsTitle}</h2></CardTitle></CardHeader><CardContent className="space-y-3">
    {UNIT_GAMES.map(game => <div key={game} className="space-y-2">
      <p id={`units-${game}-label`}>{UNIT_GAME_TEXT[game]}</p>
      {/* A choice shows as selected only after main saved it; a failed save leaves the previous one. */}
      <RadioGroup aria-labelledby={`units-${game}-label`} data-testid={`units-${game}`} value={settings?.units[game] ?? DEFAULT_UNIT_PROFILES[game]}
        disabled={!settings?.writable || units === 'saving'} onValueChange={value => choose(game, value)}>
        {UNIT_PROFILE_IDS.map(option => <div key={option} className="flex items-center gap-2">
          <RadioGroupItem value={option} id={`units-${game}-${option}`} /><Label htmlFor={`units-${game}-${option}`}>{UNIT_PROFILE_TEXT[option]}</Label>
        </div>)}
      </RadioGroup>
    </div>)}
    <p data-testid="settings-state">{settings ? SETTINGS_STATE_TEXT[settings.state] : '—'}</p>
    {/* A refused save is reported by main in the settings view; other request failures only locally. */}
    {settings?.saveError ? <p role="status" data-testid="settings-error">{SETTINGS_SAVE_ERROR_TEXT[settings.saveError]}</p>
      : units === 'failed' ? <p role="status" data-testid="settings-error">{STRINGS.unitsSaveFailed}</p> : null}
  </CardContent></Card></main>;
}
