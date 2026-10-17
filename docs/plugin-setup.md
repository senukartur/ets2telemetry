# Game plugin setup (ET-017)

ET-017 implements the [silent plugin installation](../concept.md#silent-plugin-installation--october-12-2026) decided by the owner on October 12, 2026. The application finds ETS2 and ATS through the Steam libraries or a folder the driver chooses. It installs, updates or removes only its own `ets2telemetry-plugin.dll` in each game's `bin\win_x64\plugins` folder, and only while the game is closed. The coordinator adopted the architect's decisions P1–P20 for ET-017 on October 17, 2026.

ET-017 is delivered as six PRs:

| PR | Content | State |
| --- | --- | --- |
| PR-1 | The plugin DLL is bundled with a hash manifest ([bundle format](#bundle-format)) | Implemented; nothing reads the bundle at runtime |
| PR-2 | Steam and manual game-folder discovery ([Steam root](#steam-root), [Steam discovery](#steam-discovery), [manual game folder](#manual-game-folder), [running games](#running-games)) | Implemented as read-only modules; nothing calls them from main yet |
| PR-3 | The atomic installer ([algorithm](#algorithm)) and the [install registry](#install-registry) | Implemented as modules; nothing calls them from main yet |
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
- The script reads exactly two values through `[Microsoft.Win32.Registry]::GetValue`: `HKCU\Software\Valve\Steam\SteamPath`, then, as the fallback, `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`. Each value is read on its own, and one that cannot be read is `null`, so an unreadable machine-wide key never loses a readable SteamPath. It prints `{"steamPath": <base64>|null, "installPath": <base64>|null}`, where each value is the base64 of its UTF-8 bytes, so the console code page cannot change a non-ASCII path. Output that is not exactly this shape, uses non-canonical base64, is not UTF-8 or exceeds 4096 bytes per value is refused.
- The result is canonicalized: normalized with `path.win32`, resolved through `realpath` and checked again. SteamPath is used when it names an existing local folder; otherwise InstallPath. UNC, device, relative and missing paths are never used.
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

Implemented in PR-3 as `plugin-registry.ts` with the atomic writer `atomic-json-file.ts` (P9); nothing loads it from main until PR-4. The registry records which game folders this application manages, which plugin it installed or adopted there, and the operations in progress.

- **File.** `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json`, format `ets2telemetry.plugin-setup`, version 1. It is UTF-8 JSON, written with two-space indentation, the keys in this order and a final newline:

  ```text
  {
    format, version: 1,
    games: {ets2: {excluded, manualRoot}, ats: {excluded, manualRoot}},
    installs: [{game, root, source: steam|manual|adopted, sha256, appVersion, installedUtc, createdPluginsDirectory}],
    pending: [{op: install|update|remove, game, root, source: steam|manual, temp, fromSha256, toSha256, appVersion, createdPluginsDirectory, startedUtc}],
    lastFailure: {"<game>:<steam|manual>": {code, step, utc}}
  }
  ```

- **Strict parsing.** Exactly these keys at every level. A root is a normalized absolute drive path; `manualRoot` is such a path or `null`; hashes are 64 lowercase hex digits; versions look like `0.1.0` or `0.2.0-beta.1`; times are UTC ISO strings with milliseconds; there is one install per game and root, compared case-insensitively. A pending `install` has no `fromSha256` and an `update` has one; both name a `temp` that is exactly `ets2telemetry-plugin.dll.<16 lowercase hex>.tmp` in that root's `bin\win_x64\plugins`, so recovery can never remove another file. A `remove` has `temp`, `toSha256` and `appVersion` set to `null`. A `lastFailure` code is one of the P16 block reasons. A leading byte order mark is accepted.
- **Bounds.** At most 256 KiB, 16 installs and 16 pending entries. A change beyond them is refused with `REGISTRY_UNAVAILABLE`, and nothing is written.
- **Loading.** Loading never creates, changes or removes anything. A missing folder or file is the empty registry.
- **Writes.** As for the settings file ([settings](settings.md#saving)):
  - the folder is created if needed and must be a plain folder, not a link;
  - stale `setup.json.<pid>.<uuid>.tmp` files are removed, and no other file is touched;
  - a new temporary file is written with `wx`, synced, closed and renamed over `setup.json`, with up to five retries after 20, 40, 60, 80 and 100 ms on `EPERM`, `EACCES` or `EBUSY`.

  A failure removes the temporary file and keeps both the previous file and the document in memory; a change applies only after the rename. Changes are serialized, and main's single-instance lock guarantees one writer.
- **Invalid file.** The registry starts empty. The first write moves the file aside unchanged as `setup.rejected-<UTC yyyymmddThhmmssZ>.json` (`-2`, `-3`, … when that name exists), keeps the newest three such files and logs `PLUGIN_REGISTRY_QUARANTINED`.
- **Read-only states.** The registry is read-only for a newer version (the same format with a higher integer version), a `plugins` folder or `setup.json` that is a link or not a plain folder or file, a read error, and a missing or relative location. Nothing is written, and every installer operation reports `REGISTRY_UNAVAILABLE` before it touches a game folder.
- **Exclusions.** Game exclusions and the manual folder live here, not in `settings.json` (P10). PR-3 only stores them; PR-4 sets and uses them.
- **Failures.** `lastFailure` keeps the last failure of a game and target source with its step, for the card. A success for that key clears it. A failure repeated before any intent was written does not rewrite the file. A refusal by the running check writes nothing, so polling while a game runs never writes the registry.

**Contract with ET-018 (uninstall).** ET-018 reads this file before it deletes the data root. For each install, and only while neither that game nor TruckersMP is running:

1. It re-validates the layout: `bin`, `bin\win_x64` and `plugins` must still be plain folders, not links. Otherwise it skips the install.
2. It removes the exact temporary file of each `pending` entry for that folder when that file is a regular file.
3. It removes the DLL only while its hash is still the recorded `sha256` or a `known` hash. A locked or denied file is skipped and reported, never retried in a loop.
4. It removes the `plugins` folder only if `createdPluginsDirectory` is set and the folder is now empty.

Any other file stays.

## Algorithm

Implemented in PR-3 as `plugin-installer.ts` (P6–P8). The caller passes:

- the verified bundle bytes with their SHA-256, the bundle version and the `known` list;
- a target: the game, its source (`steam` or `manual`) and its canonical root;
- the registry and the running check.

The installer never reads the bundle itself; PR-4 supplies it. Operations on one target are sequential, and PR-4 runs them single-flight.

### Ownership (P6)

A regular file at `bin\win_x64\plugins\ets2telemetry-plugin.dll` is owned only when its SHA-256 equals one of these:

- the bundled hash;
- a `known` hash;
- the `sha256` of the registry's install record for that game and exactly that root. A hash recorded for another root does not count.

Anything else is `UNRECOGNIZED_FILE` and is never written, renamed or removed: a different file, a file over 16 MiB (which is not read), a folder, and a link or junction with the plugin's name. The version of an owned file is the bundle's, the `known` entry's or the record's.

### Install and update

1. **Running check.** The injected check (`checkRunningGames` in production) runs first. `GAME_RUNNING`, `CLIENT_RUNNING` or `RUNNING_CHECK_FAILED` (also for a check that throws) ends the operation before any file access. A read-only registry then gives `REGISTRY_UNAVAILABLE`, and the pending intents of this root are recovered (see [Recovery](#recovery)).
2. **Layout.** The root is validated again without following links. A linked `bin`, `bin\win_x64` or `plugins` is `LINKED_FOLDER`; a `plugins` entry that is not a folder, or a target that is not a regular file, is `UNRECOGNIZED_FILE`; a root that is no longer a game is `IO_ERROR`.
3. **Stale temporary files.** Regular files whose names match exactly `^ets2telemetry-plugin\.dll\.[0-9a-f]{16}\.tmp$` are removed. No other file is touched.
4. **Classification.** An unrecognized file stops the operation. An owned file that equals the bundle needs no change. Without an install record for the root it is adopted with source `adopted` (a manual copy, P12); a record with another hash is updated; otherwise nothing is written, not even the registry.
5. **Read-only target.** A target without the write permission bit (the Windows read-only attribute) is `READ_ONLY_FILE`; the attribute is never cleared.
6. **Pending intent.** `{op, game, root, source, temp, fromSha256, toSha256, appVersion, createdPluginsDirectory, startedUtc}` is written durably into the registry. If that write fails, the result is `REGISTRY_UNAVAILABLE` and the game folder is not changed. A missing `plugins` folder is created only after this write, without `recursive`, so the intent already records that this run creates it.
7. **Temporary file.** `ets2telemetry-plugin.dll.<16 hex>.tmp` is created with `wx`, written completely (a write that makes no progress fails), synced and closed.
8. **Verification.** The temporary file is read back and hashed. Another hash is `VERIFY_FAILED`, and the target is untouched.
9. **Replacement.** The temporary file is renamed over the target (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`). Only `EBUSY` (a sharing violation) is retried, after 20, 40, 60, 80 and 100 ms. `EPERM` is never retried and becomes `TARGET_LOCKED`. Windows reports it for a DLL that a running process has mapped (`npm run test:plugin-lock`) and, as measured on October 17, 2026, for a target that another process holds open without delete sharing.
10. **Re-hash.** The target is read and hashed again; another hash is `VERIFY_FAILED`.
11. **Result.** One registry write records the install, clears the intent and clears the target's last failure. The record has source `steam` or `manual`, and `createdPluginsDirectory` is kept from an earlier record or set by this run. If that write fails, the plugin stays in place, the intent stays, and the result is `REGISTRY_UNAVAILABLE`; the next run's recovery records the install.
12. **Cleanup.** In `finally`, the exact temporary file of this run is removed if it was not renamed. After a failure, a `plugins` folder this run created is removed if it is empty, the failure is recorded in `lastFailure`, and the intent is cleared. An intent whose temporary file could not be removed stays for recovery.

After a fresh install or update the running check runs once more. If the game started meanwhile, the result says that the game loads the plugin after a restart (P7).

### Removal (P11)

Excluding a game removes the plugin from each of its targets in this order:

1. the running check, the layout and the classification; an unrecognized file stays and is reported;
2. the read-only refusal, because Node's `unlink` would otherwise clear the attribute;
3. the pending intent `{op: remove, temp: null, fromSha256, …}`;
4. the unlink, with the same `EBUSY` retries and `EPERM` as `TARGET_LOCKED`;
5. the registry write that deletes the install record and clears the intent.

The `plugins` folder is removed only when the install record says that this application created it and the folder is now empty. When the target is already missing, the same rule applies to that empty folder and the record is deleted.

### Recovery

`recover()` runs at the start of each run; PR-4 calls it. It needs a writable registry and a successful running check, and the intents of a running game stay. For every other intent it removes the exact temporary file when that is a regular file, classifies the target again, and then:

- records the install when the target now has the intent's `toSha256`, because the rename completed before the interruption;
- deletes the install record of a removal whose target is gone;
- removes a `plugins` folder that the intent created and that is empty now;
- clears the intent and logs `PLUGIN_RECOVERED` with the game, source, operation and outcome (`installed`, `not-installed`, `removed` or `kept`).

An intent whose temporary file cannot be removed now stays. Every install or removal first recovers the intents of its own root.

### Error codes

| Where | `EACCES`, `EPERM`, `EROFS` | `EBUSY` | `ENOSPC` | Anything else |
| --- | --- | --- | --- | --- |
| Listing stale files, creating the folder, writing and reading back the temporary file | PERMISSION_DENIED | IO_ERROR | DISK_FULL | IO_ERROR |
| Reading the target (classification, re-hash) | PERMISSION_DENIED | TARGET_LOCKED | DISK_FULL | IO_ERROR |
| Renaming over or unlinking the target | TARGET_LOCKED for `EPERM`; PERMISSION_DENIED for `EACCES` and `EROFS` | TARGET_LOCKED after five retries | DISK_FULL | IO_ERROR |

Every result carries the operation, the outcome, the block reason, the step and the error code, never a path:

- outcomes: `installed`, `updated`, `unchanged`, `adopted`, `removed`, `absent` and `blocked`;
- steps: `process`, `registry`, `recover`, `layout`, `cleanup`, `classify`, `read-only`, `pending`, `directory`, `temp`, `verify`, `rename`, `rehash`, `unlink` and `record`.

PR-4 logs each result as `PLUGIN_ACTION`, on change only.

### Documented gaps

- Another process of the same user could swap the target between the classification (step 4) and the rename (step 9).
- An ACL that denies deleting only the target file makes the rename fail with `EPERM`, which reads as `TARGET_LOCKED` rather than `PERMISSION_DENIED`. A folder that denies creating files fails at step 7 as `PERMISSION_DENIED`.
- Node reports Windows' `ERROR_ACCESS_DENIED` as `EPERM`, so a locked target and a denied one are told apart only by the step.

## Remaining manual and real-environment checks

All of them stay pending after PR-3:

- real Steam installs: the default and a custom Steam path, including non-ASCII paths, the InstallPath fallback, several libraries on other drives and libraries moved through a junction;
- ETS2 and ATS loading the silently installed DLL, and a Steam update or file verification preserving it;
- TruckersMP's real process names and the blocking behaviour;
- `sdk unload` and `sdk reload` in the game console;
- UAC- or ACL-restricted libraries with the manual fallback, and antivirus interference with the rename (PR-3 checks only a sharing lock and an ACL deny on a temporary folder);
- the SCS loader's file filter: whether a game ever loads the `.tmp` file beside the DLL;
- the real Windows dialogs, including the game folder dialog, and Explorer reveal, and the packaged Squirrel first launch;
- ET-018 uninstall cleanup and the readability of the card.

See [ET-017 validation](validation/et-017.md).

## Tests

See [TESTING.md](../TESTING.md#et-017-plugin-setup--october-17-2026) and [ET-017 validation](validation/et-017.md). PR-2's tests build fake Steam roots with `tests/shared/fake-steam.ts` inside `os.tmpdir()` and read them through `tests/shared/guarded-fs.ts`, which refuses and records any path outside its temporary root, also one whose real location lies outside it through a junction. No test reads Valve's registry keys or touches a real Steam or game folder.

PR-3's installer and registry tests write only into fake game roots and a fake registry folder under that guarded root. They inject failures by wrapping the guarded file operations. Their real-system cases hold a real sharing lock from a Windows PowerShell child and deny file creation on the temporary `plugins` folder with `icacls`, removing that deny afterwards. `npm run test:plugin-lock` (`tests/integration/plugin-image-lock.test.ts`) loads the tests-only fake SDK host, named `eurotrucks2.exe`, with the test plugin DLL from a fake root. With a lister that wrongly reports no running game, an update and a removal end as `TARGET_LOCKED` and the DLL keeps its bytes. With the real `tasklist` lister, both stop at `GAME_RUNNING` before any file operation. The test first requires that no ETS2, ATS or TruckersMP process runs.
