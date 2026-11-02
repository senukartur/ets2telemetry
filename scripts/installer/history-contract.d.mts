/** Read-only installer facts are validated against the hand-written historical fixture contract. */
export function expectedDatabase(backup: {fileName: string; fileSha256: string}, appVersion: string): Record<string, unknown>;
export function assertHistoryFacts(facts: unknown, appVersion: string): void;
