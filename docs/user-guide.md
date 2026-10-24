# User guide: installing, updating and uninstalling

This guide is for people who run ETS2Telemetry on Windows. It covers the installer, the Windows warnings an unsigned alpha build gets, where the application keeps your data, updates, and the two ways to uninstall. The technical background is in [uninstall](uninstall.md), [game plugin setup](plugin-setup.md) and [installer testing](installer-testing.md).

ETS2Telemetry is an internal alpha. No release has been published yet; when one is, it will be a pre-release labelled "unsigned internal alpha" on the project's GitHub Releases page, and only the owner publishes one ([releases](release.md)). Nothing in this guide claims that a game, TruckersMP, an antivirus product or Smart App Control was tested with it: those checks are still pending.

## Installing

Run `ETS2Telemetry-Setup-<version>.exe`, for example `ETS2Telemetry-Setup-0.1.0.exe`. It installs for your Windows user only, without administrator rights, and starts the application when it finishes. It creates a Desktop and a Start menu shortcut named **ETS2Telemetry Desktop**.

| What | Where |
| --- | --- |
| The program | `%LOCALAPPDATA%\ETS2TelemetryDesktop` |
| Your data (trip history, settings, logs) | `%LOCALAPPDATA%\ETS2Telemetry` |
| Electron's own browser data | `%APPDATA%\ETS2Telemetry Desktop` |
| The game plugin | `<game folder>\bin\win_x64\plugins\ets2telemetry-plugin.dll` |

When the application starts, it finds Euro Truck Simulator 2 and American Truck Simulator through Steam and copies its game plugin into each game's `plugins` folder while the game is closed. The **Game plugin** panel in **Settings** shows the state of each game, lets you choose a game folder by hand and lets you exclude a game ([game plugin setup](plugin-setup.md)).

### Windows SmartScreen

This alpha is not code-signed. When you run `ETS2Telemetry-Setup-<version>.exe`, Microsoft Defender SmartScreen may show **Windows protected your PC**. To continue, select **More info**, check that the file is the one you downloaded from the project's GitHub Releases page, then select **Run anyway**. Only do this for a file from that page. A signed build is planned: after the first alpha release the project applies to the SignPath Foundation for free code signing.

### Smart App Control

On Windows 11, Smart App Control may block unsigned programs, and it offers no exception for a single program. If it blocks this alpha, the alpha cannot run on that computer while Smart App Control is on. Turning it off is your decision and affects every program; this project does not ask you to change Windows security settings. How Smart App Control treats this build has not been tested yet.

## Your data

Everything ETS2Telemetry records or saves lives in `%LOCALAPPDATA%\ETS2Telemetry`:

| Folder | Content |
| --- | --- |
| `data` | The trip history database, `telemetry.sqlite` |
| `backups` | Backups made before a history database upgrade |
| `settings` | Your settings, `settings.json` |
| `logs` | Diagnostic logs |
| `synthetic` | Synthetic or replay recordings, never your game history |
| `captures` | Evidence captures, only if you turned capturing on |
| `plugins` | The record of where the game plugin was installed |
| `transport` | Connection settings shared with the game plugin |
| `uninstall` | Only during an unfinished uninstall: its record, `README.txt` and the cleanup script that runs at your next sign-in |

Your trip history is stored only on this computer. It is not synchronized anywhere yet: synchronization with a server is a later phase of the project. To keep a copy of a trip, open it on the **Journal** tab and select **Export JSON**; save the file anywhere outside `%LOCALAPPDATA%\ETS2Telemetry`. An export is a copy for your own records. It cannot be imported back into ETS2Telemetry.

## Updating

There is no automatic update. To update, close the games, then run the newer version's `ETS2Telemetry-Setup-<version>.exe`. It replaces the program and keeps your data: the trip history, its backups and your settings stay where they are. When a newer version needs a newer history database, it first writes a verified backup of the old one into `backups` ([storage](storage.md)). The application then updates the game plugin in every game folder while the game is closed.

## Uninstalling

Uninstalling deletes your local data. That is the rule for this application, and it cannot be undone:

- your trip history, which is not synchronized anywhere, is deleted for good, with its backups;
- your settings, logs, captures and synthetic recordings are deleted as well;
- trip exports you saved elsewhere stay where they are;
- the ETS2Telemetry game plugin is removed from your game folders while the games are closed. Other plugins and game files are never touched, and a file with the plugin's name that ETS2Telemetry did not install is left as it is.

Export any trip you want to keep before you uninstall.

### From the application

On the **Live** tab, the last card is **Uninstall ETS2Telemetry**. Select **Uninstall ETS2Telemetry…**, read the warning and select **Uninstall** (the default is **Cancel**).

- If a game or TruckersMP is running, or a plugin file cannot be removed, nothing is changed and the card says which game folder and why. Close the game and try again.
- Otherwise ETS2Telemetry removes its plugin, closes, deletes its data, shows what it removed and what remains, and then starts the Windows uninstall, which removes the program, the shortcuts and its entry in Windows Settings.
- A portable copy or a development build says that uninstalling is available only in an installed copy. Delete its folder instead.

### From Windows Settings

Open **Settings**, **Apps**, **Installed apps**, select **ETS2Telemetry Desktop** and **Uninstall** (or use Control Panel). A running ETS2Telemetry closes first. Windows shows no window from ETS2Telemetry during this uninstall, so the result is written to a small file, `%TEMP%\ETS2Telemetry-uninstall-<date and time>.json`.

If a game or TruckersMP is running at that moment, Windows still removes the program, but the plugin cannot be removed from that game: ETS2Telemetry keeps `%LOCALAPPDATA%\ETS2Telemetry\plugins` and `%LOCALAPPDATA%\ETS2Telemetry\uninstall`, with a `README.txt` that lists the game folders and the plugin's checksums. Everything else in the data folder is deleted.

#### The cleanup finishes at your next sign-in

Before it deletes anything, the uninstall copies a small Windows PowerShell script, `Complete-ETS2TelemetryUninstall.ps1`, into `%LOCALAPPDATA%\ETS2Telemetry\uninstall` and asks Windows to run it once at your next sign-in (a `RunOnce` entry named `ETS2TelemetryUninstall` for your user only; no administrator rights). When you sign in again:

- If the games and TruckersMP are closed, the script removes the plugin, but only a file whose checksum is one of ETS2Telemetry's, then the `plugins` and `uninstall` folders and the empty data folder. It never removes a plugin file it does not recognize, a read-only file or anything reached through a linked folder; those stay, and so does anything else you put in the data folder.
- If a game or TruckersMP is running again, it changes nothing in that game folder and asks Windows to try again at the following sign-in. After 10 attempts in total it stops trying; `README.txt` then says so and lists the steps to finish by hand.
- It shows one message that says what happened, and it writes a small result file, `%TEMP%\ETS2Telemetry-deferred-cleanup-<date and time>.json`, without any folder names.
- If it finishes, it also removes Electron's own browser data, `%APPDATA%\ETS2Telemetry Desktop`, as the uninstall itself does when it can finish at once.
- If you reinstalled ETS2Telemetry in the meantime, the reinstall has already cancelled the cleanup: the plugin stays in use and the script does nothing.
- If an unexpected error stops the script, `README.txt` says whether it tries again at the next sign-in or has stopped.

Some things can keep the script from running at all:

- **Antivirus or endpoint security.** A hidden PowerShell script started at sign-in, which deletes files, is the kind of thing such products may flag or block.
- **A Group Policy execution policy.** On a computer managed by an organization, a policy such as `AllSigned` overrides the script's own setting, and this unsigned script does not run.

In those cases nothing is removed at sign-in, and the cleanup is left to `README.txt`.

You can also finish by hand at any time: follow the README, or reinstall ETS2Telemetry, which cancels the pending cleanup, and uninstall it from the application with the games closed. Windows' handling of this sign-in step on a real machine, including how antivirus products and Group Policy treat it, has not been tested yet.

### If something is left behind

- **The result says that an unexpected error stopped the cleanup** (`ENGINE_FAILED`). From the application: nothing more was removed; uninstall again. From Windows Settings: Windows already removed the program, so follow `%LOCALAPPDATA%\ETS2Telemetry\uninstall\README.txt` if it exists, or reinstall ETS2Telemetry and uninstall it from the application.
- **The cleanup could not start** (`HOOK_FAILED`, only from Windows Settings). Nothing of your data or plugin was removed. Reinstall ETS2Telemetry and uninstall it from the application, or remove the files by hand as described below.
- **A recorded game folder is no longer a plain game folder.** The result names the game. Look in that game's `bin\win_x64\plugins` folder for `ets2telemetry-plugin.dll`.
- **Unknown files in the data folder.** ETS2Telemetry deletes only the folders listed under [Your data](#your-data). Anything else you put in `%LOCALAPPDATA%\ETS2Telemetry` is kept, and the folder stays until you delete it.

### Removing everything by hand

Use these steps when the uninstall cannot finish, for example when `%LOCALAPPDATA%` is redirected through a link, which ETS2Telemetry refuses to delete from.

1. Close ETS2Telemetry (**Exit ETS2Telemetry** in the notification area icon's menu), the games and TruckersMP. If a cleanup is still waiting for your next sign-in, it finds nothing left to do once you have finished these steps.
2. In each game folder, open `bin\win_x64\plugins`. Delete `ets2telemetry-plugin.dll` only if it is ETS2Telemetry's: in PowerShell, `Get-FileHash -Algorithm SHA256 -LiteralPath '<path to the file>'` must print one of the checksums that `README.txt` lists, or the checksum in `resources\telemetry-plugin\plugin-manifest.json` of the installed program. Leave every other file.
3. Delete `%LOCALAPPDATA%\ETS2Telemetry`. This deletes your trip history for good.
4. If the program is still listed in Windows Settings, uninstall it there. Otherwise delete `%LOCALAPPDATA%\ETS2TelemetryDesktop`, `%APPDATA%\ETS2Telemetry Desktop` and any remaining **ETS2Telemetry Desktop** shortcuts.


## Yukon Union desktop navigation (ET-028)

The main window is branded **Yukon Union Telemetry**. Package names, Windows shortcuts and data folders retain their ETS2Telemetry identities. The sidebar opens Live, Hard Mode, Journal, Settings and an informational Account and sync placeholder. Its recording words and indicator, and the top bar's connection/plugin/Hard Mode states, stay visible on every screen. Closing the native window still hides to the tray; **Exit** explicitly stops the app.

Change English/Russian from the sidebar language menu or Settings → General. Both use the same saved choice. Game-provided cargo, city, company, truck and trailer names are never translated. General and Units use keyboard-operable segmented choices. Settings includes one Overlay page (Show overlay, four layout previews, position/scale editing, all fourteen section switches and presets), Game plugin, Data and storage, and About. The working source selector and raw connection diagnostics are under Data. Opacity and backup controls are marked Planned; Start with Windows is available in an installed copy. Database statistics and application version are unavailable rather than invented.

Live keeps every telemetry field and its provenance. Gauge geometry uses current normalized numbers; an oversized reading is clamped only for the drawing, while its exact formatted value remains visible. A stale reading becomes unavailable. Live trip duration/fuel and observed route progress are unavailable in this version. The Live instrument fills the available content width. Hard Mode has its own page between Live and Journal: all twelve detected/required/state/reason entries, source/age and qualification caveats are inline, with optional parameter hints and Check again. Scroll the page for further conditions; no checklist drawer is required. Current settings do not by themselves qualify a trip.

Journal reads one cursor page at a time and updates only on Refresh. Its wide table scrolls horizontally; expected income is separate from unavailable actual list revenue. Opening a trip shows its cargo/route, outcome and recording completeness, four metric tiles, retained Hard Mode evidence, exact money categories and raw detail sections. Back returns to the same list page. The chart covers **only the current sample page**, up to 300 samples; source-monotonic segments break at missing readings/seconds and clock discontinuities. It does not claim whole-trip duration or that a gap was a pause. Raw Samples, Timeline and Completeness tabs remain available, as does JSON export with its existing uninstall warning. Game history recording remains disabled.

## Showing or hiding the overlay

Open **Settings → Overlay** and change **Show overlay** (Russian: **Показывать оверлей**). The switch changes after saving succeeds and stays saved after restarting. Hiding the overlay keeps telemetry updating. It does not change whether recording is available. Turning it off during position editing discards unsaved position and size changes; editing is unavailable while it is off. Turning it on shows it when a supported game is in front and current telemetry/window information is available. If saving fails, the previous setting and edit draft stay in effect.

## Overlay size (ET-045e)

In **Settings → Overlay**, **Edit position** shows **Smaller** and **Larger** (Russian: **Меньше** and **Больше**), which change the overlay's size in 10% steps from 50% to 300%. Since this version 100% is the size that earlier versions showed at 70%, so a size you saved before now looks about 30% smaller; choose a larger percentage (for example 70% instead of 50%) to keep the earlier look. The strip keeps its full width inside the game window at 100% and below and only its text gets smaller. Once this version saves a setting, earlier versions show default settings and cannot save until this version runs again; keep a separate Windows user profile for older test builds.
