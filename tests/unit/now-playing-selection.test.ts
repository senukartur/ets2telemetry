import {expect, it} from 'vitest';
import {acceptsSelectedSession} from '../../apps/desktop/src/now-playing/selection';
import type {MediaSession} from '../../packages/contracts/src';
const chrome: MediaSession = {id: 's2', sourceAppId: 'Chrome', playback: 'playing', current: false};
const player: MediaSession = {id: 's1', sourceAppId: 'Synthetic player', playback: 'paused', current: true};
it('validates native selection correlation/tier without duplicating its Automatic history', () => {
  const a = {...player, playback: 'playing' as const};
  const track = {id: chrome.id, revision: 1, title: null, artist: null, album: null, timeline: null, artwork: null, playback: 'playing' as const};
  expect(acceptsSelectedSession([a, chrome], {kind: 'automatic'}, track)).toBe(true);
  expect(acceptsSelectedSession([a, chrome], {kind: 'session', id: a.id}, track)).toBe(false);
  expect(acceptsSelectedSession([a, {...chrome, playback: 'paused'}], {kind: 'automatic'}, {...track, playback: 'paused'})).toBe(false);
  expect(acceptsSelectedSession([a], {kind: 'automatic'}, track)).toBe(false);
  expect(acceptsSelectedSession([a, chrome], {kind: 'automatic'}, {...track, playback: 'paused'})).toBe(false);
});
it('accepts paused-only Automatic and explicit paused sessions while rejecting stopped selections', () => {
  const track = {id: player.id, revision: 1, title: null, artist: null, album: null, timeline: null, artwork: null, playback: 'paused' as const};
  expect(acceptsSelectedSession([player], {kind: 'automatic'}, track)).toBe(true);
  expect(acceptsSelectedSession([player, chrome], {kind: 'session', id: player.id}, track)).toBe(true);
  expect(acceptsSelectedSession([{...player, playback: 'stopped'}], {kind: 'session', id: player.id}, {...track, playback: 'stopped'})).toBe(false);
});
it('permits explicit loss without fallback and requires a fresh token to be selected before accepting it', () => {
  const fresh = {...chrome, id: 's3'};
  const track = {id: fresh.id, revision: 1, title: null, artist: null, album: null, timeline: null, artwork: null, playback: 'playing' as const};
  expect(acceptsSelectedSession([fresh], {kind: 'session', id: chrome.id}, null)).toBe(true);
  expect(acceptsSelectedSession([fresh], {kind: 'session', id: chrome.id}, track)).toBe(false);
  expect(acceptsSelectedSession([fresh], {kind: 'session', id: fresh.id}, track)).toBe(true);
});
