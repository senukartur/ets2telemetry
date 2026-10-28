import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {ACTIVE_CHANNEL, CHANNEL, CHANNEL_IDENTITIES, pluginTempFilePattern, RELEASE_CHANNELS, setupFileName, TRANSPORT_DIRECTORY,
  type ChannelIdentity} from '../../apps/desktop/src/channel';
import {uninstallEntryKey} from '../../apps/desktop/src/installed-app-icon';
import {LEGACY_SHORTCUT_NAMES, SHORTCUT_NAME, SQUIRREL_APP_ID} from '../../apps/desktop/src/legacy-shortcuts';
import {mainLogLocation, serviceLogLocation} from '../../apps/desktop/src/log-location';
import {dataPaths} from '../../apps/desktop/src/paths';
import {PLUGIN_BUNDLE_FILE} from '../../apps/desktop/src/plugin-setup/plugin-bundle';
import {PLUGIN_TEMP_FILE} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {PLUGIN_FILE_NAME} from '../../apps/desktop/src/plugin-setup/steam-discovery';
import {RECEIPT_PREFIX, ROAMING_USER_DATA_NAME} from '../../apps/desktop/src/squirrel-events';
import {STRINGS, STRINGS_RU} from '../../apps/desktop/src/strings';
import {RUN_ONCE_VALUE} from '../../apps/desktop/src/uninstall/executor';
import {DATA_ROOT_NAME, PRODUCT_ROOT_NAME} from '../../apps/desktop/src/uninstall/roots';
import {RELEASED_PLUGINS} from '../../scripts/plugin-bundle.mjs';

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
  it('is production until the build-time selection lands (ET-055 PR-3)', () => {
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
  });

  it('agrees with the packaging configuration that still names the production values (ET-055 PR-3 routes it)', async () => {
    const forge = (await import(pathToFileURL(path.join(checkout, 'forge.config.cjs')).href) as {default: {
      packagerConfig: {executableName: string; appBundleId: string; win32metadata: Record<string, string>};
      makers: {name: string; config: Record<string, string>}[];
    }}).default;
    const squirrel = forge.makers.find(maker => maker.name === '@electron-forge/maker-squirrel')?.config ?? {};
    const {productName, version} = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')) as {productName: string; version: string};
    expect({squirrelId: squirrel.name, executableName: forge.packagerConfig.executableName, appBundleId: forge.packagerConfig.appBundleId, productName,
      displayName: forge.packagerConfig.win32metadata.ProductName, title: squirrel.title, setupExe: squirrel.setupExe})
      .toEqual({squirrelId: PRODUCTION.squirrelId, executableName: PRODUCTION.executableName, appBundleId: PRODUCTION.appBundleId,
        productName: PRODUCTION.productName, displayName: PRODUCTION.displayName, title: PRODUCTION.displayName,
        setupExe: setupFileName(version, CHANNEL_IDENTITIES.production)});
    expect(RELEASED_PLUGINS).toBe(`native/telemetry-plugin/${PRODUCTION.releasedPluginsFile}`);
  });
});
