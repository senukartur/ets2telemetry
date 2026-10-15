import React, {useEffect, useState} from 'react';
import type {AppState, LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {dashboardSpeed} from './speed-display';
import {createStartupLine} from './dashboard-startup';
import {APP_ERROR_TEXT, SERVICE_HEALTH_TEXT, STORAGE_HEALTH_TEXT, STRINGS} from './strings';
import './index.css';

export default function App() {
  const [startup, setStartup] = useState<string>(STRINGS.startupPending);
  const [live, setLive] = useState<LiveTelemetry>();
  const [app, setApp] = useState<AppState>();
  const [exit, setExit] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [startupLine] = useState(() => createStartupLine(() => window.desktop.getStatus(), setStartup));
  useEffect(() => {
    startupLine.start();
    return window.desktop.subscribeLive(setLive);
  }, [startupLine]);
  useEffect(() => window.desktop.subscribeAppState(state => {setApp(state); startupLine.health(state.health);}), [startupLine]);
  const observed = live?.observation?.state;
  const health = app?.health;
  const problem = health && (health.service === 'failed' || health.service === 'restarting') && health.lastError;
  return <main className="mx-auto max-w-xl space-y-4 p-4"><Card><CardHeader><CardTitle><h1>ETS2Telemetry</h1></CardTitle></CardHeader><CardContent className="space-y-2"><p>{startup}</p>
    <label>Source <select value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup(STRINGS.sourceSelectionFailed));}}>
      <option value="game">Select a game</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">Synthetic fixture</option><option value="replay">Replay fixture</option>
    </select></label>
    <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? 'Awaiting telemetry service'}</p>
    <p>Origin: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {live?.fresh ? 'current' : 'not current'}; interval coverage unknown.</p>
    <p data-testid="speed">Speed: {dashboardSpeed(live)}</p>
    <p data-testid="fuel">Fuel: {live?.fresh && observed?.fuel.available ? `${observed.fuel.value.toFixed(1)} L` : 'unavailable'}</p>
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
  </CardContent></Card></main>;
}
