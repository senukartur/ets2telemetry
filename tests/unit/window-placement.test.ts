import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {currentGameClientBounds, gameForeground, visibleGameClientBounds} from '../../apps/desktop/src/window-placement';
import {initialLive} from '../../apps/desktop/src/live-state';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry} from '../../packages/contracts/src';

export function gameLive(): LiveTelemetry {
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot') throw new Error('Expected snapshot');
  return {...initialLive('ets2'), status: 'stale', fresh: false, observation: {source: {...message.source, origin: 'game'}, state: message.data.state,
    capture: message.capture, seq: message.seq, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 600, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}}};
}
it('accepts signed physical bounds while SDK metrics are stale', () => {
  expect(currentGameClientBounds(gameLive())).toEqual({x: -1920, y: 0, width: 1920, height: 1080});
});
it.each(['synthetic', 'wrong-game', 'expired', 'disconnected', 'background', 'minimized', 'zero', 'unavailable'])('hides placement for %s state', fault => {
  const live = gameLive(), observation = live.observation!, window = observation.state.window;
  if (!window.available) throw new Error('Expected window');
  if (fault === 'synthetic') observation.source.origin = 'synthetic';
  if (fault === 'wrong-game') observation.source.game = 'ats';
  if (fault === 'expired') observation.windowFresh = false;
  if (fault === 'disconnected') live.status = 'disconnected';
  if (fault === 'background') window.value.foreground = false;
  if (fault === 'minimized') window.value.minimized = true;
  if (fault === 'zero') window.value.width = 0;
  if (fault === 'unavailable') observation.state.window = {available: false, reason: 'not-observed'};
  expect(currentGameClientBounds(live)).toBeUndefined();
});
// ET-012b: edit mode needs the same window report without the foreground requirement; driving mode keeps it.
it('gives edit mode the client area of a background game while driving placement still needs the foreground', () => {
  const live = gameLive(), window = live.observation!.state.window;
  if (!window.available) throw new Error('Expected window');
  window.value.foreground = false;
  expect(visibleGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});
  expect(gameForeground(live)).toBe(false); expect(currentGameClientBounds(live)).toBeUndefined();
  window.value.foreground = true;
  expect(gameForeground(live)).toBe(true); expect(currentGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});
});
it.each(['synthetic', 'wrong-game', 'no-game-origin', 'expired', 'disconnected', 'minimized', 'zero', 'unavailable'])('gives edit mode no client area for %s state', fault => {
  const live = gameLive(), observation = live.observation!, window = observation.state.window;
  if (!window.available) throw new Error('Expected window');
  window.value.foreground = false;
  if (fault === 'synthetic') live.selection = 'synthetic';
  if (fault === 'wrong-game') observation.source.game = 'ats';
  if (fault === 'no-game-origin') observation.source.origin = 'replay';
  if (fault === 'expired') observation.windowFresh = false;
  if (fault === 'disconnected') live.status = 'disconnected';
  if (fault === 'minimized') window.value.minimized = true;
  if (fault === 'zero') window.value.height = 0;
  if (fault === 'unavailable') observation.state.window = {available: false, reason: 'not-observed'};
  expect(visibleGameClientBounds(live)).toBeUndefined();
});
