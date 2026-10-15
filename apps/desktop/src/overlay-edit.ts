// Own-foreground gate of the overlay edit mode (ET-012b decision M6). Pure, with injected timers.
//
// While editing, the overlay is shown only while one of this application's windows (the dashboard or the overlay) is
// focused. A click from the dashboard onto the overlay blurs the dashboard before the overlay gains focus, so a loss
// counts only after OWN_FOCUS_GRACE_MS without regaining focus; a gain counts at once. The overlay may therefore stay
// visible over another application for at most this grace after the user switched away.

export const OWN_FOCUS_GRACE_MS = 150;

export interface GateTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
const systemTimers: GateTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class OwnForegroundGate {
  private active = false;
  private foreground = false;
  private timer: unknown;
  /** `changed` receives every change of the gated state while the gate is started. */
  constructor(private readonly changed: (foreground: boolean) => void, private readonly timers: GateTimers = systemTimers) {}

  /** The gated state: false while stopped. */
  get inFront(): boolean {return this.active && this.foreground;}

  /** Starts gating from the current focus without reporting it; the caller reads `inFront`. */
  start(focused: boolean): void {
    this.clear(); this.active = true; this.foreground = focused;
  }

  /** The current focus of this application's windows, read on every focus or blur event of either window. */
  update(focused: boolean): void {
    if (!this.active) return;
    if (focused) {
      this.clear();
      if (!this.foreground) {this.foreground = true; this.changed(true);}
      return;
    }
    if (!this.foreground || this.timer !== undefined) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.active && this.foreground) {this.foreground = false; this.changed(false);}
    }, OWN_FOCUS_GRACE_MS);
  }

  /** Stops gating and cancels a pending loss; nothing is reported afterwards. */
  stop(): void {this.clear(); this.active = false; this.foreground = false;}

  private clear(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
