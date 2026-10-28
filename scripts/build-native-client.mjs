import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {cmakeChannelDefinition, readCmakeCacheChannel, resolveBuildChannel} from './build-channel.mjs';
import {sha256, sourceHashes} from './source-inputs.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native telemetry client requires Windows x64');
const inputs = sourceHashes();
// ET-055: the broker accepts and connects to the pipes of this build's channel (channel-identity.hpp), so its tree is
// configured with the channel scripts/build-channel.mjs resolves; stage-native-plugin.mjs passes the same value to the
// plugin tree, and the build evidence records it for scripts/inspect-package.mjs and the broker resolver.
const channel = resolveBuildChannel();
function run(args) {
  const result = spawnSync('cmake', args, {stdio: 'inherit', shell: false, timeout: 180000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native client CMake failed with ${result.status}`);
}
run(['-S', 'native/telemetry-client', '-B', 'native/telemetry-client/build', '-A', 'x64', cmakeChannelDefinition(channel)]);
if (readCmakeCacheChannel('native/telemetry-client/build') !== channel) throw new Error(`Native client tree is not configured for the ${channel} channel`);
// `--parallel` without a job count makes CMake pass `/m` to MSBuild, which builds independent projects in parallel (docs/ci.md).
run(['--build', 'native/telemetry-client/build', '--config', 'Release', '--parallel']);
if (JSON.stringify(inputs) !== JSON.stringify(sourceHashes())) throw new Error('Native client source changed during build');
const executable = 'native/telemetry-client/build/Release/telemetry-pipe-client.exe';
const stage = '.local/package-native/telemetry-client';
mkdirSync(stage, {recursive: true});
copyFileSync(executable, path.join(stage, 'telemetry-pipe-client.exe'));
const evidence = {builtUtc: new Date().toISOString(), channel, executableSha256: sha256(readFileSync(executable)), sources: inputs};
writeFileSync(path.join(stage, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
writeFileSync('native/telemetry-client/build/Release/build-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({nativeClientBuilt: true, channel, executableSha256: evidence.executableSha256}));
