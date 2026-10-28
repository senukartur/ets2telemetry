import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BUILD_CHANNEL_VARIABLE, BUILD_IDENTITIES, buildNames, buildSetupFileName, DEFAULT_BUILD_CHANNEL, DESKTOP_BUILD_EVIDENCE, OWNER_PRODUCTION_BUILD_VARIABLE,
  packageDirectoryName, productionBuildAllowed, readBuiltBuild, resolveBuild, resolveBuildChannel, resolveBuildVersion, STAGING_RUN_NUMBER_VARIABLE}
  from '../../scripts/build-channel.mjs';
import {nugetVersion} from '../../scripts/release-identity.mjs';

// ET-055 UP13 and UP15 (REG-017): scripts/build-channel.mjs is the only resolver of the build channel and the build version.
// Agent and feature-test builds are staging (ET-055 PR-4): an unset variable builds staging, exactly `staging` is always
// accepted, exactly `production` only in GitHub Actions or with the owner-only override, and anything else fails. A staging
// version carries the 6-digit staging run number, which NuGet keeps in a sortable form.

const env = (values: Record<string, string>) => values;
const PRODUCTION_REFUSED = /A production build runs only on a GitHub-hosted Actions runner or with the owner-only ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1/;
let root: string | undefined;
afterEach(() => {if (root) rmSync(root, {recursive: true, force: true}); root = undefined;});
function checkout(version: string) {
  root = mkdtempSync(path.join(tmpdir(), 'ets2telemetry-build-channel-'));
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({name: 'fixture', version})}\n`);
  return root;
}

describe('the build channel', () => {
  it('builds staging while the variable is unset, also in GitHub Actions and with the owner override', () => {
    expect(DEFAULT_BUILD_CHANNEL).toBe('staging');
    expect(resolveBuildChannel(env({}))).toBe('staging');
    expect(resolveBuildChannel(env({GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}))).toBe('staging');
    expect(resolveBuildChannel(env({[OWNER_PRODUCTION_BUILD_VARIABLE]: '1'}))).toBe('staging');
  });

  it('accepts exactly staging anywhere', () => {
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'staging'}))).toBe('staging');
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'staging', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}))).toBe('staging');
  });

  it('refuses production outside a GitHub-hosted runner without the owner override', () => {
    expect(OWNER_PRODUCTION_BUILD_VARIABLE).toBe('ETS2TELEMETRY_OWNER_PRODUCTION_BUILD');
    expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production'}))).toThrow(PRODUCTION_REFUSED);
    expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production'}))).toThrow(/Agent and feature-test builds are staging: unset ETS2TELEMETRY_BUILD_CHANNEL/);
    // Only the exact values open production: a GitHub-hosted runner sets GITHUB_ACTIONS to `true` and RUNNER_ENVIRONMENT to
    // `github-hosted`, and the override is exactly `1`. GitHub Actions alone, such as a self-hosted runner, is not enough.
    for (const near of [{GITHUB_ACTIONS: 'true'}, {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'}, {RUNNER_ENVIRONMENT: 'github-hosted'},
      {GITHUB_ACTIONS: 'TRUE', RUNNER_ENVIRONMENT: 'github-hosted'}, {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'GitHub-hosted'}, {GITHUB_ACTIONS: '1'}, {GITHUB_ACTIONS: ''}, {[OWNER_PRODUCTION_BUILD_VARIABLE]: 'true'},
      {[OWNER_PRODUCTION_BUILD_VARIABLE]: ' 1'}, {[OWNER_PRODUCTION_BUILD_VARIABLE]: '0'}, {[OWNER_PRODUCTION_BUILD_VARIABLE]: ''}, {CI: 'true'}] as Record<string, string>[]) {
      expect(productionBuildAllowed(env(near))).toBe(false);
      expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production', ...near}))).toThrow(PRODUCTION_REFUSED);
    }
  });

  it('accepts production on a GitHub-hosted runner and with the owner-only override', () => {
    expect(productionBuildAllowed(env({GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}))).toBe(true);
    expect(productionBuildAllowed(env({[OWNER_PRODUCTION_BUILD_VARIABLE]: '1'}))).toBe(true);
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}))).toBe('production');
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production', [OWNER_PRODUCTION_BUILD_VARIABLE]: '1'}))).toBe('production');
  });

  it.each(['', 'Staging', 'PRODUCTION', ' staging', 'staging ', 'stage', 'prod', 'test', 'production,staging'])('refuses %j, also in GitHub Actions', value => {
    expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: value}))).toThrow(/must be exactly production or staging/);
    expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: value, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', [OWNER_PRODUCTION_BUILD_VARIABLE]: '1'})))
      .toThrow(/must be exactly production or staging/);
  });
});

describe('the build version', () => {
  it('is the package.json version in production, whatever the staging run number says', () => {
    expect(resolveBuildVersion('production', '0.1.1', env({}))).toBe('0.1.1');
    expect(resolveBuildVersion('production', '0.2.0-beta.1', env({[STAGING_RUN_NUMBER_VARIABLE]: '42'}))).toBe('0.2.0-beta.1');
    expect(() => resolveBuildVersion('production', '0.1', env({}))).toThrow(/not a release version/);
  });

  it('appends the zero-padded staging run number in staging, -stg.000000 without one', () => {
    expect(resolveBuildVersion('staging', '0.2.0', env({}))).toBe('0.2.0-stg.000000');
    expect(resolveBuildVersion('staging', '0.2.0', env({[STAGING_RUN_NUMBER_VARIABLE]: '42'}))).toBe('0.2.0-stg.000042');
    expect(resolveBuildVersion('staging', '0.2.0', env({[STAGING_RUN_NUMBER_VARIABLE]: '999999'}))).toBe('0.2.0-stg.999999');
    expect(resolveBuildVersion('staging', '1.10.3', env({[STAGING_RUN_NUMBER_VARIABLE]: '000007'}))).toBe('1.10.3-stg.000007');
  });

  it.each(['', '-1', '1000000', '4.2', '42a', ' 42', '0x10'])('refuses the staging run number %j', run => {
    expect(() => resolveBuildVersion('staging', '0.2.0', env({[STAGING_RUN_NUMBER_VARIABLE]: run}))).toThrow(/must be 1 to 6 digits/);
  });

  it('needs a plain x.y.z base for staging', () => {
    expect(() => resolveBuildVersion('staging', '0.2.0-beta.1', env({}))).toThrow(/plain x\.y\.z/);
  });

  it('gives NuGet-safe versions that sort by the run number', () => {
    const versions = ['000009', '000010', '000042', '001000'].map(run => nugetVersion(resolveBuildVersion('staging', '0.2.0', env({[STAGING_RUN_NUMBER_VARIABLE]: run}))));
    expect(versions).toEqual(['0.2.0-stg000009', '0.2.0-stg000010', '0.2.0-stg000042', '0.2.0-stg001000']);
    expect([...versions].sort()).toEqual(versions);
    for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+-stg\d{6}$/);
  });
});

describe('the resolved build', () => {
  it('reads the base version from the checkout and selects the channel identity', () => {
    const fixture = checkout('0.3.0');
    expect(resolveBuild({env: env({}), root: fixture})).toEqual({channel: 'staging', identity: BUILD_IDENTITIES.staging, baseVersion: '0.3.0', version: '0.3.0-stg.000000'});
    expect(resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'production', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}), root: fixture}))
      .toEqual({channel: 'production', identity: BUILD_IDENTITIES.production, baseVersion: '0.3.0', version: '0.3.0'});
    expect(resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'staging', [STAGING_RUN_NUMBER_VARIABLE]: '7'}), root: fixture}))
      .toEqual({channel: 'staging', identity: BUILD_IDENTITIES.staging, baseVersion: '0.3.0', version: '0.3.0-stg.000007'});
    expect(() => resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'production'}), root: fixture})).toThrow(PRODUCTION_REFUSED);
    expect(() => resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'beta'}), root: fixture})).toThrow(/must be exactly/);
  });

  it('names the Setup file of each channel', () => {
    expect(buildSetupFileName(BUILD_IDENTITIES.production, '0.1.1')).toBe('YukonUnionTelemetry-Setup-0.1.1.exe');
    expect(buildSetupFileName(BUILD_IDENTITIES.staging, '0.2.0-stg.000042')).toBe('YukonUnionTelemetry-Staging-Setup-0.2.0-stg.000042.exe');
  });

  it('resolves the default in the Vitest environment, whatever the shell set (tests/shared/build-channel-environment.ts)', () => {
    expect(process.env[BUILD_CHANNEL_VARIABLE]).toBeUndefined();
    expect(process.env[OWNER_PRODUCTION_BUILD_VARIABLE]).toBeUndefined();
    expect(process.env[STAGING_RUN_NUMBER_VARIABLE]).toBeUndefined();
    expect(resolveBuildChannel()).toBe('staging');
  });
});

describe('the build a checkout was made for', () => {
  function built(evidence: unknown) {
    const fixture = checkout('0.3.0');
    mkdirSync(path.join(fixture, path.dirname(DESKTOP_BUILD_EVIDENCE)), {recursive: true});
    writeFileSync(path.join(fixture, DESKTOP_BUILD_EVIDENCE), JSON.stringify(evidence));
    return fixture;
  }

  it('comes from the desktop build evidence, never from the environment', () => {
    expect(readBuiltBuild(built({channel: 'production', version: '0.3.0', sources: {}}))).toEqual({channel: 'production', identity: BUILD_IDENTITIES.production, version: '0.3.0'});
    rmSync(root!, {recursive: true, force: true});
    expect(readBuiltBuild(built({channel: 'staging', version: '0.3.0-stg.000042'}))).toEqual({channel: 'staging', identity: BUILD_IDENTITIES.staging, version: '0.3.0-stg.000042'});
  });

  it.each([{}, {channel: 'beta', version: '0.3.0'}, {channel: 'staging'}, {channel: 'staging', version: '0.3'}, null])('refuses the evidence %j', evidence => {
    expect(() => readBuiltBuild(built(evidence))).toThrow(/names no (known build channel|build version)/);
  });

  it('refuses a checkout without build evidence', () => {
    expect(() => readBuiltBuild(checkout('0.3.0'))).toThrow(/ENOENT/);
  });

  it('names the package, executable, Setup, data root and plugin of each channel', () => {
    expect(packageDirectoryName(BUILD_IDENTITIES.production)).toBe('out/ETS2Telemetry Desktop-win32-x64');
    expect(buildNames({channel: 'staging', identity: BUILD_IDENTITIES.staging, version: '0.3.0-stg.000042'})).toEqual({channel: 'staging', version: '0.3.0-stg.000042',
      packageDirectory: 'out/ETS2Telemetry Desktop Staging-win32-x64', executable: 'ETS2TelemetryDesktopStaging.exe', setup: 'YukonUnionTelemetry-Staging-Setup-0.3.0-stg.000042.exe',
      plugin: 'ets2telemetry-plugin-staging.dll', squirrelId: 'ETS2TelemetryDesktopStaging', productName: 'ETS2Telemetry Desktop Staging', displayName: 'Yukon Union Telemetry Staging',
      dataRootName: 'ETS2TelemetryStaging', pipePrefix: '\\\\.\\pipe\\ETS2TelemetryStaging-', runOnceValue: 'ETS2TelemetryStagingUninstall',
      receiptPrefix: 'ETS2TelemetryStaging-uninstall-', legacyShortcutNames: []});
    expect(buildNames({channel: 'production', identity: BUILD_IDENTITIES.production, version: '0.1.1'})).toMatchObject({packageDirectory: 'out/ETS2Telemetry Desktop-win32-x64',
      executable: 'ETS2TelemetryDesktop.exe', setup: 'YukonUnionTelemetry-Setup-0.1.1.exe', plugin: 'ets2telemetry-plugin.dll', dataRootName: 'ETS2Telemetry',
      legacyShortcutNames: ['ETS2Telemetry Desktop']});
  });
});
