import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ACTIVE_CHANNEL, CHANNEL, CHANNEL_IDENTITIES, channelCopy, channelCopyTable, pluginTempFilePattern, RELEASE_CHANNELS, setupFileName, TRANSPORT_DIRECTORY,
  type ChannelIdentity} from '../../apps/desktop/src/channel';
import {brokerDiscoveryDirectory} from '../../apps/desktop/src/broker-artifact';
import {uninstallEntryKey} from '../../apps/desktop/src/installed-app-icon';
import {LEGACY_SHORTCUT_NAMES, SHORTCUT_NAME, SQUIRREL_APP_ID} from '../../apps/desktop/src/legacy-shortcuts';
import {mainLogLocation, serviceLogLocation} from '../../apps/desktop/src/log-location';
import {v1BrokerConfiguration} from '../../apps/desktop/src/native-pipe-client';
import {dataPaths} from '../../apps/desktop/src/paths';
import {PLUGIN_BUNDLE_FILE} from '../../apps/desktop/src/plugin-setup/plugin-bundle';
import {PLUGIN_TEMP_FILE} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {PLUGIN_FILE_NAME} from '../../apps/desktop/src/plugin-setup/steam-discovery';
import {RECEIPT_PREFIX, ROAMING_USER_DATA_NAME} from '../../apps/desktop/src/squirrel-events';
import {STRINGS, STRINGS_RU} from '../../apps/desktop/src/strings';
import {RUN_ONCE_VALUE} from '../../apps/desktop/src/uninstall/executor';
import {DATA_ROOT_NAME, PRODUCT_ROOT_NAME} from '../../apps/desktop/src/uninstall/roots';
import {HISTORY_DATA_ROOT_NAMES, isHistoryFile} from '../../packages/storage/src/history-file';
import {BUILD_IDENTITIES} from '../../scripts/build-channel.mjs';
import {pluginBundleNames} from '../../scripts/plugin-bundle.mjs';
import {stampExecutorChannel} from '../../scripts/uninstall-executor.mjs';
import {forgeConfig, squirrelConfig} from '../shared/forge-config';

// ET-055 UP12 (REG-015, REG-017): the installation identities of both build channels. Production values are pinned to the
// literals every build before ET-055 used, so routing them through the channel table changes no file name, path, pipe,
// registry value or display string. Staging values are the owner-approved names, and no identity of one channel may equal
// one of the other, or the two installations would share an install root, data, plugin, pipe or registry value.

const checkout = path.resolve(import.meta.dirname, '..', '..');

const PRODUCTION = {
  channel: 'production',
  squirrelId: 'ETS2TelemetryDesktop',
  executableName: 'ETS2TelemetryDesktop',
  productName: 'ETS2Telemetry Desktop',
  appBundleId: 'com.ets2telemetry.desktop',
  appUserModelId: 'com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop',
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
};

const STAGING = {
  channel: 'staging',
  squirrelId: 'ETS2TelemetryDesktopStaging',
  executableName: 'ETS2TelemetryDesktopStaging',
  productName: 'ETS2Telemetry Desktop Staging',
  appBundleId: 'com.ets2telemetry.desktop.staging',
  appUserModelId: 'com.squirrel.ETS2TelemetryDesktopStaging.ETS2TelemetryDesktopStaging',
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
};

/** Every identity a channel owns alone; the export refusal list deliberately names the other channel's data root too. */
const OWNED: readonly (keyof ChannelIdentity)[] = ['squirrelId', 'executableName', 'productName', 'appBundleId', 'appUserModelId', 'displayName',
  'setupFileTemplate', 'dataRootName', 'pluginFileName', 'pipePrefix', 'runOnceValue', 'receiptPrefix', 'releasedPluginsFile'];
const owned = (identity: ChannelIdentity) => [...OWNED.map(key => identity[key] as string), ...identity.legacyShortcutNames];

describe('the channel identity table', () => {
  it('pins every production identity to the literal of the builds before ET-055', () => {
    expect(CHANNEL_IDENTITIES.production).toEqual(PRODUCTION);
    expect(setupFileName('0.1.1', CHANNEL_IDENTITIES.production)).toBe('YukonUnionTelemetry-Setup-0.1.1.exe');
    expect(pluginTempFilePattern(CHANNEL_IDENTITIES.production).source).toBe(/^ets2telemetry-plugin\.dll\.[0-9a-f]{16}\.tmp$/.source);
    expect(TRANSPORT_DIRECTORY).toBe('transport');
  });

  it('gives staging the approved names', () => {
    expect(CHANNEL_IDENTITIES.staging).toEqual(STAGING);
    expect(setupFileName('0.2.0-stg.000042', CHANNEL_IDENTITIES.staging)).toBe('YukonUnionTelemetry-Staging-Setup-0.2.0-stg.000042.exe');
    expect(RELEASE_CHANNELS).toEqual(['production', 'staging']);
  });

  it('shares no identity between the two channels', () => {
    const production = owned(CHANNEL_IDENTITIES.production), staging = owned(CHANNEL_IDENTITIES.staging);
    expect(production.filter(value => staging.includes(value))).toEqual([]);
    // Case-insensitive too: Windows compares file, folder, registry and pipe names without case.
    const lower = new Set(production.map(value => value.toLowerCase()));
    expect(staging.filter(value => lower.has(value.toLowerCase()))).toEqual([]);
    for (const identity of [CHANNEL_IDENTITIES.production, CHANNEL_IDENTITIES.staging]) expect(new Set(identity.exportRefusalDataRootNames).has(identity.dataRootName)).toBe(true);
  });

  it('needs exact comparison: the staging Squirrel id and data root start with the production ones', () => {
    // A prefix check would take a staging install root or package for a production one; every comparison is exact.
    expect(STAGING.squirrelId.startsWith(PRODUCTION.squirrelId)).toBe(true);
    expect(STAGING.squirrelId).not.toBe(PRODUCTION.squirrelId);
    expect(STAGING.dataRootName.startsWith(PRODUCTION.dataRootName)).toBe(true);
    // Pipe names do not nest: neither channel's endpoints match the other's prefix.
    expect(STAGING.pipePrefix.startsWith(PRODUCTION.pipePrefix)).toBe(false);
    expect(PRODUCTION.pipePrefix.startsWith(STAGING.pipePrefix)).toBe(false);
  });

  it("keeps each channel's plugin temporary files apart", () => {
    const productionTemp = 'ets2telemetry-plugin.dll.0123456789abcdef.tmp', stagingTemp = 'ets2telemetry-plugin-staging.dll.0123456789abcdef.tmp';
    expect(pluginTempFilePattern(CHANNEL_IDENTITIES.production).test(productionTemp)).toBe(true);
    expect(pluginTempFilePattern(CHANNEL_IDENTITIES.production).test(stagingTemp)).toBe(false);
    expect(pluginTempFilePattern(CHANNEL_IDENTITIES.staging).test(stagingTemp)).toBe(true);
    expect(pluginTempFilePattern(CHANNEL_IDENTITIES.staging).test(productionTemp)).toBe(false);
  });
});

describe('the routed identities of this build', () => {
  // ET-055 PR-3 added the build-time selection: scripts/build.mjs defines the channel in every bundle. Unbundled code, as
  // under Vitest, has no define and is production.
  it('is production where no build defines the channel', () => {
    expect(ACTIVE_CHANNEL).toBe('production');
    expect(CHANNEL).toBe(CHANNEL_IDENTITIES.production);
  });

  it('keeps every routed constant byte-identical in production', () => {
    expect({PRODUCT_ROOT_NAME, DATA_ROOT_NAME, SQUIRREL_APP_ID, SHORTCUT_NAME, LEGACY_SHORTCUT_NAMES, PLUGIN_FILE_NAME, PLUGIN_BUNDLE_FILE,
      PLUGIN_TEMP_FILE: PLUGIN_TEMP_FILE.source, RECEIPT_PREFIX, ROAMING_USER_DATA_NAME, RUN_ONCE_VALUE, appName: STRINGS.appName, appNameRu: STRINGS_RU.appName})
      .toEqual({PRODUCT_ROOT_NAME: 'ETS2TelemetryDesktop', DATA_ROOT_NAME: 'ETS2Telemetry', SQUIRREL_APP_ID: 'ETS2TelemetryDesktop',
        SHORTCUT_NAME: 'Yukon Union Telemetry', LEGACY_SHORTCUT_NAMES: ['ETS2Telemetry Desktop'], PLUGIN_FILE_NAME: 'ets2telemetry-plugin.dll',
        PLUGIN_BUNDLE_FILE: 'ets2telemetry-plugin.dll', PLUGIN_TEMP_FILE: /^ets2telemetry-plugin\.dll\.[0-9a-f]{16}\.tmp$/.source,
        RECEIPT_PREFIX: 'ETS2Telemetry-uninstall-', ROAMING_USER_DATA_NAME: 'ETS2Telemetry Desktop', RUN_ONCE_VALUE: 'ETS2TelemetryUninstall',
        appName: 'Yukon Union Telemetry', appNameRu: 'Yukon Union Telemetry'});
    expect(uninstallEntryKey()).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ETS2TelemetryDesktop');
  });

  it('keeps the production data, log and transport paths', () => {
    const local = path.resolve('C:\\Users\\driver\\AppData\\Local');
    expect(dataPaths(local).root).toBe(path.join(local, 'ETS2Telemetry'));
    expect(mainLogLocation({LOCALAPPDATA: local}, 'unused').directory).toBe(path.join(local, 'ETS2Telemetry', 'logs'));
    expect(serviceLogLocation({LOCALAPPDATA: local}, 'unused').directory).toBe(path.join(local, 'ETS2Telemetry', 'logs', 'service'));
    // The broker's v0 discovery directory, as broker-artifact.ts builds it, and the v1 sibling the service derives from it.
    const v0 = brokerDiscoveryDirectory(local);
    expect(v0).toBe(path.join(local, 'ETS2Telemetry', 'transport', 'v0'));
    expect(brokerDiscoveryDirectory(local, CHANNEL_IDENTITIES.staging)).toBe(path.join(local, 'ETS2TelemetryStaging', 'transport', 'v0'));
    expect(v1BrokerConfiguration({executable: 'broker.exe', discoveryDirectory: brokerDiscoveryDirectory(local, CHANNEL_IDENTITIES.staging)})?.discoveryDirectory)
      .toBe(path.join(local, 'ETS2TelemetryStaging', 'transport', 'v1'));
    expect(v1BrokerConfiguration({executable: 'broker.exe', discoveryDirectory: v0})?.discoveryDirectory).toBe(path.join(local, 'ETS2Telemetry', 'transport', 'v1'));
  });

  it('gives the packaging configuration of a production build the production values', () => {
    const forge = forgeConfig('production');
    const squirrel = squirrelConfig(forge);
    const {productName, version} = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')) as {productName: string; version: string};
    expect({squirrelId: squirrel.name, executableName: forge.packagerConfig.executableName, appBundleId: forge.packagerConfig.appBundleId, productName,
      displayName: forge.packagerConfig.win32metadata.ProductName, title: squirrel.title, setupExe: squirrel.setupExe})
      .toEqual({squirrelId: PRODUCTION.squirrelId, executableName: PRODUCTION.executableName, appBundleId: PRODUCTION.appBundleId,
        productName: PRODUCTION.productName, displayName: PRODUCTION.displayName, title: PRODUCTION.displayName,
        setupExe: setupFileName(version, CHANNEL_IDENTITIES.production)});
    expect(pluginBundleNames('production').released).toBe(`native/telemetry-plugin/${PRODUCTION.releasedPluginsFile}`);
    expect(pluginBundleNames('staging')).toEqual({channel: 'staging', file: STAGING.pluginFileName, built: `native/telemetry-plugin/build/Release/${STAGING.pluginFileName}`,
      released: `native/telemetry-plugin/${STAGING.releasedPluginsFile}`});
  });

  it('gives the packaging configuration of a staging build the staging values', () => {
    // forge.config.cjs resolves the channel when Node loads it, so a separate Node process loads it with the variables of
    // each build (tests/shared/forge-config.ts).
    const pick = (forge: ReturnType<typeof forgeConfig>) => ({name: forge.packagerConfig.name, appVersion: forge.packagerConfig.appVersion,
      executableName: forge.packagerConfig.executableName, appBundleId: forge.packagerConfig.appBundleId, win32metadata: forge.packagerConfig.win32metadata,
      squirrel: {name: squirrelConfig(forge).name, title: squirrelConfig(forge).title, setupExe: squirrelConfig(forge).setupExe}});
    const {version} = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')) as {version: string};
    expect(pick(forgeConfig('staging', {ETS2TELEMETRY_STAGING_RUN_NUMBER: '42'}))).toEqual({name: STAGING.productName, appVersion: `${version}-stg.000042`,
      executableName: STAGING.executableName, appBundleId: STAGING.appBundleId,
      win32metadata: {CompanyName: 'Artur Sianiuk', FileDescription: STAGING.displayName, ProductName: STAGING.displayName},
      squirrel: {name: STAGING.squirrelId, title: STAGING.displayName, setupExe: `YukonUnionTelemetry-Staging-Setup-${version}-stg.000042.exe`}});
    expect(pick(forgeConfig('production'))).toEqual({name: PRODUCTION.productName, appVersion: version, executableName: PRODUCTION.executableName,
      appBundleId: PRODUCTION.appBundleId, win32metadata: {CompanyName: 'Artur Sianiuk', FileDescription: PRODUCTION.displayName, ProductName: PRODUCTION.displayName},
      squirrel: {name: PRODUCTION.squirrelId, title: PRODUCTION.displayName, setupExe: `YukonUnionTelemetry-Setup-${version}.exe`}});
    // ET-055 PR-4 (UP13): without the variables, the configuration is the staging one; production outside GitHub Actions
    // and an unknown channel stop the load.
    const run = (env: Record<string, string>) => {
      const base: Record<string, string | undefined> = {...process.env};
      for (const name of ['ETS2TELEMETRY_BUILD_CHANNEL', 'ETS2TELEMETRY_OWNER_PRODUCTION_BUILD', 'ETS2TELEMETRY_STAGING_RUN_NUMBER', 'GITHUB_ACTIONS']) delete base[name];
      return spawnSync(process.execPath, ['-e', "process.stdout.write(require('./forge.config.cjs').packagerConfig.executableName)"],
        {cwd: checkout, encoding: 'utf8', timeout: 30000, env: {...base, ...env}});
    };
    const unset = run({});
    expect(unset.status, unset.stderr).toBe(0);
    expect(unset.stdout).toBe(STAGING.executableName);
    const local = run({ETS2TELEMETRY_BUILD_CHANNEL: 'production'});
    expect(local.status).not.toBe(0);
    expect(local.stderr).toMatch(/A production build runs only in GitHub Actions or with the owner-only ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1/);
    const invalid = run({ETS2TELEMETRY_BUILD_CHANNEL: 'beta'});
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toMatch(/must be exactly production or staging/);
  });
});

describe('the mirrored channel tables', () => {
  const pick = (identity: ChannelIdentity) => ({channel: identity.channel, squirrelId: identity.squirrelId, executableName: identity.executableName,
    productName: identity.productName, appBundleId: identity.appBundleId, displayName: identity.displayName, setupFileTemplate: identity.setupFileTemplate,
    pluginFileName: identity.pluginFileName, releasedPluginsFile: identity.releasedPluginsFile, dataRootName: identity.dataRootName,
    pipePrefix: identity.pipePrefix, runOnceValue: identity.runOnceValue, receiptPrefix: identity.receiptPrefix, legacyShortcutNames: identity.legacyShortcutNames});

  it('scripts/build-channel.mjs names what channel.ts names', () => {
    for (const channel of RELEASE_CHANNELS) expect(BUILD_IDENTITIES[channel]).toEqual(pick(CHANNEL_IDENTITIES[channel]));
    expect(Object.keys(BUILD_IDENTITIES)).toEqual([...RELEASE_CHANNELS]);
  });

  it('the storage guard protects the history file of every channel', () => {
    expect(HISTORY_DATA_ROOT_NAMES).toEqual(RELEASE_CHANNELS.map(channel => CHANNEL_IDENTITIES[channel].dataRootName));
    for (const channel of RELEASE_CHANNELS) {
      expect(isHistoryFile(`C:\\Users\\driver\\AppData\\Local\\${CHANNEL_IDENTITIES[channel].dataRootName}\\data\\telemetry.sqlite`)).toBe(true);
    }
    expect(isHistoryFile('C:\\Users\\driver\\AppData\\Local\\ETS2Telemetry\\synthetic\\smoke.sqlite')).toBe(false);
    expect(isHistoryFile('C:\\Users\\driver\\AppData\\Local\\ETS2TelemetryOther\\data\\telemetry.sqlite')).toBe(false);
  });

  it("the deferred-cleanup executor's table names what channel.ts names", () => {
    const script = readFileSync(path.join(checkout, 'resources/uninstall/Complete-ETS2TelemetryUninstall.ps1'), 'utf8');
    for (const channel of RELEASE_CHANNELS) {
      const identity = CHANNEL_IDENTITIES[channel];
      const row = new RegExp(`^\\s*${channel} = @\\{([^}]*)\\}`, 'm').exec(script.replace(/\r?\n\s+(?=\w+ = ')/g, ' '))?.[1] ?? '';
      const values = Object.fromEntries([...row.matchAll(/(\w+) = '([^']*)'/g)].map(match => [match[1], match[2]]));
      expect(values).toEqual({dataRoot: identity.dataRootName, installRoot: identity.squirrelId, executable: `${identity.executableName}.exe`,
        runOnceValue: identity.runOnceValue, pluginFile: identity.pluginFileName, roamingFolder: identity.productName, displayName: identity.displayName,
        receiptPrefix: channel === 'production' ? 'ETS2Telemetry-deferred-cleanup-' : 'ETS2TelemetryStaging-deferred-cleanup-'});
    }
  });

  it('stamps exactly the one $Channel line of the executor, and leaves production byte-identical', () => {
    const script = readFileSync(path.join(checkout, 'resources/uninstall/Complete-ETS2TelemetryUninstall.ps1'), 'latin1');
    expect(stampExecutorChannel(script, 'production')).toBe(script);
    const staging = stampExecutorChannel(script, 'staging');
    expect(staging.length).toBe(script.length + 'staging'.length - 'production'.length);
    expect(staging).toMatch(/^\$Channel = 'staging'\r?$/m);
    expect(staging).not.toMatch(/^\$Channel = 'production'/m);
    expect(() => stampExecutorChannel(script.replace("$Channel = 'production'", "$Channel = 'x'"), 'staging')).toThrow(/exactly one/);
    expect(() => stampExecutorChannel(`${script}\n$Channel = 'production'\n`, 'staging')).toThrow(/exactly one/);
    expect(() => stampExecutorChannel(script, 'beta' as 'staging')).toThrow(/Unknown build channel/);
  });
});

describe('the build-time channel define', () => {
  afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});

  it('selects the staging table when a build defines staging', async () => {
    vi.stubGlobal('__ETS2TELEMETRY_BUILD_CHANNEL__', 'staging');
    vi.resetModules();
    const module = await import('../../apps/desktop/src/channel');
    expect(module.ACTIVE_CHANNEL).toBe('staging');
    expect(module.CHANNEL).toEqual(STAGING);
  });

  it('fails the bundle at load for an unknown channel', async () => {
    vi.stubGlobal('__ETS2TELEMETRY_BUILD_CHANNEL__', 'beta');
    vi.resetModules();
    await expect(import('../../apps/desktop/src/channel')).rejects.toThrow(/Unknown build channel: beta/);
  });
});

describe('user copy in each channel', () => {
  const copy = 'Choose a folder outside the Yukon Union Telemetry data folder, %LOCALAPPDATA%\\ETS2Telemetry. Install root %LOCALAPPDATA%\\ETS2TelemetryDesktop, ' +
    'Roaming %APPDATA%\\ETS2Telemetry Desktop, plugin ets2telemetry-plugin.dll.';

  it('keeps production copy byte-identical', () => {
    expect(channelCopy(copy, CHANNEL_IDENTITIES.production)).toBe(copy);
    const table = Object.freeze({a: copy});
    expect(channelCopyTable(table, CHANNEL_IDENTITIES.production)).toBe(table);
  });

  it('names the staging product, folders and plugin in staging', () => {
    // The refusal's single data folder becomes the list of both roots a staging export refuses (UP12).
    expect(channelCopy(copy, CHANNEL_IDENTITIES.staging)).toBe('Choose a folder outside the Yukon Union Telemetry Staging data folders, %LOCALAPPDATA%\\ETS2TelemetryStaging and %LOCALAPPDATA%\\ETS2Telemetry. ' +
      'Install root %LOCALAPPDATA%\\ETS2TelemetryDesktopStaging, Roaming %APPDATA%\\ETS2Telemetry Desktop Staging, plugin ets2telemetry-plugin-staging.dll.');
    // Names that only start with a production name stay, and the staging display name is never extended twice.
    for (const text of ['%LOCALAPPDATA%\\ETS2TelemetryStaging', 'ets2telemetry-plugin.dll2', 'Yukon Union Telemetry Staging', 'Yukon Union Telemetryx'])
      expect(channelCopy(text, CHANNEL_IDENTITIES.staging)).toBe(text);
    const table = Object.freeze({a: copy, list: Object.freeze([copy]), count: 3, run: (value: string) => value});
    const staged = channelCopyTable(table, CHANNEL_IDENTITIES.staging);
    expect(staged.a).toBe(channelCopy(copy, CHANNEL_IDENTITIES.staging));
    expect(staged.list).toEqual([channelCopy(copy, CHANNEL_IDENTITIES.staging)]);
    expect([staged.count, staged.run, Object.isFrozen(staged), Object.isFrozen(staged.list)]).toEqual([3, table.run, true, true]);
  });
});
