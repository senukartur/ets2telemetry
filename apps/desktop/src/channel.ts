// The build channel's installation identities (ET-055 UP12; concept.md, "ET-055 in-app updates and staging channel").
//
// A build belongs to one channel, `production` or `staging`. Every name two installations would otherwise share (the
// Squirrel id and install root, the executable, userData, the shortcut AUMID and autostart value, the data root, the
// plugin DLL, the pipes and transport folders, the RunOnce value and the uninstall receipts) comes from this table, so
// both channels can be installed and run side by side. Production values are byte-identical to the builds before ET-055,
// and tests/unit/channel-identity.test.ts pins them.
//
// The active channel is fixed when the build is made; nothing at runtime switches it. scripts/build-channel.mjs resolves
// it and scripts/build.mjs replaces __ETS2TELEMETRY_BUILD_CHANNEL__ below in every bundle (main, the service, the storage
// worker, both preloads and the renderers). This module is pure data with no Node.js import, so all of them may import it;
// callers join the names into paths themselves.

export type ReleaseChannel = 'production' | 'staging';
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = Object.freeze(['production', 'staging'] as const);

export interface ChannelIdentity {
  readonly channel: ReleaseChannel;
  /**
   * The Squirrel id (forge.config.cjs `squirrel.name`): the install root `%LOCALAPPDATA%\<id>`, the HKCU Uninstall key,
   * the nupkg name and the AUMID's first part. Compare it exactly. Neither channel's id may be a case-insensitive string
   * prefix of the other's: Squirrel.Windows takes every process whose path merely starts with its install root, without a
   * separator, as its own (UpdateManager.InstallHelpers.cs, KillAllProcessesBelongingToPackage), so with the earlier
   * staging id ETS2TelemetryDesktopStaging a production uninstall ended a running staging application (ET-055,
   * BESIDE_INSTANCE_ENDED). tests/unit/channel-identity.test.ts guards this.
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
  /**
   * The data root's folder name under %LOCALAPPDATA%: `<base>\<squirrelId>` derives `<base>\<dataRootName>` (ET-018 U3).
   * Data root names are string prefixes of other roots (ETS2Telemetry of ETS2TelemetryStaging and of both install roots,
   * ETS2TelemetryStaging of the staging install root), so every comparison of a data root is exact or separator-aware.
   * Squirrel never sees a data root, and no install root is a string prefix of one.
   */
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
    squirrelId: 'ETS2TelemetryStagingDesktop',
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

/** Replaced by scripts/build.mjs with the resolved build channel; undefined where no build defines it. */
declare const __ETS2TELEMETRY_BUILD_CHANNEL__: string | undefined;

/** The build-time channel name, checked against the table: an unknown value fails the bundle at load, never silently. */
function buildChannel(value: string | undefined): ReleaseChannel {
  // Unbundled code (Vitest, the storage test bundles, type checks) has no build define and is production.
  if (value === undefined) return 'production';
  if (!(RELEASE_CHANNELS as readonly string[]).includes(value)) throw new Error(`Unknown build channel: ${value}`);
  return value as ReleaseChannel;
}

/** The channel this build belongs to, from the build-time define (scripts/build-channel.mjs). */
export const ACTIVE_CHANNEL: ReleaseChannel = buildChannel(typeof __ETS2TELEMETRY_BUILD_CHANNEL__ === 'undefined' ? undefined : __ETS2TELEMETRY_BUILD_CHANNEL__);

/** The identities of this build's channel. */
export const CHANNEL: ChannelIdentity = CHANNEL_IDENTITIES[ACTIVE_CHANNEL];

/** The Setup file name of `version` in `channel`. */
export function setupFileName(version: string, channel: ChannelIdentity = CHANNEL): string {
  // A function replacement, so `$` sequences in the version are never read as replacement patterns.
  return channel.setupFileTemplate.replace('{version}', () => version);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The installer's temporary file beside the plugin: `<plugin file>.<16 hex>.tmp` (ET-017 PR-3). */
export function pluginTempFilePattern(channel: ChannelIdentity = CHANNEL): RegExp {
  return new RegExp(`^${escapeRegExp(channel.pluginFileName)}\\.[0-9a-f]{16}\\.tmp$`);
}

/**
 * User-facing copy in the channel `channel`: the copy is written with the production names, and a staging build shows its
 * own display name, data and install roots, Roaming folder and plugin file instead. Production text is returned
 * unchanged, so production copy stays byte-identical. Only whole names are replaced; game data never passes through this.
 */
export function channelCopy(text: string, channel: ChannelIdentity = CHANNEL): string {
  if (channel.channel === 'production') return text;
  const production = CHANNEL_IDENTITIES.production;
  const productionRoot = '%LOCALAPPDATA%\\' + production.dataRootName;
  // The export refusal names every data root the channel refuses (UP12: a staging export refuses both). Its folder list
  // goes in as a placeholder, so the root renaming below never turns the production root of that list into staging's.
  const roots = channel.exportRefusalDataRootNames.map(name => '%LOCALAPPDATA%\\' + name);
  const LIST = '\uE000', refusals: [string, string][] = roots.length < 2 ? [] : [
    [`data folder, ${productionRoot}.`, `data folders, ${LIST}en${LIST}.`],
    [`вне папки данных ${production.displayName}, ${productionRoot}.`, `вне папок данных ${production.displayName}: ${LIST}ru${LIST}.`]
  ];
  // [from, to] in this order: the install root before the data root it starts with. A name followed by a letter or digit
  // is another name and stays; the staging display name is never extended twice.
  const names: [string, string, string][] = [
    ['%LOCALAPPDATA%\\' + production.squirrelId, '%LOCALAPPDATA%\\' + channel.squirrelId, ''],
    [productionRoot, '%LOCALAPPDATA%\\' + channel.dataRootName, ''],
    ['%APPDATA%\\' + production.productName, '%APPDATA%\\' + channel.productName, ''],
    [production.pluginFileName, channel.pluginFileName, ''],
    [production.displayName, channel.displayName, '(?! Staging)']
  ];
  const listed = refusals.reduce((rest, [from, to]) => rest.split(from).join(to), text);
  const renamed = names.reduce((rest, [from, to, guard]) => rest.replace(new RegExp(`${escapeRegExp(from)}${guard}(?![A-Za-z0-9])`, 'g'), () => to), listed);
  return renamed.replace(/\uE000(en|ru)\uE000/g, (_match, language: string) => roots.join(language === 'ru' ? ' и ' : ' and '));
}

/**
 * A copy table in the channel `channel`: every string value, also inside arrays and plain objects, through channelCopy;
 * keys and other values are kept, and a frozen object or array stays frozen. Production returns `table` itself.
 */
export function channelCopyTable<T>(table: T, channel: ChannelIdentity = CHANNEL): T {
  if (channel.channel === 'production') return table;
  const keepFrozen = <V extends object>(source: object, copy: V): V => Object.isFrozen(source) ? Object.freeze(copy) : copy;
  const translate = (value: unknown): unknown => typeof value === 'string' ? channelCopy(value, channel)
    : Array.isArray(value) ? keepFrozen(value, value.map(translate))
    : value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
      ? keepFrozen(value, Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]))) : value;
  return translate(table) as T;
}
