// ET-066: runs the local checks that cover a change (docs/TESTING.md#5-automation-and-merge-policy). The plan comes from
// scripts/test-affected-plan.mjs; this file collects its inputs from Git and the Vitest import graph and runs the steps.
// Windows CI still runs every suite on the PR; a local pass here is not the merge gate.
// Usage: node scripts/test-affected.mjs [--base <ref> | --range <a>..<b>] [--plan] [--json]
//   --base   compare the working tree with the merge base of <ref> and HEAD (default origin/main)
//   --range  plan the files a commit range changed, resolved in the current checkout
//   --plan   print the plan without running it; --json prints it as JSON
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CI_ONLY, DOCUMENTATION, STORAGE_BUNDLE_ENTRIES, planChecks} from './test-affected-plan.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const base = option('--base') ?? 'origin/main';
const planOnly = argv.includes('--plan'), json = argv.includes('--json');
const posix = file => file.split(path.sep).join('/');

function git(...args) {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

const range = option('--range');
const [mergeBase] = range ? [range.split('..')[0]] : git('merge-base', base, 'HEAD');
// Committed, staged, unstaged and untracked changes against the merge base, so the plan also fits work in progress.
// --range <a>..<b> plans the changes of a commit range instead, for example of a merged PR, against the current checkout.
const changed = range ? git('diff', '--name-only', range) : [...new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])].sort();
const existing = changed.filter(file => existsSync(path.join(root, file)));
const tracked = [...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')];
const testFiles = tracked.filter(file => /^tests\/.*\.(?:test|spec)\.ts$/.test(file) && existsSync(path.join(root, file)));

/** Test files that name a changed path: its repository path, or its file name when that name is unique in the checkout. */
function references() {
  const counts = new Map();
  for (const file of tracked) counts.set(path.posix.basename(file), (counts.get(path.posix.basename(file)) ?? 0) + 1);
  const sources = new Map(testFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
  const found = {};
  for (const file of changed.filter(file => !DOCUMENTATION.test(file))) {
    const name = path.posix.basename(file);
    const tokens = [file, ...(counts.get(name) === 1 && name.length >= 8 ? [name] : [])];
    // A deleted module is still named by the imports that now fail.
    if (!existing.includes(file) && /\.(?:[cm]?[jt]s|tsx)$/.test(file)) tokens.push(file.replace(/\.[^.]+$/, ''));
    const tests = testFiles.filter(test => test !== file && tokens.some(token => sources.get(test).includes(token)));
    if (tests.length > 0) found[file] = tests;
  }
  return found;
}

/** Test files and storage bundle entries whose static imports reach a changed file (Vitest's own `related` resolution). */
async function importGraph() {
  const modules = existing.filter(file => /\.(?:[cm]?[jt]s|tsx|json)$/.test(file));
  if (modules.length === 0) return {affectedTests: [], affectedEntries: []};
  const {createVitest} = await import('vitest/node');
  const vitest = await createVitest('test', {config: false, root, watch: false, reporters: [], related: modules.map(file => path.join(root, file)),
    include: ['tests/{unit,host,storage,integration}/**/*.test.ts', ...STORAGE_BUNDLE_ENTRIES]}, {}, {});
  try {
    const reached = (await vitest.specifications.getRelevantTestSpecifications()).map(spec => posix(path.relative(root, spec.moduleId)));
    return {affectedTests: reached.filter(file => file.startsWith('tests/') && file.endsWith('.test.ts')), affectedEntries: reached.filter(file => STORAGE_BUNDLE_ENTRIES.includes(file))};
  } finally {
    await vitest.close();
  }
}

const graph = changed.length === 0 || changed.every(file => DOCUMENTATION.test(file)) ? {affectedTests: [], affectedEntries: []} : await importGraph();
const plan = planChecks({changed, existing, references: references(), ...graph, lintInstalled: existsSync(path.join(root, 'tools/lint/node_modules/eslint'))});

if (json) { console.log(JSON.stringify({base, mergeBase, changed, ...plan}, null, 2)); if (planOnly) process.exit(0); }
console.log(`Changed against ${base} (${mergeBase.slice(0, 12)}): ${changed.length} file(s); plan: ${plan.kind}, ${plan.steps.length} step(s).`);
for (const step of plan.steps) console.log(`  ${step.id}: ${step.command}\n      ${step.reason}`);
if (plan.unmapped.length > 0) console.log(`No local check covers: ${plan.unmapped.join(', ')}. Only CI checks them.`);
if (plan.kind === 'documentation') console.log('Documentation only: check links, anchors and headings; no application checks.');
if (planOnly) process.exit(0);

const runtimeOutput = path.join(root, '.local', 'ci', 'affected');
const results = new Map();
for (const step of plan.steps) {
  if (step.needs.some(need => results.get(need)?.result !== 'PASS')) { results.set(step.id, {result: 'NOT RUN', seconds: 0}); continue; }
  const command = step.command.includes('Invoke-RuntimeSmoke.ps1') ? `${step.command} -OutputRoot "${runtimeOutput}"` : step.command;
  console.log(`\n> ${command}`);
  const started = performance.now();
  const {status} = spawnSync(command, {cwd: root, shell: true, stdio: 'inherit'});
  results.set(step.id, {result: status === 0 ? 'PASS' : 'FAIL', seconds: (performance.now() - started) / 1000});
}
console.log('\n| Step | Result | Duration | Command |\n| --- | --- | ---: | --- |');
for (const step of plan.steps) {
  const {result, seconds} = results.get(step.id);
  console.log(`| ${step.id} | ${result} | ${seconds.toFixed(1)} s | \`${step.command}\` |`);
}
console.log(`\nCI only: ${CI_ONLY.join('; ')}.`);
process.exit([...results.values()].every(({result}) => result === 'PASS') ? 0 : 1);
