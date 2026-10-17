# Game plugin setup (ET-017)

ET-017 implements the [silent plugin installation](../concept.md#silent-plugin-installation--october-12-2026) decided by the owner on October 12, 2026. The application finds ETS2 and ATS through the Steam libraries or a folder the driver chooses. It installs, updates or removes only its own `ets2telemetry-plugin.dll` in each game's `bin\win_x64\plugins` folder, and only while the game is closed. The coordinator adopted the architect's decisions P1–P20 for ET-017 on October 17, 2026.

ET-017 is delivered as six PRs:

| PR | Content | State |
| --- | --- | --- |
| PR-1 | The plugin DLL is bundled with a hash manifest ([bundle format](#bundle-format)) | Implemented; nothing reads the bundle at runtime |
| PR-2 | Steam and manual game-folder discovery ([Steam root](#steam-root), [Steam discovery](#steam-discovery), [manual game folder](#manual-game-folder), [running games](#running-games)) | Implemented; run from main since PR-4 |
| PR-3 | The atomic installer ([algorithm](#algorithm)) and the [install registry](#install-registry) | Implemented; run from main since PR-4 |
| PR-4 | Silent setup in main ([setup run](#setup-run)), the [mode gate](#mode-gate), the [runtime bundle reader](#runtime-reading), the per-game state in `AppState` and the [IPC channels](#ipc) | Implemented |
| PR-5 | The per-game plugin card on the dashboard ([the Game plugin card](#the-game-plugin-card)) and the `plugin` runtime smoke scenario | Implemented |
| PR-6 | The [connection diagnosis](#connection-diagnosis) on the card and the [diagnostic bundle](#diagnostic-bundle) with its `diagnostics:export` channel | Implemented |

Since PR-4 a packaged application in the `active` mode reads the bundle, discovers the games and silently installs, updates or removes its plugin, 2 s after it starts. Every development launch, smoke, test and installer harness is in the `disabled` mode and reads or writes nothing ([mode gate](#mode-gate)), except the `plugin` smoke scenario, which since PR-5 runs in the `test-root` mode against a fake root of its own. Since PR-5 the dashboard shows the per-game state in [the Game plugin card](#the-game-plugin-card). Since PR-6 the card also says why no game is connected and can save a redacted [diagnostic bundle](#diagnostic-bundle) through main's Save dialog; nothing is uploaded. The developer procedure in [manual plugin setup](manual-plugin-setup.md) stays the way to put the DLL into a game during development. No game, TruckersMP or performance claim follows from the bundle, discovery or the synthetic checks.

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

### Runtime reading

Since PR-4, `apps/desktop/src/plugin-setup/plugin-bundle.ts` reads the bundle in main (P5). It reads `process.resourcesPath\telemetry-plugin` when packaged and `<repo>\.local\package-native\telemetry-plugin` in development (the folder `npm run build` stages). It accepts the bundle only when:

- the folder is not a link and holds `ets2telemetry-plugin.dll` and `plugin-manifest.json`; other entries are ignored at runtime, because only these two files are read (the packaging inspection still requires exactly these two);
- the manifest is a regular file of at most 64 KiB, UTF-8 JSON with exactly the eight keys of the [manifest](#manifest) and valid values;
- the DLL is a regular file that is not a link, at most 16 MiB, read through one handle that is the file `lstat` saw;
- its size and SHA-256 equal the manifest's, and it is an x64 PE DLL.

The checks mirror `verifyPluginBundle` of the packaging inspection. Any failure is `BUNDLE_UNAVAILABLE` with a fixed failure code (`directory`, `manifest-unreadable`, `manifest-invalid`, `plugin-unreadable`, `plugin-not-file`, `plugin-size`, `plugin-hash`, `plugin-not-x64-dll` or `aborted`), logged as `PLUGIN_BUNDLE {state: 'unavailable', failure}`. Setup reads the bundle once per application run: a failed read is tried again on the next run, and after a success the installer only ever writes that verified in-memory copy and never reads the DLL again. Only "Show plugin file" uses the DLL's location, in main.

## Steam root

PR-2 adds how the application finds the games and validates a folder the user chose. The modules live in `apps/desktop/src/plugin-setup/`. They only read, and every file and process access goes through an injected port; since ET-017 PR-4 the [setup run](#setup-run) calls them behind the [mode gate](#mode-gate). No result here establishes that a real Steam installation, game or TruckersMP client behaves as described; see [remaining checks](#remaining-manual-and-real-environment-checks).

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

`game-processes.ts` runs the absolute `%SystemRoot%\System32\tasklist.exe /fo csv /nh` with a hidden window, no shell, a 10 s deadline and at most 1 MiB of output (P7). The deadline was 3 s until October 17, 2026: on a loaded machine (the full parallel test suite) the listing took longer than 3 s while a standalone run took 0.6 s, so setup would have blocked on `RUNNING_CHECK_FAILED`. It matches image names case-insensitively: `eurotrucks2.exe` blocks ETS2 (GAME_RUNNING), `amtrucks.exe` blocks ATS (GAME_RUNNING), and any name starting with `truckersmp` blocks both (CLIENT_RUNNING). A game never blocks the other game. A timeout, a failed run, oversized output or any malformed line is RUNNING_CHECK_FAILED, and the caller then changes nothing. Matching by name is conservative: a process of the same name from another folder also blocks.

## Mode gate

Implemented in PR-4 as `apps/desktop/src/plugin-setup/mode.ts`. The pure `pluginSetupMode` decides once at startup, from the environment and the packaged flag, whether plugin setup runs. The first matching row wins:

| Condition | Mode |
| --- | --- |
| `ETS2TELEMETRY_PLUGIN_SETUP` set to any value other than exactly `real` (`off`, `Off`, `false`, `0`, `REAL`, …) | disabled (reason `off`) |
| `ETS2TELEMETRY_PLUGIN_SETUP_ROOT=<absolute path>` and an absolute `ETS2TELEMETRY_PROFILE_DIR` | test-root |
| `ETS2TELEMETRY_PLUGIN_SETUP_ROOT` without a profile directory, or a relative root | disabled, logged as `PLUGIN_SETUP_MODE_REJECTED` |
| Any of `ETS2TELEMETRY_PROFILE_DIR`, `ETS2TELEMETRY_DIAGNOSTIC_DIR`, `ETS2TELEMETRY_LIVE_SMOKE` or `ETS2TELEMETRY_SOURCE_KIND` set, without a root | disabled |
| Unpackaged without `ETS2TELEMETRY_PLUGIN_SETUP=real` | disabled |
| Anything else | active |

An empty variable counts as unset, as for the profile override in main. The opt-out fails closed: since review round 1 of PR-4 any non-empty `ETS2TELEMETRY_PLUGIN_SETUP` other than exactly `real` disables setup, so a differently cased or misspelled `off` never leaves a packaged launch active. `real` keeps its meaning: it enables an unpackaged launch and changes nothing in a packaged one or beside a test root. The test root must be an absolute drive path: a UNC or device path is rejected like a relative one (`relative-root`), and so is a bare drive such as `C:\` or `C:\Steam\..` (`drive-root`), because every folder of that drive, a real Steam library included, would be inside it. A missing or relative profile directory is `no-profile` or `relative-profile`. A root without its marker file is `no-marker` (see test-root below). Main logs `PLUGIN_SETUP_MODE {mode, reason}` once at startup, with the reason `off`, `root-rejected`, `isolated-launch` or `development` for the disabled mode; a rejected root is first logged as `PLUGIN_SETUP_MODE_REJECTED {reason}`. Neither line carries the root.

- **test-root.** The root must hold the marker file `ets2telemetry-plugin-test-root.marker` as a regular file that is not a link; the harness that builds the fake root creates it. The setup run checks it once, through the confinement, before it reads or writes anything. Without it setup turns off for that application run (`PLUGIN_SETUP_MODE_REJECTED {reason: 'no-marker'}`, then `PLUGIN_SETUP_MODE {mode: 'disabled', reason: 'root-rejected'}`), the view's mode becomes `disabled` and the folder choice is refused with `SETUP_DISABLED`. A marker was chosen over requiring a folder inside `%TEMP%` because the runtime smokes keep their fake roots in the worktree's `.local\ci`. The Steam root is `<root>\Steam`. Nothing reads the Windows registry or runs PowerShell. The install registry is `<root>\LocalAppData\ETS2Telemetry\plugins\setup.json`, so every path setup writes lies inside the root. Every game-folder operation and every write of the install registry goes through a confinement: the path it names, its real location through any junction or symbolic link in an existing ancestor (and in its final component when the operation follows it) and every path `realpath` returns must lie inside the root. Anything else is refused before the real call as a missing path, so discovery and the installer ignore it, and the run logs `PLUGIN_TEST_ROOT_ESCAPE {count}`. A folder chosen in the dialog outside the root is refused as `FOLDER_UNSUPPORTED_PATH`. The running-game check is the real `tasklist`, which only reads.
- **disabled.** No registry read, no bundle read, no discovery, no timer and no write. Retry and the exclusion switch answer the unchanged view, and the folder dialog is refused with `SETUP_DISABLED` before it opens.
- Existing harnesses all land in disabled, except the `plugin` smoke scenario, which since PR-5 sets a test root of its own ([plugin smoke](#the-plugin-smoke-scenario)): the runtime smokes, the Playwright startup test, the native installer acceptance and the VM harness set a profile and a diagnostic directory, the `main-boundaries` unit fixture sets `ETS2TELEMETRY_SOURCE_KIND`, and `npm run dev` is unpackaged. The Squirrel lifecycle hooks quit before main constructs plugin setup. `tests/unit/plugin-setup-mode.test.ts` checks each of these environments.

## Setup run

Implemented in PR-4 as `apps/desktop/src/plugin-setup/plugin-setup.ts` (P13, P14). Main constructs it once, with the mode, and every file and child-process call is asynchronous; main owns the dialogs and the shell.

**Triggers.**

- **Launch.** The launch run starts 2 s after Electron is ready, on an unreferenced timer. Startup never awaits it; the tray and the telemetry service start as before.
- **Explicit.** Retry, a stored folder choice and an exclusion change each start a run.
- **Poll.** While a listed folder waits for `GAME_RUNNING`, `CLIENT_RUNNING`, `TARGET_LOCKED` or `RUNNING_CHECK_FAILED`, or after a run that hit its 30 s limit, the running games are listed every 15 s. A folder that waits for its game or the TruckersMP client starts a run when that blocker no longer runs. A failed listing and an unfinished run start a run as soon as the poll's own listing succeeds; while it keeps failing, the poll only goes on, so a transient listing failure never leaves the plugin unchanged for the whole session. A locked file (`TARGET_LOCKED`) starts a run when the running games changed since the last run, and otherwise at most three times in a row, so a file that something else holds open is not rewritten every 15 s; Retry tries again at any time. Without such a folder there is no poll.

**Single flight.** One run at a time. Every trigger during a run joins one follow-up run, which starts when the current run ends. Each run is aborted after 30 s (`PLUGIN_SETUP_TIMEOUT`); the PowerShell and `tasklist` calls keep their own 5 s and 10 s limits. A run lists the running games before each folder's change (and once more after a fresh install, and for recovery when intents are pending); a listing normally takes well under a second, but three listings at their 10 s limit fill the 30 s. An aborted run stops after the folder in progress, and the poll retries it.

**One run.**

1. It loads the install registry once per application run (again only while it was unreadable) and takes each game's exclusion from it.
2. It reads the bundle until that succeeds once ([runtime reading](#runtime-reading)).
3. It runs the installer's [recovery](#recovery). A reason for intents that stay is information, logged as `PLUGIN_RECOVERY_PENDING {remaining, reason}`; it never blocks other folders.
4. It discovers the Steam roots ([Steam discovery](#steam-discovery)) and validates the stored manual folder of each game again ([manual game folder](#manual-game-folder)). A manual folder that moved, became linked or is now a Steam root is `invalid` and is not changed; its install record stays.
5. For each listed folder in turn it installs or updates the plugin, or removes it from an excluded game ([algorithm](#algorithm)). Without a verified bundle every folder is `blocked` with `BUNDLE_UNAVAILABLE` and nothing is written.

A game lists at most four folders: its Steam roots in library order (ordinals 0 to 3), then its manual folder (ordinal 0). With a manual folder at most three Steam roots are listed and installed into. A fourth Steam root is then unlisted: the view counts it in `unlistedFolders`, the run logs `PLUGIN_TARGETS_LIMITED {game, count}` when the count changes, and it is never installed into. When the game is excluded, each unlisted root that has an install record in the registry still gets the same removal as a listed folder, logged as `PLUGIN_ACTION` with `listed: false`, so an exclusion never leaves this application's plugin behind; a removal there that waits for the game, the client or a lock keeps the poll running like a listed folder. A fourth copy of one game in Steam is not expected, because Steam installs one copy per library, and discovery itself reports at most four roots per game.

**State of a folder.** After its operation each folder is described from the result and, when the change did not happen, from what the folder holds now (read only):

| State | Meaning |
| --- | --- |
| `installed` | The bundled plugin is in place. An install that a running game or client refused while the folder already holds the current plugin has nothing left to do: it is `installed` without a reason and does not start the poll |
| `outdated` | An older plugin of this application is in place; `reason` says why it was not updated |
| `missing` | No plugin file; `reason` says why none was installed |
| `excluded` | The game is excluded and the folder holds no plugin of this application |
| `blocked` | The folder holds something this application cannot change now (an unrecognized file, a link, a locked or unreadable target), or the removal from an excluded game waits; `reason` says why |
| `working` | A folder seen for the first time in this application run, until its first result |

`lastFailure` is the failure the registry records for exactly that folder (`failures`, by game and canonical root).

**Logs.** Fixed codes and counts only, never a path, in the existing main log:

| Code | When |
| --- | --- |
| `PLUGIN_SETUP_MODE`, `PLUGIN_SETUP_MODE_REJECTED` | Once at startup, and once more when a test root lacks its marker |
| `PLUGIN_REGISTRY_STATE {state}` | When the registry's load state changes |
| `PLUGIN_BUNDLE {state, failure}` | When the bundle state changes |
| `PLUGIN_DISCOVERY {…counts}` | When the discovery facts change |
| `PLUGIN_ACTION {game, source, ordinal, op, outcome, code, step, errno}` | When a folder's result changes; with `listed: false` for a removal from an unlisted Steam root |
| `PLUGIN_TARGETS_LIMITED {game, count}` | When the number of unlisted Steam roots of a game changes |
| `PLUGIN_RECOVERY_PENDING {remaining, reason}` | When intents stay after recovery, and once when they are all resolved |
| `PLUGIN_RECOVERED`, `PLUGIN_REGISTRY_QUARANTINED` | From the installer and the registry, as described below |
| `PLUGIN_TEST_ROOT_ESCAPE {count}` | In the test-root mode, after a run or a choice that refused paths outside the root |
| `PLUGIN_SETUP_TIMEOUT {timeoutMs}` | A run reached 30 s |
| `PLUGIN_FOLDER_NOT_OPENED` | Explorer could not open a folder; its error text is not logged |

**Exit.** The exit's `begin`, and a fatal stop, abort plugin setup: no new run, poll or trigger starts, and the run in flight stops after the folder in progress. The exit's `idle` returns that run, which ends with the removal of its temporary file ([algorithm](#algorithm), step 12), together with any registry write of an exclusion change or a folder choice still in progress; it shares the existing 1000 ms idle budget with an in-flight settings save and an interrupted trip export ([application lifecycle](app-lifecycle.md#explicit-exit)). Requests are refused once the exit has begun, and a folder whose validation was still running when it began is not stored.

## IPC

Implemented in PR-4 (P16). The per-game state reaches the dashboard as `AppState.plugins` (`PluginSetupView` in `packages/contracts/src/app-state.ts`) through the existing `app:state` push and `app:get-state`; main pushes it whenever it changes. It has the mode, the bundled version with the first 12 hex digits of its SHA-256, whether a run is in progress, and per game the exclusion, the discovery outcome (`pending` until the first discovery), the manual folder state (`none`, `set` or `invalid`), at most four folders and the number of unlisted Steam roots (`unlistedFolders`). A folder is `{id, source, ordinal, state, reason, installed, lastFailure}`, with `id` `<game>:<source>:<ordinal>`. No path reaches the renderer: a folder is named by its source and ordinal, for example "Steam library 2".

Five invoke channels serve the trusted dashboard main frame only; the overlay and any other sender or frame are rejected. Argument counts are exact, the preload validates every argument and main validates it again (`apps/desktop/src/plugin-setup-contract.ts`), and every call is refused once the exit has begun. A failure inside plugin setup reaches the renderer as a fixed message, never its own text.

| Bridge method | Channel | Arguments | Result |
| --- | --- | --- | --- |
| `retryPluginSetup()` | `plugin:retry` | none | The view after the run |
| `choosePluginFolder(game)` | `plugin:choose-folder` | `ets2` or `ats` | `{outcome: 'chosen'}`, `{outcome: 'cancelled'}` or `{outcome: 'refused', code}` |
| `setPluginGameExcluded(game, excluded)` | `plugin:set-excluded` | a game and a boolean | The view after the run |
| `showPluginFile()` | `plugin:show-file` | none | `{outcome: 'shown'}` or `{outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'}` |
| `openPluginFolder(targetId)` | `plugin:open-folder` | a listed id matching `^(ets2\|ats):(steam\|manual):[0-3]$` | Nothing |

- **Folder choice.** Main opens `dialog.showOpenDialog(dashboard, {properties: ['openDirectory']})`, one at a time (a second call is refused with `BUSY`). A cancelled dialog, an empty selection or an exit that began while the dialog was open writes nothing. A chosen folder is validated ([manual game folder](#manual-game-folder)) and stored in the registry, replacing an earlier one, and a run starts; a refusal names one of the `FOLDER_*` codes, `REGISTRY_UNAVAILABLE` or, in the disabled mode, `SETUP_DISABLED`.
- **Exclusion.** The exclusion is written durably to the registry before the run; a registry that cannot be written rejects the call and nothing runs.
- **Show plugin file.** Right before `shell.showItemInFolder`, plugin setup checks the verified bundled DLL again with `lstat`. It answers `BUNDLE_UNAVAILABLE` and reveals nothing before the bundle was verified, when the file is missing or no longer a regular file, when it is a link, and once the exit has begun.
- **Open game plugins folder.** Main validates the listed folder again and opens its `bin\win_x64\plugins` folder with `shell.openPath` whenever that is a plain folder (also when it holds an unexpected entry, such as a folder with the plugin's name), or `bin\win_x64` when `plugins` is absent, a file or a link. An unknown id or a folder that is now linked or no longer a game opens nothing.

The sixth channel of P16, `diagnostics:export`, was added in PR-6 with the [diagnostic bundle](#diagnostic-bundle):

| Bridge method | Channel | Arguments | Result |
| --- | --- | --- | --- |
| `exportDiagnostics()` | `diagnostics:export` | none | `{outcome: 'saved'}`, `{outcome: 'cancelled'}`, `{outcome: 'refused', code}` with `EXPORT_IN_PROGRESS`, `EXPORT_INTERRUPTED` or `EXPORT_TARGET_REFUSED`, or `{outcome: 'failed', code}` with `DIALOG_FAILED`, `BUNDLE_FAILED` or `EXPORT_WRITE_FAILED` |

It serves the trusted dashboard main frame only and rejects the overlay, any other sender or frame and any argument; the preload forwards none. Once the exit has begun it answers `EXPORT_INTERRUPTED` without a dialog. It works in every mode, also `disabled`, because it reads only the application's own state and logs. The bridge method is appended after the plugin methods (`DesktopBridge` in `packages/contracts/src/index.ts`).

## The Game plugin card

Implemented in PR-5 (P18) as `apps/desktop/src/plugin-setup-card.tsx` on the Live tab, right after the Application status card. It is deliberately minimal and functional; the visual design follows the owner's mockups later. It is built only from the shadcn components in `apps/desktop/src/components/ui` (Card, Badge, Button, Switch, Label and Alert), and the overlay is untouched. All text comes from `apps/desktop/src/strings.ts` through the pure builder `apps/desktop/src/plugin-setup-text.ts`, which has a fixed text for every mode, discovery outcome, folder state, block reason, folder refusal and call answer.

The card shows:

- **Connection.** Since PR-6, one line at the top with the [connection diagnosis](#connection-diagnosis), and a note when a connected game still has an older plugin on disk.
- **Mode.** A note in the `disabled` and `test-root` modes; nothing in the `active` mode.
- **Bundle.** The bundled plugin's version and the first 12 hex digits of its SHA-256, or "not checked yet".
- **Run.** "Checking the game folders…" while a setup run is in progress.
- **Each game.**
  - A "Manage the plugin for this game" switch. Switching it off calls `setPluginGameExcluded(game, true)`; switching it on includes the game again.
  - The discovery outcome, the chosen folder's state and the count of unlisted Steam folders. In the `disabled` mode, which never searches, the discovery note is "Not searched in this launch." instead of "Looking for the game…".
  - Each listed folder by its label: "Steam folder N", where N is its position among the game's Steam folders from 1, or "Chosen folder". After the label come its state as a badge and lines for the reason, the installed version of a plugin that is not current, and the last problem when it differs from the reason.
  - "Choose game folder…".
- **Manual copy (P12).** For `PERMISSION_DENIED`, `READ_ONLY_FILE` and `UNRECOGNIZED_FILE` the folder adds the manual-copy hint and two buttons, "Show plugin file" and "Open game plugins folder".
- **Manual removal (PR #111 review).** In an excluded game the folder's change is a removal, so the card never suggests copying the plugin in. A removal refused with `PERMISSION_DENIED` or `READ_ONLY_FILE` adds "To remove it by hand: close the game, delete the plugin file from the game's plugins folder (Windows may ask for administrator rights), then press Retry." and only "Open game plugins folder". An unrecognized file there, which this application would not remove, gets no manual action, and its folder line says "A file with the plugin's name that this application did not install is in this folder; it is left as it is." without the advice to move it, also as the last problem.
- **Retry.** One Retry button for the whole card.
- **Export diagnostics…** Since PR-6, a button with the note that the file holds no paths or user and computer names and that nothing is uploaded ([diagnostic bundle](#diagnostic-bundle)). It stays available in the `disabled` mode.
- **Answers.** The answer of the last call appears as one status line: a fixed text for a saved, cancelled or refused folder choice, for a shown or unavailable plugin file, for each diagnostics export outcome, and "The request failed; nothing changed." for a rejected call.

A folder that holds the current plugin but whose install record could not be written (the registry is read-only, from a newer version, or its write failed) shows **Installed** with the `REGISTRY_UNAVAILABLE` text since PR-6, instead of only a log row; it arms no poll. ET-018's uninstall cleanup relies on that record.

A locked file (`TARGET_LOCKED`) shows only its automatic-retry text, because setup tries it again by itself.

In the `disabled` mode the switches, the folder buttons and Retry are disabled, because they would change nothing. The `scaffold` runtime smoke, which runs disabled with a rendered dashboard, asserts the disabled-mode note and that the five controls are disabled, and `RuntimeReceipt.ps1` requires that evidence (`pluginCard`) and one `PLUGIN_SETUP_MODE` row with `disabled`. Since PR-6 it also asserts the diagnosis line's fixed `NO_GAME_SELECTED` text (the scaffold launch selects no game) and that "Export diagnostics…" is enabled (`diagnosisShown`, `exportAvailable`).

The card never shows a path: the view carries none, and the folder labels use only the source and position. A renderer that only shows the pushed view cannot reveal one; the `plugin` smoke checks the card's text for the fixture root and for drive and UNC paths.

### The plugin smoke scenario

Since PR-5 the `plugin` runtime smoke scenario (`Invoke-RuntimeSmoke.ps1 -Scenario plugin`) runs the application in the `test-root` mode. Review round 1 of PR-5 moved the journey out of the `lifecycle` smoke, which is back in its PR-4 shape, so that the gating packaged lifecycle step keeps its 60 s Job. The `plugin` scenario has its own Job of 120 s. CI runs the packaged `plugin` smoke on pull requests and the development one on pushes to `main` and dispatches, like the other development smokes. Before run A, `scripts/ci/plugin-fixture.mjs` first fails loudly if `tasklist` lists `eurotrucks2.exe`, `amtrucks.exe` or a `truckersmp*` process. It then builds `<run output>\plugin-root` with:

- the marker file;
- `Steam`, whose library list names LibraryA and LibraryB;
- ETS2 in LibraryA, whose plugins folder holds an unrelated DLL and a text file;
- ATS in LibraryB, without a plugins folder;
- a manual ETS2 folder holding an unrecognized file with the plugin's name. The smoke cannot click the folder dialog, so the fixture seeds the install registry with that folder.

Nothing reads the Windows registry or touches a real Steam or game folder.

- **Run A.** The launch run must reach:
  - in `AppState.plugins`, installed for both Steam folders and blocked with `UNRECOGNIZED_FILE` for the manual folder;
  - in the card, Installed / Blocked / Installed, with no path in its text.

  Both installed DLLs must have the bundled manifest's SHA-256. The driver records the phase `plugin-run-a-settled`. The unrelated DLL, the text file and the unrecognized file must keep their bytes and modification times. The smoke then clicks the ATS switch in the card. ATS must become excluded, its plugin must be removed together with the plugins folder created for it, and every other file must stay unchanged (phase `plugin-excluded`). Run A then exits orderly.
- **Run B.** The restart must reach the same states, with ATS excluded, and write nothing: every fixture file, the install registry included, keeps its bytes and modification time. Its `PLUGIN_ACTION` rows may only be `unchanged`, `blocked` or `absent` (phase `plugin-run-b-settled`), and it exits orderly.
- **Diagnostics export (PR-6).** After run B's checks the smoke presses "Export diagnostics…" twice. Main's Save dialog is replaced through Playwright's main-process evaluate, as in the journal export journey. A cancelled dialog must write nothing. The second time, the dialog answers with a file in the run's output folder, outside the fake root. The file must be a `ets2telemetry.diagnostics` v1 bundle of at most 2 MiB with the `test-root` plugin view in run B's states and the diagnosis `NO_GAME_SELECTED`. It must hold rows of both logs, without `detail` or `pid`, among them the main log's `PLUGIN_SETUP_MODE` and `PLUGIN_ACTION` rows, found by their event codes. The text must contain no drive or UNC path and not the fake root, the output folder or the isolated LOCALAPPDATA, also in their JSON-escaped form. The user and computer names must not appear in the runtime strings the bundle redacts: fact keys, string fact values and the OS release, after the `<redacted>` marker is set aside. A second layer then scans the whole text for every name that is not a whole word of a schema token. The tokens are the bundle's keys and its string values without whitespace outside the runtime strings, derived from the bundle itself, so a free-text field added outside the redaction scope cannot carry a name unnoticed. Since the PR #111 review these checks live in `scripts/ci/diagnostics-bundle-check.mjs`, so that a name such as `main`, `logs` or `diagnostics`, which matches the preserved schema, or `mode` or `root`, which legitimately redacts a fact, cannot fail a correctly redacted bundle; `tests/unit/diagnostics-bundle-check.test.ts` runs them on bundles the real builder made for such names. The dialog must have been offered once, owned by a window, with the default `ets2telemetry-diagnostics-<UTC>.json` name and the JSON filter (phase `plugin-diagnostics-exported`). Run B's main log must hold exactly `DIAGNOSTICS_EXPORT_CANCELLED` and `DIAGNOSTICS_EXPORT_SAVED {bytes}`.
- **Logs.** Both runs log `PLUGIN_SETUP_MODE` with `test-root` and no `PLUGIN_TEST_ROOT_ESCAPE`. `RuntimeReceipt.ps1` requires the journey's flags (`pluginDiagnosticsExported` since PR-6), both orderly exits and these rows.

The evidence names files by fixed labels and hashes only, never by path. A fixture file-system failure is reported as a fixed `PLUGIN_FIXTURE_<step>` error (`BUILD`, `BUNDLE` or `SNAPSHOT`) with the error code only.

## Connection diagnosis

Implemented in PR-6 (P17) as the pure `connectionDiagnosis(plugins, status, selection, health)` in `apps/desktop/src/connection-diagnosis.ts`. The dashboard computes it from `AppState.plugins`, the live update's status and selection and `AppState.health`, and the card shows its fixed text (`CONNECTION_DIAGNOSIS_TEXT` in `strings.ts`). The first code that applies wins:

| Order | Code | When (mapped onto the current types) |
| --- | --- | --- |
| 1 | `SERVICE_UNAVAILABLE` | The service health is not `ready` (`starting`, `restarting`, `failed`, `stopping`), or the live status is `service-failed` or `restarting` |
| 2 | `CONNECTED` | The live status is `connected` or `paused`, for any selection |
| 3 | `NO_GAME_SELECTED` | The selection is the "Select a game" placeholder (`game`), `synthetic` or `replay` |
| 4 | `SETUP_DISABLED` | Plugin setup is `disabled` in this launch, so no game folder was checked |
| 5 | `GAME_NOT_FOUND` | The selected game's discovery finished and listed no game folder |
| 6 | `PLUGIN_BLOCKED_PERMISSION` | A listed folder of the selected game has `PERMISSION_DENIED` or `READ_ONLY_FILE`. This also covers a removal refused in an excluded game, so since the PR #111 review the text says that Windows did not allow the plugin file to be changed and points to the folder line, which tells a copy from a removal |
| 7 | `PLUGIN_UNRECOGNIZED` | A listed folder of a managed game has `UNRECOGNIZED_FILE`. An excluded game installs nothing, so since the PR #111 delta review such a folder counts as missing (row 12), whose text says to manage the game again |
| 8 | `PLUGIN_OUTDATED` | A listed folder is `outdated` (from the file's hash on disk) |
| 9 | `PLUGIN_PENDING_GAME_CLOSE` | A listed folder that is not `installed` waits with `GAME_RUNNING`, `CLIENT_RUNNING` or `TARGET_LOCKED` |
| 10 | `PLUGIN_BUNDLE_UNAVAILABLE` | A listed folder is blocked by `BUNDLE_UNAVAILABLE`: the bundled plugin is missing or damaged, so the text says to reinstall ETS2Telemetry |
| 11 | `PLUGIN_NOT_CHECKED` | A listed folder is blocked by `LINKED_FOLDER` or `IO_ERROR`: the plugin could not be checked there, and the text points to the folder line |
| 12 | `PLUGIN_MISSING` | A listed folder is `missing`, `excluded` (an excluded game) or `blocked` for any other reason |
| 13 | `TRANSPORT_FAILED` | The live status is `incompatible` or `unavailable`. Neither is tried again by itself: `incompatible` closes the connection without a retry, and `unavailable` means the selection found no configured native client or fixture. The card's Retry runs only plugin setup, so the text says to choose another source and then the game again, or to exit ETS2Telemetry from the tray and start it again (PR #111 review) |
| 14 | `NO_RUNNING_SOURCE` | Anything else: `waiting`, `stale` or `disconnected`, with the plugin in place |

Rows 6–12 are the folder rows. They look only at the selected game's listed folders, and each folder counts once, under the first folder row that applies to it (a folder blocked by an unrecognized file is not also missing). Rows 10 and 11 were split from `PLUGIN_MISSING` in the PR-6 review, because its advice (manage the game, Retry) does not help them; they are separate codes rather than reason-specific texts, so the diagnostic bundle records them too.

- **No folder holds the current plugin.** The first folder row that applies to any folder is the headline; one folder in that condition is enough.
- **A folder holds the current plugin** (state `installed`, which means the bundled plugin is in place, also one that keeps `REGISTRY_UNAVAILABLE`). The game can load the plugin from that folder, so the other folders' problems do not explain a missing connection (PR-6 review). Each folder row that applies to another folder becomes a note, in the rows' order: `OTHER_FOLDER_BLOCKED_PERMISSION`, `OTHER_FOLDER_UNRECOGNIZED`, `PLUGIN_OUTDATED_ON_DISK`, `OTHER_FOLDER_PENDING_GAME_CLOSE`, `OTHER_FOLDER_BUNDLE_UNAVAILABLE`, `OTHER_FOLDER_NOT_CHECKED` and `OTHER_FOLDER_MISSING`. The headline falls through to rows 13 and 14. For example, a current Steam folder and a chosen folder with an unrecognized file give `NO_RUNNING_SOURCE`, or `TRANSPORT_FAILED` while the connection fails, with the note `OTHER_FOLDER_UNRECOGNIZED`.

A discovery still `pending` without folders and folders that are `working` fall through to rows 13 and 14. With `CONNECTED`, a listed folder of the selected game that is still `outdated` adds the note `PLUGIN_OUTDATED_ON_DISK`. The diagnosis reads only the pushed view and the live status, never a game folder, and its texts carry no path.

## Diagnostic bundle

Implemented in PR-6 (P17). "Export diagnostics…" on the card calls `exportDiagnostics()`; main (`apps/desktop/src/diagnostic-bundle-writer.ts`) opens its Save dialog parented to the dashboard window with the default name `ets2telemetry-diagnostics-<UTC>.json` (for example `ets2telemetry-diagnostics-20261017T083015Z.json`) in Documents and the JSON filter. One export runs at a time.

- **Content** (`apps/desktop/src/diagnostic-bundle.ts`). One JSON document, format `ets2telemetry.diagnostics`, version 1, at most 2 MiB:
  - `createdUtc`, and `app` with the application, Electron and Node versions, the packaged flag and `os.release()`;
  - `health`, `settings` and `plugins` from `AppState`, and `bundledPlugin` (the verified bundled version and hash prefix, or null);
  - `live` with the status and selection of main's last live update, and the `diagnosis`;
  - `logs.main` and `logs.service`: the last rows of `startup.jsonl.1` then `startup.jsonl` of main's log directory (`%LOCALAPPDATA%\ETS2Telemetry\logs`, or the diagnostic directory of an isolated launch) and of its `service` subdirectory, each file's last 256 KiB, at most 2000 rows per log;
  - `omittedLogRows` per log: unreadable lines, rows beyond 2000 and rows left out for the size bound.
- **Redaction.**
  - A log row keeps only `time` (an ISO UTC time), `event` (a fixed code) and `facts`; `detail`, `pid` and anything else is dropped, and a line that is not such a row is left out.
  - A fact keeps only scalar values under plain keys. A fact string that contains `\`, `/` or a drive colon (`C:` at the start or after a non-word character) becomes `<redacted>`, as does a nested value; other strings are cut at 256 characters.
  - The Windows user name and computer name (`os.userInfo().username`, `os.hostname()` and `USERNAME`, `COMPUTERNAME` and `USERDOMAIN`) are replaced by `<redacted>`, case-insensitively and as whole words, in runtime content only: every log row's fact keys and string fact values, and `app.osRelease`. Since the PR #111 review the format, every schema key, enum code, version and event code stay exactly as written, so a name such as `main`, `logs` or `diagnostics` cannot change the document's shape or break the size trim. Names shorter than two characters are not replaced.
  - The views carry no Steam, library or game path, and nothing reads the Windows registry for the bundle.
- **Size bound.** While the text exceeds 2 MiB, the oldest eighth of the longer log's rows is left out and counted. Four full startup logs fit without that.
- **Saving.** The target checks and the write are shared with the [trip export](journal-export.md) in `apps/desktop/src/export-file.ts`. A target inside `<LOCALAPPDATA>\ETS2Telemetry`, by name, by its real path (a junction) or by file identity, a device path or a relative path is refused with `EXPORT_TARGET_REFUSED`, before the bundle is built. The bundle is built only after an allowed file was chosen, then written to `<name>.<hex8>.partial` beside the target, synced, closed and renamed over the target, with the rename retried as for settings saves. A cancelled dialog reads and writes nothing, and a Save dialog that rejects answers `DIALOG_FAILED` (PR-6 review) without reading or writing; a failure or an exit removes the partial file and leaves an existing target unchanged.
- **Exit.** The exit's `begin` and a fatal stop abort the export; its file work joins the existing 1000 ms idle budget ([application lifecycle](app-lifecycle.md)).
- **Logs.** `DIAGNOSTICS_EXPORT_CANCELLED`, `DIAGNOSTICS_EXPORT_SAVED {bytes}` and `DIAGNOSTICS_EXPORT_FAILED {outcome, code, step?, errno?}` in the main log; no path.
- **No upload.** The bundle is a file the driver chooses where to save and attaches to a report by hand.

The real Windows Save dialog and a real user's logs remain manual checks.

## Install registry

Implemented in PR-3 as `plugin-registry.ts` with the atomic writer `atomic-json-file.ts` (P9); since PR-4 the [setup run](#setup-run) loads and writes it. The registry records which game folders this application manages, which plugin it installed or adopted there, and the operations in progress.

- **File.** `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json`, format `ets2telemetry.plugin-setup`, version 1. It is UTF-8 JSON, written with two-space indentation, the keys in this order and a final newline:

  ```text
  {
    format, version: 1,
    games: {ets2: {excluded, manualRoot}, ats: {excluded, manualRoot}},
    installs: [{game, root, source: steam|manual|adopted, sha256, appVersion, installedUtc, createdPluginsDirectory}],
    pending: [{op: install|update|remove, game, root, source: steam|manual, temp, fromSha256, toSha256, appVersion, createdPluginsDirectory, startedUtc}],
    failures: [{game, root, code, step, utc}]
  }
  ```

- **Strict parsing.** Exactly these keys at every level. A root is a normalized absolute drive path; `manualRoot` is such a path or `null`; hashes are 64 lowercase hex digits; versions look like `0.1.0` or `0.2.0-beta.1`; times are UTC ISO strings with milliseconds; there is one install per game and root, compared case-insensitively. A pending `install` has no `fromSha256` and an `update` has one; both name a `temp` that is exactly `ets2telemetry-plugin.dll.<16 lowercase hex>.tmp` in that root's `bin\win_x64\plugins`, so recovery can never remove another file. A `remove` has `temp`, `toSha256` and `appVersion` set to `null`. There is at most one failure per game and root; its code is one of the P16 block reasons. A leading byte order mark is accepted.
- **Bounds.** At most 256 KiB, 16 installs, 16 pending entries and 16 failures. A change beyond the install or pending bound is refused with `REGISTRY_UNAVAILABLE`, and nothing is written; the installer checks the install bound before it changes a game folder (see [Algorithm](#algorithm)). A new failure beyond 16 drops the oldest failure of another folder, because failures only inform the card.
- **Loading.** Loading never creates, changes or removes anything. A missing folder or file is the empty registry.
- **Writes.** As for the settings file ([settings](settings.md#saving)):
  - the folder is created if needed and must be a plain folder, not a link;
  - stale `setup.json.<pid>.<uuid>.tmp` files are removed, and no other file is touched;
  - a new temporary file is written with `wx`, synced, closed and renamed over `setup.json`, with up to five retries after 20, 40, 60, 80 and 100 ms on `EPERM`, `EACCES` or `EBUSY`.

  A failure removes the temporary file and keeps both the previous file and the document in memory; a change applies only after the rename. Changes are serialized, and main's single-instance lock guarantees one writer. As for settings, Node.js cannot flush a directory entry on Windows, so the rename itself is not separately flushed: a power loss right after a write can lose the latest registry change, for example a pending intent, while a change already made in a game folder on another drive persists. The next run then sees an owned plugin without its intent or record, which ownership by the bundled or a `known` hash still covers.
- **Invalid file.** The registry starts empty. The first write moves the file aside unchanged as `setup.rejected-<UTC yyyymmddThhmmssZ>.json` (`-2`, `-3`, … when that name exists), keeps the newest three such files and logs `PLUGIN_REGISTRY_QUARANTINED`.
- **Read-only states.** The registry is read-only for a newer version (the same format with a higher integer version; a file over 256 KiB is classified from its first bytes, so a large newer file is never quarantined), a `plugins` folder or `setup.json` that is a link or not a plain folder or file, a read error, and a missing or relative location. Nothing is written, and every installer operation reports `REGISTRY_UNAVAILABLE` before it touches a game folder.
- **Exclusions.** Game exclusions and the manual folder live here, not in `settings.json` (P10). Since PR-4 the exclusion switch and the folder dialog set them, and every [setup run](#setup-run) reads them.
- **Failures.** `failures` keeps the last failure of each game folder (game and canonical root) with its step; since PR-4 it is that folder's `lastFailure` in the [IPC view](#ipc). A success in that folder clears it, and a failure or success in one root never replaces or clears another root's failure. A failure repeated before any intent was written does not rewrite the file. A refusal by the running check writes nothing, so polling while a game runs never writes the registry. Each automatic retry of a locked file (at most three while the running games stay the same, see [setup run](#setup-run)) writes an intent and a failure.

**Format change before release.** Review round 1 of PR-3 (October 17, 2026) replaced the first form of the failure field, `lastFailure` keyed `<game>:<source>`, with the per-folder `failures` list, because the up to four Steam roots of one game overwrote and cleared each other's failure. Nothing had shipped, so version 1 was changed in place; no released build ever wrote the old form, and the parser refuses it.

**Contract with ET-018 (uninstall).** ET-018 reads this file before it deletes the data root.

- **Registry states.** It acts only on a registry that loads as `loaded` or `empty`. For an `invalid-file`, `newer-version` or `unreadable` registry it touches no game folder, reports that the plugin could not be removed, and keeps `plugins\setup.json` (and any `setup.rejected-*.json`) while it deletes the rest of the data root, so that a manual retry or a newer version can still find the installs. An `empty` registry means nothing to clean.
- **Folders.** Every game folder named by an install record or by a pending `install` or `update` intent, each once. A pending `remove` intent's folder has an install record or nothing left to remove.

For each folder, and only while neither that game nor TruckersMP is running:

1. It re-validates the layout: `bin`, `bin\win_x64` and `plugins` must still be plain folders, not links. Otherwise it skips the folder.
2. It removes the exact temporary file of each `pending` entry for that folder when that file is a regular file.
3. It removes the DLL only while its hash is still the recorded `sha256`, the `toSha256` of a pending install or update for that folder, or a `known` hash. A read-only DLL (`READ_ONLY_FILE`) is skipped and reported, because an unlink would clear the attribute. A locked or denied file is skipped and reported, never retried in a loop.
4. It removes the `plugins` folder only if the install record's or a pending intent's `createdPluginsDirectory` is set and the folder is now empty.

Any other file stays.

## Algorithm

Implemented in PR-3 as `plugin-installer.ts` (P6–P8). The caller passes:

- the verified bundle bytes with their SHA-256, the bundle version and the `known` list;
- a target: the game, its source (`steam` or `manual`) and its canonical root;
- the registry and the running check.

The installer never reads the bundle itself; the [setup run](#setup-run) supplies the verified buffer. Operations on one target are sequential, and the setup run is single-flight.

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

Before step 2, a folder without an install record is refused with `REGISTRY_UNAVAILABLE` at step `pending` when 16 folders are already recorded, with no file operation in the game folder, so a result that could not be recorded never leaves an orphaned DLL. This also covers adopting a manual copy.
6. **Pending intent.** `{op, game, root, source, temp, fromSha256, toSha256, appVersion, createdPluginsDirectory, startedUtc}` is written durably into the registry. If that write fails, the result is `REGISTRY_UNAVAILABLE` and the game folder is not changed. A missing `plugins` folder is created only after this write, without `recursive`, so the intent already records that this run creates it. If another process created the folder meanwhile (`EEXIST`), the intent is rewritten durably with `createdPluginsDirectory: false` before anything else happens; if that write fails, the result is `REGISTRY_UNAVAILABLE` at step `directory`.
7. **Temporary file.** `ets2telemetry-plugin.dll.<16 hex>.tmp` is created with `wx`, written completely (a write that makes no progress fails), synced and closed.
8. **Verification.** The temporary file is read back and hashed. Another hash is `VERIFY_FAILED`, and the target is untouched.
9. **Replacement.** The temporary file is renamed over the target (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`). Only `EBUSY` (a sharing violation) is retried, after 20, 40, 60, 80 and 100 ms. `EPERM` is never retried and becomes `TARGET_LOCKED`. Windows reports it for a DLL that a running process has mapped (`npm run test:plugin-lock`) and, as measured on October 17, 2026, for a target that another process holds open without delete sharing.
10. **Re-hash.** The target is read and hashed again; another hash is `VERIFY_FAILED`.
11. **Result.** One registry write records the install, clears the intent and clears the target's last failure. The record has source `steam` or `manual`, and `createdPluginsDirectory` is kept from an earlier record or set by this run. If that write fails, the plugin stays in place, the intent stays, and the result is `REGISTRY_UNAVAILABLE`; the next run's recovery records the install.
12. **Cleanup.** In `finally`, the exact temporary file of this run is removed if it was not renamed. After a failure, a `plugins` folder this run created is removed if it is empty, the failure is recorded for this folder, and the intent is cleared. The intent stays for recovery when its temporary file could not be removed, and always once the rename has happened, for example when the re-hash could not read the target: recovery then records the install from what is on disk, with its `createdPluginsDirectory`.

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

`recover()` runs at the start of each [setup run](#setup-run). It needs a writable registry and a successful running check, and the intents of a running game stay. Every other intent is resolved on its own, with its own registry write. The layout must still be ready (no link, still a game); otherwise the intent stays and nothing in the folder is touched. One exception: when the root itself no longer exists (`ENOENT`) while its parent folder is still a plain folder, the game or its folder was removed, the temporary file went with it, and the intent is cleared and logged with the outcome `gone`. A missing parent, as on an unplugged drive, keeps the intent. Recovery then removes the exact temporary file when that is a regular file, classifies the target again, and then:

- records the install when the target now has the intent's `toSha256`, because the rename completed before the interruption. When 16 other folders are already recorded, the intent is cleared without a record and logged with the outcome `unrecorded`; the file then stays owned only through the bundled or a `known` hash;
- deletes the install record of a removal whose target is gone;
- removes a `plugins` folder that the intent created and that is empty now;
- clears the intent and logs `PLUGIN_RECOVERED` with the game, source, operation and outcome (`installed`, `not-installed`, `unrecorded`, `gone`, `removed` or `kept`).

An intent whose layout changed, whose temporary file cannot be removed now, or whose target cannot be read (for example while it is locked) stays, and the reason is reported. Every install or removal first recovers the intents of its own root.

### Error codes

| Where | `EACCES`, `EPERM`, `EROFS` | `EBUSY` | `ENOSPC` | Anything else |
| --- | --- | --- | --- | --- |
| Listing stale files, creating the folder, writing and reading back the temporary file | PERMISSION_DENIED | IO_ERROR | DISK_FULL | IO_ERROR |
| Reading the target (classification, re-hash) | PERMISSION_DENIED | TARGET_LOCKED | DISK_FULL | IO_ERROR |
| Renaming over or unlinking the target | TARGET_LOCKED for `EPERM`; PERMISSION_DENIED for `EACCES` and `EROFS` | TARGET_LOCKED after five retries | DISK_FULL | IO_ERROR |

Every result carries the operation, the outcome, the block reason, the step and the error code, never a path:

- outcomes: `installed`, `updated`, `unchanged`, `adopted`, `removed`, `absent` and `blocked`;
- steps: `process`, `registry`, `recover`, `layout`, `cleanup`, `classify`, `read-only`, `pending`, `directory`, `temp`, `verify`, `rename`, `rehash`, `unlink` and `record`.

The [setup run](#setup-run) logs each result as `PLUGIN_ACTION`, on change only.

### Documented gaps

- Another process of the same user could swap the target, or a folder above it, between the classification (step 4) and the rename (step 9).
- The registry rename is not separately flushed (see [Install registry](#install-registry)): a power loss can lose the latest intent while a change in a game folder on another drive persists.
- An intent whose folder stays linked, unreadable or present but no longer a game, or whose parent folder or drive is missing, is kept indefinitely; it counts against the 16-intent bound until the folder is repaired or comes back, or ET-018 cleans it. Only a root that is itself gone while its parent folder remains clears its intent (outcome `gone`), because nothing is left to clean. A removed Steam library whose game folder's parent is gone too therefore keeps its intent.
- An ACL that denies deleting only the target file makes the rename fail with `EPERM`, which reads as `TARGET_LOCKED` rather than `PERMISSION_DENIED`. A folder that denies creating files fails at step 7 as `PERMISSION_DENIED`.
- Node reports Windows' `ERROR_ACCESS_DENIED` as `EPERM`, so a locked target and a denied one are told apart only by the step.

## Remaining manual and real-environment checks

All of them stay pending after PR-6:

- real Steam installs: the default and a custom Steam path, including non-ASCII paths, the InstallPath fallback, several libraries on other drives and libraries moved through a junction;
- ETS2 and ATS loading the silently installed DLL, and a Steam update or file verification preserving it;
- TruckersMP's real process names and the blocking behaviour;
- `sdk unload` and `sdk reload` in the game console;
- UAC- or ACL-restricted libraries with the manual fallback, and antivirus interference with the rename (PR-3 checks only a sharing lock and an ACL deny on a temporary folder);
- the SCS loader's file filter: whether a game ever loads the `.tmp` file beside the DLL;
- the real Windows dialogs, including the game folder dialog and the diagnostics Save dialog, and Explorer reveal, and the packaged Squirrel first launch;
- the connection diagnosis against real games, TruckersMP and a real plugin connection, and a diagnostic bundle from a real user's profile and logs;
- ET-018 uninstall cleanup and the readability of the card.

See [ET-017 validation](validation/et-017.md).

## Tests

See [TESTING.md](../TESTING.md#et-017-plugin-setup--october-17-2026) and [ET-017 validation](validation/et-017.md). PR-2's tests build fake Steam roots with `tests/shared/fake-steam.ts` inside `os.tmpdir()` and read them through `tests/shared/guarded-fs.ts`, which refuses and records any path outside its temporary root, also one whose real location lies outside it through a junction. No test reads Valve's registry keys or touches a real Steam or game folder.

PR-3's installer and registry tests write only into fake game roots and a fake registry folder under that guarded root. They inject failures by wrapping the guarded file operations. Their real-system cases hold a real sharing lock from a Windows PowerShell child and deny file creation on the temporary `plugins` folder with `icacls`, removing that deny afterwards. `npm run test:plugin-lock` (`tests/integration/plugin-image-lock.test.ts`) loads the tests-only fake SDK host, named `eurotrucks2.exe`, with the test plugin DLL from a fake root. With a lister that wrongly reports no running game, an update and a removal end as `TARGET_LOCKED` and the DLL keeps its bytes. With the real `tasklist` lister, both stop at `GAME_RUNNING` before any file operation. The test first requires that no ETS2, ATS or TruckersMP process runs.

PR-4's orchestrator tests (`tests/unit/plugin-setup.test.ts`) run the setup in the test-root mode on the same guarded root, with a fake running-game lister and fake `setTimeout`; the confinement must refuse a library and a junction outside the root before the guarded file system sees them. The mode gate (`tests/unit/plugin-setup-mode.test.ts`) and the bundle reader (`tests/unit/plugin-bundle.test.ts`) are tested without a game, and `tests/unit/main-boundaries.test.ts` checks main's channels against a fake orchestrator. Every runtime smoke except the `plugin` scenario, the Playwright startup test and the installer harnesses run in the disabled mode; their main logs show `PLUGIN_SETUP_MODE` with `mode: 'disabled'`.

PR-5's card texts are checked by `tests/unit/plugin-setup-text.test.ts` with a hand-written text for every state and reason. The card itself is checked in the running application by the [plugin smoke](#the-plugin-smoke-scenario), in the test-root mode against its own fake root, and in the disabled mode by the scaffold smoke. The repository has no component-rendering unit tests, so no separate renderer unit test was added.

PR-6's diagnosis is checked by `tests/unit/connection-diagnosis.test.ts` against a hand-written precedence table, where pair rows show that each code beats the next. `tests/unit/diagnostic-bundle.test.ts` checks the format, the log row reduction, the redaction of injected paths and user and computer names, and the 2 MiB bound. `tests/unit/diagnostic-bundle-writer.test.ts` writes on real temporary folders: a cancel writes nothing, a failure and an exit remove the partial file, and a data-folder target is refused, also through a junction. `tests/unit/journal-export-writer.test.ts` is unchanged and still passes after the helper extraction. `main-boundaries.test.ts` checks the channel's trust, zero arguments, the dialog's owner and default name, the exit and one saved bundle, and `preload-recovery.test.ts` checks that no argument is forwarded. The scaffold smoke checks the diagnosis line and the plugin smoke the export.
