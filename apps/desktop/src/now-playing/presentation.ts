import type {MediaTrack} from '../../../../packages/contracts/src/now-playing';
/** Display aliases only: keep the original Windows identity and session token for selection. */
export function mediaSourceName(source: string): string {
  const name = source.trim(), executable = name.split(/[\\/]/).at(-1)?.toLowerCase();
  if (/^spotifyab\.spotifymusic_[a-z0-9]+!spotify$/i.test(name) || executable === 'spotify' || executable === 'spotify.exe') return 'Spotify';
  if (executable === 'chrome' || executable === 'chrome.exe' || executable === 'google chrome') return 'Chrome';
  if (executable === 'msedge' || executable === 'msedge.exe' || executable === 'microsoft edge') return 'Microsoft Edge';
  if (executable === 'firefox' || executable === 'firefox.exe') return 'Firefox';
  return name;
}
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
