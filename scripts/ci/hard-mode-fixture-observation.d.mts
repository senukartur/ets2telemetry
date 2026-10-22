import type {HardModeStatus, HardModeRule} from '../../packages/contracts/src/hard-mode';
export interface FixtureRule extends HardModeRule {label: string; name: string; tooltip: string[]; drawer: string[]}
export interface FixtureExpectation {language: string; rules: FixtureRule[]; hint?: string; drawer?: boolean}
export interface FixtureSnapshot {
  status: HardModeStatus; language: string;
  rows: {id: string; state: string; buttonCount: number; label: string; name: string}[];
  hint?: {count: number; visible: boolean; lines: string[]};
  drawer?: {count: number; visible: boolean; rows: {id: string; lines: string[]}[]};
}
export interface FixtureRecord {lastSnapshot?: FixtureSnapshot; phase?: string; refreshRequests?: number; elapsedMilliseconds?: number; observedUtcMs?: number}
export function hardModeFixtureSnapshot(options?: {hint?: string; drawer?: boolean}): Promise<FixtureSnapshot>;
export function waitForHardModeFixture(input: {refresh: () => Promise<unknown>; observe: () => Promise<FixtureSnapshot>;
  expected: FixtureExpectation; record: FixtureRecord; message: string; timeoutMs?: number}): Promise<FixtureSnapshot>;
