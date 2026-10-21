const {version} = require('./package.json');

// Squirrel maker options (ET-018 PR-6, docs/release.md). `authors` and `description` become the NuGet metadata that
// Squirrel shows as the publisher text; Setup carries the version in its name. scripts/release-identity.mjs,
// inspect-package --installer and the installer lifecycle find Setup by this exact name.
const squirrel = {name: 'ETS2TelemetryDesktop', authors: 'ETS2Telemetry contributors',
  description: 'Local telemetry utility for Euro Truck Simulator 2 and American Truck Simulator', setupExe: `ETS2Telemetry-Setup-${version}.exe`,
  // The Setup executable's own icon; scripts/generate-app-icons.mjs renders it from the logo. skipUpdateIcon keeps
  // Update.exe byte-identical to the vendored Squirrel.exe, which release-identity.mjs asserts (docs/release.md).
  setupIcon: 'resources/icon/app.ico', skipUpdateIcon: true};

module.exports = {
  // better-sqlite3 13.0.3 ships Node-API prebuilds; preserve its bundled binary.
  // Other native dependencies remain eligible for Forge's Electron rebuild.
  rebuildConfig: {ignoreModules:['better-sqlite3']},
  packagerConfig: {
    // resources/uninstall holds the deferred-cleanup executor that an uninstall copies and registers (ET-018 PR-5, U7).
    extraResource: ['.local/package-native/telemetry-client', '.local/package-native/telemetry-plugin', 'resources/uninstall'],
    // The physical Node worker must resolve SQLite's JavaScript loader without ASAR patches.
    asar: { unpack: '**/*.{node,cjs}', unpackDir: '**/better-sqlite3' }, executableName: 'ETS2TelemetryDesktop',
    appBundleId: 'com.ets2telemetry.desktop',
    // Embedded in the executable, so the taskbar, shortcuts and windows show the bear mark. Forge appends .ico on Windows.
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
