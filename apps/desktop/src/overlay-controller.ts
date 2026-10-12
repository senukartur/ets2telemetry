import type {LiveTelemetry} from '../../../packages/contracts/src';
import {currentGameClientBounds, type PhysicalClientBounds} from './window-placement';

export interface OverlayWindow {
  isDestroyed(): boolean;
  hide(): void;
  setBounds(bounds: PhysicalClientBounds): void;
  showInactive(): void;
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
  private bounds?: PhysicalClientBounds;
  private physical?: PhysicalClientBounds;
  private topologyReceipt?: string;
  constructor(private readonly window: OverlayWindow, private readonly screen: OverlayScreen) {}
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
  private place(): void {
    if (this.window.isDestroyed()) return;
    const physical = this.live && currentGameClientBounds(this.live);
    if (!this.ready || !physical || (this.topologyReceipt !== undefined && this.topologyReceipt === this.receipt())) {this.hide(); return;}
    if (this.bounds && this.physical && Object.keys(physical).every(key => physical[key as keyof PhysicalClientBounds] === this.physical![key as keyof PhysicalClientBounds])) {
      if (!this.visible) {this.window.showInactive(); this.visible = true;} return;
    }
    try {
      const client = this.screen.screenToDipRect(null, physical);
      if (![client.x, client.y, client.width, client.height].every(Number.isFinite) || client.width <= 0 || client.height <= 0) {this.hide(); return;}
      const bounds = {x: Math.round(client.x + Math.min(16, client.width / 8)), y: Math.round(client.y + Math.min(16, client.height / 8)),
        width: Math.min(300, Math.floor(client.width - Math.min(16, client.width / 8))), height: Math.min(132, Math.floor(client.height - Math.min(16, client.height / 8)))};
      if (bounds.width < 180 || bounds.height < 100 || !this.screen.getAllDisplays().some(({bounds: display}) =>
        bounds.x >= display.x && bounds.y >= display.y && bounds.x + bounds.width <= display.x + display.width && bounds.y + bounds.height <= display.y + display.height)) {this.hide(); return;}
      if (!this.bounds || Object.keys(bounds).some(key => bounds[key as keyof PhysicalClientBounds] !== this.bounds![key as keyof PhysicalClientBounds])) {
        this.window.setBounds(bounds); this.bounds = bounds;
      }
      this.physical = physical;
      if (!this.visible) {this.window.showInactive(); this.visible = true;}
    } catch {this.hide();}
  }
}
