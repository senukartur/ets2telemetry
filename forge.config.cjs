const {version} = require('./package.json');

// The product's display name (ET-045h, owner decision D2; docs/release.md, "Product name"). Only what Windows shows
// changes: the Installed apps DisplayName (nuspec `title`), the executable's ProductName and FileDescription (the
// shortcut name, Task Manager, file Properties) and the Setup file name. package.json `productName` stays
// "ETS2Telemetry Desktop" (it decides userData, the single-instance lock and the out/ folder), and the Squirrel id
// `name`, `executableName` and `appBundleId` keep the install root, the Uninstall key and the shortcut AUMID.
const PRODUCT_NAME = 'Yukon Union Telemetry';

// Squirrel maker options (ET-018 PR-6, docs/release.md). `title` becomes the Installed apps DisplayName and `authors`
// the Publisher (Squirrel's CreateUninstallerRegistryEntry); Setup carries the version in its name.
// scripts/release-identity.mjs, inspect-package --installer and the installer lifecycle find Setup by this exact name.
const squirrel = {name: 'ETS2TelemetryDesktop', title: PRODUCT_NAME, authors: 'Yukon Union Telemetry contributors',
  description: 'Local telemetry utility for Euro Truck Simulator 2 and American Truck Simulator', setupExe: `YukonUnionTelemetry-Setup-${version}.exe`,
  // The Setup executable's own icon; scripts/generate-app-icons.mjs renders it. skipUpdateIcon keeps
  // Update.exe byte-identical to the vendored Squirrel.exe, which release-identity.mjs asserts (docs/release.md).
  setupIcon: 'resources/icon/app.ico', skipUpdateIcon: true};

module.exports = {
  // better-sqlite3 13.0.3 ships Node-API prebuilds; preserve its bundled binary.
  // Other native dependencies remain eligible for Forge's Electron rebuild.
  rebuildConfig: {ignoreModules:['better-sqlite3']},
  packagerConfig: {
    // resources/uninstall holds the deferred-cleanup executor that an uninstall copies and registers (ET-018 PR-5, U7).
    // resources/icon ships app.ico, which the install and updated hooks place in Squirrel's install root and name as the
    // Installed apps DisplayIcon (ET-045g, docs/release.md). The Squirrel maker keeps electron-winstaller's default
    // iconUrl, the Electron icon (HTTP(S) only); with app.ico already in place Squirrel never downloads it.
    extraResource: ['.local/package-native/telemetry-client', '.local/package-native/telemetry-plugin', 'resources/uninstall', 'resources/icon'],
    // The physical Node worker must resolve SQLite's JavaScript loader without ASAR patches.
    asar: { unpack: '**/*.{node,cjs}', unpackDir: '**/better-sqlite3' }, executableName: 'ETS2TelemetryDesktop',
    appBundleId: 'com.ets2telemetry.desktop',
    // The executable's version resource. Squirrel names the shortcuts after ProductName and puts the Start menu entry in
    // `Programs\<CompanyName>`; CompanyName is pinned to the value @electron/packager inferred from package.json `author`,
    // so that folder stays where it was (ET-045h H2). apps/desktop/src/legacy-shortcuts.ts names the same values.
    win32metadata: {CompanyName: 'Artur Sianiuk', FileDescription: PRODUCT_NAME, ProductName: PRODUCT_NAME},
    // Embedded in the executable, so the taskbar, shortcuts and windows show the application icon. Forge appends .ico on Windows.
    icon: 'resources/icon/app',
    ignore: filename => {
      const normalized = filename.replaceAll('\\', '/');
      return !['', '/package.json', '/apps', '/apps/desktop', '/apps/desktop/dist', '/node_modules'].includes(normalized)
        && !normalized.startsWith('/apps/desktop/dist/') && !normalized.startsWith('/node_modules/');
    }
  },
  makers: [{name:'@electron-forge/maker-squirrel', config:squirrel}],
  plugins: [{name:'@electron-forge/plugin-auto-unpack-natives', config:{}}]
};
