import path from 'node:path';
import {BUILD_CHANNELS, BUILD_IDENTITIES, readCmakeCacheChannel, type BuildIdentity} from '../../scripts/build-channel.mjs';

// ET-055 PR-4: the native chain tests run the plugin and broker of native/telemetry-plugin/build, which pull requests build
// for the default staging channel and main pushes for production. The names those binaries use come from the channel that
// tree was configured for (its CMakeCache.txt), never from the shell's variables.

const checkout = path.resolve(import.meta.dirname, '../..');

/** The build identity of the configured plugin tree native/telemetry-plugin/build. */
export function nativeTreeIdentity(): BuildIdentity {
  const channel = readCmakeCacheChannel(path.join(checkout, 'native/telemetry-plugin/build'));
  if (!(BUILD_CHANNELS as readonly (string | null)[]).includes(channel)) throw new Error(`native/telemetry-plugin/build names no known channel: ${String(channel)}`);
  return BUILD_IDENTITIES[channel as 'production' | 'staging'];
}
