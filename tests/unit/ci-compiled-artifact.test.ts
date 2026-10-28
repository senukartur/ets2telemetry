import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {expect, it} from 'vitest';
import {mkdir, readFile, writeFile, rm, symlink, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileWorkBudget} from '../shared/file-work';
import {temporaryResources} from '../shared/resources';
import {compiledRoots, createCompiledArtifact, restoreCompiledArtifact} from '../../scripts/ci/compiled-artifact.mjs';
import {scaffoldGate} from '../../scripts/ci/scaffold-gate.mjs';
const source = 'a'.repeat(40), checkout = 'b'.repeat(40);
// The fixtures are production builds unless a case names staging (ET-055 PR-4: the package folder is the channel's).
const COMPILED_ROOTS = compiledRoots('production');
const HOST_ROOT = 'native/telemetry-plugin/build/cap0-host/Release';
const HOST = 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe';
const BINDING = 'node_modules/better-sqlite3/prebuilds/win32-x64.node';
const MAKER = 'out/make/squirrel.windows/x64';
const HOST_BYTES = Buffer.from('compiled nested CAP0 host fixture');
const HOST_HASH = 'fea6030bb5e81d9f665e74cf9db624325d03f05073506e9dd0b19a3bf590e130';
// Named budgets of the cases below whose duration is irreducible real temporary-file work (TESTING.md section 6): the
// most file requests one case issued (libuv promise and callback requests and handle closes, counted for every case on
// October 28, 2026), rounded up, at FS_OPERATION_ALLOWANCE_MS each. They bound file work, not behaviour timing, and
// the cases assert no timing. Each case takes 0.1 to 0.5 s idle, but in 13 full npm test runs the two sweeps these
// cases replace timed out at the default 5 s five times, and the channel and restore cases took up to 3.0 and 1.2 s
// (ET-019, docs/validation/et-019.md). Every case seals its own producer and changes its own sealed copy, so none can
// share a fixture.
/** 1,447 requests counted: one producer sealed and restored, then refused for each wrong identity, manifest, tamper, extra file and link. */
const RESTORE_CASE_FS_BUDGET_MS = fileWorkBudget(1_500);
/** 951 to 1,077 requests counted per installer value and variant. */
const NESTED_HELPER_FS_BUDGET_MS = fileWorkBudget(1_100);
/** 815 to 964 requests counted per omitted root. */
const MISSING_ROOT_FS_BUDGET_MS = fileWorkBudget(1_000);
/** 906 requests counted. */
const CHANNEL_CASE_FS_BUDGET_MS = fileWorkBudget(1_000);
/**
 * A hang guard for each real Node child that the CLI case starts in sequence (spawnSync's timeout), not a timing
 * assertion: a child that does not exit within it has a null status, so the case fails on that status. On a loaded host
 * a Node child takes over a second to start (fixed-program.test.ts), and the case's six children took 1.1 to 3.8 s
 * together on October 28, 2026. spawnSync blocks the event loop, so the case timeout is the guard for each child.
 */
const CLI_HANG_GUARD_MS = 10_000, CLI_CHILDREN = 6;
async function writeFixture(root: string, installer = false, omit?: string, roots = COMPILED_ROOTS) {
  for (const base of [...roots, ...(installer ? [MAKER] : [])]) {
    if (base === omit || base === HOST_ROOT) continue;
    const file = base === BINDING ? base : `${base}/fixture.exe`;
    await mkdir(path.dirname(path.join(root, file)), {recursive: true}); await writeFile(path.join(root, file), `compiled ${base}`);
  }
  // Literal consumer path, independent of the producer's root list: catches a helper silently omitted from that list.
  if (omit !== HOST_ROOT) {await mkdir(path.dirname(path.join(root, HOST)), {recursive: true}); await writeFile(path.join(root, HOST), HOST_BYTES);}
}

it.each(['push', 'workflow_dispatch', 'pull_request'])('fails closed for every participating job on %s', event => {
  const needs = Object.fromEntries(['windows-build', 'windows-runtime', 'windows-installer', 'windows-tests', 'windows-asan'].map(name => [name, {result: name === 'windows-installer' && event === 'pull_request' ? 'skipped' : 'success'}]));
  expect(scaffoldGate(needs, event)).toBe(true);
  for (const name of Object.keys(needs)) {
    for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
      if (name === 'windows-installer' && event === 'pull_request' && result === 'skipped') continue;
      expect(scaffoldGate({...needs, [name]: {result}}, event), `${name}/${result}`).toBe(false);
    }
    const missing = {...needs}; delete missing[name]; expect(scaffoldGate(missing, event)).toBe(false);
  }
  expect(scaffoldGate(null, event)).toBe(false); expect(scaffoldGate(needs, 'unknown')).toBe(false);
});
it('restores exactly verified producer bytes and rejects wrong identity, missing hashes, tamper, extra and escaping files before writes', async () => {
  const temp = await temporaryResources();
  const root = path.join(temp.directory, 'producer'), input = path.join(temp.directory, 'sealed'), target = path.join(temp.directory, 'consumer');
  try {
    await writeFixture(root);
    await createCompiledArtifact(root, input, source, checkout, false, 'production');
    await mkdir(path.dirname(path.join(target, BINDING)), {recursive: true}); await writeFile(path.join(target, BINDING), 'different consumer binding');
    const restored = await restoreCompiledArtifact(input, target, source, checkout, false);
    expect(restored.files).toBe(COMPILED_ROOTS.length);
    const restoredHost = await readFile(path.join(target, HOST));
    expect(restoredHost).toEqual(HOST_BYTES); expect(createHash('sha256').update(restoredHost).digest('hex')).toBe(HOST_HASH);
    expect(await readFile(path.join(target, BINDING))).toEqual(await readFile(path.join(root, BINDING)));
    const manifestFile = path.join(input, 'manifest.json'), original = await readFile(manifestFile, 'utf8');
    for (const [wrongSource, wrongCheckout, installer] of [['c'.repeat(40), checkout, false], [source, 'c'.repeat(40), false], [source, checkout, true]] as const)
      await expect(restoreCompiledArtifact(input, target, wrongSource, wrongCheckout, installer)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    for (const change of ['hash', 'escape', 'duplicate', 'missing-root']) {
      const manifest = JSON.parse(original) as {files: {path: string; sha256?: string}[]};
      if (change === 'hash') delete manifest.files[0].sha256;
      if (change === 'escape') manifest.files[0].path = '../outside';
      if (change === 'duplicate') manifest.files.push(manifest.files[0]);
      if (change === 'missing-root') manifest.files.pop();
      await writeFile(manifestFile, JSON.stringify(manifest));
      await expect(restoreCompiledArtifact(input, target, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    }
    await writeFile(manifestFile, original);
    const selected = path.join(input, 'payload', COMPILED_ROOTS[0], 'fixture.exe'), bytes = await readFile(selected);
    await writeFile(selected, 'tampered'); await expect(restoreCompiledArtifact(input, target, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID'); await writeFile(selected, bytes);
    await writeFile(path.join(input, 'payload/extra.exe'), 'extra'); await expect(restoreCompiledArtifact(input, target, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID'); await rm(path.join(input, 'payload/extra.exe'));
    expect(await readFile(path.join(target, COMPILED_ROOTS[0], 'fixture.exe'))).toEqual(bytes);
    const linked = path.join(temp.directory, 'linked'), outside = path.join(temp.directory, 'outside');
    await mkdir(linked); await mkdir(outside); await symlink(outside, path.join(linked, 'apps'), 'junction');
    await expect(restoreCompiledArtifact(input, linked, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    const rootLink = path.join(temp.directory, 'root-link'), inputLink = path.join(temp.directory, 'input-link');
    await symlink(outside, rootLink, 'junction'); await symlink(input, inputLink, 'junction');
    await expect(restoreCompiledArtifact(input, rootLink, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    await expect(restoreCompiledArtifact(input, path.join(rootLink, 'child'), source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    await expect(restoreCompiledArtifact(inputLink, target, source, checkout, false)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    expect(await readdir(outside)).toEqual([]);

  } finally {await temp.dispose();}
}, RESTORE_CASE_FS_BUDGET_MS);

it('uses the actual aggregate CLI exit status for success, failed, cancelled, skipped and missing dependencies', () => {
  const needs = Object.fromEntries(['windows-build', 'windows-runtime', 'windows-installer', 'windows-tests', 'windows-asan'].map(name => [name, {result: 'success'}]));
  const run = (value: unknown, event = 'push') => spawnSync(process.execPath, ['scripts/ci/scaffold-gate.mjs'], {encoding: 'utf8', windowsHide: true, timeout: CLI_HANG_GUARD_MS, env: {...process.env, GITHUB_EVENT_NAME: event, ETS2TELEMETRY_JOB_RESULTS: JSON.stringify(value)}}).status;
  expect(run(needs)).toBe(0);
  for (const result of ['failure', 'cancelled', 'skipped']) expect(run({...needs, 'windows-runtime': {result}})).toBe(1);
  const missing = {...needs}; delete missing['windows-build']; expect(run(missing)).toBe(1);
  expect(run({...needs, 'windows-installer': {result: 'skipped'}}, 'pull_request')).toBe(0);
}, CLI_CHILDREN * CLI_HANG_GUARD_MS);

it('retains every runtime scenario, fixed required names, timeout ceilings and exact-artifact consumer verification', async () => {
  const workflow = (await readFile('.github/workflows/windows-ci.yml', 'utf8')).replaceAll('\r\n', '\n');
  for (const name of ['Windows x64 scaffold', 'Windows x64 tests', 'Windows x64 native AddressSanitizer']) expect(workflow.split(`name: ${name}\n`)).toHaveLength(2);
  for (const mode of ['development', 'packaged']) {
    expect(workflow).toContain(`-Mode ${mode}\n`);
    for (const scenario of ['telemetry', 'overlay', 'lifecycle', 'plugin', 'recording', 'journal', 'hard-mode', 'refusal']) expect(workflow).toContain(`-Mode ${mode} -Scenario ${scenario}`);
    for (const shard of ['shell', 'live', 'journal', 'settings', 'overlay']) expect(workflow).toContain(`-Mode ${mode} -Scenario ui -UiCase ${shard}`);
  }
  expect(workflow).toContain('if: always() && (github.event_name');
  expect(workflow).toContain('needs: [windows-build, windows-runtime, windows-installer, windows-tests, windows-asan]');
  const consumer = workflow.split('  windows-runtime:')[1].split('  windows:')[0];
  expect(consumer.match(/compiled-artifact.mjs restore/g)).toHaveLength(2);
  expect(consumer).not.toMatch(/npm run (?:build|package|make)|cmake --build/);
  // ET-055 PR-8 raised windows-installer's ceiling from 20 to 55 minutes for its third scenario (update-from-feed); every
  // other job keeps 20.
  expect(workflow.match(/timeout-minutes: 20/g)).toHaveLength(5);
  expect(workflow.split('  windows-installer:')[1].split(/\n {2}[a-z-]+:\n/)[0]).toContain('\n    timeout-minutes: 55\n');
});

// One case per installer value and helper variant (ET-019, October 28, 2026): the variants used to share one case, which
// timed out under load; each builds its own producer, so the split changes no scene or assertion.
it.each([false, true].flatMap(installer => (['missing', 'renamed'] as const).map(variant => [installer, variant] as const)))(
  'requires the literal nested helper at create and restore despite valid decoy files (installer=%s, %s)', async (installer, variant) => {
  const temp = await temporaryResources();
  try {
    const root = path.join(temp.directory, variant, 'producer'), input = path.join(temp.directory, variant, 'sealed');
    const output = path.join(temp.directory, variant, 'refused-publication'), target = path.join(temp.directory, variant, 'consumer');
    await writeFixture(root, installer); await createCompiledArtifact(root, input, source, checkout, installer, 'production');
    const manifestFile = path.join(input, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {files: {path: string; bytes: number; sha256: string}[]};
    expect(manifest.files.find(entry => entry.path === 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe')).toEqual({path: HOST, bytes: HOST_BYTES.length, sha256: HOST_HASH});
    const baseline = path.join(temp.directory, variant, 'baseline-consumer');
    await restoreCompiledArtifact(input, baseline, source, checkout, installer);
    const exactHost = await readFile(path.join(baseline, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'));
    expect(exactHost).toEqual(HOST_BYTES); expect(createHash('sha256').update(exactHost).digest('hex')).toBe(HOST_HASH);
    await rm(path.join(root, HOST)); await writeFile(path.join(root, HOST_ROOT, 'decoy.exe'), 'decoy');
    if (variant === 'renamed') await writeFile(path.join(root, HOST_ROOT, 'renamed.exe'), HOST_BYTES);
    await expect(createCompiledArtifact(root, output, source, checkout, installer, 'production')).rejects.toThrow();
    expect(await lstat(output).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;})).toBeUndefined();
    await rm(path.join(input, 'payload', HOST));
    const decoy = {path: `${HOST_ROOT}/decoy.exe`, bytes: 5, sha256: createHash('sha256').update('decoy').digest('hex')};
    await writeFile(path.join(input, 'payload', decoy.path), 'decoy');
    if (variant === 'renamed') {
      manifest.files.find(entry => entry.path === HOST)!.path = `${HOST_ROOT}/renamed.exe`;
      await writeFile(path.join(input, 'payload', HOST_ROOT, 'renamed.exe'), HOST_BYTES);
    } else manifest.files = manifest.files.filter(entry => entry.path !== HOST);
    manifest.files.push(decoy); await writeFile(manifestFile, JSON.stringify(manifest));
    await mkdir(target); await writeFile(path.join(target, 'sentinel.txt'), 'untouched');
    await expect(restoreCompiledArtifact(input, target, source, checkout, installer)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    expect(await readdir(target)).toEqual(['sentinel.txt']); expect(await readFile(path.join(target, 'sentinel.txt'), 'utf8')).toBe('untouched');
  } finally {await temp.dispose();}
}, NESTED_HELPER_FS_BUDGET_MS);
// One case per omitted root (ET-019, October 28, 2026): the sweep sealed and broke one producer per root in one case,
// 4,665 file requests with the maker root, and timed out at the default 5 s in a full npm test under load. Each case
// seals the complete producer, checks its one omitted root against it and seals again over the changed artifact, as each
// round of the sweep did; the roots and every assertion are unchanged.
const MISSING_ROOT_CASES = [false, true].flatMap(installer => [...COMPILED_ROOTS, ...(installer ? ['out/make/squirrel.windows/x64'] : [])]
  .map(omitted => [installer, omitted] as const));
it.each(MISSING_ROOT_CASES)('refuses a missing required root, including installer maker, before publication or destination mutation (installer=%s, %s)', async (installer, omitted) => {
  const temp = await temporaryResources();
  try {
    const root = path.join(temp.directory, 'producer'), input = path.join(temp.directory, 'sealed'), target = path.join(temp.directory, 'consumer');
    await writeFixture(root, installer); await createCompiledArtifact(root, input, source, checkout, installer, 'production');
    await mkdir(target); await writeFile(path.join(target, 'sentinel.txt'), 'untouched');
    const incomplete = path.join(temp.directory, 'producer-incomplete'), output = path.join(temp.directory, 'publication');
    await writeFixture(incomplete, installer, omitted);
    await expect(createCompiledArtifact(incomplete, output, source, checkout, installer, 'production'), omitted).rejects.toThrow();
    expect(await lstat(output).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;})).toBeUndefined();
    const manifestFile = path.join(input, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {files: {path: string}[]};
    manifest.files = manifest.files.filter(entry => entry.path !== omitted && !entry.path.startsWith(`${omitted}/`));
    const removed = path.resolve(input, 'payload', omitted);
    expect(removed.startsWith(path.resolve(temp.directory) + path.sep)).toBe(true);
    await rm(removed, {recursive: true, force: true}); await writeFile(manifestFile, JSON.stringify(manifest));
    await expect(restoreCompiledArtifact(input, target, source, checkout, installer), omitted).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    expect(await readdir(target)).toEqual(['sentinel.txt']); expect(await readFile(path.join(target, 'sentinel.txt'), 'utf8')).toBe('untouched');
    await createCompiledArtifact(root, input, source, checkout, installer, 'production');
  } finally {await temp.dispose();}
}, MISSING_ROOT_FS_BUDGET_MS);

// ET-055 PR-4: a staging build seals its own package folder, the manifest records the channel, and a restore accepts the
// roots of that channel only: a production package folder never passes in a staging artifact, and an unknown channel fails.
it('seals and restores the package folder of the build channel only', async () => {
  const temp = await temporaryResources();
  const root = path.join(temp.directory, 'producer'), input = path.join(temp.directory, 'sealed'), target = path.join(temp.directory, 'consumer');
  const staging = compiledRoots('staging');
  try {
    expect(staging).toContain('out/ETS2Telemetry Desktop Staging-win32-x64');
    expect(COMPILED_ROOTS).toContain('out/ETS2Telemetry Desktop-win32-x64');
    expect(staging.filter(base => !COMPILED_ROOTS.includes(base))).toEqual(['out/ETS2Telemetry Desktop Staging-win32-x64']);
    expect(() => compiledRoots('beta' as 'staging')).toThrow('COMPILED_ARTIFACT_INVALID');
    await writeFixture(root, false, undefined, staging);
    // A staging producer has no production package folder: sealing it as production fails before publication.
    await expect(createCompiledArtifact(root, path.join(temp.directory, 'as-production'), source, checkout, false, 'production')).rejects.toThrow();
    await createCompiledArtifact(root, input, source, checkout, false, 'staging');
    const manifestFile = path.join(input, 'manifest.json'), original = await readFile(manifestFile, 'utf8');
    expect((JSON.parse(original) as {channel: string}).channel).toBe('staging');
    for (const channel of ['production', 'beta', undefined]) {
      await writeFile(manifestFile, JSON.stringify({...JSON.parse(original) as object, channel}));
      await expect(restoreCompiledArtifact(input, target, source, checkout, false), String(channel)).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
    }
    await writeFile(manifestFile, original);
    expect((await restoreCompiledArtifact(input, target, source, checkout, false)).channel).toBe('staging');
    expect(await readFile(path.join(target, 'out/ETS2Telemetry Desktop Staging-win32-x64/fixture.exe'), 'utf8')).toBe('compiled out/ETS2Telemetry Desktop Staging-win32-x64');
  } finally {await temp.dispose();}
}, CHANNEL_CASE_FS_BUDGET_MS);
