import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// The build channel resolver (ET-055 UP12, UP13 and UP15; concept.md, "ET-055 in-app updates and staging channel"). It is
// the only place that decides which release channel a build belongs to, and the version that build carries. Every
// consumer takes the result from here: scripts/build.mjs (the esbuild `define` of apps/desktop/src/channel.ts and the
// application version), the native build scripts (`-DETS2TELEMETRY_CHANNEL` of the plugin and the broker tree),
// scripts/stage-native-plugin.mjs and scripts/plugin-bundle.mjs (the DLL and released-list names), forge.config.cjs (the
// Squirrel id, executable, productName, display name and Setup name), scripts/inspect-package.mjs and
// scripts/release-identity.mjs (the expected names and the recorded channel), and scripts/configure-native-plugin.mjs
// (`npm run native:configure`). The CI, smoke and installer drivers read the channel of the build that was made instead
// (readBuiltBuild, `node scripts/build-channel.mjs --built`).
//
// Agent and feature-test builds are staging (UP13, ET-055 PR-4). Unset, ETS2TELEMETRY_BUILD_CHANNEL is
// DEFAULT_BUILD_CHANNEL, staging. Exactly `staging` is always accepted. Exactly `production` is accepted only on a
// GitHub-hosted Actions runner (GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted) or with the owner-only override
// ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1, so that no local build silently carries the production identities of the
// owner's installed application; otherwise it fails. Any other
// value, the empty string included, fails. Agents never set the production channel or the override. Nothing at run time
// switches the channel of a built application.

export const BUILD_CHANNEL_VARIABLE = 'ETS2TELEMETRY_BUILD_CHANNEL';
/** The owner-only opt-in to a production build outside GitHub Actions; exactly `1`. Agents never set it. */
export const OWNER_PRODUCTION_BUILD_VARIABLE = 'ETS2TELEMETRY_OWNER_PRODUCTION_BUILD';
/** The staging run number (UP15): 1 to 6 digits, zero-padded to 6; read only for staging builds. */
export const STAGING_RUN_NUMBER_VARIABLE = 'ETS2TELEMETRY_STAGING_RUN_NUMBER';
export const BUILD_CHANNELS = Object.freeze(['production', 'staging']);
/** The channel of a build without ETS2TELEMETRY_BUILD_CHANNEL (UP13): agent and feature-test builds are staging. */
export const DEFAULT_BUILD_CHANNEL = 'staging';
/** The build evidence of the desktop bundles, which records the channel and version they were built for (scripts/build.mjs). */
export const DESKTOP_BUILD_EVIDENCE = 'apps/desktop/dist/build-evidence.json';

/**
 * The build identities of both channels: the subset of apps/desktop/src/channel.ts that packaging needs. Node scripts do
 * not load that TypeScript module, so the values are mirrored here; tests/unit/channel-identity.test.ts pins every field
 * equal to the table in channel.ts. Production values are the names of every build before ET-055 and never change.
 */
export const BUILD_IDENTITIES = Object.freeze({
  production: Object.freeze({channel: 'production', squirrelId: 'ETS2TelemetryDesktop', executableName: 'ETS2TelemetryDesktop',
    productName: 'ETS2Telemetry Desktop', appBundleId: 'com.ets2telemetry.desktop', displayName: 'Yukon Union Telemetry',
    setupFileTemplate: 'YukonUnionTelemetry-Setup-{version}.exe', pluginFileName: 'ets2telemetry-plugin.dll',
    releasedPluginsFile: 'released-plugins.json', dataRootName: 'ETS2Telemetry', pipePrefix: '\\\\.\\pipe\\ETS2Telemetry-',
    runOnceValue: 'ETS2TelemetryUninstall', receiptPrefix: 'ETS2Telemetry-uninstall-', legacyShortcutNames: Object.freeze(['ETS2Telemetry Desktop'])}),
  staging: Object.freeze({channel: 'staging', squirrelId: 'ETS2TelemetryStagingDesktop', executableName: 'ETS2TelemetryDesktopStaging',
    productName: 'ETS2Telemetry Desktop Staging', appBundleId: 'com.ets2telemetry.desktop.staging', displayName: 'Yukon Union Telemetry Staging',
    setupFileTemplate: 'YukonUnionTelemetry-Staging-Setup-{version}.exe', pluginFileName: 'ets2telemetry-plugin-staging.dll',
    releasedPluginsFile: 'released-plugins-staging.json', dataRootName: 'ETS2TelemetryStaging', pipePrefix: '\\\\.\\pipe\\ETS2TelemetryStaging-',
    runOnceValue: 'ETS2TelemetryStagingUninstall', receiptPrefix: 'ETS2TelemetryStaging-uninstall-', legacyShortcutNames: Object.freeze([])})
});

/** The package.json version a production build carries as is (the plugin bundle and the Squirrel helpers accept it). */
const PRODUCTION_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** The base of a staging version: a plain release version, so that the tag `staging-v<base>-stg.<run>` matches UP4's pattern. */
const STAGING_BASE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const RUN_NUMBER = /^\d{1,6}$/;

/**
 * Whether `env` may build production (UP13): a GitHub-hosted Actions runner (GITHUB_ACTIONS=true and
 * RUNNER_ENVIRONMENT=github-hosted, the signal the installer guard also requires), or the owner-only override. Every value
 * is exact.
 */
export function productionBuildAllowed(env = process.env) {
  return (env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') || env[OWNER_PRODUCTION_BUILD_VARIABLE] === '1';
}

/**
 * The build channel of `env`: staging when ETS2TELEMETRY_BUILD_CHANNEL is unset or exactly `staging`, production when it
 * is exactly `production` and productionBuildAllowed(env); throws for anything else.
 */
export function resolveBuildChannel(env = process.env) {
  const value = env[BUILD_CHANNEL_VARIABLE];
  if (value === undefined) return DEFAULT_BUILD_CHANNEL;
  if (!BUILD_CHANNELS.includes(value)) throw new Error(`${BUILD_CHANNEL_VARIABLE} must be exactly production or staging, not ${JSON.stringify(value)}`);
  if (value === 'production' && !productionBuildAllowed(env)) {
    throw new Error(`A production build runs only on a GitHub-hosted Actions runner or with the owner-only ${OWNER_PRODUCTION_BUILD_VARIABLE}=1. ` +
      `Agent and feature-test builds are staging: unset ${BUILD_CHANNEL_VARIABLE} (docs/setup.md, "Build channels").`);
  }
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

/** Forge's package folder of a build identity, relative to the checkout: `out/<productName>-win32-x64`. */
export function packageDirectoryName(identity) {
  return `out/${identity.productName}-win32-x64`;
}

/**
 * The build the desktop bundles of `root` were made for, from their build evidence (DESKTOP_BUILD_EVIDENCE):
 * `{channel, identity, version}`. The smoke and installer drivers name the package, executable, data root and plugin from
 * it, so they follow the build that was actually made and never the variables of the shell that runs them. Throws when the
 * evidence is missing or names no known channel.
 */
export function readBuiltBuild(root = '.') {
  const evidence = JSON.parse(readFileSync(path.join(root, DESKTOP_BUILD_EVIDENCE), 'utf8'));
  if (!BUILD_CHANNELS.includes(evidence?.channel)) throw new Error(`${DESKTOP_BUILD_EVIDENCE} names no known build channel: ${JSON.stringify(evidence?.channel)}`);
  if (typeof evidence.version !== 'string' || !PRODUCTION_VERSION.test(evidence.version)) throw new Error(`${DESKTOP_BUILD_EVIDENCE} names no build version`);
  return Object.freeze({channel: evidence.channel, identity: BUILD_IDENTITIES[evidence.channel], version: evidence.version});
}

/** The names a driver needs of a build (`{channel, identity, version}`), as plain JSON-ready values. */
export function buildNames({channel, identity, version}) {
  return {channel, version, packageDirectory: packageDirectoryName(identity), executable: `${identity.executableName}.exe`,
    setup: buildSetupFileName(identity, version), plugin: identity.pluginFileName, squirrelId: identity.squirrelId, productName: identity.productName,
    displayName: identity.displayName, dataRootName: identity.dataRootName, pipePrefix: identity.pipePrefix, runOnceValue: identity.runOnceValue,
    receiptPrefix: identity.receiptPrefix, legacyShortcutNames: [...identity.legacyShortcutNames]};
}

// CLI: `node scripts/build-channel.mjs` prints the build this environment resolves; `--built` prints the build the desktop
// bundles were made for (readBuiltBuild), which the PowerShell smoke and installer drivers read.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--built')) throw new Error('Usage: node scripts/build-channel.mjs [--built]');
  const build = args[0] === '--built' ? readBuiltBuild(root) : resolveBuild({root});
  console.log(JSON.stringify({...buildNames(build), ...(args[0] === '--built' ? {} : {baseVersion: build.baseVersion})}, null, 2));
}
