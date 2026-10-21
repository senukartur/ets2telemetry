import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {expect, it} from 'vitest';
import {mkdir, readFile, writeFile, rm, symlink, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {COMPILED_ROOTS, createCompiledArtifact, restoreCompiledArtifact} from '../../scripts/ci/compiled-artifact.mjs';
import {scaffoldGate} from '../../scripts/ci/scaffold-gate.mjs';
const source = 'a'.repeat(40), checkout = 'b'.repeat(40);
const HOST_ROOT = 'native/telemetry-plugin/build/cap0-host/Release';
const HOST = 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe';
const BINDING = 'node_modules/better-sqlite3/prebuilds/win32-x64.node';
const MAKER = 'out/make/squirrel.windows/x64';
const HOST_BYTES = Buffer.from('compiled nested CAP0 host fixture');
const HOST_HASH = 'fea6030bb5e81d9f665e74cf9db624325d03f05073506e9dd0b19a3bf590e130';
async function writeFixture(root: string, installer = false, omit?: string) {
  for (const base of [...COMPILED_ROOTS, ...(installer ? [MAKER] : [])]) {
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
    await createCompiledArtifact(root, input, source, checkout, false);
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
});

it('uses the actual aggregate CLI exit status for success, failed, cancelled, skipped and missing dependencies', () => {
  const needs = Object.fromEntries(['windows-build', 'windows-runtime', 'windows-installer', 'windows-tests', 'windows-asan'].map(name => [name, {result: 'success'}]));
  const run = (value: unknown, event = 'push') => spawnSync(process.execPath, ['scripts/ci/scaffold-gate.mjs'], {encoding: 'utf8', windowsHide: true, env: {...process.env, GITHUB_EVENT_NAME: event, ETS2TELEMETRY_JOB_RESULTS: JSON.stringify(value)}}).status;
  expect(run(needs)).toBe(0);
  for (const result of ['failure', 'cancelled', 'skipped']) expect(run({...needs, 'windows-runtime': {result}})).toBe(1);
  const missing = {...needs}; delete missing['windows-build']; expect(run(missing)).toBe(1);
  expect(run({...needs, 'windows-installer': {result: 'skipped'}}, 'pull_request')).toBe(0);
});

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
  expect(workflow.match(/timeout-minutes: 20/g)).toHaveLength(6);
});

it.each([false, true])('requires the literal nested helper at create and restore despite valid decoy files (installer=%s)', async installer => {
  const temp = await temporaryResources();
  try {
    for (const variant of ['missing', 'renamed']) {
      const root = path.join(temp.directory, variant, 'producer'), input = path.join(temp.directory, variant, 'sealed');
      const output = path.join(temp.directory, variant, 'refused-publication'), target = path.join(temp.directory, variant, 'consumer');
      await writeFixture(root, installer); await createCompiledArtifact(root, input, source, checkout, installer);
      const manifestFile = path.join(input, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {files: {path: string; bytes: number; sha256: string}[]};
      expect(manifest.files.find(entry => entry.path === 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe')).toEqual({path: HOST, bytes: HOST_BYTES.length, sha256: HOST_HASH});
      const baseline = path.join(temp.directory, variant, 'baseline-consumer');
      await restoreCompiledArtifact(input, baseline, source, checkout, installer);
      const exactHost = await readFile(path.join(baseline, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'));
      expect(exactHost).toEqual(HOST_BYTES); expect(createHash('sha256').update(exactHost).digest('hex')).toBe(HOST_HASH);
      await rm(path.join(root, HOST)); await writeFile(path.join(root, HOST_ROOT, 'decoy.exe'), 'decoy');
      if (variant === 'renamed') await writeFile(path.join(root, HOST_ROOT, 'renamed.exe'), HOST_BYTES);
      await expect(createCompiledArtifact(root, output, source, checkout, installer)).rejects.toThrow();
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
    }
  } finally {await temp.dispose();}
});
it.each([false, true])('refuses every missing required root, including installer maker, before publication or destination mutation (installer=%s)', async installer => {
  const temp = await temporaryResources(), roots = [...COMPILED_ROOTS, ...(installer ? ['out/make/squirrel.windows/x64'] : [])];
  try {
    const root = path.join(temp.directory, 'producer'), input = path.join(temp.directory, 'sealed'), target = path.join(temp.directory, 'consumer');
    await writeFixture(root, installer); await createCompiledArtifact(root, input, source, checkout, installer);
    await mkdir(target); await writeFile(path.join(target, 'sentinel.txt'), 'untouched');
    for (const [index, omitted] of roots.entries()) {
      const incomplete = path.join(temp.directory, `producer-${index}`), output = path.join(temp.directory, `publication-${index}`);
      await writeFixture(incomplete, installer, omitted);
      await expect(createCompiledArtifact(incomplete, output, source, checkout, installer), omitted).rejects.toThrow();
      expect(await lstat(output).catch(error => {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;})).toBeUndefined();
      const manifestFile = path.join(input, 'manifest.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {files: {path: string}[]};
      manifest.files = manifest.files.filter(entry => entry.path !== omitted && !entry.path.startsWith(`${omitted}/`));
      const removed = path.resolve(input, 'payload', omitted);
      expect(removed.startsWith(path.resolve(temp.directory) + path.sep)).toBe(true);
      await rm(removed, {recursive: true, force: true}); await writeFile(manifestFile, JSON.stringify(manifest));
      await expect(restoreCompiledArtifact(input, target, source, checkout, installer), omitted).rejects.toThrow('COMPILED_ARTIFACT_INVALID');
      expect(await readdir(target)).toEqual(['sentinel.txt']); expect(await readFile(path.join(target, 'sentinel.txt'), 'utf8')).toBe('untouched');
      await createCompiledArtifact(root, input, source, checkout, installer);
    }
  } finally {await temp.dispose();}
});
