import type {Page} from '@playwright/test';
export type RemainingBudget = (cap: number) => number;
export function screen(page: Page, route: string, left?: RemainingBudget): Promise<void>;
export function settingsPanel(page: Page, panel: string, left?: RemainingBudget): Promise<void>;
export function waitForStartup(page: Page, left?: RemainingBudget, readyCap?: number): Promise<void>;
export function chooseSource(page: Page, value: string): Promise<void>;
export function chooseLanguage(page: Page, value: string): Promise<void>;
