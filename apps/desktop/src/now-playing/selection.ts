import type {MediaSession, MediaTrack, NowPlayingSelection} from '../../../../packages/contracts/src/now-playing';
/** Native owns Automatic history; main independently enforces session correlation and the highest playback tier. */
export function acceptsSelectedSession(sessions: readonly MediaSession[], selection: NowPlayingSelection, track: MediaTrack | null): boolean {
  if (!track) return true;
  const session = sessions.find(item => item.id === track.id && item.playback === track.playback);
  if (!session || (session.playback !== 'playing' && session.playback !== 'paused')) return false;
  if (selection.kind === 'session') return session.id === selection.id;
  return session.playback === (sessions.some(item => item.playback === 'playing') ? 'playing' : 'paused');
}
