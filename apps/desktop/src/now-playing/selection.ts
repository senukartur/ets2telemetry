import type {MediaSession, NowPlayingSelection} from '../../../../packages/contracts/src/now-playing';
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
