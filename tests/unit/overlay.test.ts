import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {LiveTelemetry, OverlayLayout} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveFreshness} from '../../apps/desktop/src/live-freshness';
import {OverlayController} from '../../apps/desktop/src/overlay-controller';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {v1Projection} from '../shared/live-v1-fixtures';

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
it.each([
  {game: 'ets2' as const, unit: 'km/h', below: 0.0136, above: 0.0142, reverse: '-7.2'},
  {game: 'ats' as const, unit: 'mph', below: 0.0219, above: 0.0228, reverse: '-4.5'}
])('shows rounded zero without a minus sign and preserves signed reverse speed in $game', ({game, unit, below, above, reverse}) => {
  const current = live(), state = current.observation!.state;
  current.selection = game; current.observation!.source.game = game;
  // Values straddle 0.05 in each display unit, safely away from binary rounding ties.
  const cases = [
    {raw: -0.001, displayed: '0.0'},
    {raw: -0, displayed: '0.0'},
    {raw: 0, displayed: '0.0'},
    {raw: -below, displayed: '0.0'},
    {raw: -above, displayed: '-0.1'},
    {raw: below, displayed: '0.0'},
    {raw: above, displayed: '0.1'},
    {raw: -2, displayed: reverse}
  ];
  for (const {raw, displayed} of cases) {
    state.speed = {available: true, value: raw, unit: 'm/s'};
    expect(overlayPresentation(current), `canonical speed ${String(raw)} m/s`).toMatchObject({
      speed: displayed, speedUnit: unit, source: game.toUpperCase(), origin: 'game', status: 'connected', freshness: 'current'
    });
    expect(state.speed.value).toBe(raw);
  }
});
it.each(['ets2', 'ats'] as const)('keeps unavailable and stale speed distinct from rounded zero in %s', game => {
  const current = live(); current.selection = game; current.observation!.source.game = game;
  current.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  expect(overlayPresentation(current)).toMatchObject({speed: '—', origin: 'game', status: 'connected', freshness: 'current'});
  current.observation!.state.speed = {available: true, value: -0.001, unit: 'm/s'};
  current.fresh = false; current.status = 'stale';
  expect(overlayPresentation(current)).toMatchObject({speed: '—', origin: 'game', status: 'stale', freshness: 'stale'});
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
// ET-010c decision F3: main's v1 expiry is independent of the v0 SDK and window clocks.
function withV1(current: LiveTelemetry, boundaryOrder = '102', receivedMonotonicMs = 0): LiveTelemetry {
  const v1 = v1Projection('snapshot-live', {selection: 'ets2', origin: 'game', receivedMonotonicMs});
  v1.observation!.state.boundaryOrder = boundaryOrder;
  return {...current, v1};
}
const newCapture = (current: LiveTelemetry, monotonicNs: string): LiveTelemetry =>
  ({...current, observation: {...current.observation!, capture: {...current.observation!.capture, monotonicNs}, windowReceivedMonotonicMs: Number(monotonicNs)}});
it('expires v1 data 500 ms after its last new boundary while new v0 captures keep v0 current', async () => {
  const publish = vi.fn(), freshness = new LiveFreshness(publish), current = live();
  freshness.accept(withV1(current)); await vi.advanceTimersByTimeAsync(200);
  // New v0 captures with the same v1 boundary and receipt time renew only v0.
  freshness.accept(withV1(newCapture(current, '200'))); await vi.advanceTimersByTimeAsync(200);
  freshness.accept(withV1(newCapture(current, '400'))); await vi.advanceTimersByTimeAsync(99);
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: true, v1: {fresh: true, status: 'connected'}});
  await vi.advanceTimersByTimeAsync(1);
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: true, status: 'connected',
    v1: {fresh: false, status: 'stale', reason: 'Main has no recent v1 SDK capture', observation: {state: {boundaryOrder: '102'}}}});
  // A resent v1 observation stays expired; a new boundary renews it.
  freshness.accept(withV1(newCapture(current, '500')));
  expect(publish.mock.lastCall?.[0].v1).toMatchObject({fresh: false, status: 'stale'});
  freshness.accept(withV1(newCapture(current, '550'), '103', 550));
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: true, v1: {fresh: true, status: 'connected'}});
  freshness.close(); expect(vi.getTimerCount()).toBe(0);
});
it('lets new v1 boundaries renew neither the v0 SDK expiry nor the window expiry', async () => {
  const publish = vi.fn(), freshness = new LiveFreshness(publish), current = live();
  freshness.accept(withV1(current)); await vi.advanceTimersByTimeAsync(300);
  freshness.accept(withV1(current, '103', 300)); await vi.advanceTimersByTimeAsync(200);
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: false, status: 'stale', reason: 'Main has no recent SDK capture', observation: {windowFresh: false},
    v1: {fresh: true, status: 'connected'}});
  await vi.advanceTimersByTimeAsync(300);
  expect(publish.mock.lastCall?.[0].v1).toMatchObject({fresh: false, reason: 'Main has no recent v1 SDK capture'});
  freshness.close(); expect(vi.getTimerCount()).toBe(0);
});
it('clears v1 data on invalidation and keeps its expiry across it', async () => {
  const publish = vi.fn(), freshness = new LiveFreshness(publish), current = live();
  freshness.accept(withV1(current)); await vi.advanceTimersByTimeAsync(400);
  freshness.invalidate({...initialLive('ets2'), status: 'stale'});
  expect(publish.mock.lastCall?.[0]).not.toHaveProperty('v1');
  // The same v1 observation after the invalidation does not restart its 500 ms.
  freshness.accept(withV1(newCapture(current, '400'))); await vi.advanceTimersByTimeAsync(100);
  expect(publish.mock.lastCall?.[0]).toMatchObject({fresh: true, v1: {fresh: false, status: 'stale'}});
  freshness.close(); expect(vi.getTimerCount()).toBe(0);
});
function controller(layout?: OverlayLayout) {
  // Models Windows: isAlwaysOnTop() reads the HWND's WS_EX_TOPMOST, which external z-order changes can clear.
  const window = {isDestroyed: () => false, hide: vi.fn(), setBounds: vi.fn(), showInactive: vi.fn(), topmost: true,
    isAlwaysOnTop: (): boolean => window.topmost, setAlwaysOnTop: vi.fn<(flag: boolean, level: string) => void>(flag => {window.topmost = flag;}), moveTop: vi.fn(),
    // Never called by the controller: activating or focusing the overlay would steal driving input.
    show: vi.fn(), focus: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn()};
  const screen = {screenToDipRect: vi.fn((_window: null, bounds: Electron.Rectangle) => ({x: bounds.x / 2, y: bounds.y / 2, width: bounds.width / 2, height: bounds.height / 2})),
    getAllDisplays: () => [{bounds: {x: -960, y: 0, width: 1920, height: 1080}}]};
  const lost = vi.fn();
  return {window, screen, lost, overlay: new OverlayController(window, screen, lost, layout)};
}
function noActivation(window: ReturnType<typeof controller>['window']) {
  for (const method of [window.show, window.focus, window.setFocusable, window.setIgnoreMouseEvents]) expect(method).not.toHaveBeenCalled();
}
function raisedAfterShow(window: ReturnType<typeof controller>['window']) {
  expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver');
  const shown = window.showInactive.mock.invocationCallOrder.at(-1)!, raised = window.setAlwaysOnTop.mock.invocationCallOrder.at(-1)!;
  expect(shown).toBeLessThan(raised); expect(raised).toBeLessThan(window.moveTop.mock.invocationCallOrder.at(-1)!);
}
it('re-asserts the non-taskbar topmost level after every inactive show, without activation', () => {
  const {window, lost, overlay} = controller(), current = live(); overlay.loaded(true);
  overlay.update(current); raisedAfterShow(window);
  expect(window.setAlwaysOnTop).toHaveBeenCalledOnce(); expect(window.moveTop).toHaveBeenCalledOnce();
  overlay.update(current); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce(); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.setAlwaysOnTop.mock.calls.every(([, level]) => level === 'screen-saver')).toBe(true);
  expect(lost).not.toHaveBeenCalled(); noActivation(window);
});
it('restores topmost when the game returns to the foreground after the overlay lost it while hidden', () => {
  const {window, lost, overlay} = controller(), current = live(); overlay.loaded(true); overlay.update(current);
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  // The owner focuses the dashboard: the game is background and the overlay hides.
  window.hide.mockClear(); metadata.value.foreground = false; overlay.update(current); expect(window.hide).toHaveBeenCalledOnce();
  // While hidden, the HWND loses WS_EX_TOPMOST (observed ex-style 0x8280020); moveTop alone would not restore it.
  window.topmost = false; window.moveTop.mockClear(); expect(window.moveTop).not.toHaveBeenCalled();
  metadata.value.foreground = true; overlay.update(current);
  expect(window.showInactive).toHaveBeenCalledTimes(2); raisedAfterShow(window);
  expect(window.topmost).toBe(true); expect(lost.mock.calls).toEqual([['show']]); noActivation(window);
});
it('re-asserts topmost on placement changes while visible', () => {
  const {window, overlay} = controller(), current = live(); overlay.loaded(true); overlay.update(current);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.x += 200; overlay.update(current);
  expect(window.setBounds).toHaveBeenCalledTimes(2); expect(window.showInactive).toHaveBeenCalledOnce();
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.setBounds.mock.invocationCallOrder[1]).toBeLessThan(window.setAlwaysOnTop.mock.invocationCallOrder[0]);
  noActivation(window);
});
it('restores a visible overlay whose topmost style was cleared externally and reports once per shown period', () => {
  const {window, lost, overlay} = controller(), current = live(); overlay.loaded(true); overlay.update(current);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  window.topmost = false; overlay.update(current);
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.showInactive).toHaveBeenCalledOnce(); expect(lost.mock.calls).toEqual([['visible']]);
  window.topmost = false; overlay.update(current);
  expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(2); expect(lost).toHaveBeenCalledOnce();
  overlay.loaded(false); window.topmost = false; overlay.loaded(true);
  expect(lost.mock.calls).toEqual([['visible'], ['show']]); noActivation(window);
});
it('never raises a hidden overlay, because moveTop also shows the window', () => {
  const {window, overlay} = controller(), current = live();
  overlay.update(current); window.topmost = false;
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.minimized = true; overlay.loaded(true); overlay.update(current);
  expect(window.showInactive).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
});
it('uses the API for signed physical bounds, stays bounded in client DIP bounds and shows without focus', () => {
  const {window, screen, overlay} = controller(), current = live();
  overlay.update(current); expect(window.showInactive).not.toHaveBeenCalled(); overlay.loaded(true);
  expect(screen.screenToDipRect).toHaveBeenCalledWith(null, {x: -1920, y: 0, width: 1920, height: 1080});
  // ET-012a: the default strip layout replaces ET-008's fixed 300 x 132 box at the top left (decision L10).
  expect(window.setBounds).toHaveBeenCalledWith({x: -944, y: 8, width: 928, height: 38});
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
// ET-011b: the overlay follows the persisted profile of the displayed game.
it.each([
  {game: 'ets2' as const, units: {ets2: 'us-customary', ats: 'us-customary'} as const, speed: '55.9', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal'},
  {game: 'ats' as const, units: {ets2: 'metric', ats: 'metric'} as const, speed: '90.0', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L'},
  {game: 'ets2' as const, units: {ets2: 'metric', ats: 'metric'} as const, speed: '90.0', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L'}
])('projects $game in its persisted profile $units', ({game, units, speed, speedUnit, fuel, fuelUnit}) => {
  const current = live(), state = current.observation!.state;
  current.selection = game; current.observation!.source.game = game;
  state.speed = {available: true, value: 25, unit: 'm/s'}; state.fuel = {available: true, value: 73, unit: 'L'};
  const before = structuredClone(current);
  expect(overlayPresentation(current, units)).toMatchObject({source: game.toUpperCase(), speed, speedUnit, fuel, fuelUnit, freshness: 'current'});
  expect(current).toStrictEqual(before);
  current.fresh = false; current.status = 'stale';
  expect(overlayPresentation(current, units)).toMatchObject({speed: '—', fuel: '—', speedUnit, fuelUnit, freshness: 'stale'});
});
it('keeps metric without a game and the fixture game profile for synthetic sources', () => {
  const units = {ets2: 'us-customary', ats: 'us-customary'} as const;
  expect(overlayPresentation(initialLive('game'), units)).toMatchObject({source: 'No game', speedUnit: 'km/h', fuelUnit: 'L'});
  const current = live(); current.selection = 'synthetic'; current.observation!.source.origin = 'synthetic';
  current.observation!.state.speed = {available: true, value: 25, unit: 'm/s'}; current.observation!.state.fuel = {available: true, value: 73, unit: 'L'};
  expect(overlayPresentation(current, units)).toMatchObject({source: 'ETS2', origin: 'synthetic', speed: '55.9', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal'});
});
// ET-012a: each layout has its own anchor and size in the game's client area (DIP -960, 0, 960 x 540 here).
it.each([
  {layout: 'strip' as const, bounds: {x: -944, y: 8, width: 928, height: 38}},
  {layout: 'card' as const, bounds: {x: -316, y: 16, width: 300, height: 360}},
  {layout: 'cluster' as const, bounds: {x: -944, y: 304, width: 440, height: 220}},
  {layout: 'hud' as const, bounds: {x: -944, y: 16, width: 320, height: 320}}
])('places the $layout layout at its own anchor and shows it without focus', ({layout, bounds}) => {
  const {window, overlay} = controller(layout); overlay.loaded(true); overlay.update(live());
  expect(window.setBounds.mock.calls).toEqual([[bounds]]); raisedAfterShow(window); noActivation(window);
});
it('re-places a visible overlay for a new layout and re-asserts topmost without showing or focusing it again', () => {
  const {window, screen, overlay} = controller(); overlay.loaded(true); overlay.update(live());
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('card');
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 928, height: 38}], [{x: -316, y: 16, width: 300, height: 360}]]);
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.setBounds.mock.invocationCallOrder[1]).toBeLessThan(window.setAlwaysOnTop.mock.invocationCallOrder[0]);
  expect(window.showInactive).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledTimes(2); noActivation(window);
  // The same layout again changes nothing.
  overlay.setLayout('card');
  expect(window.setBounds).toHaveBeenCalledTimes(2); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledTimes(2);
});
it('never shows or raises a hidden overlay when the layout changes', () => {
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.foreground = false; overlay.loaded(true); overlay.update(current);
  overlay.setLayout('hud'); overlay.setLayout('cluster');
  expect(window.showInactive).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  expect(window.setBounds).not.toHaveBeenCalled(); expect(window.hide).toHaveBeenCalled();
});
it('hides when the chosen layout does not fit the client area and shows again when one fits', () => {
  // 1920 x 700 physical is 960 x 350 DIP: the strip and cluster fit; the card (392 DIP) and HUD (352 DIP) do not.
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.height = 700; overlay.loaded(true); overlay.update(current);
  expect(window.showInactive).toHaveBeenCalledOnce();
  window.hide.mockClear(); overlay.setLayout('card'); expect(window.hide).toHaveBeenCalledOnce();
  overlay.update(current); expect(window.showInactive).toHaveBeenCalledOnce();
  overlay.setLayout('hud'); expect(window.showInactive).toHaveBeenCalledOnce();
  overlay.setLayout('cluster');
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 114, width: 440, height: 220});
  expect(window.showInactive).toHaveBeenCalledTimes(2); raisedAfterShow(window); noActivation(window);
});
