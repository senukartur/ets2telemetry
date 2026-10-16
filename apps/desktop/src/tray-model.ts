import type {AppHealth, LiveTelemetry} from '../../../packages/contracts/src';
import {recordingStatusText} from './recording-status-text';
import {SERVICE_HEALTH_TEXT, STORAGE_HEALTH_TEXT, STRINGS} from './strings';
import type {TrayTone} from './tray-icon';

/** Windows truncates notification-area tooltips longer than 127 characters; menu status lines keep the same limit. */
export const TRAY_TOOLTIP_LIMIT = 127;
/** Tooltip, menu and icon changes are applied at most twice per second. */
export const TRAY_MIN_UPDATE_INTERVAL_MS = 500;

export interface TrayInput {
  health: AppHealth;
  /** Selection and status of the current live state; never readings, paths or identities. */
  source?: Pick<LiveTelemetry, 'selection' | 'status'>;
  exiting: boolean;
}
export type TrayMenuItem =
  | {kind: 'status'; label: string}
  | {kind: 'separator'}
  | {kind: 'open' | 'exit'; label: string; enabled: boolean};
export interface TrayModel {tooltip: string; menu: TrayMenuItem[]; tone: TrayTone}

const SOURCE_TEXT: Readonly<Record<LiveTelemetry['selection'], string>> = Object.freeze({
  game: 'no game selected', ets2: 'ETS2', ats: 'ATS', synthetic: 'synthetic fixture', replay: 'replay fixture'
});
export function trayTone(health: AppHealth, exiting: boolean): TrayTone {
  if (!exiting && health.service === 'failed') return 'failed';
  return !exiting && health.service === 'ready' ? 'ready' : 'busy';
}
function statusLine(health: AppHealth): string {
  return `Service: ${SERVICE_HEALTH_TEXT[health.service]} · Storage self-test: ${STORAGE_HEALTH_TEXT[health.storage]}`;
}
export function trayModel(input: TrayInput): TrayModel {
  const {health, exiting} = input;
  let detail: string;
  if (exiting) detail = STRINGS.trayExiting;
  else if (health.service === 'starting') detail = STRINGS.trayStarting;
  else {
    detail = `Service ${SERVICE_HEALTH_TEXT[health.service]}`;
    if (health.service === 'ready' && input.source) detail += ` · Source: ${SOURCE_TEXT[input.source.selection]} (${input.source.status})`;
  }
  const tooltip = `${STRINGS.appName}\n${detail}`.slice(0, TRAY_TOOLTIP_LIMIT);
  return {tooltip, tone: trayTone(health, exiting), menu: [
    {kind: 'status', label: exiting ? STRINGS.trayExiting : statusLine(health)},
    // ET-015c PR-4 (G8): the recording status in its short form; the tooltip does not carry it.
    {kind: 'status', label: `${STRINGS.recordingTrayPrefix}${recordingStatusText(health.recording).short}`.slice(0, TRAY_TOOLTIP_LIMIT)},
    {kind: 'separator'},
    {kind: 'open', label: STRINGS.trayOpen, enabled: !exiting},
    {kind: 'separator'},
    {kind: 'exit', label: STRINGS.trayExit, enabled: !exiting}
  ]};
}

export interface TrayView {
  setToolTip(text: string): void;
  setMenu(menu: TrayMenuItem[]): void;
  setTone(tone: TrayTone): void;
}
export interface TrayTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
const systemTimers: TrayTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now()
};

/**
 * Applies the tray model only when a part changes, and at most twice per second; a change within the
 * interval is applied once at its end with the latest input. `immediate` bypasses the interval for the
 * exit transition, which must disable the menu at once.
 */
export class TrayPresenter {
  private applied?: {tooltip: string; menu: string; tone: TrayTone};
  private pending?: TrayInput;
  private timer: unknown;
  private lastApplied = -Infinity;
  private disposed = false;
  constructor(private readonly view: TrayView, private readonly timers: TrayTimers = systemTimers) {}

  update(input: TrayInput, immediate = false): void {
    if (this.disposed) return;
    this.pending = input;
    if (this.timer !== undefined && !immediate) return;
    const wait = this.lastApplied + TRAY_MIN_UPDATE_INTERVAL_MS - this.timers.now();
    if (immediate || !(wait > 0)) {this.flush(); return;}
    this.timer = this.timers.setTimeout(() => {this.timer = undefined; this.flush();}, wait);
  }

  dispose(): void {
    this.disposed = true; this.pending = undefined;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush(): void {
    if (this.timer !== undefined) {this.timers.clearTimeout(this.timer); this.timer = undefined;}
    const input = this.pending; this.pending = undefined;
    if (!input || this.disposed) return;
    const model = trayModel(input), menu = JSON.stringify(model.menu), previous = this.applied;
    if (previous?.tooltip === model.tooltip && previous.menu === menu && previous.tone === model.tone) return;
    this.applied = {tooltip: model.tooltip, menu, tone: model.tone};
    this.lastApplied = this.timers.now();
    if (previous?.tone !== model.tone) this.view.setTone(model.tone);
    if (previous?.tooltip !== model.tooltip) this.view.setToolTip(model.tooltip);
    if (previous?.menu !== menu) this.view.setMenu(model.menu);
  }
}
