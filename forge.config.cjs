module.exports = {
  // better-sqlite3 13.0.3 ships Node-API prebuilds; preserve its bundled binary.
  // Other native dependencies remain eligible for Forge's Electron rebuild.
  rebuildConfig: {ignoreModules:['better-sqlite3']},
  packagerConfig: {
    // The physical Node worker must resolve SQLite's JavaScript loader without ASAR patches.
    asar: { unpack: '**/*.{node,cjs}', unpackDir: '**/better-sqlite3' }, executableName: 'ETS2TelemetryDesktop',
    appBundleId: 'com.ets2telemetry.desktop',
    ignore: filename => {
      const normalized = filename.replaceAll('\\', '/');
      return !['', '/package.json', '/apps', '/apps/desktop', '/apps/desktop/dist', '/node_modules'].includes(normalized)
        && !normalized.startsWith('/apps/desktop/dist/') && !normalized.startsWith('/node_modules/');
    }
  },
  makers: [{name:'@electron-forge/maker-squirrel', config:{name:'ETS2TelemetryDesktop'}}],
  plugins: [{name:'@electron-forge/plugin-auto-unpack-natives', config:{}}]
};
