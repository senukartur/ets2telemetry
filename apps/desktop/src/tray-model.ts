import type {AppHealth, AppLanguage, LiveTelemetry} from '../../../packages/contracts/src';
import {recordingStatusText} from './recording-status-text';
import {getSourceSelectionText, getServiceHealthText, getStorageHealthText, getStrings} from './strings';

/** Windows truncates notification-area tooltips longer than 127 characters; menu status lines keep the same limit. */
export const TRAY_TOOLTIP_LIMIT = 127;
/** Tooltip and menu changes are applied at most twice per second. */
export const TRAY_MIN_UPDATE_INTERVAL_MS = 500;

export interface TrayInput {
  health: AppHealth;
  /** Selection and status of the current live state; never readings, paths or identities. */
  source?: Pick<LiveTelemetry, 'selection' | 'status'>;
  exiting: boolean;
  language?: AppLanguage;
}
export type TrayMenuItem =
  | {kind: 'status'; label: string}
  | {kind: 'separator'}
  | {kind: 'open' | 'exit'; label: string; enabled: boolean};
export interface TrayModel {tooltip: string; menu: TrayMenuItem[]}


function statusLine(health: AppHealth, language: AppLanguage): string {
  const strings = getStrings(language);
  return `${strings.serviceTrayLabel}: ${getServiceHealthText(health.service, language)} · ${strings.storageTrayLabel}: ${getStorageHealthText(health.storage, language)}`;
}
export function trayModel(input: TrayInput): TrayModel {
  const {health, exiting} = input;
  const language = input.language ?? 'en';
  const strings = getStrings(language);
  let detail: string;
  if (exiting) detail = strings.trayExiting;
  else if (health.service === 'starting') detail = strings.trayStarting;
  else {
    const serviceLabel = strings.serviceTrayLabel;
    const sourceLabel = strings.sourceLabel;
    detail = `${serviceLabel} ${getServiceHealthText(health.service, language)}`;
    if (health.service === 'ready' && input.source) detail += ` · ${sourceLabel}: ${getSourceSelectionText(input.source.selection, language)} (${input.source.status})`;
  }
  const tooltip = `${strings.appName}\n${detail}`.slice(0, TRAY_TOOLTIP_LIMIT);
  return {tooltip, menu: [
    {kind: 'status', label: exiting ? strings.trayExiting : statusLine(health, language)},
    // ET-015c PR-4 (G8): the recording status in its short form; the tooltip does not carry it.
    {kind: 'status', label: `${strings.recordingTrayPrefix}${recordingStatusText(health.recording, language).short}`.slice(0, TRAY_TOOLTIP_LIMIT)},
    {kind: 'separator'},
    {kind: 'open', label: strings.trayOpen, enabled: !exiting},
    {kind: 'separator'},
    {kind: 'exit', label: strings.trayExit, enabled: !exiting}
  ]};
}

export interface TrayView {
  setToolTip(text: string): void;
  setMenu(menu: TrayMenuItem[]): void;
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
  private applied?: {tooltip: string; menu: string};
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
    if (previous?.tooltip === model.tooltip && previous.menu === menu) return;
    this.applied = {tooltip: model.tooltip, menu};
    this.lastApplied = this.timers.now();
    if (previous?.tooltip !== model.tooltip) this.view.setToolTip(model.tooltip);
    if (previous?.menu !== menu) this.view.setMenu(model.menu);
  }
}
