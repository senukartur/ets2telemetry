import {createHash} from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {pluginBundleDirectory, readPluginBundle, type BundleFileSystem} from '../../apps/desktop/src/plugin-setup/plugin-bundle';
import {verifyPluginBundle, writePluginBundle} from '../../scripts/plugin-bundle.mjs';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-015, REG-017 (ET-017 P5): the runtime reader of the bundled plugin in main. A bundle written by the packaging
// writer (scripts/plugin-bundle.mjs) under the guarded temporary root is read through the guarded file system; every
// refusal is BUNDLE_UNAVAILABLE with a hand-written failure code. The synthetic PE bytes are inert and never loaded.

let guard: GuardedRoot;
let stage: string;
beforeEach(async () => {
  guard = await guardedTempRoot('ets2telemetry-plugin-bundle-');
  stage = path.join(guard.root, 'telemetry-plugin');
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
// Headers only: MZ, e_lfanew 0x80, "PE\0\0", the machine and the characteristics (0x2022 = executable, large-address, DLL).
function pe({machine = 0x8664, characteristics = 0x2022, size = 4096, fill = 7} = {}) {
  const bytes = Buffer.alloc(size, 0);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(characteristics, 0x80 + 22);
  bytes[size - 1] = fill;
  return bytes;
}
const KNOWN = [{appVersion: '0.1.0', sha256: 'a'.repeat(64)}];
const SOURCES = {'native/telemetry-plugin/CMakeLists.txt': 'b'.repeat(64), 'native/telemetry-plugin/src/sdk-exports.cpp': 'c'.repeat(64)};
const DLL = pe();
const read = () => readPluginBundle(stage, {fs: guard.fs as unknown as BundleFileSystem});
const manifestFile = () => path.join(stage, 'plugin-manifest.json');
const dllFile = () => path.join(stage, 'ets2telemetry-plugin.dll');
async function rewriteManifest(change: (manifest: Record<string, unknown>) => void) {
  const manifest = JSON.parse(await fsp.readFile(manifestFile(), 'utf8')) as Record<string, unknown>;
  change(manifest);
  await fsp.writeFile(manifestFile(), JSON.stringify(manifest, null, 2) + '\n');
}
/** Writes a consistent bundle around `dll`, as the packaging writer would, without its x64 check. */
async function consistentBundle(dll: Buffer) {
  writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
  await fsp.writeFile(dllFile(), dll);
  await rewriteManifest(manifest => {manifest.size = dll.length; manifest.sha256 = sha256(dll);});
}

describe('a valid bundle', () => {
  it('returns the verified bytes, hash, version and known list that the packaging verifier also accepts', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    expect(verifyPluginBundle(stage, 'production').sha256).toBe(sha256(DLL));
    const result = await read();
    if (!result.ok) throw new Error(`unexpected ${result.failure}`);
    expect(result.bundle.sha256).toBe(sha256(DLL));
    expect(result.bundle.appVersion).toBe('0.2.0');
    expect(result.bundle.known).toEqual([{appVersion: '0.1.0', sha256: 'a'.repeat(64)}]);
    expect(result.bundle.file).toBe(dllFile());
    expect(Buffer.from(result.bundle.bytes)).toEqual(DLL);
    // The installer's source is this buffer; a later change of the file on disk cannot reach it.
    await fsp.writeFile(dllFile(), pe({fill: 9}));
    expect(sha256(result.bundle.bytes)).toBe(sha256(DLL));
    expect(Object.isFrozen(result.bundle)).toBe(true);
  });

  it('accepts an empty known list and a pre-release version', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0-beta.1', pluginSources: SOURCES, known: [], channel: 'production'});
    expect(await read()).toMatchObject({ok: true, bundle: {appVersion: '0.2.0-beta.1', known: []}});
  });
});

describe('refusals', () => {
  const refused = (failure: string) => ({ok: false, code: 'BUNDLE_UNAVAILABLE', failure});

  it('refuses a missing, linked or non-folder bundle location', async () => {
    expect(await read()).toEqual(refused('directory'));
    await fsp.writeFile(stage, 'not a folder');
    expect(await read()).toEqual(refused('directory'));
    await fsp.rm(stage);
    const elsewhere = path.join(guard.root, 'elsewhere');
    writePluginBundle(elsewhere, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    await fsp.symlink(elsewhere, stage, 'junction');
    expect(await read()).toEqual(refused('directory'));
  });

  // Review round 1 (October 17, 2026): at runtime other entries in the folder are ignored; only the packaging inspection
  // (plugin-bundle-stage.test.ts) requires exactly the two files. A missing DLL or manifest is still refused.
  it('ignores other entries in the folder, and refuses a missing DLL or manifest', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    await fsp.writeFile(path.join(stage, 'notes.txt'), 'extra');
    await fsp.mkdir(path.join(stage, 'folder'));
    expect(await read()).toMatchObject({ok: true, bundle: {sha256: sha256(DLL)}});
    expect(() => verifyPluginBundle(stage, 'production')).toThrow(/exactly the DLL and its manifest/);
    await fsp.rm(dllFile());
    expect(await read()).toEqual(refused('plugin-unreadable'));
    await fsp.writeFile(dllFile(), DLL);
    await fsp.rm(manifestFile());
    expect(await read()).toEqual(refused('manifest-unreadable'));
  });

  it('refuses a DLL whose bytes differ from the manifest hash or size', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    await fsp.writeFile(dllFile(), pe({fill: 8}));
    expect(await read()).toEqual(refused('plugin-hash'));
    await fsp.writeFile(dllFile(), DLL);
    await rewriteManifest(manifest => {manifest.size = DLL.length + 1;});
    expect(await read()).toEqual(refused('plugin-size'));
  });

  it('refuses a consistent bundle whose DLL is not an x64 PE DLL', async () => {
    for (const dll of [pe({machine: 0x014c}), pe({machine: 0xaa64}), pe({characteristics: 0x0022}), Buffer.alloc(4096, 1)]) {
      await fsp.rm(stage, {recursive: true, force: true});
      await consistentBundle(dll);
      expect(await read()).toEqual(refused('plugin-not-x64-dll'));
    }
  });

  it('refuses a linked or oversized DLL without hashing it', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    const elsewhere = path.join(guard.root, 'elsewhere');
    await fsp.mkdir(elsewhere);
    await fsp.writeFile(path.join(elsewhere, 'ets2telemetry-plugin.dll'), DLL);
    await fsp.rm(dllFile());
    // A file symbolic link needs SeCreateSymbolicLinkPrivilege; without it a junction stands at the DLL name instead.
    try {await fsp.symlink(path.join(elsewhere, 'ets2telemetry-plugin.dll'), dllFile(), 'file');} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fsp.symlink(elsewhere, dllFile(), 'junction');
    }
    expect(await read()).toEqual(refused('plugin-not-file'));
    await fsp.rm(dllFile(), {recursive: true, force: true});
    await fsp.writeFile(dllFile(), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(await read()).toEqual(refused('plugin-size'));
  });

  it('refuses a manifest with unexpected keys or values', async () => {
    const changes: ((manifest: Record<string, unknown>) => void)[] = [
      manifest => {manifest.extra = true;},
      manifest => {delete manifest.known;},
      manifest => {manifest.format = 'ets2telemetry.plugin-bundle-v2';},
      manifest => {manifest.version = 2;},
      manifest => {manifest.file = 'other.dll';},
      manifest => {manifest.appVersion = 'latest';},
      manifest => {manifest.sha256 = (manifest.sha256 as string).toUpperCase();},
      manifest => {manifest.size = 63;},
      manifest => {manifest.pluginSources = {};},
      manifest => {manifest.pluginSources = {'native/telemetry-plugin/../secret': 'b'.repeat(64)};},
      manifest => {manifest.known = [{appVersion: '0.1.0', sha256: 'a'.repeat(64)}, {appVersion: '0.1.1', sha256: 'a'.repeat(64)}];},
      manifest => {manifest.known = [{appVersion: '0.1.0', sha256: 'a'.repeat(64), path: 'C:\\x'}];},
      manifest => {manifest.known = 'none';}
    ];
    for (const change of changes) {
      await fsp.rm(stage, {recursive: true, force: true});
      writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
      await rewriteManifest(change);
      expect(await read(), change.toString()).toEqual(refused('manifest-invalid'));
    }
  });

  it('refuses a manifest that is not UTF-8 JSON or exceeds 64 KiB', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    await fsp.writeFile(manifestFile(), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(await read()).toEqual(refused('manifest-invalid'));
    await fsp.writeFile(manifestFile(), '{"format":');
    expect(await read()).toEqual(refused('manifest-invalid'));
    await fsp.writeFile(manifestFile(), ' '.repeat(64 * 1024 + 1));
    expect(await read()).toEqual(refused('manifest-invalid'));
  });

  it('stops reading once the run is aborted', async () => {
    writePluginBundle(stage, {dll: DLL, appVersion: '0.2.0', pluginSources: SOURCES, known: KNOWN, channel: 'production'});
    const controller = new AbortController();
    controller.abort();
    expect(await readPluginBundle(stage, {fs: guard.fs as unknown as BundleFileSystem, signal: controller.signal})).toEqual(refused('aborted'));
  });
});

it('reads the packaged bundle beside the resources and the staged one in development', () => {
  expect(pluginBundleDirectory('C:\\App\\resources\\app.asar\\apps\\desktop\\dist', 'C:\\App\\resources', true)).toBe('C:\\App\\resources\\telemetry-plugin');
  expect(pluginBundleDirectory('D:\\repo\\apps\\desktop\\dist', 'D:\\repo\\node_modules\\electron\\dist\\resources', false))
    .toBe('D:\\repo\\.local\\package-native\\telemetry-plugin');
});
