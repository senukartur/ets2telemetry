import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {BUILT_PLUGIN, PLUGIN_STAGE, RELEASED_PLUGINS, pluginSourceHashes, readReleasedPlugins, writePluginBundle} from './plugin-bundle.mjs';

// Builds the Release game plugin and stages it with its manifest for Forge (docs/plugin-setup.md#bundle-format).
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native telemetry plugin requires Windows x64');
const sources = pluginSourceHashes();
const known = readReleasedPlugins(RELEASED_PLUGINS);
const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
function run(args) {
  const result = spawnSync('cmake', args, {stdio: 'inherit', shell: false, timeout: 600000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native plugin CMake failed with ${result.status}`);
}
// Reuse an existing tree and its generator: CI configures it with `-G 'Visual Studio 17 2022'` first (docs/ci.md).
if (!existsSync('native/telemetry-plugin/build/CMakeCache.txt')) run(['-S', 'native/telemetry-plugin', '-B', 'native/telemetry-plugin/build', '-A', 'x64']);
run(['--build', 'native/telemetry-plugin/build', '--target', 'ets2telemetry-plugin', '--config', 'Release', '--parallel']);
if (JSON.stringify(sources) !== JSON.stringify(pluginSourceHashes())) throw new Error('Native plugin source changed during build');
rmSync(PLUGIN_STAGE, {recursive: true, force: true});
const manifest = writePluginBundle(PLUGIN_STAGE, {dll: readFileSync(BUILT_PLUGIN), appVersion, pluginSources: sources, known});
console.log(JSON.stringify({nativePluginStaged: true, sha256: manifest.sha256, size: manifest.size, known: manifest.known.length}));
