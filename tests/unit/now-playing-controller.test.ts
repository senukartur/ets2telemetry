import {expect, it, vi} from 'vitest';
import {NowPlayingController} from '../../apps/desktop/src/now-playing/controller';
import {DEFAULT_NOW_PLAYING} from '../../apps/desktop/src/now-playing/contract';
import {readFileSync} from 'node:fs';
import {initialLive} from '../../apps/desktop/src/live-state';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry} from '../../packages/contracts/src';
function game(): LiveTelemetry {
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot' || !message.data.state.window.available) throw new Error('Expected game window fixture');
  message.data.state.window.value = {...message.data.state.window.value, x: 0, width: 1920};
  return {...initialLive('ets2'), status: 'connected', observation: {source: {...message.source, origin: 'game'}, state: message.data.state,
    capture: message.capture, seq: message.seq, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}}};
}
function harness() {
  let bounds = {x: 0, y: 0, width: 300, height: 78};
  const calls: string[] = [];
  const window = {isDestroyed: () => false, hide: () => calls.push('hide'), showInactive: () => calls.push('showInactive'),
    setBounds: (value: typeof bounds) => {bounds = value;}, getBounds: () => bounds,
    setIgnoreMouseEvents: (value: boolean) => calls.push(`ignore:${value}`), setFocusable: (value: boolean) => calls.push(`focusable:${value}`),
    setSkipTaskbar: vi.fn(), setMovable: (value: boolean) => calls.push(`movable:${value}`), setAlwaysOnTop: vi.fn(), isAlwaysOnTop: () => false, moveTop: vi.fn()};
  const display = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}};
  const screen = {getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display, screenToDipRect: vi.fn((_window: null, area: typeof bounds) => area)};
  const controller = new NowPlayingController(window, screen, vi.fn());
  controller.configure({...DEFAULT_NOW_PLAYING, enabled: true}); controller.loaded(true);
  return {controller, window, calls, screen};
}
it('shows without activation only over an active game and hides unavailable content', () => {
  const {controller, window, calls} = harness(); controller.update(true);
  expect(calls).not.toContain('showInactive');
  controller.updateGame(game());
  expect(calls.at(-1)).toBe('showInactive'); expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver');
  controller.update(false); expect(calls).toContain('hide'); expect(calls.at(-1)).toBe('focusable:false');
});
it.each(['background', 'minimized', 'expired', 'disconnected', 'synthetic', 'mismatched-game', 'missing-window'])('hides on %s even when media keeps updating', fault => {
  const {controller, calls} = harness(); controller.update(true); controller.updateGame(game());
  const live = game(), observation = live.observation!;
  if (!observation.state.window.available) throw new Error('Expected window');
  if (fault === 'background') observation.state.window.value.foreground = false;
  if (fault === 'minimized') observation.state.window.value.minimized = true;
  if (fault === 'expired') observation.windowFresh = false;
  if (fault === 'disconnected') live.status = 'disconnected';
  if (fault === 'synthetic') observation.source.origin = 'synthetic';
  if (fault === 'mismatched-game') observation.source.game = 'ats';
  if (fault === 'missing-window') observation.state.window = {available: false, reason: 'not-observed'};
  calls.length = 0; controller.updateGame(live); controller.update(true);
  expect(calls).not.toContain('showInactive'); expect(calls).toContain('ignore:true');
  expect(calls.at(-1)).toBe('focusable:false');
  controller.updateGame(game()); expect(calls.at(-1)).toBe('showInactive');
});
it('contains the normal panel in the DPI-converted game client without changing saved placement', () => {
  const {controller, window, calls, screen} = harness();
  screen.screenToDipRect.mockReturnValue({x: 100, y: 80, width: 800, height: 600});
  controller.update(true); controller.updateGame(game());
  expect(window.getBounds()).toEqual({x: 600, y: 602, width: 300, height: 78});
  screen.screenToDipRect.mockReturnValue({x: 0, y: 0, width: 200, height: 100});
  calls.length = 0; controller.updateGame(game()); expect(calls).not.toContain('showInactive');
  screen.screenToDipRect.mockImplementation(() => {throw new Error('Display unavailable');});
  controller.updateGame(game()); expect(calls.at(-1)).toBe('focusable:false');
  screen.screenToDipRect.mockImplementation((_window, bounds) => bounds);
  controller.updateGame(game()); expect(window.getBounds()).toEqual({x: 1604, y: 714, width: 300, height: 78});
});
it('owns a safe draft, suppresses interactive display outside own focus, and restores click-through before ending', () => {
  const {controller, window, calls} = harness();
  controller.begin(true); expect(controller.editState()).toEqual({active: true, placement: 'visible'});
  controller.moveStarted(); window.setBounds({x: 16, y: 16, width: 300, height: 78}); controller.moved();
  controller.setOwnForeground(false); expect(controller.editState().placement).toBe('not-foreground');
  controller.setOwnForeground(true); calls.length = 0;
  expect(controller.end()).toEqual({displayId: '1', x: 0, y: 0});
  expect(calls.slice(0, 4)).toEqual(['hide', 'ignore:true', 'movable:false', 'focusable:false']);
  expect(controller.editState().active).toBe(false);
  controller.begin(true); controller.reset(); expect(controller.end()).toEqual(DEFAULT_NOW_PLAYING.position);
});
it('reports an unavailable placement when Windows refuses the requested bounds', () => {
  const {controller, window, calls} = harness(); window.setBounds = () => undefined;
  expect(controller.begin(true)).toEqual({active: true, placement: 'unavailable'});
  expect(calls).not.toContain('ignore:false');
});
