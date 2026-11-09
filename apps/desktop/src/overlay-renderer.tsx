import React, {useEffect, useMemo, useState} from 'react';
import type {OverlayPresentation} from '../../../packages/contracts/src';
import {OverlayContent} from './overlay-content';
export {OverlayContent} from './overlay-content';
import {overlayView} from './overlay-view';
import {latencyBits, MARKER_CELL, MARKER_HEIGHT} from './latency-marker';
import './renderer.css';

export default function Overlay() {
  const [live, setLive] = useState<OverlayPresentation>();
  useEffect(() => window.overlay.subscribeOverlay(setLive), []);
  const view = useMemo(() => overlayView(live), [live]);
  // While editing (ET-012b) the whole root is a native drag region; main alone makes the window movable and interactive.
  return <main data-testid="overlay-root" className={`overlay overlay-${view.layout}${view.dim ? ' is-dim' : ''}${view.editing ? ' is-editing' : ''}`} aria-label="Telemetry overlay"
    data-layout={view.layout} data-source={view.source} data-origin={view.origin} data-status={view.status} data-freshness={view.freshness}
    data-paused={String(view.paused)} data-editing={String(view.editing)}>
    {live?.diagnosticFrame !== undefined ? <div aria-hidden="true" data-testid="latency-marker" style={{position: 'fixed', left: 0, top: 0,
      width: MARKER_CELL * 32, height: MARKER_HEIGHT, display: 'flex', opacity: 1, pointerEvents: 'none', zIndex: 2147483647}}>
      {latencyBits(live.diagnosticFrame).map((bit, index) => <span key={index} style={{display: 'block', flex: 'none', width: MARKER_CELL,
        height: MARKER_HEIGHT, background: bit ? '#fff' : '#000'}} />)}
    </div> : null}
    <OverlayContent view={view} />
  </main>;
}
