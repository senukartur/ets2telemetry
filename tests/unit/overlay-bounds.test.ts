import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import type {LiveTelemetry, OverlayEditState, OverlayPlacement, OverlaySections} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {BOUNDS_MISMATCH_REPORT_LIMIT, OverlayController} from '../../apps/desktop/src/overlay-controller';
import {overlayBounds, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';

// ET-045c (item 12 of ET-045, REG-016): the overlay window must end inside the game client after every sections change,
// with no scale nudge, even when Windows does not apply a requested rectangle exactly. The owner's ATS TruckersMP windowed
// session had a 2560 × 1440 physical game client at 150% on a 5120 × 2160 display; the fake screen divides by 1.5, so the
// client {2560, 360, 2560, 1440} is {1706.67, 240, 1706.67, 960} DIP with its bottom at 1200, on a 3413.33 × 1440 display.
//
// ET-045e (decisions Z2 and Z3) re-derived these rectangles because the requirement for the scale changed: a setting's
// zoom is setting × 0.7 and the strip is floor(min(1280 × max(1, setting), client width − 32)) wide (overlay-geometry.ts).
// At the owner's saved setting 0.5 (zoom 0.35) the strip is now 1280 wide at CSS width 3657 and every preset needs one row,
// ceil(13.3 + 2) = 16 DIP, so a preset change no longer changes its rectangle there. Each ET-045c scenario keeps its
// discriminating relation (a request below the window's height or Windows' minimum, a rectangle that changes or not on a
// preset change) at the same fractions at the setting 1 (zoom 0.7): the strip is 1280 wide, free width
// 1706.67 − 32 − 1280 = 394.67, so x = round(1706.67 + 16 + 0.8485 × 394.67) = round(2057.54) = 2058. At CSS width 1828
// (inner 1801) Everything needs two rows, ceil(76 × 0.7 + 2) = 56, and Driving only one, ceil(26.6 + 2) = 29. The bottom
// anchor puts the top at 240 + 8 + (960 − 16 − height): 1136 and 1163; the owner's 50% strip is at 1176.
const SCALE = 1.5;
const OWNER: OverlayPlacement = {x: 0.8485, y: 1, scale: 0.5};
/** The owner's fractions at the setting 1, where Everything and Driving only differ. */
const AT_100: OverlayPlacement = {...OWNER, scale: 1};
const EVERYTHING = {x: 2058, y: 1136, width: 1280, height: 56};
const DRIVING_ONLY = {x: 2058, y: 1163, width: 1280, height: 29};
/** Driving only kept 40 DIP high by Windows and fitted at the same fractions: 248 + 944 − 40 = 1152. */
const FITTED_40 = {x: 2058, y: 1152, width: 1280, height: 40};
const CLIENT = {x: 2560 / SCALE, y: 240, width: 2560 / SCALE, height: 960};

type Mode = 'faithful' | 'ignore-first-shrink' | 'min-height-40' | 'inflate-clamp-38' | 'ignore-position' | 'deferred' | 'refuse-all';
interface Report {event: string; facts: Record<string, string | number>}

function live(): LiveTelemetry {
  const snapshot = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot');
  const state = structuredClone(snapshot.data.state);
  if (!state.window.available) throw new Error('Expected window metadata');
  state.window.value = {...state.window.value, x: 2560, y: 360, width: 2560, height: 1440, dpi: 144, foreground: true, minimized: false, displayMode: 'windowed'};
  return {...initialLive('ats'), status: 'connected', fresh: true, observation: {
    source: {...snapshot.source, game: 'ats', origin: 'game'}, state, capture: snapshot.capture, seq: snapshot.seq,
    receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: snapshot.data.continuity}
  }};
}

/**
 * A window whose setBounds Windows may apply differently, as the owner's evidence showed: `faithful` applies it;
 * `ignore-first-shrink` applies x, y and width but keeps the height on the first call that lowers it (H-stale);
 * `min-height-40` never goes below `minHeight`, 40 DIP unless a test changes it (H-min); `inflate-clamp-38` adds 1 DIP of
 * rounding to the width and never goes below 38 DIP, as the ET-045c probe measured at 150%; `ignore-position` applies the
 * size but keeps the position; `deferred` reports the previous rectangle on the first read after
 * the first setBounds; `refuse-all` keeps the window where it is. getBounds() always returns the window's actual bounds.
 */
function fakeWindow(initial: DipRect = {x: 0, y: 0, width: 640, height: 59}) {
  const calls: string[] = [];
  const state = {mode: 'faithful' as Mode, bounds: {...initial}, visible: false, topmost: true, ignoreMouse: true, focusable: false, movable: false,
    skipTaskbar: true, shrinkIgnored: false, deferPending: false, deferred: undefined as DipRect | undefined, minHeight: 40};
  const window = {
    isDestroyed: () => false,
    setBounds: vi.fn((requested: DipRect) => {
      calls.push('setBounds');
      const previous = {...state.bounds};
      if (state.mode === 'refuse-all') return;
      if (state.mode === 'ignore-position') {state.bounds = {...previous, width: requested.width, height: requested.height}; return;}
      if (state.mode === 'ignore-first-shrink' && !state.shrinkIgnored && requested.height < previous.height) {
        state.shrinkIgnored = true; state.bounds = {x: requested.x, y: requested.y, width: requested.width, height: previous.height}; return;
      }
      if (state.mode === 'inflate-clamp-38') {state.bounds = {...requested, width: requested.width + 1, height: Math.max(38, requested.height)}; return;}
      state.bounds = {...requested, height: state.mode === 'min-height-40' ? Math.max(state.minHeight, requested.height) : requested.height};
      if (state.mode === 'deferred' && state.deferPending) {state.deferPending = false; state.deferred = previous;}
    }),
    getBounds: vi.fn((): DipRect => {
      if (state.deferred) {const stale = state.deferred; state.deferred = undefined; return {...stale};}
      return {...state.bounds};
    }),
    hide: vi.fn(() => {calls.push('hide'); state.visible = false;}),
    showInactive: vi.fn(() => {calls.push('showInactive'); state.visible = true;}),
    isAlwaysOnTop: () => state.topmost,
    setAlwaysOnTop: vi.fn((flag: boolean) => {calls.push('setAlwaysOnTop'); state.topmost = flag;}),
    moveTop: vi.fn(() => calls.push('moveTop')),
    setIgnoreMouseEvents: vi.fn((ignore: boolean) => {calls.push(`setIgnoreMouseEvents(${ignore})`); state.ignoreMouse = ignore;}),
    setFocusable: vi.fn((focusable: boolean) => {calls.push(`setFocusable(${focusable})`); state.focusable = focusable; state.skipTaskbar = !focusable;}),
    setSkipTaskbar: vi.fn((skip: boolean) => {calls.push(`setSkipTaskbar(${skip})`); state.skipTaskbar = skip;}),
    setMovable: vi.fn((movable: boolean) => {calls.push(`setMovable(${movable})`); state.movable = movable;}),
    // Never called: activating or focusing the overlay would steal driving input.
    show: vi.fn(), focus: vi.fn(),
    webContents: {setZoomFactor: vi.fn((factor: number) => calls.push(`zoom(${factor})`))}
  };
  const setMode = (mode: Mode) => {state.mode = mode; state.shrinkIgnored = false; state.deferPending = mode === 'deferred';};
  return {window, state, calls, setMode};
}

function setup(sections: OverlaySections = OVERLAY_PRESETS.everything, placement: OverlayPlacement = AT_100) {
  const fake = fakeWindow(), current = live(), reports: Report[] = [];
  const metadata = current.observation!.state.window;
  if (!metadata.available) throw new Error('Expected window metadata');
  const screen = {screenToDipRect: vi.fn((_window: null, rect: DipRect) => ({x: rect.x / SCALE, y: rect.y / SCALE, width: rect.width / SCALE, height: rect.height / SCALE})),
    getAllDisplays: () => [{bounds: {x: 0, y: 0, width: 5120 / SCALE, height: 2160 / SCALE}}]};
  const editChanged = vi.fn<(state: OverlayEditState) => void>();
  const overlay = new OverlayController(fake.window, screen, vi.fn(), 'strip', {placement, sections, editChanged,
    boundsReport: (event: string, facts: Record<string, string | number>) => reports.push({event, facts})});
  return {...fake, overlay, current, metadata: metadata.value, reports, editChanged, mismatches: () => reports.filter(report => report.event === 'OVERLAY_BOUNDS_MISMATCH')};
}
type Setup = ReturnType<typeof setup>;

const inside = (rect: DipRect, client: DipRect = CLIENT) => rect.x >= client.x && rect.y >= client.y &&
  rect.x + rect.width <= client.x + client.width && rect.y + rect.height <= client.y + client.height;
const setBoundsSince = (calls: string[], from: number) => calls.slice(from).filter(call => call === 'setBounds').length;
/** Driving mode, Everything at the setting 1, the game in front: the window is placed at the hand-computed rectangle. */
function drivingEverything(t: Setup) {
  t.overlay.loaded(true); t.overlay.update(t.current);
  expect(t.state.bounds).toEqual(EVERYTHING); expect(t.state.visible).toBe(true);
}
/** The owner's sequence before the edit at the setting 1: Everything while driving, then the dashboard in front saves Driving only. */
function ownerBeforeEdit(t: Setup) {
  drivingEverything(t);
  t.metadata.foreground = false; t.overlay.update(t.current); expect(t.state.visible).toBe(false);
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  expect(t.state.visible).toBe(false); expect(t.state.bounds).toEqual(EVERYTHING);
}
function noActivation(t: Setup) {expect(t.window.show).not.toHaveBeenCalled(); expect(t.window.focus).not.toHaveBeenCalled();}
/** The last topmost re-assertion follows the last setBounds and precedes the last moveTop. */
function raisedAfterLastSetBounds(t: Setup) {
  const lastSet = t.calls.lastIndexOf('setBounds'), raised = t.calls.lastIndexOf('setAlwaysOnTop');
  expect(lastSet).toBeGreaterThanOrEqual(0); expect(raised).toBeGreaterThan(lastSet); expect(t.calls.lastIndexOf('moveTop')).toBeGreaterThan(raised);
}

it('reproduces the owner case in edit mode: a shrink Windows did not apply is re-applied before the overlay shows', () => {
  const t = setup(); ownerBeforeEdit(t);
  t.setMode('ignore-first-shrink'); const from = t.calls.length;
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  expect(t.state.bounds).toEqual(DRIVING_ONLY);
  expect(DRIVING_ONLY.y + DRIVING_ONLY.height).toBeLessThanOrEqual(CLIENT.y + CLIENT.height);
  expect(t.state.visible).toBe(true); expect(t.calls.slice(from).filter(call => call === 'showInactive')).toHaveLength(1);
  // Review round 2: the hidden window is re-applied while still hidden and shown only once its rectangle is accepted.
  expect(t.calls.indexOf('showInactive', from)).toBeGreaterThan(t.calls.lastIndexOf('setBounds'));
  raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches()).toHaveLength(1);
  expect(t.mismatches()[0].facts).toMatchObject({mode: 'edit', outcome: 'reapplied', attempts: 1, reqX: 2058, reqY: 1163, reqW: 1280, reqH: 29,
    actX: 2058, actY: 1163, actW: 1280, actH: 56, clientX: 1706.67, clientY: 240, clientW: 1706.67, clientH: 960});
  // The interactive edit overlay stays interactive, never a taskbar tab.
  expect({ignoreMouse: t.state.ignoreMouse, focusable: t.state.focusable, movable: t.state.movable, skipTaskbar: t.state.skipTaskbar})
    .toEqual({ignoreMouse: false, focusable: true, movable: true, skipTaskbar: true});
  // Steady state: further updates neither move nor raise it again.
  const settled = t.calls.length; t.overlay.update(t.current); t.overlay.update(t.current);
  expect(t.calls.slice(settled)).toEqual([]);
  expect(t.overlay.endEdit()).toEqual(AT_100);
});

it('corrects a driving overlay inside the same sections change while the game is in front', () => {
  const t = setup(); drivingEverything(t);
  t.setMode('ignore-first-shrink'); const from = t.calls.length;
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  expect(t.state.bounds).toEqual(DRIVING_ONLY); expect(t.state.visible).toBe(true);
  expect(setBoundsSince(t.calls, from)).toBe(2); expect(t.window.showInactive).toHaveBeenCalledOnce();
  raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'reapplied', attempts: 1})]);
  // Click-through is never touched in driving mode.
  expect(t.window.setIgnoreMouseEvents).not.toHaveBeenCalled(); expect(t.window.setFocusable).not.toHaveBeenCalled();
});

it('fits a window Windows keeps at least 40 DIP high at the same fractions, inside the client', () => {
  const t = setup(); ownerBeforeEdit(t);
  t.setMode('min-height-40'); const from = t.calls.length;
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  // 1 request + 2 re-applies + 1 fit; the fit places 1280 × 40 at x 0.8485, y 1: {2058, 1152, 1280, 40}.
  expect(setBoundsSince(t.calls, from)).toBe(4);
  expect(t.state.bounds).toEqual(FITTED_40); expect(inside(t.state.bounds)).toBe(true); expect(t.state.visible).toBe(true);
  raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'edit', outcome: 'fitted', attempts: 2, reqH: 29, actH: 40})]);
  // The bottom anchor keeps the content at the window's bottom; the draft and the saved fractions are unchanged.
  expect(t.overlay.contentAnchorY).toBe(1);
  const settled = t.calls.length; t.overlay.update(t.current); expect(t.calls.slice(settled)).toEqual([]);
  expect(t.overlay.endEdit()).toEqual(AT_100);
  // Driving mode fits the same way from the unchanged saved placement.
  t.metadata.foreground = true; t.overlay.update(t.current);
  expect(t.state.bounds).toEqual(FITTED_40); expect(t.state.visible).toBe(true);
});

// ET-045e: the owner's saved 50% strip now requests 1280 × 16 at {2058, 1176}, below the 38 DIP minimum height the ET-045c
// probe measured at 150%. It is fitted at the same fractions to {2058, 248 + 944 − 38 = 1154, 1280, 38}, inside the
// client with its content at the window's bottom, and every preset keeps that rectangle without another setBounds.
it('fits the owner 50% strip, which now requests 16 DIP, to a 38 DIP minimum at the bottom of the client', () => {
  const t = setup(OVERLAY_PRESETS.everything, OWNER); t.setMode('min-height-40'); t.state.minHeight = 38;
  t.overlay.loaded(true); t.overlay.update(t.current);
  expect(t.state.bounds).toEqual({x: 2058, y: 1154, width: 1280, height: 38}); expect(inside(t.state.bounds)).toBe(true); expect(t.state.visible).toBe(true);
  expect(t.state.bounds.y + t.state.bounds.height).toBe(CLIENT.y + CLIENT.height - 8);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'fitted', reqX: 2058, reqY: 1176, reqW: 1280,
    reqH: 16, actH: 38})]);
  for (const sections of [OVERLAY_PRESETS['driving-only'], OVERLAY_PRESETS['job-focus'], OVERLAY_PRESETS.everything]) {
    const from = t.calls.length;
    t.overlay.setLayout('strip', OWNER, sections);
    expect(overlayBounds('strip', CLIENT, OWNER, sections)).toEqual({x: 2058, y: 1176, width: 1280, height: 16});
    expect(setBoundsSince(t.calls, from)).toBe(0); expect(t.state.bounds).toEqual({x: 2058, y: 1154, width: 1280, height: 38});
  }
  t.metadata.foreground = false; t.overlay.update(t.current);
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'visible'});
  expect(t.window.webContents.setZoomFactor).not.toHaveBeenCalled();
  noActivation(t);
});

it('hides fail-closed when Windows refuses every rectangle, reports too-large while editing and stops retrying', () => {
  const t = setup(); drivingEverything(t);
  t.setMode('refuse-all');
  // The game window moves 300 physical px (200 DIP) left while Driving only is saved: the new request cannot be applied.
  t.metadata.x -= 300; let from = t.calls.length;
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  // Request {1858, 1163, 1280, 29}, two re-applies, then the actual 1280 × 56 fitted at {1858, 1136}: all refused.
  expect(setBoundsSince(t.calls, from)).toBe(4); expect(t.state.visible).toBe(false);
  expect(t.calls.slice(from).filter(call => call === 'setAlwaysOnTop')).toEqual([]);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'hidden', reqX: 1858, reqY: 1163, actX: 2058, actY: 1136})]);
  from = t.calls.length; for (let index = 0; index < 5; index++) t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]);
  // Edit mode is a new attempt for the same rectangle; it fails closed as too large and hides before click-through.
  t.metadata.foreground = false; from = t.calls.length;
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 1, placement: 'too-large'});
  expect(setBoundsSince(t.calls, from)).toBe(4); expect(t.state.visible).toBe(false);
  expect({ignoreMouse: t.state.ignoreMouse, focusable: t.state.focusable, movable: t.state.movable, skipTaskbar: t.state.skipTaskbar})
    .toEqual({ignoreMouse: true, focusable: false, movable: false, skipTaskbar: true});
  from = t.calls.length; t.overlay.update(t.current); t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]); expect(t.overlay.editState()).toMatchObject({placement: 'too-large'});
  // Everything is a new request {1858, 1136, 1280, 56}; with Windows applying it again, the edit overlay shows.
  t.setMode('faithful'); from = t.calls.length;
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS.everything);
  expect(t.state.bounds).toEqual({x: 1858, y: 1136, width: 1280, height: 56});
  expect(t.overlay.editState()).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  expect(setBoundsSince(t.calls, from)).toBe(1); expect(t.state.visible).toBe(true); noActivation(t);
});

it('re-applies once when the first read after setBounds still reports the previous rectangle', () => {
  const t = setup(); drivingEverything(t);
  t.setMode('deferred'); const from = t.calls.length;
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  expect(t.state.bounds).toEqual(DRIVING_ONLY); expect(t.state.visible).toBe(true);
  expect(setBoundsSince(t.calls, from)).toBe(2); expect(t.window.hide).not.toHaveBeenCalled();
  expect(t.mismatches().map(report => report.facts.outcome)).toEqual(['reapplied']);
});

// Faithful Windows: every sections change at every bottom and side anchor and at 50, 100, 200 and 300 % sets each changed
// rectangle exactly once, ends contained with its margins and reports no mismatch; an unchanged rectangle sets nothing
// and does not raise the window again. At 50% every preset is one 16 DIP row, so no change moves the window. At 200% the
// strip is floor(min(2560, 1674.67)) = 1674 wide, CSS 1195, inner 1169: Everything needs four rows, ceil(152 × 1.4 + 2.8)
// = 216, and Driving only one, ceil(53.2 + 2.8) = 56. At 300% it is 1674 wide, CSS 797, inner 771: Everything needs five
// rows, ceil(190 × 2.1 + 4.2) = 404, and Driving only two, ceil(76 × 2.1 + 4.2) = 164. The cycle mixes the presets with
// single-section toggles, whose rows may or may not change.
const SECTION_CYCLE: OverlaySections[] = [OVERLAY_PRESETS['driving-only'], OVERLAY_PRESETS['job-focus'], {...OVERLAY_PRESETS['job-focus'], deadline: false},
  {...OVERLAY_PRESETS['job-focus'], deadline: false, cargo: false}, OVERLAY_PRESETS['driving-only'], {...OVERLAY_PRESETS['driving-only'], range: false},
  OVERLAY_PRESETS.everything, {...OVERLAY_PRESETS.everything, 'game-time': false}, OVERLAY_PRESETS['job-focus'], OVERLAY_PRESETS.everything];
const MATRIX = [0.5, 1, 2, 3].flatMap(scale => [0, 1].flatMap(y => [0.5, 0.8485, 1].map(x => ({x, y, scale}))));
const EVERYTHING_SIZE: Record<number, {width: number; height: number}> = {0.5: {width: 1280, height: 16}, 1: {width: 1280, height: 56},
  2: {width: 1674, height: 216}, 3: {width: 1674, height: 404}};
const DRIVING_ONLY_HEIGHT: Record<number, number> = {0.5: 16, 1: 29, 2: 56, 3: 164};
it.each(MATRIX.flatMap(placement => (['driving', 'edit'] as const).map(mode => ({placement, mode}))))(
  'keeps a faithfully placed strip inside the client across presets at $placement.x, $placement.y, scale $placement.scale ($mode)', ({placement, mode}) => {
    const t = setup(OVERLAY_PRESETS.everything, placement); t.overlay.loaded(true);
    if (mode === 'edit') {t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);}
    else t.overlay.update(t.current);
    expect(t.state.visible).toBe(true);
    expect(t.state.bounds).toMatchObject(EVERYTHING_SIZE[placement.scale]);
    let previous = t.state.bounds;
    for (const sections of SECTION_CYCLE) {
      const from = t.calls.length;
      t.overlay.setLayout('strip', placement, sections);
      const expected = overlayBounds('strip', CLIENT, placement, sections)!;
      const changed = JSON.stringify(expected) !== JSON.stringify(previous);
      expect(t.state.bounds).toEqual(expected);
      expect(setBoundsSince(t.calls, from)).toBe(changed ? 1 : 0);
      expect(t.calls.slice(from).filter(call => call === 'setAlwaysOnTop')).toHaveLength(changed ? 1 : 0);
      if (sections === OVERLAY_PRESETS['driving-only']) expect(expected.height).toBe(DRIVING_ONLY_HEIGHT[placement.scale]);
      // Contained with the strip's 16 DIP side and 8 DIP top and bottom margins, within the 1 DIP of rounding.
      expect(expected.x).toBeGreaterThanOrEqual(CLIENT.x + 16 - 1); expect(expected.x + expected.width).toBeLessThanOrEqual(CLIENT.x + CLIENT.width - 16 + 1);
      expect(expected.y).toBeGreaterThanOrEqual(CLIENT.y + 8 - 1); expect(expected.y + expected.height).toBeLessThanOrEqual(CLIENT.y + CLIENT.height - 8 + 1);
      expect(t.state.visible).toBe(true);
      previous = expected;
    }
    expect(t.mismatches()).toEqual([]); noActivation(t);
  });

it.each(['cancel', 'escape', 'minimize'] as const)('discards the draft on %s after a sections change and returns to the verified saved placement', reason => {
  // Main ends the edit through endEdit() for Cancel, Escape and a minimized dashboard alike, and drops the returned draft.
  const t = setup(); drivingEverything(t);
  t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);
  t.overlay.setEditScale(2); t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  // At 200% (zoom 1.4) Driving only is 1674 × 56 at x = round(1722.67 + 0.8485 × 0.67) = 1723, y = 248 + 888 = 1136.
  expect(t.state.bounds).toEqual({x: 1723, y: 1136, width: 1674, height: 56}); expect(t.state.visible).toBe(true);
  expect(t.window.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.4);
  const from = t.calls.length;
  expect(t.overlay.endEdit(), reason).toEqual({...AT_100, scale: 2});
  expect(t.calls.slice(from, from + 5)).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(t.window.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.7);
  // Back in driving mode at the saved setting 1 with the current sections; Windows first keeps the 56 DIP height.
  t.setMode('ignore-first-shrink'); t.metadata.foreground = true; t.overlay.update(t.current);
  expect(t.state.bounds).toEqual(DRIVING_ONLY); expect(t.state.visible).toBe(true);
  expect({ignoreMouse: t.state.ignoreMouse, focusable: t.state.focusable, movable: t.state.movable, skipTaskbar: t.state.skipTaskbar})
    .toEqual({ignoreMouse: true, focusable: false, movable: false, skipTaskbar: true});
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'reapplied'})]);
  noActivation(t);
});

it('does not verify or move the window while it is dragged, then snaps the drop and verifies it', () => {
  const t = setup(OVERLAY_PRESETS['driving-only']); t.overlay.loaded(true);
  t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);
  expect(t.state.bounds).toEqual(DRIVING_ONLY);
  t.overlay.moveStarted(); const from = t.calls.length, reads = t.window.getBounds.mock.calls.length;
  t.overlay.update(t.current); t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS.everything); t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]); expect(t.window.getBounds.mock.calls.length).toBe(reads);
  // Driving only again, still held; then the native drag leaves the window below the client and the drop snaps to y 1.
  t.overlay.setLayout('strip', AT_100, OVERLAY_PRESETS['driving-only']);
  t.state.bounds = {x: 2000, y: 1500, width: 1280, height: 29}; t.overlay.moved({x: 2000, y: 1500, width: 1280, height: 29});
  // Free width 394.67: (2000 − 1722.67) / 394.67 = 0.70270 → 0.7027, x = round(1722.67 + 277.33) = 2000.
  expect(t.state.bounds).toEqual({x: 2000, y: 1163, width: 1280, height: 29});
  expect(setBoundsSince(t.calls, from)).toBe(1); expect(t.window.getBounds.mock.calls.length).toBeGreaterThan(reads);
  expect(t.overlay.endEdit()).toEqual({x: 0.7027, y: 1, scale: 1}); expect(t.mismatches()).toEqual([]);
});

// Review round 1. A fitted window is taller than the layout: a drop where it stands must keep its fractions. With the
// window kept 40 DIP high, the free height is 944 − 40 = 904 and a drop at the fitted top 1152 is (1152 − 248) / 904 = 1;
// against the layout's 29 DIP it would be 904 / 915 = 0.988 and walk the content up by about 11 DIP on every drop.
it('keeps the fractions of a fitted window dropped where it stands, and repeated horizontal drops do not walk', () => {
  const t = setup(OVERLAY_PRESETS['driving-only']); t.setMode('min-height-40'); t.overlay.loaded(true);
  t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);
  expect(t.state.bounds).toEqual(FITTED_40);
  // Free width 394.67: 2058 → (2058 − 1722.67) / 394.67 = 0.8497, 1900 → 0.4493, 1800 → 0.1959; x snaps back to the drop.
  for (const [x, fraction] of [[2058, 0.8497], [1900, 0.4493], [1800, 0.1959]] as const) {
    t.overlay.moveStarted(); t.state.bounds = {...t.state.bounds, x}; t.overlay.moved({...t.state.bounds});
    expect(t.state.bounds).toEqual({x, y: 1152, width: 1280, height: 40}); expect(t.state.visible).toBe(true);
    expect(t.overlay.editState()).toMatchObject({placement: 'visible'}); expect(t.overlay.contentAnchorY).toBe(1);
    expect(t.state.bounds.y + t.state.bounds.height).toBe(1192);
    expect(Math.abs(fraction - (x - CLIENT.x - 16) / 394.67)).toBeLessThan(0.0001);
  }
  // Done saves the returned draft: y stays 1.
  expect(t.overlay.endEdit()).toEqual({x: 0.1959, y: 1, scale: 1});
});

// Review round 1, re-derived for ET-045e. A width-limited strip in a 750 × 1440 physical client (500 × 960 DIP at
// (1706.67, 240)) at the owner's 50% is floor(min(1280, 500 − 32)) = 468 wide with no free width, so
// x = 1706.67 + 16 = 1723 whatever the fraction. Speed and gear need one row at zoom 0.35 (tags 96 + 96, speed 140 and gear
// 90 with three 14 px gaps, 464 of the 1307 inner CSS px of floor(468 / 0.35) = 1337): 16 high at y 1176. Windows adds
// 1 DIP of width and keeps 38 high. Fitting the inflated width (469) would leave −1 DIP of free width and refuse the
// strip; only the height is fitted: {1723, 248 + 944 − 38 = 1154, 468, 38}.
it('fits only the axis Windows changed, so a width-limited strip with a rounded width stays visible', () => {
  const t = setup({...OVERLAY_PRESETS['driving-only'], rpm: false, fuel: false, range: false}, OWNER); t.metadata.width = 750;
  expect(overlayBounds('strip', {...CLIENT, width: 500}, OWNER, {...OVERLAY_PRESETS['driving-only'], rpm: false, fuel: false, range: false}))
    .toEqual({x: 1723, y: 1176, width: 468, height: 16});
  t.setMode('inflate-clamp-38'); t.overlay.loaded(true); t.overlay.update(t.current);
  expect(t.state.bounds).toEqual({x: 1723, y: 1154, width: 469, height: 38}); expect(t.state.visible).toBe(true);
  expect(t.state.bounds.x + t.state.bounds.width).toBeLessThanOrEqual(CLIENT.x + 500);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'fitted', reqW: 468, reqH: 16, actW: 469, actH: 38})]);
  t.metadata.foreground = false; t.overlay.update(t.current);
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'visible'});
  expect(t.state.bounds).toEqual({x: 1723, y: 1154, width: 469, height: 38});
});

// Review round 1. A deterministic minimum height produces the same mismatch for every lower request: the default log
// gets one line per mode, outcome and size difference, and at most BOUNDS_MISMATCH_REPORT_LIMIT per launch.
it('logs a repeated mismatch once and bounds the distinct mismatch lines per launch', () => {
  const t = setup(OVERLAY_PRESETS['driving-only']); t.setMode('min-height-40'); t.overlay.loaded(true); t.overlay.update(t.current);
  // The game window moves back and forth by 30 physical px (20 DIP), so every update is a new request on the display.
  for (let move = 0; move < 5; move++) {t.metadata.x += move % 2 === 0 ? -30 : 30; t.overlay.update(t.current); expect(t.state.bounds.height).toBe(40);}
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'fitted', reqH: 29, actH: 40})]);
  // Each new minimum is another size difference; they are still fitted after the limit, but no longer logged.
  for (let step = 1; step <= 25; step++) {
    t.state.minHeight = 40 + step; t.metadata.x += step % 2 === 0 ? -30 : 30; t.overlay.update(t.current);
    expect(t.state.bounds.height).toBe(40 + step); expect(t.state.visible).toBe(true);
  }
  expect(t.mismatches()).toHaveLength(BOUNDS_MISMATCH_REPORT_LIMIT);
  expect(t.reports.filter(report => report.event === 'OVERLAY_BOUNDS_SET')).toHaveLength(31);
});

// Review round 2. A hidden window is never shown before a rectangle is accepted, so a refused one does not flash over the
// game at a wrong size before it hides.
it('never shows a hidden window whose rectangle Windows refuses', () => {
  const t = setup(); drivingEverything(t);
  t.metadata.foreground = false; t.overlay.update(t.current); expect(t.state.visible).toBe(false);
  t.setMode('refuse-all'); t.metadata.x -= 300; t.metadata.foreground = true; const from = t.calls.length;
  t.overlay.update(t.current);
  // Request {1858, 1136, 1280, 56}, two re-applies; the size is unchanged, so there is nothing to fit.
  expect(t.calls.slice(from)).toEqual(['setBounds', 'setBounds', 'setBounds']);
  expect(t.window.showInactive).toHaveBeenCalledOnce(); expect(t.state.visible).toBe(false);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'hidden', reqX: 1858, actX: 2058})]);
});

// Review round 2. A fail-closed driving hide recovers on the next distinct game client observation and never churns
// while nothing changes. Windows first applies the size but not the position.
it('recovers a position-only refusal when the game returns to the front, with no setBounds while nothing changes', () => {
  const t = setup(); drivingEverything(t);
  t.setMode('ignore-position'); t.metadata.x -= 300; let from = t.calls.length;
  t.overlay.update(t.current);
  expect(setBoundsSince(t.calls, from)).toBe(3); expect(t.state.visible).toBe(false); expect(t.state.bounds).toEqual(EVERYTHING);
  // Window reports renew with the same client rectangle: nothing is set again.
  from = t.calls.length;
  for (let report = 1; report <= 5; report++) t.overlay.update({...t.current, observation: {...t.current.observation!, windowReceivedMonotonicMs: report * 100}});
  expect(t.calls.slice(from)).toEqual([]);
  // The mismatch clears; the game leaves the front and returns, a distinct observation: one bounded re-verification.
  t.setMode('faithful'); t.metadata.foreground = false; t.overlay.update(t.current); expect(t.calls.slice(from)).toEqual([]);
  t.metadata.foreground = true; t.overlay.update(t.current);
  expect(t.state.bounds).toEqual({...EVERYTHING, x: 1858}); expect(t.state.visible).toBe(true);
  expect(setBoundsSince(t.calls, from)).toBe(1);
  expect(t.calls.indexOf('showInactive', from)).toBeGreaterThan(t.calls.lastIndexOf('setBounds')); raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches().map(report => report.facts.outcome)).toEqual(['hidden', 'reapplied']);
  from = t.calls.length; t.overlay.update(t.current); t.overlay.update(t.current); expect(t.calls.slice(from)).toEqual([]);
});

it.each(['restored', 'moved', 'reloaded', 're-enabled'] as const)('recovers a refusal that clears on its own once the game client is %s', trigger => {
  const t = setup(); drivingEverything(t);
  t.setMode('refuse-all'); t.metadata.x -= 300; t.overlay.update(t.current); expect(t.state.visible).toBe(false);
  t.setMode('faithful'); let from = t.calls.length;
  t.overlay.update(t.current); t.overlay.update(t.current); expect(t.calls.slice(from)).toEqual([]);
  from = t.calls.length;
  if (trigger === 'restored') {t.metadata.minimized = true; t.overlay.update(t.current); t.metadata.minimized = false; t.overlay.update(t.current);}
  // 3 physical px are 2 DIP: a new request {1860, 1136, 1280, 56}.
  if (trigger === 'moved') {t.metadata.x += 3; t.overlay.update(t.current);}
  if (trigger === 'reloaded') {t.overlay.loaded(false); t.overlay.loaded(true);}
  if (trigger === 're-enabled') {t.overlay.setEnabled(false); t.overlay.setEnabled(true);}
  expect(t.state.visible).toBe(true); expect(t.state.bounds).toEqual({...EVERYTHING, x: trigger === 'moved' ? 1860 : 1858});
  expect(setBoundsSince(t.calls, from)).toBe(1);
  from = t.calls.length; t.overlay.update(t.current); expect(t.calls.slice(from)).toEqual([]);
});

it('logs a hide once per refused request and recovers an edit refusal when the edit overlay may show again', () => {
  const t = setup(); drivingEverything(t);
  t.setMode('refuse-all');
  // Two refused requests with the same size difference: each hide is logged, once.
  t.metadata.x -= 300; t.overlay.update(t.current); t.overlay.update(t.current);
  t.metadata.x -= 30; t.overlay.update(t.current);
  expect(t.mismatches().map(report => [report.facts.outcome, report.facts.reqX])).toEqual([['hidden', 1858], ['hidden', 1838]]);
  t.metadata.foreground = false;
  expect(t.overlay.beginEdit(true)).toMatchObject({placement: 'too-large'}); expect(t.window.showInactive).toHaveBeenCalledOnce();
  t.setMode('faithful'); let from = t.calls.length;
  t.overlay.update(t.current); expect(t.calls.slice(from)).toEqual([]);
  // The dashboard loses and regains the front: the edit overlay may show again and verifies once more.
  t.overlay.setOwnForeground(false); from = t.calls.length; t.overlay.setOwnForeground(true);
  expect(t.overlay.editState()).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  expect(t.state.visible).toBe(true); expect(setBoundsSince(t.calls, from)).toBe(1);
  expect(t.calls.indexOf('setIgnoreMouseEvents(false)', from)).toBeLessThan(t.calls.indexOf('setBounds', from));
  expect(t.calls.indexOf('showInactive', from)).toBeGreaterThan(t.calls.lastIndexOf('setBounds'));
});
