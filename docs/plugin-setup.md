# Game plugin setup (ET-017)

ET-017 implements the [silent plugin installation](../concept.md#silent-plugin-installation--october-12-2026) decided by the owner on October 12, 2026. The application finds ETS2 and ATS through the Steam libraries or a folder the driver chooses. It installs, updates or removes only its own `ets2telemetry-plugin.dll` in each game's `bin\win_x64\plugins` folder, and only while the game is closed. The coordinator adopted the architect's decisions P1–P20 for ET-017 on October 17, 2026.

ET-017 is delivered as six PRs:

| PR | Content | State |
| --- | --- | --- |
| PR-1 | The plugin DLL is bundled with a hash manifest ([bundle format](#bundle-format)) | Implemented; nothing reads the bundle at runtime |
| PR-2 | Steam and manual game-folder discovery ([Steam root](#steam-root), [Steam discovery](#steam-discovery), [manual game folder](#manual-game-folder), [running games](#running-games)) | Implemented as read-only modules; nothing calls them from main yet |
| PR-3 | The atomic installer and the [install registry](#install-registry) | Coming |
| PR-4 | Silent setup in main, the [mode gate](#mode-gate) and the per-game state in `AppState` | Coming |
| PR-5 | The per-game plugin card on the dashboard | Coming |
| PR-6 | Connection diagnosis and the diagnostic bundle | Coming |

Until PR-4 lands, the application never discovers a game, never writes into a game folder and never reads the bundle. The developer procedure in [manual plugin setup](manual-plugin-setup.md) stays the only way to put the DLL into a game. No game, TruckersMP or performance claim follows from the bundle or from discovery.

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

**Release rule.** After an ETS2Telemetry version is published, a PR appends `{appVersion, sha256}` from the published artifact's `resources/telemetry-plugin/plugin-manifest.json` before the next release build. The shipped artifact is the one built by Windows CI (`npm run make` on `main` or a dispatch), never a local build. Without the entry, a later version recognizes that plugin only through the per-folder install record, and a user whose record was lost or who copied the DLL by hand sees it as unrecognized.

**Bundle identity.** `pluginSources` covers the repository inputs that compile into the DLL: the plugin sources, its CMake project and the vendored SDK headers. The toolchain, the generator and the CMake cache options are deliberately not part of it, because the builds are not reproducible anyway. A developer tree may therefore stage a DLL built with local cache flags. Release bundles must come from a freshly configured tree, which is what CI does.

### Runtime reading (PR-4, coming)

PR-4 adds `plugin-bundle.ts` in main. It will read the bundle from `process.resourcesPath\telemetry-plugin` when packaged and from `<repo>\.local\package-native\telemetry-plugin` in development. It will read the manifest (at most 64 KiB, strict keys) and the DLL (at most 16 MiB, not a link, x64 PE), hash the DLL in memory and install only that verified buffer, never re-reading the file.

## Steam root

PR-2 adds how the application finds the games and validates a folder the user chose. The modules live in `apps/desktop/src/plugin-setup/`. They only read, every file and process access goes through an injected port, and nothing calls them from main yet; ET-017 PR-4 wires them behind the [mode gate](#mode-gate). No result here establishes that a real Steam installation, game or TruckersMP client behaves as described; see [remaining checks](#remaining-manual-and-real-environment-checks).

`steam-registry.ts` reads where Steam is installed (P1):

- One fixed Windows PowerShell 5.1 call: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -Command <fixed script>`, with a hidden window, no shell, a 5 s deadline and at most 16 KiB of output. `%SystemRoot%` is used only when it is a plain absolute drive folder; otherwise `C:\Windows`.
- The script uses only .NET calls and string concatenation, no cmdlet, so it never autoloads a module. The child gets the parent's environment with `PSModulePath` (in any letter case) replaced by `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`: a pwsh 7 parent, such as the CI tests job, exports module folders whose modules Windows PowerShell 5.1 cannot load (the same problem as in [ET-001 validation](validation/et-001.md)).
- The script reads exactly two values through `[Microsoft.Win32.Registry]::GetValue`: `HKCU\Software\Valve\Steam\SteamPath`, then, as the fallback, `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`. Each value is read on its own, and one that cannot be read is `null`, so an unreadable machine-wide key never loses a readable SteamPath. It prints `{"steamPath": <base64>|null, "installPath": <base64>|null, "unreadable": <0-2>}`, where each value is the base64 of its UTF-8 bytes, so the console code page cannot change a non-ASCII path, and `unreadable` counts the values whose read failed. Output that is not exactly this shape, uses non-canonical base64, is not UTF-8, exceeds 4096 bytes per value or counts more unreadable values than null ones is refused.
- The result is canonicalized: normalized with `path.win32`, resolved through `realpath` and checked again. SteamPath is used when it names an existing local folder; otherwise InstallPath. UNC, device, relative and missing paths are never used. When neither value is usable and at least one read failed, the result is `STEAM_REGISTRY_FAILED`, not "not installed", so a denied key is never reported as a missing Steam; a usable value still wins.
- Failures are fixed codes: `STEAM_REGISTRY_TIMEOUT`, `STEAM_REGISTRY_OUTPUT_TOO_LARGE`, `STEAM_REGISTRY_OUTPUT_INVALID`, `STEAM_REGISTRY_FAILED` and `STEAM_REGISTRY_ABORTED`. Discovery reports each as `steam-not-found`.
- Rejected alternatives: `reg.exe` prints in the OEM code page, `reg export` writes a file that includes AutoLoginUser, and a native addon, an npm dependency or registry access in the broker would widen the trusted code.

The script's two key names are fixed in code. Tests may replace them only with a per-run key `HKCU\Software\ETS2Telemetry-Test-<uuid>` and one plain subkey of it; any other key is refused before PowerShell starts.

## Steam discovery

`steam-discovery.ts` finds the game roots (P2, P3):

1. The Steam root is library 0.
2. The library list is `<steam>\steamapps\libraryfolders.vdf`, or `<steam>\config\libraryfolders.vdf` when the first is absent. Both the current format (`"0" { "path" "D:\\SteamLibrary" … }`) and the legacy one (`"1" "D:\\SteamLibrary"` beside keys such as `TimeNextStatsReport`) are read; the top key `libraryfolders` is case-insensitive and only numbered keys are libraries, in numeric order.
3. A library path must be an absolute drive path. A UNC or device path is skipped without any file access. A library on a missing drive or folder is skipped.
4. Libraries are deduplicated by canonical path (case-insensitive) and by file identity (volume serial number and file index), so a library listed again through a junction counts once and a junction-moved library is listed by its target.
5. A list that cannot be read or parsed leaves only the Steam root. Each game's outcome is then `steam-list-invalid`, and the log code is `STEAM_LIBRARY_LIST_INVALID` with a fixed reason.
6. In each library the manifest `steamapps\appmanifest_<id>.acf` (at most 64 KiB, a regular file) must have `AppState.appid` equal to 227300 (ETS2) or 270880 (ATS), and `installdir` must be one safe folder name: no `\`, `/`, `:`, `.` or `..`, no reserved device name, no trailing dot or space and no control character. StateFlags is ignored.
7. The root is `<library>\steamapps\common\<installdir>`, resolved through `realpath`. Roots are deduplicated like libraries; at most four are reported per game.

The outcome per game is `found`, `not-found`, `steam-not-found` or `steam-list-invalid`. The result also carries counts for the PLUGIN_DISCOVERY log line (`libraries`, `missingLibraries`, `duplicateLibraries`, `rejectedLibraries`, `invalidManifests`, `staleManifests`, `duplicateRoots` and `truncatedRoots`) and never a path.

### KeyValues reader

`vdf.ts` accepts only what Steam writes: quoted keys and values, braces, whitespace, `//` comments, one UTF-8 byte order mark and the escape set of Valve's reader: `\n`, `\t`, `\v`, `\b`, `\r`, `\f`, `\a`, `\\`, `\?`, `\'` and `\"`. It refuses unquoted tokens, conditionals such as `[$WIN32]`, `#include`, any other escape and invalid UTF-8. Bounds: 1 MiB per file, nesting depth 8 and 4096 UTF-8 bytes per key or value, counted as the string is read; a list may name at most 64 libraries. Entries are kept as an ordered list, so repeated keys and keys such as `__proto__` cannot reach an object prototype; a repeated key the reader needs (for example two `path` entries) is refused.

### Game layout

A root is a game root only when `bin\win_x64\eurotrucks2.exe` (ETS2) or `bin\win_x64\amtrucks.exe` (ATS) is a regular file. The layout is then:

| Status | Meaning |
| --- | --- |
| `ready` | `bin` and `bin\win_x64` are plain folders; `plugins` is absent or a plain folder; the target is absent or a regular file |
| `linked` | `bin`, `bin\win_x64` or `plugins` is a symbolic link or junction (the executable is reachable through it) |
| `unexpected-entry` | `plugins` is not a folder, or the target is a link or a folder |

Node reports NTFS junctions and symbolic links alike as links. Other reparse points, such as cloud placeholders, look like plain folders to Node and are not detected. Whether a regular target file is owned is decided by the installer (P6, PR-3), not here.

## Manual game folder

`game-folder.ts` validates a folder the user chose in main's folder dialog (P4). A selection of the root, `bin`, `bin\win_x64` or `bin\win_x64\plugins` is normalized to the root by exact tail components, in any case. The canonical root is what is stored. Refusal codes:

| Code | When |
| --- | --- |
| FOLDER_UNSUPPORTED_PATH | A relative, drive-relative, UNC, `\\?\`, `\\.\` or `\??\` path or one naming a stream, refused before any file access; a folder inside `%LOCALAPPDATA%\ETS2Telemetry` or the application's install folder, compared by name and by real path; a folder whose real path is UNC |
| FOLDER_NOT_GAME | The folder is missing or has no regular 64-bit executable of either game |
| FOLDER_WRONG_GAME | The folder holds the other game |
| FOLDER_LINKED | `bin`, `bin\win_x64` or `plugins` is a link or junction |
| FOLDER_DUPLICATE | The root has the file identity of a Steam root found for the game |

## Running games

`game-processes.ts` runs the absolute `%SystemRoot%\System32\tasklist.exe /fo csv /nh` with a hidden window, no shell, 3 s and at most 1 MiB of output (P7). It matches image names case-insensitively: `eurotrucks2.exe` blocks ETS2 (GAME_RUNNING), `amtrucks.exe` blocks ATS (GAME_RUNNING), and any name starting with `truckersmp` blocks both (CLIENT_RUNNING). A game never blocks the other game. A timeout, a failed run, oversized output or any malformed line is RUNNING_CHECK_FAILED, and the caller then changes nothing. Matching by name is conservative: a process of the same name from another folder also blocks.

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

**Contract with ET-018 (uninstall).** ET-018 reads this file before it deletes the data root. For each install, and only while neither that game nor TruckersMP is running:

1. It re-validates the layout: `bin`, `bin\win_x64` and `plugins` must still be plain folders, not links. Otherwise it skips the install.
2. It removes the exact temporary file of each `pending` entry for that folder when that file is a regular file.
3. It removes the DLL only while its hash is still the recorded `sha256` or a `known` hash. A locked or denied file is skipped and reported, never retried in a loop.
4. It removes the `plugins` folder only if `createdPluginsDirectory` is set and the folder is now empty.

Any other file stays.

## Remaining manual and real-environment checks

All of them stay pending after PR-2:

- real Steam installs: the default and a custom Steam path, including non-ASCII paths, the InstallPath fallback, several libraries on other drives and libraries moved through a junction;
- ETS2 and ATS loading the silently installed DLL, and a Steam update or file verification preserving it;
- TruckersMP's real process names and the blocking behaviour;
- `sdk unload` and `sdk reload` in the game console;
- UAC- or ACL-restricted libraries with the manual fallback, and antivirus interference with the rename;
- the real Windows dialogs, including the game folder dialog, and Explorer reveal, and the packaged Squirrel first launch;
- ET-018 uninstall cleanup and the readability of the card.

See [ET-017 validation](validation/et-017.md).

## Tests

See [TESTING.md](../TESTING.md#et-017-plugin-setup--october-17-2026) and [ET-017 validation](validation/et-017.md). PR-2's tests build fake Steam roots with `tests/shared/fake-steam.ts` inside `os.tmpdir()` and read them through `tests/shared/guarded-fs.ts`, which refuses and records any path outside its temporary root, also one whose real location lies outside it through a junction. No test reads Valve's registry keys or touches a real Steam or game folder.
