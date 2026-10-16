# Trip journal

ET-016 adds the trip journal: a list of recorded trips, a detail view of one trip and a versioned JSON export. This document describes where the journal reads its data, the read commands and their bounds, and the timeline window of a trip. Decisions J1–J22 are in [concept.md](../concept.md#et-016-authorization--october-16-2026); the schema they read is [storage schema version 2](storage.md#schema-version-2-et-016).

Status (October 16, 2026): ET-016a PR-2 implements the storage reads in the storage worker and their tests. PR-3 routes them from the dashboard through main to the telemetry service with five bridge methods ([IPC methods and codes](#ipc-methods-and-codes-j10-j11)). The parts below marked **pending** belong to later PRs: the Journal tab (PR-4) and the JSON export (PR-5). No renderer code calls the bridge methods yet, and `GAME_HISTORY_RECORDING` stays `false`, so no real game history exists to show.

## Data source and purposes (J2, J3)

The journal reads the database that the telemetry service opened, through the service's [storage worker](storage.md#storage-worker) and its `StorageClient`. There is no second connection: the writer holds an exclusive lock ([OD-8](storage.md#durability)), and only the storage worker loads SQLite.

- In production that database is the history database (`%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, purpose `history`).
- With `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` it is that synthetic or replay [recording target](storage.md#history-database-in-the-telemetry-service) instead. There is no journal-specific variable or file picker.
- Every journal response carries `database: {purpose, schemaVersion}`. A purpose other than `history` is a test database that is never game history; the Journal tab shows a persistent banner for it (pending, PR-4), and the export header carries the purpose (pending, PR-5).
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

**Checkpoint-opened trips.** Schema version 2 allows a trip opened from a checkpoint (`opened_by` `checkpoint`, `opened_event_ref` NULL), but nothing writes one until ET-016b PR-7. If one exists, the journal reads return it rather than refusing it: the list shows it like any trip, the detail has `openedBy: 'checkpoint'`, `openedEventSeq: null` and a `checkpoint` job with its nextEventSeq, and the window starts at that nextEventSeq and ends by the rules above. `tests/storage/journal-reads.test.ts` inserts such a trip directly and checks the list, the detail (also against the contract validator), the window and the timeline. The other storage reads (`getTrip`, `listTrips`) still expect an opening event and are adapted in PR-7.

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
| `DATABASE_UNAVAILABLE` | The database could not be opened or failed later; `storageCode` names the storage error code that made it unavailable (for example `PERMISSION_DENIED`, `SCHEMA_NEWER`, `TIMEOUT`) |
| `BUSY` | Main already holds one request in flight and four waiting, the service is still running an earlier read that main timed out, or the storage client's queue is full |
| `TIMEOUT` | No answer within main's 15 s, or the storage command missed its 10 s deadline |
| `NOT_FOUND` | The trip is not in the database (`UNKNOWN_TRIP`) |
| `FAILED` | Anything else: a refused query, an unexpected storage error, a journal answer that broke the contract in the client (`JOURNAL_ANSWER_INVALID`), or a service reply main refused |

No fixed-shape field of a result carries a path, a process id, a Windows session id or error text: the shapes have no such field, and main refuses a reply with any extra field ([below](#routing-and-bounds-j4)). The one open record is an interval's `detail`, forwarded as stored; only project code writes it (the trip reducer, the trip recorder and the sample buffer), from validated protocol v1 data and its own counters, and none of them writes a path, process id or session id into it. Plugin session ids, trip UUIDs and eventSeqs are stable data identifiers and appear in the values.

### Routing and bounds (J4)

1. **Main** ([journal-broker.ts](../apps/desktop/src/journal-broker.ts)) sends each read to the current ready service on its parent port as `{type: 'journal', id, query}`. One request is in flight per service, at most 4 wait behind it, and one more answers `BUSY` at once. Each request has 15 s from the moment it is sent; then it answers `TIMEOUT`, the next waiting request is sent, and the late reply, whose id is no longer in flight, is ignored. The service is attached at its readiness. When it fails, exits, restarts or exhausts its restarts, or the application exits, the request in flight and every waiting one answer `SERVICE_UNAVAILABLE`, and replies of the retired service are ignored.
2. **The service** ([journal-service.ts](../apps/desktop/src/journal-service.ts)) parses the query again and runs one journal read at a time through the client of the database it opened; a second read while one runs answers `BUSY`. It reads only while the database is open and the service is not stopping, so at most one journal command is ever in the storage queue, behind at most the recorder's one command in flight. It answers `{type: 'journal', id, result}`. A malformed message is answered `FAILED` (when its id is valid) and logged as `JOURNAL_REQUEST_REJECTED {count}` at counts 1, 2, 4, 8, …
3. **Main's reply check.** Main forwards a reply only when it is exactly `{type, id, result}` from the current service for the request in flight, and the result answers that request exactly: the journal contract validators for the read and its requested limit, the requested trip (for the detail and the samples), rows strictly after the requested cursor and in order, a next cursor exactly on a full page, trips that match the requested filter, list-row names within the protocol's 256-byte name bound, and samples of exactly the `JournalSample` shape (a compile-time check keeps it equal to the storage `SampleRecord`). Every fixed-shape object must have exactly its listed keys. An interval's `detail` is the exception: it must be an object whose `annotation` and `cause` agree with the interval's flags, but its other keys are not checked and it is forwarded as stored. Its keys vary by cause (about thirty across the reducer's annotations, gap and reading-hole intervals, the recorder's restore loss and the sample buffer's backlog) and grow with new causes, so a key whitelist in main would fail whole pages, and later exports, whenever a writer gains a key. Anything else answers `FAILED` and is never forwarded.

The `journal` reply type sits before main's fatal default for unknown service messages, which stays fatal (`SERVICE_INVALID_MESSAGE`). Main logs fixed codes with counts at 1, 2, 4, 8, …: `JOURNAL_REQUEST_BUSY`, `JOURNAL_REQUEST_TIMEOUT {kind}`, `JOURNAL_REPLY_REJECTED {kind}` and `JOURNAL_REPLY_IGNORED`. The service's history storage logs `JOURNAL_ANSWER_INVALID {command, count}` the same way.

## Pending parts

- **Journal tab (pending, PR-4).** The Live and Journal tabs, the paged list with filters, the trip detail, the display rules of J13 and the sample gap rows of J14.
- **JSON export (pending, PR-5).** The `ets2telemetry.trip-export` format version 1 and the main-process save flow (J15–J17).
- **Late-attach trips (pending, ET-016b PR-7).** Since PR-6 the recorder writes fuel used for each trip, as a value or with its unavailability reason. Until PR-7 no trip has a checkpoint job.
- Real game history, journal read latency while recording, and large real histories remain unmeasured.
