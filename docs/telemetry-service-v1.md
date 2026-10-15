# Protocol v1 ingestion in the telemetry service

ET-006b connects the Electron telemetry service to [protocol v1](protocol/v1.md): it validates each v1 connection, keeps service-internal live state, measures the source clock and, when a durable sink is configured, commits events and gap markers before it acknowledges them. Decisions E1–E14 are recorded in [concept.md](../concept.md#et-006b-authorization--october-15-2026); they are coordinator decisions under the owner's delegation of October 15, 2026 and were not individually reviewed by the owner.

Status (October 15, 2026): PR-1 adds the ingestion, the ACK pipeline and the durable sink in `apps/desktop/src` with their tests. **Nothing is wired into the running service yet.** [telemetry-service.ts](../apps/desktop/src/telemetry-service.ts) still runs only the v0 ingestion, sends no v1 hello, writes no history and sends no ACK. PR-2 adds the v1 mode of the native broker; PR-3 connects the service to the plugin's v1 endpoint, live-only and without a sink. Recording and trip effects stay with ET-015a and ET-014. See [ET-006b validation](validation/et-006b.md) for the checks performed.

## Components

| Module | Role |
| --- | --- |
| [v1-ingestion.ts](../apps/desktop/src/v1-ingestion.ts) | `V1Ingestion`: one v1 source at a time. Hello, `FrameDecoder` and the ET-002b `V1Consumer`, identity checks, live state, freshness, clock probes, reconnect backoff and the hand-off of events and gaps to the pipeline |
| [v1-durable-delivery.ts](../apps/desktop/src/v1-durable-delivery.ts) | `DurableDelivery`: the storage-commit ACK pipeline. One FIFO for every connection, one sink command in flight, `DurableAckCursor` per welcome, the generation guard on ACK writes and the failure handling |
| [durable-sink.ts](../apps/desktop/src/durable-sink.ts) | The `DurableSink` interface, `StorageDurableSink` over the service's `StorageClient` and the E7 failure table `STORAGE_FAILURE_CLASS` |

All three are Node-safe: they never load native SQLite. Only the storage worker does ([storage](storage.md#storage-worker)).

```text
pipe bytes -> FrameDecoder('server') -> V1Consumer -> identity check -> live state, credit
                                                   \-> events and gaps -> DurableDelivery FIFO -> sink commit -> DurableAckCursor -> ACK frame
```

## Connection and validation

- **Hello.** One hello per connection with the service's `clientInstanceId` (one UUID per `V1Ingestion`, that is per service process). `durableEvents` is true only when a sink is configured and durable delivery is allowed (below). It is decided at `connect`, when the hello is written: the native client sets its authority receipt, which names the plugin session, just before it emits `connect`. A live-only connection never sends `ack`.
- **Validation.** Every frame passes the v1 `FrameDecoder` and `V1Consumer`: welcome, then exactly one checkpoint, then snapshots, events, gaps, clock replies and `end`. Any violation closes the connection as `incompatible` without a reconnection until the user selects a source again (E9). A service receive clock that runs backwards closes it the same way with the reason "Receive clock failure". This includes v0 and CAP0 frames, a duplicate or skipped `eventSeq`, an event on a live-only connection, a client message from the server and any frame after `end` in the same read.
- **Identity.** A game selection requires every envelope to equal the native broker's authority receipt (game, process ID, Windows session, process instance, plugin session) with origin `game`. A synthetic or replay selection requires the envelope origin to equal the selection, and the endpoint must match `TEST_PIPE_PATTERN_V1`, a desktop-local copy of the simulator's `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}` pattern (a test checks that the two stay identical).
- **Game connections.** PR-1 has no default native client: a game selection without the `connectGame` option stays `unavailable`. PR-3 supplies the broker's v1 mode.
- **Credit (E5).** The broker relays one frame per credit. Each frame is decoded, validated and applied synchronously, and its event or gap is queued, before the listener returns and the credit is granted. A credit never waits for storage.

## Live state (E2)

`V1SourceState` is service-internal: no preload, IPC or renderer receives it, and the dashboard and overlay stay on v0. ET-010c exposes it, and the v0-retirement PR switches the live path.

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

- **Queue (E5).** Events and gaps of every connection enter one FIFO in stream order. One sink command runs at a time. At most 256 coverage items are queued or in flight; one more closes its connection as retryable with `BACKLOG_FULL`, drops that connection's queued work, and the producer redelivers after the reconnection.
- **Cursor (E6).** At each durable welcome the pipeline queues `openSession` behind earlier work. `openSession` stores the session (`upsertSession`) and returns the stored contiguous coverage C, and a new `DurableAckCursor(pluginSessionId, C)` starts. The checkpoint's `ackedThroughEventSeq` A begins the connection. If A > C (for example a restored database), durable delivery stops for that plugin session with `ACK_AHEAD_OF_STORAGE`: the ingestion reconnects live-only, and a live-only welcome of another plugin session lifts the block and reconnects durable. ET-015a defines the `restore-loss` marker.
- **Commit.** Each item is `cursor.received` and then committed by the sink. `committed`, `duplicate` and `covered` commit the range in the cursor. `conflict` keeps the stored row (§9); the key counts as committed and `V1_EVENT_CONFLICT` is logged at counts 1, 2, 4, 8, …. After every commit the storage's `committedThroughEventSeq` must equal the cursor's `throughEventSeq`; otherwise durable delivery fails with `COVERAGE_MISMATCH` and nothing is acknowledged.
- **ACK (E8).** `cursor.ack()` runs only after the commit, and its frame is written only while the connection that received the coverage is current, open and before `end`. A commit that finishes after a disconnect or `end` writes nothing; the next connection acknowledges the range again once it has been redelivered (§10). Receipt, parsing or validation is never grounds for an ACK.
- **Stop.** `stop()` drops queued work, waits for the one command in flight and writes nothing afterwards; a session open that completes after it changes no status.

### Failure classes (E7)

`STORAGE_FAILURE_CLASS` lists every `StorageErrorCode` in [packages/storage](../packages/storage/src/api.ts), so a new code fails to compile until it is classified. A rejected sink promise or a malformed result is `INTERNAL`.

| Class | Codes | Behavior |
| --- | --- | --- |
| Retryable | `DATABASE_LOCKED`, `DISK_FULL`, `IO_ERROR`, `STORAGE_BUSY` | No ACK. The connection closes, its queued work is dropped and it reconnects durable on the backoff; the producer keeps what it has not seen acknowledged (5 minutes of disconnect retention). `V1_DURABLE_RETRY {code, count}` is logged at counts 1, 2, 4, 8, … per code |
| Unavailable for the service lifetime | `WORKER_FAILED`, `TIMEOUT`, `CONSTRAINT_VIOLATION`, `SESSION_CONFLICT`, `INVALID_INPUT`, `INTERNAL`, `PERMISSION_DENIED`, `DATABASE_CORRUPT`, `UNKNOWN_SESSION`, `UNKNOWN_TRIP`, `VALUE_OUT_OF_RANGE`, `STORAGE_CLOSED`, `DATA_PATH_INVALID`, `DATABASE_UNRECOGNIZED`, `SCHEMA_NEWER`, `PURPOSE_MISMATCH`, `DURABILITY_UNVERIFIED`, `BACKUP_FAILED`, `MIGRATION_FAILED`; pipeline codes `COVERAGE_MISMATCH` and `INTERNAL` | No ACK. Every queued item is dropped, the connection closes and reconnects live-only. `V1_DURABLE_UNAVAILABLE {code}` is logged once; `durable` reports `failed` with the code |

Storage marks `TIMEOUT` retryable, but a missed deadline fails the `StorageClient` closed and every later command gets `WORKER_FAILED`, so the pipeline treats it as unavailable. `CONSTRAINT_VIOLATION` includes a session whose origin the database purpose refuses, such as a synthetic source in history.

## Durable sink (E1)

`StorageDurableSink` maps `openSession` to `upsertSession({message: welcome})` and `commit` to `commitEvent` or `commitGap` with the validated message. An optional effects hook (ET-014 and ET-015a fill it; the default supplies none) receives the session's coverage, read with `committedThrough()` right before the commit as the storage caller rule requires. Storage applies effects only on the first insert of a row ([storage](storage.md#storage-api)).

The durable path is proven only against temporary synthetic-purpose databases in tests. Production passes no sink: the hello requests `durableEvents: false`, nothing is written to history and nothing is acknowledged until ET-015a supplies trip effects and the v0-retirement PR lands. Committing to history now with empty effects was rejected (E1): effects apply on first insert only, so such rows could never receive trips, and recording would start before ET-015a.

## Diagnostics

Fixed codes and numbers only, through the `diagnose` option: `V1_DURABLE_RETRY {code, count}`, `V1_DURABLE_UNAVAILABLE {code}`, `V1_DURABLE_ACK_AHEAD {code}` and `V1_EVENT_CONFLICT {count}`. No message content, identifiers or paths are logged.

## Tests

| File | Boundary |
| --- | --- |
| `tests/unit/v1-durable-delivery.test.ts` | Every durable accepted stream of the shared protocol v1 fixtures replayed through the pipeline with an in-memory storage stand-in and the producer-side `AckValidator`; ACK order, the generation guard, conflict and covered redelivery, every E7 class, `COVERAGE_MISMATCH`, `ACK_AHEAD_OF_STORAGE`, the 256-item backlog and stop |
| `tests/unit/v1-ingestion.test.ts` | Fake sockets and fake timers: hello, hydration, freshness, fail-closed validation, game authority, backoff, `end`, clock probes and mapping values, ACK wiring, durable failures and `stop()` |
| `tests/unit/v1-ingestion-pipe.test.ts` | Actual Windows pipes against `serveV1Reactive`: eight corpus scenarios checked with `reactiveDifferences` and the hand-written ledgers |
| `tests/storage/v1-durable-ingestion.test.ts` | The bundled storage worker, `StorageClient` and `StorageDurableSink` under Electron, against the reactive simulator: hand-written rows and ACKs, a restart with a new worker, a terminated worker |
| `tests/storage/v1-ingestion-crash.test.ts` | A child process with the bundled ingestion and worker terminated at commit barriers, then a new process on the same database |

Expected values are written by hand from the specification, the shared fixtures and the simulator expectations. Timing never decides an outcome: the backlog and barriers are counted in items and commits, unit tests use controlled clocks, and real-time waits are liveness bounds.

## Pending

Real games (ETS2 and ATS, single-player and TruckersMP): the broker v1 authority with the production DLL, the QPC-to-`process.hrtime` mapping, event rates against the bounds and the cost of a second connection in the game process. The native broker v1 mode (PR-2) and the service wiring (PR-3). The production durable path, history commits, trip effects and the `restore-loss` marker (ET-015a). Second-user and remote-client rejection. One-hour stability (REG-018). Convoy is deferred.
