# Native protocol v1 producer

ET-004b implements the plugin side of [protocol v1](protocol/v1.md) in three pull requests:

1. **Producer core** (this revision): the copied event records, the encoder and the retained event store. They are SDK-free and I/O-free, and nothing in the plugin DLL uses them yet.
2. **Callback capture**: the SDK-thread handoff that assigns `eventSeq` and copies records without blocking.
3. **Endpoint**: the v1 pipe, handshake, live loop and shutdown.

The later pull requests extend this document. The v0 endpoint, its wire format and the desktop application are unchanged. Nothing here establishes game, TruckersMP, display or performance support.

## Components

| File | Contents |
| --- | --- |
| [protocol-v1-records.hpp](../native/telemetry-plugin/src/protocol-v1-records.hpp) | Trivially copyable records: `EventRecord` (eventSeq, occurrence and a variant of the 17 record bodies), `StatePod`, `ConfigurationPod`, `SourcePod`, `GameModePod` and fixed-size text |
| [protocol-v1-producer.hpp](../native/telemetry-plugin/src/protocol-v1-producer.hpp) | `Encoder`: builds every server message from the records and the store, then validates and frames it with the ET-002b `v1::encode_frame`. `ingest_event` measures and admits one event |
| [protocol-v1-store.hpp](../native/telemetry-plugin/src/protocol-v1-store.hpp) | `EventStore`: the retained entries of one plugin session, its loss counters and the outbound cursor |

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

## Caller sequence

The endpoint pull request will drive the store as follows:

1. On a durable hello, call `connect()` before the event gate opens, so that every event copied for the new consumer is retained. Build the checkpoint from `status()`.
2. On every loop iteration, call `ingest_event` for each drained event, `lose()` for each drained loss run, and `expire(now)`.
3. While the client keeps up, write the items from `next_outbound()` with `Encoder::outbound`, and record each one with the connection's `AckValidator::sent`. Stamp every message with `capture = max(now, last capture on the connection, the latest source-clock time the message carries)`. A retained event's `occurred.monotonicNs` comes from the SDK thread and can be later than the worker's clock reading. Because `encode()` rejects a capture before a carried time and the store cannot skip a retained entry, an unclamped capture would fail on every write and stall delivery.
4. Pass every ACK through `AckValidator::accept`, then call `release()` with the accepted value.
5. On disconnect of a durable client, call `disconnect(now)`. At shutdown or exhaustion, send `end` from `end_cursor()`.

## Evidence

The console test [v1-producer-test.cpp](../native/telemetry-plugin/tests/v1-producer-test.cpp) runs as CTest `v1-producer-contract-{store,release,retention,overflow,encoding,messages,streams,randomized,fuzz}` and, in the AddressSanitizer build, as `v1-producer-asan-contract-*`. It drives the store and encoder through the ET-002b `Consumer`, `DurableAckCursor` and `AckValidator` and compares built messages with the hand-written shared fixtures. Results and pending checks are in [ET-004b validation](validation/et-004b.md).
