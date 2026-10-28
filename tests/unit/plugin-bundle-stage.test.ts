// The staged and packaged game plugin bundle (ET-017 PR-1, P5): scripts/plugin-bundle.mjs writes the DLL with a strict
// manifest, and inspect-package refuses any bundle whose bytes, manifest, plugin sources or released list disagree
// (REG-015, REG-017). Every case works in its own temporary directory with inert synthetic PE bytes that are never loaded.
import {afterEach, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MAX_MANIFEST_BYTES, MAX_PLUGIN_BYTES, pluginSourceHashes, readReleasedPlugins, verifyPluginBundle,
  verifyPluginBundleAgainstTree, writePluginBundle} from '../../scripts/plugin-bundle.mjs';
import {BUILD_IDENTITIES} from '../../scripts/build-channel.mjs';

const temporary: string[] = [];
afterEach(() => {for (const directory of temporary.splice(0)) rmSync(directory, {recursive: true, force: true});});
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const KNOWN_HASH = 'a'.repeat(64);
// The fixture checkout is a production build of its own package.json version. The channel is always given, so the
// resolver default (staging since ET-055 PR-4) never decides which names a case checks.
const productionBuild = (root: string) => {
  const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {version: string}).version;
  return {channel: 'production' as const, identity: BUILD_IDENTITIES.production, baseVersion: version, version};
};

// Headers only: MZ, e_lfanew 0x80, "PE\0\0", the machine and the characteristics (0x2022 = executable, large-address, DLL).
function pe({machine = 0x8664, characteristics = 0x2022, size = 512, fill = 0} = {}) {
  const bytes = Buffer.alloc(size, 0);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(characteristics, 0x80 + 22);
  bytes[size - 1] = fill;
  return bytes;
}

function write(root: string, filename: string, content: Buffer | string) {
  mkdirSync(path.dirname(path.join(root, filename)), {recursive: true});
  writeFileSync(path.join(root, filename), content);
}

// A miniature checkout: package.json, the plugin sources, CMake project, SDK headers, released list and a Release build.
function fixture({known = [{appVersion: '0.1.0', sha256: KNOWN_HASH}], dll = pe()} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ets2-plugin-bundle-'));
  temporary.push(root);
  write(root, 'package.json', JSON.stringify({name: 'fixture', version: '0.2.0'}));
  write(root, 'native/telemetry-plugin/CMakeLists.txt', 'project(fixture)\n');
  write(root, 'native/telemetry-plugin/src/sdk-exports.cpp', '// fixture\n');
  write(root, 'native/telemetry-plugin/src/sdk-exports.def', 'EXPORTS\n');
  write(root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/include/scssdk.h', '// header\n');
  write(root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/include/common/channels.h', '// header\n');
  write(root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/readme.txt', 'not a plugin input\n');
  write(root, 'native/telemetry-plugin/tests/test.cpp', '// not a plugin input\n');
  write(root, 'native/telemetry-plugin/released-plugins.json', JSON.stringify({format: 'ets2telemetry.released-plugins', version: 1, known}));
  write(root, 'native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll', dll);
  const stage = path.join(root, '.local/package-native/telemetry-plugin');
  const stageBundle = () => writePluginBundle(stage, {dll: readFileSync(path.join(root, 'native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll')),
    appVersion: '0.2.0', pluginSources: pluginSourceHashes(root), known: readReleasedPlugins(path.join(root, 'native/telemetry-plugin/released-plugins.json')), channel: 'production'});
  const manifestFile = path.join(stage, 'plugin-manifest.json');
  const dllFile = path.join(stage, 'ets2telemetry-plugin.dll');
  const rewriteManifest = (change: (manifest: Record<string, unknown>) => void) => {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    change(manifest);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  };
  return {root, stage, stageBundle, manifestFile, dllFile, rewriteManifest};
}

it('stages a good bundle that passes both the intrinsic and the checkout checks', () => {
  const f = fixture();
  f.stageBundle();
  const dll = pe();
  const expected = {
    format: 'ets2telemetry.plugin-bundle', version: 1, appVersion: '0.2.0', file: 'ets2telemetry-plugin.dll', size: 512, sha256: sha256(dll),
    pluginSources: {
      'native/telemetry-plugin/CMakeLists.txt': sha256('project(fixture)\n'),
      'native/telemetry-plugin/src/sdk-exports.cpp': sha256('// fixture\n'),
      'native/telemetry-plugin/src/sdk-exports.def': sha256('EXPORTS\n'),
      'native/telemetry-plugin/vendor/scs-sdk-1.15/include/common/channels.h': sha256('// header\n'),
      'native/telemetry-plugin/vendor/scs-sdk-1.15/include/scssdk.h': sha256('// header\n')
    },
    known: [{appVersion: '0.1.0', sha256: KNOWN_HASH}]
  };
  expect(JSON.parse(readFileSync(f.manifestFile, 'utf8'))).toEqual(expected);
  expect(Object.keys(JSON.parse(readFileSync(f.manifestFile, 'utf8')) as object)).toEqual(['format', 'version', 'appVersion', 'file', 'size', 'sha256', 'pluginSources', 'known']);
  expect(readFileSync(f.dllFile).equals(dll)).toBe(true);
  expect(verifyPluginBundle(f.stage, 'production')).toEqual(expected);
  expect(verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toEqual(expected);
});

it('accepts the tracked empty released list of this checkout', () => {
  expect(readReleasedPlugins('native/telemetry-plugin/released-plugins.json')).toEqual([]);
});

it('rejects a DLL tampered after staging', () => {
  const f = fixture();
  f.stageBundle();
  const bytes = readFileSync(f.dllFile);
  bytes[300] ^= 0xff;
  writeFileSync(f.dllFile, bytes);
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/Plugin DLL hash differs from its manifest/);
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/Plugin DLL hash differs from its manifest/);
});

it('rejects a manifest hash or size that differs from the bytes', () => {
  const f = fixture();
  f.stageBundle();
  f.rewriteManifest(manifest => {manifest.sha256 = 'b'.repeat(64);});
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/Plugin DLL hash differs from its manifest/);
  f.rewriteManifest(manifest => {manifest.sha256 = sha256(pe()); manifest.size = 513;});
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/Plugin DLL size differs from its manifest/);
});

it('rejects a local Release build that differs from the bundled bytes', () => {
  const f = fixture();
  f.stageBundle();
  write(f.root, 'native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll', pe({fill: 1}));
  expect(verifyPluginBundle(f.stage, 'production').sha256).toBe(sha256(pe()));
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/Packaged plugin differs from local build/);
});

it('rejects a non-x64, non-DLL or non-PE image even with a consistent manifest', () => {
  for (const [image, message] of [
    [pe({machine: 0x014c}), /Plugin DLL must be x64/],
    [pe({machine: 0xaa64}), /Plugin DLL must be x64/],
    [pe({characteristics: 0x0022}), /Plugin DLL must be a DLL/],
    [Buffer.alloc(512, 0x41), /Plugin DLL must be a PE image/]
  ] as const) {
    const f = fixture({dll: image});
    expect(() => f.stageBundle()).toThrow(message);
    // Stage a good bundle, then swap in the bad image with a manifest that matches it, so only the PE check can refuse it.
    write(f.root, 'native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll', pe());
    rmSync(f.stage, {recursive: true, force: true});
    f.stageBundle();
    writeFileSync(f.dllFile, image);
    f.rewriteManifest(manifest => {manifest.sha256 = sha256(image); manifest.size = image.length;});
    expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(message);
  }
});

it('rejects stale plugin sources: a changed, added or removed input', () => {
  const f = fixture();
  f.stageBundle();
  write(f.root, 'native/telemetry-plugin/src/sdk-exports.cpp', '// changed\n');
  expect(verifyPluginBundle(f.stage, 'production').appVersion).toBe('0.2.0');
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/Plugin bundle built from stale plugin sources/);
  write(f.root, 'native/telemetry-plugin/src/sdk-exports.cpp', '// fixture\n');
  expect(verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root)).sha256).toBe(sha256(pe()));
  write(f.root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/include/new.h', '// added\n');
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/stale plugin sources/);
  unlinkSync(path.join(f.root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/include/new.h'));
  unlinkSync(path.join(f.root, 'native/telemetry-plugin/src/sdk-exports.def'));
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/stale plugin sources/);
});

it('ignores files outside the plugin inputs', () => {
  const f = fixture();
  f.stageBundle();
  write(f.root, 'native/telemetry-plugin/tests/test.cpp', '// changed\n');
  write(f.root, 'native/telemetry-plugin/vendor/scs-sdk-1.15/readme.txt', 'changed\n');
  expect(verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root)).size).toBe(512);
});

it('rejects known hashes that differ from the tracked released list', () => {
  const f = fixture();
  f.stageBundle();
  write(f.root, 'native/telemetry-plugin/released-plugins.json', JSON.stringify({format: 'ets2telemetry.released-plugins', version: 1,
    known: [{appVersion: '0.1.0', sha256: KNOWN_HASH}, {appVersion: '0.2.0', sha256: 'c'.repeat(64)}]}));
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/Plugin bundle known hashes differ from the released plugin list/);
  write(f.root, 'native/telemetry-plugin/released-plugins.json', JSON.stringify({format: 'ets2telemetry.released-plugins', version: 1, known: []}));
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/known hashes differ/);
});

// ET-055 UP12 and UP15: a staging build stages its own DLL name, its own released list and the staging version, and a
// bundle of one channel never passes as the other's.
it('stages a staging bundle under the staging names and version, and keeps the channels apart', () => {
  const f = fixture();
  write(f.root, 'native/telemetry-plugin/released-plugins-staging.json', JSON.stringify({format: 'ets2telemetry.released-plugins', version: 1, known: []}));
  write(f.root, 'native/telemetry-plugin/build/Release/ets2telemetry-plugin-staging.dll', pe({fill: 7}));
  const stage = path.join(f.root, 'staging-stage');
  const manifest = writePluginBundle(stage, {dll: pe({fill: 7}), appVersion: '0.2.0-stg.000042', pluginSources: pluginSourceHashes(f.root),
    known: readReleasedPlugins(path.join(f.root, 'native/telemetry-plugin/released-plugins-staging.json')), channel: 'staging'});
  expect(manifest.file).toBe('ets2telemetry-plugin-staging.dll');
  expect(readFileSync(path.join(stage, 'ets2telemetry-plugin-staging.dll')).equals(pe({fill: 7}))).toBe(true);
  expect(verifyPluginBundle(stage, 'staging').appVersion).toBe('0.2.0-stg.000042');
  expect(() => verifyPluginBundle(stage, 'production')).toThrow(/exactly the DLL and its manifest/);
  const build = {channel: 'staging' as const, identity: BUILD_IDENTITIES.staging, baseVersion: '0.2.0', version: '0.2.0-stg.000042'};
  expect(verifyPluginBundleAgainstTree(stage, f.root, build).sha256).toBe(sha256(pe({fill: 7})));
  expect(() => verifyPluginBundleAgainstTree(stage, f.root, {...build, version: '0.2.0-stg.000043'})).toThrow(/appVersion differs/);
  f.stageBundle();
  expect(() => verifyPluginBundle(f.stage, 'staging')).toThrow(/exactly the DLL and its manifest/);
});

it('rejects an appVersion that differs from package.json', () => {
  const f = fixture();
  f.stageBundle();
  write(f.root, 'package.json', JSON.stringify({version: '0.3.0'}));
  expect(() => verifyPluginBundleAgainstTree(f.stage, f.root, productionBuild(f.root))).toThrow(/appVersion differs from package.json/);
});

it('rejects a linked DLL and a linked bundle directory', () => {
  const f = fixture();
  f.stageBundle();
  const elsewhere = path.join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'ets2telemetry-plugin.dll'), pe());
  unlinkSync(f.dllFile);
  // A file symbolic link needs SeCreateSymbolicLinkPrivilege (hosted runners have it); without it a junction stands at the
  // DLL name instead. Both are reparse points that lstat reports as links.
  try {symlinkSync(path.join(elsewhere, 'ets2telemetry-plugin.dll'), f.dllFile, 'file');} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    symlinkSync(elsewhere, f.dllFile, 'junction');
  }
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/Plugin DLL must not be a link/);

  const g = fixture();
  g.stageBundle();
  const linked = path.join(g.root, 'linked-bundle');
  symlinkSync(g.stage, linked, 'junction');
  expect(() => verifyPluginBundle(linked, 'production')).toThrow(/Plugin bundle directory must not be a link/);
});

it('rejects a linked plugin source', () => {
  const f = fixture();
  symlinkSync(path.join(f.root, 'native/telemetry-plugin/tests'), path.join(f.root, 'native/telemetry-plugin/src/linked'), 'junction');
  expect(() => pluginSourceHashes(f.root)).toThrow(/Plugin source must not be a link/);
});

it('requires exactly the DLL and the manifest with strict manifest keys and values', () => {
  const f = fixture();
  f.stageBundle();
  writeFileSync(path.join(f.stage, 'extra.dll'), pe());
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/exactly the DLL and its manifest/);
  unlinkSync(path.join(f.stage, 'extra.dll'));
  for (const [change, message] of [
    [(m: Record<string, unknown>) => {m.extra = true;}, /Plugin manifest has unexpected keys/],
    [(m: Record<string, unknown>) => {delete m.known;}, /Plugin manifest has unexpected keys/],
    [(m: Record<string, unknown>) => {m.format = 'other';}, /unexpected format/],
    [(m: Record<string, unknown>) => {m.version = 2;}, /unsupported version/],
    [(m: Record<string, unknown>) => {m.file = 'other.dll';}, /names an unexpected file/],
    [(m: Record<string, unknown>) => {m.appVersion = '../1';}, /invalid appVersion/],
    [(m: Record<string, unknown>) => {m.sha256 = 'A'.repeat(64);}, /invalid sha256/],
    [(m: Record<string, unknown>) => {m.pluginSources = {'native/telemetry-plugin/../x': 'a'.repeat(64)};}, /invalid source path/],
    [(m: Record<string, unknown>) => {m.pluginSources = {};}, /pluginSources is outside the bounds/],
    [(m: Record<string, unknown>) => {m.known = [{appVersion: '0.1.0', sha256: KNOWN_HASH, extra: 1}];}, /known entry has unexpected keys/],
    [(m: Record<string, unknown>) => {m.known = [{appVersion: '0.1.0', sha256: KNOWN_HASH}, {appVersion: '0.1.1', sha256: KNOWN_HASH}];}, /repeats a sha256/]
  ] as const) {
    rmSync(f.stage, {recursive: true, force: true});
    f.stageBundle();
    f.rewriteManifest(change);
    expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(message);
  }
});

it('bounds the DLL and manifest sizes', () => {
  const f = fixture();
  f.stageBundle();
  writeFileSync(f.manifestFile, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/Plugin manifest exceeds 65536 bytes/);
  rmSync(f.stage, {recursive: true, force: true});
  f.stageBundle();
  const oversized = pe({size: MAX_PLUGIN_BYTES + 1});
  writeFileSync(f.dllFile, oversized);
  f.rewriteManifest(manifest => {manifest.sha256 = sha256(oversized); manifest.size = oversized.length;});
  expect(() => verifyPluginBundle(f.stage, 'production')).toThrow(/size is outside the bounds/);
  expect(() => writePluginBundle(path.join(f.root, 'other-stage'), {dll: oversized, appVersion: '0.2.0', pluginSources: {}, known: [], channel: 'production'}))
    .toThrow(/Plugin DLL size is outside the bounds/);
});

it('rejects a malformed released list', () => {
  const f = fixture();
  const list = path.join(f.root, 'native/telemetry-plugin/released-plugins.json');
  for (const [value, message] of [
    [{format: 'ets2telemetry.released-plugins', version: 1, known: [], extra: 1}, /Released plugin list has unexpected keys/],
    [{format: 'other', version: 1, known: []}, /unexpected format/],
    [{format: 'ets2telemetry.released-plugins', version: 2, known: []}, /unsupported version/],
    [{format: 'ets2telemetry.released-plugins', version: 1, known: [{appVersion: '0.1.0', sha256: 'xyz'}]}, /invalid sha256/],
    [{format: 'ets2telemetry.released-plugins', version: 1, known: {}}, /must be an array/]
  ] as const) {
    writeFileSync(list, JSON.stringify(value));
    expect(() => readReleasedPlugins(list)).toThrow(message);
  }
});

it('refuses to stage into a directory that is not empty', () => {
  const f = fixture();
  f.stageBundle();
  expect(() => f.stageBundle()).toThrow(/Plugin stage directory must be empty/);
});
