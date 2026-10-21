import {spawnSync} from 'node:child_process';
import {expect, it} from 'vitest';
import {mkdir, readFile, writeFile, rm, symlink, readdir} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {COMPILED_ROOTS, createCompiledArtifact, restoreCompiledArtifact} from '../../scripts/ci/compiled-artifact.mjs';
import {scaffoldGate} from '../../scripts/ci/scaffold-gate.mjs';
const source = 'a'.repeat(40), checkout = 'b'.repeat(40);
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
    for (const base of COMPILED_ROOTS) {
      const file = base.endsWith('.node') ? base : `${base}/fixture.exe`;
      await mkdir(path.dirname(path.join(root, file)), {recursive: true}); await writeFile(path.join(root, file), `compiled ${base}`);
    }
    await createCompiledArtifact(root, input, source, checkout, false);
    await mkdir(path.dirname(path.join(target, COMPILED_ROOTS[6])), {recursive: true}); await writeFile(path.join(target, COMPILED_ROOTS[6]), 'different consumer binding');
    const restored = await restoreCompiledArtifact(input, target, source, checkout, false);
    expect(restored.files).toBe(COMPILED_ROOTS.length);
    expect(await readFile(path.join(target, COMPILED_ROOTS[6]))).toEqual(await readFile(path.join(root, COMPILED_ROOTS[6])));
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
