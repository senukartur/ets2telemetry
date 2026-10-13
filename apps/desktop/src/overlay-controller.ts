import type {LiveTelemetry} from '../../../packages/contracts/src';
import {currentGameClientBounds, type PhysicalClientBounds} from './window-placement';

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
}
export interface OverlayScreen {
  screenToDipRect(window: null, rect: PhysicalClientBounds): PhysicalClientBounds;
  getAllDisplays(): {bounds: PhysicalClientBounds}[];
}
/** Main alone converts physical client coordinates using Electron's monitor-aware API. */
export class OverlayController {
  private live?: LiveTelemetry;
  private ready = false;
  private visible = false;
  private topmostLossReported = false;
  private bounds?: PhysicalClientBounds;
  private physical?: PhysicalClientBounds;
  private topologyReceipt?: string;
  constructor(private readonly window: OverlayWindow, private readonly screen: OverlayScreen, private readonly topmostLost: (phase: 'show' | 'visible') => void = () => {}) {}
  update(live: LiveTelemetry): void {this.live = live; this.place();}
  loaded(ready: boolean): void {this.ready = ready; this.place();}
  topologyChanged(): void {
    // A removed/reconfigured monitor invalidates the previous coordinate observation.
    this.topologyReceipt = this.receipt(); this.bounds = this.physical = undefined;
    if (this.live?.observation) this.live = {...this.live, observation: {...this.live.observation, windowFresh: false}};
    this.place();
  }
  private receipt(): string | undefined {
    const observation = this.live?.observation;
    return observation && `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.windowReceivedMonotonicMs}`;
  }
  private hide(): void {this.visible = false; this.window.hide();}
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
  private place(): void {
    if (this.window.isDestroyed()) return;
    const physical = this.live && currentGameClientBounds(this.live);
    if (!this.ready || !physical || (this.topologyReceipt !== undefined && this.topologyReceipt === this.receipt())) {this.hide(); return;}
    if (this.bounds && this.physical && Object.keys(physical).every(key => physical[key as keyof PhysicalClientBounds] === this.physical![key as keyof PhysicalClientBounds])) {
      this.present(false); return;
    }
    try {
      const client = this.screen.screenToDipRect(null, physical);
      if (![client.x, client.y, client.width, client.height].every(Number.isFinite) || client.width <= 0 || client.height <= 0) {this.hide(); return;}
      const bounds = {x: Math.round(client.x + Math.min(16, client.width / 8)), y: Math.round(client.y + Math.min(16, client.height / 8)),
        width: Math.min(300, Math.floor(client.width - Math.min(16, client.width / 8))), height: Math.min(132, Math.floor(client.height - Math.min(16, client.height / 8)))};
      if (bounds.width < 180 || bounds.height < 100 || !this.screen.getAllDisplays().some(({bounds: display}) =>
        bounds.x >= display.x && bounds.y >= display.y && bounds.x + bounds.width <= display.x + display.width && bounds.y + bounds.height <= display.y + display.height)) {this.hide(); return;}
      const moved = !this.bounds || Object.keys(bounds).some(key => bounds[key as keyof PhysicalClientBounds] !== this.bounds![key as keyof PhysicalClientBounds]);
      if (moved) {this.window.setBounds(bounds); this.bounds = bounds;}
      this.physical = physical;
      this.present(moved);
    } catch {this.hide();}
  }
}
