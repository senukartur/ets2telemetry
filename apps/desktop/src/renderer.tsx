import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DesktopBridge, LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import './index.css';
declare global {interface Window {desktop: DesktopBridge}}
function App() {
  const [startup, setStartup] = useState('Starting');
  const [live, setLive] = useState<LiveTelemetry>();
  useEffect(() => {
    window.desktop.getStatus().then(() => setStartup('Telemetry service ready; isolated storage probe verified')).catch(() => setStartup('Startup failed'));
    return window.desktop.subscribeLive(setLive);
  }, []);
  const observed = live?.observation?.state;
  return <main className="mx-auto max-w-xl p-4"><Card><CardHeader><CardTitle><h1>ETS2Telemetry</h1></CardTitle></CardHeader><CardContent className="space-y-2"><p>{startup}</p>
    <label>Source <select value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup('Source selection failed'));}}>
      <option value="game">Select a game</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">Synthetic fixture</option><option value="replay">Replay fixture</option>
    </select></label>
    <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? 'Awaiting telemetry service'}</p>
    <p>Origin: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {live?.fresh ? 'current' : 'not current'}; interval coverage unknown.</p>
    <p data-testid="speed">Speed: {live?.fresh && observed?.speed.available ? `${(observed.speed.value * 3.6).toFixed(1)} km/h` : 'unavailable'}</p>
    <p data-testid="fuel">Fuel: {live?.fresh && observed?.fuel.available ? `${observed.fuel.value.toFixed(1)} L` : 'unavailable'}</p>
    <p>Prototype live display. No trip recording or durable history.</p>
  </CardContent></Card></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
