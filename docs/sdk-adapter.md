# SCS telemetry adapter

ET-003 implements a Windows x64 C++17 DLL, `ets2telemetry-plugin.dll`, against the [pinned official SDK](../native/telemetry-plugin/vendor/README.md). It exposes the exact SDK `scs_telemetry_init` and `scs_telemetry_shutdown` ABI through a module definition file, as the official example does. The existing scaffold DLL and v0 protocol remain independent. No DLL is installed by a build or test.

## Lifecycle and calling context

Initialization accepts telemetry APIs 1.01 and 1.00, known `eut2`/`ats` identifiers, and game telemetry major 1. Unsupported versions return `SCS_RESULT_unsupported` so the game can negotiate a lower API. New game telemetry majors are rejected because they may reinterpret values. Compatible newer minor versions are retained verbatim; channel registration results remain authoritative. Display game names and patch versions are not parsed.

Configuration, frame start/end, started and paused events are required. Gameplay registration is attempted only for API 1.01; an unsupported/not-found result is exposed explicitly. Channel not-found/unsupported-type/unsupported results become `not_supported`, while other registration errors fail initialization and clean up preceding registrations. Repeated successful initialization returns `already_registered` without replacing callbacks. Shutdown is idempotent; each registered entry is unregistered independently, including when a host call throws. SDK callbacks, lifecycle methods, and exported functions contain C++ exceptions. A catch-all does not make invalid pointers or memory corruption safe.

All registration/unregistration calls occur during SDK initialization/shutdown. Runtime callbacks make no SCS calls. The SDK README requires direct game invocation on its main thread; worker/transport methods only read owned snapshots or update atomic consumer gates. There is no worker, I/O, serialization, rendering hook, memory inspection, or `DllMain` implementation in this component.

Release adapter/DLL targets use `/MT`; the standard library/CRT allocations remain in their owning module. SDK inputs are borrowed, copied immediately, and never freed or returned to the game. Only the official borrowed-pointer ABI is exported. Future transport links the internal adapter module and must not export STL containers or allocator ownership across DLLs. The SDK license is retained; current Release imports are audited in the [validation record](validation/et-003.md).

## Owned state and availability

[sdk-adapter.hpp](../native/telemetry-plugin/src/sdk-adapter.hpp) defines fixed storage with no callback allocations. `State` holds current truck/job configuration, channel readings, simulation state, and SDK frame timing. Empty job/truck configuration clears the corresponding current values. A truck configuration invalidates prior dynamic truck values even if the model ID repeats: a model identifier is not an individual truck identity. All identifiers have 128-byte bounds, copied strings 1,024 bytes, and both reject invalid UTF-8/control characters and truncation. Empty identifiers become unavailable. String diagnostics may preserve a valid empty string.

Readings distinguish `available`, `not_observed`, `not_supported`, and `invalid`. Zero and signed reverse speed are valid. A registered channel receiving null is currently unobserved; nonfinite, wrong-type and defensive-range failures are invalid. Missing configuration attributes remain unobserved. A present job configuration can contain individually unavailable fields; ET-004a must not encode a v0 available Job until its mandatory cargo/destination identifiers and required value forms can be represented. No job UUID is invented from cargo, city, income or configuration revision.

## Exact field mapping

Channel names, types and source units come from the unmodified common/game headers in the pinned SDK. `channel_specs()` exposes the normalized output unit and range to consumers.

| Owned value | SDK name/type | Source unit and mapping |
| --- | --- | --- |
| Speed | `truck.speed`, float | m/s, signed; copied, range −1,000–1,000 |
| Fuel amount | `truck.fuel.amount`, float | L; copied, range 0–1,000,000 |
| Fuel capacity | Truck config `fuel.capacity`, float | L; copied, range 0–1,000,000 |
| RPM | `truck.engine.rpm`, float | rpm; copied, range 0–100,000 |
| Displayed gear | `truck.displayed.gear`, s32 | Dashboard index; reverse negative, neutral zero; range −100–100 |
| Odometer | `truck.odometer`, float | km × 1,000 → m; range 0–1e12 m |
| Estimated range | `truck.fuel.range`, float | km × 1,000 → m; range 0–1e12 m |
| SDK average consumption | `truck.fuel.consumption.average`, float | L/km × 100 → L/100km; range 0–1,000,000 |
| Remaining navigation distance | `truck.navigation.distance`, float | Advisor meters; copied, range 0–1e12 m |
| World placement | `truck.world.placement`, dplacement | Owned x/y/z and heading/pitch/roll; finite game-world coordinates and SDK orientation fractions, not latitude/longitude |
| Game time | `game.time`, u32 | Exact in-game minutes since first game day; separate integer reading |
| Planned distance | Job config `planned_distance.km`, u32 | Simulated km × 1,000 → m, excludes ferry distance; 0–1e12 m |
| Expected income | Job config `income`, u64 | Exact integer, no floating-point conversion; expected income only |
| Cargo/destination/origin/company/market | Job string config attributes | Copied source IDs/market, individually available |
| Truck model ID | Truck config `id`, string | Copied source model ID, not a vehicle-instance UUID |
| Frame timestamps | SDK frame-start struct | Exact microseconds: render, simulation, paused simulation; the latter stops while paused |

The game-specific header sections explicitly establish Euro for ETS2 and US dollars for ATS internal telemetry currency, unless a field documents otherwise. Known major-1 games expose `EUR`/`USD` and the exact pinned header reference in `Identity.currency_source`; this comes from the primary SDK source rather than game title, locale or UI currency. Actual game-version observations remain pending. The ATS header warns that its average consumption is mostly static and depends on trailer/driver skills. Neither game's SDK mean is a defined trip-specific average.

The common gameplay header defines `job.delivered`, `job.cancelled`, fines, tolls, ferry and train events. Their generic copied payload preserves the original type: `revenue`, `cancel.penalty`, `fine.amount` and `pay.amount` are **s64**; config expected income is **u64**. Delivery `distance.km` is float real km, distinct from planned distance and odometer; delivery `delivery.time` is u32 total game minutes. Damage is a float fraction, XP s32, auto-park/auto-load bool, and ferry/train source/target names/IDs strings. Terminal delivery/cancellation data remains in its copied frame batch if a later configuration callback clears current job/truck data. If configuration clears first, the terminal event's explicit attributes are still copied; no previous job is guessed. Job disappearance alone has no gameplay effect.

Signed 64-bit and placement observations are internal types. The accepted v0 wire diagnostic schema has neither s64 nor callback envelopes/placement. ET-004a/CAP-01 must choose reviewed encoding/availability and count omitted unsupported observations, not cast s64 to double or silently extend 0.0. This adapter does not serialize them or claim durable delivery.

## Boundaries, ordering and loss

Each SDK callback increments a session-local `boundary_order` before copying. Diagnostics retain that callback order, kind, group/event ID, attribute/channel name and original array index. Configuration revision increments on each truck/job configuration boundary, separately from callback order. These are **not outbound wire `seq`**: ET-004a owns welcome/checkpoint/snapshot/diagnostic sequence allocation and its no-wrap behavior. Exhausted callback order, configuration revision or clock epoch retires the source instead of wrapping.

Process lifetime identity deterministically encodes all process-creation FILETIME and PID bits in a canonical UUID-shaped value. It survives SDK reinit/DLL reload and distinguishes PID reuse; it is a discriminator, not authentication. Plugin-session and source-monotonic-clock UUIDs use Windows system randomness during initialization. QPC records real elapsed nanoseconds in the source clock domain; SDK microseconds/game minutes never serve as sample cadence or UTC. Game clock UUIDs use an initialization random prefix and monotonic 48-bit epoch. SDK timer-restart flags, frame timestamp regressions and game-time regressions rotate the game clock and invalidate ambiguous prior readings while preserving registration capability: a missing game-time channel remains `not_supported` in both typed and scalar readings.

Channel callback order is unspecified. A valid SDK `frame_start` opens a freshness interval, and `frame_end` closes it even when publication is contended. A late game-time regression invalidates only cached channels not observed in that actual frame; values, null/unavailable observations and invalid observations already copied in the frame retain their meanings. Current speed/fuel/placement therefore do not depend on whether their callbacks precede or follow game time. A timer restart at frame start has no fresh channel values yet and clears the prior cache. Freshness markers reset on every frame boundary and SDK initialization/shutdown; channels outside a valid start/end interval are not assumed to belong to a current frame. Forward game-time jumps, profile identity, and arbitrary save loading cannot be inferred reliably from these values; CAP-01 must observe them rather than invent detection.

The producer's current state is private to the SDK thread. A frame-end publication copies a complete state/configuration and at most **32 observations** under `try_lock`; callbacks never wait for a reader. A read-side lock protects a single published current snapshot and a single ready diagnostic batch. If a reader holds the lock, the published older boundary stays intact, current producer state remains ready for the next frame, and omitted publication/diagnostic counts increase. A published but unconsumed snapshot replaced by a new one also counts coalescing and discarded diagnostics. Neither path mixes partial frame values. Consumers must use `boundary_order`/capture age as freshness evidence; a contended boundary is not retroactively reconstructed.

`read_latest` consumes the ready slot once; `read_current` provides an owned current checkpoint without consuming that slot and strips diagnostics. After shutdown/exhaustion, an atomic `source_retired` read-side fence marks even a contended, older cached boundary unusable as an active source. It is local lifetime metadata, not a new v0 wire field; transport must stop emission/connection on retirement. Both calls take only an internal copy lock and call no SDK APIs. They execute no external callback while holding the lock.

`set_consumer(connected, diagnostics)` is a future transport gate, default disabled on each init. Disabling/disconnecting atomically closes the copy gate and erases both ready and pending batches synchronously under internal copy locks. Diagnostic copying and publication use `try_lock` on the pending batch too, so this cannot stall an SDK callback. Cross-thread discard counts are transferred through an atomic counter into the next coherent producer boundary. No offline event is delivered or added while disabled. There is no event queue, samples, spool, file I/O, durable ACK or history. Offline operation retains current state/configuration and loss counters only. A reconnect checkpoint hydrates present values; it cannot replay terminal gameplay effects.

Configuration/gameplay scans inspect at most **256 entries including the terminator**, allowing indexed truck-wheel attributes. No terminator within the cap invalidates the relevant current configuration and increments a known-loss lower bound; unknown tail length is not fabricated. Each callback observation omitted because diagnostics are disabled/offline/full increments `lost_observations`; markers also count. A marker distinguishes an event with no attributes. A configuration with 255 attributes plus a terminator fits; larger inputs are bounded omissions, not evidence of supported game payload size. Copying work is bounded by this cap and the fixed string/batch capacities. `offline_transitions` counts known simulation/configuration boundaries and recognized timer regressions while disconnected. `callback_failures` is local adapter metadata; loss counters saturate rather than wrap. Zero omissions never proves complete initial coverage.

## Pending evidence and next consumers

Real availability/ordering for both games, Convoy and TruckersMP, ferry/train, sleep, road service, quick-job/truck/profile changes, and multiplayer menu/pause behavior remains pending. The common gameplay header does not define sleep, road-service or profile-change events; this adapter does not invent them. Registration success indicates an API capability, not observation of every named gameplay event. No compatibility, game latency or frame-time claim follows from fake callbacks.

ET-004a owns secure pipe I/O, peer/process validation, wire conversion, handshake/outbound sequence, cancellation and transport lifecycle. ET-007 owns verified game-window state. CAP-01 owns opt-in application-side diagnostic capture and observed capability evidence; CAP-01a adds the [CAP0 evidence copy](protocol/cap0.md) from these same callbacks without additional SDK calls; durable recording waits for the later v1 packages. [ET-003 validation](validation/et-003.md) records executed checks and pending acceptance.
