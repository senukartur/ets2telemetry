import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DesktopBridge, LiveTelemetry, OverlayBridge, OverlayPresentation, SourceSelection} from '../../../packages/contracts/src';
import {dashboardSpeed} from './speed-display';
declare global {interface Window {desktop: DesktopBridge; overlay: OverlayBridge}}
function Overlay() {
  const [live, setLive] = useState<OverlayPresentation>();
  useEffect(() => window.overlay.subscribeOverlay(setLive), []);
  return <main className="overlay" aria-label="Telemetry overlay">
    <div className="overlay-source" data-testid="overlay-status">{live?.source ?? 'No game'} · {live?.origin ?? 'none'} · {live?.status ?? 'waiting'} · {live?.freshness ?? 'unavailable'}</div>
    <div className="overlay-metrics"><div><span className="overlay-label">Speed</span><strong data-testid="overlay-speed">{live?.speed ?? '—'}</strong><span>{live?.speedUnit ?? 'km/h'}</span></div>
      <div><span className="overlay-label">Fuel</span><strong data-testid="overlay-fuel">{live?.fuel ?? '—'}</strong><span>{live?.fuelUnit ?? 'L'}</span></div></div>
  </main>;
}
function App() {
  const [startup, setStartup] = useState('Starting');
  const [live, setLive] = useState<LiveTelemetry>();
  useEffect(() => {
    window.desktop.getStatus().then(() => setStartup('Telemetry service ready; isolated storage probe verified')).catch(() => setStartup('Startup failed'));
    return window.desktop.subscribeLive(setLive);
  }, []);
  const observed = live?.observation?.state;
  return <main><h1>ETS2Telemetry</h1><p>{startup}</p>
    <label>Source <select value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(() => setStartup('Source selection failed'));}}>
      <option value="game">Select a game</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option><option value="synthetic">Synthetic fixture</option><option value="replay">Replay fixture</option>
    </select></label>
    <p data-testid="telemetry-status">{live?.status ?? 'waiting'}: {live?.reason ?? 'Awaiting telemetry service'}</p>
    <p>Origin: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {live?.fresh ? 'current' : 'not current'}; interval coverage unknown.</p>
    <p data-testid="speed">Speed: {dashboardSpeed(live)}</p>
    <p data-testid="fuel">Fuel: {live?.fresh && observed?.fuel.available ? `${observed.fuel.value.toFixed(1)} L` : 'unavailable'}</p>
    <p>Prototype live display. No trip recording or durable history.</p>
  </main>;
}
const overlayView = new URLSearchParams(window.location.search).get('view') === 'overlay';
if (overlayView) document.body.classList.add('overlay-body');
createRoot(document.getElementById('root')!).render(overlayView ? <Overlay/> : <App/>);
