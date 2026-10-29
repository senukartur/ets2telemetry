const {readFileSync, writeFileSync} = require('node:fs');
const path = require('node:path');
// ET-055: the build channel and its version come only from scripts/build-channel.mjs (Node loads that ES module
// synchronously). Production names and the production version are those of every build before ET-055.
const {buildSetupFileName, resolveBuild} = require('./scripts/build-channel.mjs');
const build = resolveBuild({root: __dirname});
const {identity, version} = build;

// The product's display name (ET-045h, owner decision D2; docs/release.md, "Product name"). Only what Windows shows
// changes: the Installed apps DisplayName (nuspec `title`), the executable's ProductName and FileDescription (the
// shortcut name, Task Manager, file Properties) and the Setup file name. The productName ("ETS2Telemetry Desktop" in
// production; it decides userData, the single-instance lock and the out/ folder), the Squirrel id `name`,
// `executableName` and `appBundleId` keep the install root, the Uninstall key and the shortcut AUMID. Staging has its own
// value of each (ET-055 UP12), so that both channels install and run side by side.
const PRODUCT_NAME = identity.displayName;
// The channel's application icon folder (scripts/generate-app-icons.mjs). Both folders are named icon, so the packaged
// resourcesiconapp.ico has one path in both channels; staging's carries an amber corner flag (ET-055).
const ICON_DIRECTORY = build.channel === 'staging' ? 'resources/staging/icon' : 'resources/icon';

// Squirrel maker options (ET-018 PR-6, docs/release.md). `title` becomes the Installed apps DisplayName and `authors`
// the Publisher (Squirrel's CreateUninstallerRegistryEntry); Setup carries the version in its name.
// scripts/release-identity.mjs, inspect-package --installer and the installer lifecycle find Setup by this exact name.
const squirrel = {name: identity.squirrelId, title: PRODUCT_NAME, authors: 'Yukon Union Telemetry contributors',
  description: 'Local telemetry utility for Euro Truck Simulator 2 and American Truck Simulator', setupExe: buildSetupFileName(identity, version),
  // The Setup executable's own icon; scripts/generate-app-icons.mjs renders it. skipUpdateIcon keeps
  // Update.exe byte-identical to the vendored Squirrel.exe, which release-identity.mjs asserts (docs/release.md).
  setupIcon: `${ICON_DIRECTORY}/app.ico`, skipUpdateIcon: true};

/**
 * ET-055: the packaged package.json carries the channel's productName and the build version. Electron names userData
 * (%APPDATA%\<productName>) and the single-instance lock after the productName and reports the version from it, and
 * electron-winstaller takes the nuspec version from it. A production build carries the tracked values, so the file is
 * left as it is.
 */
function packagedPackageJson(buildPath) {
  const file = path.join(buildPath, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.productName === identity.productName && manifest.version === version) return;
  writeFileSync(file, `${JSON.stringify({...manifest, productName: identity.productName, version}, null, 2)}\n`);
}

module.exports = {
  // better-sqlite3 13.0.3 ships Node-API prebuilds; preserve its bundled binary.
  // Other native dependencies remain eligible for Forge's Electron rebuild.
  rebuildConfig: {ignoreModules:['better-sqlite3']},
  packagerConfig: {
    // resources/uninstall holds the deferred-cleanup executor that an uninstall copies and registers (ET-018 PR-5, U7);
    // scripts/build.mjs stages it with this build's channel stamped in (ET-055). resources/icon ships app.ico, which the
    // install and updated hooks place in Squirrel's install root and name as the Installed apps DisplayIcon (ET-045g,
    // docs/release.md). The Squirrel maker keeps electron-winstaller's default iconUrl, the Electron icon (HTTP(S) only);
    // with app.ico already in place Squirrel never downloads it.
    extraResource: ['.local/package-native/telemetry-client', '.local/package-native/telemetry-plugin', '.local/package-native/uninstall', ICON_DIRECTORY],
    // The physical Node worker must resolve SQLite's JavaScript loader without ASAR patches.
    asar: { unpack: '**/*.{node,cjs}', unpackDir: '**/better-sqlite3' }, executableName: identity.executableName,
    appBundleId: identity.appBundleId,
    // The productName names out/<name>-win32-x64 and the executable's InternalName; the version is the executable's
    // FileVersion and ProductVersion. Production values equal what @electron/packager infers from package.json.
    name: identity.productName, appVersion: version,
    // The executable's version resource. Squirrel names the shortcuts after ProductName and puts the Start menu entry in
    // `Programs\<CompanyName>`; CompanyName is pinned to the value @electron/packager inferred from package.json `author`,
    // so that folder stays where it was (ET-045h H2). apps/desktop/src/legacy-shortcuts.ts names the same values.
    // OriginalFilename is the executable's file name, which @electron/packager derives from executableName.
    win32metadata: {CompanyName: 'Artur Sianiuk', FileDescription: PRODUCT_NAME, ProductName: PRODUCT_NAME},
    // Embedded in the executable, so the taskbar, shortcuts and windows show the application icon. Forge appends .ico on Windows.
    icon: `${ICON_DIRECTORY}/app`,
    ignore: filename => {
      const normalized = filename.replaceAll('\\', '/');
      return !['', '/package.json', '/apps', '/apps/desktop', '/apps/desktop/dist', '/node_modules'].includes(normalized)
        && !normalized.startsWith('/apps/desktop/dist/') && !normalized.startsWith('/node_modules/');
    }
  },
  // Forge's own view of package.json: the Squirrel maker names the nupkg and Setup after this version, and the make
  // output folder after this productName.
  hooks: {
    readPackageJson: async (_config, packageJson) => ({...packageJson, productName: identity.productName, version}),
    packageAfterCopy: async (_config, buildPath) => packagedPackageJson(buildPath)
  },
  makers: [{name:'@electron-forge/maker-squirrel', config:squirrel}],
  plugins: [{name:'@electron-forge/plugin-auto-unpack-natives', config:{}}]
};
