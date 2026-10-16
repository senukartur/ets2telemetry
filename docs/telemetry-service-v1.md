# Protocol v1 ingestion in the telemetry service

ET-006b connects the Electron telemetry service to [protocol v1](protocol/v1.md): it validates each v1 connection, keeps service-internal live state, measures the source clock and, when a durable sink is configured, commits events and gap markers before it acknowledges them. Decisions E1–E14 are recorded in [concept.md](../concept.md#et-006b-authorization--october-15-2026); they are coordinator decisions under the owner's delegation of October 15, 2026 and were not individually reviewed by the owner.

Status (October 15, 2026): PR-1 adds the ingestion, the ACK pipeline and the durable sink in `apps/desktop/src` with their tests. PR-2 adds the v1 mode of the native broker. PR-3 connects [telemetry-service.ts](../apps/desktop/src/telemetry-service.ts) to the plugin's v1 endpoint beside v0, **live-only and without a sink**: the service sends a v1 hello with `durableEvents: false`, writes no history and sends no ACK, and the dashboard and overlay stay on v0 ([service wiring](#service-wiring)). Recording and trip effects stay with ET-015a and ET-014. See [ET-006b validation](validation/et-006b.md) for the checks performed.

ET-015a PR-2 (October 16, 2026) adds the [trip recorder](#trip-recorder-et-015a): a durable sink that commits each event or gap together with its ET-014 trip effects in one storage transaction. The FIFO now also carries each durable connection's checkpoint and snapshots, and the ingestion gains durable selections, storage readiness, a receipt label and a split shutdown. The running service is unchanged: it still passes no sink, and game selections stay live-only. The service wiring is ET-015a PR-3; recording real game history needs a separate enablement PR. See [ET-015a validation](validation/et-015a.md#pr-2-the-trip-recorder-in-the-ingestion-pipeline-october-16-2026).

## Components

| Module | Role |
| --- | --- |
| [v1-ingestion.ts](../apps/desktop/src/v1-ingestion.ts) | `V1Ingestion`: one v1 source at a time. Hello, `FrameDecoder` and the ET-002b `V1Consumer`, identity checks, live state, freshness, clock probes, reconnect backoff and the hand-off of events, gaps, the checkpoint and snapshots to the pipeline |
| [v1-durable-delivery.ts](../apps/desktop/src/v1-durable-delivery.ts) | `DurableDelivery`: the storage-commit ACK pipeline. One FIFO for every connection, one sink command in flight, `DurableAckCursor` per welcome, the generation guard on ACK writes and the failure handling |
| [durable-sink.ts](../apps/desktop/src/durable-sink.ts) | The `DurableSink` interface, `StorageDurableSink` (commits without trip effects) over the service's `StorageClient`, the E7 failure table `STORAGE_FAILURE_CLASS` and `failureClass` |
| [trip-recorder.ts](../apps/desktop/src/trip-recorder.ts) | `TripRecorderSink` (ET-015a): the sink that owns the ET-014 `TripState`, steps the reducer at the head of the FIFO and commits each item with its trip effects; `RECORDER_FAILURE_CLASS` |
| [trip-seeds.ts](../apps/desktop/src/trip-seeds.ts) | `readTripSeeds`: the stored open trips of a game as cold-start seeds (ET-015a PR-1) |

All five are Node-safe: they never load native SQLite. Only the storage worker does ([storage](storage.md#storage-worker)).

```text
pipe bytes -> FrameDecoder('server') -> V1Consumer -> identity check -> live state, credit
                                                   \-> checkpoint, snapshots, events, gaps -> DurableDelivery FIFO
                                                         -> sink observe (readings) | sink commit (items) -> DurableAckCursor -> ACK frame
```

## Connection and validation

- **Hello.** One hello per connection with the service's `clientInstanceId` (one UUID per `V1Ingestion`, that is per service process). `durableEvents` is true only when a sink is configured, durable delivery is allowed (below), the selection is one of the `durableSelections` (every selection when the option is omitted) and `durableReady()` reports storage open (always when omitted; R10). It is decided at `connect`, when the hello is written: the native client sets its authority receipt, which names the plugin session, just before it emits `connect`. A live-only connection never sends `ack`.
- **Readiness (R10).** Live delivery never waits for storage: a connection made before storage opens is live-only. `durableAvailabilityChanged()` closes a current live-only connection that could now request durable delivery and reconnects once on the shortest backoff (250 ms) with a durable hello; it changes nothing when durable delivery is still not possible. The service wiring (PR-3) calls it when the database opens.
- **Validation.** Every frame passes the v1 `FrameDecoder` and `V1Consumer`: welcome, then exactly one checkpoint, then snapshots, events, gaps, clock replies and `end`. Any violation closes the connection as `incompatible` without a reconnection until the user selects a source again (E9). A service receive clock that runs backwards closes it the same way with the reason "Receive clock failure". This includes v0 and CAP0 frames, a duplicate or skipped `eventSeq`, an event on a live-only connection, a client message from the server and any frame after `end` in the same read.
- **Identity.** A game selection requires every envelope to equal the native broker's authority receipt (game, process ID, Windows session, process instance, plugin session) with origin `game`. A synthetic or replay selection requires the envelope origin to equal the selection, and the endpoint must match `TEST_PIPE_PATTERN_V1`, a desktop-local copy of the simulator's `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}` pattern (a test checks that the two stay identical).
- **Game connections.** `V1Ingestion` has no default native client: a game selection without the `connectGame` option or a broker configuration stays `unavailable`. The telemetry service supplies the broker's v1 mode ([service wiring](#service-wiring)).
- **Credit (E5).** The broker relays one frame per credit. Each frame is decoded, validated and applied synchronously, and its event or gap is queued, before the listener returns and the credit is granted. A credit never waits for storage.

## Live state (E2)

`V1SourceState` is service-internal. Since ET-010c only its whitelisted live projection leaves the service (see [Live projection](#live-projection-et-010c)); the clock mapping, the last `end`, the delivery cursor, continuity and durable status never do. The v0-retirement PR switches the live path.

| Field | Meaning |
| --- | --- |
| `status`, `reason`, `fresh` | `waiting`, `connected`, `paused`, `stale`, `disconnected`, `incompatible` or `unavailable`, with a fixed reason text |
| `observation` | The latest checkpoint or snapshot: source, `seq`, capture, state, status (delivery cursor, loss counters, game mode), continuity, `hydration` (true for the checkpoint) and the receive time |
| `clockMapping` | The local source-to-service clock mapping, when measured |
| `lastEnd` | The last `end` received, kept across reconnections |
| `durable` | `off` (no sink), `pending`, `active` or `failed` with a fixed code |

- **Hydration.** A checkpoint replaces current state only. Its job, truck and trailer configuration never become an event, a commit or an ACK (REG-003, REG-004). A welcome alone is never fresh.
- **Freshness.** The receive time advances only when `state.boundaryOrder` advances (OD-5 S7), on the service's monotonic receive clock. The state is `stale` 500 ms after the last new boundary, `paused` when a fresh state reports a paused simulation, and `waiting` when the simulation is unavailable.

## Reconnection (E9)

| Event | Status | Next |
| --- | --- | --- |
| Hello or checkpoint not received within 5 s | `disconnected` | Reconnect |
| EOF or close | `disconnected` | Reconnect |
| `end` (`plugin-shutdown`, `sequence-exhausted`, `source-retired`) | `disconnected`, `lastEnd` kept | Reconnect; a retired session finds no discovery record and waits |
| Broker exit 2 (no discovery record) | `waiting` | Reconnect |
| Broker startup deadline or exit 4 before any receipt (transient) | `waiting` | Reconnect |
| Retryable durable failure, `ACK_AHEAD_OF_STORAGE`, durable unavailable | `disconnected` | Reconnect (durable, or live-only) |
| Schema, order or identity violation; other broker rejections | `incompatible` | None until a new selection |

Reconnection delays are 250, 500, 1000, 2000 and then 4000 ms. They restart only once a connection proves healthy: a live-only connection at its hydrated checkpoint, a durable connection at its first successful commit. A persistent retryable storage failure, which closes each durable connection before its first commit, therefore keeps backing off instead of making the plugin redeliver its retained store every 250 ms. A reconnection waits for the previous broker process to exit.

## Clock probes (E10)

After each checkpoint the ingestion sends one `clock.probe`, then at most one per second while no probe is outstanding. `V1Consumer.expectClockReply` registers each probe before it is written, with IDs 1, 2, 3, … per connection. The client clock is injectable (`nowNs`, default `process.hrtime.bigint`) with one `clientClockId` per service. `computeClockMapping` turns a reply into `ClockMapping`; a reply more than 1 s after its probe gives no mapping, still ends the outstanding probe, and only then may the next probe be sent. A mapping whose source clock differs from a new welcome's capture clock is dropped. The mapping never leaves the service and never mixes the source clock with the service clock (§11).

## Storage-commit ACK pipeline (E5–E8)

- **Queue (E5, R5).** Events and gaps of every connection enter one FIFO in stream order, together with each durable connection's checkpoint and snapshots (readings). One sink command runs at a time. At most 256 coverage items are queued or in flight; one more closes its connection as retryable with `BACKLOG_FULL`, drops that connection's queued work, and the producer redelivers after the reconnection. Snapshots are queued only for a sink with `observe` and count against their own bound, `MAX_PENDING_READINGS` = 512 (more than 25 s at 20 Hz, above the 10 s storage deadline that fails the worker): the 513th closes the connection the same way. Readings never count against the 256 items, so snapshots cannot starve events, and they are never coalesced or thinned, because that would change the reading holes and jumps the reducer sees (T17).
- **Transient refusal of a redelivery.** The 256-item bound has no slack above the producer's 256 retained entries. Items still queued, and the one in flight, from a connection that has already ended keep counting until they leave the FIFO. A reconnection's redelivery of up to 256 retained entries can therefore exceed the bound and be closed with `BACKLOG_FULL`, once or a few times while the earlier work drains across the backoff steps. Even with nothing left over, a redelivery of all 256 entries is refused when one live item (for example a gap that extends the trailing record) arrives before its first commit finishes. This is not a livelock. The leftover items only drain, nothing refills them, and each later attempt commits at least its item in flight. Production passes no sink, so ET-015a PR-2 leaves the bound unchanged; the decision is on the enablement checklist ([Pending](#pending)).
- **Readings (R5).** At the head of the FIFO the sink's `observe` runs synchronously: the checkpoint (after it started the cursor) and each snapshot reach the recorder at their place among the commits, so a reading that arrives while a commit is in flight waits for that commit's result. A refused reading stops durable delivery like a failed commit.
- **Receipt label (R8).** The ingestion reads its UTC clock (`utcNow`, default `Date.now`) when an event or gap frame is decoded and passes the value with the item; the sink receives it as `commit(message, {receivedUtcMs})`. A slow commit therefore never shifts the label the reducer uses for a session without UTC labels (T15).
- **Cursor (E6).** At each durable welcome the pipeline queues `openSession` behind earlier work. `openSession` stores the session (`upsertSession`) and returns the stored contiguous coverage C, and a new `DurableAckCursor(pluginSessionId, C)` starts. The checkpoint's `ackedThroughEventSeq` A begins the connection. If A > C (for example a restored database), durable delivery stops for that plugin session with `ACK_AHEAD_OF_STORAGE`: the ingestion reconnects live-only, and a live-only welcome of another plugin session lifts the block and reconnects durable.
- **Restore loss (R9).** Before that connection closes, the pipeline awaits the sink's optional `restoreLoss(pluginSessionId, C, A)`. The recorder stores one session-level completeness interval `{kind: 'restore-loss', firstEventSeq: C + 1, lastEventSeq: A, detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq: C, ackedThroughEventSeq: A}}` with `recordCompleteness(..., {ifAbsent: true})`, so a service restart in the same plugin session adds no second row. `V1_DURABLE_RESTORE_LOSS {code}` is logged with `RECORDED` or the failure code; a failure does not unblock the session. The plugin session stays live-only until it ends (E6); its open trip closes as `restart` at the next plugin session of that game.
- **Commit.** Each item is `cursor.received` and then committed by the sink. `committed`, `duplicate` and `covered` commit the range in the cursor. `conflict` keeps the stored row (§9); the key counts as committed and `V1_EVENT_CONFLICT` is logged at counts 1, 2, 4, 8, …. After every commit the storage's `committedThroughEventSeq` must equal the cursor's `throughEventSeq`; otherwise durable delivery fails with `COVERAGE_MISMATCH` and nothing is acknowledged.
- **ACK (E8).** `cursor.ack()` runs only after the commit, and its frame is written only while the connection that received the coverage is current, open and before `end`. A commit that finishes after a disconnect or `end` writes nothing; the next connection acknowledges the range again once it has been redelivered (§10). Receipt, parsing or validation is never grounds for an ACK.
- **Stop.** `stop()` drops queued work, waits for the one command in flight and writes nothing afterwards; a session open that completes after it changes no status.
- **Ingestion stop (R14).** `V1Ingestion.stop()` is split into `stopSource()`, which ends the source and waits for the owned broker process (the intake phase; nothing is acknowledged afterwards), and `flush()`, which is the pipeline's `stop()`. `stop()` runs both in order. Queued commits are dropped, not drained: the producer retains and redelivers them, and no ACK could be written after the source closed. The service registers the two steps in PR-3.

### Failure classes (E7)

`STORAGE_FAILURE_CLASS` lists every `StorageErrorCode` in [packages/storage](../packages/storage/src/api.ts), so a new code fails to compile until it is classified. A rejected sink promise or a malformed result is `INTERNAL`.

| Class | Codes | Behavior |
| --- | --- | --- |
| Retryable | `DATABASE_LOCKED`, `DISK_FULL`, `IO_ERROR`, `STORAGE_BUSY` | No ACK. The connection closes, its queued work is dropped and it reconnects durable on the backoff; the producer keeps what it has not seen acknowledged (5 minutes of disconnect retention). `V1_DURABLE_RETRY {code, count}` is logged at counts 1, 2, 4, 8, … per code |
| Unavailable for the service lifetime | `WORKER_FAILED`, `TIMEOUT`, `CONSTRAINT_VIOLATION`, `SESSION_CONFLICT`, `INVALID_INPUT`, `INTERNAL`, `PERMISSION_DENIED`, `DATABASE_CORRUPT`, `UNKNOWN_SESSION`, `UNKNOWN_TRIP`, `VALUE_OUT_OF_RANGE`, `STORAGE_CLOSED`, `DATA_PATH_INVALID`, `DATABASE_UNRECOGNIZED`, `SCHEMA_NEWER`, `PURPOSE_MISMATCH`, `DURABILITY_UNVERIFIED`, `BACKUP_FAILED`, `MIGRATION_FAILED`; pipeline codes `COVERAGE_MISMATCH` and `INTERNAL` | No ACK. Every queued item is dropped, the connection closes and reconnects live-only. `V1_DURABLE_UNAVAILABLE {code}` is logged once; `durable` reports `failed` with the code |

Storage marks `TIMEOUT` retryable, but a missed deadline fails the `StorageClient` closed and every later command gets `WORKER_FAILED`, so the pipeline treats it as unavailable. `CONSTRAINT_VIOLATION` includes a session whose origin the database purpose refuses, such as a synthetic source in history.

The trip recorder adds three sink codes, `TRIP_ORDER_VIOLATION`, `TRIP_COVERAGE_MISMATCH` and `TRIP_UNKNOWN_SESSION`, for a reducer result `ok: false` (R7). They are contract defects between the stream, storage and the reducer, so `RECORDER_FAILURE_CLASS` makes every one `unavailable` and `failureClass` consults it after the storage table; they are logged through `V1_DURABLE_UNAVAILABLE {code}`. A code that is neither a storage nor a recorder code is never retried.

## Durable sink (E1)

`StorageDurableSink` maps `openSession` to `upsertSession({message: welcome})` and `commit` to `commitEvent` or `commitGap` with the validated message, without trip effects. Its optional effects hook was removed in ET-015a (S-3): a synchronous hook got no commit result, so it could not adopt the reducer state only after the commit (T3). The trip recorder below replaces it.

The durable path is proven only against temporary synthetic-purpose databases in tests. Production passes no sink: the hello requests `durableEvents: false`, nothing is written to history and nothing is acknowledged. Committing to history with empty effects was rejected (E1): effects apply on first insert only, so such rows could never receive trips.

## Trip recorder (ET-015a)

`TripRecorderSink` (R2) implements `DurableSink` over the storage client and owns the reducer state. `DurableDelivery` stays the only FIFO and the only single-in-flight scheduler; the recorder adds no queue of its own. It follows the [caller contract](trips.md#caller-contract-for-et-015a):

| Sink member | What the recorder does |
| --- | --- |
| `openSession(welcome)` | `upsertSession` returns the stored coverage C. When the reducer knows no session of the welcome's game (`games[game].sessionId === null`, the first durable welcome per game in the recorder's lifetime; R15), it reads that game's stored open trips with `readTripSeeds` (R4). When the reducer still has a connection, it steps `disconnected` first (R6): the interval comes from the session's last item and reading, not from when the step runs, and the old connection's queued work preceded this welcome in the FIFO. Then it steps `session` with C and the seeds |
| `commit(message, {receivedUtcMs})` | Reads `committedThrough()`, steps the event or gap, commits it with the returned effects in one transaction and adopts the stepped state only on `committed`, `duplicate`, `covered` or `conflict` (T3). A retryable failure keeps the state, so the redelivered item is stepped from it again (R7). A gap whose `previouslyCoveredThrough` differs from the coverage read before the commit, or is missing, is not adopted and fails with `TRIP_COVERAGE_MISMATCH`. This is detection after the commit, not prevention: the gap row and its effects are already stored. Durable delivery stops (no ACK, live-only), and a later cold start seeds from those rows. Under the single-writer rule it should never happen; the mismatch is on the enablement list ([Pending](#pending)) |
| `observe(message)` | A checkpoint steps `checkpoint` and then its state as a reading; a snapshot steps a reading. The state is normalized with `normalizeV1State`, as the trip replay does |
| `restoreLoss(session, C, A)` | The `restore-loss` interval above, with `ifAbsent` (R9) |
| `view(game)` | The read-only `tripView` of the adopted state, for ET-015b's sample trip UUIDs (R17) |

A `conflict` result is adopted, as T3 says (R16). Ingestion commits contiguously, so a conflict can only hit an eventSeq at or below the coverage, where the reducer is a no-op; any later divergence fails closed through storage's `UNKNOWN_TRIP`. An `unavailable` failure stops durable delivery for the service lifetime, so the recorder is no longer called; the next service start cold-starts from seeds.

## Service wiring

PR-3 (E2, E9, E12) runs one `V1Ingestion` in the telemetry service beside the v0 `TelemetryIngestion`:

- **Live-only (E2).** The service passes no durable sink. Every hello asks for `durableEvents: false`, so the plugin copies no event and counts each one it observes as `noDurableConsumer` loss (OD-4); the service sends no ACK and writes no history row, and `durable` stays `off`. Clock probes run as described above. `V1SourceState` stays inside the service; since ET-010c its whitelisted projection rides on the live update (see [Live projection](#live-projection-et-010c)).
- **Selection.** Each `select` command, after the v0 ingestion has accepted it, also selects the same source for v1. A v1 failure is logged as `V1_SELECT_REJECTED` and never fails the v0 selection.
- **Game sources.** Only through the verified native broker in its v1 mode (`--protocol v1`), started by `NativePipeClient` in v1 mode ([native broker control](telemetry-service-v0.md#protocol-v1-mode)). The client accepts only the six-key receipt marked `protocolMajor: 1` and rejects a v0 receipt, and a v0 client rejects a v1 receipt. It sends the hello raw and every later client frame (`clock.probe` here; `ack` only with a sink) as tag `0x02` followed by the frame, apart from the `0x01` credits. A client frame whose length prefix does not match it or whose payload is outside 1–4,096 bytes closes the connection with the outcome `client-frame-rejected` before anything reaches the broker. The broker stages `client-frame` and `client-write` are known stage names. No Node code opens a game pipe.
- **Discovery directory (E12).** The v1 directory is derived from the validated v0 broker configuration that main sends with a selection: a directory named `v0` under a parent named `transport` gives its sibling `v1` (`%LOCALAPPDATA%\ETS2Telemetry\transport\v1`) with the same verified executable. Any other shape gives no configuration, so a v1 game source stays `unavailable` instead of guessing a directory. The main-to-service message is unchanged.
- **Fixtures.** A `synthetic` or `replay` selection connects v1 only to `ETS2TELEMETRY_SOURCE_PIPE_V1`, which must match `TEST_PIPE_PATTERN_V1`; without it v1 is `unavailable`. The envelope origin must equal the selection.
- **Two brokers.** A game selection now runs two broker processes, one per protocol, each with its own directory, policy and lock. A v1 broker that finds no `transport\v1` directory (a plugin without v1) reports `waiting` and exits 2; the ingestion retries on the backoff above.
- **Shutdown.** The `v1-ingestion` step runs in the `intake` phase beside `ingestion` and `capture` with a 1,000 ms budget; it ends the source and waits for the broker process. The phase maxima are unchanged: 1,000 ms for `intake`, none registered for `flush` and 1,000 ms for `storage`, 2,000 ms in total against `SERVICE_STOP_BUDGET_MS` of 2,500 ms.

## Live projection (ET-010c)

The service keeps the latest v0 update and the latest v1 projection and publishes `withV1(v0, v1)` through the existing live subscriptions, which coalesce to at most 20 Hz (decision F1). The projection ([live-v1.ts](../apps/desktop/src/live-v1.ts), `liveV1Projection`) is an explicit whitelist (F2):

| Field | Content |
| --- | --- |
| `selection`, `status`, `reason`, `fresh` | As in `V1SourceState` |
| `observation.source`, `seq`, `capture` | The latest checkpoint's or snapshot's envelope fields |
| `observation.state` | The wire state's keys except `window` (fifteen of sixteen), listed one by one, so a new wire key never leaks by default |
| `observation.sourceStatus` | `gameMode` and `eventLoss` only; never the delivery cursor |
| `observation.receivedMonotonicMs`, `hydration` | The service receive time (advances only with a new SDK boundary) and the checkpoint flag |

It never carries the window or its handle, the message kind, continuity, the clock mapping, the last `end` or durable status. The projection is attached only to a v0 update of the same selection. The service republishes only for a change the projection shows: the selection, status, reason, freshness or a new observation object; a clock mapping or durable status update alone republishes nothing.

Main validates the projection in the upstream handler, before freshness and the overlay see it, and the dashboard preload validates it again (`parseLiveV1`: exact keys, the update's selection, one of the seven v1 statuses, a reason of 1–256 characters without control characters, `fresh` only with an observation and a `connected` or `paused` status, and `validateLiveObservationV1`, which applies the wire state rules and rejects a window). An invalid projection is stripped and the v0 update kept; main logs `LIVE_V1_REJECTED {count}` at occurrences 1, 2, 4, 8, … and never closes the channel for it. Main and the preload expire the projection 500 ms after its last new receipt key (plugin session, process instance, capture clock, SDK boundary and receipt time), independently of v0 (F3). Display rules are in [live telemetry fields](live-telemetry-fields.md#protocol-v1-rows-et-010c).

## Diagnostics

Fixed codes and numbers only, through the `diagnose` option: `V1_DURABLE_RETRY {code, count}`, `V1_DURABLE_UNAVAILABLE {code}` (including the recorder codes), `V1_DURABLE_ACK_AHEAD {code}`, `V1_DURABLE_RESTORE_LOSS {code}` (ET-015a: `RECORDED` or the failure code) and `V1_EVENT_CONFLICT {count}`; production has no sink, so they do not occur there. The telemetry service adds `V1_SOURCE_STATUS {status, selection, durable, count}`, logged when the status changes, at occurrences 1, 2, 4, 8, … of each status, so a reconnection loop cannot fill the bounded log; `NATIVE_BROKER_V1_EXIT` with the same fixed facts and coalescing as the v0 `NATIVE_BROKER_EXIT`; and `V1_SELECT_REJECTED`. No message content, identifiers or paths are logged.

## Tests

| File | Boundary |
| --- | --- |
| `tests/unit/v1-durable-delivery.test.ts` | Every durable accepted stream of the shared protocol v1 fixtures replayed through the pipeline with an in-memory storage stand-in and the producer-side `AckValidator`; ACK order, the generation guard, conflict and covered redelivery, every E7 class, `COVERAGE_MISMATCH`, `ACK_AHEAD_OF_STORAGE`, the 256-item backlog and stop; ET-015a: readings observed at their place in the FIFO, none queued without `observe`, a refused reading, the 512-reading bound, the receipt label and the restore-loss call before the ACK-ahead close, and `StorageDurableSink` without effects |
| `tests/unit/v1-ingestion.test.ts` | Fake sockets and fake timers: hello, hydration, freshness, fail-closed validation, game authority, backoff, `end`, clock probes and mapping values, ACK wiring, durable failures and `stop()`; ET-015a: durable selections and readiness with `durableAvailabilityChanged()`, readings and receipt labels handed to the sink, and `stopSource()` before `flush()` |
| `tests/unit/v1-ingestion-pipe.test.ts` | Actual Windows pipes against `serveV1Reactive`: eight corpus scenarios checked with `reactiveDifferences` and the hand-written ledgers |
| `tests/storage/v1-durable-ingestion.test.ts` | The bundled storage worker, `StorageClient` and `StorageDurableSink` under Electron, against the reactive simulator: hand-written rows and ACKs, a restart with a new worker, a terminated worker |
| `tests/storage/v1-ingestion-crash.test.ts` | A child process with the bundled ingestion and worker terminated at commit barriers, then a new process on the same database |
| `tests/unit/native-pipe-client.test.ts` | The broker's v1 mode with a mocked child process: spawn arguments, the six-key receipt and the rejected v0/v1 receipt mix, the raw hello, tagged client frames and their bounds, the new stages, the E12 directory derivation, and `V1Ingestion` through the v1 client (a hello with `durableEvents: false`, a tagged probe, credits, no ACK) |
| `tests/unit/telemetry-service-v0.test.ts` | The service entry point with a recorded `V1Ingestion` stand-in: no sink, the selection followed with the fixture endpoint and the derived directory, isolation from the v0 selection, the coalesced status log and the bounded `v1-ingestion` shutdown step; since ET-010c the projection on the live update of the same selection and no republish for a clock mapping alone |
| `tests/unit/live-v1.test.ts` | ET-010c: the projection whitelist, `parseLiveV1` and `validateLiveObservationV1` rejections, `withV1` and the receipt key |
| `tests/unit/live-smoke-source-v1.test.ts` | ET-010c: the synthetic v1 smoke source over an actual Windows pipe through `V1Ingestion`: hydration, stale while held on the same connection, disconnect on stop |
| `tests/unit/trip-recorder.test.ts` (ET-015a) | `V1Ingestion`, the pipeline and `TripRecorderSink` with fake sockets over an async adapter of the trip-replay storage model: adoption after the commit, a retryable failure keeping the state, readings behind a commit in flight, the lazy disconnection, a cold start from seeds, a reducer violation going live-only, one restore-loss row across lifetimes, the 513th reading and the receipt label |
| `tests/storage/trip-recorder.test.ts` (ET-015a, S2) | The recorder and the real storage worker against the reactive simulator: ten scenarios against their hand-written trip expectations, every ACK at or below the reported coverage |
| `tests/storage/trip-recorder-crash.test.ts` (ET-015a, S3) | Recording processes terminated before, after and inside a commit transaction and at fixed commit counts, then a cold-started process on the same database |
| `tests/storage/trip-recorder-faults.test.ts` (ET-015a, S4) | `SQLITE_FULL`, `SQLITE_READONLY` and `SQLITE_BUSY` injected inside the real transaction by the fault worker, and a held commit against a backlog bound of four |
| `tests/integration/v1-chain.test.ts` (`npm run test:v1-chain`) | E14: the fake-SDK host and the test plugin DLL with the real broker in v1 mode; the broker-provisioned policy, an ACK from a test-level durable driver releasing entries, and `V1Ingestion` failing closed on the synthetic origin under game authority |

Expected values are written by hand from the specification, the shared fixtures and the simulator expectations. Timing never decides an outcome: the backlog and barriers are counted in items and commits, unit tests use controlled clocks, and real-time waits are liveness bounds.

## Pending

Real games (ETS2 and ATS, single-player and TruckersMP): the broker v1 authority with the production DLL, the coexistence of the v0 and v1 policies, the QPC-to-`process.hrtime` mapping, event rates against the bounds and the cost of a second connection and a second broker process. The packaged broker v1 mode in an installed application. The service wiring of the trip recorder, durable selections, readiness and the `recording-flush` step (ET-015a PR-3), and the recording runtime journey (PR-4). Recording real game history, which waits for the enablement PR after the v0 retirement, real-game v1 evidence, ET-015b, ET-015c and the S-1/S-2 decision. Real event and snapshot rates against the 256-item and 512-reading bounds, and the CPU cost of a reducer step per reading. Before enablement, decide whether the coverage-item bound must exceed the producer's retention, or whether queued items of connections that are no longer current stop counting against it, so a redelivery is never refused transiently. Also before enablement, decide whether a `TRIP_COVERAGE_MISMATCH` gap must be prevented before its commit instead of detected after it; the check finds the mismatch only once the gap and its effects are stored. Second-user and remote-client rejection. One-hour stability (REG-018). Convoy is deferred.
