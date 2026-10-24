import type {LiveTelemetry, OverlayEditPlacement, OverlayEditState, OverlayLayout, OverlayPlacement, OverlaySections} from '../../../packages/contracts/src';
import {overlayBounds, placementFromBounds, placeSize, type DipRect} from './overlay-geometry';
import {DEFAULT_OVERLAY_PLACEMENTS, samePlacement} from './overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, sameSections} from './overlay-sections';
import {currentGameClientBounds, gameForeground, visibleGameClientBounds, type PhysicalClientBounds} from './window-placement';

/**
 * Electron's default `floating` level on Windows also stacks the window directly behind the taskbar.
 * While a borderless full-screen game is foreground the shell makes the taskbar non-topmost, and a
 * window placed after a non-topmost window loses WS_EX_TOPMOST. Levels outside Electron's
 * behind-taskbar set only apply HWND_TOPMOST.
 */
export const OVERLAY_TOPMOST_LEVEL = 'screen-saver';
export interface OverlayWindow {
  isDestroyed(): boolean;
  hide(): void;
  setBounds(bounds: PhysicalClientBounds): void;
  /** The window's actual DIP bounds, read back from the HWND; ET-045c verifies them against the requested bounds. */
  getBounds(): DipRect;
  showInactive(): void;
  /** On Windows this reads the HWND's actual WS_EX_TOPMOST style, not a cached flag. */
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(flag: true, level: typeof OVERLAY_TOPMOST_LEVEL): void;
  moveTop(): void;
  // Edit mode only (ET-012b decision M7); driving mode never calls these.
  setIgnoreMouseEvents(ignore: boolean): void;
  setFocusable(focusable: boolean): void;
  setSkipTaskbar(skip: boolean): void;
  setMovable(movable: boolean): void;
  webContents: {setZoomFactor(factor: number): void};
}
export interface OverlayScreen {
  screenToDipRect(window: null, rect: PhysicalClientBounds): PhysicalClientBounds;
  getAllDisplays(): {bounds: PhysicalClientBounds}[];
}
export interface OverlayControllerOptions {
  /** Persisted visibility gate; evaluated before edit and driving authority. */
  enabled?: boolean;
  /** The saved placement of the initial layout; the overlay window was created at its scale. */
  placement?: OverlayPlacement;
  /** The saved enabled sections; every layout reserves rows for them (ET-012c, ET-012d). Defaults to every section. */
  sections?: OverlaySections;
  /** Receives every change of the edit state. */
  editChanged?: (state: OverlayEditState) => void;
  /** Fraction-only content alignment change; does not carry an observation or native command. */
  anchorChanged?: (anchor: number) => void;
  /**
   * Fixed-code, numbers-only facts about verified window bounds (ET-045c). `OVERLAY_BOUNDS_MISMATCH` reports one line per
   * mode, outcome and size difference, at most BOUNDS_MISMATCH_REPORT_LIMIT per launch; `OVERLAY_BOUNDS_SET` follows every verified apply and belongs only in an
   * opt-in diagnostic timeline.
   */
  boundsReport?: (event: OverlayBoundsEvent, facts: OverlayBoundsFacts) => void;
}
/**
 * ET-045c: the actual window may differ from a requested rectangle by this much on each edge, which absorbs DIP to
 * physical pixel rounding at fractional scale factors.
 */
export const BOUNDS_TOLERANCE_DIP = 1;
/** ET-045c: how often one requested rectangle is applied again after the actual window did not match it. */
export const BOUNDS_REAPPLY_LIMIT = 2;
/**
 * ET-045c: distinct `OVERLAY_BOUNDS_MISMATCH` lines per controller, that is per application launch. A line is distinct
 * by mode, outcome and the size difference Windows applied, so a deterministic minimum height logs once, not once per
 * request; later distinct mismatches are still handled but not logged.
 */
export const BOUNDS_MISMATCH_REPORT_LIMIT = 16;
export type OverlayBoundsEvent = 'OVERLAY_BOUNDS_MISMATCH' | 'OVERLAY_BOUNDS_SET';
/** `exact` for an apply that matched at once; the others follow a mismatch. */
export type OverlayBoundsOutcome = 'exact' | 'reapplied' | 'fitted' | 'hidden';
/** Requested, actual and game client rectangles in DIP, rounded to two decimals; no handle, path or value. */
export type OverlayBoundsFacts = {mode: 'driving' | 'edit'; outcome: OverlayBoundsOutcome; attempts: number;
  reqX: number; reqY: number; reqW: number; reqH: number; actX: number; actY: number; actW: number; actH: number;
  clientX: number; clientY: number; clientW: number; clientH: number};
interface EditDraft {layout: OverlayLayout; draft: OverlayPlacement}
/** What a fallback needs to place the actual window size at the same fractions. */
interface FitContext {layout: OverlayLayout; client: DipRect; placement: OverlayPlacement; mode: 'driving' | 'edit'}
/** Per-request verification state: reset whenever the request or what it was computed from changes. */
interface Verification {attempts: number; fitted: boolean; refused: boolean}
const freshVerification = (): Verification => ({attempts: 0, fitted: false, refused: false});
const sameRect = (left: DipRect, right: DipRect) => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
const near = (left: number, right: number) => Math.abs(left - right) <= BOUNDS_TOLERANCE_DIP;
/** A dimension that differs only by DIP-to-pixel rounding at both edges; Windows did not change that axis. */
const roundingOnly = (actual: number, wanted: number) => Math.abs(actual - wanted) <= 2 * BOUNDS_TOLERANCE_DIP;
/** True when Windows kept another size on at least one axis beyond rounding. */
const resized = (actual: {width: number; height: number}, wanted: {width: number; height: number}) =>
  !roundingOnly(actual.width, wanted.width) || !roundingOnly(actual.height, wanted.height);
/** Every edge within the tolerance; a non-finite actual rectangle never matches. */
const nearRect = (actual: DipRect, wanted: DipRect) => near(actual.x, wanted.x) && near(actual.y, wanted.y) &&
  near(actual.x + actual.width, wanted.x + wanted.width) && near(actual.y + actual.height, wanted.y + wanted.height);
const insideClient = (actual: DipRect, client: DipRect) => actual.x >= client.x - BOUNDS_TOLERANCE_DIP && actual.y >= client.y - BOUNDS_TOLERANCE_DIP &&
  actual.x + actual.width <= client.x + client.width + BOUNDS_TOLERANCE_DIP && actual.y + actual.height <= client.y + client.height + BOUNDS_TOLERANCE_DIP;
const round2 = (value: number) => Math.round(value * 100) / 100;
const validArea = (rect: DipRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const sameEditState = (left: OverlayEditState | undefined, right: OverlayEditState) => left !== undefined && (left.active || right.active
  ? left.active && right.active && left.layout === right.layout && left.scale === right.scale && left.placement === right.placement : true);

/**
 * Main alone converts physical client coordinates using Electron's monitor-aware API.
 *
 * Driving mode (ET-008, ET-012a): the overlay shows without activation only while the game is the current foreground
 * window, ignores the mouse and is never focusable or movable. Edit mode (ET-012b): the overlay shows only while one of
 * this application's windows is in front and the game is not, and only then is it interactive, so it can be dragged.
 * Every hide happens before the window becomes click-through again, and the taskbar tab is never left enabled.
 *
 * Verified bounds (ET-045c): a requested rectangle is checked against the window's actual bounds after it is set and on
 * every later placement. A mismatch beyond one DIP per edge is applied again up to twice, after an inactive show if the
 * window was still hidden; a window that keeps another size is placed at that size by the same fractions when it fits;
 * otherwise the overlay hides fail-closed for that request, which edit mode reports as `too-large`. The saved placement
 * and the draft never change. While the user drags the edit overlay nothing is verified.
 */
export class OverlayController {
  private live?: LiveTelemetry;
  private ready = false;
  private enabled: boolean;
  private visible = false;
  private topmostLossReported = false;
  /** The rectangle last requested through setBounds, or adopted from a finished drag; a placement compares against it. */
  private requested?: DipRect;
  /** What the actual window must match: the request, or its fit to the size Windows applied instead. */
  private accepted?: DipRect;
  private verification = freshVerification();
  private fit?: FitContext;
  private readonly boundsReport: (event: OverlayBoundsEvent, facts: OverlayBoundsFacts) => void;
  private readonly mismatchKeys = new Set<string>();
  private physical?: PhysicalClientBounds;
  private topologyReceipt?: string;
  private placement: OverlayPlacement;
  private sections: OverlaySections;
  private zoom: number;
  private readonly editChanged: (state: OverlayEditState) => void;
  private edit?: EditDraft;
  private editStatus: OverlayEditPlacement = 'waiting-for-game';
  private reportedEdit?: OverlayEditState;
  private ownForeground = false;
  private interactive = false;
  private moving = false;
  private heldAnchor?: number;
  private reportedAnchor: number;
  private readonly anchorChanged: (anchor: number) => void;
  /** The client area the visible edit overlay was placed in; a finished drag converts against it. */
  private client?: DipRect;
  constructor(private readonly window: OverlayWindow, private readonly screen: OverlayScreen, private readonly topmostLost: (phase: 'show' | 'visible') => void = () => {},
    private layout: OverlayLayout = 'strip', options: OverlayControllerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.placement = options.placement ?? DEFAULT_OVERLAY_PLACEMENTS[layout];
    this.sections = options.sections ?? DEFAULT_OVERLAY_SECTIONS;
    this.zoom = this.placement.scale;
    this.editChanged = options.editChanged ?? (() => {});
    this.reportedEdit = {active: false};
    this.reportedAnchor = this.placement.y; this.anchorChanged = options.anchorChanged ?? (() => {});
    this.boundsReport = options.boundsReport ?? (() => {});
  }
  get contentAnchorY(): number {return this.heldAnchor ?? (this.edit?.draft ?? this.placement).y;}
  private reportAnchor(): void {
    const anchor = this.contentAnchorY;
    if (anchor === this.reportedAnchor) return;
    this.reportedAnchor = anchor; this.anchorChanged(anchor);
  }
  update(live: LiveTelemetry): void {this.live = live; this.place();}
  /**
   * A saved layout, placement or sections change re-places the window from the last observation; it renews no SDK or
   * window freshness. A moved visible overlay re-asserts topmost without activation; a hidden one stays hidden. Sections
   * alone change only the reserved rows of the strip (ET-012c decision S7) and of the card, cluster and HUD (ET-012d
   * decision K9): the window moves and is raised only when its rectangle changed, so a bottom-anchored layout that grows
   * moves its top edge. While editing, the saved placement is only remembered: the draft stays until edit mode ends, but
   * changed sections re-size the draft from its unchanged fractions, which may no longer fit.
   */
  setLayout(layout: OverlayLayout, placement: OverlayPlacement = DEFAULT_OVERLAY_PLACEMENTS[layout], sections: OverlaySections = this.sections): void {
    const placed = layout === this.layout && samePlacement(placement, this.placement), sectionsChanged = !sameSections(sections, this.sections);
    if (placed && !sectionsChanged) return;
    this.layout = layout; this.placement = placement; this.sections = sections;
    // ET-045c: any saved change verifies the window again, even when its rectangle stays the same.
    this.verification = freshVerification();
    this.reportAnchor();
    // Main refuses a layout change while editing; should one arrive anyway, the edit is cancelled.
    if (this.edit && this.edit.layout !== layout) {this.endEdit(); return;}
    if (this.edit) {if (sectionsChanged) this.place(); return;}
    // A new layout or placement always moves the window; new sections only invalidate the cached client observation.
    if (placed) this.physical = undefined;
    else this.forgetBounds();
    this.place();
  }
  /** Applies committed visibility first, so discarding an edit cannot briefly re-show the driving overlay. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {this.endEdit(); this.verification = freshVerification();}
    this.place();
  }
  loaded(ready: boolean): void {
    this.ready = ready;
    if (!ready) this.verification = freshVerification();
    this.place();
  }
  topologyChanged(): void {
    // A removed/reconfigured monitor invalidates the previous coordinate observation.
    this.topologyReceipt = this.receipt(); this.forgetBounds();
    if (this.live?.observation) this.live = {...this.live, observation: {...this.live.observation, windowFresh: false}};
    this.place();
  }
  /** Re-applies the current scale as the overlay document's zoom factor, for example after the document loaded again. */
  restoreZoom(): void {if (!this.window.isDestroyed()) this.window.webContents.setZoomFactor(this.zoom);}

  /** Enters edit mode for the current layout from its saved placement; `ownForeground` is the gate's current state. */
  beginEdit(ownForeground: boolean): OverlayEditState {
    if (!this.enabled) throw new Error('Overlay is disabled');
    if (!this.edit) {
      this.edit = {layout: this.layout, draft: this.placement};
      this.ownForeground = ownForeground; this.editStatus = 'waiting-for-game';
      this.forgetBounds();
      this.place();
    }
    this.reportEdit();
    return this.editState();
  }
  /** Whether this application's own windows are in front (the gated focus of the dashboard and the overlay). */
  setOwnForeground(ownForeground: boolean): void {
    if (ownForeground === this.ownForeground) return;
    this.ownForeground = ownForeground;
    if (this.edit) this.place();
  }
  setEditScale(scale: number): OverlayEditState {
    if (this.edit) {this.edit.draft = {...this.edit.draft, scale}; this.place();}
    return this.editState();
  }
  /** The layout's default anchor at scale 1. */
  resetEdit(): OverlayEditState {
    if (this.edit) {this.edit.draft = DEFAULT_OVERLAY_PLACEMENTS[this.edit.layout]; this.reportAnchor(); this.place();}
    return this.editState();
  }
  /**
   * Leaves edit mode and returns the draft, or undefined when not editing. The overlay hides before it becomes
   * click-through and non-focusable again, then returns to driving mode with the saved placement.
   */
  endEdit(): OverlayPlacement | undefined {
    const edit = this.edit;
    if (!edit) return undefined;
    if (!this.window.isDestroyed()) this.hide();
    this.edit = undefined; this.moving = false; this.heldAnchor = undefined; this.reportAnchor(); this.client = undefined; this.forgetBounds();
    this.place();
    this.reportEdit();
    return edit.draft;
  }
  /** The user started dragging the visible edit overlay: no placement moves it until the drag ends. */
  moveStarted(): void {if (this.edit && this.visible && this.interactive && !this.moving) {this.heldAnchor = this.contentAnchorY; this.moving = true;}}
  /** The drag ended at these DIP bounds: they become the draft's clamped fractions, then the window snaps inside. */
  moved(bounds: DipRect): void {
    if (!this.edit) return;
    this.moving = false; this.heldAnchor = undefined;
    if (this.visible && this.client) {
      // A fitted window (ET-045c) has the size Windows kept, not the layout's: on each axis Windows changed, the drop
      // converts against the free space of that actual size, so a drop where it stood keeps its fractions.
      const requested = this.requested, fitted = this.accepted && requested && resized(this.accepted, requested) ? this.accepted : undefined;
      const size = fitted && requested ? {width: roundingOnly(fitted.width, requested.width) ? requested.width : bounds.width,
        height: roundingOnly(fitted.height, requested.height) ? requested.height : bounds.height} : undefined;
      this.edit.draft = placementFromBounds(this.edit.layout, this.client, bounds, this.edit.draft, this.sections, size);
      // The dropped bounds are the window's actual bounds; the snap below is verified against them (ET-045c).
      this.requested = this.accepted = {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
      this.verification = freshVerification();
    }
    this.place(); this.reportAnchor();
  }
  editState(): OverlayEditState {
    return this.edit ? {active: true, layout: this.edit.layout, scale: this.edit.draft.scale, placement: this.editStatus} : {active: false};
  }

  private receipt(): string | undefined {
    const observation = this.live?.observation;
    return observation && `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.windowReceivedMonotonicMs}`;
  }
  /** The next placement sets its rectangle again and verifies it from scratch. */
  private forgetBounds(): void {
    this.requested = this.accepted = this.physical = this.fit = undefined; this.verification = freshVerification();
  }
  private topologyPending(): boolean {return this.topologyReceipt !== undefined && this.topologyReceipt === this.receipt();}
  private reportEdit(): void {
    const state = this.editState();
    if (sameEditState(this.reportedEdit, state)) return;
    this.reportedEdit = state; this.editChanged(state);
  }
  /** Hides first; an interactive edit overlay then becomes click-through, non-focusable and non-movable again. */
  private hide(): void {
    if (!this.visible && !this.interactive) return;
    this.visible = false; this.moving = false; this.heldAnchor = undefined; this.reportAnchor(); this.window.hide();
    if (!this.interactive) return;
    this.interactive = false;
    this.window.setMovable(false); this.window.setIgnoreMouseEvents(true); this.window.setFocusable(false);
    // Electron 44 on Windows maps setFocusable to SetSkipTaskbar(!focusable); this keeps the taskbar tab off explicitly.
    this.window.setSkipTaskbar(true);
  }
  // Every show and placement change re-asserts topmost without activation (SWP_NOACTIVATE), so a
  // level lost while hidden or moved cannot leave the overlay behind the game. A visible overlay is
  // checked on each update and restored if something external cleared WS_EX_TOPMOST.
  // A re-apply after verification (ET-045c) is a placement change: it re-asserts topmost after the last setBounds.
  private present(moved: boolean, shownNow = false): void {
    const shown = shownNow || !this.visible;
    if (!this.visible) this.showWindow();
    const lost = !this.window.isAlwaysOnTop();
    if (lost && !this.topmostLossReported) {this.topmostLossReported = true; this.topmostLost(shown ? 'show' : 'visible');}
    if (shown || moved || lost) {this.window.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL); this.window.moveTop();}
  }
  private showWindow(): void {this.window.showInactive(); this.visible = true; this.topmostLossReported = false;}
  private reportBounds(event: OverlayBoundsEvent, outcome: OverlayBoundsOutcome, requested: DipRect, actual: DipRect, fit: FitContext): void {
    const {client} = fit;
    this.boundsReport(event, {mode: fit.mode, outcome, attempts: this.verification.attempts,
      reqX: round2(requested.x), reqY: round2(requested.y), reqW: round2(requested.width), reqH: round2(requested.height),
      actX: round2(actual.x), actY: round2(actual.y), actW: round2(actual.width), actH: round2(actual.height),
      clientX: round2(client.x), clientY: round2(client.y), clientW: round2(client.width), clientH: round2(client.height)});
  }
  /**
   * Sets a changed request, then verifies the window's actual bounds against the accepted rectangle (ET-045c). A
   * mismatch is applied again up to BOUNDS_REAPPLY_LIMIT times, after an inactive show in the same task if the window
   * was meant to show but is still hidden. A window that keeps another size is then placed once at that size by the
   * same fractions, if that fits and lies on a display. When nothing matches inside the client the overlay hides, and
   * this request is not set again until it or what it was computed from changes. Returns whether the overlay shows.
   */
  private applyVerified(requested: DipRect, fit: FitContext): boolean {
    this.fit = fit;
    let applied = false, shown = false;
    if (!this.requested || !sameRect(requested, this.requested)) {
      this.window.setBounds(requested); applied = true;
      this.requested = this.accepted = requested; this.verification = freshVerification();
    } else if (this.verification.refused) {this.hide(); return false;}
    const verification = this.verification;
    let accepted = this.accepted ?? requested, actual = this.window.getBounds(), outcome: OverlayBoundsOutcome = 'exact';
    if (!nearRect(actual, accepted)) {
      const first = actual;
      while (verification.attempts < BOUNDS_REAPPLY_LIMIT && !nearRect(actual, accepted)) {
        verification.attempts++;
        if (!this.visible) {this.showWindow(); shown = true;}
        this.window.setBounds(accepted); applied = true;
        actual = this.window.getBounds();
      }
      if (!nearRect(actual, accepted) && !verification.fitted && resized(actual, requested)) {
        verification.fitted = true;
        // Only an axis Windows changed takes the actual dimension; a rounding difference keeps the request's, so a strip
        // as wide as the client allows is not refused for one inflated DIP.
        const fitted = placeSize(fit.layout, fit.client, fit.placement, {width: roundingOnly(actual.width, requested.width) ? requested.width : actual.width,
          height: roundingOnly(actual.height, requested.height) ? requested.height : actual.height});
        if (fitted && this.onDisplay(fitted)) {
          this.window.setBounds(fitted); applied = true; this.accepted = accepted = fitted;
          actual = this.window.getBounds();
        }
      }
      const matched = nearRect(actual, accepted) && insideClient(actual, fit.client);
      outcome = !matched ? 'hidden' : sameRect(accepted, requested) ? 'reapplied' : 'fitted';
      const key = `${fit.mode}|${outcome}|${first.width - requested.width}|${first.height - requested.height}`;
      if (!this.mismatchKeys.has(key) && this.mismatchKeys.size < BOUNDS_MISMATCH_REPORT_LIMIT) {
        this.mismatchKeys.add(key); this.reportBounds('OVERLAY_BOUNDS_MISMATCH', outcome, requested, first, fit);
      }
      if (!matched) {
        verification.refused = true; this.hide();
        this.reportBounds('OVERLAY_BOUNDS_SET', outcome, requested, actual, fit);
        return false;
      }
    }
    this.present(applied, shown);
    if (applied) this.reportBounds('OVERLAY_BOUNDS_SET', outcome, requested, actual, fit);
    return true;
  }
  private onDisplay(bounds: DipRect): boolean {
    return this.screen.getAllDisplays().some(({bounds: display}) =>
      bounds.x >= display.x && bounds.y >= display.y && bounds.x + bounds.width <= display.x + display.width && bounds.y + bounds.height <= display.y + display.height);
  }
  /** The scale in use (the draft while editing) is the overlay document's zoom factor, applied even while hidden. */
  private syncZoom(): void {
    const scale = this.edit ? this.edit.draft.scale : this.placement.scale;
    if (scale === this.zoom) return;
    this.zoom = scale; this.window.webContents.setZoomFactor(scale);
  }
  private place(): void {
    if (this.window.isDestroyed()) return;
    if (!this.enabled) {this.hide(); return;}
    if (!this.moving) this.syncZoom();
    if (this.edit) {this.placeEditing(this.edit); return;}
    const physical = this.live && currentGameClientBounds(this.live);
    if (!this.ready || !physical || this.topologyPending()) {this.hide(); return;}
    // The same client area: the window is only verified again (ET-045c), which sets nothing while it matches.
    if (this.requested && this.fit && this.physical && Object.keys(physical).every(key => physical[key as keyof PhysicalClientBounds] === this.physical![key as keyof PhysicalClientBounds])) {
      this.applyVerified(this.requested, this.fit); return;
    }
    try {
      const client = this.screen.screenToDipRect(null, physical);
      if (!validArea(client)) {this.hide(); return;}
      // Each layout has its own placement and size inside the client area (overlay-geometry.ts); a layout that does not fit hides.
      const bounds = overlayBounds(this.layout, client, this.placement, this.sections);
      if (!bounds || !this.onDisplay(bounds)) {this.hide(); return;}
      this.applyVerified(bounds, {layout: this.layout, client, placement: this.placement, mode: 'driving'});
      this.physical = physical;
    } catch {this.hide();}
  }
  /**
   * Edit mode needs a visible game window but not a foreground game: the dashboard is in front while editing. The
   * overlay shows only while this application is in front and the game is not (decision M6). While the user drags it,
   * no placement moves it.
   */
  private placeEditing(edit: EditDraft): void {
    const physical = this.live && visibleGameClientBounds(this.live);
    let status: OverlayEditPlacement = 'waiting-for-game', bounds: DipRect | undefined;
    this.client = undefined;
    if (this.ready && physical && !this.topologyPending()) {
      let client: DipRect | undefined;
      try {client = this.screen.screenToDipRect(null, physical);} catch {client = undefined;}
      const placed = client && validArea(client) ? overlayBounds(edit.layout, client, edit.draft, this.sections) : undefined;
      if (client && validArea(client) && !placed) status = 'too-large';
      else if (client && placed && this.onDisplay(placed)) {
        this.client = client; bounds = placed;
        status = this.ownForeground && !gameForeground(this.live!) ? 'visible' : 'not-foreground';
      }
    }
    if (status !== 'visible' || !bounds) this.hide();
    else if (!this.moving && !this.showInteractive(bounds, {layout: edit.layout, client: this.client!, placement: edit.draft, mode: 'edit'})) {
      // Windows did not apply the draft's rectangle (ET-045c): reported as the existing fit refusal, with no IPC change.
      status = 'too-large';
    }
    this.editStatus = status;
    this.reportEdit();
  }
  /**
   * Interactive first, then zoom and bounds, an inactive show and the topmost re-assertion (decision M7). Never show() or
   * focus(). Bounds are applied again after the first show only when verification found a mismatch (ET-045c); a request
   * Windows refused stays hidden and does not become interactive again.
   */
  private showInteractive(bounds: DipRect, fit: FitContext): boolean {
    if (this.verification.refused && this.requested && sameRect(bounds, this.requested)) {this.hide(); return false;}
    if (!this.interactive) {
      this.window.setIgnoreMouseEvents(false); this.window.setFocusable(true);
      // setFocusable(true) enables the taskbar tab on Windows; the overlay never shows one.
      this.window.setSkipTaskbar(true); this.window.setMovable(true);
      this.interactive = true;
    }
    return this.applyVerified(bounds, fit);
  }
}
