# Synthetic protocol v1 simulator

ET-005b adds a deterministic [protocol v1](protocol/v1.md) producer model beside the unchanged [v0 simulator](simulator-v0.md). It is a Node test tool, independent of Electron and the SCS SDK. It opens no database, writes no history, discovery or service-policy file, calls no SDK function and emits only synthetic origins. The desktop application still speaks v0. Nothing here establishes game, TruckersMP, display or performance behavior.

This revision (PR-1) provides deterministic replay. Serving the model on a real named pipe with fault injection (PR-2) and replaying sanitized CAP-01 callback sequences (PR-3) are separate pull requests.

From the repository root, using the [pinned toolchain](setup.md):

```powershell
npm run build --workspace @ets2telemetry/telemetry-simulator
node tools/telemetry-simulator/dist/cli.cjs replay-v1 tests/fixtures/simulator-v1/save-load.json
npm test -- tests/unit/simulator-v1-store.test.ts tests/unit/simulator-v1-source.test.ts tests/unit/simulator-v1-scenario.test.ts tests/unit/simulator-v1-replay.test.ts
```

`replay-v1` writes one JSON line per wire message to stdout: `{scenario, origin, connection, atMs, direction, message}`, where `direction` is `server` or `client`. Two runs of one scenario are byte-identical.

## Components

| Module (`tools/telemetry-simulator/src/v1/`) | Role |
| --- | --- |
| `store.ts` | `EventStore`, a TypeScript mirror of the native ET-004b store and its invariants I1–I8 ([native v1 transport](native-transport-v1.md#store-rules)) |
| `source.ts` | `AdapterModel`: SDK callbacks in, v1 records, occurrences and the published state slot out, following the [records table](native-transport-v1.md#records-from-the-callbacks) and the [§6 mapping](protocol/v1.md#6-units-and-sdk-mapping). `EventChannel` models the SDK-thread gate, `eventSeq` assignment, open loss runs and a full handoff ring. `ScenarioClock` holds the clocks |
| `producer.ts` | `V1Producer`: the transport worker without I/O. It drains the channel in the [caller sequence](native-transport-v1.md#caller-sequence) (loss parts in the order offline, noDurableConsumer, queueCount; then the copied record), measures each event once with the worst-case envelope, stamps `capture = max(now, last capture, carried times)`, passes every ACK through `AckValidator` and coalesces snapshots |
| `client.ts` | `ScriptedClient` built from the ET-002b `FrameDecoder`, `V1Consumer`, `DurableAckCursor` and `computeClockMapping`, plus `CommitLedger`, an in-memory stand-in for rows keyed `UNIQUE(plugin_session_id, event_seq)` (CD-6). It is not storage |
| `scenario.ts` | The strict scenario schema and the ordered timeline |
| `replay.ts` | The virtual-clock driver and the transcript |

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

Transport steps: `connect` with `client: {durable, commit?, ack?, probes?}` and `disconnect`. `commit` is `each` (default), `none`, `failAt:<eventSeq>` (crash before committing the item that covers it) or `crashAfterCommit:<eventSeq>` (commit it, then crash before its ACK). `ack` is `each` (default), `withhold` or `dropAfter:<n>` (later ACKs are lost after leaving the client). A live-only client (`durable: false`) has neither. `probes` are scenario times at least 1,000 ms apart within the connection. A crash closes the connection; a scripted `disconnect` after it is a no-op, and the next connection uses a new client instance whose cursor starts from the ledger. Client faults, wire faults and second clients are PR-2.

## Clocks, identities and ordering

- Source monotonic clock: 1,000,000,000,000 ns + `atMs` × 1,000,000, less any time a non-advancing suspend stopped it. UTC labels: 1,800,000,000,000 ms + `atMs` + UTC jumps. Client clock: 5,000,000,000,000 ns + `atMs` × 1,000,000, so a zero-latency probe maps with offset −4,000,000,000,000 ns and uncertainty 0. Game time comes only from frames.
- Identities are SHA-256-derived UUIDs over `simulator-v1:<seed>:<label>`: `plugin-session`, `process-instance`, `capture-clock`, `game-clock-<epoch>`, `client-instance-<n>`, `client-clock-<n>`. The process ID is 1 and the Windows session 0; neither is an authenticated identity.
- At one `atMs`, due timers fire first (a retention expiry before a snapshot), then source steps, then probes, then transport steps. A timer fires at its own time, or when a suspend ends if it fell due during it. Timers after the last step do not fire.
- The client applies each server message synchronously and the producer processes each reply before its next action. Every SDK callback, including frame_start, each channel and frame_end, advances `boundaryOrder`. Message `seq` counts written messages. The 50 ms snapshot interval starts at the checkpoint; a publication inside it replaces the one unsent snapshot and increments `coalescedSnapshots`. State is the slot published at the last frame_end (OD-5 S7), so a configuration change after it reaches the client only with the next frame.
- Store retention runs in source time (CD-11). Store misuse would be an invariant violation; the model throws instead of retiring the session, so a defect cannot pass silently.

## Corpus and expectations

[`tests/fixtures/simulator-v1`](../tests/fixtures/simulator-v1) lists 23 synthetic scenarios in `manifest.txt`. Each `<id>.json` has a hand-written `<id>.expected.json` whose `authoredFrom` cites the specification it was derived from. The comparator in [simulator-v1-expected.ts](../tests/shared/simulator-v1-expected.ts) only reads expectations: each connection's welcome, checkpoint, ordered coverage (`{event, type, redelivered}` or `{gap, causes, redelivered}`; `eventRange` abbreviates consecutive events), ACKs, snapshots and `end`, then the ledger and the store. Objects match as subsets, arrays and loss counts exactly, and seeded identifiers appear as labels such as `game-clock-1`. Expectations are wire-level only; trip outcomes belong to ET-014/ET-015, which may add `<id>.trip.expected.json`.

The queue-bytes scenario's split is derived by hand from the documented 6,306-byte `event-worst` measure: its worst achievable record measures 6,001–6,007 bytes, so 174 events fit and eventSeq 175 is the first `queueBytes` loss. The store test keeps the 166/167 split for records of exactly 6,306 bytes.

## Pending

Real-game event rates against the v1 bounds; the native v1 endpoint in a running game; profile change, train crossing, weigh station, special jobs and owned trailers (synthetic only here); QPC behavior across sleep and real UTC changes; second-user and remote rejection (Node pipes are not DACL evidence, PR-2); ET-006b ingestion; the real transactional insert and crash recovery (ET-013/ET-015a); trip outcomes (ET-014/ET-015); TruckersMP detection. There is no automated differential test between this TypeScript model and the native store.
