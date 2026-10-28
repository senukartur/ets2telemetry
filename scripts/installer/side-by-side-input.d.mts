import type {BuildNames} from '../build-channel.mjs';

export const INPUT_FILE: 'side-by-side-input.json';
export const INPUT_FORMAT: 'ets2telemetry.side-by-side-input';
export interface SideBySideInput {
  format: string;
  version: number;
  source: string;
  checkout: string;
  build: BuildNames;
  setup: {name: string; sha256: string; bytes: number};
}
export function checkSideBySideInput(record: unknown, checkout: string): SideBySideInput;
export function createSideBySideInput(root: string, output: string, source: string | undefined, checkout: string): SideBySideInput;
export function verifySideBySideInput(directory: string, checkout: string): SideBySideInput & {setupPath: string};
