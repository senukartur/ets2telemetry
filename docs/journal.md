# Trip journal

ET-016 adds the trip journal: a list of recorded trips, a detail view of one trip and a versioned JSON export. This document describes where the journal reads its data, the read commands and their bounds, and the timeline window of a trip. Decisions J1–J22 are in [concept.md](../concept.md#et-016-authorization--october-16-2026); the schema they read is [storage schema version 2](storage.md#schema-version-2-et-016).

Status (October 16, 2026): ET-016a PR-2 implements the storage reads in the storage worker and their tests. PR-3 routes them from the dashboard through main to the telemetry service with five bridge methods ([IPC methods and codes](#ipc-methods-and-codes-j10-j11)). PR-4 adds the [Journal tab](#the-journal-tab-j12j14) to the main window, which reads through those methods. The parts below marked **pending** belong to later PRs, such as the JSON export (PR-5). `GAME_HISTORY_RECORDING` stays `false`, so no real game history exists to show.

## Data source and purposes (J2, J3)

The journal reads the database that the telemetry service opened, through the service's [storage worker](storage.md#storage-worker) and its `StorageClient`. There is no second connection: the writer holds an exclusive lock ([OD-8](storage.md#durability)), and only the storage worker loads SQLite.

- In production that database is the history database (`%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, purpose `history`).
- With `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` it is that synthetic or replay [recording target](storage.md#history-database-in-the-telemetry-service) instead. There is no journal-specific variable or file picker.
- Every journal response carries `database: {purpose, schemaVersion}`. A purpose other than `history` is a test database that is never game history; the Journal tab shows a persistent banner for it, and the export header carries the purpose (pending, PR-5).
- Tests and smokes seed only temporary or isolated synthetic databases, never history.

Journal reads share the recorder's single command lane in the storage client: one command in flight, at most 64 queued, 10 s per command. A read that missed that deadline would fail the client closed and stop recording for the service lifetime, so every read is bounded, uses an index or a primary key ([below](#query-plans)), and the service sends at most one journal command at a time ([routing](#routing-and-bounds-j4)).

## Read commands and bounds (J5)

The contract is [packages/contracts/src/journal.ts](../packages/contracts/src/journal.ts); the queries are in [packages/storage/src/sqlite/journal.ts](../packages/storage/src/sqlite/journal.ts).

| Command | Arguments | Result |
| --- | --- | --- |
| `journalTrips(query?)` | `{cursor?, game?, outcome?, completeness?}` | 50 trips per page, newest first (`id < cursor ORDER BY id DESC`). The filters (`ets2`/`ats`; `open`/`delivered`/`cancelled`/`none`; `complete`/`partial`/`unknown`) are part of the SQL `WHERE` clause, so they apply before the limit and a full page always carries `nextCursor`. The page size is fixed; a `limit` is refused |
| `journalTrip(tripUuid)` | a trip UUID | The trip's detail (below), or `UNKNOWN_TRIP` |
| `journalEvents(tripUuid, page)` | `{cursor?, limit}`, `limit` 100 (UI) or 500 (export) | One page of the trip's timeline in eventSeq order, with the window |
| `journalIntervals(tripUuid, page)` | `{cursor?, limit}`, `limit` 100 (UI) or 500 (export) | One page of the trip's completeness intervals in insertion order, with the trip's total |
| `listSamples({tripUuid}, {afterId?, limit})` | the existing sample read; the journal uses `limit` 300 (UI) or 3,600 (export) | One page of the trip's one-second samples |

**Cursors** are opaque to callers but have a fixed format, checked on both sides of the worker boundary: a trip or interval cursor is the decimal row id of the last row read (`^[1-9][0-9]{0,18}$`, at most 2^63 − 1); an event cursor is the canonical eventSeq of the last event read (`^[1-9][0-9]{0,19}$`, at most 2^64 − 2). A page shorter than its limit has `nextCursor: null`.

**Strict arguments.** The worker's request parser accepts a journal command only with exactly its listed fields: a lower-case UUID, a query of only the listed filters with listed values, a `limit` from the read's allowed set and a cursor of the read's format. The storage core checks the same rules again in process. Anything else is `INVALID_INPUT`; an unknown trip is `UNKNOWN_TRIP`. `StorageClient` copies queries and pages field by field and validates every answer against the contract and the requested page size. A well-framed answer that breaks them resolves only that command with `JOURNAL_ANSWER_INVALID` and leaves the client and the recorder running; a malformed frame still fails the client closed ([storage](storage.md#storage-worker), review pass 1).

**Every list is bounded twice.** Each list in a journal answer is limited in its SQL statement, and the contract allows exactly that bound, so a stored history cannot produce an answer the client refuses: trips 50 per page; events and intervals the requested 100 or 500; the detail's first 50 intervals; the detail's latest 10 trailer configurations with their `total` (a trip keeps every trailer configuration it was given, for example after a trailer is re-sent or changed); and money totals and unavailable counts, which each stand for at least one of at most 5,000 amounts. An event carries at most one attribution (its key is the event), and the job, truck and outcome are single rows. A page has a next cursor exactly when it is full.

**Contract versus schema.** The contract accepts every value the schema can hold for the fields it reads directly: interval eventSeq bounds and the window start are any 20-digit key (including 0 for an interval bound and 2^64 − 1 for a checkpoint's nextEventSeq), and game mode includes the reserved `convoy`. Some checks remain stricter than the schema: job, truck and trailer values, event records and occurrences are checked with the protocol v1 validator, whose identifier and name byte limits and occurrence rules the schema does not repeat (its text columns have no length limit, and the currency source is limited to 128 characters, not bytes). Those values reach storage only from validated protocol v1 messages, and a violation now fails only that read with `JOURNAL_ANSWER_INVALID`.

**The trip detail** (`JournalTripDetail`) holds:

- the list fields (game, game-mode evidence, outcome, close reason, recording completeness, UTC labels, observed distance, fuel used, a job summary), the plugin session, how the trip opened (`openedBy` `event` with its `openedEventSeq`, or `checkpoint` with `openedEventSeq` null), the outcome eventSeq, and the close carrier (`closedBy`, null while open and for trips closed under schema version 1);
- the job values in canonical units from the normalized job row, with its source (`event` with its eventSeq, or `checkpoint` with the checkpoint's nextEventSeq);
- the truck and the latest 10 trailer configurations in commit order (not eventSeq order: a later plugin session's eventSeqs start at 1 again) from their configuration events, with the trip's trailer total, and the gameplay outcome record (`job.delivered` with its revenue or `job.cancelled` with its penalty);
- money totals (below), the timeline window (below), the first 50 completeness intervals with the trip's total and the next cursor;
- the trip's sample count with the UTC labels of its first and last sample;
- the export bounds fixed at this read (J17): the trip session's committed coverage and the trip's largest sample and interval ids.

**Values.** Every SDK value keeps the protocol v1 availability shape: an unavailable value is `{available: false, reason}` with `not-observed`, `not-supported` or `invalid`, and zero is a value. Measures inside the job, truck, trailer and outcome records keep their protocol v1 `unit` field (`m`, `kg`, `L` for the truck's fuel capacity, `min`, `fraction`). The trip's own observed distance and fuel used carry their unit in the field name instead (`observedDistanceM`, `fuelUsedL`), and money totals are exact decimal text. Nothing is converted for display here. Planned distance (the job offer), observed distance (odometer while recording) and the delivered distance of the outcome record are separate fields, and so are expected income (the job offer) and revenue or penalty (the outcome).

**Money totals.** Fines, tolls, ferry and train amounts of the events attributed to the trip (`trip` or `trip-before-loaded`) are summed exactly with BigInt per category, SDK type and currency basis (`sdk-documented` with its code and source, or `unknown`); the sum is decimal text and may exceed the SDK type's range. Amounts are never netted, converted or summed across currencies, and revenue and penalty are not part of the totals. Unavailable amounts are counted by reason instead of being summed. At most 5,000 amounts are read; with more, `incomplete` is `true` and both lists are empty, so a partial sum is never reported as a total.

## Timeline window (J7)

A trip's timeline lists events of the trip's own plugin session in eventSeq order. The window starts at the earlier of the trip's opening event and its job configuration (the `job.configured` event, or the checkpoint's nextEventSeq) and ends at the trip's close carrier, which storage records in the `trip.close` transaction ([schema version 2](storage.md#schema-version-2-et-016)):

| Trip | Window end | `end` |
| --- | --- | --- |
| Open | none | `open` |
| Closed by an event of its own session (an outcome, a different job, a discontinuity, a reload decision) | through that event, inclusive | `close-event` |
| Closed by a gap of its own session | just before the first eventSeq the gap newly covered | `close-gap` |
| Closed from another plugin session (a restart) | the end of the trip's session | `end-of-session` |
| Closed under schema version 1 (no carrier) | unknown: the timeline lists only the events of its session attributed to it or referenced by it (its job, truck and trailer configurations, its opening and its outcome) | `known: false` |

**Checkpoint-opened trips.** Since ET-016b PR-7 a [late-attach trip](trips.md#late-attach-trips-j9) opens from a checkpoint (`opened_by` `checkpoint`, `opened_event_ref` NULL), written by [`openAttachedTrip`](storage.md#late-attach-trips-et-016b-pr-7). The list shows it like any trip, the detail has `openedBy: 'checkpoint'`, `openedEventSeq: null` and a `checkpoint` job with its nextEventSeq, and the window starts at that nextEventSeq, after the events replayed before the checkpoint, and ends by the rules above. `tests/storage/journal-reads.test.ts` checks a trip inserted directly and a trip written by `openAttachedTrip` and closed by its delivery (window from nextEventSeq through the delivery); `getTrip` and `listTrips` read such a trip too (`TripRecord.openedBy`, `jobSource`, `checkpointJob`).

An event row at the carrier's eventSeq marks an event close; otherwise a gap closed the trip. Every event carries its stored record, its occurrence and its attribution (`trip`, `trip-before-loaded`, `free-driving`, `ambiguous` with the attributed trip, or none), so an event of the window that belongs to another trip or to no trip is still shown as such. Events of other plugin sessions are never listed.

## Query plans

No index was added for the journal (J6). Every statement is a constant of `JOURNAL_QUERIES`, and `tests/storage/journal-scale.test.ts` runs `EXPLAIN QUERY PLAN` on each against a database of 1,008 trips and 360,657 samples: each uses a primary key, the events `UNIQUE (plugin_session_id, event_seq)` index, `event_attributions_trip`, `completeness_intervals_trip`, `samples_trip` or the `trip_trailers` primary key, and no plan scans `events` or `samples`. The trip page walks the trips primary key backwards from the cursor; the unknown-window timeline looks each referenced event up by its primary key. The plans and timings are listed in [storage](storage.md#journal-reads-et-016).

## IPC methods and codes (J10, J11)

ET-016 PR-3 adds five methods to the dashboard's preload bridge, after `finishOverlayEdit`, each on its own fixed invoke channel. The sixth, `exportJournalTrip`, follows with the export in PR-5.

| Bridge method | Channel | Arguments the preload forwards | Page main fixes | Value |
| --- | --- | --- | --- | --- |
| `listJournalTrips(query?)` | `journal:list-trips` | one fresh copy of `{cursor?, game?, outcome?, completeness?}` | 50 trips (the storage read's fixed page) | `JournalTripPage` |
| `getJournalTrip(tripUuid)` | `journal:get-trip` | the UUID | — | `JournalTripDetail` |
| `listJournalEvents(tripUuid, cursor?)` | `journal:list-events` | the UUID and the event cursor, or `null` | 100 events | `JournalEventPage` |
| `listJournalIntervals(tripUuid, cursor?)` | `journal:list-intervals` | the UUID and the interval cursor, or `null` | 100 intervals | `JournalIntervalPage` |
| `listJournalSamples(tripUuid, cursor?)` | `journal:list-samples` | the UUID and the sample cursor, or `null` | 300 samples | `JournalSamplePage`: `{database, samples, nextCursor}`, where a full page's cursor is its last sample id |

**Arguments.** The preload checks every argument before it invokes, with the same rules as the storage worker: a lower-case UUID, a cursor of the read's format (a trip, interval or sample cursor is a row id up to 2^63 − 1; an event cursor an eventSeq up to 2^64 − 2), and a filter of only the listed keys and values. It forwards only own fields, read once, in a fresh object; anything else rejects with `Invalid journal request` and no IPC. Main checks the same rules again with exact argument counts (`list-trips` one object, `get-trip` one UUID, the page channels a UUID and a cursor or `null`) and sets the page size itself; the renderer cannot choose it. Only the trusted dashboard main frame may call: another sender, a subframe or the overlay rejects with `Untrusted journal request`. The code is in [journal-contract.ts](../apps/desktop/src/journal-contract.ts).

**Results.** A valid call never rejects: it resolves `{ok: true, value}` or `{ok: false, code}` with a fixed code.

| Code | Meaning |
| --- | --- |
| `SERVICE_UNAVAILABLE` | No ready telemetry service: before the first readiness of a restarted service, after a failure, exit or restart exhaustion, while the application or the service stops |
| `DATABASE_OPENING` | The service is still opening its database |
| `DATABASE_UNAVAILABLE` | The database could not be opened or failed later; `storageCode` names the storage error code that made it unavailable (for example `PERMISSION_DENIED`, `SCHEMA_NEWER`). `storageCode: 'TIMEOUT'` means a storage command, possibly this read, missed the storage client's 10 s deadline: that fails the client closed, so the database and recording stay stopped for that telemetry service until it restarts ([the telemetry service](telemetry-service-v1.md#journal-queries-et-016)) |
| `BUSY` | Main already holds one request in flight and four waiting, the service is still running an earlier read that main timed out, or the storage client's queue is full |
| `TIMEOUT` | No answer from the service within main's 15 s deadline; the read may be retried |
| `NOT_FOUND` | The trip is not in the database (`UNKNOWN_TRIP`) |
| `FAILED` | Anything else: a refused query, an unexpected storage error, a journal answer that broke the contract in the client (`JOURNAL_ANSWER_INVALID`), or a service reply main refused |

No fixed-shape field of a result carries a path, a process id, a Windows session id or error text: the shapes have no such field, and main refuses a reply with any extra field ([below](#routing-and-bounds-j4)). The one open record is an interval's `detail`, forwarded as stored; only project code writes it (the trip reducer, the trip recorder and the sample buffer), from validated protocol v1 data and its own counters, and none of them writes a path, process id or session id into it. Plugin session ids, trip UUIDs and eventSeqs are stable data identifiers and appear in the values.

### Routing and bounds (J4)

1. **Main** ([journal-broker.ts](../apps/desktop/src/journal-broker.ts)) sends each read to the current ready service on its parent port as `{type: 'journal', id, query}`. One request is in flight per service, at most 4 wait behind it, and one more answers `BUSY` at once. Each request has 15 s from the moment it is sent; then it answers `TIMEOUT`, the next waiting request is sent, and the late reply, whose id is no longer in flight, is ignored. The service is attached at its readiness. When it fails, exits, restarts or exhausts its restarts, or the application exits, the request in flight and every waiting one answer `SERVICE_UNAVAILABLE`, and replies of the retired service are ignored.
2. **The service** ([journal-service.ts](../apps/desktop/src/journal-service.ts)) parses the query again and runs one journal read at a time through the client of the database it opened; a second read while one runs answers `BUSY`. It reads only while the database is open and the service is not stopping, so at most one journal command is ever in the storage queue, behind at most the recorder's one command in flight. It answers `{type: 'journal', id, result}`. A malformed message is answered `FAILED` (when its id is valid) and logged as `JOURNAL_REQUEST_REJECTED {count}` at counts 1, 2, 4, 8, …
3. **Main's reply check.** Main forwards a reply only when it is exactly `{type, id, result}` from the current service for the request in flight, and the result answers that request exactly: the journal contract validators for the read and its requested limit, the requested trip (for the detail and the samples), rows strictly after the requested cursor and in order, a next cursor exactly on a full page, trips that match the requested filter, list-row names within the protocol's 256-byte name bound, and samples of exactly the `JournalSample` shape (a compile-time check keeps it equal to the storage `SampleRecord`). Every fixed-shape object must have exactly its listed keys. An interval's `detail` is the exception: it must be an object whose `annotation` and `cause` agree with the interval's flags, but its other keys are not checked and it is forwarded as stored. Its keys vary by cause (about thirty across the reducer's annotations, gap and reading-hole intervals, the recorder's restore loss and the sample buffer's backlog) and grow with new causes, so a key whitelist in main would fail whole pages, and later exports, whenever a writer gains a key. Anything else answers `FAILED` and is never forwarded.

The `journal` reply type sits before main's fatal default for unknown service messages, which stays fatal (`SERVICE_INVALID_MESSAGE`). Main logs fixed codes with counts at 1, 2, 4, 8, …: `JOURNAL_REQUEST_BUSY`, `JOURNAL_REQUEST_TIMEOUT {kind}`, `JOURNAL_REPLY_REJECTED {kind}` and `JOURNAL_REPLY_IGNORED`. The service's history storage logs `JOURNAL_ANSWER_INVALID {command, count}` the same way.

## The Journal tab (J12–J14)

ET-016 PR-4 adds the Journal tab to the main window. The window has two shadcn Tabs: **Live**, the existing dashboard and the default, and **Journal**. The Live panel stays mounted while Journal is open, so its cards keep their state, and its inactive state hides it (Radix does not hide a force-mounted panel). The Journal panel mounts when it opens and holds nothing while closed. The tab list is one compact row above the first card, so the status, speed and fuel lines stay inside the first 800 × 500 viewport (B6); the journal smoke measures them.

**Reads.** The tab uses only the five bridge methods above. It holds one page of each list at a time: the trip list, and in a trip's detail the completeness intervals, the timeline and the samples. Next and Previous walk a stack of cursors, so Previous re-reads the earlier page instead of keeping it. A list loads when it opens and on Refresh; nothing refreshes by itself. While a trip is open, the list stays mounted but hidden, so Back returns to the same page without a read. A filter change starts a new list at its first page. Only the latest request of a list may set its page, so a slow answer to an earlier page is dropped. The detail has four tabs, each reading when it opens: Summary (the trip detail), Completeness (intervals, 100 per page), Timeline (events, 100 per page) and Samples (300 per page). Every read sets its next cursor on a full page, so a list whose length is a multiple of its page size ends with an empty page (exactly 50 trips leave an empty page 2): an empty page after the first says only that nothing more follows (`No more trips.`, `No more events in this window.`, `No more completeness intervals.`, `No more one-second samples.`), never that nothing was recorded. The filters are shadcn Selects. An error boundary keeps a render fault of the journal inside its tab with a fixed sentence, so it can never blank the Live tab; closing and reopening the Journal tab retries.

**Text.** Every string comes from the pure builder [journal-view.ts](../apps/desktop/src/journal-view.ts) with the fixed texts of [strings.ts](../apps/desktop/src/strings.ts); [journal.tsx](../apps/desktop/src/journal.tsx) only renders it. There are no React component tests (B4): `tests/unit/journal-view.test.ts` checks the texts and the journal runtime smoke the rendered tab.

**Display rules (J13).**

| Value | Shown as |
| --- | --- |
| Outcome | `Delivered`, `Cancelled`, `In progress`, or `No outcome — <why it closed>` (job cleared, a different job started, the game or plugin restarted, a loaded save or game time change, events were lost) |
| Recording completeness | A separate badge: `Complete`, `Partial` or `Unknown`. Neither is inferred from the other |
| Distances | Planned (job offer, excludes ferries), Observed (odometer while recording) and Delivered (reported by the game) are separate rows. A trip that was not delivered shows `none (not delivered)` |
| Money | Expected income (job offer) and Revenue or Penalty (reported by the game) are separate rows; a trip without an outcome shows `none (no delivery or cancellation)`, an open one `not yet (in progress)`. Fines, tolls, ferries and trains show one exact total per currency and SDK type, for example `401 EUR (SDK-documented), 2 amounts; 50 (currency unknown), 1 amount`, plus `N unavailable (reason)`. Nothing is converted, netted or added across currencies; with more than 5,000 amounts a note replaces the totals |
| A missing value | `unavailable (not observed)`, `unavailable (not provided by the game)` or `unavailable (invalid reading)`. Zero, `no` and an empty name (`(empty)`) are values |
| Units | The trip's own game profile from the saved settings: ETS2 metric and ATS US customary by default, never the profile of the game currently shown on Live |
| Times | The recorded UTC labels as local clock time, `YYYY-MM-DD HH:MM:SS`; a note says so. A label outside the representable date range shows as `unavailable (invalid reading)`. Real durations are not shown, because labels are not monotonic time. The delivery duration and the deadline are game time |
| Game mode | The mode with its evidence, for example `Single-player (weak evidence, not confirmed, module scan)`; a weak result is never presented as confirmed (D9). A mode that changed during the trip says so |
| Fuel used | The stored trip value (S-1, J8) with its availability. There is no trip average consumption (J21) |
| Truck and trailers | A trip without a truck says that none was recorded and that a trip attached during its job has none until the game sends it again (J22); the same holds for trailers. Only the latest 10 trailer configurations are listed, with a note when the trip has more |
| Test database | A persistent banner `Synthetic test database — never game history` or `Replay test database — never game history` on every view while the last answer came from such a database (J3) |
| Empty history | `No trips recorded`; while recording is `disabled` (`GAME_HISTORY_RECORDING` false) it adds that game recording is off in this version. With a filter: `No trips match these filters`. An empty later page: `No more trips.` without the note |
| Refusals | Each J11 code is a fixed sentence; `DATABASE_UNAVAILABLE` names the storage code's fixed cause. A rejected call shows `The journal request was refused.` No path, SQL or storage error text is shown |

**Timeline and intervals.** The timeline states its window in words (through the closing event, before the events a gap lost, to the end of the session, in progress, or unknown for a trip closed under schema version 1), and each event shows its time, type, a short detail (money exact as above) and whom it belongs to: this trip, this trip before the cargo was loaded, another trip, free driving, ambiguous, or `—`. Interval causes are fixed texts for the recorder's causes ([trip interval detail keys](trips.md#interval-detail-keys)); any other cause shows as `other`, and an annotation says that it leaves completeness unchanged.

**Samples (J14).** Each sample row shows its time, speed, fuel, gear, engine RPM, odometer, the SDK's estimated range and mean consumption, game time and the world position; the consumption and position headings carry the notes `SDK mean, not a trip average` and `game-world coordinates, not GPS`. Each value is `unavailable (reason)` when missing. Between two rows of the same source clock whose source seconds (monotonic time ÷ 1 s) are more than one apart, a `no samples for N s` row names the N missing seconds; a change of source clock is a `source restarted` row. Only the current page is held, so the first row of a page is not compared with the previous page.

## Pending parts

- **Journal tab manual checks (pending).** Readability at 100% and 150% scaling in the 800 × 500 window, keyboard use of the tabs, tables and filters, and the tab against real recorded game history (after enablement).
- **JSON export (pending, PR-5).** The `ets2telemetry.trip-export` format version 1 and the main-process save flow (J15–J17).
- **Late-attach trips (ET-016b PR-7, done).** Since PR-6 the recorder writes fuel used for each trip, as a value or with its unavailability reason. Since PR-7 a job accepted before the recorder attached is a partial trip with a checkpoint job and no truck or trailer until they are configured again ([TD-007](technical-debt.md#td-007-truck-and-trailer-identity-of-late-attach-trips)).
- Real game history, journal read latency while recording, and large real histories remain unmeasured.
