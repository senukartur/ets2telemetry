export type Entry = [string, number];
export type Step = {job: string; name: string; seconds: number};
export type Matrix = {cells: Record<string, Record<string, Entry[]>>};
export const LAYERS: {id: string; label: string}[];
export const MARKERS: [string, string];
export function reachedSources(test: string, read: (file: string) => string, tracked: Set<string>): string[];
export function majorityArea(sources: string[], own: string): string;
export function scenarioAreas(tracked: Set<string>): Record<string, string>;
export function ctestEntry(name: string): {area: string; family: string};
export function junitTimes(xml: string, element: 'testsuite' | 'testcase'): Entry[];
export function buildMatrix(evidence: {vitest?: Entry[]; storage?: Entry[]; ctest?: Entry[]; asan?: Entry[]; steps?: Step[]},
  areaOfTest: (file: string) => string, scenarioArea: Record<string, string>): Matrix;
export function renderMatrix(matrix: Matrix, runs: [string, string][]): string;
export function replaceSection(document: string, section: string): string;
