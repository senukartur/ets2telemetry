# Game plugin setup (ET-017)

ET-017 implements the [silent plugin installation](../concept.md#silent-plugin-installation--october-12-2026) decided by the owner on October 12, 2026. The application finds ETS2 and ATS through the Steam libraries or a folder the driver chooses. It installs, updates or removes only its own `ets2telemetry-plugin.dll` in each game's `bin\win_x64\plugins` folder, and only while the game is closed. The coordinator adopted the architect's decisions P1–P20 for ET-017 on October 17, 2026.

ET-017 is delivered as six PRs:

| PR | Content | State |
| --- | --- | --- |
| PR-1 | The plugin DLL is bundled with a hash manifest ([bundle format](#bundle-format)) | Implemented; nothing reads the bundle at runtime |
| PR-2 | Steam and manual game-folder discovery | Coming |
| PR-3 | The atomic installer and the [install registry](#install-registry) | Coming |
| PR-4 | Silent setup in main, the [mode gate](#mode-gate) and the per-game state in `AppState` | Coming |
| PR-5 | The per-game plugin card on the dashboard | Coming |
| PR-6 | Connection diagnosis and the diagnostic bundle | Coming |

Until PR-4 lands, the application never discovers a game, never writes into a game folder and never reads the bundle. The developer procedure in [manual plugin setup](manual-plugin-setup.md) stays the only way to put the DLL into a game. No game, TruckersMP or performance claim follows from the bundle.

## Bundle format

Since ET-017 PR-1, `npm run build` stages the game plugin. `scripts/stage-native-plugin.mjs` runs right after the native broker build and does the following:

1. It configures `native/telemetry-plugin/build` with `cmake -S native/telemetry-plugin -B native/telemetry-plugin/build -A x64`, but only when that tree has no `CMakeCache.txt`. An existing tree keeps its generator; Windows CI configures it first with `-G 'Visual Studio 17 2022'` ([ci](ci.md#et-017-plugin-bundle)).
2. It builds only the DLL: `cmake --build native/telemetry-plugin/build --target ets2telemetry-plugin --config Release --parallel`.
3. It fails if a plugin source changed during the build.
4. It replaces `.local/package-native/telemetry-plugin` with a fresh directory holding exactly two files: the DLL bytes it read from `native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll`, and `plugin-manifest.json`. It verifies the result before it exits.

Forge copies that directory into the package as `resources\telemetry-plugin`, next to `resources\telemetry-client`. Neither directory is inside `app.asar`. Generated files are never committed: `native/telemetry-plugin/build` and `.local/` are ignored.

### Manifest

`plugin-manifest.json` is UTF-8 JSON of at most 64 KiB. Its keys are exactly these, in this order when written:

| Key | Value |
| --- | --- |
| `format` | `ets2telemetry.plugin-bundle` |
| `version` | `1` |
| `appVersion` | The `version` of the root `package.json`, for example `0.1.0` |
| `file` | `ets2telemetry-plugin.dll` |
| `size` | The DLL size in bytes, from 64 bytes to 16 MiB |
| `sha256` | The DLL's SHA-256, 64 lowercase hex digits |
| `pluginSources` | SHA-256 of every plugin input, keyed by repository path with `/` separators: every file under `native/telemetry-plugin/src`, `native/telemetry-plugin/CMakeLists.txt` and every file under `native/telemetry-plugin/vendor/scs-sdk-1.15/include`; at most 1024 entries |
| `known` | A copy of the `known` list of [`released-plugins.json`](#released-plugin-list) at build time |

`scripts/plugin-bundle.mjs` holds the writer and the checks, with types in `plugin-bundle.d.mts`. `verifyPluginBundle(directory)` accepts a bundle only when all of the following hold:

- the directory is not a link and holds exactly the DLL and the manifest;
- neither file is a link (a symbolic link or a junction), and both are regular files;
- the manifest has exactly the keys above, with valid values;
- the DLL size equals `size` and is within the bounds, and its SHA-256 equals `sha256`;
- the DLL starts with `MZ`, has the `PE\0\0` signature at its `e_lfanew` offset, machine `0x8664` (x64) and the `IMAGE_FILE_DLL` characteristic.

`npm run inspect:package` calls `verifyPluginBundleAgainstTree` on the packaged `resources\telemetry-plugin`. On top of `verifyPluginBundle` it requires:

- the DLL bytes equal `native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll` of the checkout;
- `pluginSources` equals the hashes of the current plugin inputs, so a package built before a plugin source changed fails;
- `known` equals the tracked `released-plugins.json`;
- `appVersion` equals the root `package.json` version.

`.local/diagnostics/package-inspection.json` records the result under `nativePlugin`. The inspection never loads the DLL.

### Released plugin list

`native/telemetry-plugin/released-plugins.json` is tracked. It lists the SHA-256 of every plugin DLL that a released ETS2Telemetry version shipped:

```json
{
  "format": "ets2telemetry.released-plugins",
  "version": 1,
  "known": []
}
```

The format is strict: exactly the keys `format`, `version` and `known`; `known` holds at most 256 entries, and each entry has exactly the keys `appVersion` (a version such as `0.1.0` or `0.2.0-beta.1`) and `sha256` (64 lowercase hex digits), with no repeated hash. The file is at most 64 KiB.

The list starts empty because nothing has been released. MSVC builds are not reproducible, so the same sources can produce a DLL with a different hash; a local rebuild after a touched source file did so on October 17, 2026. The release process therefore appends the hash of the DLL in each shipped bundle, read from that bundle's manifest, with the release's `appVersion`. Never remove an entry. A later version uses the list to recognize a plugin that an earlier version installed (P6, PR-3). Changing the file requires a new build before `inspect:package`, because the manifest copies it.

### Runtime reading (PR-4, coming)

PR-4 adds `plugin-bundle.ts` in main. It will read the bundle from `process.resourcesPath\telemetry-plugin` when packaged and from `<repo>\.local\package-native\telemetry-plugin` in development. It will read the manifest (at most 64 KiB, strict keys) and the DLL (at most 16 MiB, not a link, x64 PE), hash the DLL in memory and install only that verified buffer, never re-reading the file.

## Mode gate

Coming in PR-4. The pure `pluginSetupMode` decides from the environment and the packaged flag whether plugin setup runs. The first matching row wins:

| Condition | Mode |
| --- | --- |
| `ETS2TELEMETRY_PLUGIN_SETUP=off` | disabled |
| `ETS2TELEMETRY_PLUGIN_SETUP_ROOT=<absolute path>` and an absolute `ETS2TELEMETRY_PROFILE_DIR` | test-root |
| `ETS2TELEMETRY_PLUGIN_SETUP_ROOT` without a profile directory, or a relative root | disabled, logged as `PLUGIN_SETUP_MODE_REJECTED` |
| Any of `ETS2TELEMETRY_PROFILE_DIR`, `ETS2TELEMETRY_DIAGNOSTIC_DIR`, `ETS2TELEMETRY_LIVE_SMOKE` or `ETS2TELEMETRY_SOURCE_KIND` set, without a root | disabled |
| Unpackaged without `ETS2TELEMETRY_PLUGIN_SETUP=real` | disabled |
| Anything else | active |

- **test-root.** The Steam root is `<root>\Steam`. Nothing reads the Windows registry or runs PowerShell, and every discovered path must resolve inside `<root>`; any other path is ignored and logged as `PLUGIN_TEST_ROOT_ESCAPE`.
- **disabled.** No registry read, no discovery and no write.
- Existing harnesses all land in disabled: the runtime smokes, the Playwright startup test, the native installer acceptance, the VM harness and the Squirrel lifecycle hooks.

## Install registry

Coming in PR-3. The registry records which game folders this application manages and which plugin it installed there.

- **File.** `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json`, format `ets2telemetry.plugin-setup`, version 1:

  ```text
  {
    format, version: 1,
    games: {ets2: {excluded, manualRoot}, ats: {...}},
    installs: [{game, root, source: steam|manual|adopted, sha256, appVersion, installedUtc, createdPluginsDirectory}],
    pending: [...],
    lastFailure: {"<game>:<source>": {code, step, utc}}
  }
  ```

- **Bounds.** At most 256 KiB, 16 installs and 16 pending entries.
- **Writes.** Like the settings file: the file must not be a link; stale `setup.json.<pid>.<uuid>.tmp` files are removed; a new temporary file is written with `wx`, synced and renamed over `setup.json`, with up to five retries on `EPERM`, `EACCES` or `EBUSY`. The single-instance lock guarantees one writer.
- **Invalid file.** It is kept as `setup.rejected-<UTC>.json` (the newest three are kept), and the registry starts empty.
- **Newer version.** Read-only: no mutation, and every operation reports `REGISTRY_UNAVAILABLE`.
- **Exclusions.** Game exclusions and the manual folder live here, not in `settings.json` (P10).

**Contract with ET-018 (uninstall).** ET-018 reads this file before it deletes the data root. For each install it removes the DLL only while its hash is still the recorded `sha256` or a `known` hash, then removes the `plugins` folder only if `createdPluginsDirectory` is set and the folder is empty. Any other file stays.

## Remaining manual and real-environment checks

All of them stay pending after PR-1:

- real Steam installs: the default and a custom Steam path, including non-ASCII paths, several libraries on other drives and libraries moved through a junction;
- ETS2 and ATS loading the silently installed DLL, and a Steam update or file verification preserving it;
- TruckersMP's real process names and the blocking behaviour;
- `sdk unload` and `sdk reload` in the game console;
- UAC- or ACL-restricted libraries with the manual fallback, and antivirus interference with the rename;
- the real Windows dialogs and Explorer reveal, and the packaged Squirrel first launch;
- ET-018 uninstall cleanup and the readability of the card.

See [ET-017 validation](validation/et-017.md).
