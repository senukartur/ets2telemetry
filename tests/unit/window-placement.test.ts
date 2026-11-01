import {v1Projection} from '../shared/live-v1-fixtures';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {currentGameClientBounds, gameForeground, gamePaused, visibleGameClientBounds} from '../../apps/desktop/src/window-placement';
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

it.each(['ets2', 'ats'] as const)('places automatic %s only from its current v0 game window', game => {
  const live = gameLive(); live.selection = 'game'; live.observation!.source.game = game;
  const bounds = {x: -1920, y: 0, width: 1920, height: 1080};
  // SDK staleness does not expire a separately fresh window report.
  expect(currentGameClientBounds(live)).toEqual(bounds);
  const window = live.observation!.state.window; if (!window.available) throw new Error('Expected window');
  window.value.foreground = false; expect(visibleGameClientBounds(live)).toEqual(bounds); expect(currentGameClientBounds(live)).toBeUndefined();
  for (const fault of ['synthetic', 'replay', 'fixture', 'explicit-mismatch', 'expired', 'minimized', 'size', 'disconnected'] as const) {
    const invalid = structuredClone(live), observation = invalid.observation!;
    if (fault === 'synthetic' || fault === 'replay') observation.source.origin = fault;
    if (fault === 'fixture') invalid.selection = 'synthetic';
    if (fault === 'explicit-mismatch') invalid.selection = game === 'ets2' ? 'ats' : 'ets2';
    if (fault === 'expired') observation.windowFresh = false;
    if (fault === 'disconnected') invalid.status = 'disconnected';
    if (!observation.state.window.available) throw new Error('Expected window');
    if (fault === 'minimized') observation.state.window.value.minimized = true;
    if (fault === 'size') observation.state.window.value.width = 0;
    expect(visibleGameClientBounds(invalid), fault).toBeUndefined();
  }
  const partial = {...initialLive('game'), v1: v1Projection('snapshot-live', {selection: 'game', origin: 'game', game})};
  expect(visibleGameClientBounds(partial)).toBeUndefined(); expect(currentGameClientBounds(partial)).toBeUndefined();
});

it('detects game paused for status or simulation state', () => {
  const live = gameLive();
  expect(gamePaused(live)).toBe(false);

  live.status = 'paused';
  expect(gamePaused(live)).toBe(true);

  live.status = 'connected';
  live.observation!.state.simulation = 'paused';
  expect(gamePaused(live)).toBe(true);

  live.status = 'stale';
  expect(gamePaused(live)).toBe(true);

  live.observation!.state.simulation = 'running';
  expect(gamePaused(live)).toBe(false);
});

it('hides driving placement when paused while visibleGameClientBounds keeps client area for edit mode', () => {
  const live = gameLive();
  expect(currentGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});
  expect(visibleGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});

  live.observation!.state.simulation = 'paused';
  expect(currentGameClientBounds(live)).toBeUndefined();
  expect(visibleGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});

  live.observation!.state.simulation = 'running';
  live.status = 'paused';
  expect(currentGameClientBounds(live)).toBeUndefined();
  expect(visibleGameClientBounds(live)).toEqual({x: -1920, y: 0, width: 1920, height: 1080});
});
