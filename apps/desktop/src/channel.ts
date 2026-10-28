// The build channel's installation identities (ET-055 UP12; concept.md, "ET-055 in-app updates and staging channel").
//
// A build belongs to one channel, `production` or `staging`. Every name two installations would otherwise share (the
// Squirrel id and install root, the executable, userData, the shortcut AUMID and autostart value, the data root, the
// plugin DLL, the pipes and transport folders, the RunOnce value and the uninstall receipts) comes from this table, so
// both channels can be installed and run side by side. Production values are byte-identical to the builds before ET-055,
// and tests/unit/channel-identity.test.ts pins them.
//
// The active channel is fixed when the build is made; nothing at runtime switches it. Until the build-time selection
// lands (ET-055 PR-3), every build is production. This module is pure data with no Node.js import, so main, the service,
// preloads and renderers may all import it; callers join the names into paths themselves.

export type ReleaseChannel = 'production' | 'staging';
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = Object.freeze(['production', 'staging'] as const);

export interface ChannelIdentity {
  readonly channel: ReleaseChannel;
  /**
   * The Squirrel id (forge.config.cjs `squirrel.name`): the install root `%LOCALAPPDATA%\<id>`, the HKCU Uninstall key,
   * the nupkg name and the AUMID's first part. The staging id starts with the production id, so compare it exactly.
   */
  readonly squirrelId: string;
  /** The executable's file name without `.exe` (forge.config.cjs `executableName`, OriginalFilename). */
  readonly executableName: string;
  /** Electron's productName: `%APPDATA%\<productName>` (userData, the O7 Roaming folder), the single-instance lock, `out/`. */
  readonly productName: string;
  /** forge.config.cjs `appBundleId`. */
  readonly appBundleId: string;
  /** Squirrel's shortcut AUMID `com.squirrel.<id>.<exe>`, which Electron also uses as the autostart Run value name. */
  readonly appUserModelId: string;
  /** What Windows and the window show: the nuspec title, ProductName, FileDescription, the shortcuts, window and tray. */
  readonly displayName: string;
  /** The Setup file name with `{version}` in place of the application version. */
  readonly setupFileTemplate: string;
  /** Shortcut names of earlier builds of this channel that the install and update hooks migrate (ET-045h). */
  readonly legacyShortcutNames: readonly string[];
  /** The data root's folder name under %LOCALAPPDATA%: `<base>\<squirrelId>` derives `<base>\<dataRootName>` (ET-018 U3). */
  readonly dataRootName: string;
  /** The game plugin's DLL name in the plugins folder and in the bundle. */
  readonly pluginFileName: string;
  /** The named-pipe prefix of the plugin's v0, v1 and CAP0 endpoints. */
  readonly pipePrefix: string;
  /** The HKCU RunOnce value of the deferred uninstall cleanup (ET-018 O3). */
  readonly runOnceValue: string;
  /** The prefix of the `%TEMP%` uninstall receipt file. */
  readonly receiptPrefix: string;
  /** The released plugin list in `native/telemetry-plugin/` (docs/plugin-setup.md, "Released plugin list"). */
  readonly releasedPluginsFile: string;
  /** Data root folder names under %LOCALAPPDATA% that an export target may never lie in. */
  readonly exportRefusalDataRootNames: readonly string[];
}

/** The transport folder under the data root, holding the plugin's discovery records and the v1 service policy. */
export const TRANSPORT_DIRECTORY = 'transport';

function identity(fields: Omit<ChannelIdentity, 'appUserModelId'>): ChannelIdentity {
  return Object.freeze({...fields, appUserModelId: `com.squirrel.${fields.squirrelId}.${fields.executableName}`,
    legacyShortcutNames: Object.freeze([...fields.legacyShortcutNames]),
    exportRefusalDataRootNames: Object.freeze([...fields.exportRefusalDataRootNames])});
}

export const CHANNEL_IDENTITIES: Readonly<Record<ReleaseChannel, ChannelIdentity>> = Object.freeze({
  production: identity({
    channel: 'production',
    squirrelId: 'ETS2TelemetryDesktop',
    executableName: 'ETS2TelemetryDesktop',
    productName: 'ETS2Telemetry Desktop',
    appBundleId: 'com.ets2telemetry.desktop',
    displayName: 'Yukon Union Telemetry',
    setupFileTemplate: 'YukonUnionTelemetry-Setup-{version}.exe',
    legacyShortcutNames: ['ETS2Telemetry Desktop'],
    dataRootName: 'ETS2Telemetry',
    pluginFileName: 'ets2telemetry-plugin.dll',
    pipePrefix: '\\\\.\\pipe\\ETS2Telemetry-',
    runOnceValue: 'ETS2TelemetryUninstall',
    receiptPrefix: 'ETS2Telemetry-uninstall-',
    releasedPluginsFile: 'released-plugins.json',
    exportRefusalDataRootNames: ['ETS2Telemetry']
  }),
  staging: identity({
    channel: 'staging',
    squirrelId: 'ETS2TelemetryDesktopStaging',
    executableName: 'ETS2TelemetryDesktopStaging',
    productName: 'ETS2Telemetry Desktop Staging',
    appBundleId: 'com.ets2telemetry.desktop.staging',
    displayName: 'Yukon Union Telemetry Staging',
    setupFileTemplate: 'YukonUnionTelemetry-Staging-Setup-{version}.exe',
    legacyShortcutNames: [],
    dataRootName: 'ETS2TelemetryStaging',
    pluginFileName: 'ets2telemetry-plugin-staging.dll',
    pipePrefix: '\\\\.\\pipe\\ETS2TelemetryStaging-',
    runOnceValue: 'ETS2TelemetryStagingUninstall',
    receiptPrefix: 'ETS2TelemetryStaging-uninstall-',
    releasedPluginsFile: 'released-plugins-staging.json',
    exportRefusalDataRootNames: ['ETS2TelemetryStaging', 'ETS2Telemetry']
  })
});

/**
 * The channel this build belongs to. ET-055 PR-3 replaces the initializer with the build-time selection; until then
 * every build is production.
 */
export const ACTIVE_CHANNEL = 'production' as ReleaseChannel;

/** The identities of this build's channel. */
export const CHANNEL: ChannelIdentity = CHANNEL_IDENTITIES[ACTIVE_CHANNEL];

/** The Setup file name of `version` in `channel`. */
export function setupFileName(version: string, channel: ChannelIdentity = CHANNEL): string {
  return channel.setupFileTemplate.replace('{version}', version);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The installer's temporary file beside the plugin: `<plugin file>.<16 hex>.tmp` (ET-017 PR-3). */
export function pluginTempFilePattern(channel: ChannelIdentity = CHANNEL): RegExp {
  return new RegExp(`^${escapeRegExp(channel.pluginFileName)}\\.[0-9a-f]{16}\\.tmp$`);
}
