# User guide: installing, updating and uninstalling

This guide is for people who run Yukon Union Telemetry on Windows. It covers the installer, the Windows warnings an unsigned alpha build gets, where the application keeps your data, updates, and the two ways to uninstall. The technical background is in [uninstall](uninstall.md), [game plugin setup](plugin-setup.md) and [installer testing](installer-testing.md).

Yukon Union Telemetry is an internal alpha. No release has been published yet; when one is, it will be a pre-release labelled "unsigned internal alpha" on the project's GitHub Releases page, and only the owner publishes one ([releases](release.md)). Nothing in this guide claims that a game, TruckersMP, an antivirus product or Smart App Control was tested with it: those checks are still pending.

## Installing

Run `YukonUnionTelemetry-Setup-<version>.exe`, for example `YukonUnionTelemetry-Setup-0.1.0.exe`. It installs for your Windows user only, without administrator rights, and starts the application when it finishes. It creates a Desktop and a Start menu shortcut named **Yukon Union Telemetry**; the Start menu one is in the **Artur Sianiuk** folder. Windows Settings → Apps → Installed apps lists the program as **Yukon Union Telemetry**.

| What | Where |
| --- | --- |
| The program | `%LOCALAPPDATA%\ETS2TelemetryDesktop` |
| Your data (trip history, settings, logs) | `%LOCALAPPDATA%\ETS2Telemetry` |
| Electron's own browser data | `%APPDATA%\ETS2Telemetry Desktop` |
| The game plugin | `<game folder>\bin\win_x64\plugins\ets2telemetry-plugin.dll` |

When the application starts, it finds Euro Truck Simulator 2 and American Truck Simulator through Steam and copies its game plugin into each game's `plugins` folder while the game is closed. The **Game plugin** panel in **Settings** shows the state of each game, lets you choose a game folder by hand and lets you exclude a game ([game plugin setup](plugin-setup.md)).

### Connecting to a game

Start ETS2 or ATS and open **Live**. **Automatic** is the default source: **Waiting for game** stays visible until a verified game plugin is available. Either launch order works. If both games are available before connection, choose **Euro Truck Simulator 2** or **American Truck Simulator** on Live. Another game appearing during an attached session does not switch away from it. After an automatic session ends, the application waits for the next game again.

An incomplete connection means one telemetry stream is still waiting; the available stream stays attached. A source mismatch or a verification failure stays visible and requires reconnecting or choosing a source again. **Settings → Data** retains explicit ETS2/ATS selection and isolated synthetic/replay fixtures for diagnostics. An explicit game selection waits only for that game; choose **Automatic** to resume automatic selection. Fixture launches never fall back to a real game when a fixture is missing or disconnects.

### Current track

In **Settings → General**, enable **Show Now Playing** (off by default). Choose Automatic or an available Windows media source, Minimal or Full, and background opacity (40–100%, initially 80%). Source selection starts Automatic on each application run; the other choices are saved. Full preserves square, portrait and wide artwork and omits metadata Windows does not supply. Recognized Windows source identities use readable names such as Spotify and Chrome in both the selector and panel. A browser is not renamed after the service playing inside it.

The independent panel appears only inside the active selected game's client area, using a fresh game-window report. It hides before the game starts, during Alt+Tab or game minimization, and when the window report expires. A saved position outside the game's client area is clamped into it for display without changing the preference; a client area too small for the panel hides it. Paused media is labelled and its progress freezes. No session, stopped playback, an unavailable explicit source or a reader error clears and hides it; General shows the reason. Automatic prefers a playing source over a paused Windows-current source. An explicit missing source waits until it returns; choose Automatic to change this policy.

**Edit position** makes the panel draggable while this application has focus, including a placeholder without media. **Done** saves, **Cancel** or Escape restores the saved position, and **Reset** changes the draft to the primary display's right side, approximately three quarters down its available work area. The normal panel passes mouse input through and does not take focus. Its position and visibility are independent of the telemetry overlay; edit one at a time. Disabling stops media observation and keeps your preferences. Closing the dashboard to the tray keeps observation running until explicit Exit.

### Windows SmartScreen

This alpha is not code-signed. When you run `YukonUnionTelemetry-Setup-<version>.exe`, Microsoft Defender SmartScreen may show **Windows protected your PC**. To continue, select **More info**, check that the file is the one you downloaded from the project's GitHub Releases page, then select **Run anyway**. Only do this for a file from that page. A signed build is planned: after the first alpha release the project applies to the SignPath Foundation for free code signing.

### Smart App Control

On Windows 11, Smart App Control may block unsigned programs, and it offers no exception for a single program. If it blocks this alpha, the alpha cannot run on that computer while Smart App Control is on. Turning it off is your decision and affects every program; this project does not ask you to change Windows security settings. How Smart App Control treats this build has not been tested yet.

## Your data

Everything Yukon Union Telemetry records or saves lives in `%LOCALAPPDATA%\ETS2Telemetry`:

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
| `updates` | Only while an in-app update downloads or installs: the downloaded update, removed once it is installed |

Your trip history is stored only on this computer. It is not synchronized anywhere yet: synchronization with a server is a later phase of the project. To keep a copy of a trip, open it on the **Journal** tab and select **Export JSON**; save the file anywhere outside `%LOCALAPPDATA%\ETS2Telemetry`. An export is a copy for your own records. It cannot be imported back into Yukon Union Telemetry.

## Updating

### In the application (ET-055)

An installed Yukon Union Telemetry checks for a newer version of its own release channel by itself: 15 seconds after its background service is first ready (shortly after it starts) and then every 6 hours. It never downloads or installs anything on its own. When a newer version exists, a button appears in the sidebar under the recording indicator ("Update to 0.2.0"), and only your click on it downloads and installs it. The same button shows the download progress, "Installing…" and "Restarting…", "Close the game to update" when a game is running (click it again once the game is closed), "Update failed – Retry" with the reason when you point at it, and "Restart to finish" when the update was installed while a game was running. While there is nothing to install the button is hidden. Under it the sidebar always shows the version of this copy, for example "Version 0.1.1"; a staging test build adds a "Staging" badge, and a development build reads "Development build". Settings → About shows the same version line and **Check for updates**, which checks at once and answers beside the button ("You have the latest version.", "Version 0.2.0 is available…" or why the check failed); in a copy that was not installed it is disabled. Close the games first: while Euro Truck Simulator 2, American Truck Simulator or TruckersMP runs, the update is refused. After the click the application downloads the update, checks that it was signed by the project and that it is exactly the published file, installs it, and restarts through its normal exit, so a recording in progress is written first. If you start a game while it installs, it finishes at the next start. While an update downloads or installs, uninstalling from the application is refused until it has finished, and while an uninstall runs no update starts.

The check asks GitHub, which hosts the releases, for the latest release. Nothing that identifies you or this computer is sent, but GitHub sees your IP address, as for any visit to a web page. A failed check, for example offline, changes nothing and is tried again later. Until the project publishes its first signed update, the application finds no update.

### By hand

To update by hand, close the games, then run the newer version's `YukonUnionTelemetry-Setup-<version>.exe` (versions before the rename are named `ETS2Telemetry-Setup-<version>.exe`). It replaces the program and keeps your data: the trip history, its backups and your settings stay where they are. When a newer version needs a newer history database, it first writes a verified backup of the old one into `backups` ([storage](storage.md)). The application then updates the game plugin in every game folder while the game is closed.

Versions before the rename named the program and its shortcuts **ETS2Telemetry Desktop**. Updating replaces those shortcuts with **Yukon Union Telemetry** ones in the same places, and Installed apps shows the new name; the installation, its data and its settings stay the same. A shortcut of the old name is removed only when it belongs to this installation and the new one exists beside it. Taskbar and Start pins you made keep their old label: unpin them and pin **Yukon Union Telemetry** again.

## Uninstalling

Uninstalling deletes your local data. That is the rule for this application, and it cannot be undone:

- your trip history, which is not synchronized anywhere, is deleted for good, with its backups;
- your settings, logs, captures and synthetic recordings are deleted as well;
- trip exports you saved elsewhere stay where they are;
- the Yukon Union Telemetry game plugin is removed from your game folders while the games are closed. Other plugins and game files are never touched, and a file with the plugin's name that Yukon Union Telemetry did not install is left as it is.

Export any trip you want to keep before you uninstall.

### From the application

On the **Live** tab, the last card is **Uninstall Yukon Union Telemetry**. Select **Uninstall Yukon Union Telemetry…**, read the warning and select **Uninstall** (the default is **Cancel**).

- If a game or TruckersMP is running, or a plugin file cannot be removed, nothing is changed and the card says which game folder and why. Close the game and try again.
- Otherwise Yukon Union Telemetry removes its plugin, closes, deletes its data, shows what it removed and what remains, and then starts the Windows uninstall, which removes the program, the shortcuts and its entry in Windows Settings.
- A portable copy or a development build says that uninstalling is available only in an installed copy. Delete its folder instead.

### From Windows Settings

Open **Settings**, **Apps**, **Installed apps**, select **Yukon Union Telemetry** (**ETS2Telemetry Desktop** in versions before the rename) and **Uninstall** (or use Control Panel). A running Yukon Union Telemetry closes first. Windows shows no window from Yukon Union Telemetry during this uninstall, so the result is written to a small file, `%TEMP%\ETS2Telemetry-uninstall-<date and time>.json`.

If a game or TruckersMP is running at that moment, Windows still removes the program, but the plugin cannot be removed from that game: Yukon Union Telemetry keeps `%LOCALAPPDATA%\ETS2Telemetry\plugins` and `%LOCALAPPDATA%\ETS2Telemetry\uninstall`, with a `README.txt` that lists the game folders and the plugin's checksums. Everything else in the data folder is deleted.

#### The cleanup finishes at your next sign-in

Before it deletes anything, the uninstall copies a small Windows PowerShell script, `Complete-ETS2TelemetryUninstall.ps1`, into `%LOCALAPPDATA%\ETS2Telemetry\uninstall` and asks Windows to run it once at your next sign-in (a `RunOnce` entry named `ETS2TelemetryUninstall` for your user only; no administrator rights). When you sign in again:

- If the games and TruckersMP are closed, the script removes the plugin, but only a file whose checksum is one of Yukon Union Telemetry's, then the `plugins` and `uninstall` folders and the empty data folder. It never removes a plugin file it does not recognize, a read-only file or anything reached through a linked folder; those stay, and so does anything else you put in the data folder.
- If a game or TruckersMP is running again, it changes nothing in that game folder and asks Windows to try again at the following sign-in. After 10 attempts in total it stops trying; `README.txt` then says so and lists the steps to finish by hand.
- It shows one message that says what happened, and it writes a small result file, `%TEMP%\ETS2Telemetry-deferred-cleanup-<date and time>.json`, without any folder names.
- If it finishes, it also removes Electron's own browser data, `%APPDATA%\ETS2Telemetry Desktop`, as the uninstall itself does when it can finish at once.
- If you reinstalled Yukon Union Telemetry in the meantime, the reinstall has already cancelled the cleanup: the plugin stays in use and the script does nothing.
- If an unexpected error stops the script, `README.txt` says whether it tries again at the next sign-in or has stopped.

Some things can keep the script from running at all:

- **Antivirus or endpoint security.** A hidden PowerShell script started at sign-in, which deletes files, is the kind of thing such products may flag or block.
- **A Group Policy execution policy.** On a computer managed by an organization, a policy such as `AllSigned` overrides the script's own setting, and this unsigned script does not run.

In those cases nothing is removed at sign-in, and the cleanup is left to `README.txt`.

You can also finish by hand at any time: follow the README, or reinstall Yukon Union Telemetry, which cancels the pending cleanup, and uninstall it from the application with the games closed. Windows' handling of this sign-in step on a real machine, including how antivirus products and Group Policy treat it, has not been tested yet.

### If something is left behind

- **The result says that an unexpected error stopped the cleanup** (`ENGINE_FAILED`). From the application: nothing more was removed; uninstall again. From Windows Settings: Windows already removed the program, so follow `%LOCALAPPDATA%\ETS2Telemetry\uninstall\README.txt` if it exists, or reinstall Yukon Union Telemetry and uninstall it from the application.
- **The cleanup could not start** (`HOOK_FAILED`, only from Windows Settings). Nothing of your data or plugin was removed. Reinstall Yukon Union Telemetry and uninstall it from the application, or remove the files by hand as described below.
- **A recorded game folder is no longer a plain game folder.** The result names the game. Look in that game's `bin\win_x64\plugins` folder for `ets2telemetry-plugin.dll`.
- **Unknown files in the data folder.** Yukon Union Telemetry deletes only the folders listed under [Your data](#your-data). Anything else you put in `%LOCALAPPDATA%\ETS2Telemetry` is kept, and the folder stays until you delete it.

### Removing everything by hand

Use these steps when the uninstall cannot finish, for example when `%LOCALAPPDATA%` is redirected through a link, which Yukon Union Telemetry refuses to delete from.

1. Close Yukon Union Telemetry (**Exit Yukon Union Telemetry** in the notification area icon's menu), the games and TruckersMP. If a cleanup is still waiting for your next sign-in, it finds nothing left to do once you have finished these steps.
2. In each game folder, open `bin\win_x64\plugins`. Delete `ets2telemetry-plugin.dll` only if it is Yukon Union Telemetry's: in PowerShell, `Get-FileHash -Algorithm SHA256 -LiteralPath '<path to the file>'` must print one of the checksums that `README.txt` lists, or the checksum in `resources\telemetry-plugin\plugin-manifest.json` of the installed program. Leave every other file.
3. Delete `%LOCALAPPDATA%\ETS2Telemetry`. This deletes your trip history for good.
4. If the program is still listed in Windows Settings, uninstall it there. Otherwise delete `%LOCALAPPDATA%\ETS2TelemetryDesktop`, `%APPDATA%\ETS2Telemetry Desktop` and any remaining **Yukon Union Telemetry** or **ETS2Telemetry Desktop** shortcuts.


## Yukon Union desktop navigation (ET-028)

The main window is branded **Yukon Union Telemetry**, and since ET-045h so are the tray, the dialogs, the Windows shortcuts, the Installed apps entry and the installer. Technical names keep "ETS2Telemetry": the folders `%LOCALAPPDATA%\ETS2Telemetry`, `%LOCALAPPDATA%\ETS2TelemetryDesktop` and `%APPDATA%\ETS2Telemetry Desktop`, the executable `ETS2TelemetryDesktop.exe`, the game plugin `ets2telemetry-plugin.dll` and the names of result and export files. The sidebar opens Live, Hard Mode, Journal and Settings. Its recording words and indicator, and the top bar's connection/plugin/Hard Mode states, stay visible on every screen. Closing the native window still hides to the tray; **Exit** explicitly stops the app, and its tooltip says so. Explanations of a setting or value sit behind a small ⓘ icon next to it: hover over it or move the keyboard focus to it to read them.

Change English/Russian in Settings → General. Game-provided cargo, city, company, truck and trailer names are never translated. General holds the interface language, Start with Windows, the units of each game and **Gear display**, all as keyboard-operable choices. **Gear display** for each game (ET-050): *Automatic (1, 2, 3)* or *Manual range-splitter (1L, 1H, 2L…)*. In manual mode the labels follow your truck's gearbox layout when the game reports it: on an ATS 18-speed, for example, LL and LH for the crawler gears and 1L…8H after them, and on an ETS2 12+2, C1 and C2 for the crawler gears and 1L…6H after them. When the game has not reported the layout, or reports one this application does not recognize, each forward gear pair is shown as a low (L) and high (H) range: 1L, 1H, 2L… Reverse stays R1, R2 and neutral N. It changes only what the Live screen and the overlay show; your recorded history keeps the game's gear numbers. The labels are derived from the game's shifter layout, not read from the game's own gear names, so a modded or unusual gearbox may differ from the in-game dashboard. If your gearbox has one crawler gear and the dashboard numbers the rest without L and H (for example an ETS2 Scania 13+1: C, 1, 2, 3…), choose *Crawler first (C, 1, 2, 3…)*; in ATS the option reads *Crawler first (L, 1, 2, 3…)*. The application cannot tell such a gearbox apart from a range-splitter one with the same shifter layout, so the choice is yours and applies to every truck of that game. Settings also has one Overlay page (Show overlay, four layout previews, opacity, position/scale editing, all section switches and presets), Game plugin, About and, last, Diagnostics. Diagnostics holds the source selector, the raw connection and service status and the recording health; a driver does not need it. Start with Windows is available in an installed copy. The application version is in the sidebar and in About.

Live shows the instruments, the current job, the truck and the game time with the next mandatory break. **All telemetry fields**, at the bottom, opens the full list with every field's provenance, notes and reasons. Gauge geometry uses current normalized numbers; an oversized reading is clamped only for the drawing, while its exact formatted value remains visible. A stale reading becomes unavailable. The Live instrument fills the available content width. Hard Mode has its own page between Live and Journal: the headline with the profile source and Check again on one row, a full-width progress bar and a grid of the twelve rules with their state. A failing rule also shows its current and required value on one line, and the line above the grid names the settings to change in the game. Every rule's tooltip gives its detected and required value and the reason; the qualification caveats are behind the ⓘ icon next to the headline. Current settings do not by themselves qualify a trip.

Journal reads one cursor page at a time and updates only on Refresh. Its wide table scrolls horizontally; the list shows expected income, and the actual payment or penalty is in the trip. Opening a trip shows its cargo/route, outcome and recording completeness, three metric tiles, retained Hard Mode evidence, exact money categories and raw detail sections. Back returns to the same list page. The chart covers **only the current sample page**, up to 300 samples; source-monotonic segments break at missing readings/seconds and clock discontinuities. It does not claim whole-trip duration or that a gap was a pause. The current page's sample table is in a collapsed section under the chart, and **Recorded data** at the bottom opens the completeness intervals and the event timeline. JSON export keeps its uninstall warning next to its button.

A job created in a save (for example by CargoMan) can have a complete recording when the delivered distance and game duration corroborate that its execution was observed from the beginning. Matching cargo and route names alone is insufficient. An unchanged, verified pause across a reconnection adds an informational annotation without making the recording partial. Missing evidence or actual losses still make it partial; existing journal entries are not recalculated.

## Showing or hiding the overlay

Overlay measurements use whole numbers rounded to the nearest unit (`200.2 km` → `200 km`, `200.5 km` → `201 km`). Route endpoints show only cities, and the delivery countdown omits "in" (Russian "через"); an overdue delivery still shows a warning. The game clock shows only `HH:MM`, without the day number.

Open **Settings → Overlay** and change **Show overlay** (Russian: **Показывать оверлей**). The switch changes after saving succeeds and stays saved after restarting. Hiding the overlay keeps telemetry updating. It does not change whether recording is available. Turning it off during position editing discards unsaved position and size changes; editing is unavailable while it is off. Turning it on shows it when a supported game is in front and current telemetry/window information is available. If saving fails, the previous setting and edit draft stay in effect.

## Next mandatory break on the overlay (ET-052)

The overlay has an extra section, **Next mandatory break** (Russian: **До обязательного перерыва**), shown with a coffee-cup icon and, in the strip, cluster panel and HUD, the short name **Break** (**Перерыв**). It shows the in-game time left until the game requires a break, for example `1 h 35 min`. It appears when the game's plugin provides the value: with an older plugin still loaded in a running game, or when the game reports no value, it shows a dash (`—`) instead of a zero.

- **Colours and words.** From 1 to 119 minutes the value is orange and the item is announced as "soon"; at zero or less it reads `0 min`, is red and underlined and is announced as "due now". From two hours it has the normal colour. Only the "due" state has a second visible cue (the underline, besides its `0 min` text); "soon" is shown by the orange colour alone, and the item's accessible name includes the state word (not yet checked with a screen reader). Whether the orange alone is readable above a real game is still to be checked by the owner.
- **Settings.** It is on by default, also after an update from an earlier version, and you can switch it off in **Settings → Overlay → Sections**. The **Everything** preset includes it; **Job focus** and **Driving only** do not. If you had applied one of those two presets before updating, the update switches the break on, so your sections then match neither preset and no preset button shows as pressed until you choose one again.
- **Bigger windows.** One more section makes the Card, the Cluster panel and the Minimal HUD one row taller, and the strip can take a third row. The extra space is transparent.
- **Older versions.** After this version has saved your settings, an earlier version of the application treats the settings file as written by a newer version: it uses defaults and does not save until you run this version again.
- **Not recorded.** The value is only shown live; it is not saved in the journal or the export.

## Overlay size (ET-045e)

In **Settings → Overlay**, **Edit position** shows **Smaller** and **Larger** (Russian: **Меньше** and **Больше**), which change the overlay's size in 10% steps from 50% to 300%. Since this version 100% is the size that earlier versions showed at 70%, so a size you saved before now looks about 30% smaller; choose a larger percentage (for example 70% instead of 50%) to keep the earlier look. The strip keeps its full width inside the game window at 100% and below and only its text gets smaller. Once this version saves a setting, earlier versions show default settings and cannot save until this version runs again; keep a separate Windows user profile for older test builds.
