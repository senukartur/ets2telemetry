import {expect, it} from 'vitest';
import {mediaSourceName, mediaTime, progress} from '../../apps/desktop/src/now-playing/presentation';
import type {MediaTrack} from '../../packages/contracts/src';
const track: MediaTrack = {id: 's1', revision: 1, title: null, artist: null, album: null, artwork: null, playback: 'playing', timeline: {start: 1000, end: 101000, position: 11000, lastUpdatedUtc: 100000, rate: 1}};
it.each([
  ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'Spotify'],
  ['spotifyab.spotifymusic_zpdnekdrzrea0!spotify', 'Spotify'],
  ['Spotify.exe', 'Spotify'], ['C:\\Users\\fixture\\Spotify.exe', 'Spotify'],
  ['chrome.exe', 'Chrome'], ['Chrome', 'Chrome'], ['msedge.exe', 'Microsoft Edge'], ['firefox.exe', 'Firefox'],
  ['Vendor.OtherPlayer_abcd!Player', 'Vendor.OtherPlayer_abcd!Player'], ['Synthetic Chrome', 'Synthetic Chrome'],
])('presents Windows source %s as %s without inventing a browser service', (source, expected) => {
  expect(mediaSourceName(source)).toBe(expected);
});
it('interpolates credible playing anchors and clamps to the timeline', () => {
  expect(progress(track, 102000)).toEqual({position: 12000, duration: 100000, fraction: 0.12});
  expect(progress({...track, timeline: {...track.timeline!, position: 100000}}, 105000)).toEqual({position: 100000, duration: 100000, fraction: 1});
  expect(mediaTime(125000)).toBe('2:05');
});
it('freezes paused, unknown-rate, invalid-rate and implausible anchors, and omits unavailable timelines', () => {
  expect(progress({...track, playback: 'paused'}, 105000)?.position).toBe(10000);
  for (const rate of [null, 0, -1]) expect(progress({...track, timeline: {...track.timeline!, rate}}, 105000)?.position).toBe(10000);
  expect(progress(track, 99999)?.position).toBe(10000);
  expect(progress(track, 86500001)?.position).toBe(10000);
  expect(progress({...track, timeline: null}, 105000)).toBeNull();
});
