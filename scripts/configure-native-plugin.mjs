import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {cmakeChannelDefinition, readCmakeCacheChannel, resolveBuildChannel} from './build-channel.mjs';

// `npm run native:configure` (ET-055 PR-4): configures the plugin tree native/telemetry-plugin/build for the channel that
// scripts/build-channel.mjs resolves, staging unless a production build is allowed, so a reconfigured tree never keeps the
// channel of an earlier configuration by accident. Extra arguments go to CMake, for example the generator that Windows CI
// passes: `npm run native:configure -- -G "Visual Studio 17 2022"`. An argument that could set, load or remove the channel
// instead of the resolver is refused before CMake runs (refusedConfigureArgument), because CMake applies the last
// definition it sees and the tree would keep that channel.

/**
 * The first extra argument that could choose the channel instead of the resolver, or null: a `-D` definition of
 * ETS2TELEMETRY_CHANNEL in any form (`-DETS2TELEMETRY_CHANNEL=…`, `-DETS2TELEMETRY_CHANNEL:STRING=…`, `-D
 * ETS2TELEMETRY_CHANNEL=…` as two arguments, any letter case), an initial cache script (`-C`), a cache entry removal (`-U`)
 * or a preset (`--preset`), each in any spelling CMake accepts.
 */
export function refusedConfigureArgument(args) {
  for (const [index, argument] of args.entries()) {
    if (typeof argument !== 'string') return String(argument);
    if (/^-D\s*ETS2TELEMETRY_CHANNEL/i.test(argument)) return argument;
    if (argument === '-D' && /^\s*ETS2TELEMETRY_CHANNEL/i.test(args[index + 1] ?? '')) return `${argument} ${args[index + 1]}`;
    if (/^-[CU]/.test(argument) || /^--preset(=|$)/.test(argument)) return argument;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native telemetry plugin requires Windows x64');
  const extra = process.argv.slice(2);
  const refused = refusedConfigureArgument(extra);
  if (refused !== null) {
    throw new Error(`native:configure sets the build channel itself; refusing the CMake argument ${JSON.stringify(refused)}. ` +
      'Choose the channel with ETS2TELEMETRY_BUILD_CHANNEL (docs/setup.md, "Build channels").');
  }
  const channel = resolveBuildChannel();
  const directory = 'native/telemetry-plugin/build';
  const result = spawnSync('cmake', ['-S', 'native/telemetry-plugin', '-B', directory, '-A', 'x64', cmakeChannelDefinition(channel), ...extra],
    {stdio: 'inherit', shell: false, timeout: 600000});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (readCmakeCacheChannel(directory) !== channel) throw new Error(`Native plugin tree is not configured for the ${channel} channel`);
  console.log(JSON.stringify({nativePluginConfigured: true, channel}));
}
