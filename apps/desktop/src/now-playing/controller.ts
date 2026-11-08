import type {NowPlayingEditState, NowPlayingPosition, NowPlayingSettings} from '../../../../packages/contracts/src/now-playing';
import type {LiveTelemetry} from '../../../../packages/contracts/src';
import {currentGameClientBounds} from '../window-placement';
import {DEFAULT_NOW_PLAYING} from './contract';
import {positionFromBounds, widgetBounds, type Area, type MediaDisplay} from './placement';
interface WidgetWindow {
  webContents: {isDestroyed(): boolean};
  isDestroyed(): boolean; isVisible(): boolean; hide(): void; showInactive(): void; setBounds(bounds: Area): void; getBounds(): Area;
  setIgnoreMouseEvents(ignore: boolean): void; setFocusable(value: boolean): void; setSkipTaskbar(value: boolean): void; setMovable(value: boolean): void;
  setAlwaysOnTop(value: boolean, level: 'screen-saver'): void; isAlwaysOnTop(): boolean; moveTop(): void;
}
interface WidgetScreen {getAllDisplays(): MediaDisplay[]; getPrimaryDisplay(): MediaDisplay; getDisplayMatching(bounds: Area): MediaDisplay; screenToDipRect(window: null, bounds: Area): Area}
/** Main owns the edit draft; renderer snapshots grant no movement authority. */
export class NowPlayingController {
  private settings: NowPlayingSettings = DEFAULT_NOW_PLAYING;
  private draft?: NowPlayingPosition;
  private ready = false;
  private available = false;
  private game?: Area;
  private live?: LiveTelemetry;
  private foreground = false;
  private visible = false;
  private interactive = false;
  private moving = false;
  private retired = false;
  /** A completed native hide and click-through pass that nothing has undone since. */
  private concealed = false;
  constructor(private readonly window: WidgetWindow, private readonly screen: WidgetScreen, private readonly changed: () => void) {this.passThrough();}
  configure(settings: NowPlayingSettings): void {if (this.retired) return; this.settings = settings; if (!settings.enabled && this.draft) this.end(); this.place();}
  loaded(ready: boolean): void {if (this.retired) return; this.ready = ready; if (!ready && this.draft) this.end(); this.place();}
  update(available: boolean): void {if (this.retired) return; this.available = available; this.place();}
  updateGame(live: LiveTelemetry): void {
    if (this.retired) return;
    this.live = live;
    this.game = undefined;
    const physical = currentGameClientBounds(live);
    if (physical) {
      try {
        const bounds = this.screen.screenToDipRect(null, physical);
        if (Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0) this.game = bounds;
      } catch {/* Unavailable display conversion cannot authorize visibility. */}
    }
    this.place();
  }
  topologyChanged(): void {this.moving = false; if (this.live) this.updateGame(this.live); else this.place();}
  setOwnForeground(value: boolean): void {if (this.retired) return; this.foreground = value; this.place(); this.changed();}
  editState(): NowPlayingEditState {return {active: Boolean(this.draft), placement: !this.ready || (this.draft && this.foreground && !this.visible) ? 'unavailable' : this.foreground ? 'visible' : 'not-foreground'};}
  /** Read-only internal facts; visibility/interactivity are controller intent, not proof that a document rendered. */
  diagnosticSnapshot():Readonly<{ready:boolean;retired:boolean;draft:boolean;foreground:boolean;visible:boolean;interactive:boolean;moving:boolean;enabled:boolean;available:boolean;game:boolean;placement:NowPlayingEditState['placement']}> {
    return {ready:this.ready,retired:this.retired,draft:!!this.draft,foreground:this.foreground,visible:this.visible,interactive:this.interactive,
    moving:this.moving,enabled:this.settings.enabled,available:this.available,game:!!this.game,placement:this.editState().placement};}
  begin(foreground: boolean): NowPlayingEditState {
    if (!this.usable() || !this.settings.enabled || !this.ready) throw new Error('Current track edit unavailable');
    this.draft ??= {...this.settings.position}; this.foreground = foreground; this.place(); this.changed(); return this.editState();
  }
  reset(): NowPlayingEditState {if (!this.draft) throw new Error('Current track edit inactive'); this.draft = {...DEFAULT_NOW_PLAYING.position}; this.place(); this.changed(); return this.editState();}
  end(): NowPlayingPosition | undefined {
    const draft = this.draft; if (!draft) return;
    this.hide(); this.draft = undefined; this.moving = false; this.place(); this.changed(); return draft;
  }
  moveStarted(): void {if (this.draft && this.interactive) this.moving = true;}
  moved(): void {
    if (!this.usable() || !this.draft || !this.moving) return;
    const bounds = this.window.getBounds(); this.draft = positionFromBounds(bounds, this.screen.getDisplayMatching(bounds)); this.moving = false; this.place();
  }
  /** Release authority before native hide/close callbacks can publish another observation. */
  retire(): void {
    if (this.retired) return;
    this.retired = true; this.ready = false; this.draft = undefined; this.hide(true);
  }
  private usable(retiring = false): boolean {return (retiring || !this.retired) && !this.window.isDestroyed() && !this.window.webContents.isDestroyed();}
  private apply(action: () => void, retiring = false): boolean {
    if (!this.usable(retiring)) return false;
    action();
    return this.usable(retiring);
  }
  private passThrough(retiring = false): boolean {
    this.interactive = false;
    return this.apply(() => this.window.setIgnoreMouseEvents(true), retiring) && this.apply(() => this.window.setMovable(false), retiring) &&
      this.apply(() => this.window.setFocusable(false), retiring) && this.apply(() => this.window.setSkipTaskbar(true), retiring);
  }
  private hide(retiring = false): void {
    this.visible = false; this.moving = false;
    // Telemetry repeats this at 20 Hz while the widget stays hidden. The window keeps its click-through state, and
    // Electron would redo the native work and emit `hide` for a hidden window. Only the visibility is cheap to re-check.
    if (!retiring && this.concealed && this.usable() && !this.window.isVisible()) return;
    // A callback of these native calls can place the widget again, so `visible` is read after them.
    this.concealed = this.apply(() => this.window.hide(), retiring) && this.passThrough(retiring) && !this.visible;
  }
  private place(): void {
    if (!this.usable()) return;
    if (!this.settings.enabled || !this.ready || (this.draft ? !this.foreground : !this.available || !this.game)) {this.hide(); return;}
    if (this.moving) return;
    const bounds = widgetBounds(this.draft ?? this.settings.position, this.settings.style, this.screen.getAllDisplays(), this.screen.getPrimaryDisplay());
    if (!this.draft && this.game) {
      if (bounds.width > this.game.width || bounds.height > this.game.height) {this.hide(); return;}
      bounds.x = Math.max(this.game.x, Math.min(bounds.x, this.game.x + this.game.width - bounds.width));
      bounds.y = Math.max(this.game.y, Math.min(bounds.y, this.game.y + this.game.height - bounds.height));
    }
    const before = this.window.getBounds();
    const moved = Object.keys(bounds).some(key => bounds[key as keyof Area] !== before[key as keyof Area]);
    if (moved && !this.apply(() => this.window.setBounds(bounds))) return;
    const actual = this.window.getBounds();
    if (Object.keys(bounds).some(key => Math.abs(actual[key as keyof Area] - bounds[key as keyof Area]) > 1)) {this.hide(); return;}
    this.concealed = false;
    if (this.draft && !this.interactive) {
      if (!this.apply(() => this.window.setIgnoreMouseEvents(false))) return;
      if (!this.apply(() => this.window.setFocusable(true))) return;
      if (!this.apply(() => this.window.setSkipTaskbar(true))) return;
      if (!this.apply(() => this.window.setMovable(true))) return;
      this.interactive = true;
    }
    const shown = !this.visible;
    if (shown) {this.visible = true; if (!this.apply(() => this.window.showInactive())) return;}
    if (shown || moved || !this.window.isAlwaysOnTop()) {
      if (this.apply(() => this.window.setAlwaysOnTop(true, 'screen-saver'))) this.apply(() => this.window.moveTop());
    }
  }
}
