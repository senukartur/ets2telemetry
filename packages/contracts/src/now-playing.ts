export type NowPlayingStyle = 'minimal' | 'full';
export type MediaPlayback = 'playing' | 'paused' | 'stopped' | 'closed' | 'changing' | 'unknown';
export interface NowPlayingPosition {displayId: string | null; x: number; y: number}
export interface NowPlayingSettings {enabled: boolean; style: NowPlayingStyle; backgroundOpacity: number; position: NowPlayingPosition}
export type NowPlayingSelection = {kind: 'automatic'} | {kind: 'session'; id: string};
export interface MediaSession {id: string; sourceAppId: string; playback: MediaPlayback; current: boolean}
export interface MediaTimeline {start: number; end: number; position: number; lastUpdatedUtc: number; rate: number | null}
export interface MediaArtwork {png: string; width: number; height: number}
export interface MediaTrack {id: string; revision: number; title: string | null; artist: string | null; album: string | null; playback: MediaPlayback; timeline: MediaTimeline | null; artwork: MediaArtwork | null}
export type NowPlayingError = 'API_ERROR' | 'SESSION_LIMIT' | 'READER_UNAVAILABLE' | 'READER_TIMEOUT' | 'INVALID_RESPONSE';
export interface NowPlayingEditState {active: boolean; placement: 'visible' | 'not-foreground' | 'unavailable'}
/** The dashboard receives source identities and fixed states only, never track metadata or artwork. */
export interface NowPlayingView {
  state: 'disabled' | 'waiting' | 'playing' | 'paused' | 'no-session' | 'unavailable' | 'stopped' | 'error';
  sources: readonly MediaSession[]; selection: NowPlayingSelection; error: NowPlayingError | null; edit: NowPlayingEditState;
}
export interface NowPlayingDisplay {generation: number; language: 'en' | 'ru'; style: NowPlayingStyle; backgroundOpacity: number; editing: boolean; source: string | null; track: MediaTrack | null}
export interface NowPlayingBridge {subscribeNowPlaying(callback: (display: NowPlayingDisplay) => void): () => void}
