# Trip journal

ET-016 adds the trip journal: a list of recorded trips, a detail view of one trip and a versioned JSON export. This document describes where the journal reads its data, the read commands and their bounds, and the timeline window of a trip. Decisions J1–J22 are in [concept.md](../concept.md#et-016-authorization--october-16-2026); the schema they read is [storage schema version 2](storage.md#schema-version-2-et-016).

Status (October 16, 2026): ET-016a PR-2 implements the storage reads in the storage worker and their tests. The parts below marked **pending** belong to later PRs: the journal queries from main through the telemetry service (PR-3), the Journal tab (PR-4) and the JSON export (PR-5). Nothing in the application calls the journal reads yet, and `GAME_HISTORY_RECORDING` stays `false`, so no real game history exists to show.

## Data source and purposes (J2, J3)

The journal reads the database that the telemetry service opened, through the service's [storage worker](storage.md#storage-worker) and its `StorageClient`. There is no second connection: the writer holds an exclusive lock ([OD-8](storage.md#durability)), and only the storage worker loads SQLite.

- In production that database is the history database (`%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, purpose `history`).
- With `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` it is that synthetic or replay [recording target](storage.md#history-database-in-the-telemetry-service) instead. There is no journal-specific variable or file picker.
- Every journal response carries `database: {purpose, schemaVersion}`. A purpose other than `history` is a test database that is never game history; the Journal tab shows a persistent banner for it (pending, PR-4), and the export header carries the purpose (pending, PR-5).
- Tests and smokes seed only temporary or isolated synthetic databases, never history.

Journal reads share the recorder's single command lane in the storage client: one command in flight, at most 64 queued, 10 s per command. A read that missed that deadline would fail the client closed and stop recording for the service lifetime, so every read is bounded, uses an index or a primary key ([below](#query-plans)), and the service will send at most one journal command at a time (pending, PR-3).

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

## Pending parts

- **IPC (pending, PR-3).** Main sends journal queries to the telemetry service on its parent port, with one query in flight per service, at most 4 queued and 15 s each, and six fixed bridge methods for the trusted dashboard frame (J4, J10, J11).
- **Journal tab (pending, PR-4).** The Live and Journal tabs, the paged list with filters, the trip detail, the display rules of J13 and the sample gap rows of J14.
- **JSON export (pending, PR-5).** The `ets2telemetry.trip-export` format version 1 and the main-process save flow (J15–J17).
- **Late-attach trips (ET-016b PR-7, done).** Since PR-6 the recorder writes fuel used for each trip, as a value or with its unavailability reason. Since PR-7 a job accepted before the recorder attached is a partial trip with a checkpoint job and no truck or trailer until they are configured again ([TD-007](technical-debt.md#td-007-truck-and-trailer-identity-of-late-attach-trips)).
- Real game history, journal read latency while recording, and large real histories remain unmeasured.
