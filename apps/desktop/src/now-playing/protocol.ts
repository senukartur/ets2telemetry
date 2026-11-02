import type {MediaSession, MediaTrack, NowPlayingError} from '../../../../packages/contracts/src/now-playing';
import {exact, isId, isSession, isTrack, record} from './contract';
export const MAX_MEDIA_FRAME = 1024 * 1024;
export interface MediaSnapshot {version: 1; type: 'snapshot'; requestId: number; sessions: MediaSession[]; selected: MediaTrack | null; error: NowPlayingError | null}
export function parseSnapshot(value: unknown, requestId: number): MediaSnapshot | undefined {
  if (!record(value) || !exact(value, ['version', 'type', 'requestId', 'sessions', 'selected', 'error']) || value.version !== 1 || value.type !== 'snapshot' || value.requestId !== requestId || !Array.isArray(value.sessions) || value.sessions.length > 32 || !value.sessions.every(isSession)) return;
  const sessions = value.sessions;
  if (new Set(sessions.map(s => s.id)).size !== sessions.length || sessions.filter(s => s.current).length > 1) return;
  if (value.error !== null && value.error !== 'API_ERROR' && value.error !== 'SESSION_LIMIT') return;
  if (value.error !== null && (sessions.length || value.selected !== null)) return;
  const selected = value.selected;
  if (selected !== null && (!isTrack(selected) || !sessions.some(s => s.id === selected.id && s.playback === selected.playback))) return;
  return value as unknown as MediaSnapshot;
}
/** Streaming parser retains at most one bounded payload, regardless of incoming chunk sizes. */
export class MediaFrames {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private payload?: Buffer;
  private used = 0;
  push(chunk: Buffer, receive: (value: unknown) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count); offset += count; this.headerUsed += count;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32LE();
        if (length < 2 || length > MAX_MEDIA_FRAME) throw new Error('Invalid media frame');
        this.payload = Buffer.alloc(length); this.used = 0;
      }
      const count = Math.min(this.payload.length - this.used, chunk.length - offset);
      chunk.copy(this.payload, this.used, offset, offset + count); offset += count; this.used += count;
      if (this.used !== this.payload.length) continue;
      const payload = this.payload; this.payload = undefined; this.headerUsed = 0;
      receive(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload)));
    }
  }
}
export function snapshotCommand(requestId: number, selectedId: string | null): Buffer {
  if (!Number.isSafeInteger(requestId) || requestId < 1 || (selectedId !== null && !isId(selectedId))) throw new Error('Invalid media command');
  const payload = Buffer.from(JSON.stringify({version: 1, type: 'snapshot', requestId, selectedId}));
  if (payload.length > 1024) throw new Error('Invalid media command');
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
}
