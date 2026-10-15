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
