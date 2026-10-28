import {spawnSync} from 'node:child_process';
import {cmakeChannelDefinition, readCmakeCacheChannel, resolveBuildChannel} from './build-channel.mjs';

// `npm run native:configure` (ET-055 PR-4): configures the plugin tree native/telemetry-plugin/build for the channel that
// scripts/build-channel.mjs resolves, staging unless a production build is allowed, so a reconfigured tree never keeps the
// channel of an earlier configuration by accident. Extra arguments go to CMake unchanged, for example the generator that
// Windows CI passes: `npm run native:configure -- -G "Visual Studio 17 2022"`.
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native telemetry plugin requires Windows x64');
const channel = resolveBuildChannel();
const directory = 'native/telemetry-plugin/build';
const result = spawnSync('cmake', ['-S', 'native/telemetry-plugin', '-B', directory, '-A', 'x64', cmakeChannelDefinition(channel), ...process.argv.slice(2)],
  {stdio: 'inherit', shell: false, timeout: 600000});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (readCmakeCacheChannel(directory) !== channel) throw new Error(`Native plugin tree is not configured for the ${channel} channel`);
console.log(JSON.stringify({nativePluginConfigured: true, channel}));
