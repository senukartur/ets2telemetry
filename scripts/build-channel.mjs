import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// The build channel resolver (ET-055 UP12, UP13 and UP15; concept.md, "ET-055 in-app updates and staging channel"). It is
// the only place that decides which release channel a build belongs to, and the version that build carries. Every
// consumer takes the result from here: scripts/build.mjs (the esbuild `define` of apps/desktop/src/channel.ts and the
// application version), the native build scripts (`-DETS2TELEMETRY_CHANNEL` of the plugin and the broker tree),
// scripts/stage-native-plugin.mjs and scripts/plugin-bundle.mjs (the DLL and released-list names), forge.config.cjs (the
// Squirrel id, executable, productName, display name and Setup name), scripts/inspect-package.mjs and
// scripts/release-identity.mjs (the expected names and the recorded channel).
//
// ETS2TELEMETRY_BUILD_CHANNEL must be exactly `production` or `staging`; anything else, the empty string included, fails.
// Unset, it is DEFAULT_BUILD_CHANNEL. Nothing at run time switches the channel of a built application.

export const BUILD_CHANNEL_VARIABLE = 'ETS2TELEMETRY_BUILD_CHANNEL';
/** The staging run number (UP15): 1 to 6 digits, zero-padded to 6; read only for staging builds. */
export const STAGING_RUN_NUMBER_VARIABLE = 'ETS2TELEMETRY_STAGING_RUN_NUMBER';
export const BUILD_CHANNELS = Object.freeze(['production', 'staging']);
/** The channel of a build without ETS2TELEMETRY_BUILD_CHANNEL. ET-055 PR-4 makes it staging and adds its guard. */
export const DEFAULT_BUILD_CHANNEL = 'production';

/**
 * The build identities of both channels: the subset of apps/desktop/src/channel.ts that packaging needs. Node scripts do
 * not load that TypeScript module, so the values are mirrored here; tests/unit/channel-identity.test.ts pins every field
 * equal to the table in channel.ts. Production values are the names of every build before ET-055 and never change.
 */
export const BUILD_IDENTITIES = Object.freeze({
  production: Object.freeze({channel: 'production', squirrelId: 'ETS2TelemetryDesktop', executableName: 'ETS2TelemetryDesktop',
    productName: 'ETS2Telemetry Desktop', appBundleId: 'com.ets2telemetry.desktop', displayName: 'Yukon Union Telemetry',
    setupFileTemplate: 'YukonUnionTelemetry-Setup-{version}.exe', pluginFileName: 'ets2telemetry-plugin.dll',
    releasedPluginsFile: 'released-plugins.json'}),
  staging: Object.freeze({channel: 'staging', squirrelId: 'ETS2TelemetryDesktopStaging', executableName: 'ETS2TelemetryDesktopStaging',
    productName: 'ETS2Telemetry Desktop Staging', appBundleId: 'com.ets2telemetry.desktop.staging', displayName: 'Yukon Union Telemetry Staging',
    setupFileTemplate: 'YukonUnionTelemetry-Staging-Setup-{version}.exe', pluginFileName: 'ets2telemetry-plugin-staging.dll',
    releasedPluginsFile: 'released-plugins-staging.json'})
});

/** The package.json version a production build carries as is (the plugin bundle and the Squirrel helpers accept it). */
const PRODUCTION_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** The base of a staging version: a plain release version, so that the tag `staging-v<base>-stg.<run>` matches UP4's pattern. */
const STAGING_BASE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const RUN_NUMBER = /^\d{1,6}$/;

/** The build channel of `env`; throws for any value other than exactly `production` or `staging`. */
export function resolveBuildChannel(env = process.env) {
  const value = env[BUILD_CHANNEL_VARIABLE];
  if (value === undefined) return DEFAULT_BUILD_CHANNEL;
  if (!BUILD_CHANNELS.includes(value)) throw new Error(`${BUILD_CHANNEL_VARIABLE} must be exactly production or staging, not ${JSON.stringify(value)}`);
  return value;
}

/**
 * The version a build of `channel` carries (UP15). Production: the package.json version. Staging:
 * `<package.json version>-stg.<6-digit run number>`, with the run number from ETS2TELEMETRY_STAGING_RUN_NUMBER and
 * `000000` when it is unset (local builds). NuGet turns it into `<base>-stg<6 digits>`, which sorts by the run number.
 */
export function resolveBuildVersion(channel, baseVersion, env = process.env) {
  if (channel === 'production') {
    if (typeof baseVersion !== 'string' || !PRODUCTION_VERSION.test(baseVersion)) throw new Error(`package.json version is not a release version: ${JSON.stringify(baseVersion)}`);
    return baseVersion;
  }
  if (channel !== 'staging') throw new Error(`Unknown build channel ${JSON.stringify(channel)}`);
  if (typeof baseVersion !== 'string' || !STAGING_BASE.test(baseVersion)) throw new Error(`A staging build needs a plain x.y.z package.json version, not ${JSON.stringify(baseVersion)}`);
  const run = env[STAGING_RUN_NUMBER_VARIABLE];
  if (run !== undefined && !RUN_NUMBER.test(run)) throw new Error(`${STAGING_RUN_NUMBER_VARIABLE} must be 1 to 6 digits, not ${JSON.stringify(run)}`);
  return `${baseVersion}-stg.${(run ?? '0').padStart(6, '0')}`;
}

/** The Setup file name of `version` in the build identity `identity`. */
export function buildSetupFileName(identity, version) {
  // A function replacement, so `$` sequences in the version are never read as replacement patterns.
  return identity.setupFileTemplate.replace('{version}', () => version);
}

/**
 * The resolved build: `{channel, identity, baseVersion, version}`. `root` is the checkout whose package.json supplies the
 * base version.
 */
export function resolveBuild({env = process.env, root = '.'} = {}) {
  const channel = resolveBuildChannel(env);
  const baseVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  return Object.freeze({channel, identity: BUILD_IDENTITIES[channel], baseVersion, version: resolveBuildVersion(channel, baseVersion, env)});
}

/** The CMake cache definition that selects `channel` in the plugin and the broker tree (ETS2TELEMETRY_CHANNEL, ET-055 PR-2). */
export function cmakeChannelDefinition(channel) {
  if (!BUILD_CHANNELS.includes(channel)) throw new Error(`Unknown build channel ${JSON.stringify(channel)}`);
  return `-DETS2TELEMETRY_CHANNEL=${channel}`;
}

/** The ETS2TELEMETRY_CHANNEL value of a configured CMake tree, or null when its cache has none. */
export function readCmakeCacheChannel(buildDirectory) {
  const cache = readFileSync(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8');
  return /^ETS2TELEMETRY_CHANNEL:STRING=(.*?)\r?$/m.exec(cache)?.[1] ?? null;
}

// CLI: node scripts/build-channel.mjs — prints the resolved build of this checkout as JSON.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const build = resolveBuild({root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')});
  console.log(JSON.stringify({channel: build.channel, version: build.version, baseVersion: build.baseVersion, executable: `${build.identity.executableName}.exe`,
    setup: buildSetupFileName(build.identity, build.version), plugin: build.identity.pluginFileName}, null, 2));
}
