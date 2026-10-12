import React, {useEffect, useState} from 'react';
import type {OverlayPresentation} from '../../../packages/contracts/src';
import './renderer.css';

export default function Overlay() {
  const [live, setLive] = useState<OverlayPresentation>();
  useEffect(() => window.overlay.subscribeOverlay(setLive), []);
  return <main className="overlay" aria-label="Telemetry overlay">
    <div className="overlay-source" data-testid="overlay-status">{live?.source ?? 'No game'} · {live?.origin ?? 'none'} · {live?.status ?? 'waiting'} · {live?.freshness ?? 'unavailable'}</div>
    <div className="overlay-metrics"><div><span className="overlay-label">Speed</span><strong data-testid="overlay-speed">{live?.speed ?? '—'}</strong><span>{live?.speedUnit ?? 'km/h'}</span></div>
      <div><span className="overlay-label">Fuel</span><strong data-testid="overlay-fuel">{live?.fuel ?? '—'}</strong><span>{live?.fuelUnit ?? 'L'}</span></div></div>
  </main>;
}
