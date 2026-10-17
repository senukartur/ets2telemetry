# Plugin setup

ET-017 installs, updates and removes only this project's plugin, `ets2telemetry-plugin.dll`, in the `bin\win_x64\plugins` folder of each discovered or chosen ETS2 and ATS installation. The decisions are P1–P20 of the ET-017 plan, adopted by the coordinator under the owner's delegation of October 15, 2026; silent installation is the owner's decision of October 12, 2026 ([concept.md](../concept.md)).

This section describes PR-2: how the application finds the games and validates a folder the user chose. The modules live in `apps/desktop/src/plugin-setup/`. They only read, every file and process access goes through an injected port, and nothing calls them from main yet; ET-017 PR-4 wires them. No result here establishes that a real Steam installation, game or TruckersMP client behaves as described; see [pending checks](#pending-checks).

## Steam root

`steam-registry.ts` reads where Steam is installed (P1):

- One fixed Windows PowerShell 5.1 call: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -Command <fixed script>`, with a hidden window, no shell, a 5 s deadline and at most 16 KiB of output. `%SystemRoot%` is used only when it is a plain absolute drive folder; otherwise `C:\Windows`.
- The script uses only .NET calls and string concatenation, no cmdlet, so it never autoloads a module. The child gets the parent's environment with `PSModulePath` (in any letter case) replaced by `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`: a pwsh 7 parent, such as the CI tests job, exports module folders whose modules Windows PowerShell 5.1 cannot load (the same problem as in [ET-001 validation](validation/et-001.md)).
- The script reads exactly two values through `[Microsoft.Win32.Registry]::GetValue`: `HKCU\Software\Valve\Steam\SteamPath`, then, as the fallback, `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`. It prints `{"steamPath": <base64>|null, "installPath": <base64>|null}`, where each value is the base64 of its UTF-8 bytes, so the console code page cannot change a non-ASCII path. Output that is not exactly this shape, uses non-canonical base64, is not UTF-8 or exceeds 4096 bytes per value is refused.
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

## Pending checks

- Real Steam installations: default and custom SteamPath, including non-ASCII paths, InstallPath fallback, libraries on other drives, junction-moved libraries.
- Real ETS2 and ATS folders and the real folder dialog.
- Real TruckersMP process names and their blocking behaviour.

## Tests

See [TESTING.md](../TESTING.md#et-017-plugin-setup--october-17-2026) and [ET-017 validation](validation/et-017.md). Tests build fake Steam roots with `tests/shared/fake-steam.ts` inside `os.tmpdir()` and read them through `tests/shared/guarded-fs.ts`, which refuses and records any path outside its temporary root, also one whose real location lies outside it through a junction. No test reads Valve's registry keys or touches a real Steam or game folder.
