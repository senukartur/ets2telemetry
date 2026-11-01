import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {NowPlayingBridge, NowPlayingDisplay} from '../../../../packages/contracts/src/now-playing';
import {mediaTime, progress} from './presentation';
import {t} from '../i18n';
import './styles.css';
declare global {interface Window {nowPlaying: NowPlayingBridge}}
export function CurrentTrack({display}: {display: NowPlayingDisplay}) {
  const [now, setNow] = useState(Date.now);
  const track = display.track;

  useEffect(() => {
    if (track?.playback !== 'playing' || !track.timeline || track.timeline.rate === null || track.timeline.rate <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer);
  }, [track]);
  if (!track && !display.editing) return null;
  const full = display.style === 'full', timeline = track && progress(track, now);
  const text = (key: Parameters<typeof t>[0]) => t(key, undefined, display.language);
  return <section className={`np-panel np-${display.style}${display.editing ? ' np-editing' : ''}`} style={{backgroundColor: `rgb(11 17 32 / ${display.backgroundOpacity / 100})`}} data-testid="now-playing-panel" lang={display.language}>
    {full && track?.artwork ? <Cover key={`${track.id}:${track.revision}`} png={track.artwork.png} /> : null}
    <div className="np-content">
      <div className="np-title">{track?.title || text('np.title')}</div>
      {track?.artist ? <div className="np-artist">{track.artist}</div> : null}
      {full && track?.album ? <div className="np-album">{track.album}</div> : null}
      <div className="np-status">{track?.playback === 'paused' ? <span>{text('np.paused')}</span> : null}{full && display.source ? <span>{display.source}</span> : null}{display.editing ? <span>{text('np.drag')}</span> : null}</div>
      {full && timeline ? <div className="np-timeline"><div className="np-progress"><span style={{width: `${timeline.fraction * 100}%`}} /></div><div className="np-times"><span>{mediaTime(timeline.position)}</span><span>{mediaTime(timeline.duration)}</span></div></div> : null}
    </div>
  </section>;
}
function Cover({png}: {png: string}) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {type: 'image/png'}));
    const element = image.current; if (element) element.src = url;
    return () => {if (element) element.removeAttribute('src'); URL.revokeObjectURL(url);};
  }, [png]);
  return <img ref={image} className="np-artwork" alt="" />;
}
function Widget() {
  const [display, setDisplay] = useState<NowPlayingDisplay>();
  useEffect(() => window.nowPlaying.subscribeNowPlaying(setDisplay), []);
  return display ? <CurrentTrack display={display} /> : null;
}
if (typeof document !== 'undefined') createRoot(document.getElementById('root')!).render(<Widget />);
