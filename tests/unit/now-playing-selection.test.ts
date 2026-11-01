import {expect, it} from 'vitest';
import {selectSession} from '../../apps/desktop/src/now-playing/selection';
import type {MediaSession} from '../../packages/contracts/src';
const chrome: MediaSession = {id: 's2', sourceAppId: 'Chrome', playback: 'playing', current: false};
const player: MediaSession = {id: 's1', sourceAppId: 'Synthetic player', playback: 'paused', current: true};
it('prefers playing Chrome over Windows-current paused player and retains a still-playing source', () => {
  expect(selectSession([player, chrome], {kind: 'automatic'}, 's1')).toEqual(chrome);
  expect(selectSession([{...player, playback: 'playing'}, chrome], {kind: 'automatic'}, 's2')).toEqual(chrome);
});
it('uses Windows-current in the highest tier, otherwise ordinal ordering independent of enumeration', () => {
  const playing = {...player, playback: 'playing' as const};
  expect(selectSession([chrome, playing], {kind: 'automatic'}, null)).toEqual(playing);
  expect(selectSession([{...playing, current: false}, chrome], {kind: 'automatic'}, null)).toEqual(chrome);
  expect(selectSession([chrome, {...playing, current: false}], {kind: 'automatic'}, null)).toEqual(chrome);
});
it('retains paused sources and never replaces an unavailable explicit source', () => {
  const paused = {...chrome, playback: 'paused' as const};
  expect(selectSession([player, paused], {kind: 'automatic'}, paused.id)).toEqual(paused);
  expect(selectSession([chrome], {kind: 'session', id: player.id}, player.id)).toBeUndefined();
  expect(selectSession([{...player, playback: 'stopped'}], {kind: 'automatic'}, 's1')).toBeUndefined();
});
