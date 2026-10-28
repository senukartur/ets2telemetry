import path from 'node:path';
import {BUILD_CHANNELS, BUILD_IDENTITIES} from '../build-channel.mjs';

// ET-055 PR-4: the build a runtime smoke runs. Invoke-RuntimeSmoke.ps1 records the channel and the application version in
// the run's config from the build that was actually made (`node scripts/build-channel.mjs --built`, the desktop build
// evidence) in every mode. A packaged run also checks the package's broker evidence names that channel; an installed run
// requires that channel's install layout (ET-055 PR-5: the installer lifecycle installs either channel). Pull requests run staging packages and main
// pushes production ones, so every name a smoke checks that differs between the channels comes from here: the isolated
// data root, the plugin file, the display name inside user-facing copy and the version an export records.

/** `{channel, identity, version}` of the run's config; throws for a config without a known channel or a version. */
export function smokeBuild(config) {
  if (!BUILD_CHANNELS.includes(config?.channel)) throw new Error(`SMOKE_CHANNEL_UNKNOWN: ${JSON.stringify(config?.channel)}`);
  if (typeof config.appVersion !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(config.appVersion)) throw new Error('SMOKE_APP_VERSION_UNKNOWN');
  return {channel: config.channel, identity: BUILD_IDENTITIES[config.channel], version: config.appVersion};
}

/** The application's data root inside the run's isolated LOCALAPPDATA: `<LOCALAPPDATA>\ETS2Telemetry` or `...\ETS2TelemetryStaging`. */
export const smokeDataRoot = config => path.join(config.localappdata, smokeBuild(config).identity.dataRootName);

/** The display name user-facing copy names: "Yukon Union Telemetry" or "Yukon Union Telemetry Staging". */
export const smokeDisplayName = config => smokeBuild(config).identity.displayName;
