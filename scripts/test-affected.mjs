// ET-066: runs the local checks that cover a change (docs/TESTING.md#5-automation-and-merge-policy). The plan and the step
// runner come from scripts/test-affected-plan.mjs; this file collects their inputs from Git and the Vitest import graph.
// Windows CI still runs every suite on the PR; a local pass here is not the merge gate.
// Usage: node scripts/test-affected.mjs [--base <ref> | --range <a>..<b>] [--plan] [--json]
//   --base   compare the working tree with the merge base of <ref> and HEAD (default origin/main)
//   --range  plan the files a commit range changed, resolved in the current checkout
//   --plan   print the plan without running it; --json prints it as JSON
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CI_ONLY, DOCUMENTATION, STORAGE_BUNDLE_ENTRIES, findReferences, formatSummary, planChecks, runSteps} from './test-affected-plan.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const base = option('--base') ?? 'origin/main';
const planOnly = argv.includes('--plan'), json = argv.includes('--json');
const posix = file => file.split(path.sep).join('/');

/** Runs Git without a shell; `-z` output is split on NUL, so a path is never re-read through quoting. */
function git(...args) {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split(args.includes('-z') ? '\0' : /\r?\n/).filter(Boolean);
}

const range = option('--range');
const [mergeBase] = range ? [range.split('..')[0]] : git('merge-base', base, 'HEAD');
// Committed, staged, unstaged and untracked changes against the merge base, so the plan also fits work in progress.
// --range <a>..<b> plans the changes of a commit range instead, for example of a merged PR, against the current checkout.
// Without rename detection a moved file is its deleted old path and its new path, so the tests of both are planned.
const changed = range ? git('diff', '--name-only', '--no-renames', '-z', range)
  : [...new Set([...git('diff', '--name-only', '--no-renames', '-z', mergeBase), ...git('ls-files', '-z', '--others', '--exclude-standard')])].sort();
const existing = changed.filter(file => existsSync(path.join(root, file)));
const tracked = [...git('ls-files', '-z'), ...git('ls-files', '-z', '--others', '--exclude-standard')];
const testFiles = tracked.filter(file => /^tests\/.*\.(?:test|spec)\.ts$/.test(file) && existsSync(path.join(root, file)));

/** Maps each changed module to the test files and storage bundle entries whose static imports reach it (Vitest's module graph). */
async function importGraph() {
  const modules = existing.filter(file => /\.(?:[cm]?[jt]s|tsx|json)$/.test(file));
  if (modules.length === 0) return {};
  const {createVitest} = await import('vitest/node');
  const vitest = await createVitest('test', {config: false, root, watch: false, reporters: [],
    include: ['tests/{unit,host,storage,integration}/**/*.test.ts', ...STORAGE_BUNDLE_ENTRIES]}, {}, {});
  try {
    const specifications = await vitest.specifications.globTestSpecifications();
    if (specifications.length === 0) return {};
    const entries = new Map(specifications.map(specification => [specification.moduleId, posix(path.relative(root, specification.moduleId))]));
    const imports = {};
    for (const file of modules) {
      const affected = await vitest.specifications.getAffectedModules(specifications[0].project, specifications, [posix(path.resolve(root, file))]);
      const reached = [...affected].filter(id => entries.has(id)).map(id => entries.get(id)).sort();
      if (reached.length > 0) imports[file] = reached;
    }
    return imports;
  } finally {
    await vitest.close();
  }
}

const prose = changed.length === 0 || changed.every(file => DOCUMENTATION.test(file));
const references = findReferences({changed, existing, tracked, sources: new Map(testFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')]))});
const imports = prose ? {} : await importGraph();
let plan;
try {
  plan = planChecks({changed, existing, imports, references, lintInstalled: existsSync(path.join(root, 'tools/lint/node_modules/eslint'))});
} catch (error) {
  console.error(`test:affected: ${error.message}. Rename the files or run the full suites.`);
  process.exit(2);
}

if (json) { console.log(JSON.stringify({base, mergeBase, changed, ...plan}, null, 2)); if (planOnly) process.exit(0); }
console.log(`Changed against ${base} (${mergeBase.slice(0, 12)}): ${changed.length} file(s); plan: ${plan.kind}, ${plan.steps.length} step(s).`);
if (plan.areas.length > 0) console.log(`Areas (docs/regression-registry.md#area--layer-matrix): ${plan.areas.join(', ')}.`);
for (const step of plan.steps) console.log(`  ${step.id}: ${step.command}\n      ${step.reason}`);
if (plan.unmapped.length > 0) console.log(`No local test covers: ${plan.unmapped.join(', ')}. Locally they are at most typechecked and linted; only CI tests them.`);
if (plan.kind === 'documentation') console.log('Documentation only: check links, anchors and headings; no application checks.');
if (planOnly) process.exit(0);

const runtimeOutput = path.join(root, '.local', 'ci', 'affected');
const results = runSteps(plan.steps, step => {
  const command = step.command.includes('Invoke-RuntimeSmoke.ps1') ? `${step.command} -OutputRoot "${runtimeOutput}"` : step.command;
  console.log(`\n> ${command}`);
  // Every path in a command matched SAFE_PATH in planChecks, so the shell reads each one as a single word.
  return spawnSync(command, {cwd: root, shell: true, stdio: 'inherit'}).status;
});
console.log(`\n${formatSummary(results)}`);
console.log(`\nCI only: ${CI_ONLY.join('; ')}.`);
process.exit(results.every(({result}) => result === 'PASS') ? 0 : 1);
