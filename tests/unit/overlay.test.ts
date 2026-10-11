import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveFreshness} from '../../apps/desktop/src/live-freshness';
import {OverlayController} from '../../apps/desktop/src/overlay-controller';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';

function live(): LiveTelemetry {
  const snapshot = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot');
  return {...initialLive('ets2'), status: 'connected', fresh: true, observation: {
    source: {...snapshot.source, origin: 'game'}, state: snapshot.data.state, capture: snapshot.capture, seq: snapshot.seq,
    receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: snapshot.data.continuity}
  }};
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('converts ETS2 and ATS defaults without changing canonical quantities, including real zeros', () => {
  const current = live(), state = current.observation!.state;
  state.speed = {available: true, value: 10, unit: 'm/s'}; state.fuel = {available: true, value: 37.85411784, unit: 'L'};
  expect(overlayPresentation(current)).toMatchObject({source: 'ETS2', speed: '36.0', speedUnit: 'km/h', fuel: '37.9', fuelUnit: 'L', freshness: 'current'});
  current.selection = 'ats'; current.observation!.source.game = 'ats';
  expect(overlayPresentation(current)).toMatchObject({source: 'ATS', speed: '22.4', speedUnit: 'mph', fuel: '10.0', fuelUnit: 'US gal'});
  expect(state.speed.value).toBe(10); expect(state.fuel.value).toBe(37.85411784);
  state.speed.value = 0; state.fuel.value = 0;
  expect(overlayPresentation(current)).toMatchObject({speed: '0.0', fuel: '0.0'});
});
it.each(['missing', 'stale', 'synthetic', 'wrong-game', 'disconnected'])('blanks untrusted or unavailable metrics: %s', fault => {
  const current = live();
  if (fault === 'missing') {current.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'}; current.observation!.state.fuel = {available: false, reason: 'not-observed', unit: 'L'};}
  if (fault === 'stale') {current.fresh = false; current.status = 'stale';}
  if (fault === 'synthetic') current.observation!.source.origin = 'synthetic';
  if (fault === 'wrong-game') current.observation!.source.game = 'ats';
  if (fault === 'disconnected') current.status = 'disconnected';
  expect(overlayPresentation(current)).toMatchObject({speed: '—', fuel: '—'});
});
it.each(['synthetic', 'replay'] as const)('projects explicit %s fixtures for a hidden renderer with a distinct origin', origin => {
  const current = live(); current.selection = origin; current.observation!.source.origin = origin;
  current.observation!.state.speed = {available: true, value: 25, unit: 'm/s'};
  current.observation!.state.fuel = {available: true, value: 73, unit: 'L'};
  expect(overlayPresentation(current)).toMatchObject({source: 'ETS2', origin, speed: '90.0', fuel: '73.0', freshness: 'current'});
});
it('does not renew equal SDK captures, permits fresh windows with stale metrics, then hides on window expiry', async () => {
  const publish = vi.fn(), freshness = new LiveFreshness(publish), current = live();
  freshness.accept(current); await vi.advanceTimersByTimeAsync(200);
  freshness.accept({...current, observation: {...current.observation!, windowReceivedMonotonicMs: 200}});
  await vi.advanceTimersByTimeAsync(200);
  freshness.accept({...current, observation: {...current.observation!, receivedMonotonicMs: 400, windowReceivedMonotonicMs: 400}});
  await vi.advanceTimersByTimeAsync(100);
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: false, status: 'stale', observation: {windowFresh: true}});
  freshness.accept({...current, observation: {...current.observation!, windowReceivedMonotonicMs: 400}});
  expect(publish.mock.lastCall?.[0].fresh).toBe(false);
  await vi.advanceTimersByTimeAsync(150);
  expect(publish.mock.lastCall?.[0].observation.windowFresh).toBe(false);
  freshness.close(); expect(vi.getTimerCount()).toBe(0);
});
it('retains receipt expiry across port invalidation and independently renews a new capture', async () => {
  const publish = vi.fn(), freshness = new LiveFreshness(publish), current = live();
  freshness.accept(current); await vi.advanceTimersByTimeAsync(400);
  freshness.invalidate({...initialLive('ets2'), status: 'stale'});
  freshness.accept(current); expect(publish.mock.lastCall?.[0].observation.windowFresh).toBe(false);
  await vi.advanceTimersByTimeAsync(100); expect(publish.mock.lastCall?.[0].fresh).toBe(false);
  freshness.accept({...current, observation: {...current.observation!, capture: {...current.observation!.capture, monotonicNs: '9999999999'}, windowReceivedMonotonicMs: 500}});
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: true, observation: {windowFresh: true}});
  freshness.close(); expect(vi.getTimerCount()).toBe(0);
});
function controller() {
  const window = {isDestroyed: () => false, hide: vi.fn(), setBounds: vi.fn(), showInactive: vi.fn()};
  const screen = {screenToDipRect: vi.fn((_window: null, bounds: Electron.Rectangle) => ({x: bounds.x / 2, y: bounds.y / 2, width: bounds.width / 2, height: bounds.height / 2})),
    getAllDisplays: () => [{bounds: {x: -960, y: 0, width: 1920, height: 1080}}]};
  return {window, screen, overlay: new OverlayController(window, screen)};
}
it('uses the API for signed physical bounds, stays bounded in client DIP bounds and shows without focus', () => {
  const {window, screen, overlay} = controller(), current = live();
  overlay.update(current); expect(window.showInactive).not.toHaveBeenCalled(); overlay.loaded(true);
  expect(screen.screenToDipRect).toHaveBeenCalledWith(null, {x: -1920, y: 0, width: 1920, height: 1080});
  expect(window.setBounds).toHaveBeenCalledWith({x: -944, y: 16, width: 300, height: 132});
  expect(window.showInactive).toHaveBeenCalledOnce(); overlay.update(current);
  expect(window.showInactive).toHaveBeenCalledOnce(); expect(window.setBounds).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledOnce();
});
it.each(['expired', 'minimized', 'background', 'source', 'failed', 'small', 'conversion-failed'])('hides the overlay on %s', fault => {
  const {window, screen, overlay} = controller(), current = live(); overlay.loaded(true); overlay.update(current);
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  if (fault === 'expired') current.observation!.windowFresh = false;
  if (fault === 'minimized') metadata.value.minimized = true;
  if (fault === 'background') metadata.value.foreground = false;
  if (fault === 'source') current.selection = 'synthetic';
  if (fault === 'failed') current.status = 'service-failed';
  if (fault === 'small') metadata.value.width = 10;
  if (fault === 'conversion-failed') {metadata.value.x--; screen.screenToDipRect.mockImplementation(() => {throw new Error('removed display');});}
  window.hide.mockClear(); overlay.update(current); expect(window.hide).toHaveBeenCalledOnce();
});
it('waits for a new window receipt after monitor changes, including repeated old SDK/window deliveries', () => {
  const {window, overlay} = controller(), current = live(); overlay.loaded(true); overlay.update(current);
  overlay.topologyChanged(); expect(window.hide).toHaveBeenCalled(); window.showInactive.mockClear();
  overlay.update(current); expect(window.showInactive).not.toHaveBeenCalled();
  overlay.update({...current, observation: {...current.observation!, windowReceivedMonotonicMs: 1}});
  expect(window.showInactive).toHaveBeenCalledOnce();
});
it('does not convert a removed-monitor rectangle into an offscreen overlay', () => {
  const {window, screen, overlay} = controller();
  screen.screenToDipRect.mockReturnValue({x: -5000, y: 0, width: 1920, height: 1080});
  overlay.loaded(true); overlay.update(live()); expect(window.showInactive).not.toHaveBeenCalled();
});
it('recovers an unchanged rectangle after a transient conversion failure without caching that failure', () => {
  const {window, screen, overlay} = controller(), current = live(); overlay.loaded(true);
  screen.screenToDipRect.mockImplementationOnce(() => {throw new Error('transient conversion');});
  overlay.update(current); expect(window.showInactive).not.toHaveBeenCalled();
  overlay.update(current); expect(window.showInactive).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledTimes(2);
});
