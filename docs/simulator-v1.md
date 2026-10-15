# Synthetic protocol v1 simulator

ET-005b adds a deterministic [protocol v1](protocol/v1.md) producer model beside the unchanged [v0 simulator](simulator-v0.md). It is a Node test tool, independent of Electron and the SCS SDK. It opens no database, writes no history, discovery or service-policy file, calls no SDK function and emits only synthetic origins. The desktop application still speaks v0. Nothing here establishes game, TruckersMP, display or performance behavior.

PR-1 provides deterministic replay. PR-2 serves the same model on a real named pipe with client and wire fault injection ([below](#named-pipe-serving)). Replaying sanitized CAP-01 callback sequences (PR-3) is a separate pull request.

From the repository root, using the [pinned toolchain](setup.md):

```powershell
npm run build --workspace @ets2telemetry/telemetry-simulator
node tools/telemetry-simulator/dist/cli.cjs replay-v1 tests/fixtures/simulator-v1/save-load.json
npm run smoke:v1 --workspace @ets2telemetry/telemetry-simulator
node tools/telemetry-simulator/dist/cli.cjs smoke-v1 tests/fixtures/simulator-v1/wire-faults.json --scale 0
npm test -- tests/unit/simulator-v1-store.test.ts tests/unit/simulator-v1-source.test.ts tests/unit/simulator-v1-scenario.test.ts tests/unit/simulator-v1-replay.test.ts tests/unit/simulator-v1-pipe.test.ts tests/unit/simulator-v1-faults.test.ts
```

`replay-v1` writes one JSON line per wire message to stdout: `{scenario, origin, connection, atMs, direction, message}`, where `direction` is `server` or `client`. Injected fault bytes appear at their place as `{scenario, origin, connection, atMs, direction, fault, bytesHex}` instead of `message`. Two runs of one scenario are byte-identical. `smoke-v1` and `serve-v1` are described under [named-pipe serving](#named-pipe-serving).

## Components

| Module (`tools/telemetry-simulator/src/v1/`) | Role |
| --- | --- |
| `store.ts` | `EventStore`, a TypeScript mirror of the native ET-004b store and its invariants I1–I8 ([native v1 transport](native-transport-v1.md#store-rules)) |
| `source.ts` | `AdapterModel`: SDK callbacks in, v1 records, occurrences and the published state slot out, following the [records table](native-transport-v1.md#records-from-the-callbacks) and the [§6 mapping](protocol/v1.md#6-units-and-sdk-mapping). `EventChannel` models the SDK-thread gate, `eventSeq` assignment, open loss runs and a full handoff ring. `ScenarioClock` holds the clocks |
| `producer.ts` | `V1Producer`: the transport worker without I/O. It drains the channel in the [caller sequence](native-transport-v1.md#caller-sequence) (loss parts in the order offline, noDurableConsumer, queueCount; then the copied record), measures each event once with the worst-case envelope, stamps `capture = max(now, last capture, carried times)`, passes every ACK through `AckValidator` and coalesces snapshots |
| `client.ts` | `ScriptedClient` built from the ET-002b `FrameDecoder`, `V1Consumer`, `DurableAckCursor` and `computeClockMapping`, plus `CommitLedger`, an in-memory stand-in for rows keyed `UNIQUE(plugin_session_id, event_seq)` (CD-6). It is not storage |
| `scenario.ts` | The strict scenario schema and the ordered timeline |
| `replay.ts` | `V1Driver`, the virtual-clock driver: a generator of transport effects (accept, expected client bytes, server writes, flushes, closes) that `replayV1` answers at once. Also the transcript and fault lines |
| `faults.ts` | The fault vocabulary and the bytes of each client and wire fault, built outside the producer |
| `pipe.ts` | `serveV1`, the lockstep named-pipe server, and `runV1PipeClient`, the scripted pipe client; `TEST_PIPE_PATTERN_V1` |
| `cadence.ts` | Real-time cadence and state-rate checks of a paced pipe run |

The ET-002b contract modules are reused unchanged. Every server message is built through `encodeFrame`, and every client message through the same encoder; each side decodes the other's frames with `FrameDecoder`.

## Scenario format

A scenario file is strict JSON of at most 2 MiB, read once through the v0 simulator's bounded reader, which rejects duplicate keys. Unknown or missing fields are rejected at every level, and the result is rebuilt from validated fields only.

```json
{"format": "ets2telemetry-simulator-v1", "schemaVersion": 1, "id": "...", "purpose": "...", "reg": ["REG-001"],
 "origin": "synthetic", "game": "ets2", "seed": "...", "provenance": null,
 "source": {"versions": {...}, "gameplayEvents": "registered", "currency": "unknown", "gameMode": "unknown", "startEventSeq": "1"},
 "steps": [...], "transport": [...]}
```

- `origin` is `synthetic` with `provenance: null`. `game` is always rejected (CD-4). `replay` with CAP-01 provenance is added by PR-3.
- `source.gameplayEvents`: `registered` or `not-supported` (no gameplay steps, no gameplay types in welcome). `source.currency`: `unknown` or `sdk-documented`, which uses EUR from `scssdk_telemetry_eut2.h` for ETS2 and USD from `scssdk_telemetry_ats.h` for ATS (CD-9, D11). `source.gameMode`: `unknown` (OD-3: mode unknown, no `source.gameMode` type) or `synthetic-detection`, which allows `gameMode` steps (CD-8, D9 only). `startEventSeq` above 1 is a synthetic affordance for exhaustion: [1, start) counts as acknowledged and committed.
- At most 1,000 steps in total, `atMs` from 0 to 86,400,000 and ordered within each array, `repeat` and `count` at most 1,000, at most 255 attributes per callback, and at most 20,000 transcript messages per replay.

Source steps use the SDK-callback vocabulary (CD-3):

| `action` | Fields | Model |
| --- | --- | --- |
| `configuration` | `id`, `attributes`, `list?`, `repeat?` | `job`, `truck` and `trailer.0`–`trailer.9` emit records (D13); `bus_job`, `car_job`, `controls`, `hshifter`, `substances` and the legacy `trailer` only advance the boundary order (TD-002). An empty terminated list is a clear. `list: "null"` (no attributes) and `"unterminated"` (a shorthand for a list cut at the native 255-entry scan bound, with at least one attribute) make every unseen field invalid |
| `gameplay` | `id`, `attributes`, `list?`, `repeat?` | The six v1 gameplay types; `car_job.*` and unknown ids yield nothing |
| `lifecycle` | `event` | `simulation.started` or `simulation.paused`; `occurred.simulation` is the state after the callback |
| `frame` | `timerRestart?`, `channels?` | frame_start (a timer restart rotates the game clock and emits `timers.restart`), each listed channel in registration order, then frame_end: the loss-run flush and the state publication |
| `gameMode` | `mode`, `method`, `confidence`, `module?` | Synthetic detection; emits `source.gameMode` on the first result and on every change. Not an SDK callback |
| `encodingFailure` | `count` | Injects records the contract rejects (an out-of-range trailer index), so measurement fails |
| `handoff` | `full` | A full ring loses every event the durable gate would copy as `queueCount`; the run stays open until the ring drains |
| `utcJump` | `deltaMs` | Moves UTC labels only |
| `suspend` | `durationMs`, `sourceClockAdvances` | CD-12: the source clock either stops or advances across the suspend; nothing runs until it ends |
| `shutdown` | `reason` | `plugin-shutdown` or `source-retired`: a best-effort `end`, then nothing may follow; an open loss run gets no gap (OD-5 S11) |

Attributes are `{name, sdkType, value}` with the SDK names and types. `float` values must be float32-exact, `u64`/`s64` are exact decimal strings, and a `string` value of `null` is a null pointer (invalid). A wrong `sdkType` for the field is invalid. Channel values are numbers in SDK units (speed m/s, `fuel.amount` L, `odometer` and `fuel.range` km, `fuel.consumption.average` L/km, `navigation.distance` m, `game.time` u32 minutes, `displayed.gear`, `engine.rpm`), `null` for a callback without a value, or `"invalid"` for a wrong-typed value; `world.placement` is `{x, y, z, heading, pitch, roll}`.

Transport steps: `connect` with `client: {durable, commit?, ack?, probes?}` and `disconnect`. `commit` is `each` (default), `none`, `failAt:<eventSeq>` (crash before committing the item that covers it) or `crashAfterCommit:<eventSeq>` (commit it, then crash before its ACK). `ack` is `each` (default), `withhold` or `dropAfter:<n>` (later ACKs are lost after leaving the client). A live-only client (`durable: false`) has neither. `probes` are scenario times at least 1,000 ms apart within the connection. A crash closes the connection; a scripted `disconnect` after it is a no-op, and the next connection uses a new client instance whose cursor starts from the ledger.

Fault and endpoint steps (PR-2):

| `action` | Fields | Model |
| --- | --- | --- |
| `clientFault` | `fault` | A hello fault is a connection attempt of its own, made while no client is connected; the producer opens no v1 connection for it. A live fault acts on the open connection after its checkpoint |
| `wireFault` | `fault` | Server-to-client bytes injected on the open connection, built outside the producer and the encoder. Requires the top-level `faultInjection: true`, which a scenario without wire faults may not set |
| `secondClient` | | Another client connects while the open one continues; it is refused |
| `writeDeadline` | | Ends a connection whose client stalled (`clientFault: stallRead`) at the server write deadline. Another connection must follow it, because a stalled client learns of the closure only from the next accepted connection |

| Fault | Bytes | Outcome |
| --- | --- | --- |
| `helloOversized` | A prefix of 4,097 | Closed at the prefix (§3) |
| `helloMalformed`, `helloV0`, `helloCap0`, `helloOtherMajor`, `helloOtherMinor`, `helloUnknownKind`, `ackBeforeHello` | Malformed JSON, a v0 or CAP0 hello, version 2.0 or 1.1, kind `subscribe`, an `ack` first | Closed without a byte (§2, §4) |
| `helloExtraBytes`, `ackBeforeCheckpoint` | A valid hello and one more byte or an `ack` in the same write | Closed without a byte (OD-5 S6) |
| `helloPartialEof` | Half a hello, then the client ends its side | Closed at EOF |
| `helloTimeout` | Nothing | Closed at the 5 s hello deadline (§4) |
| `secondHello`, `unknownKind`, `oversizedFrame`, `malformedFrame` | A hello, kind `subscribe`, a prefix of 4,097, malformed JSON | Closed without an error frame (§4, OD-5 S6) |
| `ackLiveOnly`, `ackForeignSession`, `ackBeyondSent`, `ackRegressing` | An `ack` from a live-only client, for another plugin session, for the next uncovered `eventSeq`, or one below the accepted point | Closed by `AckValidator` (§10) |
| `ackDuplicate` | An `ack` equal to the accepted point | No-op; the connection continues (§10) |
| `probeRepeat`, `probeWhileReplyUnsent` | The previous probe ID again; two probes in one write | Closed (§11, OD-5 S6). A rejected read consumes no message `seq` |
| `partialFrameEof` | Half an `ack`, then the client ends its side | Closed at EOF |
| `stallRead` | Nothing; the client stops reading | Ends at the scripted `writeDeadline` |
| `duplicateEventSeq`, `skippedEventSeq` | The last event again, or one `eventSeq` beyond the next | `V1Consumer`: eventSeq coverage violation (§9) |
| `seqRegression`, `captureRegression`, `foreignSource` | A snapshot with the last `seq`, an earlier capture, or another plugin session | `V1Consumer`: identity, clock or order violation (§5) |
| `malformedJson`, `oversizedPrefix`, `partialEof`, `v0Frame` | Malformed JSON, a prefix of 65,537, half a frame and then EOF, a v0 `welcome` | `FrameDecoder`: rejected (§3) |
| `frameAfterEnd` | A consistent `end`, then a snapshot | `V1Consumer`: nothing may follow `end` |
| `seqSkip` | Nothing; the producer skips one message `seq` | Accepted: the next message reports one skipped sequence (§5) |

A rejected client fault, and a wire fault the client rejects, end only their connection. The producer then behaves as after a disconnect at that time: the gate closes, a durable connection starts its retention window, and nothing else changes. Each fault on a connection is recorded in the result (`faults`, `rejection`, `refusedClients`).

## Clocks, identities and ordering

- Source monotonic clock: 1,000,000,000,000 ns + `atMs` × 1,000,000, less any time a non-advancing suspend stopped it. UTC labels: 1,800,000,000,000 ms + `atMs` + UTC jumps. Client clock: 5,000,000,000,000 ns + `atMs` × 1,000,000, so a zero-latency probe maps with offset −4,000,000,000,000 ns and uncertainty 0. Game time comes only from frames.
- Identities are SHA-256-derived UUIDs over `simulator-v1:<seed>:<label>`: `plugin-session`, `process-instance`, `capture-clock`, `game-clock-<epoch>`, `client-instance-<n>`, `client-clock-<n>`. The process ID is 1 and the Windows session 0; neither is an authenticated identity.
- At one `atMs`, due timers fire first (a retention expiry before a snapshot), then source steps, then probes, then transport steps. A timer fires at its own time, or when a suspend ends if it fell due during it. Timers after the last step do not fire.
- The client applies each server message synchronously and the producer processes each reply before its next action. Every SDK callback, including frame_start, each channel and frame_end, advances `boundaryOrder`. Message `seq` counts written messages. The 50 ms snapshot interval starts at the checkpoint; a publication inside it replaces the one unsent snapshot and increments `coalescedSnapshots`. State is the slot published at the last frame_end (OD-5 S7), so a configuration change after it reaches the client only with the next frame.
- Store retention runs in source time (CD-11). Store misuse would be an invariant violation; the model throws instead of retiring the session, so a defect cannot pass silently.

## Corpus and expectations

[`tests/fixtures/simulator-v1`](../tests/fixtures/simulator-v1) lists 28 synthetic scenarios in `manifest.txt`: the 23 of PR-1, the fault scenarios `client-hello-faults`, `client-control-faults` and `wire-faults`, and the pipe scenarios `pipe-reconnect` (the CI smoke) and `pipe-stalled-reader`. Each `<id>.json` has a hand-written `<id>.expected.json` whose `authoredFrom` cites the specification it was derived from. The comparator in [simulator-v1-expected.ts](../tests/shared/simulator-v1-expected.ts) only reads expectations: each connection's welcome, checkpoint, ordered coverage (`{event, type, redelivered}` or `{gap, causes, redelivered}`; `eventRange` abbreviates consecutive events), ACKs, snapshots and `end`, then the ledger and the store. Per connection it also lists fault lines, refused second clients and the client's rejection message. Objects match as subsets, arrays and loss counts exactly, and seeded identifiers appear as labels such as `game-clock-1`. Expectations are wire-level only; trip outcomes belong to ET-014/ET-015, which may add `<id>.trip.expected.json`.

The queue-bytes scenario's split is derived by hand from the documented 6,306-byte `event-worst` measure: its worst achievable record measures 6,001–6,007 bytes, so 174 events fit and eventSeq 175 is the first `queueBytes` loss. The store test keeps the 166/167 split for records of exactly 6,306 bytes.

## Named-pipe serving

`serveV1` (`pipe.ts`) serves one scenario on a new endpoint `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}`; `TEST_PIPE_PATTERN_V1` matches exactly these names, and the pipe client refuses any other endpoint. Nothing else is published: no discovery record and no `service-policy.json`. The server is Node, so it has no protected DACL and no peer authentication; it is not security evidence for the native endpoint.

```powershell
node tools/telemetry-simulator/dist/cli.cjs serve-v1 <scenario.json> [--scale <0-10>]
node tools/telemetry-simulator/dist/cli.cjs smoke-v1 <scenario.json> [--scale <0-10>]
```

`serve-v1` prints `{origin, endpoint, history: false}`, serves the scenario to a client that follows its transport steps, then prints a summary with the transcript's SHA-256. `smoke-v1` runs that scripted client in the same process and exits with an error unless the pipe run equals the replay (see below), the first measurable gap of at least 20 ms arrives within half to one second beyond its schedule, state messages are at least 50 ms apart (at most 20 Hz) and every clock probe was answered. `--scale` is real milliseconds per scenario millisecond while a client is connected (default 1; 0 does not pace); offline segments are always fast-forwarded.

**Lockstep.** The server runs the same `V1Driver` as `replay-v1` and answers its transport effects with pipe I/O. After each server frame it waits for exactly the bytes the scenario's client sends in reply, compares them and only then lets the producer process them, as one read. The producer's source clock is scenario time, and retention runs in it (CD-11). So the served transcript, including snapshots and clock replies, is byte-identical to `replay-v1` by construction, and every client byte and every applied message are compared with the replay as well. This is stronger than the plan's claim (events, gaps, checkpoints and `end` byte-identical; snapshots equal in state). A client that deviates from its script, for example with other hello bytes, an extra ACK or a missing connection, fails the run visibly.

**The scripted client.** `runV1PipeClient` uses the PR-1 `ScriptedClient`, built only from the ET-002b `FrameDecoder`, `V1Consumer`, `DurableAckCursor` and `computeClockMapping`, with the in-memory `CommitLedger` and per-instance ACK cursors, one connection after another. Its script (`clientPlan`) comes from the replay, because a probe or a fault belongs to a point of the server stream that only the scenario timeline defines: each action is taken after the server message with a given `seq`. A probe is sent at its own scenario time on the connection's paced schedule, so its round trip does not include the server's wait for the timeline. The client clock is `process.hrtime`, so mappings differ from the replay's zero-latency values and are checked separately: a reply within 1 s gives `offset` and an uncertainty of half the measured round trip; a later reply gives no mapping (§11).

**Mirrored endpoint behavior.** One client at a time: a client arriving while another is connected is closed without a byte and does not displace it. The hello is read as `v1-server.cpp` reads it: the 4,096-byte bound at the prefix, a byte beyond the hello in the same read rejected, any other first message, major, envelope minor or kind rejected, all without an error frame. After the checkpoint only `ack` (through `AckValidator`) and `clock.probe` are accepted; probe IDs increase and no probe may arrive while a reply is unsent. One replaceable unsent snapshot at most every 50 ms. `end` at shutdown, at sequence exhaustion, and on cancellation (`stop` or an aborted signal: `plugin-shutdown` for a live connection, written within the write deadline, then the endpoint closes). Writes must complete within the 1,000 ms write deadline; a hello is due within 5,000 ms of the scenario's connect point (tests inject a shorter hello deadline only for a client that never sends one). A deadline is judged only after one more I/O poll, so a completion already queued when a starved process wakes still counts.

**Deliberate differences from the native endpoint.** The lockstep server checks the client against its script instead of reacting to arbitrary timing. It feeds the producer one scripted reply at a time, so the native window between the welcome and the checkpoint, in which a client byte resets the connection, does not exist here; such bytes are instead the `helloExtraBytes` and `ackBeforeCheckpoint` faults in the hello's own read. The hello deadline counts from the scenario's connect point, not from the OS connection. A scripted `disconnect` is performed by the server after the client's replies have arrived (the client sees EOF without `end`); a graceful close returns only after the client has read every byte (libuv's `FlushFileBuffers`). After `end` at sequence exhaustion the endpoint keeps serving `welcome` then `end`, as PR-1 models it, while the native endpoint closes. Node keeps several pipe instances, so a second client connects at the OS level and is then closed; the native endpoint has one instance and refuses it at connect.

**Determinism by construction.** No check depends on scheduling speed. The stalled-reader scenario writes about 600 KB after the client stops reading, far beyond the 64 KiB pipe buffer, while the steps before it write a few hundred bytes, so the write deadline fires at the scripted step on any host; if the writes complete anyway the run fails visibly. Waits for a cooperative client are liveness bounds (5,000 ms); only a broken client reaches them. Real time is used only for pacing, the cadence smoke bound and clock mappings.

## Pending

Real-game event rates against the v1 bounds; the native v1 endpoint in a running game; profile change, train crossing, weigh station, special jobs and owned trailers (synthetic only here); QPC behavior across sleep and real UTC changes; second-user and remote rejection (Node pipes are not DACL or peer-authentication evidence); ET-006b ingestion; the real transactional insert and crash recovery (ET-013/ET-015a); trip outcomes (ET-014/ET-015); TruckersMP detection. There is no automated differential test between this TypeScript model and the native store, nor between the Node pipe server and the native endpoint; the desktop application does not consume v1 until ET-006b.
