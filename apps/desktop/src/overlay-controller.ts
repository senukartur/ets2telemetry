import type {LiveTelemetry, OverlayEditPlacement, OverlayEditState, OverlayLayout, OverlayPlacement, OverlaySections} from '../../../packages/contracts/src';
import {overlayBounds, placementFromBounds, type DipRect} from './overlay-geometry';
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
  /** The saved placement of the initial layout; the overlay window was created at its scale. */
  placement?: OverlayPlacement;
  /** The saved enabled sections; every layout reserves rows for them (ET-012c, ET-012d). Defaults to every section. */
  sections?: OverlaySections;
  /** Receives every change of the edit state. */
  editChanged?: (state: OverlayEditState) => void;
}
interface EditDraft {layout: OverlayLayout; draft: OverlayPlacement}
const sameRect = (left: DipRect, right: DipRect) => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
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
 */
export class OverlayController {
  private live?: LiveTelemetry;
  private ready = false;
  private visible = false;
  private topmostLossReported = false;
  private bounds?: PhysicalClientBounds;
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
  /** The client area the visible edit overlay was placed in; a finished drag converts against it. */
  private client?: DipRect;
  constructor(private readonly window: OverlayWindow, private readonly screen: OverlayScreen, private readonly topmostLost: (phase: 'show' | 'visible') => void = () => {},
    private layout: OverlayLayout = 'strip', options: OverlayControllerOptions = {}) {
    this.placement = options.placement ?? DEFAULT_OVERLAY_PLACEMENTS[layout];
    this.sections = options.sections ?? DEFAULT_OVERLAY_SECTIONS;
    this.zoom = this.placement.scale;
    this.editChanged = options.editChanged ?? (() => {});
    this.reportedEdit = {active: false};
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
    // Main refuses a layout change while editing; should one arrive anyway, the edit is cancelled.
    if (this.edit && this.edit.layout !== layout) {this.endEdit(); return;}
    if (this.edit) {if (sectionsChanged) this.place(); return;}
    // A new layout or placement always moves the window; new sections only invalidate the cached client observation.
    if (placed) this.physical = undefined;
    else this.bounds = this.physical = undefined;
    this.place();
  }
  loaded(ready: boolean): void {this.ready = ready; this.place();}
  topologyChanged(): void {
    // A removed/reconfigured monitor invalidates the previous coordinate observation.
    this.topologyReceipt = this.receipt(); this.bounds = this.physical = undefined;
    if (this.live?.observation) this.live = {...this.live, observation: {...this.live.observation, windowFresh: false}};
    this.place();
  }
  /** Re-applies the current scale as the overlay document's zoom factor, for example after the document loaded again. */
  restoreZoom(): void {if (!this.window.isDestroyed()) this.window.webContents.setZoomFactor(this.zoom);}

  /** Enters edit mode for the current layout from its saved placement; `ownForeground` is the gate's current state. */
  beginEdit(ownForeground: boolean): OverlayEditState {
    if (!this.edit) {
      this.edit = {layout: this.layout, draft: this.placement};
      this.ownForeground = ownForeground; this.editStatus = 'waiting-for-game';
      this.bounds = this.physical = undefined;
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
    if (this.edit) {this.edit.draft = DEFAULT_OVERLAY_PLACEMENTS[this.edit.layout]; this.place();}
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
    this.edit = undefined; this.moving = false; this.client = undefined; this.bounds = this.physical = undefined;
    this.place();
    this.reportEdit();
    return edit.draft;
  }
  /** The user started dragging the visible edit overlay: no placement moves it until the drag ends. */
  moveStarted(): void {if (this.edit && this.visible && this.interactive) this.moving = true;}
  /** The drag ended at these DIP bounds: they become the draft's clamped fractions, then the window snaps inside. */
  moved(bounds: DipRect): void {
    if (!this.edit) return;
    this.moving = false;
    if (this.visible && this.client) {
      this.edit.draft = placementFromBounds(this.edit.layout, this.client, bounds, this.edit.draft, this.sections);
      this.bounds = {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
    }
    this.place();
  }
  editState(): OverlayEditState {
    return this.edit ? {active: true, layout: this.edit.layout, scale: this.edit.draft.scale, placement: this.editStatus} : {active: false};
  }

  private receipt(): string | undefined {
    const observation = this.live?.observation;
    return observation && `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.windowReceivedMonotonicMs}`;
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
    this.visible = false; this.moving = false; this.window.hide();
    if (!this.interactive) return;
    this.interactive = false;
    this.window.setMovable(false); this.window.setIgnoreMouseEvents(true); this.window.setFocusable(false);
    // Electron 44 on Windows maps setFocusable to SetSkipTaskbar(!focusable); this keeps the taskbar tab off explicitly.
    this.window.setSkipTaskbar(true);
  }
  // Every show and placement change re-asserts topmost without activation (SWP_NOACTIVATE), so a
  // level lost while hidden or moved cannot leave the overlay behind the game. A visible overlay is
  // checked on each update and restored if something external cleared WS_EX_TOPMOST.
  private present(moved: boolean): void {
    const shown = !this.visible;
    if (shown) {this.window.showInactive(); this.visible = true; this.topmostLossReported = false;}
    const lost = !this.window.isAlwaysOnTop();
    if (lost && !this.topmostLossReported) {this.topmostLossReported = true; this.topmostLost(shown ? 'show' : 'visible');}
    if (shown || moved || lost) {this.window.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL); this.window.moveTop();}
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
    this.syncZoom();
    if (this.edit) {this.placeEditing(this.edit); return;}
    const physical = this.live && currentGameClientBounds(this.live);
    if (!this.ready || !physical || this.topologyPending()) {this.hide(); return;}
    if (this.bounds && this.physical && Object.keys(physical).every(key => physical[key as keyof PhysicalClientBounds] === this.physical![key as keyof PhysicalClientBounds])) {
      this.present(false); return;
    }
    try {
      const client = this.screen.screenToDipRect(null, physical);
      if (!validArea(client)) {this.hide(); return;}
      // Each layout has its own placement and size inside the client area (overlay-geometry.ts); a layout that does not fit hides.
      const bounds = overlayBounds(this.layout, client, this.placement, this.sections);
      if (!bounds || !this.onDisplay(bounds)) {this.hide(); return;}
      const moved = !this.bounds || !sameRect(bounds, this.bounds);
      if (moved) {this.window.setBounds(bounds); this.bounds = bounds;}
      this.physical = physical;
      this.present(moved);
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
    else if (!this.moving) this.showInteractive(bounds);
    this.editStatus = status;
    this.reportEdit();
  }
  /** Interactive first, then zoom and bounds, an inactive show and the topmost re-assertion (decision M7). Never show() or focus(). */
  private showInteractive(bounds: DipRect): void {
    if (!this.interactive) {
      this.window.setIgnoreMouseEvents(false); this.window.setFocusable(true);
      // setFocusable(true) enables the taskbar tab on Windows; the overlay never shows one.
      this.window.setSkipTaskbar(true); this.window.setMovable(true);
      this.interactive = true;
    }
    const moved = !this.bounds || !sameRect(bounds, this.bounds);
    if (moved) {this.window.setBounds(bounds); this.bounds = bounds;}
    this.present(moved);
  }
}
