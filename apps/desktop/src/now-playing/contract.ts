import type {MediaArtwork, MediaSession, MediaTrack, NowPlayingDisplay, NowPlayingPosition, NowPlayingSelection, NowPlayingSettings, NowPlayingStyle} from '../../../../packages/contracts/src/now-playing';

export const DEFAULT_NOW_PLAYING: NowPlayingSettings = Object.freeze({enabled: false, style: 'minimal', backgroundOpacity: 80, position: Object.freeze({displayId: null, x: 1, y: 0.75})});
export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isStyle = (value: unknown): value is NowPlayingStyle => value === 'minimal' || value === 'full';
export const isOpacity = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 40 && value <= 100;
export const isId = (value: unknown): value is string => typeof value === 'string' && /^s(?:[1-9][0-9]{0,9}|[a-fA-F0-9]{32}-[1-9][0-9]{0,9})$/.test(value);
export const isSelection = (value: unknown): value is NowPlayingSelection => record(value) && ((value.kind === 'automatic' && exact(value, ['kind'])) || (value.kind === 'session' && isId(value.id) && exact(value, ['kind', 'id'])));
export const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export const isPosition = (value: unknown): value is NowPlayingPosition => record(value) && exact(value, ['displayId', 'x', 'y']) && (value.displayId === null || (typeof value.displayId === 'string' && /^-?\d{1,16}$/.test(value.displayId))) && fraction(value.x) && fraction(value.y);
const playback = new Set(['playing', 'paused', 'stopped', 'closed', 'changing', 'unknown']);
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit && Array.from(value).every(c => c.charCodeAt(0) >= 32 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159));
export const isSession = (value: unknown): value is MediaSession => record(value) && exact(value, ['id', 'sourceAppId', 'playback', 'current']) && isId(value.id) && text(value.sourceAppId, 512) && playback.has(String(value.playback)) && typeof value.current === 'boolean';
/** PNG IHDR bounds are checked before Electron's decoder allocates any pixels. */
export function isArtwork(value: unknown): value is MediaArtwork {
  if (!record(value) || !exact(value, ['png', 'width', 'height']) || typeof value.png !== 'string' || value.png.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.png)) return false;
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || Number(value.width) < 1 || Number(value.height) < 1 || Number(value.width) > 512 || Number(value.height) > 512) return false;
  try {
    const bytes = Uint8Array.from(atob(value.png), c => c.charCodeAt(0));
    if (bytes.length < 33 || bytes.length > 262144 || [137,80,78,71,13,10,26,10].some((b, i) => bytes[i] !== b)) return false;
    const view = new DataView(bytes.buffer);
    return view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452 && view.getUint32(16) === value.width && view.getUint32(20) === value.height;
  } catch {return false;}
}
export function isTrack(value: unknown): value is MediaTrack {
  if (!record(value) || !exact(value, ['id', 'revision', 'title', 'artist', 'album', 'playback', 'timeline', 'artwork']) || !isId(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !playback.has(String(value.playback))) return false;
  if (![value.title, value.artist, value.album].every(v => v === null || text(v, 1024)) || (value.artwork !== null && !isArtwork(value.artwork))) return false;
  const t = value.timeline;
  return t === null || (record(t) && exact(t, ['start', 'end', 'position', 'lastUpdatedUtc', 'rate']) && [t.start, t.end, t.position, t.lastUpdatedUtc].every(v => Number.isSafeInteger(v) && Number(v) >= 0) && Number(t.end) > Number(t.start) && Number(t.position) >= Number(t.start) && Number(t.position) <= Number(t.end) && (t.rate === null || typeof t.rate === 'number' && Number.isFinite(t.rate)));
}
export function isDisplay(value: unknown): value is NowPlayingDisplay {
  return record(value) && exact(value, ['generation', 'language', 'style', 'backgroundOpacity', 'editing', 'source', 'track']) && Number.isSafeInteger(value.generation) && Number(value.generation) >= 0 && (value.language === 'en' || value.language === 'ru') && isStyle(value.style) && isOpacity(value.backgroundOpacity) && typeof value.editing === 'boolean' && (value.source === null || text(value.source, 512)) && (value.track === null || isTrack(value.track));
}
