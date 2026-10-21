import path from 'node:path';
import {fileURLToPath} from 'node:url';
/** The PR-only installer exclusion is intentional; every participating job must succeed, including on cancellation. */
export function scaffoldGate(needs, event) {
  const required = ['windows-build', 'windows-runtime', 'windows-tests', 'windows-asan', 'windows-installer'];
  return ['pull_request', 'push', 'workflow_dispatch'].includes(event) && needs !== null && typeof needs === 'object' &&
    Object.keys(needs).length === required.length && required.every(name => needs[name]?.result === (name === 'windows-installer' && event === 'pull_request' ? 'skipped' : 'success'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!scaffoldGate(JSON.parse(process.env.ETS2TELEMETRY_JOB_RESULTS ?? 'null'), process.env.GITHUB_EVENT_NAME)) throw new Error('SCAFFOLD_DEPENDENCY_FAILED');
}
