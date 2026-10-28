import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BUILD_CHANNEL_VARIABLE, BUILD_IDENTITIES, buildSetupFileName, DEFAULT_BUILD_CHANNEL, resolveBuild, resolveBuildChannel, resolveBuildVersion,
  STAGING_RUN_NUMBER_VARIABLE} from '../../scripts/build-channel.mjs';
import {nugetVersion} from '../../scripts/release-identity.mjs';

// ET-055 UP13 and UP15 (REG-017): scripts/build-channel.mjs is the only resolver of the build channel and the build version.
// Until ET-055 PR-4 an unset variable still builds production; exactly `production` or `staging` is accepted and anything
// else fails. A staging version carries the 6-digit staging run number, which NuGet keeps in a sortable form.

const env = (values: Record<string, string>) => values;
let root: string | undefined;
afterEach(() => {if (root) rmSync(root, {recursive: true, force: true}); root = undefined;});
function checkout(version: string) {
  root = mkdtempSync(path.join(tmpdir(), 'ets2telemetry-build-channel-'));
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({name: 'fixture', version})}\n`);
  return root;
}

describe('the build channel', () => {
  it('defaults to production while the variable is unset (ET-055 PR-4 flips the default)', () => {
    expect(DEFAULT_BUILD_CHANNEL).toBe('production');
    expect(resolveBuildChannel(env({}))).toBe('production');
  });

  it('accepts exactly production or staging', () => {
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'production'}))).toBe('production');
    expect(resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: 'staging'}))).toBe('staging');
  });

  it.each(['', 'Staging', 'PRODUCTION', ' staging', 'staging ', 'stage', 'prod', 'test', 'production,staging'])('refuses %j', value => {
    expect(() => resolveBuildChannel(env({[BUILD_CHANNEL_VARIABLE]: value}))).toThrow(/must be exactly production or staging/);
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
    expect(resolveBuild({env: env({}), root: fixture})).toEqual({channel: 'production', identity: BUILD_IDENTITIES.production, baseVersion: '0.3.0', version: '0.3.0'});
    expect(resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'staging', [STAGING_RUN_NUMBER_VARIABLE]: '7'}), root: fixture}))
      .toEqual({channel: 'staging', identity: BUILD_IDENTITIES.staging, baseVersion: '0.3.0', version: '0.3.0-stg.000007'});
    expect(() => resolveBuild({env: env({[BUILD_CHANNEL_VARIABLE]: 'beta'}), root: fixture})).toThrow(/must be exactly/);
  });

  it('names the Setup file of each channel', () => {
    expect(buildSetupFileName(BUILD_IDENTITIES.production, '0.1.1')).toBe('YukonUnionTelemetry-Setup-0.1.1.exe');
    expect(buildSetupFileName(BUILD_IDENTITIES.staging, '0.2.0-stg.000042')).toBe('YukonUnionTelemetry-Staging-Setup-0.2.0-stg.000042.exe');
  });
});
