import type {Page} from '@playwright/test';
export interface GaugeObservation {number: string; unit: string; accessibleName: string; visible: boolean}
export interface RendererObservation {status: string; speed: string; fuel: string; gauge?: GaugeObservation}
export function currentTelemetryObservation(): RendererObservation | false;
export function waitForCurrentTelemetry(page: Page): Promise<RendererObservation>;
export type LiveRow = readonly [testId: string, text: string];
export const SYNTHETIC_V0_LIVE_ROWS: readonly LiveRow[];
export const SYNTHETIC_V0_VALUE_IDS: readonly string[];
export const SYNTHETIC_V0_HIDDEN_ROWS: readonly string[];
export function completeLiveObservation(expected: {rows: readonly LiveRow[]; hidden: readonly string[]}): Record<string, string> | false;
export function notCurrentLiveObservation(expected: {values: readonly string[]; status: string; hidden: readonly string[]}): Record<string, string | undefined> | false;
export function waitForCompleteLive(page: Page, rows?: readonly LiveRow[], hidden?: readonly string[]): Promise<Record<string, string>>;
export function waitForNotCurrentLive(page: Page, values: readonly string[], status: string, hidden?: readonly string[]): Promise<Record<string, string | undefined>>;
export const SYNTHETIC_V1_LIVE_ROWS: readonly LiveRow[];
export const SYNTHETIC_V1_VALUE_IDS: readonly string[];
export const SYNTHETIC_V0V1_LIVE_ROWS: readonly LiveRow[];
export const SYNTHETIC_V0V1_HIDDEN_ROWS: readonly string[];
export function v1NotCurrentObservation(expected: {values: readonly string[]; status: string; speed: string; statusId?: string; omitFuel?: boolean}): Record<string, string | undefined> | false;
export function waitForV1NotCurrentLive(page: Page, values: readonly string[], status: string, speed: string): Promise<Record<string, string | undefined>>;
/** Element test id to exact text, `null` for an absent element; `freshness` compares overlay-root's data-freshness. */
export type OverlayV1Expectation = Readonly<Record<string, string | null>>;
export const SYNTHETIC_V1_OVERLAY_CURRENT: OverlayV1Expectation;
export const SYNTHETIC_V1_STRIP_SECTIONS: readonly string[];
export const SYNTHETIC_V1_OVERLAY_V0_STALE: OverlayV1Expectation;
export const SYNTHETIC_V1_OVERLAY_V1_STALE: OverlayV1Expectation;
export const SYNTHETIC_V1_OVERLAY_STOPPED: OverlayV1Expectation;
export function overlayV1Observation(expected: OverlayV1Expectation): Record<string, string | null> | false;
export function waitForOverlayV1(page: Page, expected: OverlayV1Expectation): Promise<Record<string, string | null>>;
/** ET-052: the break item's data-urgency, accessible name, computed colour and text decoration. */
export interface OverlayBreakCue {urgency: string | null; label: string | null; color: string; textDecorationLine: string}
export const SYNTHETIC_V1_BREAK_CUE: OverlayBreakCue;
export function overlayBreakCueObservation(expected: Partial<OverlayBreakCue>): OverlayBreakCue | false;
export function waitForOverlayBreakCue(page: Page, expected: Partial<OverlayBreakCue>): Promise<OverlayBreakCue>;
export interface OverlayOverflow {layout: string | null; root: {width: number; height: number} | null; sections: string[]; outside: string[]; truncated: string[]}
export function overlayOverflow(): OverlayOverflow;
/** ET-045d: the speed, gear and RPM value and unit texts one probe step writes into the rendered overlay. */
export interface NumberProbeStep {speed?: string; speedUnit?: string; gear?: string; rpm?: string; rpmUnit?: string}
export type ProbeEdges = {left: number; top: number; right: number; bottom: number};
export interface StripNumberProbe {ok: boolean; reason?: string; restored: boolean; baseline?: Record<string, ProbeEdges>;
  steps: {texts: Record<string, string>; moved: string[]; truncated: string[]}[]}
export function stripNumberProbe(steps: readonly NumberProbeStep[]): StripNumberProbe;
export interface ClusterCentreProbe {ok: boolean; reason?: string; restored: boolean; ring?: {track: string; limit: number; centre: {x: number; y: number}};
  steps: {texts: Record<string, string>; reach: Record<string, number>; outside: string[]; truncated: string[]}[]}
export function clusterCentreProbe(steps: readonly NumberProbeStep[]): ClusterCentreProbe;
/** ET-045f: the rendered Cluster speed arc and RPM arc; an arc that is not drawn is null. */
export interface SpeedArcObservation {r: number; transform: string | null; dasharray: string | null; offset: number; transitionProperty: string; transitionDuration: string; transitionTimingFunction: string; stroke: string; strokeWidth: string}
export interface ClusterSpeedArcProbe {ok: boolean; reason?: string; layout: string | null; track: boolean; arc: SpeedArcObservation | null;
  rpmArc: {dasharray: string | null; stroke: string} | null}
export function clusterSpeedArcProbe(): ClusterSpeedArcProbe;

export function zeroLiveObservation(language: string): boolean;
