// ET-066: the area × layer test matrix of docs/regression-registry.md#area--layer-matrix, generated from the hosted
// evidence of Windows CI runs instead of written by hand. Rows are the product areas of TEST_AREAS in
// scripts/test-affected-plan.mjs, columns the test layers; each cell lists its entry points with their hosted seconds:
// a Vitest or storage file's JUnit time, a CTest family's summed case times, a CI step's duration otherwise.
// Usage: node scripts/test-matrix.mjs --run <pr run id> --run <main push run id> [--run <extended campaigns run id>] [--write]
//   --run       downloads that run's JUnit artifacts and step times with gh into .local/test-matrix/<id>
//   --evidence  reads a folder laid out as --run leaves it instead (offline)
//   --write     replaces the generated section of docs/regression-registry.md; otherwise prints it
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {RUNTIME_SCENARIOS, TEST_AREAS, areaOf, runtimeScenariosOf} from './test-affected-plan.mjs';

export const LAYERS = [
  {id: 'unit', label: 'Vitest unit'}, {id: 'storage', label: 'Storage'}, {id: 'ctest', label: 'C++ CTest'}, {id: 'asan', label: 'ASan'},
  {id: 'chains', label: 'Chains and CLI smokes'}, {id: 'runtime', label: 'Packaged runtime'}, {id: 'installer', label: 'Installer lifecycle'},
  {id: 'extended', label: 'Extended'}];
export const MARKERS = ['<!-- test-matrix:start -->', '<!-- test-matrix:end -->'];

/** Runtime step titles of .github/workflows/windows-ci.yml by the scenario they run (RUNTIME_SCENARIOS, plus the session-end audit). */
const RUNTIME_STEPS = [[/Electron worker smoke/, 'scaffold'], [/session-end audit/, 'session-end'], [/telemetry source/, 'telemetry'],
  [/hidden overlay/, 'overlay'], [/current track/, 'now-playing'], [/tray lifecycle/, 'lifecycle'], [/plugin setup/, 'plugin'],
  [/recording journey/, 'recording'], [/trip journal smoke/, 'journal'], [/Hard Mode journey/, 'hard-mode'], [/UI (\w+) shard/, 'ui:'],
  [/history database refusal/, 'refusal']];
/** Other CI steps that are test entry points: [job, step title, layer, entry point, test file or area]. */
const STEP_ENTRIES = [
  [/compiled artifacts/, /CAP0 controlled capture chain/, 'chains', 'cap0-chain', {test: 'tests/integration/cap0-chain.test.ts'}],
  [/compiled artifacts/, /Protocol v1 controlled broker chain/, 'chains', 'v1-chain and v1-chain-process-death', {test: 'tests/integration/v1-chain.test.ts'}],
  [/compiled artifacts/, /Plugin image lock check/, 'chains', 'plugin-image-lock', {test: 'tests/integration/plugin-image-lock.test.ts'}],
  [/compiled artifacts/, /v0 CLI pipe smoke/, 'chains', 'simulator smoke (v0)', {area: 'protocol'}],
  [/compiled artifacts/, /v1 CLI pipe smoke/, 'chains', 'simulator smoke:v1', {area: 'protocol'}],
  [/AddressSanitizer/, /Media reader AddressSanitizer/, 'asan', 'media-session-reader-asan-*', {area: 'now-playing'}],
  [/installer/, /^Installer lifecycle in a test root/, 'installer', 'production lifecycle', {area: 'setup'}],
  [/installer/, /^Staging installer lifecycle/, 'installer', 'staging lifecycle', {area: 'setup'}],
  [/installer/, /Side-by-side installer lifecycle/, 'installer', 'side-by-side lifecycle', {area: 'setup'}],
  [/installer/, /Update-from-feed installer lifecycle/, 'installer', 'update-from-feed lifecycle', {area: 'updater'}],
  [/runtime/, /Extended existing safety regressions/, 'extended', 'Invoke-Extended (watchdog, uninstall residue, deferred cleanup)', {area: 'setup'}],
  [/extended campaigns/, /Native .* fuzz/, 'extended', null, {area: 'native-plugin'}],
  [/extended campaigns/, /Recovery campaign/, 'extended', null, {test: 'tests/storage/trip-recorder-crash.test.ts'}],
  [/extended campaigns/, /Protocol fuzz campaign/, 'extended', null, {test: 'tests/unit/protocol-fuzz.test.ts'}]];

const IMPORT = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
const NAMED_PATH = /['"`]((?:apps|packages|tools|scripts|native|resources|\.github)\/[\w./-]+)['"`]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs', '/index.ts'];

/**
 * The repository files a test imports or names, following its own helpers under tests/ (not product modules): the
 * files `read(file)` returns text for, among `tracked`. Type-only imports are left out.
 */
export function reachedSources(test, read, tracked) {
  const sources = new Set(), seen = new Set([test]), queue = [test];
  while (queue.length > 0) {
    const file = queue.shift(), text = read(file).split(/\r?\n/).filter(line => !/^\s*import\s+type\b/.test(line)).join('\n');
    const targets = [...text.matchAll(IMPORT)].map(match => resolveImport(file, match[1] ?? match[2] ?? match[3], tracked));
    targets.push(...[...text.matchAll(NAMED_PATH)].map(match => match[1]).filter(name => tracked.has(name)));
    for (const target of targets.filter(Boolean)) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (target.startsWith('tests/')) { if (/\.(?:[cm]?[jt]s|tsx)$/.test(target)) queue.push(target); } else sources.add(target);
    }
  }
  return [...sources].sort();
}
function resolveImport(from, specifier, tracked) {
  const base = path.posix.join(path.posix.dirname(from), specifier);
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), ...EXTENSIONS.slice(1).map(extension => base + extension)]) if (tracked.has(candidate)) return candidate;
  return null;
}

/** Test tooling that many tests import to drive their subject: counted only when a test imports nothing else. */
const TOOLING = /^(?:tools\/telemetry-simulator|tests\/fixtures)\//;

/**
 * The area of a test entry point or runtime scenario: the area its own name falls in (the names follow the subject), else
 * the area that owns most of `sources`, by TEST_AREAS order on a tie, else `ci`.
 */
export function majorityArea(sources, own) {
  const named = areaOf(path.posix.basename(own).replace(/\.(?:test|spec)\.ts$/, ''));
  if (named) return named;
  const product = sources.filter(file => !TOOLING.test(file)), counts = new Map();
  for (const area of (product.length > 0 ? product : sources).map(areaOf).filter(Boolean)) counts.set(area, (counts.get(area) ?? 0) + 1);
  return TEST_AREAS.map(area => area.id).filter(id => counts.has(id)).sort((a, b) => counts.get(b) - counts.get(a))[0] ?? 'ci';
}

/** Each runtime scenario's area: the area owning most of the desktop and package sources that select the scenario. */
export function scenarioAreas(tracked) {
  const sources = [...tracked].filter(file => /^(?:apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file));
  const areas = {'session-end': 'shell'};
  for (const name of Object.keys(RUNTIME_SCENARIOS)) areas[name] = majorityArea(sources.filter(file => runtimeScenariosOf(file).includes(name)), name);
  return areas;
}

/** The area of a CTest case by TEST_AREAS `ctest`, and its family: the ASan token removed and the case suffix folded into `*`. */
export function ctestEntry(name) {
  const plain = name.replace(/-asan(?=-)/, '');
  const area = TEST_AREAS.find(entry => entry.ctest?.test(plain))?.id ?? 'native-plugin';
  const group = /^native-pipe-client-(discover|v1|capture)-/.exec(plain)?.[1];
  const family = plain.startsWith('native-pipe-client-') ? `native-pipe-client-${group ? `${group}-` : ''}*`
    : plain.startsWith('media-session-reader-') ? plain : plain.replace(/-contract-.*$/, '-contract-*');
  return {area, family};
}

/** [name, seconds] of every <testsuite> (Vitest, one per file) or <testcase> (CTest) in a JUnit document. */
export function junitTimes(xml, element) {
  const pattern = element === 'testsuite' ? /<testsuite name="([^"]+)"[^>]*?\stime="([\d.]+)"/g : /<testcase name="([^"]+)"[^>]*?\stime="([\d.]+)"/g;
  return [...xml.matchAll(pattern)].map(match => [match[1], Number(match[2])]);
}

/**
 * Builds the matrix from parsed evidence: `vitest` and `storage` are [file, seconds], `ctest` and `asan` [case, seconds],
 * `steps` {job, name, seconds}, `areaOfTest` maps a test file to its area and `scenarioArea` a runtime scenario to its area.
 * Returns {cells: {area: {layer: [[entry, seconds], ...]}}} with each cell's entries longest first.
 */
export function buildMatrix({vitest = [], storage = [], ctest = [], asan = [], steps = []}, areaOfTest, scenarioArea) {
  const cells = Object.fromEntries(TEST_AREAS.map(area => [area.id, Object.fromEntries(LAYERS.map(layer => [layer.id, new Map()]))]));
  const add = (area, layer, entry, seconds) => { const cell = cells[area][layer]; cell.set(entry, (cell.get(entry) ?? 0) + seconds); };
  // tests/host/ stays as host/: tests/host/game-processes and tests/unit/game-processes share a name and a layer.
  const short = file => file.replace(/^tests\/(?:(?:unit|storage|integration)\/)?/, '').replace(/\.test\.ts$/, '');
  for (const [file, seconds] of vitest) add(areaOfTest(file), 'unit', short(file), seconds);
  for (const [file, seconds] of storage) add(areaOfTest(file), 'storage', short(file), seconds);
  for (const [layer, cases] of [['ctest', ctest], ['asan', asan]]) for (const [name, seconds] of cases) { const {area, family} = ctestEntry(name); add(area, layer, family, seconds); }
  for (const {job, name, seconds} of steps) {
    const runtime = /runtime/i.test(job) ? RUNTIME_STEPS.find(([pattern]) => pattern.test(name)) : undefined;
    if (runtime && /Yukon UI|smoke|audit|journey/.test(name)) {
      const scenario = runtime[1] === 'ui:' ? `ui:${/UI (\w+) shard/.exec(name)[1]}` : runtime[1];
      const development = /development/i.test(name);
      add(scenarioArea[scenario] ?? 'shell', development ? 'extended' : 'runtime', development ? `${scenario} (development)` : scenario, seconds);
      continue;
    }
    const rule = STEP_ENTRIES.find(([jobPattern, stepPattern]) => jobPattern.test(job) && stepPattern.test(name));
    if (!rule) continue;
    const [, , layer, entry, owner] = rule;
    add(owner.area ?? areaOfTest(owner.test), layer, entry ?? name, seconds);
  }
  return {cells: Object.fromEntries(Object.entries(cells).map(([area, layers]) =>
    [area, Object.fromEntries(Object.entries(layers).map(([layer, map]) => [layer, [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))]))]))};
}

const seconds = value => value >= 10 ? Math.round(value).toString() : value.toFixed(1);
const total = entries => entries.reduce((sum, [, value]) => sum + value, 0);

/** The generated Markdown section, between MARKERS. `runs` are [id, what it supplied] for the provenance line. */
export function renderMatrix({cells}, runs) {
  const lines = [MARKERS[0], '',
    `Generated by \`node scripts/test-matrix.mjs\` from ${runs.map(([id, what]) => `[${id}](https://github.com/senukartur/ets2telemetry/actions/runs/${id}) (${what})`).join(', ')}. ` +
    'Seconds are hosted wall time: a Vitest or storage file\'s JUnit time (files run in parallel workers, so a column\'s sum exceeds its step), a CTest family\'s summed case times, a CI step\'s duration otherwise. ' +
    'Areas own repository paths by `TEST_AREAS` in [test-affected-plan.mjs](../scripts/test-affected-plan.mjs). A test file or runtime scenario belongs to the area its name falls in, else to the area that owns most of the product files it imports (for a scenario, the sources that select it in the local plan); a CTest case belongs to its area by name. ' +
    'Development-mode smokes, which run only on `main` and dispatch, are counted as Extended. Totals add entry points: they measure test time, not CI wall time.', '',
    `| Area | ${LAYERS.map(layer => layer.label).join(' | ')} | Total |`, `| --- | ${LAYERS.map(() => '---:').join(' | ')} | ---: |`];
  const sums = LAYERS.map(() => [0, 0]);
  for (const area of TEST_AREAS) {
    const row = LAYERS.map((layer, index) => {
      const entries = cells[area.id][layer.id];
      sums[index][0] += entries.length; sums[index][1] += total(entries);
      return entries.length === 0 ? '—' : `${entries.length} · ${seconds(total(entries))} s`;
    });
    lines.push(`| ${area.label} | ${row.join(' | ')} | ${seconds(LAYERS.reduce((sum, layer) => sum + total(cells[area.id][layer.id]), 0))} s |`);
  }
  lines.push(`| **All areas** | ${sums.map(([count, value]) => `${count} · ${seconds(value)} s`).join(' | ')} | ${seconds(sums.reduce((sum, [, value]) => sum + value, 0))} s |`, '');
  for (const area of TEST_AREAS) {
    const parts = LAYERS.filter(layer => cells[area.id][layer.id].length > 0)
      .map(layer => `${layer.label}: ${cells[area.id][layer.id].map(([entry, value]) => `\`${entry}\` ${seconds(value)}`).join(', ')}.`);
    if (parts.length > 0) lines.push(`- **${area.label}.** ${parts.join(' ')}`);
  }
  lines.push('', MARKERS[1]);
  return lines.join('\n');
}

/** Replaces the section between MARKERS in `document`, in its line endings; refuses a document without exactly one pair. */
export function replaceSection(document, section) {
  const start = document.indexOf(MARKERS[0]), end = document.indexOf(MARKERS[1]);
  if (start === -1 || end < start || document.indexOf(MARKERS[0], start + 1) !== -1) throw new Error('TEST_MATRIX_MARKERS_INVALID');
  return document.slice(0, start) + section.replace(/\r?\n/g, document.includes('\r\n') ? '\r\n' : '\n') + document.slice(end + MARKERS[1].length);
}

function files(directory) {
  return existsSync(directory) ? readdirSync(directory, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)) : [];
}

function main() {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const argv = process.argv.slice(2), values = name => argv.flatMap((value, index) => value === name ? [argv[index + 1]] : []);
  const gh = (...args) => {
    const result = spawnSync('gh', args, {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const folders = [...values('--evidence')];
  for (const run of values('--run')) {
    if (!/^\d+$/.test(run)) throw new Error('TEST_MATRIX_RUN_INVALID');
    const folder = path.join(root, '.local', 'test-matrix', run);
    if (!existsSync(path.join(folder, 'jobs.json'))) {
      mkdirSync(folder, {recursive: true});
      // The tests, ASan and native evidence hold the JUnit files; the runtime, installer and compiled artifacts are large and hold none.
      const artifacts = JSON.parse(gh('api', `repos/{owner}/{repo}/actions/runs/${run}/artifacts?per_page=100`)).artifacts.map(artifact => artifact.name)
        .filter(name => /^windows-(?:tests-|asan-)?evidence-/.test(name));
      for (const name of artifacts) gh('run', 'download', run, '-n', name, '-D', path.join(folder, name));
      writeFileSync(path.join(folder, 'jobs.json'), gh('api', '--paginate', '--slurp', `repos/{owner}/{repo}/actions/runs/${run}/jobs`));
    }
    folders.push(folder);
  }
  if (folders.length === 0) throw new Error('Pass --run <id> or --evidence <folder>.');

  // The first run that supplies a JUnit file or a step is its source: a later main push run adds only what the PR run
  // skipped (installer lifecycles, development smokes, extended regressions), so nothing is counted twice.
  const evidence = {vitest: [], storage: [], ctest: [], asan: [], steps: []}, runs = [], taken = new Set();
  for (const folder of folders) {
    const found = files(folder), supplied = new Set();
    for (const file of found.filter(name => name.endsWith('.xml')).sort()) {
      const xml = readFileSync(file, 'utf8'), base = path.basename(file);
      const kind = base === 'vitest.xml' ? ['vitest', 'testsuite', 'Vitest'] : base === 'vitest-storage.xml' ? ['storage', 'testsuite', 'storage']
        : /^ctest-.*-asan\.xml$/.test(base) ? ['asan', 'testcase', 'ASan'] : /^ctest-.*\.xml$/.test(base) ? ['ctest', 'testcase', 'CTest'] : null;
      if (!kind || taken.has(base)) continue;
      taken.add(base);
      evidence[kind[0]].push(...junitTimes(xml, kind[1]));
      supplied.add(`${kind[2]} JUnit`);
    }
    const jobsFile = found.find(name => path.basename(name) === 'jobs.json');
    if (jobsFile) {
      const pages = JSON.parse(readFileSync(jobsFile, 'utf8')), jobs = (Array.isArray(pages) ? pages : [pages]).flatMap(page => page.jobs);
      for (const job of jobs) for (const step of job.steps ?? []) {
        const key = `${job.name.replace(/\s*\(.*\)$/, '')}::${step.name}`;
        if (step.conclusion === 'skipped' || !step.started_at || !step.completed_at || taken.has(key)) continue;
        taken.add(key);
        evidence.steps.push({job: job.name, name: step.name, seconds: (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000});
        supplied.add('step times');
      }
    }
    if (supplied.size > 0) runs.push([path.basename(folder), [...supplied].join(', ')]);
  }

  const tracked = new Set(spawnSync('git', ['ls-files'], {cwd: root, encoding: 'utf8'}).stdout.split(/\r?\n/).filter(Boolean));
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const areaOfTest = test => majorityArea(tracked.has(test) ? reachedSources(test, read, tracked) : [], test);
  const section = renderMatrix(buildMatrix(evidence, areaOfTest, scenarioAreas(tracked)), runs);
  if (argv.includes('--write')) {
    const registry = path.join(root, 'docs', 'regression-registry.md');
    writeFileSync(registry, replaceSection(readFileSync(registry, 'utf8'), section));
    console.log(`Wrote the area × layer matrix to ${path.relative(root, registry)}.`);
  } else console.log(section);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
