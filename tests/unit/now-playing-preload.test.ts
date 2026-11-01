import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopBridge, NowPlayingBridge, NowPlayingDisplay} from '../../packages/contracts/src';
let ipc: EventEmitter & {send: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>};
let bridge: NowPlayingBridge, desktop: DesktopBridge, unsubscribe: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); ipc = Object.assign(new EventEmitter(), {send: vi.fn(), invoke: vi.fn()});
  vi.doMock('electron', () => ({ipcRenderer: ipc, contextBridge: {exposeInMainWorld: (name: string, value: never) => {if (name === 'nowPlaying') bridge = value; else desktop = value;}}}));
});
afterEach(() => {unsubscribe?.(); unsubscribe = undefined; vi.useRealTimers(); vi.doUnmock('electron');});
class Port {
  onmessage?: (event: {data: unknown}) => void;
  onmessageerror?: () => void;
  events = new EventEmitter(); postMessage = vi.fn(); start = vi.fn(); close = vi.fn();
  addEventListener(name: string, listener: () => void) {this.events.on(name, listener);}
  deliver(value: NowPlayingDisplay, delivery: number) {this.onmessage?.({data: {type: 'live', delivery, update: value}});}
}
const display: NowPlayingDisplay = {generation: 1, language: 'en', style: 'full', backgroundOpacity: 80, editing: false, source: 'Synthetic player', track: {id: 's1', revision: 1, title: 'Fixture', artist: null, album: null, playback: 'paused', timeline: null, artwork: null}};
it('exposes only a frozen readonly subscription and clears quiet/closed channels after five seconds', async () => {
  await import('../../apps/desktop/src/now-playing/preload');
  expect(Object.keys(bridge)).toEqual(['subscribeNowPlaying']); expect(Object.isFrozen(bridge)).toBe(true);
  const receive = vi.fn(); unsubscribe = bridge.subscribeNowPlaying(receive);
  expect(() => bridge.subscribeNowPlaying(vi.fn())).toThrow();
  ipc.emit('now-playing:ready', {}, 1); const port = new Port(); ipc.emit('now-playing:port', {ports: [port]}, {generation: 1}); port.deliver(display, 1);
  expect(receive).toHaveBeenLastCalledWith(display); expect(port.postMessage).toHaveBeenLastCalledWith({type: 'consumed', delivery: 1});
  await vi.advanceTimersByTimeAsync(4999); expect(receive.mock.lastCall?.[0].track).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1); expect(receive.mock.lastCall?.[0]).toMatchObject({source: null, track: null});
  unsubscribe(); expect(ipc.send).toHaveBeenLastCalledWith('now-playing:unsubscribe', 1); expect(vi.getTimerCount()).toBe(0);
});
it('retires replaced documents, rejects backwards generations and never acknowledges malformed display data', async () => {
  await import('../../apps/desktop/src/now-playing/preload'); const receive = vi.fn(); unsubscribe = bridge.subscribeNowPlaying(receive);
  ipc.emit('now-playing:ready', {}, 1); const first = new Port(); ipc.emit('now-playing:port', {ports: [first]}, {generation: 1}); first.deliver(display, 1);
  ipc.emit('now-playing:ready', {}, 2); const next = new Port(); ipc.emit('now-playing:port', {ports: [next]}, {generation: 2}); expect(first.close).toHaveBeenCalled();
  first.deliver(display, 2); expect(receive.mock.lastCall?.[0].track).toBeNull();
  next.deliver({...display, generation: 3}, 3); next.deliver({...display, generation: 2}, 4);
  expect(next.close).toHaveBeenCalled(); expect(receive.mock.lastCall?.[0].track).toBeNull(); expect(next.postMessage).toHaveBeenCalledTimes(1);
});
it('validates exact arity and bounded settings/source/edit arguments before dashboard IPC', async () => {
  await import('../../apps/desktop/src/preload');
  const invalid: [keyof DesktopBridge, unknown[]][] = [
    ['setNowPlayingEnabled', []], ['setNowPlayingEnabled', [true, 1]], ['setNowPlayingEnabled', ['true']],
    ['setNowPlayingStyle', ['large']], ['setNowPlayingStyle', ['full', 1]], ['setNowPlayingBackgroundOpacity', [39]], ['setNowPlayingBackgroundOpacity', [40.5]],
    ['selectNowPlayingSource', [{kind: 'session', id: 'file:///secret'}]], ['selectNowPlayingSource', [{kind: 'automatic', path: 'cmd.exe'}]],
    ['beginNowPlayingEdit', [1]], ['resetNowPlayingEditPlacement', [1]], ['finishNowPlayingEdit', ['delete']]
  ];
  for (const [method, args] of invalid) await expect(Reflect.apply(desktop[method] as (...args: unknown[]) => unknown, desktop, args)).rejects.toThrow('Invalid current track request');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await desktop.setNowPlayingEnabled(true); await desktop.setNowPlayingStyle('minimal'); await desktop.setNowPlayingBackgroundOpacity(40);
  await desktop.selectNowPlayingSource({kind: 'automatic'}); await desktop.beginNowPlayingEdit(); await desktop.resetNowPlayingEditPlacement(); await desktop.finishNowPlayingEdit('cancel');
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['settings:set-now-playing-enabled', 'settings:set-now-playing-style', 'settings:set-now-playing-background-opacity', 'now-playing:select-source', 'now-playing-edit:begin', 'now-playing-edit:reset', 'now-playing-edit:finish']);
});
