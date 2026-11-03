export const STORAGE_BUNDLE_ENTRIES: string[];
export const RUNTIME_SCENARIOS: Record<string, string[]>;
export const DOCUMENTATION: RegExp;
export const CI_ONLY: string[];
export const MAX_SELECTED_FILES: number;
export type PlanStep = {id: string; command: string; reason: string; needs: string[]};
export type Plan = {kind: 'empty' | 'documentation' | 'code'; steps: PlanStep[]; unmapped: string[]; ciOnly: string[]};
export function planChecks(input: {changed: string[]; affectedTests?: string[]; affectedEntries?: string[]; references?: Record<string, string[]>;
  existing?: string[]; lintInstalled?: boolean}): Plan;
