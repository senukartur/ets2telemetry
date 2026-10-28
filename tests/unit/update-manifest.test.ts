import {describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES} from '../../apps/desktop/src/channel';
import {UPDATE_PUBLIC_KEYS} from '../../apps/desktop/src/updater/update-keys';
import {MANIFEST_MAX_BYTES, PACKAGE_MAX_BYTES, parseUpdateManifest, verifyUpdateManifest, type ManifestBinding} from '../../apps/desktop/src/updater/update-manifest';
import {compareNugetVersions, isChannelTag, nugetVersionOf, tagVersion} from '../../apps/desktop/src/updater/update-version';
import {manifestObject, packageBytes, signManifest, testKey} from '../shared/update-fixtures';

// ET-055 UP5 (REG-019, unit part): the signed update manifest. Keys are generated here; no private key is committed.
// Expected outcomes are written by hand from the plan's refusal list, not derived from the implementation.

const PKG = packageBytes(1024);
const KEY = testKey('owner-2026');
const production = (keys = [KEY.publicKey], currentVersion = '0.1.1', sourceTag?: string): ManifestBinding => ({identity: CHANNEL_IDENTITIES.production, keys, currentVersion, sourceTag});
const staging = (sourceTag: string | undefined, keys = [KEY.publicKey], currentVersion = '0.2.0-stg.000041'): ManifestBinding => ({identity: CHANNEL_IDENTITIES.staging, keys, currentVersion, sourceTag});
const verified = (manifest: Record<string, unknown>, binding: ManifestBinding, key = KEY) => {
  const signed = signManifest(manifest, key);
  return verifyUpdateManifest(signed.bytes, signed.signature, binding);
};

describe('versions and tags', () => {
  it('converts application versions to NuGet versions as electron-winstaller does', () => {
    expect(nugetVersionOf('0.2.0')).toBe('0.2.0');
    expect(nugetVersionOf('0.2.0-stg.000042')).toBe('0.2.0-stg000042');
    expect(nugetVersionOf('1.0.0-alpha.1')).toBe('1.0.0-alpha1');
  });
  it('orders NuGet versions by SemVer precedence, never by text', () => {
    const ordered = ['0.1.1', '0.2.0-stg000041', '0.2.0-stg000042', '0.2.0', '0.10.0', '1.0.0-alpha1', '1.0.0-alpha2', '1.0.0'];
    for (let index = 1; index < ordered.length; index++) expect(compareNugetVersions(ordered[index], ordered[index - 1]), ordered[index]).toBeGreaterThan(0);
    expect(compareNugetVersions('0.2.0-STG000042', '0.2.0-stg000042')).toBe(0);
    expect(compareNugetVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBeGreaterThan(0);
    expect(() => compareNugetVersions('0.2', '0.2.0')).toThrow();
  });
  it('accepts only the channel\'s own tag pattern', () => {
    expect(isChannelTag('staging', 'staging-v0.2.0-stg.000042')).toBe(true);
    for (const tag of ['v0.2.0', 'staging-v0.2.0', 'staging-v0.2.0-stg.42', 'staging-v0.2.0-stg.0000042', 'Staging-v0.2.0-stg.000042', 'staging-v0.2.0-stg.000042 '])
      expect(isChannelTag('staging', tag), tag).toBe(false);
    expect(isChannelTag('production', 'v0.2.0')).toBe(true);
    for (const tag of ['0.2.0', 'staging-v0.2.0-stg.000042', 'v0.2', 'release-0.2.0']) expect(isChannelTag('production', tag), tag).toBe(false);
    expect(tagVersion('staging', 'staging-v0.2.0-stg.000042')).toBe('0.2.0-stg.000042');
  });
});

describe('signature', () => {
  it('ships no compiled key yet, so every real manifest is refused with SIGNATURE_INVALID', () => {
    expect(UPDATE_PUBLIC_KEYS).toEqual({production: [], staging: []});
    expect(verified(manifestObject('production', '0.2.0', PKG, KEY.keyId), production([...UPDATE_PUBLIC_KEYS.production]))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
    expect(verified(manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId), staging('staging-v0.2.0-stg.000042', [...UPDATE_PUBLIC_KEYS.staging]))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
  });
  it('verifies a manifest signed by a compiled key of the channel, with or without a final line break', () => {
    const manifest = manifestObject('production', '0.2.0', PKG, KEY.keyId);
    expect(verified(manifest, production())).toMatchObject({ok: true, manifest: {appVersion: '0.2.0', nugetVersion: '0.2.0', package: {tag: 'v0.2.0', name: 'ETS2TelemetryDesktop-0.2.0-full.nupkg'}}});
    const signed = signManifest(manifest, KEY, {newline: true});
    expect(verifyUpdateManifest(signed.bytes, signed.signature, production()).ok).toBe(true);
  });
  it('rotates keys by keyId: the listed new key verifies, an unknown keyId or another key under its id does not', () => {
    const next = testKey('owner-2027');
    const keys = [KEY.publicKey, next.publicKey];
    expect(verified(manifestObject('production', '0.2.0', PKG, next.keyId), production(keys), next).ok).toBe(true);
    expect(verified(manifestObject('production', '0.2.0', PKG, KEY.keyId), production(keys)).ok).toBe(true);
    expect(verified(manifestObject('production', '0.2.0', PKG, 'owner-2028'), production(keys))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
    // Signed by the old key but naming the new key's id.
    expect(verified(manifestObject('production', '0.2.0', PKG, next.keyId), production(keys), KEY)).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
  });
  it('refuses a changed byte, a truncated, padded or non-base64 signature and a key of the other channel', () => {
    const signed = signManifest(manifestObject('production', '0.2.0', PKG, KEY.keyId), KEY);
    const changed = Buffer.from(signed.bytes); changed[changed.indexOf('0.2.0')] = '1'.charCodeAt(0);
    expect(verifyUpdateManifest(changed, signed.signature, production()).ok).toBe(false);
    const text = signed.signature.toString('ascii');
    for (const signature of [text.slice(0, -4), `${text}AAAA`, ` ${text}`, `${text}\n\n`, text.replace(/[A-Za-z]/, '!'), '']) {
      expect(verifyUpdateManifest(signed.bytes, Buffer.from(signature, 'ascii'), production()), JSON.stringify(signature)).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
    }
    // The staging key list never verifies a production manifest, even when the same key id appears there.
    const stagingKey = testKey(KEY.keyId);
    expect(verified(manifestObject('production', '0.2.0', PKG, KEY.keyId), production([stagingKey.publicKey]))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
  });
});

describe('binding to this build and its source release', () => {
  it('refuses a manifest of the other channel', () => {
    expect(verified(manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId), production())).toEqual({ok: false, code: 'CHANNEL_MISMATCH'});
    expect(verified(manifestObject('production', '0.2.0', PKG, KEY.keyId), staging(undefined))).toEqual({ok: false, code: 'CHANNEL_MISMATCH'});
  });
  it('refuses a tag that is not the source tag or not of the channel\'s pattern', () => {
    const stagingManifest = manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId);
    expect(verified(stagingManifest, staging('staging-v0.2.0-stg.000042')).ok).toBe(true);
    expect(verified(stagingManifest, staging('staging-v0.2.0-stg.000043'))).toEqual({ok: false, code: 'TAG_MISMATCH'});
    const wrongTag = manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId);
    (wrongTag.package as Record<string, unknown>).tag = 'staging-v0.2.0-stg.000043';
    expect(verified(wrongTag, staging('staging-v0.2.0-stg.000043'))).toEqual({ok: false, code: 'TAG_MISMATCH'});
    const productionTag = manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId);
    (productionTag.package as Record<string, unknown>).tag = 'v0.2.0-stg.000042';
    expect(verified(productionTag, staging(undefined))).toEqual({ok: false, code: 'TAG_MISMATCH'});
    // A staging version without the six-digit run never matches the staging tag pattern.
    expect(verified(manifestObject('staging', '0.2.0-stg.42', PKG, KEY.keyId), staging('staging-v0.2.0-stg.42'))).toEqual({ok: false, code: 'TAG_MISMATCH'});
    const otherVersion = manifestObject('production', '0.2.0', PKG, KEY.keyId);
    (otherVersion.package as Record<string, unknown>).tag = 'v0.3.0';
    expect(verified(otherVersion, production())).toEqual({ok: false, code: 'TAG_MISMATCH'});
  });
  it('refuses any package name but exactly <Squirrel id>-<NuGet version>-full.nupkg of this channel', () => {
    const named = (channel: 'production' | 'staging', version: string, name: string) => {
      const manifest = manifestObject(channel, version, PKG, KEY.keyId); (manifest.package as Record<string, unknown>).name = name; return manifest;
    };
    // The comparison is exact: the other channel's id, and a name that only starts with this channel's id (such as the
    // pre-fix staging id ETS2TelemetryDesktopStaging), are refused.
    expect(verified(named('staging', '0.2.0-stg.000042', 'ETS2TelemetryDesktop-0.2.0-stg000042-full.nupkg'), staging('staging-v0.2.0-stg.000042'))).toEqual({ok: false, code: 'NAME_MISMATCH'});
    expect(verified(named('production', '0.2.0', 'ETS2TelemetryStagingDesktop-0.2.0-full.nupkg'), production())).toEqual({ok: false, code: 'NAME_MISMATCH'});
    for (const name of ['ets2telemetrydesktop-0.2.0-full.nupkg', 'ETS2TelemetryDesktop-0.2.0-delta.nupkg', 'ETS2TelemetryDesktop-0.2.0-full.nupkg.exe', '..\\ETS2TelemetryDesktop-0.2.0-full.nupkg',
      'ETS2TelemetryDesktop-0.2.0.0-full.nupkg', 'https://example.invalid/ETS2TelemetryDesktop-0.2.0-full.nupkg',
      'ETS2TelemetryDesktopStaging-0.2.0-full.nupkg'])
      expect(verified(named('production', '0.2.0', name), production()), name).toEqual({ok: false, code: 'NAME_MISMATCH'});
    expect(verified(manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId), staging('staging-v0.2.0-stg.000042'))).toMatchObject({ok: true, manifest: {package: {name: 'ETS2TelemetryStagingDesktop-0.2.0-stg000042-full.nupkg'}}});
  });
  it('refuses the same version and a downgrade', () => {
    expect(verified(manifestObject('production', '0.1.1', PKG, KEY.keyId), production())).toEqual({ok: false, code: 'NOT_NEWER'});
    expect(verified(manifestObject('production', '0.1.0', PKG, KEY.keyId), production())).toEqual({ok: false, code: 'DOWNGRADE'});
    expect(verified(manifestObject('staging', '0.2.0-stg.000041', PKG, KEY.keyId), staging('staging-v0.2.0-stg.000041'))).toEqual({ok: false, code: 'NOT_NEWER'});
    expect(verified(manifestObject('staging', '0.2.0-stg.000040', PKG, KEY.keyId), staging('staging-v0.2.0-stg.000040'))).toEqual({ok: false, code: 'DOWNGRADE'});
    expect(verified(manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId), staging('staging-v0.2.0-stg.000042')).ok).toBe(true);
  });
});

describe('shape', () => {
  const valid = manifestObject('production', '0.2.0', PKG, KEY.keyId);
  const withPackage = (changes: Record<string, unknown>) => ({...valid, package: {...(valid.package as Record<string, unknown>), ...changes}});
  const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
  it.each([
    ['an extra key (a URL)', {...valid, url: 'https://example.invalid/package.nupkg'}],
    ['a missing keyId', without('keyId')],
    ['another format', {...valid, format: 'ets2telemetry.update-manifest.v2'}],
    ['an unknown channel', {...valid, channel: 'beta'}],
    ['a NuGet version that does not match the application version', {...valid, nugetVersion: '0.2.1'}],
    ['an application version that is not a version', {...valid, appVersion: '0.2', nugetVersion: '0.2'}],
    ['a zero size', withPackage({size: 0})],
    ['a size above 400 MiB', withPackage({size: PACKAGE_MAX_BYTES + 1})],
    ['a fractional size', withPackage({size: 10.5})],
    ['an upper-case SHA-256', withPackage({sha256: PKG.sha256.toUpperCase()})],
    ['a short SHA-1', withPackage({sha1: PKG.sha1.slice(2)})],
    ['an extra package key', withPackage({url: 'https://example.invalid/x'})],
    ['a local publication time', {...valid, publishedUtc: '2026-10-28T12:00:00+02:00'}],
    ['an impossible publication time', {...valid, publishedUtc: '2026-13-40T12:00:00Z'}],
    ['a keyId with a path', {...valid, keyId: '..\\key'}]
  ])('refuses %s as malformed, before any signature check', (_name, manifest) => {
    expect(verified(manifest, production())).toEqual({ok: false, code: 'MANIFEST_MALFORMED'});
  });
  it('refuses non-JSON, non-UTF-8, an array and more than 16 KiB', () => {
    expect(parseUpdateManifest(Buffer.from('not json'))).toBeUndefined();
    expect(parseUpdateManifest(Buffer.from([0x7b, 0xff, 0x7d]))).toBeUndefined();
    expect(parseUpdateManifest(Buffer.from('[]'))).toBeUndefined();
    expect(parseUpdateManifest(Buffer.alloc(0))).toBeUndefined();
    const padded = Buffer.from(JSON.stringify(valid).replace('{', `{${' '.repeat(MANIFEST_MAX_BYTES)}`));
    expect(parseUpdateManifest(padded)).toBeUndefined();
    expect(parseUpdateManifest(Buffer.from(JSON.stringify(valid)))).toMatchObject({appVersion: '0.2.0'});
  });
});
