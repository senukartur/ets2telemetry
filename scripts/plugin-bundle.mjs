import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {BUILD_IDENTITIES, resolveBuild, resolveBuildChannel} from './build-channel.mjs';

// Bundled game plugin (ET-017 PR-1, docs/plugin-setup.md#bundle-format). The build stages the Release SDK DLL with a
// strict manifest; Forge copies the directory to resources/telemetry-plugin and inspect-package verifies it. Nothing in
// the application reads the bundle yet. The DLL and released-list names belong to the build channel (ET-055 UP12): every
// function takes the channel and defaults to this build's (scripts/build-channel.mjs).
export const PLUGIN_BUNDLE_FORMAT = 'ets2telemetry.plugin-bundle';
export const RELEASED_PLUGINS_FORMAT = 'ets2telemetry.released-plugins';
export const PLUGIN_MANIFEST = 'plugin-manifest.json';
export const PLUGIN_STAGE = '.local/package-native/telemetry-plugin';
/**
 * The channel's plugin names: the DLL `file`, its Release build `built` (CMake names the DLL after the channel) and the
 * tracked released-plugin list `released`, both relative to the checkout.
 */
export function pluginBundleNames(channel = resolveBuildChannel()) {
  assert.ok(Object.hasOwn(BUILD_IDENTITIES, channel), `Unknown build channel ${channel}`);
  const identity = BUILD_IDENTITIES[channel];
  return Object.freeze({channel, file: identity.pluginFileName, built: `native/telemetry-plugin/build/Release/${identity.pluginFileName}`,
    released: `native/telemetry-plugin/${identity.releasedPluginsFile}`});
}
export const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_KNOWN = 256;
const MAX_SOURCES = 1024;
const MANIFEST_KEYS = ['appVersion', 'file', 'format', 'known', 'pluginSources', 'sha256', 'size', 'version'];
const RELEASED_KEYS = ['format', 'known', 'version'];
const KNOWN_KEYS = ['appVersion', 'sha256'];
const HASH = /^[0-9a-f]{64}$/;
const APP_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
// The repository inputs that compile into the DLL: plugin sources, its CMake project and the vendored SDK headers. The
// toolchain, generator and CMake cache options are deliberately excluded (builds are not reproducible); release bundles
// come from a freshly configured CI tree (docs/plugin-setup.md#released-plugin-list).
const SOURCE_FILES = ['native/telemetry-plugin/CMakeLists.txt'];
const SOURCE_DIRECTORIES = ['native/telemetry-plugin/src', 'native/telemetry-plugin/vendor/scs-sdk-1.15/include'];
const SOURCE_KEY = /^native\/telemetry-plugin\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys, label) {
  assert.ok(isRecord(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), keys, `${label} has unexpected keys`);
}

// SHA-256 of every plugin input, keyed by repository path with `/` separators. Links are refused, never followed.
export function pluginSourceHashes(root = '.') {
  const files = [...SOURCE_FILES];
  function walk(directory, depth) {
    assert.ok(depth <= 8, 'Plugin source tree too deep');
    for (const item of readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const filename = `${directory}/${item.name}`;
      assert.ok(!item.isSymbolicLink(), `Plugin source must not be a link: ${filename}`);
      if (item.isDirectory()) walk(filename, depth + 1);
      else {assert.ok(item.isFile(), `Plugin source must be a regular file: ${filename}`); files.push(filename);}
    }
  }
  for (const directory of SOURCE_DIRECTORIES) {
    assert.ok(!lstatSync(path.join(root, directory)).isSymbolicLink(), `Plugin source must not be a link: ${directory}`);
    walk(directory, 0);
  }
  assert.ok(files.length <= MAX_SOURCES, 'Too many plugin sources');
  for (const filename of SOURCE_FILES) assert.ok(lstatSync(path.join(root, filename)).isFile(), `Plugin source must be a regular file: ${filename}`);
  return Object.fromEntries(files.sort().map(filename => [filename, sha256(readFileSync(path.join(root, filename)))]));
}

function parseKnown(value, label) {
  assert.ok(Array.isArray(value) && value.length <= MAX_KNOWN, `${label} must be an array of at most ${MAX_KNOWN} entries`);
  const seen = new Set();
  return value.map(entry => {
    exactKeys(entry, KNOWN_KEYS, `${label} entry`);
    assert.ok(typeof entry.appVersion === 'string' && APP_VERSION.test(entry.appVersion), `${label} entry has an invalid appVersion`);
    assert.ok(typeof entry.sha256 === 'string' && HASH.test(entry.sha256), `${label} entry has an invalid sha256`);
    assert.ok(!seen.has(entry.sha256), `${label} repeats a sha256`);
    seen.add(entry.sha256);
    return {appVersion: entry.appVersion, sha256: entry.sha256};
  });
}

function readJson(filename, limit, label) {
  const item = lstatSync(filename);
  assert.ok(!item.isSymbolicLink(), `${label} must not be a link`);
  assert.ok(item.isFile(), `${label} must be a regular file`);
  assert.ok(item.size > 0 && item.size <= limit, `${label} exceeds ${limit} bytes`);
  const bytes = readFileSync(filename);
  assert.ok(bytes.length === item.size, `${label} changed while it was read`);
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

// The tracked list of every shipped plugin hash. MSVC builds are not reproducible, so a release appends its own hash.
export function readReleasedPlugins(filename = pluginBundleNames().released) {
  const value = readJson(filename, MAX_MANIFEST_BYTES, 'Released plugin list');
  exactKeys(value, RELEASED_KEYS, 'Released plugin list');
  assert.equal(value.format, RELEASED_PLUGINS_FORMAT, 'Released plugin list has an unexpected format');
  assert.equal(value.version, 1, 'Released plugin list has an unsupported version');
  return parseKnown(value.known, 'Released plugin list');
}

// Windows x64 DLL: MZ header, PE signature, machine AMD64 (0x8664) and the IMAGE_FILE_DLL characteristic.
export function assertX64Dll(bytes, label = 'Plugin') {
  assert.ok(bytes.length >= 64 && bytes.length <= MAX_PLUGIN_BYTES, `${label} size is outside the bounds`);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d, `${label} must be a PE image`);
  const pe = bytes.readUInt32LE(0x3c);
  assert.ok(pe >= 64 && pe <= bytes.length - 24, `${label} has an invalid PE header offset`);
  assert.equal(bytes.readUInt32LE(pe), 0x4550, `${label} has no PE signature`);
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, `${label} must be x64`);
  assert.ok((bytes.readUInt16LE(pe + 22) & 0x2000) !== 0, `${label} must be a DLL`);
}

function parseManifest(value, file) {
  exactKeys(value, MANIFEST_KEYS, 'Plugin manifest');
  assert.equal(value.format, PLUGIN_BUNDLE_FORMAT, 'Plugin manifest has an unexpected format');
  assert.equal(value.version, 1, 'Plugin manifest has an unsupported version');
  assert.ok(typeof value.appVersion === 'string' && APP_VERSION.test(value.appVersion), 'Plugin manifest has an invalid appVersion');
  assert.equal(value.file, file, 'Plugin manifest names an unexpected file');
  assert.ok(Number.isSafeInteger(value.size) && value.size >= 64 && value.size <= MAX_PLUGIN_BYTES, 'Plugin manifest size is outside the bounds');
  assert.ok(typeof value.sha256 === 'string' && HASH.test(value.sha256), 'Plugin manifest has an invalid sha256');
  assert.ok(isRecord(value.pluginSources), 'Plugin manifest pluginSources must be an object');
  const sources = Object.entries(value.pluginSources);
  assert.ok(sources.length > 0 && sources.length <= MAX_SOURCES, 'Plugin manifest pluginSources is outside the bounds');
  for (const [filename, hash] of sources) {
    assert.ok(SOURCE_KEY.test(filename) && !filename.split('/').some(part => part === '.' || part === '..'), 'Plugin manifest has an invalid source path');
    assert.ok(typeof hash === 'string' && HASH.test(hash), 'Plugin manifest has an invalid source hash');
  }
  return {format: value.format, version: value.version, appVersion: value.appVersion, file: value.file, size: value.size,
    sha256: value.sha256, pluginSources: Object.fromEntries(sources), known: parseKnown(value.known, 'Plugin manifest known')};
}

// Intrinsic checks of a staged or packaged bundle directory. Returns the parsed manifest; throws AssertionError otherwise.
export function verifyPluginBundle(directory, channel = resolveBuildChannel()) {
  const {file} = pluginBundleNames(channel);
  const root = lstatSync(directory);
  assert.ok(!root.isSymbolicLink(), 'Plugin bundle directory must not be a link');
  assert.ok(root.isDirectory(), 'Plugin bundle must be a directory');
  assert.deepEqual(readdirSync(directory).sort(), [file, PLUGIN_MANIFEST].sort(), 'Plugin bundle must hold exactly the DLL and its manifest');
  const manifest = parseManifest(readJson(path.join(directory, PLUGIN_MANIFEST), MAX_MANIFEST_BYTES, 'Plugin manifest'), file);
  const filename = path.join(directory, file);
  const item = lstatSync(filename);
  assert.ok(!item.isSymbolicLink(), 'Plugin DLL must not be a link');
  assert.ok(item.isFile(), 'Plugin DLL must be a regular file');
  assert.ok(item.size >= 64 && item.size <= MAX_PLUGIN_BYTES, 'Plugin DLL size is outside the bounds');
  const bytes = readFileSync(filename);
  assert.equal(bytes.length, item.size, 'Plugin DLL changed while it was read');
  assert.equal(bytes.length, manifest.size, 'Plugin DLL size differs from its manifest');
  assert.equal(sha256(bytes), manifest.sha256, 'Plugin DLL hash differs from its manifest');
  assertX64Dll(bytes, 'Plugin DLL');
  return manifest;
}

// Packaging check: the bundle also matches this checkout's Release build, plugin sources, released list and the build
// version of this channel (the package.json version, with the staging suffix in staging).
export function verifyPluginBundleAgainstTree(directory, root = '.', build = resolveBuild({root})) {
  const names = pluginBundleNames(build.channel);
  const manifest = verifyPluginBundle(directory, build.channel);
  assert.equal(sha256(readFileSync(path.join(root, names.built))), manifest.sha256, 'Packaged plugin differs from local build');
  assert.deepEqual(manifest.pluginSources, pluginSourceHashes(root), 'Plugin bundle built from stale plugin sources');
  assert.deepEqual(manifest.known, readReleasedPlugins(path.join(root, names.released)), 'Plugin bundle known hashes differ from the released plugin list');
  assert.equal(manifest.appVersion, build.version, 'Plugin bundle appVersion differs from package.json and the build channel');
  return manifest;
}

// Writes the DLL bytes and manifest into a new or empty directory, then verifies the result.
export function writePluginBundle(directory, {dll, appVersion, pluginSources, known, channel = resolveBuildChannel()}) {
  const {file} = pluginBundleNames(channel);
  assertX64Dll(dll, 'Plugin DLL');
  mkdirSync(directory, {recursive: true});
  assert.equal(readdirSync(directory).length, 0, 'Plugin stage directory must be empty');
  const manifest = {format: PLUGIN_BUNDLE_FORMAT, version: 1, appVersion, file, size: dll.length,
    sha256: sha256(dll), pluginSources, known};
  writeFileSync(path.join(directory, file), dll, {flag: 'wx'});
  writeFileSync(path.join(directory, PLUGIN_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return verifyPluginBundle(directory, channel);
}
