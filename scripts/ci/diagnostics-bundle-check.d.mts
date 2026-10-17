export const REDACTED: string;
export const DIAGNOSTIC_BUNDLE_LIMIT_BYTES: number;
export function runtimeStrings(bundle: unknown): string[];
export function schemaTokens(bundle: unknown): string[];
export function checkDiagnosticsBundle(text: string, options: {identities: readonly (string | undefined)[]; runPaths: readonly string[]; mainEvents: readonly string[]}): unknown;
