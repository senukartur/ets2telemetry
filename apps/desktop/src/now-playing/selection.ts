import type {MediaSession, MediaTrack, NowPlayingSelection} from '../../../../packages/contracts/src/now-playing';
/** Native owns Automatic history; main independently enforces session correlation and the highest playback tier. */
export function acceptsSelectedSession(sessions: readonly MediaSession[], selection: NowPlayingSelection, track: MediaTrack | null): boolean {
  if (!track) return true;
  const session = sessions.find(item => item.id === track.id && item.playback === track.playback);
  if (!session || (session.playback !== 'playing' && session.playback !== 'paused')) return false;
  if (selection.kind === 'session') return session.id === selection.id;
  return session.playback === (sessions.some(item => item.playback === 'playing') ? 'playing' : 'paused');
}
/** IDs are helper-lifetime tokens; explicit selection never silently falls back. */
export function selectSession(sessions: readonly MediaSession[], selection: NowPlayingSelection, previous: string | null): MediaSession | undefined {
  if (selection.kind === 'session') return sessions.find(session => session.id === selection.id);
  for (const playback of ['playing', 'paused']) {
    const candidates = sessions.filter(session => session.playback === playback);
    const retained = candidates.find(session => session.id === previous);
    if (retained) return retained;
    if (candidates.length) return candidates.find(session => session.current) ?? candidates.sort((a, b) => a.sourceAppId < b.sourceAppId ? -1 : a.sourceAppId > b.sourceAppId ? 1 : a.id < b.id ? -1 : 1)[0];
  }
  return undefined;
}
