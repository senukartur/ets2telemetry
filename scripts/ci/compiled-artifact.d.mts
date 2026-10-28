export function compiledRoots(channel: 'production' | 'staging'): string[];
export function createCompiledArtifact(root: string, output: string, source: string, checkout: string, installer: boolean, channel: 'production' | 'staging'): Promise<void>;
export function restoreCompiledArtifact(input: string, root: string, source: string, checkout: string, installer: boolean): Promise<{files: number; bytes: number; source: string; checkout: string; channel: 'production' | 'staging'}>;
