# Durable history storage

ET-013 adds the local history database: a SQLite file written through [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) by one connection that the telemetry service's storage worker owns. This document describes the schema, the durability rules, migrations, backups, the storage API and the worker that runs it.

Status (October 15, 2026): PR-1 added the in-process storage core in [packages/storage](../packages/storage) and its tests. PR-2 runs it in the storage worker of the telemetry utilityProcess, opens the production database at service start ([below](#history-database-in-the-telemetry-service)) and measured its size ([disk budgets](#disk-budgets)). The desktop application stays on protocol v0, records nothing and sends no ACK; recording starts with ET-015a. ET-006b PR-1 adds a [durable sink](#durable-sink-for-protocol-v1-ingestion-et-006b) for protocol v1 ingestion that only tests use with temporary synthetic databases; production durable delivery stays off. See [ET-013 validation](validation/et-013.md) for the checks performed.

## Files and purposes

| Purpose | File | Accepted envelope origin |
| --- | --- | --- |
| `history` | `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, backups in `%LOCALAPPDATA%\ETS2Telemetry\backups\` | `game` only |
| `synthetic` | `%LOCALAPPDATA%\ETS2Telemetry\synthetic\<name>.sqlite`, name `[a-z0-9-]{1,64}`, backups in `synthetic\backups\` | `synthetic` only |
| `replay` | same directory rules as `synthetic` | `replay` only |

The paths are resolved at runtime from `LOCALAPPDATA` (`dataPaths` in [paths.ts](../apps/desktop/src/paths.ts), which also names the `synthetic` directory); the application never falls back to TEMP or the working directory. Each database stamps its purpose in `database_info` when it is created, and a schema trigger refuses a plugin session whose origin differs from the one its purpose accepts. Synthetic and replay data therefore never enter history. A synthetic or replay database may not use the production history path at all. Tests use only temporary directories from `tests/shared/resources.ts`.

The database path must be absolute and normalized; `:memory:`, relative, drive-relative and `file:` paths are refused with `DATA_PATH_INVALID`. A missing parent directory is created; a file in its place is refused.

## Durability

SQLite terms used here:

- **WAL (write-ahead log)** is a journal mode in which a commit appends pages to a separate `-wal` file instead of rewriting the database in place; a *checkpoint* later copies them back. A crash leaves a "live" WAL whose committed transactions SQLite replays on the next open.
- **`synchronous`** controls how often SQLite asks Windows to flush data to disk. `FULL` (2) flushes the WAL on every commit, so a commit that returned survives power loss. `NORMAL` (1) can lose the last commits on power loss in WAL mode.
- **Locking mode `EXCLUSIVE`** keeps the database lock after the first transaction instead of releasing it. Set before the first WAL access, SQLite also keeps the WAL index in memory, so no `-shm` shared-memory file exists.

Every writer open, including reopen, the open after a migration and the open after a restore, runs the same sequence:

1. Validate the path (above).
2. If the file exists, inspect it without writing. When no `-wal` or `-journal` file exists, the 100-byte file header is authoritative: a foreign `application_id` or a newer `user_version` is refused without opening SQLite at all. Otherwise a read-only connection reads `application_id`, `user_version`, the user tables and `database_info.purpose`. A read-only connection to a WAL file can create a `-shm` (and an empty `-wal`) beside it; the inspection removes exactly the files it created. It never changes the database or an existing WAL.
3. Refuse a file of another application, or one without this application's schema but with user tables (`DATABASE_UNRECOGNIZED`), a newer schema (`SCHEMA_NEWER`), another purpose (`PURPOSE_MISMATCH`) and a locked file (`DATABASE_LOCKED`). An existing file without write access is `PERMISSION_DENIED`; SQLite would otherwise fall back to a read-only handle and fail later with a misleading I/O code.
4. Open read-write with a 2,000 ms busy timeout.
5. `PRAGMA locking_mode = EXCLUSIVE`, read back `exclusive`.
6. Re-read `application_id`, `user_version` and the user tables on this connection. In exclusive mode this first read takes the file lock and keeps it. Another process could have changed the file since step 2: a schema that became newer is refused with `SCHEMA_NEWER`, and any other change (a different version or id, or tables in a file inspected as new) with `DATABASE_UNRECOGNIZED`, before any write.
7. `PRAGMA journal_mode = WAL`, read back `wal`.
8. `PRAGMA synchronous = FULL`, read back `2`. This comes after WAL on purpose: better-sqlite3 13.0.3 compiles `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` (`node_modules/better-sqlite3/deps/defines.gypi`), so a WAL database reopened without this setting runs at `NORMAL`. A test proves that a plain connection to the same file reads `1`.
9. `PRAGMA foreign_keys = ON`, read back `1`.
10. `BEGIN IMMEDIATE; COMMIT` to take the write lock now, so a second writer fails at open rather than at its first write.
11. Read integers as BigInt (`defaultSafeIntegers`), so no integer is silently rounded.

Any mismatch closes the connection with `DURABILITY_UNVERIFIED`. Only a connection that passed every step carries the durability record `{journalMode: 'wal', synchronous: 'full', lockingMode: 'exclusive', foreignKeys: true}`, and every write asserts it. A commit result exists only after `COMMIT` returned on that connection.

**One writer (OD-8).** Exclusive locking makes the running application the only connection: a second application instance or an external SQLite tool gets `DATABASE_LOCKED` while it runs. Read the database with external tools only while the application is closed. A second-instance policy belongs to ET-011.

Not established: behavior on real power loss or an operating-system crash, a genuinely full volume, real ACL denial on roaming, redirected or OneDrive folders, antivirus or indexer locks on `-wal` files and renames, and directory durability. Windows offers no directory `fsync`; renames rely on NTFS metadata journaling.

## Schema version 1

The schema text is frozen in [schema-v1.ts](../packages/storage/src/sqlite/schema-v1.ts) and in the committed fixture. `PRAGMA application_id` is `1163154226` (the ASCII bytes `ETS2`) and `PRAGMA user_version` is the schema version. Every table is `STRICT`: SQLite refuses a value that cannot become its column's type, such as text in an INTEGER column.

| Table | Contents |
| --- | --- |
| `database_info` | One immutable row: database UUID, purpose, accepted origin, creation time and application version |
| `schema_migrations` | One row per applied version, with the pre-migration backup file name and SHA-256 when one was taken |
| `plugin_sessions` | One row per plugin session from its welcome: identity, protocol and SDK versions, capabilities, the welcome's game-mode evidence, committed coverage and end marker. Identity columns are immutable |
| `clocks` | Source monotonic and game clock UUIDs per session |
| `events` | One immutable row per durable event, `UNIQUE(plugin_session_id, event_seq)`; occurrence columns plus the canonical payload |
| `event_gaps` | One immutable row per gap marker range, `UNIQUE(plugin_session_ref, first_event_seq, last_event_seq)`, with the six loss causes |
| `job_configurations`, `truck_configurations`, `trailer_configurations` | Normalized configuration events: stable ids and localized names side by side, never invented trailer names |
| `event_amounts`, `job_deliveries` | Money of revenue, penalty, fine, toll, ferry and train events, and delivery details |
| `trips` | Project-generated trip UUID, game, game-mode evidence, configuration references, outcome, close reason, recording completeness and times |
| `trip_trailers`, `event_attributions`, `completeness_intervals` | Trip trailers, per-event trip attribution, and known missing or discontinuous intervals |
| `samples` | One-second samples with numeric session, trip and clock references |

Conventions (OD-3, OD-6, OD-7):

- **Exact 64-bit identifiers.** Wire uint64 values in sessions, events and gaps (`eventSeq`, monotonic nanoseconds, UTC milliseconds, revisions, boundary order, loss counts) are stored as 20-digit zero-padded decimal TEXT. That is exact, and text order equals numeric order, so range queries and the UNIQUE key work. Sample `monotonic_ns` is an INTEGER; a value above 2^63-1 is refused with `VALUE_OUT_OF_RANGE`, never truncated.
- **Exact money.** Money is the raw canonical decimal TEXT with its SDK type (`s64` or `u64`) and currency status, never a REAL. A `GLOB` check enforces the shape and the codec checks the range with BigInt; `-0` and leading zeros are refused.
- **Availability.** Each SDK attribute has a value column and a `_state` column (`available`, `not-observed`, `not-supported`, `invalid`); the value is present exactly when the state is `available`. Zero is a value, and a provided empty string is an available `''`. Samples keep one NULL per unavailable reading plus `not_supported_mask` and `invalid_mask` bits; a NULL without a bit is not observed. Commands accept only exactly `{available: true, value}` with a present value or `{available: false, reason}` with a known reason; any other shape is `INVALID_INPUT`, never a silent not-observed.
- **Floats.** SDK float32 values are stored as float64 REAL copies, which is exact. One exception: SQLite keeps integral REAL values in integer form, so negative zero reads back as zero. The canonical event payload keeps `-0`.
- **Raw payload.** Each event row keeps `payload_json`, canonical JSON (sorted keys, no whitespace) of the validated `{occurred, record}`, beside its normalized columns. A redelivered event compares by this text.
- **Time.** Real time (source monotonic nanoseconds with their clock, UTC milliseconds as labels) and game time (minutes with their game clock) are separate columns and are never mixed.
- **Reserved values.** Enumerations match protocol minor 0 and include values reserved for later minors, such as game mode `convoy`, so adding them needs no table rebuild.

Indexes: samples by session and by trip, attributions and completeness intervals by trip, completeness by session, and the UNIQUE keys. Journal indexes belong to ET-016.

## Storage API

[packages/storage/src/index.ts](../packages/storage/src/index.ts) is the in-process API; it loads native SQLite. [api.ts](../packages/storage/src/api.ts) holds the Node-safe types. Every method returns `{ok: true, value}` or `{ok: false, error: {code, retryable, message, sqliteCode?, cause?, backupFileName?}}`. The message is fixed text per code; an error never contains a filesystem path or a SQLite message. There is no delete command for history entities, and the MVP never deletes history automatically.

| Command | Behavior |
| --- | --- |
| `openStorage(options)` | The durability sequence, then creation or migration |
| `upsertSession({message})` | Stores the session from a validated welcome. Repeating it changes nothing; a changed identity, version or capability is `SESSION_CONFLICT`. Later game-mode changes arrive as `source.gameMode` events and are kept beside the welcome's evidence |
| `commitEvent({message, effects?})`, `commitGap({message, effects?})` | Validates the message again with the protocol v1 schema and requires a stored session with the same identity. One `BEGIN IMMEDIATE` transaction inserts the row keyed UNIQUE(session, eventSeq or range), its normalized rows and the effects, and advances coverage. Returns `committed`, `duplicate` (same canonical payload; effects not applied again), `conflict` (different payload; the stored row is kept, protocol v1 §9) or, for a gap only, `covered` (its whole range is already inside committed coverage; nothing is stored and effects are not applied), with `committedThroughEventSeq`. Every gap result also carries `previouslyCoveredThrough`, the coverage before the transaction |
| `committedThrough(pluginSessionId)` | The contiguous committed coverage: the `committedThroughEventSeq` input of `DurableAckCursor` |
| `appendSamples(pluginSessionId, rows)` | Up to 3,600 samples in one transaction: all of them or none |
| `recordCompleteness(pluginSessionId, interval)` | A known missing interval outside an event commit |
| `getSession`, `getEvent`, `listEvents` (≤ 500), `getTrip`, `listTrips` (≤ 100), `listSamples` (≤ 3,600 per trip or session), `storageInfo` | Bounded reads |
| `restoreBackup(manifest, options)` | Restore into a new file (below) |

**Coverage.** `committed_through_event_seq` is advanced in the same transaction as the commit. A range that starts at or before coverage + 1 extends it, and stored events and gaps that continue from there are absorbed, so commits {1, 2, 4} give 2 and committing 3 later gives 4. A gap range may overlap committed events; those keep their rows (protocol v1 §9). A gap that lies wholly inside coverage, such as a merged gap record redelivered after an ACK inside it (stream `ack-inside-gap-record`), is `covered`: storing it again would count the same losses twice and reapply its effects. An ACK may be built only from this value after the transaction returned (protocol v1 §10).

**Overlapping gap rows.** A gap row may overlap other gap rows. The producer extends a retained gap record in place, so after an ACK inside it the record can be redelivered with a larger range that contains ranges already stored as separate rows (protocol v1 §9). Example: event 1, gap [2, 2] (`queueCount` 1) and gap [3, 4] (`encodingFailed` 2) are committed; the producer holds them as one record [2, 4]; an ACK of 3 falls inside it; offline events 5 and 6 extend it to [2, 6], which the next connection redelivers. Storage keeps all three rows and nothing is dropped; coverage becomes 6 and the result reports `previouslyCoveredThrough` 4. Rules:

- Each gap row keeps the six cause counts of its own message. Counts are per message, not additive across overlapping rows: summing them counts the prefix [2, 4] twice.
- The set of lost eventSeqs is the union of the gap row ranges minus the eventSeqs that have an event row. Never sum the range lengths of overlapping rows.
- To total losses by cause without double counting, walk the gap rows in commit order (`id`) and keep only the eventSeqs above everything already counted. When a row overlaps earlier rows, it is a grown producer record whose counts include those of the earlier rows it contains, so its causes for the new suffix are its counts minus the counts of the earlier gap rows inside its range: [2, 6] minus [2, 2] and [3, 4] gives `offline` 2 for [5, 6]. A row's counts describe its whole range; they do not say which eventSeq had which cause.
- **Caller rule for effects.** Effects supplied with a gap are applied once, when its row is first stored, and must cover only (`previouslyCoveredThrough`, `lastEventSeq`]. Read `committedThrough()` right before committing; the single writer keeps it unchanged until the commit, and the result's `previouslyCoveredThrough` confirms the value the transaction used.

**Trip effects (OD-9).** The domain (ET-014) computes typed effects; storage applies them in the same transaction, in order, only when the event or gap is inserted for the first time. At most 16 per commit: `trip.open` (at a job configuration event), `trip.update` (whitelisted fields), `trip.close` (delivered or cancelled only with the matching gameplay outcome event), `event.attribute` and `completeness.add`. References to configuration events are resolved inside the transaction, within the current plugin session. Every trip reference (`trip.update`, `trip.close`, `event.attribute`, `completeness.add` and a sample's `tripUuid`) must name a trip of the current session's game: an ATS session can never bind data to an ETS2 trip, or the reverse. A trip of an earlier plugin session of the same game stays referable, because ET-014 closes it with close reason `restart` from the new session. A closed trip accepts only `trip.update` of recording completeness and observed distance, since a late gap can still downgrade its completeness; its game-mode evidence and configuration are fixed once it is closed. Any failure rolls back the event as well and returns an explicit error, never a commit result. ET-013 tests effects only with synthetic examples. An in-process `testHooks.beforeCommit` exists for tests and is never part of a worker message.

The ET-014 reducer that computes these effects, and its caller contract for ET-015a, are described in [trips](trips.md).

### Error codes

| Code | Meaning | Retryable |
| --- | --- | --- |
| `DATABASE_LOCKED` | `SQLITE_BUSY`/`LOCKED`, `EBUSY`, or another writer holds the file | Yes |
| `PERMISSION_DENIED` | `SQLITE_READONLY*`, `PERM`, `AUTH`, `CANTOPEN`, `EACCES`, `EPERM`, a read-only file | No |
| `DISK_FULL` | `SQLITE_FULL`, `ENOSPC` | Yes |
| `IO_ERROR` | `SQLITE_IOERR*`, `EIO` | Yes |
| `DATABASE_CORRUPT` | `SQLITE_CORRUPT`, `SQLITE_NOTADB`, an impossible stored value | No |
| `CONSTRAINT_VIOLATION` | `SQLITE_CONSTRAINT*`, for example a synthetic session in history | No |
| `INVALID_INPUT`, `UNKNOWN_SESSION`, `UNKNOWN_TRIP`, `SESSION_CONFLICT`, `VALUE_OUT_OF_RANGE` | Command input | No |
| `STORAGE_CLOSED`, `STORAGE_BUSY`, `WORKER_FAILED`, `TIMEOUT` | Connection and worker state ([storage worker](#storage-worker)) | `STORAGE_BUSY`, `TIMEOUT` |
| `DATA_PATH_INVALID` | Invalid path or blocked directory | No |
| `DATABASE_UNRECOGNIZED`, `SCHEMA_NEWER`, `PURPOSE_MISMATCH`, `DURABILITY_UNVERIFIED` | Refused opens; the file is unchanged | No |
| `BACKUP_FAILED`, `MIGRATION_FAILED` | `cause` gives the underlying code; `backupFileName` names the backup | No |
| `INTERNAL` | Any other failure, including other SQLite result codes such as `SQLITE_ERROR`, a `TypeError` and a better-sqlite3 `RangeError` (for example a wrong parameter count): a defect in the storage code. Input ranges are validated before SQLite, so a `RangeError` is never read as `VALUE_OUT_OF_RANGE`. Malformed command arguments are `INVALID_INPUT` | No |

## Storage worker

The database runs on a Node.js worker thread of the telemetry utilityProcess, never in Electron main or a renderer:

```text
Electron main -> telemetry utilityProcess -> storage worker thread (storage-worker.cjs) -> one better-sqlite3 connection
```

[apps/desktop/src/storage-worker.ts](../apps/desktop/src/storage-worker.ts) has two modes. Started with `workerData {kind: 'storage'}`, it runs the host in [worker/host.ts](../packages/storage/src/worker/host.ts) on the in-process storage core; every other start is the unchanged ET-001 readiness probe (`{kind: 'probe', filename}`). It is the only desktop module that loads better-sqlite3.

The service talks to the worker through [StorageClient](../packages/storage/src/client.ts), which is Node-safe: it never loads native SQLite. The messages are defined in [worker/protocol.ts](../packages/storage/src/worker/protocol.ts): `{type: 'storage.request', id, command}` and `{type: 'storage.response', id, result}`, where `command` names one storage method (`open`, `upsertSession`, `commitEvent`, `commitGap`, `appendSamples`, `recordCompleteness`, `committedThrough`, the bounded reads, `storageInfo` and `close`) and `result` is the method's Result. Open options cross the boundary as exactly `{path, purpose, backupsDirectory, appVersion}`; the host copies them field by field and forwards only the message and effects of a commit, so injected migrations, clocks and `testHooks` never reach the worker. A malformed request with an id is answered with `INVALID_INPUT`.

| Rule | Value |
| --- | --- |
| Commands in flight | One at a time, in order; request ids are monotonic positive integers |
| Queue | At most 64 commands behind the one in flight; the next is refused at once with retryable `STORAGE_BUSY` |
| Deadline per command | 10 s after it was sent; `open` 120 s, because it can include a verified backup and a migration |
| Missed deadline | The command gets retryable `TIMEOUT`, the worker is terminated and every queued and later command gets `WORKER_FAILED` |
| Worker error or unexpected exit | The command in flight and every queued command get `WORKER_FAILED`; later commands too |
| Malformed answer | An answer for another id, an unknown error code or a commit result without a canonical decimal `committedThroughEventSeq` and a known status fails the client the same way |
| Close | Queued commands get `STORAGE_CLOSED`, the command in flight finishes with its real result, then the worker closes the database (SQLite checkpoints the WAL) and its thread exits with code 0. Without that within the close grace, the worker is terminated and the command in flight gets `WORKER_FAILED`. Closing a client that had already failed (worker error or exit, missed deadline, malformed answer) only waits for the terminated thread and is never clean |

**No success after a failure.** A worker failure, a missed deadline or a malformed answer fails the client closed. The command in flight may or may not have committed, so it is reported as `TIMEOUT` or `WORKER_FAILED`, never as a commit result, and an answer arriving later is ignored. A durable ACK may be built only from a commit result (protocol v1 §10), so a lost answer can delay an ACK but never advance one past stored coverage; after a restart the producer redelivers and storage answers `duplicate`. A storage error such as `DISK_FULL` is an ordinary result: the worker keeps serving and a retry can commit.

## History database in the telemetry service

OD-2: the telemetry service opens the production history database when it starts, without waiting for it ([history-storage.ts](../apps/desktop/src/history-storage.ts)). The ET-001 temporary probe stays the readiness gate, so live telemetry and the overlay never depend on the database.

- **Path.** `dataPaths(%LOCALAPPDATA%).database`, that is `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, with purpose `history` and backups in `%LOCALAPPDATA%\ETS2Telemetry\backups\`. A missing, empty, relative or drive-relative `LOCALAPPDATA` leaves history unavailable with `DATA_PATH_INVALID`; there is no TEMP or working-directory fallback.
- **Diagnostics.** The service log receives only fixed codes and numbers: `HISTORY_STORAGE_OPENED` with facts `{schemaVersion, created, migratedFrom}` (`migratedFrom` is `null` unless a migration ran), `HISTORY_STORAGE_UNAVAILABLE` with `{code}` at most once per service, `HISTORY_BACKUP_PARTIALS_REMOVED` with `{count}` after an open that removed stale partial backup files ([below](#backups-and-restore-od-5)), and `HISTORY_STORAGE_CLOSED` after an orderly close. A refused open (for example `SCHEMA_NEWER`, `DATABASE_LOCKED` or `DATABASE_UNRECOGNIZED`) ends the worker at once; history then stays unavailable until the service starts again. Nothing retries yet.
- **Shutdown.** The step `history-storage` (1000 ms) runs in the `storage` phase of the [service shutdown sequence](app-lifecycle.md#service-shutdown), in parallel with `storage-probe`. It waits for a running open, closes the database and waits for the worker thread to end; the close grace is 800 ms, after which the worker is terminated and the step fails, so the service reports `{type: 'stopped', clean: false}`. The step also fails when the worker had failed earlier in the session (a crash or a missed deadline), because the database was then not closed in order. Phase maxima are now 1000 (intake) + 0 (flush) + 1000 (storage) = 2000 ms of the 2500 ms `SERVICE_STOP_BUDGET_MS`, which leaves 500 ms for the ET-015 flush step.
- **A failed probe** ends the service from its report, outside the orderly sequence (exit code 0 after the probe's own `stopped`, 1 after `SERVICE_STOP_FAILED`). The service first closes the history database, bounded by the same 1000 ms, and then exits with that code. After first readiness this close is best effort: the preceding `failed` report makes the supervisor kill the service at once, so the killed-service rule (WAL replay on the next open, no data loss) usually applies instead.
- **A killed service** does not close the database; SQLite replays committed WAL frames and discards the rest when the next service opens it. The exclusive lock ends with the process.
- **Second instance.** A second service process (which ET-011a's single-instance lock already prevents) would get `DATABASE_LOCKED`.

## Durable sink for protocol v1 ingestion (ET-006b)

ET-006b PR-1 adds `StorageDurableSink` ([durable-sink.ts](../apps/desktop/src/durable-sink.ts)), the bridge from [protocol v1 ingestion](telemetry-service-v1.md) to this API: `openSession` is `upsertSession` with the validated welcome and returns `committedThroughEventSeq`, the `DurableAckCursor` input; `commit` is `commitEvent` or `commitGap`. An optional effects hook reads `committedThrough()` right before each commit, as the caller rule above requires; the default supplies no effects. The ACK pipeline acknowledges only after a commit result and requires the result's coverage to equal its cursor. It classifies every error code in the table above as retryable (`DATABASE_LOCKED`, `DISK_FULL`, `IO_ERROR`, `STORAGE_BUSY`) or as stopping durable delivery for the service lifetime (every other code, including `TIMEOUT`, because a missed deadline fails the client closed); see [failure classes](telemetry-service-v1.md#failure-classes-e7).

The sink is exercised only against temporary synthetic-purpose databases in tests (`tests/storage/v1-durable-ingestion.test.ts`, `tests/storage/v1-ingestion-crash.test.ts`). **Production durable delivery is off:** the service passes no sink, so it still writes no history row and sends no ACK until ET-015a supplies trip effects and the v0-retirement PR lands.

## Migrations (OD-4)

Migrations are forward-only and frozen once released: `MIGRATIONS = [{version: 1, name: '0001-initial'}]`. Each step sets `user_version` and inserts its `schema_migrations` row. A table-rebuild step declares `foreignKeysOff`; the framework turns foreign keys off outside the transaction and runs `foreign_key_check` before commit. Tests may inject migration lists only through the in-process API.

- A new or zero-length file (or an empty SQLite file: application id 0, no user tables and user version 0, as the inspection and the locked re-check both require) receives every migration in one transaction, without a backup.
- An existing database below the supported version is backed up and verified first (below), then every pending step runs in one `BEGIN IMMEDIATE` transaction that ends with `foreign_key_check` and `quick_check`. Any failure rolls back to the old version and content and returns `MIGRATION_FAILED` with the backup name. A backup failure migrates nothing.
- A newer database is refused with `SCHEMA_NEWER` at inspection, including a newer schema that exists only in a live WAL. There is no read-only fallback: an older application never reads or changes a newer schema.
- ET-001's isolated probe database lives in a temporary directory and is never migrated. An unrecognized file at the production path is refused with `DATABASE_UNRECOGNIZED` and never modified, moved or deleted.

## Backups and restore (OD-5)

The pre-migration backup is made with SQLite's online backup API (`db.backup()`), never a file copy: the writer connection copies pages under its exclusive lock, so the copy is consistent even with a live WAL. Steps:

1. Compute the source's logical digest: SHA-256 over the schema, the header versions and every row of every table in rowid order with type-tagged exact values, plus per-table row counts. A file in place of the backup directory is `BACKUP_FAILED` with cause `DATA_PATH_INVALID`.
2. Reuse an existing backup of exactly this content: a manifest with the same database UUID, source version, logical digest and row counts whose backup file still has the recorded size and SHA-256. A migration that fails the same way on every open therefore keeps one backup instead of a new full-size copy each time; a damaged backup is never reused. Otherwise require free space of at least (database + WAL) × 1.1, else `BACKUP_FAILED` with cause `DISK_FULL`.
3. Copy into `telemetry-<first 8 characters of the database UUID>-v<from version>-<UTC timestamp>.sqlite.partial`, then switch the copy to rollback-journal mode so it is one self-contained file.
4. Verify the copy read-only: `integrity_check`, `foreign_key_check`, `application_id`, `user_version`, database UUID, row counts and logical digest.
5. Flush it, rename it to `.sqlite`, and write the manifest `.json` last: `{format, databaseUuid, fromVersion, fileName, fileSha256, size, rowCounts, logicalDigest, createdUtcMs, appVersion, reason: 'pre-migration'}`.

Any failure removes the partial files. A writer that is terminated during the copy (for example when the service's bounded shutdown ends the storage worker) cannot do that, so every writer open of an existing database, once it holds the exclusive lock, removes that database's leftovers: regular files named exactly `telemetry-<uuid8>-v<n>-<timestamp>.sqlite.partial` with `-journal`, `-wal` or `-shm`, and `telemetry-<uuid8>-v<n>-<timestamp>.json.partial`. Finished backups, manifests, other databases' files and anything else are never touched; a removal that fails is retried at the next open. The open summary reports the number as `removedPartialBackups` (PR #60 review). **Retention:** after the new backup is verified and its migration committed, the three newest verified pre-migration backups of that database are kept and older ones are deleted, the backup first and its manifest last. Files without a valid manifest of this application, backups of other databases and history rows are never touched. Budget backups at up to three times the database size.

**Restore** (`restoreBackup`) writes only to a new path. Before writing anything it checks the target path for the requested purpose (a synthetic or replay restore to the production history path is `DATA_PATH_INVALID`), refuses an existing target or any `-wal`, `-shm`, `-journal` or `.partial` file beside it, and checks the manifest, the file SHA-256, the logical digest and that the backup's `database_info.purpose` is the requested one (`PURPOSE_MISMATCH`). Only then does it create the target directory, copy through the backup API into `<target>.partial`, verify the copy, rename it and open it through the normal durability path, which migrates it when it is older. If that open fails, the restored file and its sidecars are removed again on a best-effort basis: a removal that fails (for example `EBUSY` from a scanner) is ignored, and the open's error is still returned as a result. In-place replacement of the live database is deferred to ET-018. Open question for ET-015a: a restored database can hold less coverage than the producer has already acknowledged; ET-015a defines the `restore-loss` completeness marker.

## Disk budgets

These are separate allowances, not a total disk guarantee:

| Item | Bound |
| --- | --- |
| Database | Measured: about 53 MB per 100 hours of 1 Hz samples with this schema (below), within the planning allowance of about 100 MB |
| WAL | Checkpointed automatically about every 1,000 pages and on close; measured peak 4.2 MB (4,173,592 bytes) |
| Pre-migration backups | Up to three copies of the database |
| Logs, CAP0 captures, binaries | Their own bounds: 256 KiB plus one rotation per log; 20 MiB per capture file; the installed application |

### Measured size (ET-013 PR-2)

`npm run measure:storage` ([storage-size.measure.ts](../tests/measurement/storage-size.measure.ts)) writes 100 hours of 1 Hz history through the real storage core with its verified durability settings into a temporary database, under the pinned Electron runtime: 50 plugin sessions of 2 hours, 360,000 samples (every reading available, float32 values as the SDK gives them, about 92% of them in trips), 100 trips with truck and trailer references, 950 gameplay events with attributions, 100 trip closes and 50 gaps with completeness intervals. Samples are written in transactions of 60 rows; 300 further one-row transactions measure the worst case of a 1 Hz writer. Result on the implementer's Windows machine, October 15, 2026 (Electron 44.7.0, better-sqlite3 13.0.3, page size 4,096):

| Measure | Value |
| --- | --- |
| Database after close | 53,436,416 bytes (13,046 pages, empty freelist): **53.4 MB per 100 hours** |
| WAL peak during the load | 4,173,592 bytes |
| `samples` table | 41,078,784 bytes |
| `samples_session` index | 5,693,440 bytes |
| `samples_trip` index (partial) | 5,218,304 bytes |
| Samples with both indexes | 144.3 bytes per sample |
| `events` table and its UNIQUE index | 1,028,096 and 36,864 bytes |
| Every other table and index | under 60 KB each |
| Event commit (with effects) | median 2.4 ms, 95th percentile 3.5 ms |
| 60-sample commit | median 2.5 ms, 95th percentile 3.8 ms |
| One-sample commit | median 1.9 ms, 95th percentile 2.4 ms |
| `listSamples` of one trip (3,300 rows) | median 24.1 ms |
| `listTrips` (100), `listEvents`, `getTrip`, `committedThrough`, `storageInfo` | median 2.0, 0.15, 0.03, 0.01 and 0.05 ms |

The October 10 in-memory model (60–120 MB per 100 hours, about 52 MB with numeric references) is superseded by this measurement of the actual schema. The figures are one synthetic run, not a guarantee: samples with unavailable readings are smaller, longer localized texts or more events per hour are larger, timings depend on the disk, and real one-hour growth, CPU use and frame time remain REG-018/ET-019/ET-020 work. Pre-migration backups add up to three database copies.

## Tests

The storage suite loads native SQLite and runs only under the pinned Electron executable in Node mode, the runtime of the telemetry service: `npm run test:storage` first runs [build-storage-test-bundles.mjs](../scripts/build-storage-test-bundles.mjs), which bundles the storage worker entrypoint, the storage core and the client with Vite under plain Node into a new temporary directory, then starts [run-electron-node.mjs](../scripts/run-electron-node.mjs) with `ETS2TELEMETRY_STORAGE_TEST_BUNDLES` naming that directory; it runs Vitest inside `electron.exe` with `ELECTRON_RUN_AS_NODE=1` and removes the bundles afterwards. [vitest.storage.config.mts](../vitest.storage.config.mts) and `tests/storage/setup.ts` refuse any runtime other than Electron 44.7.0. The Node-safe suite (`npm test`) tests the codec, error mapping and retention policy without native SQLite. What enforces the split:

- **ESLint, statically.** Only `packages/storage/src/sqlite`, `apps/desktop/src/storage-worker.ts` and `tests/storage` may import `better-sqlite3`. The Node-safe set (`tests/unit`, `tests/shared`, every `apps/desktop/src` `.ts` module except the storage worker, and `packages/storage/src/{api,codec,errors,retention,client}.ts` and `worker/protocol.ts`) and the preloads and renderers may also not import the SQLite core, the in-process storage index that re-exports it, the storage worker host (`worker/host.ts`, which runs that index), or `tests/storage`. Relative names inside the package count too: `./index`, `../index`, `./sqlite/…`, `../sqlite/…`, `./host`, `./worker/host` and `../worker/host`, plus the bare directory specifiers `.`, `./`, `..` and `../`; only the storage worker entrypoint may import the host. In the Node-safe set, the preloads and the renderers, `no-restricted-syntax` also reports a dynamic `import()` or a `require()` of any of those modules or of `better-sqlite3` when the module name is a string literal or a template literal without expressions, any call whose first argument is the literal `'better-sqlite3'`, and any `createRequire` call. These selectors are built from the same regular expressions as the import restrictions, so the static and dynamic sets are identical. A computed module name, or a module outside these lists that loads SQLite and is then imported, is not detected statically.
- **Worker and process tests.** `tests/storage/worker.test.ts` drives the bundled worker in a real worker thread through `StorageClient`: open, commits with effects, reads, close with exit code 0 and no WAL left, reopen by a new worker, refused opens (`DATA_PATH_INVALID`, `SCHEMA_NEWER`, `DATABASE_UNRECOGNIZED`, `DATABASE_LOCKED`, `PERMISSION_DENIED`) and command errors as path-free results, and a terminated worker. Every real-worker `StorageClient` in the storage suite whose close is checked (in `worker.test.ts` and `v1-durable-ingestion.test.ts`) uses `TEST_CLOSE_GRACE_MS` (15 s) from `tests/storage/helpers.ts`. The longer grace bounds a hung close, and the suite asserts no close latency. The crash-test child processes keep the default grace, because they are killed and never close. `worker.test.ts` also runs a worker variant that holds the `close` request on the worker thread. With the test grace, a close held 500 ms past the 2 s production default ends clean with exit code 0. A client with the production grace reports that stall as `{clean: false}`. Grace expiry is covered by a close held past a 200 ms grace: the worker is terminated with exit code 1, the close is reported `{clean: false}`, and the reopened database keeps the committed event. `tests/storage/crash-recovery.test.ts` runs [crash-child.cjs](../tests/storage/fixtures/crash-child.cjs) as a separate Electron process and ends it with `TerminateProcess`: inside a commit transaction (in-process `beforeCommit` hook), through the worker after `COMMIT` but before the ack line, and through the worker at five seeded acks. After each kill the database must pass `integrity_check` and `foreign_key_check`, coverage must equal the longest stored prefix and be at least every reported commit, every stored event must have exactly its attribution, every stored gap its completeness interval and every trip its open, close and completeness exactly when the causing rows are stored, and redelivering the whole stream must answer `duplicate` for stored items and complete the rest.
- **The storage suite's runtime check.** `vitest.storage.config.mts` and `tests/storage/setup.ts` fail unless the process is Electron 44.7.0, so the native suite never runs under plain Node. They do not stop a Node-safe test from loading SQLite at run time; that is the lint rule's job, and `vitest.config.mts` includes only `tests/unit`.

`npm run measure:storage` is a separate measurement ([vitest.storage-measure.config.mts](../vitest.storage-measure.config.mts)) with the same runtime check; it is not part of a check suite. Set `ETS2TELEMETRY_MEASURE_REPORT` to an absolute path outside the checkout to keep its JSON report.

Fixtures in [tests/fixtures/storage](../tests/fixtures/storage) are immutable: each `.sqlite` file has the SQL it was created from, `manifest.txt` lists every file's SHA-256, and the representative database's expected content is written by hand. Tests copy fixtures into temporary directories and check that the originals are unchanged. Never regenerate a fixture: add a new one for a new schema version.

## Decisions (October 15, 2026)

The owner delegated the ET-013 design decisions to the coordinator on October 15, 2026; these are coordinator decisions under owner delegation, adopting the architect's recommendations:

| # | Decision |
| --- | --- |
| OD-1 | Two PRs: the storage core with schema, migrations and backups; then the worker integration and measurement |
| OD-2 | PR-2 opens the production database at service start without blocking live telemetry; the ET-001 temporary probe stays the readiness gate |
| OD-3 | Canonical `payload_json` plus normalized columns |
| OD-4 | `user_version` integers, forward-only migrations in one transaction, newer schemas refused without a read-only fallback, `application_id` `ETS2` |
| OD-5 | Keep the three newest verified pre-migration backups per database; no backup for a new database |
| OD-6 | Sample columns as above, REAL float64 copies of float32 values, orientation not stored |
| OD-7 | Zero-padded TEXT uint64 keys in events, gaps and sessions; INTEGER with refusal in samples; money as raw TEXT |
| OD-8 | One writer through `locking_mode = EXCLUSIVE` |
| OD-9 | Typed trip effects applied atomically, on first insert only. Trip references must match the session's game; cross-session references within one game are allowed for the restart close; closed trips accept only completeness and observed-distance updates (added after the PR #51 advisory review) |
| OD-10 | A separate `synthetic` directory with origin enforcement; the ET-001 probe is discarded; unrecognized files are refused |
