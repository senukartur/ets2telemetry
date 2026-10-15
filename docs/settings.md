# Persistent settings, unit profiles and overlay settings (ET-011b, ET-012a)

ET-011b stores the user's settings in a small JSON file and uses them to choose the display units of each game. ET-012a adds the overlay layout and the overlay sections in format v2. The decisions behind the file are C10–C12 in [concept.md](../concept.md#et-011-authorization--october-15-2026) and, for the overlay settings, L2, L3 and L13 in [concept.md](../concept.md#et-012a-authorization--october-15-2026); numeric conversion follows ET-010 decision N2 (telemetry-core is the single numeric source).

## Location

The file is `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json`. Main resolves `%LOCALAPPDATA%` at runtime through `dataPaths(LOCALAPPDATA).settings` (`apps/desktop/src/paths.ts`), separately from the application binaries and from `telemetry.sqlite`, so an application update does not replace it. When `LOCALAPPDATA` is missing or not an absolute path, there is no settings location: defaults apply and nothing can be saved (`unavailable`). Preserving the file across a real installed update and an optional uninstall removal belong to ET-018.

## Format v2 (ET-012a)

```json
{
  "format": "ets2telemetry.settings",
  "version": 2,
  "units": {
    "ets2": "metric",
    "ats": "us-customary"
  },
  "overlay": {
    "layout": "strip",
    "sections": {
      "speed": true,
      "gear": true,
      "rpm": true,
      "fuel": true,
      "range": true,
      "sdk-consumption": true,
      "cargo": true,
      "origin": true,
      "destination": true,
      "distance-driven": true,
      "distance-remaining": true,
      "deadline": true,
      "expected-income": true,
      "game-time": true
    }
  }
}
```

The application writes exactly this shape: UTF-8 without a byte order mark, two-space indentation, a trailing newline and all fourteen section keys in this canonical order. When reading it:

- a leading UTF-8 byte order mark is accepted and unknown keys are ignored;
- a file larger than 64 KiB, bytes that are not UTF-8, anything other than a JSON object, a missing or different `format` marker, or a `version` that is not an integer makes the file **invalid**;
- a version 1 file is migrated in memory ([below](#migration-from-v1)) and then read as v2;
- a missing `version` or a version below 1 is **unsupported-older**: there is no migration path, so such a file uses defaults;
- a version above 2 is **newer-version**: written by a later application version;
- each `units.ets2` and `units.ats` value must be exactly `metric` or `us-customary`;
- `overlay.layout` must be exactly `strip`, `card`, `cluster` or `hud`;
- `overlay.sections` must be an object of booleans that enables at least one section.

An invalid or missing value falls back to its default on its own (**loaded-with-fallbacks**); the other values still apply. The fallback field paths are `units.ets2`, `units.ats`, `overlay.layout`, `overlay.sections` and `overlay.sections.<id>`:

- A missing or non-object `overlay` block falls back as `overlay.layout` and `overlay.sections`.
- A missing or non-object `sections` value, or one that enables no section, falls back as a whole to every section (`overlay.sections`).
- A single missing or non-boolean section falls back to its default, enabled (`overlay.sections.<id>`).

### Migration from v1

Format v1 (ET-011b) had only the `units` block. The migration chain in `apps/desktop/src/settings-schema.ts` has one pure step, v1 to v2, which never mutates its input. It adds the overlay block with its defaults (the strip layout and every section). The v1 units then pass the normal v2 validation, so an invalid v1 unit still falls back alone. A migrated file loads as `loaded` (or `loaded-with-fallbacks`) and its load row carries `migratedFrom: 1`. Nothing is written at startup: the file stays v1 on disk until the first save of any setting writes the complete v2 document. A migrated file is valid, so it is never quarantined.

**Downgrade.** An ET-011b build reads a v2 file as `newer-version`: it uses default units, never modifies the file and refuses to save (`SETTINGS_READ_ONLY`). Going back to that build therefore shows default units until a newer build runs again.

## Overlay settings (ET-012a)

| Field | Values | Default |
| --- | --- | --- |
| `overlay.layout` | `strip` (one 38 px row at the top centre), `card` (top right), `cluster` (round speed gauge and side panel at the bottom left), `hud` (shadowed text at the top left) | `strip` |
| `overlay.sections.<id>` | `true` or `false` for each of the fourteen sections; at least one `true` | all `true` |

The settings card groups the sections as Driving (`speed`, `gear`, `rpm`), Fuel (`fuel`, `range`, `sdk-consumption`), Job (`cargo`, `origin`, `destination`, `distance-driven`, `distance-remaining`, `deadline`, `expected-income`) and Time (`game-time`). Which sections the live bridge can fill today, and how a section without data appears, is described in [live telemetry fields](live-telemetry-fields.md#overlay) and [the minimal overlay](minimal-overlay.md#layouts-and-sections-et-012a).

## Unit profiles

| Profile | Speed | Fuel |
| --- | --- | --- |
| `metric` | km/h | L |
| `us-customary` | mph | US gal |

Defaults follow ET-000: ETS2 `metric` and ATS `us-customary`. Without a selected game (or with a fixture that names no game), the metric profile applies. The profile ids are telemetry-core's `DisplayProfileId`, and `apps/desktop/src/unit-profiles.ts` asserts at compile time that the contract type `UnitProfile` in `packages/contracts/src/app-state.ts` is the same set. That module only maps settings to a profile and builds the overlay and dashboard strings; every conversion constant, conversion and rounding rule comes from `packages/telemetry-core` (`units.ts`, `display-profile.ts`, `format.ts`). Canonical telemetry stays in m/s and liters. With the default profiles the overlay text is unchanged from earlier versions, and so is the dashboard's for ETS2 and without a game. The ATS dashboard, which earlier always showed km/h and liters, now follows the ATS US customary default (mph and US gallons), like the overlay. Money is never converted (ET-010 N9). The dashboard's **Live telemetry** card (ET-010b) uses the same per-game profile for every row with a unit.

## Load states

Loading happens once at startup, in parallel with the service start. Loading never creates, changes or removes a file or directory. The load returns within a 1000 ms budget, and the first dashboard and overlay windows open only after it returned:

- If the read finishes within the budget, its state applies at once, as in the table below.
- If it is still running when the budget expires (for example on a CPU-starved start, as in hosted run 38755116140), the windows open with defaults in the read-only `loading` state and the same read keeps running. When it settles, its own result applies (state, units and whether saving is possible) and is pushed to the dashboard and the overlay as a save is (see [below](#dashboard-and-overlay)). A read error then still means `unreadable`.
- A read that has not settled within `SETTINGS_READ_LIMIT_MS` (about 30 s after the start: the limit timer is armed for the remaining 29 s when the 1,000 ms budget expires, so a CPU-starved start can push the cutoff slightly later) is treated as hung: the session becomes `unreadable` and the read's later result is ignored. A bounded read of a file of at most 64 KiB that takes this long is not CPU starvation but a stuck file system, for example an unreachable redirected folder; in run 38755116140 the whole startup, both windows included, took about 6 s. The limit keeps the units card from saying "still being read" indefinitely.

| State | Meaning | Units in use | Can save |
| --- | --- | --- | --- |
| `loading` | The read outlasted the 1000 ms budget and has not settled yet | Defaults | No (`SETTINGS_WRITE_FAILED`); refused at once, never queued |
| `defaults` | No settings file (or no settings directory) | Defaults | Yes; the first save creates the file |
| `loaded` | A valid v2 file, or a valid v1 file migrated in memory | From the file (overlay defaults for a v1 file) | Yes; a migrated v1 file is rewritten as v2 by the first save |
| `loaded-with-fallbacks` | A v2 (or migrated v1) file with some invalid fields | Valid fields from the file, defaults for the others | Yes; the save rewrites the whole file |
| `invalid-file` | Not a usable settings file | Defaults | Yes; the first save quarantines the file |
| `unsupported-older` | An older format without a migration path | Defaults | Yes; the first save quarantines the file |
| `newer-version` | Written by a newer version (version 3 or later) | Defaults | No (`SETTINGS_READ_ONLY`); the file is never modified |
| `unreadable` | The file or directory is a symbolic link or junction, not a plain file or directory, or could not be read, or the read had not settled within the read limit (about 30 s) | Defaults | No (`SETTINGS_WRITE_FAILED`) |
| `unavailable` | No valid settings location | Defaults | No (`SETTINGS_WRITE_FAILED`) |

The settings directory and file are inspected with `lstat`, which does not follow links: a symbolic link or junction is refused and never read or written through.

## Saving

A change of a unit profile, the overlay layout or the overlay sections is saved in this order; the new settings apply in memory only after the final rename succeeded:

1. Create the settings directory if needed and check again that it is a plain directory.
2. Remove stale temporary files of the store's own pattern `settings.json.<pid>.<uuid>.tmp`, left by an interrupted earlier save. No other file is touched.
3. If the file loaded as `invalid-file` or `unsupported-older`, rename it unchanged to `settings.rejected-<UTC yyyymmddThhmmssZ>.json` (with `-2`, `-3`, … when that name exists) and keep only the newest three such files. This happens once, on the first save.
4. Write the new content to a new temporary file (exclusive create), flush it to disk (`FileHandle.sync()`) and close it.
5. Rename the temporary file over `settings.json`. Antivirus scanners and indexers can briefly hold new files open on Windows, so `EPERM`, `EACCES` and `EBUSY` are retried up to five times after 20, 40, 60, 80 and 100 ms (300 ms in total).

If any step fails, the temporary file is removed, the previous file and the settings in use stay as they were, the request is rejected and the settings view's `saveError` becomes `SETTINGS_WRITE_FAILED` (`SETTINGS_READ_ONLY` for a newer-version file) until the next successful save clears it. Settings errors never change the service's health or its last problem. A failure after the quarantine rename leaves no `settings.json`, which the next start reads as defaults. Node.js cannot flush a directory entry on Windows, so the rename itself is not separately flushed.

Saves of every kind share one serialized queue, and each save computes its new settings from those in use when its write starts, so a unit save and an overlay save never undo each other. Every save writes the complete v2 document. At most four may be outstanding, including the one in progress; a fifth request is refused at once without changing the settings view. Once the load has returned, a read-only state (`loading`, `newer-version`, `unreadable`, `unavailable`) refuses a save at once instead of queuing it, so neither later saves nor the exit's wait depend on a read that is still pending. Because nothing is saved while the read is pending, a late `invalid-file` or `unsupported-older` file is quarantined only by a save after its state was applied. A save requested before the load returned (no window exists then) waits for the read's result, or at most until the 30 s read limit, which refuses it. An explicit exit waits for an in-flight save for at most 1000 ms (`EXIT_IDLE_BUDGET_MS`, see [the application lifecycle](app-lifecycle.md#explicit-exit)); new saves are refused once the exit has started. A save cut short by the exit leaves at most a temporary file, which the next save removes.

## Dashboard and overlay

The dashboard's **Display units** card has one shadcn radio group per game (`metric`, `US customary`) and a line that explains the load state. A choice shows as selected only after main saved it; while a save runs the groups are disabled. A refused save shows the view's `saveError` text in the card that requested it (`The change could not be saved; the previous settings stay in use.` or the read-only explanation; the wording became neutral in ET-012a because the overlay card shares it); a request that failed before reaching the store shows `The unit change was not saved; the previous units stay in use.` The groups are disabled when the settings cannot be saved. While a read that outlasted the load budget is pending, the card shows `Saved settings are still being read; defaults are in use and changes cannot be saved yet.` with the groups disabled; this is a functional state line rather than a spinner, like the other load states. When the read settles, main pushes the new settings view exactly as after a save, so the card, the dashboard rows and the overlay switch to the file's units without a restart. The dashboard's speed and fuel rows use the profile of the displayed game (`displayProfile` in `unit-profiles.ts`), with each game's default before the first settings push.

The preload bridge appends one method, `setUnitProfile(game, profile)`. The preload accepts only `ets2`/`ats` and `metric`/`us-customary` and forwards exactly those two values over `settings:set-unit-profile`. Main checks the sender and its main frame, validates both values and the argument count again, and resolves with the new settings view only after the save. It then pushes `AppState` (whose `settings` holds the units, the load state, whether saving is possible and the last save error) to a subscribed dashboard, and republishes the overlay projection from main's stored freshness output in the new units. The republication accepts no observation and renews neither the SDK nor the window freshness deadline, so a reading that was about to expire still expires on time and the overlay placement is unchanged. Neither the renderer nor the overlay receives a path, file content or error text.

ET-012a adds the **Overlay** card after the units card and two more bridge methods (decision L3). There is no generic settings patch: each channel accepts one fixed shape.

- `setOverlayLayout(layout)` over `settings:set-overlay-layout`: exactly one argument, one of the four layout ids.
- `setOverlaySections(sections)` over `settings:set-overlay-sections`: exactly one argument, a complete record with exactly the fourteen section ids as own data properties, booleans only, at least one `true`, and a plain object prototype. The preload forwards a fresh copy of the validated record; main validates it again (`parseOverlaySections` in `apps/desktop/src/overlay-sections.ts`) and hands the store a frozen copy.

Both are refused for an untrusted sender or frame (including the overlay), for any other shape, and once the exit has started. They share the unit save's error mapping (fixed messages only) and its refusal reporting in `saveError`. After the durable save main pushes `AppState`, republishes the overlay projection with the new layout and sections from its stored freshness output, and moves the overlay window to the new layout's anchor (see [the minimal overlay](minimal-overlay.md#layouts-and-sections-et-012a)). As for units, this renews neither SDK nor window freshness. A late startup read that brings another layout is applied the same way. The card shows only saved values: the layout radio group, three presets (Everything, Job focus, Driving only, shown as pressed when the saved sections equal them) and one switch per section grouped Driving, Fuel, Job and Time, with a marker for sections that need protocol v1 or trip tracking. Controls are disabled while a save runs and when settings cannot be saved; the last enabled section cannot be switched off.

## Diagnostics

Startup logs `SETTINGS_LOADED` (`state` `defaults` or `loaded`) or `SETTINGS_FALLBACK` (any other state, with `fields` for fallbacks or a fixed `reason` such as `reparse-point`, `read` or `load-limit`). A v1 file migrated in memory adds `migratedFrom: 1` to its `SETTINGS_LOADED` or `loaded-with-fallbacks` row. A read that outlasts the 1000 ms budget first logs `SETTINGS_LOAD_PENDING` (`state` `loading`, `reason` `load-budget`); the `SETTINGS_LOADED` or `SETTINGS_FALLBACK` row that follows when it settles, or at the 30 s limit, has the same facts as for a read within the budget. Saves log `SETTINGS_QUARANTINED` and `SETTINGS_SAVED` with `game` and `profile` for a unit save, `overlayLayout` for a layout save, or `overlaySections` (the number of enabled sections) for a sections save. None of these names match the smoke failure pattern `FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE`. A refused newer-version save logs `SETTINGS_SAVE_REFUSED`; a failed save logs `SETTINGS_WRITE_FAILED` with the failing `step` and the error `code`. Facts carry fixed codes only, never paths or file content.

## Tests

- `tests/unit/settings-schema.test.ts`: every load classification, the 64 KiB boundary, the byte order mark and the exact serialized bytes. Since ET-012a: a v2 file, the pure v1-to-v2 migration (units kept, an invalid v1 unit falling back alone, `migratedFrom`, the input not mutated), version 3 as the first newer version, each overlay fallback including a record that enables nothing, and the canonical section order of the v2 bytes and their round trip.
- `tests/unit/settings-store.test.ts`, ET-012a cases: a v1 file byte-identical at startup and rewritten as v2 with its units by the first overlay save; a v2 overlay block loaded without a migration fact; exact v2 bytes for a sections save, applied only after the rename; a failed overlay save keeping the previous overlay settings; overlay saves refused for a newer-version file and during a pending read; unit and overlay saves serialized in one queue with every change surviving and their facts; and the shared four-request bound. The existing cases now expect the overlay defaults in each view and v2 bytes after a save, and the newer-version cases use version 3.
- `tests/unit/settings-store.test.ts` (real temporary directories; failures injected by wrapping the real file operations): no write on startup, exact bytes, `sync` before the rename, EPERM/EACCES/EBUSY retry, a persistent EPERM that keeps the previous file and removes the temporary file, failures at write, sync and rename that leave the old file valid, byte-identical quarantine on the first save only, keeping the newest three quarantined files, newer-version untouched and read-only, a junction directory and a symbolic-link file refused, only matching temporary files removed, serialized saves, the four-request bound and the idle hook, the unavailable location and the 1000 ms load budget, a prompt refusal with no idle work after the budget expired over a read that never settles, and `saveError` set by a failed save and cleared by the next one. Since October 15, 2026, with controlled timers and a gated real read (clean late read): the pending `loading` view and its log row; a late corrupt file applied as `invalid-file` and quarantined byte-identically only by a later save (the hosted run 38755116140 regression); late `loaded`, `loaded-with-fallbacks`, `unsupported-older` and `newer-version` files applied with their own writability and nothing written; a save during the pending read refused at once without queuing or quarantine; a late read error staying `unreadable`; a hung read declared `unreadable` at the 30 s limit with its later result ignored; and a save requested before the load returned refused at the limit.
- `tests/unit/unit-profiles.test.ts`, `overlay.test.ts`, `speed-display.test.ts`: profile mapping, both profiles in the overlay and dashboard, and the dashboard's profile choice with the ATS US customary default; the existing overlay and dashboard cases are unchanged, and the one that calls `dashboardSpeed` without a profile is titled for its implicit metric default. A source check keeps conversion constants and `toFixed` out of the desktop display modules.
- `tests/unit/main-boundaries.test.ts`: trusted sender and frame only, invalid values rejected, the change applied only after the save, the overlay republished without renewed authority, refused saves reported in the settings view while a service problem stays the last problem, the exit waiting for an in-flight save within 1000 ms, the first windows opening only after the load returned, and a late read pushed to the dashboard and republished to the overlay in the new units without a save or renewed freshness. `preload-recovery.test.ts` covers the bridge validation. ET-012a adds the two overlay channels to both: trust, argument count and shape validation, the fresh frozen copy handed to the store, apply after the save with republication and re-placement without renewed freshness, the shared error mapping, refusal while exiting, and a late read that changes the layout.
- The development and packaged `lifecycle` runtime smokes seed an invalid file and check quarantine, exact content (v2 since ET-012a), mph and US gallons, and the restart; a pending read is waited for before the exact checks. See [CI](ci.md#et-011b-settings-in-the-lifecycle-smoke). The overlay smoke's final step saves the `card` layout and waits for the overlay document to render it.

Evidence and pending manual checks are in [ET-011 validation](validation/et-011.md#et-011b-persistent-settings-and-unit-profiles) and [ET-012a validation](validation/et-012a.md).
