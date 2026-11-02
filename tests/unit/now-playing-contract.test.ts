import {expect, it} from 'vitest';
import {isArtwork, isDisplay, isPosition, isSelection, isTrack} from '../../apps/desktop/src/now-playing/contract';
import {parseSnapshot} from '../../apps/desktop/src/now-playing/protocol';
const track = {id: 's1', revision: 1, title: 'Synthetic track', artist: null, album: null, playback: 'playing', artwork: null, timeline: null};
it('accepts bounded literal metadata while rejecting controls, identifiers, oversized text and unknown fields', () => {
  expect(isTrack({...track, title: '<script>literal</script>'})).toBe(true);
  for (const patch of [{title: 'x'.repeat(1025)}, {title: 'new\nline'}, {id: 'https://example.test'}, {revision: 0}, {url: 'file:///secret'}, {timeline: {start: 0, end: 1, position: 2, lastUpdatedUtc: 0, rate: null}}]) expect(isTrack({...track, ...patch})).toBe(false);
  expect(isSelection({kind: 'session', id: 's1', executable: 'cmd.exe'})).toBe(false);
  expect(isSelection({kind: 'automatic'})).toBe(true);
  expect(isPosition({displayId: null, x: 1, y: 0.75})).toBe(true);
  expect(isPosition({displayId: null, x: Infinity, y: 0})).toBe(false);
});
it('fences response request/session/playback identity and clears on error', () => {
  const response = {version: 1, type: 'snapshot', requestId: 7, sessions: [{id: 's1', sourceAppId: 'Synthetic player', playback: 'playing', current: true}], selected: track, error: null};
  expect(parseSnapshot(response, 7)).toEqual(response);
  expect(parseSnapshot(response, 8)).toBeUndefined();
  expect(parseSnapshot({...response, selected: {...track, id: 's2'}}, 7)).toBeUndefined();
  expect(parseSnapshot({...response, sessions: [...response.sessions, ...response.sessions]}, 7)).toBeUndefined();
  expect(parseSnapshot({...response, error: 'API_ERROR'}, 7)).toBeUndefined();
});
it('only accepts a bounded PNG with declared IHDR dimensions, never URLs', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  expect(isArtwork({png, width: 1, height: 1})).toBe(true);
  expect(isArtwork({png, width: 2, height: 1})).toBe(false);
  expect(isArtwork({png: 'https://example.test/cover.png', width: 1, height: 1})).toBe(false);
  expect(isArtwork({png: 'A'.repeat(349532), width: 1, height: 1})).toBe(false);
  expect(isDisplay({generation: 1, language: 'en', style: 'minimal', backgroundOpacity: 40, editing: false, source: null, track})).toBe(true);
});
