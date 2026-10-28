export const CI_WORKFLOW: '.github/workflows/windows-ci.yml';
export function installerArtifactName(channel: string, runId: string, attempt: number): string;
export function checkReleaseRun(run: unknown, options: {runId: string; repository: string; channel: string}): {commit: string; attempt: number; artifact: string};
export function checkRelease(release: unknown, options: {tag: string; commit: string; draft: boolean; prerelease: boolean; names: readonly string[]}): {id: unknown};
