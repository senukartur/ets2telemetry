import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import * as asar from '@electron/asar';
import {sha256, sourceHashes} from './source-inputs.mjs';
import {verifyPackage} from './package-integrity.mjs';
import {verifyPluginBundleAgainstTree} from './plugin-bundle.mjs';

// Read bytes and resolve paths only. Never import application entries or native bindings.
const directory = path.resolve(process.argv[2] || 'out/ETS2Telemetry Desktop-win32-x64');
const archive = path.join(directory, 'resources/app.asar');
const integrity = verifyPackage(directory);
const paths = asar.listPackage(archive).map(filename => filename.replaceAll('\\', '/'));
assert.ok(!paths.some(filename => /^\/(test-results|playwright-report|\.local|tests|scripts)(\/|$)/.test(filename)), 'Diagnostic or development files leaked into package');
const read = filename => asar.extractFile(archive, path.normalize(filename));
const metadata = JSON.parse(read('apps/desktop/dist/build-evidence.json'));
assert.deepEqual(metadata.sources, sourceHashes(), 'Package was built from stale source inputs');
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
for (const name of ['main', 'preload', 'overlay-preload', 'telemetry-service', 'storage-worker']) {
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
const executable = path.join(directory, 'ETS2TelemetryDesktop.exe');
const report = {checkedUtc: new Date().toISOString(), directory, applicationLaunched: false,
  ...integrity,
  asarSha256: sha256(readFileSync(archive)), executableSha256: sha256(readFileSync(executable)),
  nativeSha256: sha256(nativeBytes), compiledFilesVerified: files, sources: metadata.sources};
const clientDirectory = path.join(directory, 'resources/telemetry-client');
const clientMetadata = JSON.parse(readFileSync(path.join(clientDirectory, 'build-evidence.json'), 'utf8'));
assert.deepEqual(clientMetadata.sources, metadata.sources, 'Native client and desktop sources differ');
assert.deepEqual(clientMetadata.sources, sourceHashes(), 'Native client built from stale inputs');
const clientBytes = readFileSync(path.join(clientDirectory, 'telemetry-pipe-client.exe'));
assert.equal(sha256(clientBytes), clientMetadata.executableSha256, 'Native client build hash mismatch');
assert.equal(sha256(clientBytes), sha256(readFileSync('native/telemetry-client/build/Release/telemetry-pipe-client.exe')), 'Packaged client differs from local build');
assert.equal(clientBytes.readUInt16LE(0), 0x5a4d, 'Native client must be a PE executable');
assert.equal(clientBytes.readUInt16LE(clientBytes.readUInt32LE(0x3c) + 4), 0x8664, 'Native client must be x64');
report.nativeClient = {executableSha256: clientMetadata.executableSha256, sourcesVerified: true};
// The bundled game plugin (ET-017): strict manifest, x64 DLL bytes equal to the local Release build, current plugin
// sources and the tracked released-plugin list. Nothing in the application reads the bundle yet.
const pluginManifest = verifyPluginBundleAgainstTree(path.join(directory, 'resources/telemetry-plugin'));
report.nativePlugin = {sha256: pluginManifest.sha256, size: pluginManifest.size, appVersion: pluginManifest.appVersion,
  pluginSourcesVerified: Object.keys(pluginManifest.pluginSources).length, known: pluginManifest.known.length};
mkdirSync('.local/diagnostics', {recursive: true});
writeFileSync('.local/diagnostics/package-inspection.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({applicationLaunched: false, ...integrity, compiledFilesVerified: files.length, asarSha256: report.asarSha256, executableSha256: report.executableSha256, pluginSha256: report.nativePlugin.sha256}, null, 2));
