import type {Page} from '@playwright/test';
export interface RendererObservation {status: string; speed: string; fuel: string}
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
export function v1NotCurrentObservation(expected: {values: readonly string[]; status: string; speed: string}): Record<string, string | undefined> | false;
export function waitForV1NotCurrentLive(page: Page, values: readonly string[], status: string, speed: string): Promise<Record<string, string | undefined>>;
/** Element test id to exact text, `null` for an absent element; `freshness` compares overlay-root's data-freshness. */
export type OverlayV1Expectation = Readonly<Record<string, string | null>>;
export const SYNTHETIC_V1_OVERLAY_CURRENT: OverlayV1Expectation;
export const SYNTHETIC_V1_OVERLAY_V0_STALE: OverlayV1Expectation;
export const SYNTHETIC_V1_OVERLAY_V1_STALE: OverlayV1Expectation;
export const SYNTHETIC_V1_OVERLAY_STOPPED: OverlayV1Expectation;
export function overlayV1Observation(expected: OverlayV1Expectation): Record<string, string | null> | false;
export function waitForOverlayV1(page: Page, expected: OverlayV1Expectation): Promise<Record<string, string | null>>;
export interface OverlayOverflow {layout: string | null; root: {width: number; height: number} | null; sections: string[]; outside: string[]}
export function overlayOverflow(): OverlayOverflow;
