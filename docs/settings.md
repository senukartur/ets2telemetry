# Persistent settings and unit profiles (ET-011b)

ET-011b stores the user's settings in a small JSON file and uses them to choose the display units of each game. The only setting in this version is the unit profile per game. The decisions behind it are C10–C12 in [concept.md](../concept.md#et-011-authorization--october-15-2026); numeric conversion follows ET-010 decision N2 (telemetry-core is the single numeric source).

## Location

The file is `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json`. Main resolves `%LOCALAPPDATA%` at runtime through `dataPaths(LOCALAPPDATA).settings` (`apps/desktop/src/paths.ts`), separately from the application binaries and from `telemetry.sqlite`, so an application update does not replace it. When `LOCALAPPDATA` is missing or not an absolute path, there is no settings location: defaults apply and nothing can be saved (`unavailable`). Preserving the file across a real installed update and an optional uninstall removal belong to ET-018.

## Format v1

```json
{
  "format": "ets2telemetry.settings",
  "version": 1,
  "units": {
    "ets2": "metric",
    "ats": "us-customary"
  }
}
```

The application writes exactly this shape: UTF-8 without a byte order mark, two-space indentation and a trailing newline. When reading it:

- a leading UTF-8 byte order mark is accepted and unknown keys are ignored;
- a file larger than 64 KiB, bytes that are not UTF-8, anything other than a JSON object, a missing or different `format` marker, or a `version` that is not an integer makes the file **invalid**;
- a missing `version` or a version below 1 is **unsupported-older**. Migrations to v1 are a chain of pure steps in `apps/desktop/src/settings-schema.ts`; the chain is empty because no older format was released, so such a file uses defaults;
- a version above 1 is **newer-version**: written by a later application version;
- in a v1 file, each `units.ets2` and `units.ats` value must be exactly `metric` or `us-customary`. An invalid or missing value falls back to its default on its own (**loaded-with-fallbacks**); the other values still apply.

## Unit profiles

| Profile | Speed | Fuel |
| --- | --- | --- |
| `metric` | km/h | L |
| `us-customary` | mph | US gal |

Defaults follow ET-000: ETS2 `metric` and ATS `us-customary`. Without a selected game (or with a fixture that names no game), the metric profile applies. The profile ids are telemetry-core's `DisplayProfileId`, and `apps/desktop/src/unit-profiles.ts` asserts at compile time that the contract type `UnitProfile` in `packages/contracts/src/app-state.ts` is the same set. That module only maps settings to a profile and builds the overlay and dashboard strings; every conversion constant, conversion and rounding rule comes from `packages/telemetry-core` (`units.ts`, `display-profile.ts`, `format.ts`). Canonical telemetry stays in m/s and liters. With the default profiles the overlay text is unchanged from earlier versions, and so is the dashboard's for ETS2 and without a game. The ATS dashboard, which earlier always showed km/h and liters, now follows the ATS US customary default (mph and US gallons), like the overlay. Money is never converted (ET-010 N9). The dashboard's **Live telemetry** card (ET-010b) uses the same per-game profile for every row with a unit.

## Load states

Loading happens once at startup, in parallel with the service start, within 1000 ms. The first dashboard and overlay windows open only after it settled. Loading never creates, changes or removes a file or directory.

| State | Meaning | Units in use | Can save |
| --- | --- | --- | --- |
| `defaults` | No settings file (or no settings directory) | Defaults | Yes; the first save creates the file |
| `loaded` | A valid v1 file | From the file | Yes |
| `loaded-with-fallbacks` | A v1 file with some invalid fields | Valid fields from the file, defaults for the others | Yes; the save rewrites the whole file |
| `invalid-file` | Not a usable settings file | Defaults | Yes; the first save quarantines the file |
| `unsupported-older` | An older format without a migration path | Defaults | Yes; the first save quarantines the file |
| `newer-version` | Written by a newer version | Defaults | No (`SETTINGS_READ_ONLY`); the file is never modified |
| `unreadable` | The file or directory is a symbolic link or junction, not a plain file or directory, could not be read, or loading exceeded 1000 ms | Defaults | No (`SETTINGS_WRITE_FAILED`) |
| `unavailable` | No valid settings location | Defaults | No (`SETTINGS_WRITE_FAILED`) |

The settings directory and file are inspected with `lstat`, which does not follow links: a symbolic link or junction is refused and never read or written through.

## Saving

A change is saved in this order; the new units apply in memory only after the final rename succeeded:

1. Create the settings directory if needed and check again that it is a plain directory.
2. Remove stale temporary files of the store's own pattern `settings.json.<pid>.<uuid>.tmp`, left by an interrupted earlier save. No other file is touched.
3. If the file loaded as `invalid-file` or `unsupported-older`, rename it unchanged to `settings.rejected-<UTC yyyymmddThhmmssZ>.json` (with `-2`, `-3`, … when that name exists) and keep only the newest three such files. This happens once, on the first save.
4. Write the new content to a new temporary file (exclusive create), flush it to disk (`FileHandle.sync()`) and close it.
5. Rename the temporary file over `settings.json`. Antivirus scanners and indexers can briefly hold new files open on Windows, so `EPERM`, `EACCES` and `EBUSY` are retried up to five times after 20, 40, 60, 80 and 100 ms (300 ms in total).

If any step fails, the temporary file is removed, the previous file and the units in use stay as they were, the request is rejected and the settings view's `saveError` becomes `SETTINGS_WRITE_FAILED` (`SETTINGS_READ_ONLY` for a newer-version file) until the next successful save clears it. Settings errors never change the service's health or its last problem. A failure after the quarantine rename leaves no `settings.json`, which the next start reads as defaults. Node.js cannot flush a directory entry on Windows, so the rename itself is not separately flushed.

Saves are serialized. At most four may be outstanding, including the one in progress; a fifth request is refused at once without changing the settings view. Once loading has finished, a read-only state (`newer-version`, `unreadable`, `unavailable`) refuses a save at once instead of queuing it; when the 1000 ms load budget expires while a read still hangs, later saves and the exit's wait no longer depend on that read. An explicit exit waits for an in-flight save for at most 1000 ms (`EXIT_IDLE_BUDGET_MS`, see [the application lifecycle](app-lifecycle.md#explicit-exit)); new saves are refused once the exit has started. A save cut short by the exit leaves at most a temporary file, which the next save removes.

## Dashboard and overlay

The dashboard's **Display units** card has one shadcn radio group per game (`metric`, `US customary`) and a line that explains the load state. A choice shows as selected only after main saved it; while a save runs the groups are disabled. A refused save shows the view's `saveError` text in the card (`The unit change could not be saved; the previous units stay in use.` or the read-only explanation); a request that failed before reaching the store shows `The unit change was not saved; the previous units stay in use.` The groups are disabled when the settings cannot be saved. The dashboard's speed and fuel rows use the profile of the displayed game (`displayProfile` in `unit-profiles.ts`), with each game's default before the first settings push.

The preload bridge appends one method, `setUnitProfile(game, profile)`. The preload accepts only `ets2`/`ats` and `metric`/`us-customary` and forwards exactly those two values over `settings:set-unit-profile`. Main checks the sender and its main frame, validates both values and the argument count again, and resolves with the new settings view only after the save. It then pushes `AppState` (whose `settings` holds the units, the load state, whether saving is possible and the last save error) to a subscribed dashboard, and republishes the overlay projection from main's stored freshness output in the new units. The republication accepts no observation and renews neither the SDK nor the window freshness deadline, so a reading that was about to expire still expires on time and the overlay placement is unchanged. Neither the renderer nor the overlay receives a path, file content or error text.

## Diagnostics

Startup logs `SETTINGS_LOADED` (`state` `defaults` or `loaded`) or `SETTINGS_FALLBACK` (any other state, with `fields` for fallbacks or a fixed `reason` such as `reparse-point` or `load-budget`). Saves log `SETTINGS_QUARANTINED` and `SETTINGS_SAVED` (`game`, `profile`). None of these names match the smoke failure pattern `FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE`. A refused newer-version save logs `SETTINGS_SAVE_REFUSED`; a failed save logs `SETTINGS_WRITE_FAILED` with the failing `step` and the error `code`. Facts carry fixed codes only, never paths or file content.

## Tests

- `tests/unit/settings-schema.test.ts`: every load classification, the 64 KiB boundary, the byte order mark, the empty migration chain and the exact serialized bytes.
- `tests/unit/settings-store.test.ts` (real temporary directories; failures injected by wrapping the real file operations): no write on startup, exact bytes, `sync` before the rename, EPERM/EACCES/EBUSY retry, a persistent EPERM that keeps the previous file and removes the temporary file, failures at write, sync and rename that leave the old file valid, byte-identical quarantine on the first save only, keeping the newest three quarantined files, newer-version untouched and read-only, a junction directory and a symbolic-link file refused, only matching temporary files removed, serialized saves, the four-request bound and the idle hook, the unavailable location and the 1000 ms load budget, a prompt refusal with no idle work after the budget expired over a read that never settles, and `saveError` set by a failed save and cleared by the next one.
- `tests/unit/unit-profiles.test.ts`, `overlay.test.ts`, `speed-display.test.ts`: profile mapping, both profiles in the overlay and dashboard, and the dashboard's profile choice with the ATS US customary default; the existing overlay and dashboard cases are unchanged, and the one that calls `dashboardSpeed` without a profile is titled for its implicit metric default. A source check keeps conversion constants and `toFixed` out of the desktop display modules.
- `tests/unit/main-boundaries.test.ts`: trusted sender and frame only, invalid values rejected, the change applied only after the save, the overlay republished without renewed authority, refused saves reported in the settings view while a service problem stays the last problem, the exit waiting for an in-flight save within 1000 ms, and the first windows opening only after the load settled. `preload-recovery.test.ts` covers the bridge validation.
- The development and packaged `lifecycle` runtime smokes seed an invalid file and check quarantine, exact content, mph and US gallons, and the restart; see [CI](ci.md#et-011b-settings-in-the-lifecycle-smoke).

Evidence and pending manual checks are in [ET-011 validation](validation/et-011.md#et-011b-persistent-settings-and-unit-profiles).
