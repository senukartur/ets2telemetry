# CAP0 evidence capture contract 0.0

CAP-01a (card ET-009, package of CAP-01) defines CAP0: a separately versioned, default-off, evidence-only capture contract for copied SDK configuration, gameplay and lifecycle callbacks. It implements the interface and bounds the owner approved on October 12, 2026. It exists to collect real-game evidence in owner-scheduled sessions before protocol v1 is designed. This package adds no real-game evidence. It does not accept CAP-01, does not make ET-009 Done, and authorizes no protocol v1, durable history, trip logic or renderer feature.

Implementations:

| Role | Files |
| --- | --- |
| Native copy queue | [evidence-queue.hpp](../../native/telemetry-plugin/src/evidence-queue.hpp), [evidence-queue.cpp](../../native/telemetry-plugin/src/evidence-queue.cpp), hooks in [sdk-adapter.cpp](../../native/telemetry-plugin/src/sdk-adapter.cpp) |
| Native wire and endpoint | [capture-wire.cpp](../../native/telemetry-plugin/src/capture-wire.cpp), [capture-server.cpp](../../native/telemetry-plugin/src/capture-server.cpp), [capture-hello.hpp](../../native/telemetry-plugin/src/capture-hello.hpp) |
| Broker capture mode | [client.cpp](../../native/telemetry-client/src/client.cpp) (`--capture cap0`) |
| TypeScript contract | [capture-cap0.ts](../../packages/contracts/src/capture-cap0.ts) |
| Service session and writer | [capture-controller.ts](../../apps/desktop/src/capture-controller.ts), [capture-session.ts](../../apps/desktop/src/capture-session.ts), [capture-writer.ts](../../apps/desktop/src/capture-writer.ts), [capture-activation.ts](../../apps/desktop/src/capture-activation.ts) |
| Export sanitizer | [tools/capture-export](../../tools/capture-export/src/sanitize.ts) |

## Isolation from protocol v0

CAP0 is not a v0 minor version, extension or diagnostics mode. The v0 handshake, parser, schema, fixtures, live subscriptions, overlay and SQLite probe are unchanged. `diagnostics: true` does not make the v0 parser accept CAP0 data; tests assert that both the TypeScript and C++ v0 decoders reject every CAP0 packet and the CAP0 hello, and that CAP0 decoders reject v0 messages.

CAP0 has its own pipe, worker thread, queue, hello, receipt marker and decoder. Its capture worker can stall or fail without delaying SDK callbacks or v0 frames: the adapter copies into the CAP0 queue without locks or waits, and the CAP0 worker never touches v0 slots. Copying into CAP0 does not change v0 snapshots, continuity counters or v0 diagnostic batches; a test drives an evidence-enabled adapter and a reference adapter identically and compares them.

## Activation and authority

Capture is off by default. Activation is the narrowest launch-time switch the application already uses for source configuration: environment variables read once by Electron main, never by the renderer.

| Variable | Meaning |
| --- | --- |
| `ETS2TELEMETRY_CAPTURE=cap0` | Requests one capture interval. Any other non-empty value rejects activation. |
| `ETS2TELEMETRY_CAPTURE_MINUTES` | Optional explicitly selected interval, integer 1-60. Default 10. |
| `ETS2TELEMETRY_CAPTURE_LABEL` | Optional operator label for the manifest, `^[a-z0-9][a-z0-9.-]{0,63}$`, for example `ets2-sp-windowed`. |

Main logs `CAPTURE_ACTIVATION` or `CAPTURE_ACTIVATION_REJECTED`. It attaches a one-shot grant (format, interval, label, display summary) to the first verified ETS2/ATS `select` message that carries the fixed broker. Later selections and supervised service restarts never renew it; a new interval requires a new explicit launch. The renderer and preload APIs are unchanged and cannot select paths, endpoints or capture. The service validates the grant independently; a rejected grant never fails live source selection.

The plugin always publishes a passive CAP0 endpoint after v0 startup succeeds. Its creation is asynchronous and its failure never disables v0. The endpoint copies nothing until an authorized client completes the opt-in hello:

```text
\\.\pipe\ETS2Telemetry-{game}-cap0-{userTag}-{windowsSessionId}-{processInstanceId}-{pluginSessionId}
```

It uses the v0 security model: explicit protected current-user DACL, `PIPE_REJECT_REMOTE_CLIENTS`, `FILE_FLAG_FIRST_PIPE_INSTANCE`, one instance and one client, and no adoption of a pre-existing endpoint. The connected client's PID, token user, Windows session, final image path and image SHA-256 must match the protected `service-policy.json`, exactly as for v0. The native broker (`telemetry-pipe-client.exe --game ets2|ats --discovery-dir <dir> --capture cap0`) performs the unchanged discovery and connected-server authority checks against the v0 discovery record, derives the CAP0 name from that verified record and connects only there. Its authority receipt has the six v0 receipt fields plus `"evidence":"cap0"`; the service rejects a receipt without that marker. The broker accepts only a CAP0 hello on stdin and relays one packet per stdio credit.

The client sends one hello within five seconds, at most 4,096 payload bytes; the prefix bound is enforced before payload accumulation and any additional client byte closes the connection:

```json
{"format":"ets2telemetry-cap0","version":{"major":0,"minor":0},"kind":"hello","captureSessionId":"<uuid>","data":{"evidenceOnly":true}}
```

Only then does the worker prepare the queue (allocating its arena outside callbacks), open the capture gate and send the header. There is no offline spool: callbacks before the gate opens, between captures, or after the client leaves are not copied. A reconnecting client starts a new capture with `envelopeSeq` 1.

## Native copy and queue bounds

On configuration, gameplay, `started`/`paused`, SDK timer restart and game-time regression callbacks, the adapter copies one envelope from the same borrowed SDK input it already inspects. It makes no additional SDK calls. Per-frame channel values are not CAP0 envelopes. JSON is never built in a callback.

| Bound | Value | Behaviour at the bound |
| --- | --- | --- |
| Queue envelopes | 128 | Newest envelope dropped, `droppedQueueFull` counted |
| Queue bytes | 2 MiB (2,097,152) | Newest envelope dropped, `droppedBytesFull` counted; a record never straddles the ring end |
| Attribute scan | 256 entries including terminator | `terminated:false`, `omittedLowerBound:1`; unknown tail length is not invented |
| Identifier/name bytes | 128 | Element `invalid`/`too-long`; never truncated |
| String value bytes | 1,024 | Element `invalid`/`too-long`; never truncated |
| Packet payload | 65,536 bytes plus 4-byte prefix | Envelope split into ordered attribute ranges |
| Hello payload | 4,096 bytes | Connection closed before payload accumulation |
| Write deadline | 1 s per packet | Capture connection closed; source unaffected |

The queue is single-producer, single-consumer and lock-free. A callback never waits, allocates or performs I/O; a Dekker handshake lets the worker close the gate after an in-progress copy finishes. The binary record is fixed by measured size before copying, so contents remain intact across wrap-around. Each attempted envelope receives an `envelopeSeq`, including dropped ones; the next retained envelope carries `droppedBefore`, the exact count of dropped envelopes since the previous retained one.

The producer publishes each attempt's counter changes (attempted, enqueued or dropped, drop cause, bytes, last dropped sequence and time) as one seqlock version; the worker's snapshot retries across a concurrent write and never blocks the producer. Every snapshot therefore satisfies `attempted = enqueued + dropped` and `dropped = droppedQueueFull + droppedBytesFull`, so loss and end packets built while callbacks continue are internally consistent. The reader retries only while a counter write is in progress; real callbacks are spaced by game work, so the retry is short. A producer writing back to back could delay the worker's snapshot, but never the reverse.

While capturing, the worker checks source liveness through a lock-free flag; it reads the full adapter snapshot only once, for the header, so it never contends with the SDK thread's v0 publication lock. An idle listener waits for a connection without periodic wake-ups.

## Wire format

Every packet is a four-byte unsigned little-endian length followed by 1-65,536 bytes of UTF-8 JSON, parsed by the same bounded strict parser rules as v0 (duplicate keys, invalid UTF-8, lone surrogates and trailing data rejected; depth at most 16). Unknown keys are rejected. Every packet has:

| Field | Contract |
| --- | --- |
| `format` | `ets2telemetry-cap0` |
| `version` | `{"major":0,"minor":0}`; any other version is rejected |
| `kind` | `header`, `envelope`, `loss` or `end` |
| `captureSessionId` | UUID chosen by the application for this capture |
| `packetSeq` | Decimal-string uint64, contiguous from 0 per capture |
| `publishMonotonicNs` | Worker serialization time in the source monotonic clock |

Unavailable values always use `{"available":false,"reason":"not-observed|not-supported|invalid","detail":"..."}` with `detail` one of `none`, `null-value`, `too-long`, `invalid-utf8`, `non-finite`, `unsupported-type`, `null-name`, `null-attributes`.

**header** (first packet only): `origin` (`game` or `synthetic`), `source` (`game`, `sdkGameId`, `processId`, `windowsSessionId`, `processInstanceId`, `pluginSessionId`), `versions` (`telemetryApi` and `gameTelemetry` as major/minor, `sdkArchive`, `pluginImage` final path and SHA-256 of the producing module), `clocks` (`sourceMonotonicClockId`, `gameClockIdAtOpen`, `openMonotonicNs`), `currency` (SDK-header-sourced code and reference), `publishedBoundaryOrderAtOpen` and the exact `bounds` above. Different bounds are a different producer and are rejected. The application rejects a header whose source differs from the broker authority. The production DLL reports `origin:"game"`; the tests-only DLL and console fixtures report `synthetic`.

**envelope**: `envelopeSeq`, `droppedBefore`, `callback` (`group` `configuration|gameplay|lifecycle` and its `id`), `sharedBoundaryOrder`, `configurationRevision`, `callbackMonotonicNs`, `sdkFrame` (`renderTimeUs`, `simulationTimeUs`, `pausedSimulationTimeUs` from the last frame start), `gameTime` (`minutes`, `clockId`), `simulation`, `attributes` (`expected`, `present`, `terminated`, `total`, `first`, `count`, `final`, `omittedLowerBound`) and `observations`. Lifecycle ids are `simulation.started`, `simulation.paused`, `timers.restart` and `game.time.regression`. Each observation has `position` (original attribute index in the SDK array), `name`, `arrayIndex` (the SDK attribute index; unavailable for non-array attributes), `sdkType`/`sdkTypeId` (original SCS value type) and `value`:

| SDK type | JSON value |
| --- | --- |
| `bool` | boolean |
| `s32`, `u32` | integer number |
| `s64`, `u64` | decimal string (never a JSON number) |
| `float`, `double` | finite number; float values are exactly widened and round-trip |
| `fvector`, `dvector` | `{x,y,z}` |
| `euler` | `{heading,pitch,roll}` |
| `fplacement`, `dplacement` | `{position:{x,y,z},orientation:{heading,pitch,roll}}` |
| `string` | string up to 1,024 UTF-8 bytes; valid control characters are preserved and JSON-escaped |
| other | `unknown` type, always unavailable `not-supported` |

An envelope larger than one packet is sent as consecutive packets with the same `envelopeSeq`, contiguous `first`/`count` ranges and `final:true` on the last part. Every copied attribute appears exactly once. A single observation is at most about 8 KiB after escaping, so the 64 KiB limit always admits it; a smaller test limit that cannot fit one fails explicitly.

**loss**: cumulative `attemptedEnvelopes`, `droppedEnvelopes`, `droppedBytes`, `droppedQueueFull`, `droppedBytesFull`, `lastDroppedEnvelopeSeq` and `lastDropMonotonicNs`. Sent when drops change, at most every 100 ms, and before an end marker.

**end**: `reason` (`plugin-shutdown`, `source-retired`, `encoding-failed`) with attempted, enqueued, published, dropped and unsent envelope counts. On SDK shutdown a frame write already in flight gets up to 250 ms to complete rather than being truncated. The worker then drains already copied envelopes for up to 200 ms and sends any loss packet and the end marker within a further 100 ms, reporting envelopes still queued as `unsentEnvelopes`. It closes its handle without `DisconnectNamedPipe`, which would discard unread bytes. If the in-flight write, a drain write or the marker write cannot complete in that budget (a client that has stopped reading), the write is cancelled, a partial frame may remain and no end marker is sent; the application then records a disconnect without an end marker. After a non-shutdown end marker the endpoint waits up to one second for the client to close before serving again.

Packets are never stamped with a fabricated time. If the source monotonic clock cannot be read (not expected on supported Windows versions), the worker refuses to open the gate when the hello arrives, or closes an open capture connection without further packets. The application then records a disconnect without an end marker.

### Ordering

The TypeScript stream validator requires the header first, contiguous `packetSeq`, non-decreasing `publishMonotonicNs`, increasing `envelopeSeq` with `droppedBefore` equal to the exact gap, uninterrupted split parts, increasing `sharedBoundaryOrder`, non-decreasing loss counters, a callback time not after publication, and nothing after `end`. It never reorders, deduplicates or repairs evidence; a violation closes the capture as `protocol-error`.

`sharedBoundaryOrder` is the adapter's counter incremented by every SDK callback, including channel callbacks that are not captured, so gaps are normal. It shows the order in which this adapter observed callbacks; it is **not** a proven per-callback total order of the game.

## Clock domains

Values from different domains are never subtracted from one another.

| Domain | Fields | Meaning |
| --- | --- | --- |
| SDK frame time | `sdkFrame.*` | Game-provided microseconds from the last frame start; can restart (`timers.restart`) |
| Game time | `gameTime.minutes`, `gameTime.clockId` | In-game minutes; the clock id rotates on restarts and regressions |
| Source monotonic | `callbackMonotonicNs`, `publishMonotonicNs`, `lastDropMonotonicNs` | Plugin QPC domain identified by `sourceMonotonicClockId`; callback copy, drop and worker publication are stages of one clock |
| File receipt | `receipt.monotonicNs`, `receipt.utcUnixMs` | Telemetry service receipt before the file write; its own `receiptClockId`. UTC is a label and may jump |

## Application writer and output

`CaptureSession` and `CaptureWriter` run in the telemetry utilityProcess. The service validates and admits each packet synchronously, then returns one broker credit; the writer is therefore the only backpressure point.

| Writer bound | Value |
| --- | --- |
| Pending (admitted but unwritten, including the write in flight) | 2 MiB |
| `packets.ndjson` size | 20 MiB per capture |
| Collection deadline | 10 minutes by default; 1-60 minutes only by explicit activation |

Output is resolved at runtime under `%LOCALAPPDATA%\ETS2Telemetry\captures\{captureSessionId}\`, separate from `telemetry.sqlite` and application binaries. An existing directory is never reused. `packets.ndjson` contains one line per validated packet: `{"receipt":{"seq","monotonicNs","utcUnixMs"},"packet":<payload>}`. `<payload>` is the validated wire payload text stored verbatim, so values and number spellings (including `-0`) are exact; the only change is that insignificant JSON line breaks become spaces to keep one packet per line. The file is therefore not a byte copy of the wire frames: the length prefixes are dropped and the receipt wrapper is added.

The capture closes on: end marker (`source-end`), source disconnect (`disconnect`), deadline, pending cap, file cap, write failure, invalid stream (`protocol-error`), an explicitly invalid broker receipt or protocol use (`authority-rejected`), exhausted transient pre-authority retries (`source-unavailable`), an unexpected internal failure such as an invalid receipt clock (`internal-error`) or service stop. Every close attempts to write `manifest.json` (temporary file, then rename). Closing never throws into the service. If the manifest cannot be written, no `manifest.json` exists, the temporary file is removed when possible, and the service logs `CAPTURE_CLOSED` with `manifestWriteError`; the session still finishes and tears down the broker. If the telemetry service process itself is terminated mid-capture, `packets.ndjson` remains without a manifest. The exporter refuses such a directory, because it cannot verify integrity without the manifest hash. The manifest records status (`complete` only with an end marker, no discarded packets and no open split envelope), stop reason, activation, broker authority, the header, clock-domain descriptions, receipt timing, counts of received/written/discarded packets and bytes, the last plugin loss packet, the end marker, known `droppedBefore` boundaries (first 1,000 plus an omitted count), partial-envelope state, limits, the `packets.ndjson` byte count and SHA-256, code identity (desktop build-evidence hash, broker hash, Electron/Node versions, CI source commit when present), platform (Windows version/release/architecture) and display summary. It states `durableAck`, `tripEffects`, `history` and `playback` as `false`.

If the discovery record is absent the session retries every second until the deadline. Transient failures before authority (the broker's 5-second authority deadline, for example on a cold image-hash cache, a broker that cannot start, or a broker exit before its receipt) are retried with a 250 ms to 4 s backoff for at most 60 seconds from the first such failure, then end the capture as `source-unavailable`. Pending retries are cancelled by the deadline and by service stop. The grant remains one capture per launch, and once an authorized capture ends it is never reconnected. Real unknown cases remain missing, never synthetic passes.

## Export and sanitization

Raw captures stay local. They are never committed to Git or uploaded automatically. To share evidence, export a sanitized copy:

```powershell
npm run capture:export -- "$env:LOCALAPPDATA\ETS2Telemetry\captures\<captureSessionId>" "<new-export-directory>"
```

The exporter verifies the raw `packets.ndjson` length and SHA-256 against the manifest, then writes `packets.ndjson`, `manifest.json` and `export.json` to a new directory. UUIDs, process IDs, Windows session IDs, process creation times, user tags, display IDs and local paths become first-appearance tokens: equal inputs share a token and token order follows first appearance, so equality and ordering relationships survive. Paths are also redacted where they appear inside free text: drive, UNC and `\\?\` paths are replaced from their start to the end of the path-like text (spaces included, so trailing context may be removed too), and `Users`/`home`/`Documents and Settings` folder names in relative fragments become `redacted-user-N`. UTC receipt labels are rebased to the capture start. Monotonic clocks, sequences, SDK identifiers and copied game values are kept. Exported lines are re-serialized JSON, with `-0` preserved. The mapping is never written. Game-provided strings (for example cargo, city or licence-plate text) and the operator label are retained, so review an export before sharing it; copied game strings can contain player-entered or localized data.

## Non-goals

CAP0 has no durable ACK, redelivery, persistence, trip or history effect, playback-as-game path, renderer API or arbitrary endpoint/path selection. It does not establish that any event, unit, currency or clock behaviour occurs in a running game: those observations, both games, the required modes and late-attach/reconnect/save-load/travel cases remain pending CAP-01 evidence. See [CAP-01a validation](../validation/cap-01a.md).
