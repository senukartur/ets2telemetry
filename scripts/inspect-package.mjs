import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import * as asar from '@electron/asar';
import {readCmakeCacheChannel, resolveBuild} from './build-channel.mjs';
import {sha256, sourceHashes} from './source-inputs.mjs';
import {verifyPackage} from './package-integrity.mjs';
import {pluginBundleNames, verifyPluginBundleAgainstTree} from './plugin-bundle.mjs';
import {assertNoPackedNativeCode, assertVersionInfo, executableOf, inspectInstaller, MAKE_DIRECTORY, packageDirectoryOf, readVersionInfo} from './release-identity.mjs';
import {EXECUTOR_FILE, executorBytes} from './uninstall-executor.mjs';

// Read bytes and resolve paths only. Never import application entries or native bindings.
// `--installer` (ET-018 PR-6) also checks the Squirrel make output: the full NuGet package must carry exactly the
// portable package's files with the same bytes, apart from Squirrel's known additions (scripts/release-identity.mjs).
// ET-055: every name is the build channel's (scripts/build-channel.mjs, the same environment as the build), and the
// desktop bundle, the packaged package.json, the broker, the plugin, both native trees and the executor must all name it.
const build = resolveBuild();
const {identity} = build;
const args = process.argv.slice(2);
const installerCheck = args.includes('--installer');
const positional = args.filter(arg => arg !== '--installer');
assert.ok(positional.length <= 1 && !positional.some(arg => arg.startsWith('--')), 'Usage: inspect-package.mjs [package directory] [--installer]');
const directory = path.resolve(positional[0] || packageDirectoryOf(identity));
const archive = path.join(directory, 'resources/app.asar');
const integrity = verifyPackage(directory);
const paths = asar.listPackage(archive).map(filename => filename.replaceAll('\\', '/'));
// ET-018 PR-6: native code must be physically unpacked, where the release identity's PE walk sees it.
assertNoPackedNativeCode(archive);
assert.ok(!paths.some(filename => /^\/(test-results|playwright-report|\.local|tests|scripts)(\/|$)/.test(filename)), 'Diagnostic or development files leaked into package');
const read = filename => asar.extractFile(archive, path.normalize(filename));
const metadata = JSON.parse(read('apps/desktop/dist/build-evidence.json'));
assert.deepEqual(metadata.sources, sourceHashes(), 'Package was built from stale source inputs');
assert.equal(metadata.channel, build.channel, `Package was built for the ${metadata.channel} channel, not ${build.channel}`);
assert.equal(metadata.version, build.version, 'Package was built with another version');
// Electron names userData and the single-instance lock after the packaged productName and reports this version.
const packagedManifest = JSON.parse(read('package.json'));
assert.equal(packagedManifest.productName, identity.productName, 'Packaged productName differs from the build channel');
assert.equal(packagedManifest.version, build.version, 'Packaged version differs from the build version');
const files = [];
function collect(directory, prefix = '') {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) collect(path.join(directory, entry.name), `${relative}/`);
    else files.push(relative);
  }
}
collect('apps/desktop/dist');
for (const filename of files) {
  const packaged = `apps/desktop/dist/${filename}`;
  assert.equal(sha256(read(packaged)), sha256(readFileSync(packaged)), `Stale bundled file: ${filename}`);
}
for (const name of ['main', 'preload', 'overlay-preload', 'now-playing-preload', 'telemetry-service', 'storage-worker']) {
  const filename = `apps/desktop/dist/${name}.cjs`;
  assert.equal(asar.statFile(archive, path.normalize(filename)).unpacked, true, `Entrypoint must be physically unpacked: ${name}`);
  assert.equal(sha256(readFileSync(path.join(`${archive}.unpacked`, filename))), sha256(read(filename)));
}
const worker = path.join(`${archive}.unpacked`, 'apps/desktop/dist/storage-worker.cjs');
const resolver = createRequire(worker);
const sqlite = resolver.resolve('better-sqlite3');
assert.ok(sqlite.startsWith(`${archive}.unpacked${path.sep}`), 'Worker dependency resolves outside the package');
const native = path.join(path.dirname(sqlite), '../prebuilds/win32-x64.node');
const nativeBytes = readFileSync(native);
assert.equal(nativeBytes.readUInt16LE(0), 0x5a4d, 'Native binding must be a PE image');
const peOffset = nativeBytes.readUInt32LE(0x3c);
assert.equal(nativeBytes.readUInt16LE(peOffset + 4), 0x8664, 'Native binding must be x64');
const executable = path.join(directory, executableOf(identity));
const report = {checkedUtc: new Date().toISOString(), directory, applicationLaunched: false, channel: build.channel, version: build.version,
  ...integrity,
  asarSha256: sha256(readFileSync(archive)), executableSha256: sha256(readFileSync(executable)),
  nativeSha256: sha256(nativeBytes), compiledFilesVerified: files, sources: metadata.sources};
// The executable's version resource (ET-045h): the product's display name, which Squirrel gives the shortcuts, the
// Start menu folder's CompanyName and the unchanged technical file name. Read with FileVersionInfo; nothing is run.
const versionInfo = readVersionInfo(executable);
assertVersionInfo(versionInfo, identity);
report.versionInfo = versionInfo;
const clientDirectory = path.join(directory, 'resources/telemetry-client');
const clientMetadata = JSON.parse(readFileSync(path.join(clientDirectory, 'build-evidence.json'), 'utf8'));
assert.deepEqual(clientMetadata.sources, metadata.sources, 'Native client and desktop sources differ');
assert.deepEqual(clientMetadata.sources, sourceHashes(), 'Native client built from stale inputs');
// The broker and the plugin accept and serve the same pipes only when both native trees built the same channel.
assert.equal(clientMetadata.channel, build.channel, 'Native client was built for another channel');
assert.equal(readCmakeCacheChannel('native/telemetry-client/build'), build.channel, 'Native client tree is configured for another channel');
assert.equal(readCmakeCacheChannel('native/telemetry-plugin/build'), build.channel, 'Native plugin tree is configured for another channel');
const clientBytes = readFileSync(path.join(clientDirectory, 'telemetry-pipe-client.exe'));
assert.equal(sha256(clientBytes), clientMetadata.executableSha256, 'Native client build hash mismatch');
assert.equal(sha256(clientBytes), sha256(readFileSync('native/telemetry-client/build/Release/telemetry-pipe-client.exe')), 'Packaged client differs from local build');
assert.equal(clientBytes.readUInt16LE(0), 0x5a4d, 'Native client must be a PE executable');
assert.equal(clientBytes.readUInt16LE(clientBytes.readUInt32LE(0x3c) + 4), 0x8664, 'Native client must be x64');
report.nativeClient = {executableSha256: clientMetadata.executableSha256, channel: clientMetadata.channel, sourcesVerified: true};

const mediaDirectory = path.join(directory, 'resources/media-session-reader');
assert.deepEqual(readdirSync(mediaDirectory).sort(), ['build-evidence.json', 'media-session-reader.exe']);
const mediaEvidence = JSON.parse(readFileSync(path.join(mediaDirectory, 'build-evidence.json'), 'utf8'));
assert.deepEqual(mediaEvidence.sources, sourceHashes(), 'Media reader sources are stale');
assert.equal(mediaEvidence.channel, build.channel);
const mediaBytes = readFileSync(path.join(mediaDirectory, 'media-session-reader.exe'));
assert.equal(sha256(mediaBytes), mediaEvidence.executableSha256);
assert.equal(sha256(mediaBytes), sha256(readFileSync('native/media-session-reader/build/Release/media-session-reader.exe')));
assert.equal(mediaBytes.readUInt16LE(0), 0x5a4d);
assert.equal(mediaBytes.readUInt16LE(mediaBytes.readUInt32LE(0x3c) + 4), 0x8664);
assert.ok(!paths.some(filename => /media-session-reader-fixture/i.test(filename)));

report.mediaReader = {executableSha256: mediaEvidence.executableSha256, channel: mediaEvidence.channel, sourcesVerified: true, fixturesExcluded: true};
// The bundled game plugin (ET-017): strict manifest, x64 DLL bytes equal to the local Release build, current plugin
// sources and the tracked released-plugin list. Nothing in the application reads the bundle yet.
const pluginManifest = verifyPluginBundleAgainstTree(path.join(directory, 'resources/telemetry-plugin'), '.', build);
// The DLL's version resource names its channel's file (ET-055 PR-2), so a renamed DLL of the other channel is told apart.
const pluginVersionInfo = readVersionInfo(path.join(directory, 'resources/telemetry-plugin', pluginBundleNames(build.channel).file));
assert.equal(pluginVersionInfo.OriginalFilename, identity.pluginFileName, 'Plugin DLL OriginalFilename differs from the build channel');
assert.equal(pluginVersionInfo.ProductName, identity.displayName, 'Plugin DLL ProductName differs from the build channel');
report.nativePlugin = {file: pluginManifest.file, sha256: pluginManifest.sha256, size: pluginManifest.size, appVersion: pluginManifest.appVersion,
  originalFilename: pluginVersionInfo.OriginalFilename, pluginSourcesVerified: Object.keys(pluginManifest.pluginSources).length, known: pluginManifest.known.length};
// The deferred-cleanup executor (ET-018 PR-5): exactly the tracked script with this build's `$Channel` line (ET-055;
// production's is the tracked script itself), plain ASCII so Windows PowerShell 5.1 reads it without a byte order mark,
// and nothing else in its folder.
const executorDirectory = path.join(directory, 'resources/uninstall');
assert.deepEqual(readdirSync(executorDirectory).sort(), [EXECUTOR_FILE], 'Unexpected files beside the uninstall executor');
const packagedExecutor = readFileSync(path.join(executorDirectory, EXECUTOR_FILE));
assert.equal(sha256(packagedExecutor), sha256(executorBytes(build.channel)), 'Packaged uninstall executor differs from the tracked script stamped with the build channel');
assert.ok(packagedExecutor.length > 0 && packagedExecutor.length <= 256 * 1024 && packagedExecutor.every(byte => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)),
  'Uninstall executor must be plain ASCII within 256 KiB');
report.uninstallExecutor = {sha256: sha256(packagedExecutor), size: packagedExecutor.length};
// The product icon (ET-045g): exactly the build channel's tracked app.ico (resources/icon or resources/staging/icon), alone in its folder. The install and updated
// hooks place it in Squirrel's install root for the Installed apps entry; --installer checks the NuGet package carries it.
const iconDirectory = path.join(directory, 'resources/icon');
assert.deepEqual(readdirSync(iconDirectory).sort(), ['app.ico'], 'Unexpected files beside the packaged product icon');
const iconBytes = readFileSync(path.join(iconDirectory, 'app.ico'));
assert.equal(sha256(iconBytes), sha256(readFileSync(build.channel === 'staging' ? 'resources/staging/icon/app.ico' : 'resources/icon/app.ico')), "Packaged product icon differs from the build channel's tracked icon");
report.productIcon = {sha256: sha256(iconBytes), size: iconBytes.length};
if (installerCheck) report.installer = inspectInstaller({packageDirectory: directory, makeDirectory: path.resolve(MAKE_DIRECTORY), version: build.version, identity});
mkdirSync('.local/diagnostics', {recursive: true});
writeFileSync('.local/diagnostics/package-inspection.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({applicationLaunched: false, channel: build.channel, version: build.version, ...integrity, compiledFilesVerified: files.length, asarSha256: report.asarSha256, executableSha256: report.executableSha256, pluginSha256: report.nativePlugin.sha256,
  uninstallExecutorSha256: report.uninstallExecutor.sha256, productIconSha256: report.productIcon.sha256, versionInfo: report.versionInfo,
  ...(report.installer ? {installer: {setup: report.installer.setup, nupkg: report.installer.nupkg, projectedFiles: report.installer.projectedFiles, additions: report.installer.additions}} : {})}, null, 2));
