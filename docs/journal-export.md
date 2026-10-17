# Trip export format

ET-016 PR-5 exports one recorded trip as a JSON file, `ets2telemetry.trip-export` format version 1, through a Save dialog that main owns. The export is a copy for the user's own records. The application never imports or restores it. Decisions J15–J18 are in [concept.md](../concept.md#et-016-authorization--october-16-2026); the reads it is made from are the [journal reads](journal.md).

Status (October 17, 2026): the format, the save flow and the Export button are implemented and tested with synthetic databases only. `GAME_HISTORY_RECORDING` stays `false`, so no real game trip can be exported yet. The Windows Save dialog itself (overwrite prompt, cancel by Esc and by the close box, OneDrive Documents, long paths, a read-only folder) remains a pending manual check.

## Saving a trip (J16, J17)

The trip detail in the Journal tab has an **Export JSON** button. Next to it the tab states that an uninstall removes the local trip history and that the JSON export is a copy that cannot be imported (J18; the owner's [uninstall rule](../concept.md#uninstall-removes-local-data--october-16-2026)).

The button calls the sixth bridge method, `exportJournalTrip(tripUuid)`, on the fixed channel `journal:export-trip`. The preload forwards only a valid lower-case trip UUID; main checks it again, accepts only the trusted dashboard main frame and runs one export at a time. Main then:

1. Reads the trip detail through the [journal broker](journal.md#routing-and-bounds-j4). The detail fixes the export's bounds (below) and the default file name.
2. Reads the open database's purpose, schema version and UUID for the header (the `database` query, below).
3. Opens the Save dialog on the dashboard window with the default path `<Documents>\ets2telemetry-trip-<game>-<YYYYMMDD-HHmm>-<uuid8>.json` and the single filter `JSON (*.json)`. The time is the trip's start label in UTC, so the name does not depend on the computer's time zone. A cancelled dialog answers `{outcome: 'cancelled'}`; nothing is opened, created or written.
4. Refuses a target that is not a drive or UNC path, a `\\?\`, `\\.\` or `\??\` device path, a path with a DOS device name (`CON`, `NUL`, `COM1`, …) in any component, or any path inside `%LOCALAPPDATA%\ETS2Telemetry\`. The check resolves the path, drops the trailing dots and spaces Windows ignores and compares without case. It is repeated on the chosen folder as Windows resolves it (`realpath`), so a junction or a short name into the data folder is refused too. Without a usable LOCALAPPDATA every target is refused.
5. Creates `<name>.<8 hex digits>.partial` beside the target with the `wx` flag, writes the document page by page through the journal reads (completeness intervals and events 500 per page, samples 3,600 per page), syncs and closes it, and renames it over the target. A rename that Windows refuses with `EPERM`, `EACCES` or `EBUSY` is retried after 20, 40, 60, 80 and 100 ms, as settings saves are.
6. On any failure, and when the application exits, it closes and removes the partial file; an existing target stays unchanged. A partial file it did not create is never removed.

The whole document is never held in memory: main holds the detail and one page at a time.

**Exit.** An exit stops the export at its next step: a read that the exit's broker retirement answers, a page write or a rename attempt. The export answers `EXPORT_INTERRUPTED`, and the exit's bounded idle hook (1,000 ms together with a pending settings save) waits for the partial file's removal. An exit while the dialog is open writes nothing and does not wait for the dialog.

**Results.** A valid call never rejects. It resolves `{ok: true, value: {outcome: 'saved', events, intervals, samples}}`, `{ok: true, value: {outcome: 'cancelled'}}` or `{ok: false, code}`. The codes are the [journal codes](journal.md#ipc-methods-and-codes-j10-j11) of a refused read (`DATABASE_UNAVAILABLE` with its `storageCode`) and four export codes:

| Code | Meaning |
| --- | --- |
| `EXPORT_TARGET_REFUSED` | The chosen file lies in the data folder or is a device path |
| `EXPORT_WRITE_FAILED` | The file could not be created, written, synced or renamed; a file that already had the name is unchanged |
| `EXPORT_IN_PROGRESS` | Another export is running |
| `EXPORT_INTERRUPTED` | The application exited during the export |

`FAILED` also covers a page that names another database than the detail or a timeline of another plugin session. The renderer shows a fixed sentence per code and never receives a path or error text. Main logs fixed codes only: `JOURNAL_EXPORT_SAVED {events, samples}`, `JOURNAL_EXPORT_CANCELLED` and `JOURNAL_EXPORT_FAILED {code}`; a write failure adds the fixed `step` (`target`, `open`, `write`, `sync`, `close`, `rename`) and the system error code (`errno`, such as `EACCES`).

**The `database` query.** The header names the database UUID (J15), which no journal read returns. Main sends the service `{kind: 'database'}` on the existing journal routing; the service answers `{database: {purpose, schemaVersion}, databaseUuid}` from the summary its storage worker returned when it opened the database, without a storage command. The renderer has no channel for this query. The session origin needs no read: a database accepts exactly one plugin-session origin, fixed by its purpose (`history` → `game`, `synthetic` → `synthetic`, `replay` → `replay`; schema trigger `plugin_sessions_origin`).

## Bounds and snapshots (J17)

The trip detail read at the start of an export fixes three bounds: the trip session's committed coverage (`committedThroughEventSeq`), the trip's largest sample id and its largest completeness interval id. Each section's pages stop at its bound, and rows past it are left out: an event, interval or sample committed after the detail read is not in the file, even when it belongs to the trip. A section whose bound is null (no samples or intervals at the read) is not read at all.

`bounds.snapshot` is `true` when the trip was still open (`trip.outcome` `open`) at the detail read. Such an export is a consistent snapshot of what was recorded up to its bounds; a later export of the same trip can contain more. A closed trip's export is not a snapshot, but its bounds are still recorded.

## Format version 1

The document is one JSON object with these keys, in this order. Each row of `intervals`, `events` and `samples` is on its own line.

| Key | Content |
| --- | --- |
| `format` | `"ets2telemetry.trip-export"` |
| `formatVersion` | `1` |
| `header` | `application {name: "ETS2Telemetry", version}`; `exportedUtcMs`, the UTC label of the export (never monotonic time); `database {uuid, purpose, schemaVersion}`, the database the trip was read from; `sessionOrigin`, `game` for history or `synthetic`/`replay` for a test database, which is never game history (J3) |
| `units` | The canonical units below, as fixed text |
| `bounds` | `{committedThroughEventSeq, lastSampleId, lastIntervalId, snapshot}` (above) |
| `trip` | The stored trip: `tripUuid`, `pluginSessionId`, `game`, `gameMode {mode, method, confidence}`, `gameModeAmbiguous`, `outcome`, `closeReason`, `recordingCompleteness`, `startedUtcMs`, `endedUtcMs`, `observedDistanceM`, `fuelUsedL`, `openedBy` (`event` or `checkpoint`), `openedEventSeq`, `outcomeEventSeq` and `closedBy {pluginSessionId, eventSeq}` (null while open and for trips closed under schema version 1). Outcome and recording completeness are separate; neither is inferred from the other |
| `job` | `{source, eventSeq, checkpointNextEventSeq, values}`: the job values in the protocol v1 `job.configured` shape, from its event (`source: "event"`) or a checkpoint (`source: "checkpoint"`) |
| `truck` | `{eventSeq, values}` of the trip's truck configuration, or null when none was recorded (J22) |
| `trailers` | `{items, total}`: the latest 10 trailer configurations in commit order and the trip's total, as in the detail; earlier ones appear as `trailer.configured` events when they lie inside the window |
| `outcomeDetails` | `{eventSeq, record}` with the `job.delivered` (revenue, XP, damage, delivered distance, duration) or `job.cancelled` (penalty) record, or null |
| `money` | `{incomplete, totals, unavailable}`: exact per-currency totals of the attributed fines, tolls, ferries and trains, as in the [journal detail](journal.md#read-commands-and-bounds-j5) |
| `window` | The timeline window (J7): `{known: true, pluginSessionId, fromEventSeq, throughEventSeq, end}` or `{known: false, pluginSessionId}` |
| `intervals` | The trip's completeness intervals up to `lastIntervalId`, in insertion order: `id`, `kind`, `annotation`, `cause`, UTC labels, monotonic bounds with `sourceClockId`, eventSeq bounds and the stored `detail` record |
| `events` | The window's events up to `committedThroughEventSeq`, in eventSeq order: `eventSeq`, `type`, `occurred` (the protocol v1 occurrence), `record` and `attribution` (`{kind, tripUuid}` or null) |
| `samples` | The trip's one-second samples up to `lastSampleId`, in id order: `id`, `utcMs`, `sourceClockId`, `monotonicNs`, `gameTime`, `speed`, `fuel`, `averageConsumption`, `estimatedRange`, `engineRpm`, `gear`, `odometer` and `position` |

**Stable identifiers.** `tripUuid`, `pluginSessionId`, eventSeq (unique within its plugin session), sample and interval ids (row ids of this database, increasing) and `header.database.uuid` identify the records. Row ids are only unique within one database; the database UUID tells databases apart. Integers that can exceed 2^53 (eventSeq, monotonic nanoseconds, game minutes of an occurrence, money) are decimal text.

**Units.** Numbers are in canonical units and never converted for display:

| `units` key | Text |
| --- | --- |
| `distance` | `m` |
| `speed` | `m/s` |
| `fuel` | `L` |
| `averageConsumption` | `L/100 km (the SDK mean, not a trip average)` |
| `mass` | `kg` |
| `engineSpeed` | `rpm` |
| `gear` | `gear index (0 neutral, negative reverse)` |
| `cargoDamage` | `fraction (0 to 1)` |
| `position` | `m (game-world coordinates, not latitude or longitude)` |
| `gameTime` | `min (game minutes of the game clock named by clockId)` |
| `monotonicTime` | `ns (the source clock named by its clock id)` |
| `utcLabel` | `ms since the Unix epoch (a label, not monotonic time)` |
| `money` | `exact decimal text in the SDK type; currency as documented by the SDK header or unknown, never converted` |

A measure inside a protocol v1 record also carries its own `unit`. The trip's observed distance and fuel used name their unit in the field (`observedDistanceM`, `fuelUsedL`). There is no trip average consumption (J21).

**Availability.** Every SDK value keeps the protocol v1 shape: `{available: true, value}` or `{available: false, reason}` with `not-observed`, `not-supported` or `invalid`, plus `unit` for a measure. Zero, `false` and an empty name are values; an unavailable value is never written as zero.

**Money.** A money value is `{raw, sdkType, currency}`: `raw` is the exact decimal text of the SDK value (`s64` or `u64`), and `currency` is `{status: "sdk-documented", code, source}`, which names the currency the SDK header documents for the game (not observed at runtime), or `{status: "unknown"}`. A total's `raw` is the exact BigInt sum and can exceed the SDK type's range. Amounts are never converted, netted or added across currencies, and expected income (job offer), revenue and penalty (outcome) stay separate.

## Example

A delivered ETS2 trip of a synthetic test database with one toll, no truck, trailer or interval and one sample. Every value is written by hand; `tests/unit/journal-export.test.ts` parses this block and checks it with the shared validator.

```json
{
"format": "ets2telemetry.trip-export",
"formatVersion": 1,
"header": {"application": {"name": "ETS2Telemetry", "version": "0.1.0"}, "exportedUtcMs": 1791680400000, "database": {"uuid": "f0000000-0000-4000-8000-000000000001", "purpose": "synthetic", "schemaVersion": 2}, "sessionOrigin": "synthetic"},
"units": {"distance": "m", "speed": "m/s", "fuel": "L", "averageConsumption": "L/100 km (the SDK mean, not a trip average)", "mass": "kg", "engineSpeed": "rpm", "gear": "gear index (0 neutral, negative reverse)", "cargoDamage": "fraction (0 to 1)", "position": "m (game-world coordinates, not latitude or longitude)", "gameTime": "min (game minutes of the game clock named by clockId)", "monotonicTime": "ns (the source clock named by its clock id)", "utcLabel": "ms since the Unix epoch (a label, not monotonic time)", "money": "exact decimal text in the SDK type; currency as documented by the SDK header or unknown, never converted"},
"bounds": {"committedThroughEventSeq": "3", "lastSampleId": "1", "lastIntervalId": null, "snapshot": false},
"trip": {"tripUuid": "7a000000-0000-4000-8000-000000000001", "pluginSessionId": "10000000-0000-4000-8000-000000000001", "game": "ets2", "gameMode": {"mode": "single-player", "method": "module-scan", "confidence": "weak"}, "gameModeAmbiguous": false, "outcome": "delivered", "closeReason": "outcome", "recordingCompleteness": "complete", "startedUtcMs": 1791676800000, "endedUtcMs": 1791676802000, "observedDistanceM": {"available": true, "value": 1500.5}, "fuelUsedL": {"available": false, "reason": "not-observed"}, "openedBy": "event", "openedEventSeq": "1", "outcomeEventSeq": "3", "closedBy": {"pluginSessionId": "10000000-0000-4000-8000-000000000001", "eventSeq": "3"}},
"job": {"source": "event", "eventSeq": "1", "checkpointNextEventSeq": null, "values": {"sourceCityId": {"available": true, "value": "synthetic_city_a"}, "sourceCity": {"available": true, "value": "Synthetic City A"}, "sourceCompanyId": {"available": true, "value": "synthetic_company_a"}, "sourceCompany": {"available": true, "value": "Synthetic Company A"}, "destinationCityId": {"available": true, "value": "synthetic_city_b"}, "destinationCity": {"available": true, "value": "Synthetic City B"}, "destinationCompanyId": {"available": true, "value": "synthetic_company_b"}, "destinationCompany": {"available": true, "value": "Synthetic Company B"}, "cargoId": {"available": true, "value": "synthetic_cargo"}, "cargo": {"available": true, "value": "Synthetic Cargo"}, "cargoMass": {"available": true, "value": 18000, "unit": "kg"}, "cargoUnitMass": {"available": true, "value": 1000, "unit": "kg"}, "cargoUnitCount": {"available": true, "value": 18}, "market": {"available": true, "value": "freight_market"}, "isSpecialJob": {"available": true, "value": false}, "cargoLoaded": {"available": true, "value": true}, "plannedDistance": {"available": true, "value": 152000, "unit": "m"}, "expectedIncome": {"available": true, "value": {"raw": "12345", "sdkType": "u64", "currency": {"status": "unknown"}}}, "deliveryDeadline": {"available": true, "value": "13000", "unit": "min"}}},
"truck": null,
"trailers": {"items": [], "total": 0},
"outcomeDetails": {"eventSeq": "3", "record": {"type": "job.delivered", "revenue": {"available": true, "value": {"raw": "15000", "sdkType": "s64", "currency": {"status": "sdk-documented", "code": "EUR", "source": "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units"}}}, "earnedXp": {"available": true, "value": 0}, "cargoDamage": {"available": true, "value": 0.0125, "unit": "fraction"}, "distance": {"available": true, "value": 1500.5, "unit": "m"}, "deliveryDuration": {"available": false, "reason": "not-observed", "unit": "min"}, "autoParkUsed": {"available": true, "value": false}, "autoLoadUsed": {"available": true, "value": true}}},
"money": {"incomplete": false, "totals": [{"category": "toll", "sdkType": "s64", "currency": {"status": "sdk-documented", "code": "EUR", "source": "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units"}, "raw": "35", "count": 1}], "unavailable": []},
"window": {"known": true, "pluginSessionId": "10000000-0000-4000-8000-000000000001", "fromEventSeq": "1", "throughEventSeq": "3", "end": "close-event"},
"intervals": [],
"events": [
{"eventSeq": "1", "type": "job.configured", "occurred": {"monotonicNs": {"available": true, "value": "1000149000000"}, "gameTime": {"minutes": {"available": true, "value": "12345"}, "clockId": "40000000-0000-4000-8000-000000000001"}, "utcUnixMs": {"available": true, "value": "1791676800000"}, "simulation": "running", "configurationRevision": "8", "boundaryOrder": "101"}, "record": {"type": "job.configured", "sourceCityId": {"available": true, "value": "synthetic_city_a"}, "sourceCity": {"available": true, "value": "Synthetic City A"}, "sourceCompanyId": {"available": true, "value": "synthetic_company_a"}, "sourceCompany": {"available": true, "value": "Synthetic Company A"}, "destinationCityId": {"available": true, "value": "synthetic_city_b"}, "destinationCity": {"available": true, "value": "Synthetic City B"}, "destinationCompanyId": {"available": true, "value": "synthetic_company_b"}, "destinationCompany": {"available": true, "value": "Synthetic Company B"}, "cargoId": {"available": true, "value": "synthetic_cargo"}, "cargo": {"available": true, "value": "Synthetic Cargo"}, "cargoMass": {"available": true, "value": 18000, "unit": "kg"}, "cargoUnitMass": {"available": true, "value": 1000, "unit": "kg"}, "cargoUnitCount": {"available": true, "value": 18}, "market": {"available": true, "value": "freight_market"}, "isSpecialJob": {"available": true, "value": false}, "cargoLoaded": {"available": true, "value": true}, "plannedDistance": {"available": true, "value": 152000, "unit": "m"}, "expectedIncome": {"available": true, "value": {"raw": "12345", "sdkType": "u64", "currency": {"status": "unknown"}}}, "deliveryDeadline": {"available": true, "value": "13000", "unit": "min"}}, "attribution": null},
{"eventSeq": "2", "type": "player.tollgate.paid", "occurred": {"monotonicNs": {"available": true, "value": "1000150000000"}, "gameTime": {"minutes": {"available": true, "value": "12346"}, "clockId": "40000000-0000-4000-8000-000000000001"}, "utcUnixMs": {"available": true, "value": "1791676801000"}, "simulation": "running", "configurationRevision": "8", "boundaryOrder": "102"}, "record": {"type": "player.tollgate.paid", "amount": {"available": true, "value": {"raw": "35", "sdkType": "s64", "currency": {"status": "sdk-documented", "code": "EUR", "source": "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units"}}}}, "attribution": {"kind": "trip", "tripUuid": "7a000000-0000-4000-8000-000000000001"}},
{"eventSeq": "3", "type": "job.delivered", "occurred": {"monotonicNs": {"available": true, "value": "1000151000000"}, "gameTime": {"minutes": {"available": true, "value": "12347"}, "clockId": "40000000-0000-4000-8000-000000000001"}, "utcUnixMs": {"available": true, "value": "1791676802000"}, "simulation": "running", "configurationRevision": "8", "boundaryOrder": "103"}, "record": {"type": "job.delivered", "revenue": {"available": true, "value": {"raw": "15000", "sdkType": "s64", "currency": {"status": "sdk-documented", "code": "EUR", "source": "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units"}}}, "earnedXp": {"available": true, "value": 0}, "cargoDamage": {"available": true, "value": 0.0125, "unit": "fraction"}, "distance": {"available": true, "value": 1500.5, "unit": "m"}, "deliveryDuration": {"available": false, "reason": "not-observed", "unit": "min"}, "autoParkUsed": {"available": true, "value": false}, "autoLoadUsed": {"available": true, "value": true}}, "attribution": {"kind": "trip", "tripUuid": "7a000000-0000-4000-8000-000000000001"}}
],
"samples": [
{"id": "1", "utcMs": 1791676801500, "sourceClockId": "30000000-0000-4000-8000-000000000001", "monotonicNs": "1000150500000", "gameTime": {"minutes": {"available": true, "value": 12346}, "clockId": "40000000-0000-4000-8000-000000000001"}, "speed": {"available": true, "value": 0}, "fuel": {"available": true, "value": 410.5}, "averageConsumption": {"available": true, "value": 32.5}, "estimatedRange": {"available": false, "reason": "not-supported"}, "engineRpm": {"available": true, "value": 650}, "gear": {"available": true, "value": 0}, "odometer": {"available": true, "value": 1234590}, "position": {"available": true, "value": {"x": -31212.25, "y": 42.5, "z": 18801.5}}}
]
}
```

## Versioning and no import

Any change to the document — a key added, removed, renamed or moved, a shape or unit changed — bumps `formatVersion`. Version 1 is fixed by `packages/contracts/src/journal-export.ts`, [journal-export.ts](../apps/desktop/src/journal-export.ts) and the hand-written checks of `tests/shared/trip-export-validator.ts`. The application has no import or restore: an export is a copy for the user's records, and the journal reads only the database the telemetry service opened.

## Tests and pending checks

`tests/unit/journal-export.test.ts` compares an anchor export with a hand-written document, keeps money beyond 2^53 as text and checks the bounds; `tests/unit/journal-export-writer.test.ts` runs the save flow against real temporary folders (cancel, failures in the middle of a page, replacement, refused targets including a junction, one export at a time, exit); `tests/unit/main-boundaries.test.ts` covers the channel's trust and argument checks, the dialog's window and default path and the exit; `tests/storage/journal-export.test.ts` exports through the real storage worker and reconciles each file with independent SQL; the development and packaged `journal` smokes save, cancel and refuse through the rendered tab ([ci](ci.md#et-016-trip-journal-smoke)). See [TESTING.md](../TESTING.md#et-016-trip-journal--october-16-2026).

Pending: the real Windows Save dialog (overwrite prompt, Esc and the close box, OneDrive Documents, long paths, a read-only folder), exports of real recorded game history after enablement, and export timings of large real trips.
