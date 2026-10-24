import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import type {LiveTelemetry, OverlayEditState, OverlayPlacement, OverlaySections} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {OverlayController} from '../../apps/desktop/src/overlay-controller';
import {overlayBounds, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';

// ET-045c (item 12 of ET-045, REG-016): the overlay window must end inside the game client after every sections change,
// with no scale nudge, even when Windows does not apply a requested rectangle exactly. The owner's ATS TruckersMP windowed
// session had a 2560 × 1440 physical game client at 150% on a 5120 × 2160 display; the fake screen divides by 1.5, so the
// client {2560, 360, 2560, 1440} is {1706.67, 240, 1706.67, 960} DIP with its bottom at 1200, on a 3413.33 × 1440 display.
//
// Hand-computed strip rectangles at the owner's saved placement x 0.8485, y 1, scale 0.5 (overlay-geometry.ts): the strip
// is floor(min(1280 × 0.5, 1706.67 − 32)) = 640 wide at CSS width 1280; free width 1706.67 − 32 − 640 = 1034.67, so
// x = round(1706.67 + 16 + 0.8485 × 1034.67) = round(2600.58) = 2601. At zoom 0.5 a row is 19 DIP and the snapped border
// adds 2: Job focus needs two rows, ceil(38 × 2 × 0.5 + 2) = 40; Driving only one, ceil(19 + 2) = 21; Everything three,
// ceil(57 + 2) = 59. The bottom anchor puts the top at 240 + 8 + (960 − 16 − height): 1152, 1171 and 1133.
const SCALE = 1.5;
const OWNER: OverlayPlacement = {x: 0.8485, y: 1, scale: 0.5};
const JOB_FOCUS = {x: 2601, y: 1152, width: 640, height: 40};
const DRIVING_ONLY = {x: 2601, y: 1171, width: 640, height: 21};
const CLIENT = {x: 2560 / SCALE, y: 240, width: 2560 / SCALE, height: 960};

type Mode = 'faithful' | 'ignore-first-shrink' | 'min-height-40' | 'deferred' | 'refuse-all';
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
 * `min-height-40` never goes below 40 DIP (H-min); `deferred` reports the previous rectangle on the first read after
 * the first setBounds; `refuse-all` keeps the window where it is. getBounds() always returns the window's actual bounds.
 */
function fakeWindow(initial: DipRect = {x: 0, y: 0, width: 640, height: 59}) {
  const calls: string[] = [];
  const state = {mode: 'faithful' as Mode, bounds: {...initial}, visible: false, topmost: true, ignoreMouse: true, focusable: false, movable: false,
    skipTaskbar: true, shrinkIgnored: false, deferPending: false, deferred: undefined as DipRect | undefined};
  const window = {
    isDestroyed: () => false,
    setBounds: vi.fn((requested: DipRect) => {
      calls.push('setBounds');
      const previous = {...state.bounds};
      if (state.mode === 'refuse-all') return;
      if (state.mode === 'ignore-first-shrink' && !state.shrinkIgnored && requested.height < previous.height) {
        state.shrinkIgnored = true; state.bounds = {x: requested.x, y: requested.y, width: requested.width, height: previous.height}; return;
      }
      state.bounds = {...requested, height: state.mode === 'min-height-40' ? Math.max(40, requested.height) : requested.height};
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

function setup(sections: OverlaySections = OVERLAY_PRESETS['job-focus'], placement: OverlayPlacement = OWNER) {
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
/** Driving mode, Job focus, the game in front: the window is placed at the hand-computed Job focus rectangle. */
function drivingJobFocus(t: Setup) {
  t.overlay.loaded(true); t.overlay.update(t.current);
  expect(t.state.bounds).toEqual(JOB_FOCUS); expect(t.state.visible).toBe(true);
}
/** The owner's sequence before the edit: Job focus while driving, then the dashboard in front saves Driving only. */
function ownerBeforeEdit(t: Setup) {
  drivingJobFocus(t);
  t.metadata.foreground = false; t.overlay.update(t.current); expect(t.state.visible).toBe(false);
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
  expect(t.state.visible).toBe(false); expect(t.state.bounds).toEqual(JOB_FOCUS);
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
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'visible'});
  expect(t.state.bounds).toEqual(DRIVING_ONLY);
  expect(DRIVING_ONLY.y + DRIVING_ONLY.height).toBeLessThanOrEqual(CLIENT.y + CLIENT.height);
  expect(t.state.visible).toBe(true); expect(t.calls.slice(from).filter(call => call === 'showInactive')).toHaveLength(1);
  raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches()).toHaveLength(1);
  expect(t.mismatches()[0].facts).toMatchObject({mode: 'edit', outcome: 'reapplied', attempts: 1, reqX: 2601, reqY: 1171, reqW: 640, reqH: 21,
    actX: 2601, actY: 1171, actW: 640, actH: 40, clientX: 1706.67, clientY: 240, clientW: 1706.67, clientH: 960});
  // The interactive edit overlay stays interactive, never a taskbar tab.
  expect({ignoreMouse: t.state.ignoreMouse, focusable: t.state.focusable, movable: t.state.movable, skipTaskbar: t.state.skipTaskbar})
    .toEqual({ignoreMouse: false, focusable: true, movable: true, skipTaskbar: true});
  // Steady state: further updates neither move nor raise it again.
  const settled = t.calls.length; t.overlay.update(t.current); t.overlay.update(t.current);
  expect(t.calls.slice(settled)).toEqual([]);
  expect(t.overlay.endEdit()).toEqual(OWNER);
});

it('corrects a driving overlay inside the same sections change while the game is in front', () => {
  const t = setup(); drivingJobFocus(t);
  t.setMode('ignore-first-shrink'); const from = t.calls.length;
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
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
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'visible'});
  // 1 request + 2 re-applies + 1 fit; the fit places 640 × 40 at x 0.8485, y 1: {2601, 1152, 640, 40}.
  expect(setBoundsSince(t.calls, from)).toBe(4);
  expect(t.state.bounds).toEqual(JOB_FOCUS); expect(inside(t.state.bounds)).toBe(true); expect(t.state.visible).toBe(true);
  raisedAfterLastSetBounds(t); noActivation(t);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'edit', outcome: 'fitted', attempts: 2, reqH: 21, actH: 40})]);
  // The bottom anchor keeps the content at the window's bottom; the draft and the saved fractions are unchanged.
  expect(t.overlay.contentAnchorY).toBe(1);
  const settled = t.calls.length; t.overlay.update(t.current); expect(t.calls.slice(settled)).toEqual([]);
  expect(t.overlay.endEdit()).toEqual(OWNER);
  // Driving mode fits the same way from the unchanged saved placement.
  t.metadata.foreground = true; t.overlay.update(t.current);
  expect(t.state.bounds).toEqual(JOB_FOCUS); expect(t.state.visible).toBe(true);
});

it('hides fail-closed when Windows refuses every rectangle, reports too-large while editing and stops retrying', () => {
  const t = setup(); drivingJobFocus(t);
  t.setMode('refuse-all');
  // The game window moves 300 physical px left while Driving only is saved: the new request cannot be applied.
  t.metadata.x -= 300; let from = t.calls.length;
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
  // Request {2401, 1171, 640, 21}, two re-applies, then the actual 640 × 40 fitted at {2401, 1152}: all refused.
  expect(setBoundsSince(t.calls, from)).toBe(4); expect(t.state.visible).toBe(false);
  expect(t.calls.slice(from).filter(call => call === 'setAlwaysOnTop')).toEqual([]);
  expect(t.mismatches().map(report => report.facts)).toEqual([expect.objectContaining({mode: 'driving', outcome: 'hidden', reqX: 2401, reqY: 1171, actX: 2601, actY: 1152})]);
  from = t.calls.length; for (let index = 0; index < 5; index++) t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]);
  // Edit mode is a new attempt for the same rectangle; it fails closed as too large and hides before click-through.
  t.metadata.foreground = false; from = t.calls.length;
  expect(t.overlay.beginEdit(true)).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'too-large'});
  expect(setBoundsSince(t.calls, from)).toBe(4); expect(t.state.visible).toBe(false);
  expect({ignoreMouse: t.state.ignoreMouse, focusable: t.state.focusable, movable: t.state.movable, skipTaskbar: t.state.skipTaskbar})
    .toEqual({ignoreMouse: true, focusable: false, movable: false, skipTaskbar: true});
  from = t.calls.length; t.overlay.update(t.current); t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]); expect(t.overlay.editState()).toMatchObject({placement: 'too-large'});
  // Everything is a new rectangle {2401, 1133, 640, 59}; with Windows applying it again, the edit overlay shows.
  t.setMode('faithful'); from = t.calls.length;
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS.everything);
  expect(t.state.bounds).toEqual({x: 2401, y: 1133, width: 640, height: 59});
  expect(t.overlay.editState()).toEqual({active: true, layout: 'strip', scale: 0.5, placement: 'visible'});
  expect(setBoundsSince(t.calls, from)).toBe(1); expect(t.state.visible).toBe(true); noActivation(t);
});

it('re-applies once when the first read after setBounds still reports the previous rectangle', () => {
  const t = setup(); drivingJobFocus(t);
  t.setMode('deferred'); const from = t.calls.length;
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
  expect(t.state.bounds).toEqual(DRIVING_ONLY); expect(t.state.visible).toBe(true);
  expect(setBoundsSince(t.calls, from)).toBe(2); expect(t.window.hide).not.toHaveBeenCalled();
  expect(t.mismatches().map(report => report.facts.outcome)).toEqual(['reapplied']);
});

// Faithful Windows: every sections change at every bottom and side anchor and at 50, 100 and 200 % sets each changed
// rectangle exactly once, ends contained with its margins and reports no mismatch; an unchanged rectangle sets nothing
// and does not raise the window again. At scale 2 the strip is floor(min(2560, 1674.67)) = 1674 wide, inner 837 CSS:
// Everything needs five rows, ceil(76 × 5 + 4) = 384, and Driving only two, ceil(76 × 2 + 4) = 156. The cycle mixes the
// presets with single-section toggles, whose rows may or may not change.
const SECTION_CYCLE: OverlaySections[] = [OVERLAY_PRESETS['driving-only'], OVERLAY_PRESETS['job-focus'], {...OVERLAY_PRESETS['job-focus'], deadline: false},
  {...OVERLAY_PRESETS['job-focus'], deadline: false, cargo: false}, OVERLAY_PRESETS['driving-only'], {...OVERLAY_PRESETS['driving-only'], range: false},
  OVERLAY_PRESETS.everything, {...OVERLAY_PRESETS.everything, 'game-time': false}, OVERLAY_PRESETS['job-focus'], OVERLAY_PRESETS.everything];
const MATRIX = [0.5, 1, 2].flatMap(scale => [0, 1].flatMap(y => [0.5, 0.8485, 1].map(x => ({x, y, scale}))));
it.each(MATRIX.flatMap(placement => (['driving', 'edit'] as const).map(mode => ({placement, mode}))))(
  'keeps a faithfully placed strip inside the client across presets at $placement.x, $placement.y, scale $placement.scale ($mode)', ({placement, mode}) => {
    const t = setup(OVERLAY_PRESETS.everything, placement); t.overlay.loaded(true);
    if (mode === 'edit') {t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);}
    else t.overlay.update(t.current);
    expect(t.state.visible).toBe(true);
    if (placement.scale === 2) expect(t.state.bounds).toMatchObject({width: 1674, height: 384});
    let previous = t.state.bounds;
    for (const sections of SECTION_CYCLE) {
      const from = t.calls.length;
      t.overlay.setLayout('strip', placement, sections);
      const expected = overlayBounds('strip', CLIENT, placement, sections)!;
      const changed = JSON.stringify(expected) !== JSON.stringify(previous);
      expect(t.state.bounds).toEqual(expected);
      expect(setBoundsSince(t.calls, from)).toBe(changed ? 1 : 0);
      expect(t.calls.slice(from).filter(call => call === 'setAlwaysOnTop')).toHaveLength(changed ? 1 : 0);
      if (placement.scale === 2 && sections === OVERLAY_PRESETS['driving-only']) expect(expected.height).toBe(156);
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
  const t = setup(); drivingJobFocus(t);
  t.metadata.foreground = false; t.overlay.update(t.current); t.overlay.beginEdit(true);
  t.overlay.setEditScale(1); t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
  // At scale 1 Driving only is 1280 × 40 at x = round(1722.67 + 0.8485 × 394.67) = 2058, y = 248 + 904 = 1152.
  expect(t.state.bounds).toEqual({x: 2058, y: 1152, width: 1280, height: 40}); expect(t.state.visible).toBe(true);
  const from = t.calls.length;
  expect(t.overlay.endEdit(), reason).toEqual({...OWNER, scale: 1});
  expect(t.calls.slice(from, from + 5)).toEqual(['hide', 'setMovable(false)', 'setIgnoreMouseEvents(true)', 'setFocusable(false)', 'setSkipTaskbar(true)']);
  expect(t.window.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.5);
  // Back in driving mode at the saved scale 0.5 with the current sections; Windows first keeps the 40 DIP height.
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
  t.overlay.update(t.current); t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['job-focus']); t.overlay.update(t.current);
  expect(t.calls.slice(from)).toEqual([]); expect(t.window.getBounds.mock.calls.length).toBe(reads);
  // Driving only again, still held; then the native drag leaves the window below the client and the drop snaps to y 1.
  t.overlay.setLayout('strip', OWNER, OVERLAY_PRESETS['driving-only']);
  t.state.bounds = {x: 2000, y: 1500, width: 640, height: 21}; t.overlay.moved({x: 2000, y: 1500, width: 640, height: 21});
  // Free width 1034.67: (2000 − 1722.67) / 1034.67 = 0.26804 → 0.268, x = round(1722.67 + 277.29) = 2000.
  expect(t.state.bounds).toEqual({x: 2000, y: 1171, width: 640, height: 21});
  expect(setBoundsSince(t.calls, from)).toBe(1); expect(t.window.getBounds.mock.calls.length).toBeGreaterThan(reads);
  expect(t.overlay.endEdit()).toEqual({x: 0.268, y: 1, scale: 0.5}); expect(t.mismatches()).toEqual([]);
});
