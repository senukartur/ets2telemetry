import type {MediaTrack} from '../../../../packages/contracts/src/now-playing';
/** Only a recent credible Windows timeline anchor with a positive rate may advance. */
export function progress(track: MediaTrack, now: number): {position: number; duration: number; fraction: number} | null {
  const t = track.timeline;
  if (!t || t.end <= t.start) return null;
  const elapsed = now - t.lastUpdatedUtc;
  const advance = track.playback === 'playing' && t.rate !== null && t.rate > 0 && elapsed >= 0 && elapsed <= 86400000 ? elapsed * t.rate : 0;
  const position = Math.max(0, Math.min(t.end - t.start, t.position - t.start + advance));
  return {position, duration: t.end - t.start, fraction: position / (t.end - t.start)};
}
export const mediaTime = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
