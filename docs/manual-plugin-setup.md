# Manual prototype plugin setup

This is a developer procedure for the future real-game gate, not an ET-017 installer/wizard or a compatibility claim. ET-003 supplies the real SDK adapter as `ets2telemetry-plugin.dll`. Never install a test DLL or native console fixture. Historical ET-001 scaffold instructions refer to a placeholder DLL that is no longer built (ET-019t, October 17, 2026); the commands below identify the maintained SDK artifact. SDK 1.15 is the archive version, not a game or telemetry API version; the pinned headers/license are under `native/telemetry-plugin/vendor/scs-sdk-1.15`.

## Build and check

Use the pinned Node 24.19.0/npm 11.17.0 and Visual Studio/CMake toolchain from [setup](setup.md). Run from the repository root in Developer PowerShell, with Node/npm/CMake on PATH:

```powershell
npm ci
npm run lint:install
npm run typecheck
npm run lint
npm run lint:ps
npm test
npm run native:configure
npm run native:build
npm run build
npm run make
npm run inspect:package
```

`native:build` produces `native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll`. `build` separately compiles the fixed x64 pipe-client broker and desktop/renderer; since ET-017 PR-1 it also builds the plugin DLL and stages it for packaging as `resources/telemetry-plugin` ([game plugin setup](plugin-setup.md#bundle-format)), but nothing installs that copy yet. The source-bound broker receipt must match the desktop receipt; rebuild after source changes. Forge produces `out/ETS2Telemetry Desktop-win32-x64` and the Squirrel maker files; creating them does not install the app. If the environment requires its installed system CA, use `NODE_OPTIONS=--use-system-ca` as explained in setup, without disabling TLS verification.

## Install only the project DLL, with game/client closed

Exit ETS2, ATS and TruckersMP completely before copying, replacing or removing the DLL. Do not terminate another user's process or touch another plugin. Choose the actual Steam library/game root; this example is ETS2 (use `American Truck Simulator` for ATS):

```powershell
if (Get-Process -Name eurotrucks2,amtrucks,TruckersMP,TruckersMP-Launcher -ErrorAction SilentlyContinue) {
  throw 'Close the games and TruckersMP client before managing the project DLL.'
}
$gameRoot = (Resolve-Path -LiteralPath 'C:\Program Files (x86)\Steam\steamapps\common\Euro Truck Simulator 2').Path
$pluginSource = (Resolve-Path -LiteralPath 'native/telemetry-plugin/build/Release/ets2telemetry-plugin.dll').Path
$pluginsDirectory = Join-Path $gameRoot 'bin\win_x64\plugins'
$pluginTarget = Join-Path $pluginsDirectory 'ets2telemetry-plugin.dll'
if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'bin\win_x64') -PathType Container)) {throw 'Wrong game root.'}
if (Test-Path -LiteralPath $pluginTarget) {throw 'Existing file: verify the retained project-owned hash before replacing it.'}
New-Item -ItemType Directory -Path $pluginsDirectory -Force | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget
if ((Get-FileHash -LiteralPath $pluginTarget -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $pluginSource -Algorithm SHA256).Hash) {throw 'DLL copy hash mismatch.'}
Get-FileHash -LiteralPath $pluginSource -Algorithm SHA256
```

Retain the printed candidate DLL SHA256 with the source commit and chosen path. A replacement requires verifying that the existing destination matches a previously retained owned candidate hash, then copying only this exact filename with the games/client closed. If ownership cannot be established, stop and inspect the existing file. Do not rename/delete unrelated DLLs or copy the full build directory into the game.

## Launch and select

Use normal window startup for the interactive desktop application. Hiding its first GUI window makes the close control inaccessible. A background launcher console may remain hidden independently. The G01 comparison in [session evidence](validation/et-008-g01.md) records the distinction.

For development, `npm run dev` rebuilds and starts Forge's desktop app. For the packaged prototype, launch the complete inspected directory, without moving its executable away from `resources`:

```powershell
npm run dev
# Or, after closing the development instance:
Start-Process -FilePath (Resolve-Path -LiteralPath 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe').Path -WindowStyle Normal
```

These are manual launch instructions, not bounded acceptance harness commands. Use the repository's owned Windows Job wrappers for automated runtime evidence. Select **Euro Truck Simulator 2** or **American Truck Simulator** in the dashboard before the corresponding game launch. Selection resolves the fixed development/packaged broker; the broker provisions its exact-image policy in `%LOCALAPPDATA%\ETS2Telemetry\transport\v0\service-policy.json` with current-user ownership and bounded atomic updates. Do not hand-edit ACLs/policy, approve an arbitrary executable, or grant a general Electron path. Missing/invalid policy or source authority fails closed. If more than one matching live game source exists, close the extra instance; the app does not choose implicitly. Avoid mixed privilege levels; actual elevated-game behavior still requires testing.

Launch the selected game/client normally, choose windowed or borderless mode and enter active simulation. The overlay appears only with accepted game-origin window metadata while that game is foreground. It hides on minimize/foreground loss/expired metadata. Synthetic/replay choices are controlled fixtures and never make the native overlay visible. Do not infer success from a dashboard status alone: record actual source/game/client versions, mode, artifact hashes, input/focus/DPI behavior and performance using [TESTING.md](../TESTING.md).

To remove this candidate, close both games/client and the app, confirm the exact destination SHA256 still equals the retained installed candidate, and remove only `$pluginTarget` with `Remove-Item -LiteralPath $pluginTarget`. Preserve other plugins, game files, exports and user data. Do not delete the whole `plugins` or transport-policy directory. Managed installation belongs to ET-017 (below); uninstall cleanup belongs to ET-018.

## Hand over to the managed install (ET-017)

Since ET-017, the packaged application installs, updates and removes its own plugin silently in each discovered game folder ([game plugin setup](plugin-setup.md)). It replaces or removes only a file whose SHA-256 it recognizes: the bundled plugin, a released one in `native/telemetry-plugin/released-plugins.json`, or the one recorded for that folder in `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json`. A DLL copied by hand from a development build has none of these hashes, so the Game plugin card shows that folder as **Blocked** with "A file with the plugin's name that this application did not install is in the way", and the connection diagnosis says to move it away. The application never overwrites or deletes it ([TD-011](technical-debt.md#td-011-in-app-replacement-of-an-unrecognized-plugin-file)).

To hand a folder over to the managed install:

1. Exit ETS2, ATS, TruckersMP and ETS2Telemetry.
2. Confirm that the file's SHA-256 still equals the candidate hash you retained above, then remove only that file, as described in the previous section.
3. Start the installed (packaged) application normally, without any `ETS2TELEMETRY_*` variable. It installs its bundled plugin and records it; the card shows **Installed**.

A file you copied by hand from the packaged application ("Show plugin file" on the card) has the bundled hash: the application adopts it and records it as `adopted` instead of reporting it. Never run a development build with `ETS2TELEMETRY_PLUGIN_SETUP=real` to do this: it writes into real game folders.

If the card reports a problem, **Export diagnostics…** on the card saves one JSON file with versions, states and recent log codes, without paths or user and computer names ([diagnostic bundle](plugin-setup.md#diagnostic-bundle)). Nothing is uploaded; attach the file to a report yourself.
