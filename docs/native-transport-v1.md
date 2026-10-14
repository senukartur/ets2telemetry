# Native protocol v1 producer

ET-004b implements the plugin side of [protocol v1](protocol/v1.md) in three pull requests:

1. **Producer core** (PR A, merged as `f6829fc`): the copied event records, the encoder and the retained event store. They are SDK-free and I/O-free.
2. **Callback capture** (this revision): the SDK-thread handoff that assigns `eventSeq` and copies records without blocking, and the v1 state slot. The plugin DLL compiles it, but nothing attaches an event channel yet, so it is inert in production.
3. **Endpoint**: the v1 pipe, handshake, live loop and shutdown.

The endpoint pull request extends this document. The v0 endpoint, its wire format and the desktop application are unchanged. Nothing here establishes game, TruckersMP, display or performance support.

## Components

| File | Contents |
| --- | --- |
| [protocol-v1-records.hpp](../native/telemetry-plugin/src/protocol-v1-records.hpp) | Trivially copyable records: `EventRecord` (eventSeq, occurrence and a variant of the 17 record bodies), `StatePod`, `ConfigurationPod`, `SourcePod`, `GameModePod` and fixed-size text |
| [protocol-v1-producer.hpp](../native/telemetry-plugin/src/protocol-v1-producer.hpp) | `Encoder`: builds every server message from the records and the store, then validates and frames it with the ET-002b `v1::encode_frame`. `ingest_event` measures and admits one event |
| [protocol-v1-store.hpp](../native/telemetry-plugin/src/protocol-v1-store.hpp) | `EventStore`: the retained entries of one plugin session, its loss counters and the outbound cursor |
| [event-channel.hpp](../native/telemetry-plugin/src/event-channel.hpp) | `EventChannel`: the lock-free handoff ring from the SDK callback thread to the transport worker, its gate and the loss runs |
| [sdk-adapter.hpp](../native/telemetry-plugin/src/sdk-adapter.hpp) | `attach_events`, the v1 records built in the SDK callbacks, and the v1 state slot `V1Current`, read with `read_v1_current` |

The transport worker owns the encoder and the store. Both are single-threaded, never block and take every time as an explicit argument in the source monotonic clock. The store allocates its 256 entries once, at construction.

### Records

Records keep SDK units: speed in m/s, fuel in L, odometer and range in km, consumption in L/km, planned distance in u32 km, delivered distance as an SDK float in km, game time in u32 minutes and money as raw s64 or u64. The encoder applies the [§6 mapping](protocol/v1.md#6-units-and-sdk-mapping) and marks a non-finite or out-of-range reading `invalid`.

- Every value carries its availability. Zero-initialized storage reads as `not-observed`, never as an available zero.
- Text is copied into fixed buffers of 128 bytes for identifiers and 256 bytes for names. A copy reads at most one byte past the limit, so an unterminated SDK string is never scanned further. A longer value becomes `invalid`, never truncated. The encoder checks UTF-8, C0 and DEL characters (D12).
- In configuration, slot *i* of an available trailer is written with index *i*. The wire always carries all ten trailer slots, and an empty slot is unavailable (OD-6).
- Money takes its currency from the session (`SessionIdentity::currency`): `unknown`, or `sdk-documented` with the header source (D11).

### Encoder

Each builder returns the wire tree of one message; `encode()` validates it with the contract and adds the length prefix. A message whose `capture.monotonicNs` precedes a source-clock time it carries (an occurrence, lost or retention time) is rejected, never clamped. The endpoint stamps `capture` when it encodes (OD-5 S7); see the capture rule under [Caller sequence](#caller-sequence).

`measure_event` encodes an event once with the worst-case envelope: the maximum `seq` and capture time and `redelivered: false`, which is one byte longer than `true`. Every later encoding of the record fits within that size (OD-5 S3). A record that the contract rejects, for example a game-time regression whose occurrence is not its `to` time, cannot be sent. `ingest_event` then records it as `encodingFailed` coverage, as it does for a payload over 16,384 bytes. Any other failure during measurement, such as `std::bad_alloc`, also yields `encodingFailed`: `measure_event` and `ingest_event` never throw, and the store allocates nothing after construction, so every drained `eventSeq` keeps its coverage and no exception can end the transport worker. The `event-worst` record, with every text at its D12 limit, measures 6,306 bytes: the fixture's 6,305 plus one for `redelivered: false`.

Without game-mode detection (OD-3) the welcome lists no `source.gameMode` type and reports mode `unknown`, method `none` and confidence `none`. Without the gameplay-event registration it lists none of the six gameplay types.

## Store rules

The store holds the unacknowledged entries that cover [*A* + 1, *N*): events and gap records, in `eventSeq` order. *A* is the release point (`ackedThroughEventSeq`) and *N* the next `eventSeq` (`nextEventSeq`, OD-5 S11).

| Invariant | Rule |
| --- | --- |
| I1 coverage | The entries cover exactly [*A* + 1, *N*), each `eventSeq` once, without holes. A new event or lost range must start at *N* |
| I2 bounds | At most 256 entries and 1,048,576 bytes. An event counts its measured payload and a gap record 1,024 bytes. An event is admitted only if one entry and 1,024 bytes stay free afterwards, so events use at most 255 entries. Otherwise it is lost as `queueCount` (no entry) or `queueBytes` (no bytes); `queueCount` wins when both apply |
| I3 extension | A lost range extends the trailing entry in place when that entry is a gap record, whatever the causes. The record keeps its entry, its 1,024 bytes and its retention time, and its causes add up. Otherwise the range becomes a new gap record, which always fits in the reserved entry and bytes |
| I4 release | An ACK for *T* releases exactly the entries whose last `eventSeq` is ≤ *T*. A gap record with first ≤ *T* < last stays whole, and *A* becomes its first `eventSeq` − 1 (decision (c)) |
| I5 retention | A durable disconnect starts a 300,000 ms window. A durable reconnection inside it cancels the window. When it ends, every retained event becomes `retentionExpired` coverage, merged with the gap records into one gap record over [*A* + 1, *N*). Expiry never adds entries. Gap records never age |
| I6 delivery | A durable connection writes coverage from *A* + 1 in order, each `eventSeq` once. An item is `redelivered` when an earlier connection wrote any of its `eventSeq` values. A gap record extended after it was written yields a delta gap for the new tail only |
| I7 monotonicity | *A*, *N* and the six loss counters never decrease |
| I8 end | `end` reports *N*, *A* and the number of retained events (OD-5 S5). After `eventSeq` 18,446,744,073,709,551,614 the store is exhausted and accepts nothing more; the endpoint sends `end` with `sequence-exhausted` |

Further rules:

- **Lost times** are the first and last lost observation, both present or both absent. Merging keeps the earliest first and the latest last time (OD-5 S1). An event lost at admission uses its `occurred.monotonicNs`; expired events contribute theirs.
- **Retention time** (`oldestRetainedMonotonicNs`) is the time an entry was admitted. The gap record created by expiry takes the expiry time (OD-5 S2).
- **No durable consumer**: the capture gate copies events only while a durable consumer is connected; otherwise they reach the store as `offline` or `noDurableConsumer` loss runs through `lose()` (OD-4). Before the first durable connection of a plugin session, `admit()` and `ingest_event` reject an event as misuse. Events copied while a durable consumer was connected and stored after it disconnected fall inside the retention window and are retained (OD-5 S4). Only an event stored after that window has ended is recorded as `retentionExpired`.
- **Live-only clients** never reach the store's cursor and never start or cancel a retention window.
- **Written** means that the endpoint issued the write (OD-5 S9). `next_outbound()` marks an item written when it returns it.
- **Misuse** (an event before the first durable connection, an `eventSeq` other than *N*, a size outside 1–16,384 bytes, one lost time without the other, an ACK beyond the written coverage or without a connection) is rejected without any change.

## Callback capture

The SDK callbacks hand events to the transport worker through one `EventChannel` per plugin session: a single-producer, single-consumer ring of 128 slots. Each slot holds an optional closed loss run and an optional copied `EventRecord`. `prepare()` allocates the ring once, in the SDK initialization context, and starts the session at `eventSeq` 1 with the gate closed. The ring is never reallocated while the adapter holds the channel.

### Gate and observation

The worker sets the gate; the SDK thread reads it atomically on every event:

| Gate | Meaning | An observed event |
| --- | --- | --- |
| `none` | No v1 client | Lost as `offline` |
| `live` | A live-only client | Lost as `noDurableConsumer` |
| `durable` | A durable consumer, after `EventStore::connect()` | Copied into a free slot; with the ring full, lost as `queueCount` (OD-5 S4) |

`observe()` on the SDK thread:

1. assigns the next `eventSeq` to every observed event (D5), including events that are lost. After `max_event_seq` it assigns nothing more and returns 0; the channel reports `exhausted()`;
2. loads the gate;
3. with the gate `durable` and a free slot, copies the record into the slot. The record is trivially copyable, so this is a fixed-size copy without allocation;
4. otherwise extends the open loss run: its range, a count per cause, and the earliest and latest available `occurred.monotonicNs` (OD-5 S1);
5. the next copied record carries the closed run as `loss_before`, so the run precedes it in the ring.

At every `frame_end` the adapter calls `flush_loss()`, which moves an open run into a free slot of its own, so a trailing run reaches the worker without waiting for another record. A full ring keeps the run open, and it keeps extending.

For v1 the SDK thread never waits for a lock: the ring is lock-free and the v1 slot is only try-locked. It allocates nothing, makes no SDK call and signals no event. The worker polls the ring at least every 10 ms. A run still open when the plugin exits gets no gap (OD-5 S11).

### Records from the callbacks

The adapter builds the records in SDK units, with the [§6 mapping](protocol/v1.md#6-units-and-sdk-mapping) left to the encoder:

| Callback | Record |
| --- | --- |
| `job` configuration | `job.configured`, or `job.cleared` when the attribute list is empty. Every callback emits a record, including an identical re-send (D13) |
| `truck` configuration | `truck.configured` or `truck.cleared`, in the same way |
| `trailer.0`–`trailer.9` configuration | `trailer.configured` for a non-empty slot. An empty slot emits `trailer.cleared` only when the slot was non-empty before (D13) |
| `bus_job`, `car_job`, the legacy `trailer` id, other configurations | No record and no `eventSeq` (TD-002) |
| `started`, `paused` | `simulation.started`, `simulation.paused` |
| Frame start with a timer restart or a regressed frame time | `timers.restart` |
| A `game.time` channel value below the previous one | `gameTime.regression`: `from` is the reading and game clock before the rotation, `to` the regressed reading under the new clock, equal to `occurred.gameTime` |
| `job.delivered`, `job.cancelled`, `player.fined`, `player.tollgate.paid`, `player.use.ferry`, `player.use.train` | The record of the same type |
| `car_job.*` and unknown gameplay events | No record and no `eventSeq` |

- **Occurrence.** `occurred` describes the callback moment, after the callback updated the adapter state: the source clock (QPC), the game time and clock, a UTC label from `GetSystemTimePreciseAsFileTime` (OD-5 S8), the simulation state, the v1 configuration revision and the shared callback order. A `simulation.paused` event therefore carries `paused` and `simulation.started` carries `running` ([§8](protocol/v1.md#8-durable-events), owner decision of October 15, 2026).
- **Configuration revision.** v1 has its own revision. It counts the job and truck callbacks and the trailer callbacks that emit a record. The v0 revision is unchanged.
- **Text (D12).** A provided empty string stays available, a value over 128 or 256 bytes is invalid and never truncated, and a null string pointer or a wrong attribute type is invalid. The encoder checks UTF-8 and control characters.
- **Attribute lists.** The scan stops at the v0 bound of 256 entries including the terminator, and indexed attributes are skipped. After a null or unterminated list, every field that was not seen is invalid, because it may have been sent. A null configuration list is a present configuration, not a clear.

### v1 state slot

The adapter publishes a `V1Current` beside the v0 slot: at every `frame_end`, at initialization, at shutdown and when a channel is attached. It holds the source identity, the current state in SDK units (`StatePod`, without the window, which the endpoint adds), the configuration, the boundary order, a UTC capture label and the v1 continuity.

- The SDK thread only try-locks the slot. When the worker holds it, the older slot stays whole and `coalescedSnapshots` counts the skipped publication. The configuration is copied only after a configuration boundary, and a skipped publication keeps it pending.
- `offlineTransitions` counts the lifecycle and configuration boundaries that occur while the gate is `none` (OD-5 S10). Gameplay events are counted as loss, not as transitions.
- `read_v1_current()` copies the slot and consumes nothing. The v0 `read_latest()` slot keeps its single consumer.

## Caller sequence

The endpoint pull request will drive the channel and the store as follows:

1. Prepare the channel in the SDK initialization context and attach it with `attach_events()` after `Adapter::initialize()`, once per plugin session. Start the worker afterwards; `read_v1_current()` is available at once. `initialize()` detaches a channel still attached from an earlier session, so its `eventSeq` never continues under a new `pluginSessionId` (§9); v1 then stays inert until a freshly prepared channel is attached. When `initialize()` returns `not_now` because the worker holds a slot, it has changed no state.
2. On a durable hello, call `EventStore::connect()` and only then `set_gate(Gate::durable)`, so that every record copied for the new consumer is retained. Build the checkpoint from `status()` and `read_v1_current()`. A live-only hello sets `Gate::live`; it never connects the store. On the disconnect of a durable client, set the gate to `live` or `none` first, then call `disconnect(now)`.
3. On every loop iteration, at most 10 ms apart, drain the ring with `front()` and `pop()`. For a slot's `loss_before`, call `lose()` once per nonzero cause, in the fixed order `offline`, `noDurableConsumer`, `queueCount`, each part with the run's lost times. The parts are contiguous, so the store merges them into one gap record with the exact counts and lost times. Then call `ingest_event` for the slot's record. Call `expire(now)` on every iteration.
4. Treat `rejected` from `ingest_event`, `admit()` or `lose()` as an invariant violation: retire the session with `end` reason `source-retired` and one fixed log entry, deferred to the SDK thread. It cannot happen while the drain order above is kept.
5. While the client keeps up, write the items from `next_outbound()` with `Encoder::outbound`, and record each one with the connection's `AckValidator::sent`. Stamp every message with `capture = max(now, last capture on the connection, the latest source-clock time the message carries)`. A retained event's `occurred.monotonicNs` comes from the SDK thread and can be later than the worker's clock reading. Because `encode()` rejects a capture before a carried time and the store cannot skip a retained entry, an unclamped capture would fail on every write and stall delivery.
6. Pass every ACK through `AckValidator::accept`, then call `release()` with the accepted value.
7. At shutdown, or when the channel or the store is exhausted, send `end` from `end_cursor()`. Detach the channel with `attach_events(nullptr)` only after the worker has stopped.

## Evidence

The console test [v1-producer-test.cpp](../native/telemetry-plugin/tests/v1-producer-test.cpp) runs as CTest `v1-producer-contract-{store,release,retention,overflow,encoding,messages,streams,randomized,fuzz}` and, in the AddressSanitizer build, as `v1-producer-asan-contract-*`. It drives the store and encoder through the ET-002b `Consumer`, `DurableAckCursor` and `AckValidator` and compares built messages with the hand-written shared fixtures.

The console test [event-channel-test.cpp](../native/telemetry-plugin/tests/event-channel-test.cpp) runs as `event-channel-contract-{ring,gate,loss-runs,flush,concurrency,exhaustion}` and `event-channel-asan-contract-*`. The adapter cases in [sdk-adapter-test.cpp](../native/telemetry-plugin/tests/sdk-adapter-test.cpp) run inside `sdk-adapter-contract` and `sdk-adapter-asan-contract`: record mapping through the contract encoder, the gate and state slot, non-blocking callbacks, v0 and CAP0 isolation, and the drain into the event store in the order above, accepted by the ET-002b `Consumer`. Results and pending checks are in [ET-004b validation](validation/et-004b.md).
