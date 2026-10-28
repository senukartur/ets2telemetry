import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {cmakeChannelDefinition, readCmakeCacheChannel, resolveBuild} from './build-channel.mjs';
import {PLUGIN_STAGE, pluginBundleNames, pluginSourceHashes, readReleasedPlugins, writePluginBundle} from './plugin-bundle.mjs';

// Builds the Release game plugin and stages it with its manifest for Forge (docs/plugin-setup.md#bundle-format).
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native telemetry plugin requires Windows x64');
// ET-055: the plugin tree builds this build's channel (scripts/build-channel.mjs), the same value build-native-client.mjs
// gives the broker tree; CMake names the DLL after it, and the bundle carries the channel's released list and version.
const build = resolveBuild();
const names = pluginBundleNames(build.channel);
const sources = pluginSourceHashes();
const known = readReleasedPlugins(names.released);
function run(args) {
  const result = spawnSync('cmake', args, {stdio: 'inherit', shell: false, timeout: 600000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native plugin CMake failed with ${result.status}`);
}
// Reuse an existing tree and its generator: CI configures it with `-G 'Visual Studio 17 2022'` first (docs/ci.md). An
// existing tree is configured again only to set the channel, which keeps its generator and every other cache entry.
if (!existsSync('native/telemetry-plugin/build/CMakeCache.txt')) run(['-S', 'native/telemetry-plugin', '-B', 'native/telemetry-plugin/build', '-A', 'x64', cmakeChannelDefinition(build.channel)]);
else if (readCmakeCacheChannel('native/telemetry-plugin/build') !== build.channel) run(['-S', 'native/telemetry-plugin', '-B', 'native/telemetry-plugin/build', cmakeChannelDefinition(build.channel)]);
if (readCmakeCacheChannel('native/telemetry-plugin/build') !== build.channel) throw new Error(`Native plugin tree is not configured for the ${build.channel} channel`);
run(['--build', 'native/telemetry-plugin/build', '--target', 'ets2telemetry-plugin', '--config', 'Release', '--parallel']);
if (JSON.stringify(sources) !== JSON.stringify(pluginSourceHashes())) throw new Error('Native plugin source changed during build');
rmSync(PLUGIN_STAGE, {recursive: true, force: true});
const manifest = writePluginBundle(PLUGIN_STAGE, {dll: readFileSync(names.built), appVersion: build.version, pluginSources: sources, known, channel: build.channel});
console.log(JSON.stringify({nativePluginStaged: true, channel: build.channel, file: manifest.file, sha256: manifest.sha256, size: manifest.size, known: manifest.known.length}));
