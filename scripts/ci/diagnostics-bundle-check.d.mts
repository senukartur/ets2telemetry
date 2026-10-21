export const REDACTED: string;
export const DIAGNOSTIC_BUNDLE_LIMIT_BYTES: number;
export function runtimeStrings(bundle: unknown): string[];
export function schemaTokens(bundle: unknown): string[];
/** The lower-case enums of the bundle's views, by name. */
export const ENUMS: Readonly<Record<'serviceHealth' | 'storageHealth' | 'recordingState' | 'recordingTarget' | 'tripPhase' | 'tripCompleteness' | 'language' | 'unitProfile' | 'overlayLayout' | 'overlaySection' | 'settingsState' | 'pluginMode' | 'pluginGame' | 'discovery' | 'manualFolder' | 'targetState' | 'targetSource' | 'selection' | 'liveStatus', readonly string[]>>;
export function checkDiagnosticsBundle(text: string, options: {identities: readonly (string | undefined)[]; runPaths: readonly string[]; mainEvents: readonly string[]}): unknown;
