# Persistent settings, overlay visibility and autostart (ET-011b, ET-012, ET-029, ET-031)

ET-049 UI follow-up, October 25, 2026: Background opacity shows one percentage to the right of the slider. It follows the draft immediately during a gesture, then the committed value after save or refusal recovery. The separate Saved label from the initial implementation is removed. Writes and overlay publication still occur only on commit through the existing durable-save path.

ET-011b stores the user's settings in a small JSON file and uses them to choose the display units of each game. ET-012a adds the overlay layout and the overlay sections in format v2. ET-012b adds the saved position and scale of every overlay layout in format v3. The decisions behind the file are C10–C12 in [concept.md](../concept.md#et-011-authorization--october-15-2026) and, for the overlay settings, L2, L3 and L13 in [concept.md](../concept.md#et-012a-authorization--october-15-2026) and M2, M3, M10, M11 and M12 in [concept.md](../concept.md#et-012b-authorization--october-15-2026); numeric conversion follows ET-010 decision N2 (telemetry-core is the single numeric source). ET-029 adds the UI language (`language: 'en' | 'ru'`) in format v4, letting the user switch desktop app, tray and overlay live without restart. ET-031 adds Start with Windows (`autostart: boolean`) in format v5, allowing the application to launch minimized to the notification area upon user sign-in.

ET-012e added saved overlay visibility in historical format v6, defaulting to enabled. ET-049 makes v7 the current format by adding background opacity. Accepted ET-031 v5 remains the autostart format; earlier ET-012 visibility-v5 records describe an unmerged prototype schema, not a second historical v5 contract.

ET-045e update, October 24, 2026 (decision Z5, owner decision D1 option b; ET-049 took v7 first, so ET-045e uses v8): the current format is **v8**. It has exactly the fields and canonical layout of ET-049's v7 document below with `"version": 8`. What changed is the meaning of each placement's `scale`: it is the user's setting, shown as a percentage, and the overlay document's zoom factor is now setting × 0.7 (`overlayZoom` in `apps/desktop/src/overlay-placement.ts`), so the new 100% looks like the earlier 70%. Its range is [0.5, 3] (50–300%) instead of [0.5, 2]. Saved numbers are kept and reinterpreted, never rewritten: a v7 file migrates to v8 by an identity step (`migratedFrom: 7`), and the owner's saved strip at 0.5 now renders at the earlier 35% (choose 70% for the earlier 50% look). See [ET-045e validation](validation/et-045e.md). The v7 and v6 headings below keep their ET-049 and ET-012e wording; read "current" there as the field layout that v8 retains.

## Current format v9: gear display (ET-050)

ET-050 update, October 25, 2026 (decisions GD1–GD8 in [concept.md](../concept.md#et-050-gear-display-mode--october-25-2026)): the current format is **v9**. It is the v8 document with `"version": 9` and one new block, `gearDisplay`, written right after `units`:

```json
  "units": {
    "ets2": "metric",
    "ats": "us-customary"
  },
  "gearDisplay": {
    "ets2": "automatic",
    "ats": "automatic"
  },
```

Each game's value is exactly `automatic` (gears 1, 2, 3…) or `manual` (range-splitter pairs 1L, 1H, 2L, 2H…); neutral is N and reverse R1, R2… in both. The default is `automatic` for both games. Only the displayed text changes: the live protocols, the history database, the one-second samples, the journal and the JSON export keep the raw integer gear index.

- **Load rules.** A missing block, a block that is not an object, or a block as an array falls back for both games (`gearDisplay.ets2` and `gearDisplay.ats`). Inside an object each game falls back alone when its value is missing or is not one of the two exact strings; `"Manual"`, numbers and booleans are never coerced. Unknown keys inside the block are ignored.
- **Migration v8 to v9.** The pure step adds `{"ets2": "automatic", "ats": "automatic"}`. A stray `gearDisplay` key in a pre-v9 document is replaced, as ET-049 does for opacity, so an earlier hand edit never becomes a v9 preference. A v1 to v8 file is migrated in memory (`migratedFrom: 1` to `migratedFrom: 8`) and stays unchanged on disk; nothing is written at startup, and the first save of any setting writes the complete v9 document.
- **Newer and older builds.** A version of 10 or later is newer-version (read-only defaults; the file is never modified). A build before ET-050 reads v9 as newer-version and refuses to save, so it can never drop the gear display mode by rewriting the file. Running an ET-050 build with an earlier build's profile therefore makes that earlier build read-only until a newer build runs again.
- **Bridge.** `setGearDisplay(game, mode)` over `settings:set-gear-display`: exactly two arguments, `ets2`/`ats` and `automatic`/`manual`, from the trusted dashboard main frame only. The preload, main and the store each validate it. The save shares the queue and the four-request bound of every other setting, applies only after the durable rename and logs `SETTINGS_SAVED` with the facts `{game, gearDisplay}` only. Settings diagnostics and the diagnostic bundle carry `settings.gearDisplay`.
- **Display.** Main republishes the overlay from its stored freshness output after the save, without renewing SDK or window freshness, exactly as for a unit profile. The overlay renderer still receives only formatted text. The dashboard's Live instrument and Live details row use the same mode, chosen by the same displayed-game rule as the unit profile (automatic without a game or before the settings arrive).
- **Settings > Units.** A **Gear display** card below the units card has one labelled radio group per game, described by a note on the forms and on stored telemetry. It shows only the committed mode, is disabled while a save is in flight or the settings are read-only, and shows a refused save in its own card.
- **Tests.** `settings-schema.test.ts` (v9 bytes, the v8-to-v9 step, each fallback, version 10 as newer-version), `settings-store.test.ts` (a v8 file byte-identical at startup, the first gear save writing exact v9 after the rename, failure and read-only refusal, the shared queue with unit saves, reload), `preload-recovery.test.ts`, `main-boundaries.test.ts`, `gear-display-card-rendering.test.ts`, `gear-display-choice.test.ts`, and the `lifecycle` and `ui` runtime smokes. See [ET-050 validation](validation/et-050.md).

The v8, v7 and v6 sections below keep their wording; read "current" there as the field layout that v9 retains.

## Location

The file is `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json`. Main resolves `%LOCALAPPDATA%` at runtime through `dataPaths(LOCALAPPDATA).settings` (`apps/desktop/src/paths.ts`), separately from the application binaries and from `telemetry.sqlite`, so an application update does not replace it. When `LOCALAPPDATA` is missing or not an absolute path, there is no settings location: defaults apply and nothing can be saved (`unavailable`). Preserving the file across a real installed update and an optional uninstall removal belong to ET-018. Since ET-018 PR-1 the installer lifecycle proves that install, repair and update keep the file byte-identical. An uninstall deletes it with the rest of the data folder, from Windows Settings or from the application; the [in-app uninstall](uninstall.md#in-app-uninstall) and the Journal tab's export note say so ([user guide](user-guide.md#uninstalling)).

## Current format v7: background opacity (ET-049)

Format v7 adds `overlay.backgroundOpacity`, a whole percentage from 40 through 100, default 80. It serializes immediately after `overlay.enabled`; the remainder is the v6 shape below, with `"version": 7`. An invalid/missing value in v7 falls back independently to 80 (`overlay.backgroundOpacity`); values are neither coerced nor clamped. The v6-to-v7 pure migration installs 80 even if an older document carries an unknown stray opacity key, preserving all existing preferences. The v1–v6 chain remains supported without startup writes, and the next durable save writes v7. A version greater than 7 is read-only; a v6 application treats v7 as newer-version and cannot drop the new setting.

Settings > Overlay uses an EN/RU, labelled keyboard-accessible slider (40–100%, step 1). Its thumb and single adjacent percentage follow the candidate during a held gesture; the overlay retains the committed value until a durable save succeeds. Releasing a gesture or a keyboard step submits one save, and Radix blocks further interaction until it settles. A pending thumb retains its tab stop and keyboard focus with `aria-disabled`; a read-only thumb is fully disabled. No movement-event writes are queued. Failure restores the thumb and displayed percentage to the committed value and displays the existing contextual settings error; read-only disables the slider. The shared four-request main-owned settings queue remains the final bound for all callers.

`setOverlayBackgroundOpacity(number)` uses `settings:set-overlay-background-opacity`, exactly one validated whole percentage, from the trusted dashboard main frame only. Preload and main validate independently; the store also rejects invalid values. Settings diagnostics carry `backgroundOpacity`, and save facts carry only `overlayBackgroundOpacity`. Main publishes the committed percentage as a display-only overlay field without renewing source freshness. The content container sets `--yu-ov-panel` to `rgba(11,17,32,percentage/100)`; it changes only Strip/Card surfaces and both Cluster surfaces. Minimal remains backgroundless. Text, badges, icons, gauges, stale dimming, the transparent root/margins and edit outline/fill retain their own styles. No native window opacity is used.

Opacity persists independently of layout and placement drafts, including Done/Cancel/Escape, tray reopen, reload and restart. Tests cover migration, write failure/recovery/read-only, durable ordering/queue bounds, strict IPC and display publication. UI journeys check EN/RU keyboard/held-pointer behavior, failed writes, read-only, computed background-only rendering at 40/65/80/100 across all four layouts, and existing input/security/scroll assertions. Real-game appearance/input and installed-update evidence remain pending. See [ET-049 validation](validation/et-049.md).

## Historical format v6 (ET-012e integrated with ET-031)

The following describes the pre-ET-049 v6 format and its earlier migration steps. Current reads/writes use v7 as specified above (v8 since ET-045e, with the same fields).

```json
{
  "format": "ets2telemetry.settings",
  "version": 6,
  "language": "en",
  "autostart": false,
  "units": {
    "ets2": "metric",
    "ats": "us-customary"
  },
  "overlay": {
    "enabled": true,
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
    },
    "placements": {
      "strip": {
        "x": 0.5,
        "y": 0,
        "scale": 1
      },
      "card": {
        "x": 1,
        "y": 0,
        "scale": 1
      },
      "cluster": {
        "x": 0,
        "y": 1,
        "scale": 1
      },
      "hud": {
        "x": 0,
        "y": 0,
        "scale": 1
      }
    }
  }
}
```

The application writes exactly this shape: UTF-8 without a byte order mark, two-space indentation, a trailing newline, all fourteen section keys in this canonical order and the placements of all four layouts in the canonical layout order (`strip`, `card`, `cluster`, `hud`), each with `x`, `y` and `scale` in this order. When reading it:

- a leading UTF-8 byte order mark is accepted and unknown keys are ignored;
- a file larger than 64 KiB, bytes that are not UTF-8, anything other than a JSON object, a missing or different `format` marker, or a `version` that is not an integer makes the file **invalid**;
- a version 1 to 7 file is migrated in memory ([below](#migration-from-v1-v2-v3-v4-and-v5)) and then read as v8 (ET-045e); since ET-050 a version 1 to 8 file is migrated on to v9;
- a missing `version` or a version below 1 is **unsupported-older**: there is no migration path, so such a file uses defaults;
- a version above 8 is **newer-version** (since ET-045e): written by a later application version; since ET-050 a version above 9;
- `language` must be exactly `en` or `ru` (default: `en`);
- `autostart` must be a strict boolean (default: `false`), independently of overlay visibility;
- each `units.ets2` and `units.ats` value must be exactly `metric` or `us-customary`;
- `overlay.enabled` must be a boolean (default: `true`); strings and numbers are not coerced;
- `overlay.layout` must be exactly `strip`, `card`, `cluster` or `hud`;
- `overlay.sections` must be an object of booleans that enables at least one section;
- `overlay.placements` must be an object; each layout's placement must have `x` and `y` that are finite numbers in [0, 1] and a `scale` that is a finite number in [0.5, 3] (ET-045e; [0.5, 2] before). Values are rounded to four decimals (`x`, `y`) and two decimals (`scale`) when read and when written.

An invalid or missing value falls back to its default on its own (**loaded-with-fallbacks**); the other values still apply. The fallback field paths include `language`, `autostart` and `overlay.enabled`; the remaining paths are `units.ets2`, `units.ats`, `overlay.layout`, `overlay.sections`, `overlay.sections.<id>`, `overlay.placements` and `overlay.placements.<layout>`:

- A missing or non-object `overlay` block falls back as `overlay.layout`, `overlay.sections`, `overlay.placements` and `overlay.enabled`.
- A missing or non-object `sections` value, or one that enables no section, falls back as a whole to every section (`overlay.sections`).
- A single missing or non-boolean section falls back to its default, enabled (`overlay.sections.<id>`).
- A missing or non-object `placements` value falls back as a whole to the default placements (`overlay.placements`).
- One layout's placement that is missing, not an object, or has an `x`, `y` or `scale` that is missing, not a finite number or outside its range falls back alone to that layout's default (`overlay.placements.<layout>`). An out-of-range value is never clamped.

### Format v3 (ET-012b)

Format v3, written by ET-012b builds, is the v6 document above without `language`, `autostart` or `overlay.enabled` and with `"version": 3`. This version reads it through the migration below and writes it back only as v6.

### Format v2 (ET-012a)

Format v2, written by ET-012a builds, is the v3 document above without `overlay.placements` and with `"version": 2`.

### Format v5 (accepted ET-031)

Format v5 is the current v6 document without `overlay.enabled`, with `"version": 5`. It contains the strict `autostart` boolean. Its value is preserved by the v5-to-v6 step; no startup rewrite occurs.

### Migration from v1, v2, v3, v4 and v5

Format v1 (ET-011b) had only the `units` block; format v2 (ET-012a) added the overlay layout and sections; format v3 (ET-012b) added overlay placements; format v4 (ET-029) added the UI language. The migration chain in `apps/desktop/src/settings-schema.ts` has five pure steps, which never mutate their input:

- v1 to v2 adds the overlay block with its defaults (the strip layout and every section). The v1 units then pass the normal validation, so an invalid v1 unit still falls back alone.
- v2 to v3 (ET-012b) adds the default placements of all four layouts to the overlay block; the layout and sections are kept. A v2 file never had placements, so a stray `placements` key in it is replaced by the defaults. A v2 overlay that is not an object stays as it is and falls back as a whole.
- v3 to v4 (ET-029) adds `"language": "en"`.
- v4 to v5 (accepted ET-031) adds `"autostart": false` exactly as the accepted migration.
- v5 to v6 (ET-012e) adds `"enabled": true` inside an object-valued overlay, preserving autostart, language, units, layouts, sections and placements. A stray pre-v6 visibility key is replaced by the default; malformed overlay values continue through normal fallback.
- v6 to v7 (ET-049) adds `backgroundOpacity` 80 ([above](#current-format-v7-background-opacity-et-049)).
- v7 to v8 (ET-045e) changes only `version`. Every placement number is kept, so each saved scale now means the rebased setting. An earlier scale in (2, 3] could only come from a hand-edited file; after this step it passes the v8 range check instead of falling back.

A v1 file passes all seven steps. A migrated file loads as `loaded` (or `loaded-with-fallbacks`) and its load row carries `migratedFrom: 1` to `migratedFrom: 7`. Nothing is written at startup: the file stays v1 to v7 on disk until the first save of any setting writes the complete v8 document. A migrated file is valid, so it is never quarantined.

**Downgrade.** A build before ET-045e, including ET-049, reads v8 as newer-version: it shows read-only defaults and never modifies the file. The bump was chosen over keeping v7 so that an older build neither misreads the rebased numbers at the earlier zoom nor replaces a scale above 2 with its default on its next save. Running an ET-045e build with an earlier build's profile therefore makes that earlier build read-only until a newer build runs again; use a separate profile for frozen candidates. The accepted v5 application reads v6 as newer-version and refuses writes, preserving both flags. An application supporting only v4 reads v5 as newer-version and refuses writes. An ET-011b build reads a v2 or v3 file, and an ET-012a build a v3 file, as `newer-version`: it uses defaults, never modifies the file and refuses to save (`SETTINGS_READ_ONLY`). Going back to such a build therefore shows default units and overlay settings until a newer build runs again. Making `placements` an optional key in v2 instead was rejected (decision M2), so that an older build never rewrites a file and silently drops the placements.

## Overlay settings (ET-012a)

| Field | Values | Default |
| --- | --- | --- |
| `overlay.enabled` (ET-012e) | `true` or `false` | `true` |
| `overlay.layout` | `strip` (one or more 38 px rows at the top centre, as many as the enabled sections need), `card` (top right), `cluster` (round speed gauge and side panel at the bottom left), `hud` (shadowed text at the top left) | `strip` |
| `overlay.sections.<id>` | `true` or `false` for each of the fourteen sections; at least one `true` | all `true` |
| `overlay.placements.<layout>` (ET-012b) | `x` and `y` in [0, 1], `scale` in [0.5, 3] (ET-045e; zoom = scale × 0.7); see [overlay placements](#overlay-placements-and-edit-mode-et-012b) | the ET-012a anchor of each layout at scale 1: strip `0.5, 0`, card `1, 0`, cluster `0, 1`, HUD `0, 0` |

The settings card groups the sections as Driving (`speed`, `gear`, `rpm`), Fuel (`fuel`, `range`, `sdk-consumption`), Job (`cargo`, `origin`, `destination`, `distance-driven`, `distance-remaining`, `deadline`, `expected-income`) and Time (`game-time`). Which sections the live bridge can fill today, and how a section without data appears, is described in [live telemetry fields](live-telemetry-fields.md#overlay) and [the minimal overlay](minimal-overlay.md#layouts-and-sections-et-012a). Since ET-012c a sections save can change the strip's height: the strip reserves rows for every enabled section, whether or not it currently has data, and is re-placed after the durable save ([geometry](minimal-overlay.md#geometry-and-placements-et-012b)). The settings format is unchanged.

### Overlay placements and edit mode (ET-012b)

Each layout has its own placement, so switching layouts keeps every layout where the user put it. A placement is not a pixel position: `x` and `y` are fractions of the free space left inside the game's client area once the margins and the scaled overlay window are taken away (0 is the left or top margin, 1 the right or bottom one), and `scale` multiplies the layout's size and content. A saved placement therefore stays inside any client area the scaled layout fits, by construction; a layout that does not fit at its scale hides the overlay as before (see [the minimal overlay](minimal-overlay.md#geometry-and-placements-et-012b)). Multi-monitor, mixed-DPI, monitor-removal and off-screen recovery stay deferred.

ET-012e presentation amendment, October 22, 2026: the same `y` also aligns the painted layout vertically within the reserved native window. Sparse content therefore aligns with the top, centre or bottom of the usable client area at `y = 0`, `0.5` or `1` without resizing the window when fields appear or disappear. Main publishes this display-only anchor from the committed placement, or the edit draft while editing; it is not a new saved setting or renderer command. During a held native drag the internal anchor stays fixed and the application applies no new zoom or bounds. After release the recomputed fraction can shift the painted content inside the window by `(reserved height - painted height) × change in y`; this can be large when little native travel remains and is a separate owner usability check. Bottom alignment does not establish pointer-drop continuity. The schema, scale range and native-window fraction definition are unchanged.

Placements change only through the overlay **edit mode** (decisions M5 and M10–M12). The mode lives in main's memory only: it is never saved, and every start is in driving mode. The **Overlay** card's **Position and size** block shows the saved scale of the current layout and an **Edit position** button, enabled while settings can be saved. In edit mode the block shows where the overlay is (`visible`, waiting for the game window, too large for it, or hidden while another application or the game is in front), **Smaller** and **Larger** (10 % steps within 50–300 % since ET-045e, 50–200 % before; the percentage is the setting, whose zoom is setting × 0.7), **Reset to default**, **Done**, **Cancel** and a help line: drag the outlined overlay over the game; Enter on the overlay saves and Esc cancels. The layout radio group is disabled while editing; section, preset and unit changes stay possible. Dragging, scaling and resetting change only main's draft and write nothing.

The preload bridge appends four methods, each over its own fixed-shape invoke channel. Main accepts them only from the trusted dashboard main frame (never from the overlay), validates them again and refuses them once the exit has started:

| Method | Channel | Request | Result |
| --- | --- | --- | --- |
| `beginOverlayEdit()` | `overlay-edit:begin` | no argument; refused while settings cannot be saved (`writable` false) | the edit state; a second call returns the current state |
| `setOverlayEditScale(scale)` | `overlay-edit:set-scale` | exactly one finite number in [0.5, 3] (ET-045e; [0.5, 2] before), rounded to two decimals; only while editing; main applies `overlayZoom(scale)` as the zoom factor | the edit state |
| `resetOverlayEditPlacement()` | `overlay-edit:reset` | no argument; the layout's default placement at scale 1; only while editing | the edit state |
| `finishOverlayEdit(outcome)` | `overlay-edit:finish` | exactly `save` or `cancel`; only while editing | the settings view |

`AppState.overlayEdit` is `{active: false}` or `{active: true, layout, scale, placement}`, with `placement` one of `visible`, `waiting-for-game`, `too-large` and `not-foreground`; main pushes it whenever it changes. While editing, `settings:set-overlay-layout` is refused with a fixed message (`The overlay layout cannot change while its position is edited`).

**Done** (or Enter on the focused overlay) leaves edit mode first, so the overlay is hidden and click-through again before anything is written. It then saves the draft through the shared settings queue (`setOverlayPlacement(layout, placement)` in the store) like any other change: it applies only after the durable rename, and a failed or refused save keeps the previous placement and reports `saveError` in the card. **Cancel** (or Esc) discards the draft and writes nothing. Edit mode is also cancelled without writing when the dashboard closes to the tray, is minimized, or its document is reloaded, replaced or crashes, when the overlay's subscription or document is retired (an unsubscribe, including the one the overlay preload sends after a lost channel, a reload, a crash or a close), and when the exit begins. The overlay can thus end an edit only by cancelling it; it cannot start, change or save one. While edit mode is active the driving overlay stays hidden, even with the game in front, until Done or Cancel.

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
| `loaded` | A valid v3 file, or a valid v1 or v2 file migrated in memory | From the file (overlay defaults for a v1 file, default placements for a v2 file) | Yes; a migrated file is rewritten as v3 by the first save |
| `loaded-with-fallbacks` | A v3 (or migrated v1 or v2) file with some invalid fields | Valid fields from the file, defaults for the others | Yes; the save rewrites the whole file |
| `invalid-file` | Not a usable settings file | Defaults | Yes; the first save quarantines the file |
| `unsupported-older` | An older format without a migration path | Defaults | Yes; the first save quarantines the file |
| `newer-version` | Written by a newer version (version 9 or later since ET-045e; version 10 or later since ET-050) | Defaults | No (`SETTINGS_READ_ONLY`); the file is never modified |
| `unreadable` | The file or directory is a symbolic link or junction, not a plain file or directory, or could not be read, or the read had not settled within the read limit (about 30 s) | Defaults | No (`SETTINGS_WRITE_FAILED`) |
| `unavailable` | No valid settings location | Defaults | No (`SETTINGS_WRITE_FAILED`) |

The settings directory and file are inspected with `lstat`, which does not follow links: a symbolic link or junction is refused and never read or written through.

## Saving

A change of a unit profile, the overlay layout, the overlay sections or an overlay placement is saved in this order; the new settings apply in memory only after the final rename succeeded:

1. Create the settings directory if needed and check again that it is a plain directory.
2. Remove stale temporary files of the store's own pattern `settings.json.<pid>.<uuid>.tmp`, left by an interrupted earlier save. No other file is touched.
3. If the file loaded as `invalid-file` or `unsupported-older`, rename it unchanged to `settings.rejected-<UTC yyyymmddThhmmssZ>.json` (with `-2`, `-3`, … when that name exists) and keep only the newest three such files. This happens once, on the first save.
4. Write the new content to a new temporary file (exclusive create), flush it to disk (`FileHandle.sync()`) and close it.
5. Rename the temporary file over `settings.json`. Antivirus scanners and indexers can briefly hold new files open on Windows, so `EPERM`, `EACCES` and `EBUSY` are retried up to five times after 20, 40, 60, 80 and 100 ms (300 ms in total).

If any step fails, the temporary file is removed, the previous file and the settings in use stay as they were, the request is rejected and the settings view's `saveError` becomes `SETTINGS_WRITE_FAILED` (`SETTINGS_READ_ONLY` for a newer-version file) until the next successful save clears it. Settings errors never change the service's health or its last problem. A failure after the quarantine rename leaves no `settings.json`, which the next start reads as defaults. Node.js cannot flush a directory entry on Windows, so the rename itself is not separately flushed.

Saves of every kind share one serialized queue, and each save computes its new settings from those in use when its write starts, so a unit save and an overlay save never undo each other. Every save writes the complete v3 document. At most four may be outstanding, including the one in progress; a fifth request is refused at once without changing the settings view. Once the load has returned, a read-only state (`loading`, `newer-version`, `unreadable`, `unavailable`) refuses a save at once instead of queuing it, so neither later saves nor the exit's wait depend on a read that is still pending. Because nothing is saved while the read is pending, a late `invalid-file` or `unsupported-older` file is quarantined only by a save after its state was applied. A save requested before the load returned (no window exists then) waits for the read's result, or at most until the 30 s read limit, which refuses it. An explicit exit waits for an in-flight save for at most 1000 ms (`EXIT_IDLE_BUDGET_MS`, see [the application lifecycle](app-lifecycle.md#explicit-exit)); new saves are refused once the exit has started. A save cut short by the exit leaves at most a temporary file, which the next save removes.

## Dashboard and overlay

The dashboard's **Display units** card has one shadcn radio group per game (`metric`, `US customary`) and a line that explains the load state. A choice shows as selected only after main saved it; while a save runs the groups are disabled. A refused save shows the view's `saveError` text in the card that requested it (`The change could not be saved; the previous settings stay in use.` or the read-only explanation; the wording became neutral in ET-012a because the overlay card shares it); a request that failed before reaching the store shows `The unit change was not saved; the previous units stay in use.` The groups are disabled when the settings cannot be saved. While a read that outlasted the load budget is pending, the card shows `Saved settings are still being read; defaults are in use and changes cannot be saved yet.` with the groups disabled; this is a functional state line rather than a spinner, like the other load states. When the read settles, main pushes the new settings view exactly as after a save, so the card, the dashboard rows and the overlay switch to the file's units without a restart. The dashboard's speed and fuel rows use the profile of the displayed game (`displayProfile` in `unit-profiles.ts`), with each game's default before the first settings push.

The preload bridge appends one method, `setUnitProfile(game, profile)`. The preload accepts only `ets2`/`ats` and `metric`/`us-customary` and forwards exactly those two values over `settings:set-unit-profile`. Main checks the sender and its main frame, validates both values and the argument count again, and resolves with the new settings view only after the save. It then pushes `AppState` (whose `settings` holds the units, the load state, whether saving is possible and the last save error) to a subscribed dashboard, and republishes the overlay projection from main's stored freshness output in the new units. The republication accepts no observation and renews neither the SDK nor the window freshness deadline, so a reading that was about to expire still expires on time and the overlay placement is unchanged. Neither the renderer nor the overlay receives a path, file content or error text.

ET-012a adds the **Overlay** card after the units card and two more bridge methods (decision L3). There is no generic settings patch: each channel accepts one fixed shape.

- `setOverlayLayout(layout)` over `settings:set-overlay-layout`: exactly one argument, one of the four layout ids.
- `setOverlaySections(sections)` over `settings:set-overlay-sections`: exactly one argument, a complete record with exactly the fourteen section ids as own data properties, booleans only, at least one `true`, and a plain object prototype. The preload forwards a fresh copy of the validated record; main validates it again (`parseOverlaySections` in `apps/desktop/src/overlay-sections.ts`) and hands the store a frozen copy.

Both are refused for an untrusted sender or frame (including the overlay), for any other shape, and once the exit has started. They share the unit save's error mapping (fixed messages only) and its refusal reporting in `saveError`. After the durable save main pushes `AppState`, republishes the overlay projection with the new layout and sections from its stored freshness output, and moves the overlay window to the new layout's anchor (see [the minimal overlay](minimal-overlay.md#layouts-and-sections-et-012a)). As for units, this renews neither SDK nor window freshness. A late startup read that brings another layout is applied the same way. The card shows only saved values: the layout radio group, three presets (Everything, Job focus, Driving only, shown as pressed when the saved sections equal them) and one switch per section grouped Driving, Fuel, Job and Time, with a marker for sections that need protocol v1 or trip tracking. Since ET-010c the protocol v1 sections appear once the plugin's v1 data arrives, so the markers read "needs the plugin's protocol v1 data" (origin, distance remaining, deadline), "shows game ids without protocol v1" (cargo, destination) and "needs trip tracking; hidden for now" (distance driven). Controls are disabled while a save runs and when settings cannot be saved; the last enabled section cannot be switched off.


## Start with Windows card (ET-031)

The dashboard's **General** settings panel includes an **Autostart** card with a toggle switch and status badge:
- Displays live status: `Active`, `Disabled`, `Not installed` (in unpackaged/portable mode), or `Failed`.
- In an installed application, toggling updates the Windows login item via `Update.exe --processStart "<exe>" --process-start-args "--hidden"`.
- In an unpackaged or portable environment, the toggle is disabled with an informational note indicating autostart is available after installation.
- Toggling invokes `setAutostart(enabled)` over the bridge and persists the setting atomically.

## Language card (ET-029)

The dashboard includes a standalone **Language** card (Option B, before the full Yukon Union multi-page navigation is introduced) with a radio group for English (`en`) and Russian (`ru`). Changing the language calls `setLanguage(language)` over the bridge, saves format v6 settings to disk, and pushes the updated `language` to both the dashboard renderer and the transparent overlay without restart. The notification area tray model also reflects the chosen language.

## Diagnostics

Startup logs `SETTINGS_LOADED` (`state` `defaults` or `loaded`) or `SETTINGS_FALLBACK` (any other state, with `fields` for fallbacks or a fixed `reason` such as `reparse-point`, `read` or `load-limit`). A v1 or v2 file migrated in memory adds `migratedFrom: 1` or `migratedFrom: 2` to its `SETTINGS_LOADED` or `loaded-with-fallbacks` row. A read that outlasts the 1000 ms budget first logs `SETTINGS_LOAD_PENDING` (`state` `loading`, `reason` `load-budget`); the `SETTINGS_LOADED` or `SETTINGS_FALLBACK` row that follows when it settles, or at the 30 s limit, has the same facts as for a read within the budget. Saves log `SETTINGS_QUARANTINED` and `SETTINGS_SAVED` with `game` and `profile` for a unit save, `overlayLayout` for a layout save, `overlaySections` (the number of enabled sections) for a sections save, or `overlayPlacement` (the layout) and `overlayScale` for a placement save; a position is never logged. With a diagnostic directory, main also records the timeline rows `OVERLAY_EDIT_STARTED`, `OVERLAY_EDIT_FINISHED` (`outcome`) and `OVERLAY_EDIT_CANCELLED` (`reason`). None of these names match the smoke failure pattern `FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE`. A refused newer-version save logs `SETTINGS_SAVE_REFUSED`; a failed save logs `SETTINGS_WRITE_FAILED` with the failing `step` and the error `code`. Facts carry fixed codes only, never paths or file content.

## Tests

- `tests/unit/settings-schema.test.ts`: every load classification, the 64 KiB boundary, the byte order mark and the exact serialized bytes. Since ET-012a: a v2 file, the pure v1-to-v2 migration (units kept, an invalid v1 unit falling back alone, `migratedFrom`, the input not mutated), version 3 as the first newer version, each overlay fallback including a record that enables nothing, and the canonical section order of the v2 bytes and their round trip. Since ET-012b (REG-017): a v3 file with its placements, the pure v2-to-v3 migration (layout and sections kept, default placements, `migratedFrom: 2`, the input not mutated, a stray v2 `placements` key replaced) and the v1-to-v3 chain (`migratedFrom: 1`), each placement fallback (missing or non-object record, a missing layout, `x` or `y` outside [0, 1], a scale outside [0.5, 2], non-numbers) with no clamping, normalisation on read and write, version 4 as the first newer version, and the exact v3 bytes with sections and placements in canonical order and their round trip. The current-format cases moved from v2 to v3 inputs.
- `tests/unit/settings-store.test.ts`, ET-012a cases: a v1 file byte-identical at startup and rewritten (as v3 since ET-012b) with its units by the first overlay save; exact bytes for a sections save, applied only after the rename; a failed overlay save keeping the previous overlay settings; overlay saves refused for a newer-version file and during a pending read; unit and overlay saves serialized in one queue with every change surviving and their facts; and the shared four-request bound. ET-012b cases (REG-017): a v2 file byte-identical at startup with default placements and `migratedFrom: 2`, rewritten as v3 by the first save; a v3 file loaded with its placements and no migration fact; a placement save written as exact v3 bytes, normalised, applied only after the rename, with `overlayPlacement` and `overlayScale` facts; a failed placement save keeping the previous placement; placement saves refused for a newer-version file and during a pending read; and placement saves sharing the queue, the four-request bound and the facts with unit and section saves. The existing cases now expect the default placements in each view and v3 bytes after a save, and the newer-version cases use version 4 (version 3 is now the current format).
- `tests/unit/settings-store.test.ts` (real temporary directories; failures injected by wrapping the real file operations): no write on startup, exact bytes, `sync` before the rename, EPERM/EACCES/EBUSY retry, a persistent EPERM that keeps the previous file and removes the temporary file, failures at write, sync and rename that leave the old file valid, byte-identical quarantine on the first save only, keeping the newest three quarantined files, newer-version untouched and read-only, a junction directory and a symbolic-link file refused, only matching temporary files removed, serialized saves, the four-request bound and the idle hook, the unavailable location and the 1000 ms load budget, a prompt refusal with no idle work after the budget expired over a read that never settles, and `saveError` set by a failed save and cleared by the next one. Since October 15, 2026, with controlled timers and a gated real read (clean late read): the pending `loading` view and its log row; a late corrupt file applied as `invalid-file` and quarantined byte-identically only by a later save (the hosted run 38755116140 regression); late `loaded`, `loaded-with-fallbacks`, `unsupported-older` and `newer-version` files applied with their own writability and nothing written; a save during the pending read refused at once without queuing or quarantine; a late read error staying `unreadable`; a hung read declared `unreadable` at the 30 s limit with its later result ignored; and a save requested before the load returned refused at the limit.
- `tests/unit/unit-profiles.test.ts`, `overlay.test.ts`, `speed-display.test.ts`: profile mapping, both profiles in the overlay and dashboard, and the dashboard's profile choice with the ATS US customary default; the existing overlay and dashboard cases are unchanged, and the one that calls `dashboardSpeed` without a profile is titled for its implicit metric default. A source check keeps conversion constants and `toFixed` out of the desktop display modules.
- `tests/unit/main-boundaries.test.ts`: trusted sender and frame only, invalid values rejected, the change applied only after the save, the overlay republished without renewed authority, refused saves reported in the settings view while a service problem stays the last problem, the exit waiting for an in-flight save within 1000 ms, the first windows opening only after the load returned, and a late read pushed to the dashboard and republished to the overlay in the new units without a save or renewed freshness. `preload-recovery.test.ts` covers the bridge validation. ET-012a adds the two overlay channels to both: trust, argument count and shape validation, the fresh frozen copy handed to the store, apply after the save with republication and re-placement without renewed freshness, the shared error mapping, refusal while exiting, and a late read that changes the layout. ET-012b adds the four overlay edit channels: trust (the overlay is rejected), argument count and shape, refusal while settings are read-only, when not editing and once exiting; the layout channel refused while editing; edit mode interactive only while shown over a background game; a scale applied as the overlay zoom factor and window size; a drag snapped inside the client area; Done handing the store the draft only after edit mode ended and applying it after the save; a failed save keeping the previous placement; Cancel, Esc, dashboard close, reload and crash, overlay reload and crash, and exit discarding the draft without writing; every key prevented on the overlay with Enter saving only in edit mode; the system menu prevented; the 150 ms focus grace across the dashboard and the overlay; `waiting-for-game` without a game window; and the overlay created at its saved scale with that zoom re-applied after each load. `preload-recovery.test.ts` checks the four appended methods and their validation.
- The development and packaged `lifecycle` runtime smokes seed an invalid file and check quarantine, exact content (v3 since ET-012b), mph and US gallons, and the restart; a pending read is waited for before the exact checks. Since ET-012b run B also checks the restored default placements (run A saves only the units), driving mode after the restart and the overlay zoom factor of the saved scale (1); a non-default placement's restore is covered by unit tests. See [CI](ci.md#et-011b-settings-in-the-lifecycle-smoke). The overlay smoke saves the `card` layout and waits for the overlay document to render it, then enters edit mode, saves the card at scale 1.5 and checks the overlay and dashboard zoom factors (see [CI](ci.md#overlay-edit-step-et-012b)).

Evidence and pending manual checks are in [ET-011 validation](validation/et-011.md#et-011b-persistent-settings-and-unit-profiles), [ET-012a validation](validation/et-012a.md) and [ET-012b validation](validation/et-012b.md).

## Saved overlay visibility (ET-012e)

Settings → Overlay has the labelled keyboard-operable **Show overlay** switch (**Показывать оверлей** in Russian). It displays only the committed value. The narrow dashboard-main-frame IPC `settings:set-overlay-enabled` accepts exactly one boolean through `DesktopBridge.setOverlayEnabled`; the overlay renderer cannot call it. It shares the existing four-request durable settings queue and atomic rename. A refused or failed write leaves visibility and any active edit draft unchanged. Successful saves log only `overlayEnabled`, without coordinates or file content.

A successful off save gates visibility before hiding and cancelling edit mode, discarding unsaved position/scale and restoring click-through behavior. Edit cannot begin while disabled. Enabling happens after committed geometry is installed and keeps all existing source, freshness, foreground, minimization, topology and fit gates. It renews no telemetry or window observation. Late completions after exit cannot show a retired overlay. Telemetry keeps updating; visibility does not control recording eligibility, which remains disabled for game history.

While the startup read is still `loading`, the overlay remains hidden even though the pending settings view carries the enabled default. A completed read applies its saved value and final geometry. Once the read limit reports `unreadable`, the existing default-true fallback applies; the loading gate does not change corruption or read-limit policy.

The first save writes canonical v6 (v7 since ET-049, v8 since ET-045e); v1–v5 (v1–v7 since ET-045e) load without startup writes. Missing or invalid current-format visibility falls back independently to true with `overlay.enabled`. Older applications treat v6 as newer-version and refuse writes rather than erase visibility. Historical fixture files remain unchanged. See [ET-012e evidence and pending manual checks](validation/et-012e.md).

### Startup autostart authority

The main-only store getter distinguishes a confirmed initial autostart choice from display defaults. A positively missing file/directory supplies false; parsed settings supply their current committed choice, including a migration or unrelated field fallback. A fallback of autostart itself, invalid/unsupported/newer files, unavailable/read-error/reparse outcomes, pending reads and the read limit supply no intent. Generic saves never promote an unknown initial load. A read retired at 30 seconds cannot restore authority later.

Startup queries actual registration while intent is unknown and never writes login registration from provisional defaults. A late load may reconcile once; it supersedes older target discovery. Ordinary save publications do not restart this startup operation. A valid trusted explicit autostart request retires startup before awaiting discovery, even if its durable save fails; invalid/untrusted requests do not. Exit retires pending discovery and prevents OS mutation after a durable save. Explicit successful writes apply the current committed choice, preserving shared-queue ordering.

## Unified Overlay page (ET-048)

Settings > Overlay contains one mounted card for visibility, layout, position/size, presets and the fourteen grouped section switches. The separate Overlay sections destination and Choose sections action are removed. ET-049 replaces the former Planned opacity text with the persisted slider described above. Ordinary page scrolling and wrapping keep the lower controls reachable, including keyboard focus at renderer zoom.

Owner follow-up, October 24, 2026: individual section rows show their label, icon and switch without the parenthetical protocol-v1, game-ID or trip-tracking notes. This presentation change applies to EN/RU; availability rules and the general unavailable/stale explanation remain unchanged.

Navigation and rendering do not save settings. Each selection still shows only after the existing committed save; errors remain in the requesting card. Layout is locked during a position edit, while presets and sections keep their existing availability and final-section guard. Scale/reset affect main's draft only; Cancel writes nothing and Done persists through the existing handler. A committed visibility-off save cancels the draft; failure preserves it. Read-only behavior, settings v6, migrations, durability, IPC and ET-045 geometry/typography corrections are unchanged. See [ET-048 validation](validation/et-048.md) for evidence and manual limits.


ET-049 observer-budget history and its preserved failure are recorded once in [the validation report](validation/et-049.md). The existing UI shards retain all behavioral branches, screenshots and Job limits.
