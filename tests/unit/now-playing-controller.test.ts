import {expect, it, vi} from 'vitest';
import {NowPlayingController} from '../../apps/desktop/src/now-playing/controller';
import {DEFAULT_NOW_PLAYING} from '../../apps/desktop/src/now-playing/contract';
function harness() {
  let bounds = {x: 0, y: 0, width: 300, height: 78};
  const calls: string[] = [];
  const window = {isDestroyed: () => false, hide: () => calls.push('hide'), showInactive: () => calls.push('showInactive'),
    setBounds: (value: typeof bounds) => {bounds = value;}, getBounds: () => bounds,
    setIgnoreMouseEvents: (value: boolean) => calls.push(`ignore:${value}`), setFocusable: (value: boolean) => calls.push(`focusable:${value}`),
    setSkipTaskbar: vi.fn(), setMovable: (value: boolean) => calls.push(`movable:${value}`), setAlwaysOnTop: vi.fn(), isAlwaysOnTop: () => false, moveTop: vi.fn()};
  const display = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}};
  const controller = new NowPlayingController(window, {getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display}, vi.fn());
  controller.configure({...DEFAULT_NOW_PLAYING, enabled: true}); controller.loaded(true);
  return {controller, window, calls};
}
it('shows without activation independently of game state and hides unavailable content', () => {
  const {controller, window, calls} = harness(); controller.update(true);
  expect(calls.at(-1)).toBe('showInactive'); expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver');
  controller.update(false); expect(calls).toContain('hide'); expect(calls.at(-1)).toBe('focusable:false');
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
