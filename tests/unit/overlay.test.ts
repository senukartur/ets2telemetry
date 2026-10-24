import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {LiveTelemetry, OverlayEditState, OverlayLayout, OverlayPlacement, OverlaySections} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveFreshness} from '../../apps/desktop/src/live-freshness';
import {OverlayController} from '../../apps/desktop/src/overlay-controller';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';
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
  expect(overlayPresentation(current)).toMatchObject({source: 'ETS2', speed: '36', speedUnit: 'km/h', fuel: '37.9', fuelUnit: 'L', freshness: 'current'});
  current.selection = 'ats'; current.observation!.source.game = 'ats';
  expect(overlayPresentation(current)).toMatchObject({source: 'ATS', speed: '22', speedUnit: 'mph', fuel: '10.0', fuelUnit: 'US gal'});
  expect(state.speed.value).toBe(10); expect(state.fuel.value).toBe(37.85411784);
  state.speed.value = 0; state.fuel.value = 0;
  expect(overlayPresentation(current)).toMatchObject({speed: '0', fuel: '0.0'});
});
it.each([
  {game: 'ets2' as const, unit: 'km/h', below: 0.136, above: 0.142, reverse: '-7'},
  {game: 'ats' as const, unit: 'mph', below: 0.219, above: 0.228, reverse: '-4'}
])('shows rounded zero without a minus sign and preserves signed reverse speed in $game', ({game, unit, below, above, reverse}) => {
  const current = live(), state = current.observation!.state;
  current.selection = game; current.observation!.source.game = game;
  // Values straddle 0.5 in each display unit, safely away from binary rounding ties.
  const cases = [
    {raw: -0.001, displayed: '0'},
    {raw: -0, displayed: '0'},
    {raw: 0, displayed: '0'},
    {raw: -below, displayed: '0'},
    {raw: -above, displayed: '-1'},
    {raw: below, displayed: '0'},
    {raw: above, displayed: '1'},
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
  expect(overlayPresentation(current)).toMatchObject({source: 'ETS2', origin, speed: '90', fuel: '73.0', freshness: 'current'});
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
  // ET-045c: Windows applies the requested bounds faithfully here; getBounds() reads them back.
  const window = {isDestroyed: () => false, hide: vi.fn(), bounds: {x: 0, y: 0, width: 0, height: 0},
    setBounds: vi.fn((bounds: Electron.Rectangle) => {window.bounds = {...bounds};}), getBounds: (): Electron.Rectangle => ({...window.bounds}), showInactive: vi.fn(), topmost: true,
    isAlwaysOnTop: (): boolean => window.topmost, setAlwaysOnTop: vi.fn<(flag: boolean, level: string) => void>(flag => {window.topmost = flag;}), moveTop: vi.fn(),
    // Never called by the controller: activating or focusing the overlay would steal driving input.
    show: vi.fn(), focus: vi.fn(), setFocusable: vi.fn(), setIgnoreMouseEvents: vi.fn(),
    // ET-012b: edit mode only; driving cases never change the scale, so the zoom factor is never set.
    setSkipTaskbar: vi.fn(), setMovable: vi.fn(), webContents: {setZoomFactor: vi.fn()}};
  const screen = {screenToDipRect: vi.fn((_window: null, bounds: Electron.Rectangle) => ({x: bounds.x / 2, y: bounds.y / 2, width: bounds.width / 2, height: bounds.height / 2})),
    getAllDisplays: () => [{bounds: {x: -960, y: 0, width: 1920, height: 1080}}]};
  const lost = vi.fn();
  return {window, screen, lost, overlay: new OverlayController(window, screen, lost, layout)};
}
function noActivation(window: ReturnType<typeof controller>['window']) {
  for (const method of [window.show, window.focus, window.setFocusable, window.setIgnoreMouseEvents, window.setSkipTaskbar, window.setMovable]) expect(method).not.toHaveBeenCalled();
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
  // ET-012a: the default strip layout replaces ET-008's fixed 300 x 132 box at the top left (decision L10). ET-045e: at
  // the setting 1 (zoom 0.7) the 928 DIP strip has CSS width 1325 and reserves three rows, ceil(114 × 0.7 + 2) = 82.
  expect(window.setBounds).toHaveBeenCalledWith({x: -944, y: 8, width: 928, height: 82});
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
  {game: 'ets2' as const, units: {ets2: 'us-customary', ats: 'us-customary'} as const, speed: '56', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal'},
  {game: 'ats' as const, units: {ets2: 'metric', ats: 'metric'} as const, speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L'},
  {game: 'ets2' as const, units: {ets2: 'metric', ats: 'metric'} as const, speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L'}
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
  expect(overlayPresentation(current, units)).toMatchObject({source: 'ETS2', origin: 'synthetic', speed: '56', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal'});
});
// ET-012a: each layout has its own anchor and size in the game's client area (DIP -960, 0, 960 x 540 here).
// ET-012c reserves rows for the enabled sections and ET-012d does so for the card, cluster and HUD. ET-045e changed the
// requirement for the scale: the default setting 1 renders at zoom 0.7, so with every section the strip is 928 × 82
// (three rows at CSS width 1325), the card 210 × 270, the cluster 308 × 188 and the HUD 224 × 248; the card's left edge is
// −960 + 960 − 16 − 210 = −226 and the bottom-anchored cluster's top 16 + (540 − 32 − 188) = 336.
it.each([
  {layout: 'strip' as const, bounds: {x: -944, y: 8, width: 928, height: 82}},
  {layout: 'card' as const, bounds: {x: -226, y: 16, width: 210, height: 270}},
  {layout: 'cluster' as const, bounds: {x: -944, y: 336, width: 308, height: 188}},
  {layout: 'hud' as const, bounds: {x: -944, y: 16, width: 224, height: 248}}
])('places the $layout layout at its own anchor and shows it without focus', ({layout, bounds}) => {
  const {window, overlay} = controller(layout); overlay.loaded(true); overlay.update(live());
  expect(window.setBounds.mock.calls).toEqual([[bounds]]); raisedAfterShow(window); noActivation(window);
});
it('re-places a visible overlay for a new layout and re-asserts topmost without showing or focusing it again', () => {
  const {window, screen, overlay} = controller(); overlay.loaded(true); overlay.update(live());
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('card');
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 928, height: 82}], [{x: -226, y: 16, width: 210, height: 270}]]);
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
  expect(window.setBounds).not.toHaveBeenCalled(); expect(window.hide).not.toHaveBeenCalled();
});
it('hides when the chosen layout does not fit the client area and shows again when one fits', () => {
  // 1920 x 540 physical is 960 x 270 DIP: the strip (98 DIP) and cluster (220 DIP) fit; the card (302 DIP) and HUD
  // (280 DIP) do not with every section. The cluster's top is 16 + (270 − 32 − 188) = 66.
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.height = 540; overlay.loaded(true); overlay.update(current);
  expect(window.showInactive).toHaveBeenCalledOnce();
  window.hide.mockClear(); overlay.setLayout('card'); expect(window.hide).toHaveBeenCalledOnce();
  overlay.update(current); expect(window.showInactive).toHaveBeenCalledOnce();
  overlay.setLayout('hud'); expect(window.showInactive).toHaveBeenCalledOnce();
  overlay.setLayout('cluster');
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 66, width: 308, height: 188});
  expect(window.showInactive).toHaveBeenCalledTimes(2); raisedAfterShow(window); noActivation(window);
});

// ET-012b edit mode (REG-016). The tracked window models Electron 44 on Windows, where setFocusable(focusable) also
// sets SetSkipTaskbar(!focusable). The game client is 1920 x 1080 physical at (-1920, 0), which the half-scale screen
// converts to 960 x 540 DIP at (-960, 0): the cluster's free space with every section is 620 x 320 DIP at the setting 1
// (ET-045e: zoom 0.7 makes it 308 x 188; ET-012d's 440 x 267 left 488 x 241).
function trackedController(layout: OverlayLayout = 'cluster', placement?: OverlayPlacement, sections?: OverlaySections) {
  const state = {visible: false, ignoreMouse: true, focusable: false, movable: false, skipTaskbar: true, topmost: true};
  const calls: string[] = [];
  const record = (name: string) => {calls.push(name);};
  const window = {isDestroyed: () => false, bounds: {x: 0, y: 0, width: 0, height: 0},
    hide: vi.fn(() => {record('hide'); state.visible = false;}),
    // ET-045c: Windows applies the requested bounds faithfully here; getBounds() reads them back.
    setBounds: vi.fn((bounds: Electron.Rectangle) => {record('setBounds'); window.bounds = {...bounds};}), getBounds: (): Electron.Rectangle => ({...window.bounds}),
    showInactive: vi.fn(() => {record('showInactive'); state.visible = true;}),
    isAlwaysOnTop: () => state.topmost,
    setAlwaysOnTop: vi.fn((flag: boolean) => {record('setAlwaysOnTop'); state.topmost = flag;}),
    moveTop: vi.fn(() => record('moveTop')),
    setIgnoreMouseEvents: vi.fn((ignore: boolean) => {record(`setIgnoreMouseEvents(${ignore})`); state.ignoreMouse = ignore;}),
    setFocusable: vi.fn((focusable: boolean) => {record(`setFocusable(${focusable})`); state.focusable = focusable; state.skipTaskbar = !focusable;}),
    setSkipTaskbar: vi.fn((skip: boolean) => {record(`setSkipTaskbar(${skip})`); state.skipTaskbar = skip;}),
    setMovable: vi.fn((movable: boolean) => {record(`setMovable(${movable})`); state.movable = movable;}),
    show: vi.fn(), focus: vi.fn(),
    webContents: {setZoomFactor: vi.fn((factor: number) => record(`zoom(${factor})`))}};
  const screen = {screenToDipRect: vi.fn((_window: null, bounds: Electron.Rectangle) => ({x: bounds.x / 2, y: bounds.y / 2, width: bounds.width / 2, height: bounds.height / 2})),
    getAllDisplays: () => [{bounds: {x: -960, y: 0, width: 1920, height: 1080}}]};
  const editChanged = vi.fn<(state: OverlayEditState) => void>(), anchorChanged = vi.fn<(anchor: number) => void>();
  const current = live(), metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  return {window, state, calls, screen, editChanged, anchorChanged, current, metadata: metadata.value,
    overlay: new OverlayController(window, screen, vi.fn(), layout, {...(placement ? {placement} : {}), ...(sections ? {sections} : {}), editChanged, anchorChanged})};
}
type Tracked = ReturnType<typeof trackedController>;
/** The REG-016 invariant after every controller call: never a taskbar tab; hidden or driving means click-through. */
function assertInvariant({state, overlay, metadata}: Tracked, ownForeground: boolean) {
  expect(state.skipTaskbar, 'taskbar tab').toBe(true);
  const editing = overlay.editState().active;
  if (!state.visible || !editing) {
    expect({ignoreMouse: state.ignoreMouse, focusable: state.focusable, movable: state.movable}).toEqual({ignoreMouse: true, focusable: false, movable: false});
  }
  if (state.visible && !editing) expect(metadata.foreground, 'driving needs the game in front').toBe(true);
  if (state.visible && editing) {
    expect({ownForeground, gameForeground: metadata.foreground}).toEqual({ownForeground: true, gameForeground: false});
    expect({ignoreMouse: state.ignoreMouse, focusable: state.focusable, movable: state.movable}).toEqual({ignoreMouse: false, focusable: true, movable: true});
  }
}
/** Starts edit mode over a background game while the dashboard is in front. */
function editing(tracked: Tracked) {
  tracked.overlay.loaded(true); tracked.metadata.foreground = false; tracked.overlay.update(tracked.current);
  tracked.calls.length = 0;
  return tracked.overlay.beginEdit(true);
}
it('applies visibility before discarding edit, hides interactively first, and refuses edit while off', () => {
  const tracked = trackedController(); editing(tracked); tracked.overlay.setEditScale(1.5); tracked.calls.length = 0;
  tracked.overlay.setEnabled(false);
  expect(tracked.calls.slice(0, 5)).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(tracked.calls).not.toContain('showInactive'); expect(tracked.overlay.editState()).toEqual({active: false});
  expect(() => tracked.overlay.beginEdit(true)).toThrow('Overlay is disabled'); assertInvariant(tracked, true);
  tracked.metadata.foreground = true; tracked.overlay.update(tracked.current); expect(tracked.state.visible).toBe(false);
  tracked.overlay.setEnabled(true); expect(tracked.state.visible).toBe(true); expect(tracked.overlay.editState()).toEqual({active: false});
  expect(tracked.window.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.7); assertInvariant(tracked, true);
});
it.each(['expired', 'minimized', 'background', 'source', 'failed', 'small', 'topology', 'offscreen'])('enabling never bypasses the existing %s gate', fault => {
  const tracked = trackedController(), {overlay, current, metadata, window, screen} = tracked;
  overlay.setEnabled(false); overlay.loaded(true); overlay.update(current);
  expect(window.showInactive).not.toHaveBeenCalled();
  if (fault === 'expired') current.observation!.windowFresh = false;
  if (fault === 'minimized') metadata.minimized = true;
  if (fault === 'background') metadata.foreground = false;
  if (fault === 'source') current.selection = 'synthetic';
  if (fault === 'failed') current.status = 'service-failed';
  if (fault === 'small') metadata.width = 10;
  if (fault === 'topology') overlay.topologyChanged();
  if (fault === 'offscreen') screen.screenToDipRect.mockReturnValue({x: -5000, y: 0, width: 1920, height: 1080});
  overlay.update(current); const before = structuredClone(current); overlay.setEnabled(true);
  expect(window.showInactive).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled(); expect(current).toEqual(before);
});
const order = (calls: string[], names: string[]) => names.map(name => calls.indexOf(name));

it('makes the edit overlay interactive before an inactive show and raises it afterwards, without show or focus', () => {
  const tracked = trackedController(), {window, calls} = tracked;
  expect(editing(tracked)).toEqual({active: true, layout: 'cluster', scale: 1, placement: 'visible'});
  const sequence = order(calls, ['setIgnoreMouseEvents(false)', 'setFocusable(true)', 'setSkipTaskbar(true)', 'setMovable(true)', 'setBounds', 'showInactive',
    'setAlwaysOnTop', 'moveTop']);
  expect(sequence.every(index => index >= 0)).toBe(true);
  expect([...sequence].sort((left, right) => left - right)).toEqual(sequence);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 336, width: 308, height: 188});
  expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled();
  assertInvariant(tracked, true);
});
it.each([
  {name: 'own focus loss', act: (tracked: Tracked) => tracked.overlay.setOwnForeground(false), placement: 'not-foreground', own: false},
  {name: 'the game in front', act: (tracked: Tracked) => {tracked.metadata.foreground = true; tracked.overlay.update(tracked.current);}, placement: 'not-foreground', own: true},
  {name: 'a minimized game', act: (tracked: Tracked) => {tracked.metadata.minimized = true; tracked.overlay.update(tracked.current);}, placement: 'waiting-for-game', own: true},
  {name: 'an expired window report', act: (tracked: Tracked) => tracked.overlay.update({...tracked.current, observation: {...tracked.current.observation!, windowFresh: false}}),
    placement: 'waiting-for-game', own: true},
  {name: 'a monitor change', act: (tracked: Tracked) => tracked.overlay.topologyChanged(), placement: 'waiting-for-game', own: true},
  {name: 'an overlay that is not loaded', act: (tracked: Tracked) => tracked.overlay.loaded(false), placement: 'waiting-for-game', own: true}
])('hides the edit overlay before restoring click-through on $name', ({act, placement, own}) => {
  const tracked = trackedController(); editing(tracked); tracked.calls.length = 0;
  act(tracked);
  expect(tracked.calls).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(tracked.overlay.editState()).toEqual({active: true, layout: 'cluster', scale: 1, placement});
  assertInvariant(tracked, own);
});
it('needs a game window report for edit mode, but not a foreground game', () => {
  const tracked = trackedController();
  tracked.overlay.loaded(true); expect(tracked.overlay.beginEdit(true)).toMatchObject({placement: 'waiting-for-game'});
  tracked.current.selection = 'synthetic'; tracked.overlay.update(tracked.current);
  expect(tracked.overlay.editState()).toMatchObject({placement: 'waiting-for-game'}); expect(tracked.window.showInactive).not.toHaveBeenCalled();
  tracked.current.selection = 'ets2'; tracked.metadata.foreground = false; tracked.overlay.update(tracked.current);
  expect(tracked.overlay.editState()).toMatchObject({placement: 'visible'}); expect(tracked.window.showInactive).toHaveBeenCalledOnce();
  assertInvariant(tracked, true);
});
it('leaves edit mode hidden and click-through, then shows for driving only with the game in front and never interactive', () => {
  const tracked = trackedController(), {overlay, window} = tracked; editing(tracked); tracked.calls.length = 0;
  expect(overlay.endEdit()).toEqual({x: 0, y: 1, scale: 1});
  expect(tracked.calls.slice(0, 5)).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(tracked.state.visible).toBe(false); expect(overlay.editState()).toEqual({active: false}); assertInvariant(tracked, true);
  // The dashboard is still in front: driving mode keeps the overlay hidden until the game is the foreground window.
  window.showInactive.mockClear(); overlay.update(tracked.current); expect(window.showInactive).not.toHaveBeenCalled();
  tracked.metadata.foreground = true; overlay.update(tracked.current);
  expect(window.showInactive).toHaveBeenCalledOnce(); assertInvariant(tracked, false);
  expect(overlay.endEdit()).toBeUndefined();
});
it('keeps the REG-016 invariant after every step of a deterministic driving and editing sequence', () => {
  const tracked = trackedController(), {overlay, metadata, current} = tracked;
  let own = false;
  const steps: [string, () => void][] = [
    ['driving with the game in front', () => {overlay.loaded(true); overlay.update(current);}],
    ['dashboard in front', () => {own = true; metadata.foreground = false; overlay.update(current);}],
    ['begin edit', () => {overlay.beginEdit(own);}],
    ['own focus lost', () => {own = false; overlay.setOwnForeground(false);}],
    ['own focus regained', () => {own = true; overlay.setOwnForeground(true);}],
    ['game in front while editing', () => {metadata.foreground = true; overlay.update(current);}],
    ['game in the background again', () => {metadata.foreground = false; overlay.update(current);}],
    ['game minimized', () => {metadata.minimized = true; overlay.update(current);}],
    ['game restored', () => {metadata.minimized = false; overlay.update(current);}],
    ['monitor change', () => overlay.topologyChanged()],
    ['new window report', () => {current.observation!.windowReceivedMonotonicMs = 1; overlay.update(current);}],
    ['drag started', () => overlay.moveStarted()],
    ['drag ended', () => overlay.moved({x: -700, y: 100, width: 440, height: 220})],
    ['larger', () => {overlay.setEditScale(1.5);}],
    ['reset', () => {overlay.resetEdit();}],
    ['overlay reloading', () => overlay.loaded(false)],
    ['overlay loaded', () => overlay.loaded(true)],
    ['done', () => {overlay.endEdit();}],
    ['game in front for driving', () => {own = false; metadata.foreground = true; overlay.update(current);}],
    ['dashboard in front again', () => {own = true; metadata.foreground = false; overlay.update(current);}],
    ['edit again and cancel', () => {overlay.beginEdit(own); overlay.endEdit();}]
  ];
  const shown: string[] = [];
  for (const [name, step] of steps) {
    step();
    try {assertInvariant(tracked, own);} catch (error) {throw new Error(`After step "${name}": ${String(error)}`, {cause: error});}
    if (tracked.state.visible) shown.push(`${overlay.editState().active ? 'edit' : 'drive'}: ${name}`);
  }
  // The sequence exercises both shown modes, not only hidden states.
  expect(shown).toEqual(['drive: driving with the game in front', 'edit: begin edit', 'edit: own focus regained', 'edit: game in the background again',
    'edit: game restored', 'edit: new window report', 'edit: drag started', 'edit: drag ended', 'edit: larger', 'edit: reset', 'edit: overlay loaded',
    'drive: game in front for driving']);
  expect(tracked.state.visible).toBe(false);
  expect(tracked.window.show).not.toHaveBeenCalled(); expect(tracked.window.focus).not.toHaveBeenCalled();
});
it('does not move the window while it is dragged and snaps a drop past the edges inside the client area', () => {
  const tracked = trackedController('cluster', {x: 0.5, y: 0.5, scale: 1}), {overlay, window} = tracked;
  editing(tracked);
  // x = −960 + 16 + 310 = −634, y = 16 + 160 = 176.
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -634, y: 176, width: 308, height: 188});
  overlay.moveStarted(); window.setBounds.mockClear();
  // The game window moves while the user drags: nothing is placed until the drag ends.
  tracked.metadata.x += 200; overlay.update(tracked.current); tracked.metadata.x -= 200; overlay.update(tracked.current);
  expect(window.setBounds).not.toHaveBeenCalled();
  overlay.moved({x: -2000, y: 9999, width: 308, height: 188});
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 336, width: 308, height: 188}]]);
  expect(overlay.endEdit()).toEqual({x: 0, y: 1, scale: 1});
});
it('keeps a drop inside the client area where it was dropped', () => {
  const tracked = trackedController('cluster', {x: 0.5, y: 0.5, scale: 1}), {overlay, window} = tracked;
  editing(tracked); overlay.moveStarted(); window.setBounds.mockClear();
  // The native drag moved the window itself (ET-045c: the controller verifies against its actual bounds).
  window.bounds = {x: -600, y: 200, width: 308, height: 188}; overlay.moved({x: -600, y: 200, width: 308, height: 188});
  // (-600 + 944) / 620 = 0.55484 and (200 - 16) / 320 = 0.575, rounded to four decimals; the window stays where it was dropped.
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(overlay.endEdit()).toEqual({x: 0.5548, y: 0.575, scale: 1});
});
it('applies the edited scale as zoom factor and size, and reports a scale that does not fit as too large', () => {
  const tracked = trackedController('cluster', {x: 0.5, y: 0.5, scale: 1}), {overlay, window} = tracked;
  editing(tracked); tracked.calls.length = 0;
  expect(overlay.setEditScale(1.5)).toEqual({active: true, layout: 'cluster', scale: 1.5, placement: 'visible'});
  // ET-045e: the setting 1.5 is zoom 1.05. With every section 462 x 281 (ceil(265 × 1.05 + 2.1)) leaves 466 x 227 DIP of
  // free space: x = −960 + 16 + 233 = −711, y = round(16 + 113.5) = 130.
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -711, y: 130, width: 462, height: 281});
  expect(tracked.calls.indexOf('zoom(1.05)')).toBeLessThan(tracked.calls.indexOf('setBounds'));
  // A 300 DIP high client area has no room for 281 + 32.
  tracked.metadata.height = 600; overlay.update(tracked.current);
  expect(overlay.editState()).toEqual({active: true, layout: 'cluster', scale: 1.5, placement: 'too-large'});
  expect(tracked.state.visible).toBe(false); assertInvariant(tracked, true);
  expect(overlay.resetEdit()).toEqual({active: true, layout: 'cluster', scale: 1, placement: 'visible'});
  expect(window.webContents.setZoomFactor.mock.calls).toEqual([[1.05], [0.7]]);
  // Cancel returns to the saved scale, whose zoom is applied even while the overlay stays hidden.
  overlay.setEditScale(0.5); expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([0.35]);
  overlay.endEdit();
  expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([0.7]);
  overlay.restoreZoom(); expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([0.7]);
});
it('applies the zoom of the 50% and 300% settings while editing', () => {
  const tracked = trackedController('card', {x: 0, y: 0, scale: 1}), {overlay, window} = tracked;
  // A 2560 x 2000 physical client is 1280 x 1000 DIP at (-960, 0): the card at 3 (630 × 807) leaves 618 x 161 free.
  tracked.metadata.width = 2560; tracked.metadata.height = 2000; editing(tracked);
  expect(overlay.setEditScale(3)).toEqual({active: true, layout: 'card', scale: 3, placement: 'visible'});
  expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([2.1]);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 16, width: 630, height: 807});
  expect(overlay.setEditScale(0.5)).toEqual({active: true, layout: 'card', scale: 0.5, placement: 'visible'});
  expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([0.35]);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 16, width: 105, height: 136});
  expect(overlay.endEdit()).toEqual({x: 0, y: 0, scale: 0.5});
  expect(window.webContents.setZoomFactor.mock.lastCall).toEqual([0.7]);
});
it('reports each edit state change once', () => {
  const tracked = trackedController(), {overlay, editChanged} = tracked;
  editing(tracked); overlay.update(tracked.current); overlay.update(tracked.current);
  overlay.setOwnForeground(false); overlay.setOwnForeground(false); overlay.setEditScale(1.2); overlay.endEdit();
  expect(editChanged.mock.calls.map(([state]) => state)).toEqual([
    {active: true, layout: 'cluster', scale: 1, placement: 'visible'}, {active: true, layout: 'cluster', scale: 1, placement: 'not-foreground'},
    {active: true, layout: 'cluster', scale: 1.2, placement: 'not-foreground'}, {active: false}]);
});
it('re-places a visible driving overlay for a new saved placement and scale of the same layout without showing it again', () => {
  const tracked = trackedController(), {overlay, window} = tracked;
  overlay.loaded(true); overlay.update(tracked.current); tracked.calls.length = 0;
  overlay.setLayout('cluster', {x: 0.5, y: 0.5, scale: 1.5});
  expect(tracked.calls).toEqual(['zoom(1.05)', 'setBounds', 'setAlwaysOnTop', 'moveTop']);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -711, y: 130, width: 462, height: 281});
  overlay.setLayout('cluster', {x: 0.5, y: 0.5, scale: 1.5}); expect(tracked.calls).toHaveLength(4);
  expect(window.showInactive).toHaveBeenCalledOnce(); assertInvariant(tracked, false);
  for (const method of [window.setFocusable, window.setIgnoreMouseEvents, window.setSkipTaskbar, window.setMovable]) expect(method).not.toHaveBeenCalled();
});
it('keeps the draft while a saved placement arrives during editing, and cancels the edit for another layout', () => {
  const tracked = trackedController(), {overlay} = tracked;
  editing(tracked); overlay.setEditScale(1.2);
  overlay.setLayout('cluster', {x: 0.25, y: 0.25, scale: 1});
  expect(overlay.editState()).toMatchObject({active: true, scale: 1.2});
  overlay.setLayout('hud');
  expect(overlay.editState()).toEqual({active: false}); expect(tracked.state.visible).toBe(false); assertInvariant(tracked, true);
});
it('places a restarted overlay at its saved non-default placement in driving mode without changing the zoom it was created with', () => {
  // As after a restart: the window was created at the saved setting 1.5, whose zoom is 1.05 (ET-045e). The cluster with
  // every section is then 462 x 281 DIP; the 960 x 540 client leaves 960 - 32 - 462 = 466 by 540 - 32 - 281 = 227 DIP
  // free, and half of each is 233 and 113.5: x = -960 + 16 + 233 = -711 and y = round(16 + 113.5) = 130.
  const tracked = trackedController('cluster', {x: 0.5, y: 0.5, scale: 1.5}), {overlay, window} = tracked;
  overlay.loaded(true); overlay.update(tracked.current);
  expect(window.setBounds.mock.calls).toEqual([[{x: -711, y: 130, width: 462, height: 281}]]);
  expect(window.showInactive).toHaveBeenCalledOnce(); assertInvariant(tracked, false);
  expect(window.webContents.setZoomFactor).not.toHaveBeenCalled();
  // A reloaded document gets the saved zoom again; the default placement returns the zoom to 0.7.
  overlay.restoreZoom(); expect(window.webContents.setZoomFactor.mock.calls).toEqual([[1.05]]);
  overlay.setLayout('cluster');
  expect(window.webContents.setZoomFactor.mock.calls).toEqual([[1.05], [0.7]]);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 336, width: 308, height: 188});
});

// ET-012c (decision S7): the strip reserves rows for the saved sections, so a sections save can change its height. The
// expected rectangles are hand-computed at the setting 1 (zoom 0.7, ET-045e): in the 960 x 540 DIP client the strip is 928
// wide at CSS width 1325 (inner 1298), three rows (ceil(114 × 0.7 + 2) = 82) with every section and one
// (ceil(26.6 + 2) = 29) with driving-only.
it('re-places a visible strip for saved sections once, raising it without showing or focusing it again', () => {
  const {window, screen, overlay} = controller(); overlay.loaded(true); overlay.update(live());
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 928, height: 82}]]);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, OVERLAY_PRESETS['driving-only']);
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 928, height: 82}], [{x: -944, y: 8, width: 928, height: 29}]]);
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.setBounds.mock.invocationCallOrder[1]).toBeLessThan(window.setAlwaysOnTop.mock.invocationCallOrder[0]);
  expect(window.setAlwaysOnTop.mock.invocationCallOrder[0]).toBeLessThan(window.moveTop.mock.invocationCallOrder[0]);
  expect(window.showInactive).toHaveBeenCalledOnce(); noActivation(window);
  // The same sections again, even as another object, change nothing.
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, {...OVERLAY_PRESETS['driving-only']});
  expect(window.setBounds).toHaveBeenCalledTimes(2); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce(); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(screen.screenToDipRect).toHaveBeenCalledTimes(2);
});
it('neither moves nor raises a visible strip when saved sections keep its reserved rows', () => {
  // A 2624 x 1080 physical client is 1312 x 540 DIP: the strip is 1280 wide, two rows (ceil(76 × 0.7 + 2) = 56) with every
  // section and still two without RPM and cargo (the first row ends at destination, 1694 of 1801 inner CSS px).
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.width = 2624; overlay.loaded(true); overlay.update(current);
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 1280, height: 56}]]);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, {...DEFAULT_OVERLAY_SECTIONS, rpm: false, cargo: false});
  expect(window.setBounds).toHaveBeenCalledOnce(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled();
  expect(window.showInactive).toHaveBeenCalledOnce(); noActivation(window);
});
it('never shows, raises or moves a hidden strip when the saved sections change', () => {
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.foreground = false; overlay.loaded(true); overlay.update(current);
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, OVERLAY_PRESETS['driving-only']);
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, OVERLAY_PRESETS['job-focus']);
  expect(window.showInactive).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  expect(window.setBounds).not.toHaveBeenCalled(); expect(window.hide).not.toHaveBeenCalled();
  // Back in front, the strip shows once at the latest sections' size. Job-focus at 928 (inner 1298) needs two rows:
  // tags, speed, gear, fuel, cargo and destination = 1296 (distance remaining would reach 1460); distance remaining and
  // deadline. ceil(76 × 0.7 + 2) = 56.
  metadata.value.foreground = true; overlay.update(current);
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 8, width: 928, height: 56}]]); expect(window.showInactive).toHaveBeenCalledOnce();
});
it('keeps the strip rectangle while only the values change', () => {
  const {window, screen, overlay} = controller(), current = live(), state = current.observation!.state;
  overlay.loaded(true); overlay.update(current);
  for (const speed of [0, 12.5, 33.3]) {
    state.speed = {available: true, value: speed, unit: 'm/s'}; state.fuel = {available: false, reason: 'not-observed', unit: 'L'};
    overlay.update({...current, observation: {...current.observation!, receivedMonotonicMs: speed}});
  }
  expect(window.setBounds).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledOnce();
  expect(window.showInactive).toHaveBeenCalledOnce(); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce();
});
it('re-sizes the edit strip for saved sections from the unchanged draft fractions', () => {
  const tracked = trackedController('strip'), {overlay, window} = tracked;
  editing(tracked);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 8, width: 928, height: 82});
  // A drop at y 100: free height 540 − 16 − 82 = 442; 92 / 442 = 0.208145… normalizes to 0.2081 (four decimals).
  // There is no free width, so the draft retains x = 0.5.
  overlay.moveStarted(); overlay.moved({x: -944, y: 100, width: 928, height: 82});
  window.setBounds.mockClear(); tracked.calls.length = 0;
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, OVERLAY_PRESETS['driving-only']);
  // Driving-only: free height 540 − 16 − 29 = 495, y = round(8 + 0.2081 × 495) = round(111.01) = 111.
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 111, width: 928, height: 29}]]);
  expect(tracked.calls).toEqual(['setBounds', 'setAlwaysOnTop', 'moveTop']);
  expect(overlay.editState()).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  assertInvariant(tracked, true);
  expect(overlay.endEdit()).toEqual({x: 0.5, y: 0.2081, scale: 1});
});
it('reports an edit strip that no longer fits its saved sections as too large and hides it before click-through', () => {
  // A 1920 x 160 physical client is 960 x 80 DIP: driving-only needs 29 + 16 = 45, every section 82 + 16 = 98.
  const tracked = trackedController('strip', undefined, OVERLAY_PRESETS['driving-only']), {overlay, window} = tracked;
  tracked.metadata.height = 160; editing(tracked);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 8, width: 928, height: 29});
  tracked.calls.length = 0;
  overlay.setLayout('strip', DEFAULT_OVERLAY_PLACEMENTS.strip, DEFAULT_OVERLAY_SECTIONS);
  expect(overlay.editState()).toEqual({active: true, layout: 'strip', scale: 1, placement: 'too-large'});
  expect(tracked.calls).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  assertInvariant(tracked, true);
});

// ET-012d (decisions K4 and K9): the card, cluster and HUD reserve rows for the saved sections, so a sections save can
// change their height through the unchanged controller path. Hand-computed in the 960 x 540 DIP client at (-960, 0) at
// the setting 1 (zoom 0.7, ET-045e): the card is 210 wide and 270 high with every section (ceil(382 × 0.7 + 2)) and 252
// (its nominal floor round(360 × 0.7)) with driving-only or job-focus; the cluster is 308 wide and 188 high with every
// section (ceil(265 × 0.7 + 2)) at y = 16 + (540 − 32 − 188) = 336, and 154 with driving-only at
// y = 16 + (540 − 32 − 154) = 370.
it('re-places a visible card for saved sections once, raising it without showing or focusing it again', () => {
  const {window, overlay} = controller('card'); overlay.loaded(true); overlay.update(live());
  expect(window.setBounds.mock.calls).toEqual([[{x: -226, y: 16, width: 210, height: 270}]]);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('card', DEFAULT_OVERLAY_PLACEMENTS.card, OVERLAY_PRESETS['driving-only']);
  expect(window.setBounds.mock.calls).toEqual([[{x: -226, y: 16, width: 210, height: 270}], [{x: -226, y: 16, width: 210, height: 252}]]);
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.setBounds.mock.invocationCallOrder[1]).toBeLessThan(window.setAlwaysOnTop.mock.invocationCallOrder[0]);
  expect(window.setAlwaysOnTop.mock.invocationCallOrder[0]).toBeLessThan(window.moveTop.mock.invocationCallOrder[0]);
  expect(window.showInactive).toHaveBeenCalledOnce(); noActivation(window);
  // Job-focus keeps the card's nominal 252: the window neither moves nor is raised again.
  overlay.setLayout('card', DEFAULT_OVERLAY_PLACEMENTS.card, OVERLAY_PRESETS['job-focus']);
  expect(window.setBounds).toHaveBeenCalledTimes(2); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce(); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.showInactive).toHaveBeenCalledOnce(); noActivation(window);
});
it('never shows, raises or moves a hidden card when the saved sections change', () => {
  const {window, overlay} = controller('card'), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  metadata.value.foreground = false; overlay.loaded(true); overlay.update(current);
  overlay.setLayout('card', DEFAULT_OVERLAY_PLACEMENTS.card, OVERLAY_PRESETS['driving-only']);
  overlay.setLayout('card', DEFAULT_OVERLAY_PLACEMENTS.card, DEFAULT_OVERLAY_SECTIONS);
  expect(window.showInactive).not.toHaveBeenCalled(); expect(window.moveTop).not.toHaveBeenCalled(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  expect(window.setBounds).not.toHaveBeenCalled(); expect(window.hide).not.toHaveBeenCalled();
});
it('moves the top edge of a bottom-anchored cluster when saved sections change its height', () => {
  const {window, overlay} = controller('cluster'); overlay.loaded(true); overlay.update(live());
  expect(window.setBounds.mock.calls).toEqual([[{x: -944, y: 336, width: 308, height: 188}]]);
  window.setAlwaysOnTop.mockClear(); window.moveTop.mockClear();
  overlay.setLayout('cluster', DEFAULT_OVERLAY_PLACEMENTS.cluster, OVERLAY_PRESETS['driving-only']);
  expect(window.setBounds).toHaveBeenLastCalledWith({x: -944, y: 370, width: 308, height: 154});
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(window.moveTop).toHaveBeenCalledOnce();
  expect(window.showInactive).toHaveBeenCalledOnce(); noActivation(window);
});
it.each(['card', 'cluster', 'hud'] as const)('keeps the %s rectangle while only the values change', layout => {
  const {window, screen, overlay} = controller(layout), current = live(), state = current.observation!.state;
  overlay.loaded(true); overlay.update(current);
  for (const speed of [0, 12.5, 33.3]) {
    state.speed = {available: true, value: speed, unit: 'm/s'}; state.fuel = {available: false, reason: 'not-observed', unit: 'L'};
    overlay.update({...current, observation: {...current.observation!, receivedMonotonicMs: speed}});
  }
  expect(window.setBounds).toHaveBeenCalledOnce(); expect(screen.screenToDipRect).toHaveBeenCalledOnce();
  expect(window.showInactive).toHaveBeenCalledOnce(); expect(window.setAlwaysOnTop).toHaveBeenCalledOnce();
});

// ET-035: hide idempotency prevents redundant BrowserWindow.hide() dispatches at 20 Hz when game metadata is absent or unready.
it('never calls window.hide() when update() is called repeatedly with unavailable game metadata while hidden', () => {
  const {window, overlay} = controller(), current = live();
  current.observation!.state.window = {available: false, reason: 'not-observed'};
  overlay.loaded(true);
  for (let i = 0; i < 20; i++) {
    overlay.update(current);
  }
  expect(window.hide).not.toHaveBeenCalled();
  expect(window.showInactive).not.toHaveBeenCalled();
});
it('calls window.hide() exactly once when transitioning from visible to hidden, and ignores subsequent updates while hidden', () => {
  const {window, overlay} = controller(), current = live();
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected metadata');
  overlay.loaded(true);
  overlay.update(current);
  expect(window.showInactive).toHaveBeenCalledOnce();
  expect(window.hide).not.toHaveBeenCalled();

  metadata.value.foreground = false;
  overlay.update(current);
  expect(window.hide).toHaveBeenCalledOnce();

  for (let i = 0; i < 20; i++) {
    overlay.update(current);
  }
  expect(window.hide).toHaveBeenCalledOnce();
});
it('transitions to hidden and resets interactivity flags once on ending edit mode, ignoring subsequent redundant hide requests', () => {
  const tracked = trackedController();
  editing(tracked);
  tracked.calls.length = 0;

  tracked.overlay.endEdit();
  expect(tracked.calls).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(tracked.state.visible).toBe(false);

  tracked.calls.length = 0;
  tracked.metadata.foreground = false;
  for (let i = 0; i < 20; i++) {
    tracked.overlay.update(tracked.current);
  }
  tracked.overlay.setLayout('strip');
  expect(tracked.calls).toEqual([]);
});

it.each(['strip', 'card', 'cluster', 'hud'] as const)('keeps %s native capacity fixed across sparse/populated readings and uses committed anchors', layout => {
  const t = trackedController(layout, {x: 0.5, y: 1, scale: 1}); t.overlay.loaded(true); t.overlay.update(t.current);
  expect(t.overlay.contentAnchorY).toBe(1); t.window.setBounds.mockClear();
  t.current.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  t.overlay.update(t.current); t.current.observation!.state.speed = {available: true, value: 25, unit: 'm/s'}; t.overlay.update(t.current);
  expect(t.window.setBounds).not.toHaveBeenCalled(); expect(t.anchorChanged).not.toHaveBeenCalled();
});
it('publishes a fraction-only drag once after release, freezes anchor/zoom/bounds while held and restores committed anchor on cancel', () => {
  const t = trackedController('cluster', {x: 0, y: 1, scale: 1}); editing(t);
  t.overlay.moveStarted(); t.window.setBounds.mockClear(); t.window.webContents.setZoomFactor.mockClear();
  t.overlay.resetEdit(); t.overlay.setEditScale(1.1); t.overlay.update(t.current);
  expect(t.overlay.contentAnchorY).toBe(1); expect(t.anchorChanged).not.toHaveBeenCalled();
  expect(t.window.setBounds).not.toHaveBeenCalled(); expect(t.window.webContents.setZoomFactor).not.toHaveBeenCalled();
  t.overlay.moved({x: -700, y: 100, width: 484, height: 294});
  expect(t.overlay.contentAnchorY).toBeGreaterThan(0); expect(t.overlay.contentAnchorY).toBeLessThan(1);
  expect(t.anchorChanged).toHaveBeenCalledOnce(); expect(t.window.webContents.setZoomFactor).toHaveBeenCalledOnce();
  t.overlay.endEdit(); expect(t.overlay.contentAnchorY).toBe(1); expect(t.anchorChanged).toHaveBeenCalledTimes(2);
});
it.each(['off', 'document', 'cancel'] as const)('retires a held drag on %s and applies the current anchor/scale without a late move', action => {
  const t = trackedController('card', {x: 1, y: 1, scale: 1}); editing(t);
  t.overlay.moveStarted(); t.overlay.resetEdit(); t.overlay.setEditScale(1.1);
  expect(t.overlay.contentAnchorY).toBe(1);
  if (action === 'off') t.overlay.setEnabled(false);
  else if (action === 'document') t.overlay.loaded(false);
  else t.overlay.endEdit();
  expect(t.state.visible).toBe(false); expect(t.state.ignoreMouse).toBe(true);
  expect(t.overlay.contentAnchorY).toBe(action === 'document' ? 0 : 1);
  if (action === 'off') t.overlay.setEnabled(true);
  if (action === 'document') t.overlay.loaded(true);
  t.overlay.update(t.current);
  expect(t.overlay.contentAnchorY).toBe(action === 'document' ? 0 : 1);
});
