import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, realpath, rm, utimes, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {BUILD_IDENTITIES, buildNames} from '../../scripts/build-channel.mjs';
import {checkSideBySideInput, INPUT_FILE, INPUT_FORMAT, verifySideBySideInput} from '../../scripts/installer/side-by-side-input.mjs';
import {temporaryResources} from '../shared/resources';

// ET-055 PR-5 (REG-017, REG-019): the side-by-side installer lifecycle's inputs and the driver's channel handling. No
// installer runs: the staging input is a fixture folder with stand-in Setup bytes, and the driver commands here are the
// run signal, the versions plan and the config check, which never start a process.
const CHECKOUT = 'b'.repeat(40), SOURCE = 'a'.repeat(40);
const names = buildNames({channel: 'staging', identity: BUILD_IDENTITIES.staging, version: '0.1.0-stg.000000'});
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const record = (bytes: Buffer, changes: Record<string, unknown> = {}) => ({format: INPUT_FORMAT, version: 1, source: SOURCE, checkout: CHECKOUT, build: names,
  setup: {name: names.setup, sha256: sha256(bytes), bytes: bytes.length}, ...changes});

describe('staging input of the side-by-side scenario', () => {
  const bytes = Buffer.from('stand-in staging Setup bytes');
  it('accepts a staging build of this checkout and names its Setup', () => {
    expect(names.setup).toBe('YukonUnionTelemetry-Staging-Setup-0.1.0-stg.000000.exe');
    expect(checkSideBySideInput(record(bytes), CHECKOUT).build.channel).toBe('staging');
  });
  it.each([
    ['another checkout', {checkout: 'c'.repeat(40)}, 'SIDE_BY_SIDE_INPUT_OTHER_CHECKOUT'],
    ['a production build', {build: buildNames({channel: 'production', identity: BUILD_IDENTITIES.production, version: '0.1.0'})}, 'SIDE_BY_SIDE_INPUT_NOT_STAGING'],
    ['another format', {format: 'other'}, 'SIDE_BY_SIDE_INPUT_INVALID'],
    ['an unexpected key', {extra: true}, 'SIDE_BY_SIDE_INPUT_INVALID'],
    ['a Setup of another name', {setup: {name: 'Setup.exe', sha256: 'a'.repeat(64), bytes: 1}}, 'SIDE_BY_SIDE_INPUT_SETUP_NAME'],
    ['a Setup without a hash', {setup: {name: names.setup, sha256: 'x', bytes: 1}}, 'SIDE_BY_SIDE_INPUT_SETUP_HASH'],
    ['a source of another form', {source: 'main'}, 'SIDE_BY_SIDE_INPUT_COMMIT']
  ])('refuses %s', (_name, changes, message) => expect(() => checkSideBySideInput(record(bytes, changes), CHECKOUT)).toThrow(message));
  it('reads the folder back only with exactly the record and the recorded Setup bytes', async () => {
    const resources = await temporaryResources();
    try {
      const folder = path.join(resources.directory, 'staging-input');
      await mkdir(folder);
      await writeFile(path.join(folder, names.setup), bytes);
      await writeFile(path.join(folder, INPUT_FILE), JSON.stringify(record(bytes)));
      expect(verifySideBySideInput(folder, CHECKOUT)).toMatchObject({setupPath: path.resolve(folder, names.setup), setup: {sha256: sha256(bytes)}});
      await writeFile(path.join(folder, names.setup), Buffer.from('changed bytes of the same staging Setup'));
      expect(() => verifySideBySideInput(folder, CHECKOUT)).toThrow('SIDE_BY_SIDE_INPUT_SETUP_CHANGED');
      await writeFile(path.join(folder, names.setup), bytes);
      await writeFile(path.join(folder, 'extra.exe'), 'extra');
      expect(() => verifySideBySideInput(folder, CHECKOUT)).toThrow('SIDE_BY_SIDE_INPUT_FOLDER_UNEXPECTED');
    } finally {await resources.dispose();}
  });
});

describe('driver channels (ET-055 PR-5)', () => {
  const driver = path.resolve('scripts/installer/installer-lifecycle.mjs');
  // A local shell: no GitHub-hosted runner signal, and no inherited one.
  const local = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT'].includes(key.toUpperCase())));
  const hosted = {...local, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'};
  const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{passed: boolean; failure: {code?: string; message?: string} | null; plan?: unknown}>((resolve, reject) => {
    execFile(process.execPath, [driver, ...args], {env, encoding: 'utf8', timeout: 30000, windowsHide: true}, (_error, stdout) => {
      try {resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1)!) as {passed: boolean; failure: {code?: string} | null});} catch {reject(new Error('DRIVER_OUTPUT_INVALID'));}
    });
  });
  it('accepts a local staging run only with -AllowLocal and both channels only on a hosted runner', async () => {
    expect(await run(['signal', '--channel', 'staging', '--allow-local'], local)).toMatchObject({passed: true});
    expect(await run(['signal', '--channel', 'staging'], local)).toMatchObject({passed: false, failure: {code: 'LOCAL_RUN_REFUSED'}});
    expect(await run(['signal', '--channel', 'production', '--channel', 'staging', '--allow-local'], local)).toMatchObject({passed: false, failure: {code: 'LOCAL_PRODUCTION_REFUSED'}});
    expect(await run(['signal', '--channel', 'production', '--channel', 'staging'], hosted)).toMatchObject({passed: true});
    expect(await run(['signal', '--channel', 'staging', '--channel', 'staging'], hosted)).toMatchObject({passed: false, failure: {code: 'RUN_CHANNELS_INVALID'}});
    expect(await run(['signal'], hosted)).toMatchObject({passed: false, failure: {code: 'SETUP_CHANNEL_UNKNOWN'}});
  }, 60000);
  it('prints the run\'s versions and both channels\' identities', async () => {
    const result = await run(['versions', 'staging', '0.1.0-stg.000000'], local) as {passed: boolean; plan: {versions: {b: {installed: string}}; fixtureC: {installed: string}; identities: {channel: string}[]}};
    expect(result.passed).toBe(true);
    expect(result.plan.versions.b.installed).toBe('0.1.1-stg000000');
    // ET-055 PR-8: the update-from-feed scenario's third version.
    expect(result.plan.fixtureC.installed).toBe('0.1.2-stg000000');
    expect(result.plan.identities.map(identity => identity.channel)).toEqual(['production', 'staging']);
    expect(await run(['versions', 'production', '0.1.0-stg.000000'], local)).toMatchObject({passed: false, failure: {code: 'LIFECYCLE_VERSION_INVALID'}});
  }, 30000);
  it('refuses a config whose channel, peer or profile does not fit the run', async () => {
    const resources = await temporaryResources();
    try {
      const evidence = path.join(resources.directory, `installer-${'0'.repeat(32)}-evidence`), runRoot = path.join(resources.directory, `installer-${'0'.repeat(32)}`);
      await mkdir(evidence);
      const base = {runRoot, evidence, setup: path.join(resources.directory, 'Setup.exe'), stepBudgetMs: 1000, channel: 'staging', channels: ['production', 'staging'],
        appVersion: '0.1.0-stg.000000', peers: {production: path.join(evidence, 'config-production.json')}, profileDir: path.join(runRoot, 'profile-staging')};
      const check = async (changes: Record<string, unknown>) => {
        const file = path.join(evidence, 'config-staging.json');
        await writeFile(file, JSON.stringify({...base, ...changes}));
        return run(['residue', file, 'missing'], local);
      };
      // A valid config passes its check and then fails on the missing listing, not on the config.
      expect((await check({})).failure?.message).not.toMatch(/CONFIG_/);
      expect(await check({channel: 'beta'})).toMatchObject({passed: false, failure: {message: expect.stringContaining('CONFIG_CHANNEL_INVALID')}});
      expect(await check({channels: ['production']})).toMatchObject({passed: false, failure: {message: expect.stringContaining('CONFIG_CHANNEL_INVALID')}});
      expect(await check({appVersion: '0.1.0'})).toMatchObject({passed: false, failure: {code: 'LIFECYCLE_VERSION_INVALID'}});
      expect(await check({peers: {staging: path.join(evidence, 'config-staging.json')}})).toMatchObject({passed: false, failure: {message: expect.stringContaining('CONFIG_PEER_INVALID')}});
      expect(await check({peers: {production: path.join(resources.directory, 'config-production.json')}}))
        .toMatchObject({passed: false, failure: {message: expect.stringContaining('CONFIG_PEER_INVALID')}});
      expect(await check({profileDir: path.join(resources.directory, 'profile')})).toMatchObject({passed: false, failure: {message: expect.stringContaining('CONFIG_PROFILE_INVALID')}});
      expect(JSON.parse(await readFile(path.join(evidence, 'residue-missing.json'), 'utf8'))).toMatchObject({command: 'residue', passed: false});
    } finally {await resources.dispose();}
  }, 60000);
  // The staging data root across production's uninstall: a sentinel and the top-level entries must stay, and the check
  // removes the sentinel again so the channel's own later uninstall sees its data root as before.
  it('plants and checks the sentinel of the other channel\'s data root, and names what changed', async () => {
    const resources = await temporaryResources();
    try {
      const base = await realpath(resources.directory), id = '1'.repeat(32);
      const runRoot = path.join(base, `installer-${id}`), evidence = path.join(base, `installer-${id}-evidence`);
      const dataRoot = path.join(runRoot, 'LocalAppData', 'ETS2TelemetryStaging');
      await mkdir(path.join(dataRoot, 'plugins'), {recursive: true});
      await mkdir(path.join(dataRoot, 'logs'));
      await mkdir(evidence);
      const config = path.join(evidence, 'config-staging.json');
      await writeFile(config, JSON.stringify({runRoot, evidence, setup: path.join(base, 'Setup.exe'), stepBudgetMs: 1000, channel: 'staging', channels: ['production', 'staging'],
        appVersion: '0.1.0-stg.000000', peers: {production: path.join(evidence, 'config-production.json')}, profileDir: path.join(runRoot, 'profile-staging')}));
      const sentinel = (...args: string[]) => run(['sentinel', config, ...args], local);
      expect(await sentinel('before-a', 'plant')).toMatchObject({passed: true});
      expect((await readdir(dataRoot)).sort()).toEqual(['captures', 'logs', 'plugins']);
      expect(await sentinel('after-a', 'check', 'before-a')).toMatchObject({passed: true});
      // The check removed the sentinel and the folder the plant created.
      expect((await readdir(dataRoot)).sort()).toEqual(['logs', 'plugins']);
      expect(await sentinel('before-b', 'plant')).toMatchObject({passed: true});
      await writeFile(path.join(dataRoot, 'captures', 'installer-lifecycle-sentinel.txt'), 'changed');
      expect((await sentinel('after-b', 'check', 'before-b')).failure?.message).toMatch(/^OTHER_CHANNEL_DATA_CHANGED \(sentinel bytes changed\)/);
      await rm(path.join(dataRoot, 'captures'), {recursive: true});
      expect(await sentinel('before-c', 'plant')).toMatchObject({passed: true});
      await rm(path.join(dataRoot, 'plugins'), {recursive: true});
      expect((await sentinel('after-c', 'check', 'before-c')).failure?.message).toMatch(/^OTHER_CHANNEL_DATA_CHANGED \(entries removed: plugins\)/);
      await rm(dataRoot, {recursive: true});
      expect((await sentinel('after-d', 'check', 'before-c')).failure?.message).toMatch(/^OTHER_CHANNEL_DATA_CHANGED \(data root removed\)/);
      expect((await sentinel('after-e', 'check', 'after-e')).failure?.message).toContain('SENTINEL_MODE_INVALID');
    } finally {await resources.dispose();}
  }, 60000);
  // ET-055 PR-8 (PR-5 review): a wipe that empties an entry but keeps its folder; the plant samples one file per entry,
  // preferring one the application leaves alone, and never a SQLite sidecar, a rotating log or the transport entry.
  it('samples one file per entry of the other channel\'s data root and names a removed or changed one', async () => {
    const resources = await temporaryResources();
    try {
      const base = await realpath(resources.directory), id = '2'.repeat(32);
      const runRoot = path.join(base, `installer-${id}`), evidence = path.join(base, `installer-${id}-evidence`);
      const dataRoot = path.join(runRoot, 'LocalAppData', 'ETS2TelemetryStaging');
      const put = async (relative: string, text: string) => {await mkdir(path.dirname(path.join(dataRoot, relative)), {recursive: true}); await writeFile(path.join(dataRoot, relative), text);};
      await put('data\\telemetry.sqlite', 'database');
      await put('data\\telemetry.sqlite-wal', 'sidecar');
      await put('data\\backups\\telemetry-x.json', 'manifest');
      await put('plugins\\setup.json', '{}');
      await put('logs\\startup.jsonl', 'log');
      await put('transport\\v1\\service-policy.json', '{}');
      await mkdir(evidence);
      const config = path.join(evidence, 'config-staging.json');
      await writeFile(config, JSON.stringify({runRoot, evidence, setup: path.join(base, 'Setup.exe'), stepBudgetMs: 1000, channel: 'staging', channels: ['production', 'staging'],
        appVersion: '0.1.0-stg.000000', peers: {production: path.join(evidence, 'config-production.json')}, profileDir: path.join(runRoot, 'profile-staging')}));
      const sentinel = (...args: string[]) => run(['sentinel', config, ...args], local);
      const result = async (name: string) => JSON.parse(await readFile(path.join(evidence, `sentinel-${name}.json`), 'utf8')).result as {samples: Record<string, {file: string; kind: string; rewritten?: boolean} | null>};
      expect(await sentinel('before-a', 'plant')).toMatchObject({passed: true});
      expect(Object.fromEntries(Object.entries((await result('before-a')).samples).map(([entry, sample]) => [entry, sample && {file: sample.file, kind: sample.kind}]))).toEqual({
        data: {file: 'data\\backups\\telemetry-x.json', kind: 'untouched'}, logs: null, plugins: {file: 'plugins\\setup.json', kind: 'rewritable'}, transport: null});
      // The application beside rewrote a file: a new time and new bytes are accepted and reported.
      await new Promise(resolve => setTimeout(resolve, 20));
      await put('plugins\\setup.json', '{"rewritten":true}');
      expect(await sentinel('after-a', 'check', 'before-a')).toMatchObject({passed: true});
      expect((await result('after-a')).samples.plugins).toEqual({file: 'plugins\\setup.json', kind: 'rewritable', rewritten: true});
      // Same time, other bytes: changed. A whole second, so the time written back is exactly the planted one.
      const manifest = path.join(dataRoot, 'data', 'backups', 'telemetry-x.json'), time = new Date('2026-10-01T00:00:00.000Z');
      await utimes(manifest, time, time);
      expect(await sentinel('before-b', 'plant')).toMatchObject({passed: true});
      await writeFile(manifest, 'MANIFEST');
      await utimes(manifest, time, time);
      expect((await sentinel('after-b', 'check', 'before-b')).failure?.message).toMatch(/^OTHER_CHANNEL_DATA_CHANGED \(file bytes changed: data\\backups\\telemetry-x\.json\)/);
      // An emptied entry whose folder stays: removed.
      await rm(path.join(dataRoot, 'captures'), {recursive: true});
      expect(await sentinel('before-c', 'plant')).toMatchObject({passed: true});
      await rm(path.join(dataRoot, 'plugins', 'setup.json'));
      expect((await sentinel('after-c', 'check', 'before-c')).failure?.message).toMatch(/^OTHER_CHANNEL_DATA_CHANGED \(file removed: plugins\\setup\.json\)/);
    } finally {await resources.dispose();}
  }, 60000);
});
