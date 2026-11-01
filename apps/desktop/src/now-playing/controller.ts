import type {NowPlayingEditState, NowPlayingPosition, NowPlayingSettings} from '../../../../packages/contracts/src/now-playing';
import {DEFAULT_NOW_PLAYING} from './contract';
import {positionFromBounds, widgetBounds, type Area, type MediaDisplay} from './placement';
interface WidgetWindow {
  isDestroyed(): boolean; hide(): void; showInactive(): void; setBounds(bounds: Area): void; getBounds(): Area;
  setIgnoreMouseEvents(ignore: boolean): void; setFocusable(value: boolean): void; setSkipTaskbar(value: boolean): void; setMovable(value: boolean): void;
  setAlwaysOnTop(value: boolean, level: 'screen-saver'): void; isAlwaysOnTop(): boolean; moveTop(): void;
}
interface WidgetScreen {getAllDisplays(): MediaDisplay[]; getPrimaryDisplay(): MediaDisplay; getDisplayMatching(bounds: Area): MediaDisplay}
/** Main owns the edit draft; renderer snapshots grant no movement authority. */
export class NowPlayingController {
  private settings: NowPlayingSettings = DEFAULT_NOW_PLAYING;
  private draft?: NowPlayingPosition;
  private ready = false;
  private available = false;
  private foreground = false;
  private visible = false;
  private interactive = false;
  private moving = false;
  constructor(private readonly window: WidgetWindow, private readonly screen: WidgetScreen, private readonly changed: () => void) {this.passThrough();}
  configure(settings: NowPlayingSettings): void {this.settings = settings; if (!settings.enabled && this.draft) this.end(); this.place();}
  loaded(ready: boolean): void {this.ready = ready; if (!ready && this.draft) this.end(); this.place();}
  update(available: boolean): void {this.available = available; this.place();}
  topologyChanged(): void {this.moving = false; this.place();}
  setOwnForeground(value: boolean): void {this.foreground = value; this.place(); this.changed();}
  editState(): NowPlayingEditState {return {active: Boolean(this.draft), placement: !this.ready || (this.draft && this.foreground && !this.visible) ? 'unavailable' : this.foreground ? 'visible' : 'not-foreground'};}
  begin(foreground: boolean): NowPlayingEditState {
    if (!this.settings.enabled || !this.ready) throw new Error('Current track edit unavailable');
    this.draft ??= {...this.settings.position}; this.foreground = foreground; this.place(); this.changed(); return this.editState();
  }
  reset(): NowPlayingEditState {if (!this.draft) throw new Error('Current track edit inactive'); this.draft = {...DEFAULT_NOW_PLAYING.position}; this.place(); this.changed(); return this.editState();}
  end(): NowPlayingPosition | undefined {
    const draft = this.draft; if (!draft) return;
    this.hide(); this.draft = undefined; this.moving = false; this.place(); this.changed(); return draft;
  }
  moveStarted(): void {if (this.draft && this.interactive) this.moving = true;}
  moved(): void {
    if (!this.draft || !this.moving) return;
    const bounds = this.window.getBounds(); this.draft = positionFromBounds(bounds, this.screen.getDisplayMatching(bounds)); this.moving = false; this.place();
  }
  private passThrough(): void {this.window.setIgnoreMouseEvents(true); this.window.setMovable(false); this.window.setFocusable(false); this.window.setSkipTaskbar(true); this.interactive = false;}
  private hide(): void {this.window.hide(); this.visible = false; this.moving = false; this.passThrough();}
  private place(): void {
    if (this.window.isDestroyed()) return;
    if (!this.settings.enabled || !this.ready || (this.draft ? !this.foreground : !this.available)) {this.hide(); return;}
    if (this.moving) return;
    const bounds = widgetBounds(this.draft ?? this.settings.position, this.settings.style, this.screen.getAllDisplays(), this.screen.getPrimaryDisplay());
    const before = this.window.getBounds();
    const moved = Object.keys(bounds).some(key => bounds[key as keyof Area] !== before[key as keyof Area]);
    if (moved) this.window.setBounds(bounds);
    const actual = this.window.getBounds();
    if (Object.keys(bounds).some(key => Math.abs(actual[key as keyof Area] - bounds[key as keyof Area]) > 1)) {this.hide(); return;}
    if (this.draft && !this.interactive) {this.window.setIgnoreMouseEvents(false); this.window.setFocusable(true); this.window.setSkipTaskbar(true); this.window.setMovable(true); this.interactive = true;}
    const shown = !this.visible;
    if (shown) {this.window.showInactive(); this.visible = true;}
    if (shown || moved || !this.window.isAlwaysOnTop()) {this.window.setAlwaysOnTop(true, 'screen-saver'); this.window.moveTop();}
  }
}
