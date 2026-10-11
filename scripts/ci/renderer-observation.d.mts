import type {Page} from '@playwright/test';
export interface RendererObservation {status: string; speed: string; fuel: string}
export function currentTelemetryObservation(): RendererObservation | false;
export function waitForCurrentTelemetry(page: Page): Promise<RendererObservation>;
