# Trip lifecycle and completeness

ET-014 adds a pure, deterministic trip reducer in [packages/telemetry-core/src/trips](../packages/telemetry-core/src/trips). It turns committed protocol v1 events and gaps, session changes, checkpoint hydration and disconnections into the storage `TripEffect` lists that [storage](storage.md#storage-api) applies in the same transaction as the event or gap. The coordinator adopted decisions T1–T20 under the owner's standing delegation of October 15, 2026 ([concept.md](../concept.md#et-014-authorization--october-15-2026)).

Status (October 15, 2026):

- **PR-1**: the event-driven lifecycle, identity, attribution and completeness. It covers T1–T15 and T18–T20 as they apply to events.
- **PR-2**: [readings accounting](#readings-accounting-t16-t17) (T16, T17): observed distance, fuel used, refuels, game-time jumps, crossings, position jumps and reading holes, plus replay of the ET-005b simulator scenarios against hand-written trip expectations.
- Nothing records yet. No storage schema, wire, preload/IPC, renderer or native code changes. ET-015a wires the reducer into commits.
- Behaviour seen in real traces rests only on the reviewed CAP-01 observations O1–O11 ([CAP-01a validation](validation/cap-01a.md)). Everything else is synthetic inference and stays pending until real-game sessions ([ET-014 validation](validation/et-014.md)).

## Interface

All values are plain data: uint64 values stay decimal strings, and the state survives structured cloning and JSON. The reducer never mutates its inputs. It imports the storage effect types as types only from `packages/storage/src/api.ts` (T2); the [boundary test](../tests/unit/telemetry-core-boundaries.test.ts) allows exactly that import.

| Export | Purpose |
| --- | --- |
| `initialTripState()` | No connection, no session, every game idle |
| `stepTrip(state, input)` | `{ok: true, state, effects}` or `{ok: false, code}` with `ORDER_VIOLATION`, `COVERAGE_MISMATCH` or `UNKNOWN_SESSION` |
| `tripView(state, game)` | Phase, untracked job, the open trip and the last closed trip of one game |
| `tripUuidFor(pluginSessionId, jobEventSeq)`, `jobKey(job)` | Trip identity (T4) and job identity (T6) |
| `MAX_EFFECTS` (16), `MAX_ANNOTATIONS_PER_COMMIT` (8) | Per-commit bounds (T18); a test checks that `MAX_EFFECTS` equals storage's |

Inputs (`TripInput`):

| Kind | Carries | Effects |
| --- | --- | --- |
| `session` | The validated welcome, the coverage `upsertSession` returned, and `openTrips` (`TripSeed[]`) on a cold start | None; decided effects wait in the game's queue |
| `checkpoint` | The connection's checkpoint | None (hydration only, T9) |
| `event`, `gap` | The message, `coveredThrough` read right before the commit, and `receivedUtcMs` | The effects for that message's commit |
| `reading` | A normalized state of the current connection (the checkpoint's and each snapshot's), with its source identity, capture time and UTC label | None; distance and fuel accumulate, and annotations or a reading-hole downgrade wait for the game's next carrier |
| `disconnected` | — | None |

## Caller contract for ET-015a

**Adopt after commit (T3).** For each event or gap, the caller:

1. reads `committedThrough()` right before the commit, as the storage caller rule requires;
2. steps the reducer;
3. commits the message with the returned effects;
4. adopts the returned state only when storage reports `committed`, `duplicate`, `covered` or `conflict`.

On a retryable or failed commit the caller keeps the old state. When the item is redelivered, the reducer then returns the same effects. Non-carrier inputs (session, checkpoint, disconnected) are adopted immediately. An `ok: false` result fails closed: durable delivery must stop, as for any other contract violation.

**Connections.** Every connection ends with a `disconnected` input before the next connection's `session` input, including a reconnection to the same plugin session, a switch to the other game and a new plugin session. The reducer takes the interval in which the consumer was not connected from that input; an item or a reading of a session that is not the current connection's is refused.

**Readings.** The caller feeds the checkpoint's state as a reading right after the `checkpoint` input, and each snapshot's state as a reading, in stream order with the events and gaps. A reading is adopted at once, like other non-carrier inputs.

**Coverage (T5).** The reducer keeps a processed point per plugin session:

- every carrier's `coveredThrough` must equal it, or the result is `COVERAGE_MISMATCH`;
- an eventSeq at or below it is a no-op, and the same state object comes back;
- a skipped eventSeq is `ORDER_VIOLATION`;
- a gap applies only to its suffix (processed point, `lastEventSeq`], the storage `previouslyCoveredThrough` rule;
- an item of a session that is not the current connection's is `UNKNOWN_SESSION`.

Because the reducer applies effects only for new coverage and queues them otherwise, effects never go into a commit that storage would answer with `duplicate` or `covered`.

**Cold start (`TripSeed`).** When the service starts while storage holds open trips of the welcome's game, the caller passes them with the first session input:

- `{tripUuid, pluginSessionId, game, jobKey, startedUtcMs, recordingCompleteness, lastObservedUtcMs?}`;
- `jobKey` is `jobKey()` of the trip's stored job configuration. With null, no later job ever matches it;
- `lastObservedUtcMs` is the label of the session's last stored item;
- `observedDistanceM` (PR-2) is the trip's stored observed distance when it is available; a resumed trip accumulates from it, so its next update never replaces the stored value with a smaller one;
- `awaitingOutcome` (PR-2 fix round 1) is true when the trip's job was cleared before the stop: a stored `job.cleared` of the session after the trip's job configuration with no later `job.configured`. The trip then resumes awaiting its outcome, so free driving after the clear adds no distance, and a later outcome still attaches;
- a seed of another plugin session closes as `restart` at the new session's first commit (T11);
- a seed of the same session resumes as an active trip (awaiting its outcome with `awaitingOutcome`) and becomes partial with a `not-connected` interval (`consumer-restart`): the consumer was not running for part of it. Its reload-check phase, load window and money totals are not rebuilt. Its `cargoLoaded` is unknown too, so after a clear its identical re-send never matches: an O10 save load then closes the resumed trip and opens a not-merged continuation, which is the conservative result.

**Storage gaps (T19).** No storage change is part of ET-014. These gaps go to ET-015a or ET-016:

| # | Gap | Proposed owner |
| --- | --- | --- |
| S-1 | No fuel-used column on trips; PR-2 reports fuel used, refuelled litres and refuel episodes in the view only. `trip.close` has no detail, so the close carries none of them | Schema v2 `observed_fuel_used_l`, ET-015a |
| S-2 | A late-attached job cannot open a trip from the checkpoint: storage opens trips only at a job configuration event, and hydration stores no configuration rows. The job stays untracked until an identical `job.configured` arrives | Schema v2 and concept §7 wording, decided at ET-015a or ET-016 |
| S-3 | The current synchronous `EffectsHook` of the durable sink gets no commit result, so it cannot follow T3 | ET-015a replaces it with step, commit, then adopt |
| S-4 | Continuations have no column; they live in completeness `detail` JSON (`continuationOf`) | Acceptable as is |

Open question for ET-015a: the alternative to seeds is rebuilding the state by replaying the session's stored items through the reducer alone, from coverage 0. That needs the stored gap rows as well, and the storage read API lists events but not gaps.

## States and transitions

Each game has one slot with at most one open trip. Without an open trip the slot is **idle**. An open trip is in one of three phases:

- **active**;
- **awaiting-outcome**, after `job.cleared`;
- **reload-check**, after an identical re-send following a clear.

A newly opened trip also has a **load window**. If its job was configured outside a running simulation, the window lasts until the next `simulation.started` and for the one event right after it. A `timers.restart` or `gameTime.regression` inside the window is the load that restored this job (O1, O10), so it does not close the trip.

The session's **load state** is `loading` from a fresh session until its first `simulation.started`, and again after `timers.restart` until the next start (O1). A `gameTime.regression` never starts a load: it follows the start of the load it ends (O10), so it leaves the state unchanged, or sets `running` when it occurred while running. The state is `unknown` after a gap or when the reducer joins a session that already has committed events.

A job is **untracked** when it is known or likely active but no trip tracks it: a checkpoint job seen while idle (T9), or the job of a trip that a gap closed before its clear or outcome. It stays untracked until `job.cleared`, an outcome or a new trip. A later checkpoint while idle replaces it, or clears it when that checkpoint shows no job. A new plugin session starts with none.

**Replayed events.** A checkpoint describes the state at its `status.delivery.nextEventSeq`. The producer's retained events below that point arrive after the checkpoint but happened before it, while the consumer was not attached (protocol v1 §7, §9). The reducer keeps that point per session and treats a replayed event as an ordinary stream event:

- a checkpoint job applies only from the point on, so a replayed fine with no open trip is `free-driving`, and a replayed clear or outcome does not end the untracked checkpoint job;
- a replayed `job.configured` opens an ordinary trip from its real configuration event, never a `late-attach` match. It is partial with a `not-connected` interval `opened-before-attach`, because the consumer has no readings from before it attached. `late-attach` stays reserved for a job whose configuration event the consumer never receives.

A gap-sourced untracked job is unaffected: a gap is itself a stream item in order.

| From | Trigger | To | Effects |
| --- | --- | --- | --- |
| idle | `job.configured` | active | `trip.open` at this event with the session's current truck and trailer references and game mode; cause intervals below |
| active | same-key `job.configured` | active | none; `cargoLoaded` is updated (O3) |
| active | different-key `job.configured` | active (new) | close `{none, different-job, partial}`; open the new trip |
| active | `job.cleared` | awaiting-outcome | none |
| awaiting-outcome | same-key `job.configured` with the trip's last `cargoLoaded` | reload-check | none |
| awaiting-outcome or reload-check | same-key `job.configured` with a different `cargoLoaded`, such as a save from before a cargo-market pickup | active (new) | close `{none, configuration-cleared, partial}`; open a new trip at this event with a `reload` continuation interval. The closed trip keeps its `cargoLoaded` (concept.md, October 14, 2026: continue only when every attribute is identical) |
| awaiting-outcome or reload-check | different-key `job.configured` | active (new) | close `{none, configuration-cleared, partial}`; open the new trip |
| active or awaiting-outcome | `job.delivered` / `job.cancelled` | idle | attribute `trip`; close `{outcome, this-event}`, `complete` after a clean window, else `partial` |
| active, in its load window before the start | `job.delivered` / `job.cancelled` | active | attribute `ambiguous`; the trip stays open (T14) |
| active, in its load window | `timers.restart` | active | trip.update `partial` and an `opened-at-load` interval, once |
| active, in its load window | `gameTime.regression` | active | trip.update `partial`; a `save-load` interval |
| active or awaiting-outcome, outside the load window | `timers.restart` or `gameTime.regression` | idle | close `{none, discontinuity, partial}` |
| reload-check | `gameTime.regression` | active (same trip) | trip.update `partial`; a `save-load` interval (O10) |
| reload-check | `job.cleared` | awaiting-outcome | none |
| reload-check | truck/trailer configure or clear, pause or start, same-key re-send, `source.gameMode` | reload-check | as in active |
| reload-check | `timers.restart`, a fine, toll, ferry or train | active (new) | close `{none, configuration-cleared, partial}`; open a new trip from the re-send (`jobConfiguration: {eventSeq}`) with a `reload` continuation interval. A gameplay event is attributed `ambiguous`. After a timer restart the new trip keeps a load window |
| reload-check | `job.delivered` / `job.cancelled` | idle | close `{none, configuration-cleared, partial}`; attribute `ambiguous`; no new trip opens, because the outcome ended whichever job it was |
| any open | gap with a new suffix | idle | close `{none, gap, partial}` and the gap interval (T10). Unless the trip was awaiting its outcome, its job becomes untracked |
| idle | gap with a new suffix | idle | a session-level gap interval |
| any open | `truck.configured` with different values | unchanged | trip.update `truckConfiguration: this-event`; a `truck-change` annotation unless it is the first truck reference |
| any open | `trailer.configured` with different values for its slot | unchanged | trip.update `trailerConfigurations: [this-event]` |
| any open | `source.gameMode` that differs from the trip's mode | unchanged | trip.update `gameModeAmbiguous: true`, once |
| open trip of an earlier session of the game | new session | idle | close `{none, restart, partial}` at the new session's first commit. A continuation candidate left by an earlier close is relabelled `restart` |
| open trip of this session | reconnection after `disconnected` | unchanged | trip.update `partial`; a `not-connected` interval from the last item before the disconnection |
| any | checkpoint | unchanged | none; the session keeps the checkpoint's `nextEventSeq`, and an idle slot records the checkpoint job as untracked from that point on (T9) |

Cause intervals on `trip.open` make the new trip partial:

- `opened-at-load` (`discontinuity`): the session is loading (T12);
- `late-attach` (`not-connected`): an identical job was untracked since a checkpoint, and this configuration is not replayed (T9);
- `opened-before-attach` (`not-connected`): the configuration is replayed from before the connection's checkpoint;
- `{cause, continuationOf, decision: 'not-merged'}` (`discontinuity`): the last trip of this game closed without an outcome and had the same job key. Its close reason is the cause: `restart` (T11), `gap`, `discontinuity` or `configuration-cleared`. A candidate that crosses a plugin restart is `restart`, and an outcome clears it. Identical jobs are never merged.

### Interval detail keys

Every `completeness.add` of the reducer carries a `detail` object (storage keeps it as JSON). Event sequence numbers in it are uint64 decimal strings.

| `detail.cause` | Interval kind | Other keys |
| --- | --- | --- |
| `opened-at-load` | `discontinuity` | `atEventSeq`: the event that opened the trip, or the timer restart inside its load window |
| `late-attach` | `not-connected` | `atEventSeq`: the opening event |
| `opened-before-attach` | `not-connected` | `atEventSeq`: the replayed opening event |
| `restart`, `gap`, `discontinuity`, `configuration-cleared` | `discontinuity` | `continuationOf`: the earlier trip's UUID; `decision`: `not-merged`; `atEventSeq`: the opening event |
| `reload` | `discontinuity` | `continuationOf`, `decision: 'not-merged'`; `atEventSeq`: the decisive event |
| `save-load` | `discontinuity` | `fromClockId`, `toClockId`: the game clocks of the `gameTime.regression`; `atEventSeq`: the regression |
| `gap` (an interval of the gap itself) | `event-loss` or `not-connected` | `causes`: the record's six loss counters; `firstEventSeq`, `lastEventSeq`: the whole record's range (the interval's own range is the new suffix); `redelivered` |
| `disconnected` | `not-connected` | `odometerDeltaM` (PR-2), always present: null when queued, then set by the first reading of the new connection while the interval still waits, to the metres from the last reading before the disconnection to it. It stays null without an odometer or a known truck at either end, after a truck change (brand, model or plate, as in `derived.ts`) or without a reading; a truck unavailable at both ends, even for the same reason, is not known. The interval carries `startUtcMs` and, on the same source clock, `startMonotonicNs`, `endMonotonicNs` and `sourceClockId` |
| `consumer-restart` | `not-connected` | none |
| `reading-hole` (PR-2) | `sample-loss` | none for one hole. An interval extended by later holes carries `holes`, their number, and `includesReadings: true` when it was extended over readings (beyond four waiting holes). The interval carries `startMonotonicNs`, `endMonotonicNs` and `sourceClockId`, and the UTC labels when both are valid and the later one is not earlier |
| `truck-change` (annotation) | `discontinuity` | `annotation: true`; `atEventSeq`; after merging also `count` and `lastAtEventSeq` |
| `utc-label-jump` (annotation) | `discontinuity` | `annotation: true`; `labelUtcMs`: the label that preceded the start; `clampedToUtcMs`: the trip start; `atEventSeq`, null for a restart close |
| `odometer-regressed`, `odometer-jump` (annotations, PR-2) | `discontinuity` | `annotation: true`; `deltaM`: the excluded odometer change; `atMonotonicNs`: the later reading's capture time; after merging also `count` and `lastAtMonotonicNs` |
| `game-time-jump` (annotation, PR-2) | `discontinuity` | `annotation: true`; `label`: `crossing` or `possible-sleep`; `fromMinutes`, `toMinutes`: game minutes as decimal strings; `atMonotonicNs`: the reading where it was found. While it waits, wherever it is in the queue, a growing jump updates `toMinutes`, `lastAtMonotonicNs` and an upgrade to `crossing`; one that grows after it was sent gets a new annotation with `continues: true` whose `fromMinutes` is where the sent one ended, so the ranges never overlap. Never merged with another jump |
| `position-jump` (annotation, PR-2) | `discontinuity` | `annotation: true`; `label`: `crossing` or `possible-teleport`; `meters`: the straight-line step; `atMonotonicNs`; after merging also `count` and `lastAtMonotonicNs` |
| `refuel` (annotation, PR-2) | `discontinuity` | `annotation: true`; `addedLiters`: the episode's litres in this annotation; `atMonotonicNs`: its first step; `lastAtMonotonicNs` once it grows while waiting, wherever it is in the queue. An episode that continues after its annotation was sent gets a new one with `continues: true`. Never merged with another episode |

## Attribution (T14)

Each gameplay event (`job.delivered`, `job.cancelled`, `player.fined`, `player.tollgate.paid`, `player.use.ferry`, `player.use.train`) gets exactly one `event.attribute` in its own commit. Other events get none.

| Attribution | When |
| --- | --- |
| `trip` | An active trip's window, including an outcome that attaches after the clear |
| `trip-before-loaded` | An active `cargo_market` job whose `cargoLoaded` is available and false (O3) |
| `free-driving` | No open trip and no untracked job, or a fine, toll or transfer after the clear: outside any active job (concept.md, October 13, 2026) |
| `ambiguous` | A gameplay event that resolves a reload check; a fine, toll or transfer while a job is untracked; the outcome of an untracked job or with no attachable trip; an outcome before the first start of a replaced or loaded configuration |

Money is summed per trip as exact BigInt digits per currency and SDK type. Fines before loading are kept apart from other fines. Free-driving and ambiguous events change no trip totals.

**Residual risk.** The outcome guard covers only a job configured outside a running simulation, whose load window lasts until the next start. If job B is configured while running and job A's late outcome then arrives, the outcome attaches to B and closes it. No real trace shows a job configured while running (O2: accepts arrive while paused), so this stays a pending real-game check.

## Identity

- **Trip UUID (T4).** The first 128 bits of SHA-256(`ets2telemetry-trip-v1:` + pluginSessionId + `:` + eventSeq of the configuring job event), written as 8-4-4-4-12 lowercase hex like the simulator's seeded ids, without RFC 4122 version bits. A replay or redelivery therefore yields the same UUID. telemetry-core has its own SHA-256, checked against NIST vectors and `node:crypto`.
- **Job key (T6).** The canonical tuple of every `job.configured` field except `cargoLoaded`, with availability, reason, unit and money currency. A cargo-market pickup re-send is therefore the same job (O3).
- **Truck and trailer.** A re-send with identical values changes nothing; different values update the reference.

## Time and money (T15)

- **UTC label.** `occurred.utcUnixMs`, else the session's last label, else `receivedUtcMs`. A gap carries no UTC, so a gap close uses the session's last label. A restart close uses the old session's last observed label, a lower bound.
- **Clamp.** Storage requires `ended_utc_ms >= started_utc_ms`, and a violation would fail the commit and stop durable delivery. An end before the start is therefore clamped to the start and annotated `utc-label-jump`.
- **Real duration.** Real time comes from `occurred.monotonicNs` within one session's source clock (`realDurationNs` in the view). Trips never span plugin sessions.
- **Game time.** Game-time spans stay within one game clock. Sleeps and crossings are included and annotated, never subtracted.
- **Money and distance.** Planned distance and expected income come from the job; revenue, delivered distance and the cancellation penalty from the outcome event. They are never converted, netted or mixed. Observed distance comes from readings ([below](#readings-accounting-t16-t17)).

## What "complete" means (T13)

A trip opens `unknown` and stays `unknown` while nothing is known to be missing. It becomes `partial` on:

- an event loss or not-connected interval;
- a reconnection or consumer restart;
- a save load;
- an ambiguous or not-merged continuation;
- a late attach, or a configuration replayed from before the attach;
- an opening during a load;
- a close without an outcome;
- a reading hole.

It is `complete` only when its gameplay outcome closes it after a clean window. Annotations (`truck-change`, `utc-label-jump`, and the readings annotations `odometer-regressed`, `odometer-jump`, `game-time-jump`, `position-jump` and `refuel`) are `discontinuity` intervals with `detail.annotation: true` and never downgrade.

A delivered trip can be partial. Completion status and recording completeness stay separate (concept.md §7).

## Readings accounting (T16, T17)

[`accounting.ts`](../packages/telemetry-core/src/trips/accounting.ts) classifies each step between two consecutive readings of one connection with the [step primitives](live-telemetry-fields.md) `odometerStep` and `fuelStep` of `derived.ts`, then the reducer applies the result to the open trip of the reading's game. The trip keeps only plain data: the totals and where the session's last reading was taken. The last reading itself is kept per session as a JSON-safe point.

**Which steps count.** A step belongs to the open trip only when its earlier reading was taken while the trip was open. It counts towards distance and fuel, and can be annotated, only when the trip was active at both readings. A step across the trip's opening, its `job.cleared` or a connection hole therefore never counts, even when the trip is active again before the next reading. A step across a source, truck or game-clock boundary (a plugin session, a capture clock, a truck change, a timer restart or a save load) counts nothing and is not annotated: the events that caused it are recorded already.

| Quantity | Rule |
| --- | --- |
| Observed distance | The sum of `continuous` odometer steps in metres; a road stop adds 0 m and makes the distance available. A regression or a jump beyond `MAX_PLAUSIBLE_SPEED_MPS` × elapsed + the float32-aware margin is excluded and annotated `odometer-regressed` or `odometer-jump` with its `deltaM` |
| Fuel used | The summed `consumed` litres minus the summed `increaseLiters` of `unchanged` steps (increases of at most `FUEL_NOISE_LITERS`), over continuous fuel steps. Not observed before the first one. No storage column (S-1): it is in the view only |
| Refuels | A `refuelled` step is never consumption. Consecutive counted refuelled steps form one episode (a step that is not counted ends it); its `refuel` annotation's litres grow while it waits, and a continuation after it was sent is marked `continues`. The view reports refuelled litres and the number of episodes |
| Connection hole | `disconnected` drops the session's last reading, so the first step of the next connection starts fresh. The reconnection's `not-connected` interval records `odometerDeltaM` from the first reading of the new connection, null without an odometer or a known truck at either end, or after a truck change; that change is never added to the trip |

**Persistence.** Observed distance is persisted with `trip.update observedDistanceM` on each commit carrier when it changed since the last update, and right before every close (outcome, gap, discontinuity, different job, configuration cleared and restart), so a close never leaves a change unsent. A distance that was never observed is not written: storage keeps `not-observed`.

**Provisional thresholds (T17).** They are named constants in `accounting.ts` and stay provisional until real sessions confirm them ([ET-014 validation](validation/et-014.md)):

| Constant | Value | Rule |
| --- | --- | --- |
| `GAME_TIME_JUMP_MINUTES`, `GAME_TIME_JUMP_RATE`, `GAME_TIME_WINDOW_SECONDS`, `GAME_TIME_GROWTH_SECONDS` | 30 game minutes; 60 game minutes per real minute; 60 s; 1 s | A forward advance on one game clock of at least 30 minutes at more than 60 minutes per real minute is a `game-time-jump` (normal driving runs at about 19, a ferry at about 90). It is measured from the previous reading, however long ago, and from each reading of the last 60 s (kept at most one per second), so a ferry spread over many readings is found as well as a single-step sleep. The jump starts at the latest such reading. While the window still shows it, it grows only by an advance faster than 60 per real minute since its last growth, measured over at least 1 s of real time, so normal driving after a sleep does not extend it: an ordinary minute tick right after the jump is never that fast over a whole second |
| `CROSSING_WINDOW_SECONDS` | 300 s | A jump is labelled `crossing` when a ferry or train event's source time lies at most 300 s before the jump's start or between its start and the current reading, so a snapshot between the event and the jump does not matter; else `possible-sleep`, an inference. A transfer that arrives after the jump does not relabel it |
| `MAX_PLAUSIBLE_SPEED_MPS`, `POSITION_JUMP_MARGIN_METERS` | 100 m/s; 50 m | A straight-line position step longer than 100 m/s × elapsed + 50 m is a `position-jump`, labelled `crossing` or `possible-teleport` the same way |
| `READING_HOLE_SECONDS` | 5 s | At least 5 s of running simulation between two readings of one connection is a reading hole: the trip becomes partial with a `sample-loss` interval. Running time starts from the earlier reading's state and switches at each live event's `occurred.simulation`, at its source time, so driving and then a pause is a hole while a paused stretch is not. A hole that starts where the waiting one ended extends it; at most four holes of one trip, connection and capture clock wait, and a fifth extends the last one. A hole never extends a waiting hole of an earlier connection. Coalesced snapshots never create an interval, because only running time between readings counts, never skipped message `seq` values |

Readings without an open trip of their session change no trip and add no effect: no annotation is session-level.

## Effect bounds (T18)

A commit carries at most 16 effects, in this order:

1. queued lifecycle effects (restart closes and not-connected updates decided at a session input, reading-hole downgrades decided at a reading, and the observed-distance update before a restart close);
2. the carrier's own effects, ending with the open trip's observed-distance update when it changed;
3. at most 8 annotations, including those decided at readings.

The carrier's own effects always fit (at most six: an observed-distance update and a close, then an open with three cause intervals) because they may reference `this-event`. Queued effects never reference `this-event`, so they wait in order for the game's next commit. Consecutive queued annotations of the same trip, cause and label merge into one with `count` and `lastAtEventSeq` (`lastAtMonotonicNs` for a reading annotation). A refuel or a game-time jump never merges, because each episode keeps its own litres or range and may still grow in place; this only lengthens the waiting queue, and the cap of 8 annotations per carrier still holds.

A queued interval of an earlier session loses its monotonic bounds when a new session of the game starts. Storage scopes source clocks to the committing session (T11).

## Evidence basis (T20)

| Rule | Basis |
| --- | --- |
| Job accepted while paused with truck/trailer re-send; start follows | O2 (6 jobs, 1 exception) |
| Pickup re-send changes only `cargoLoaded`; trip-before-loaded fines | O3 (run 8) |
| Pause before delivery; delivery while paused; delivery before the clear | O5, O6 (4 deliveries) |
| Cancellation: clear, truck/trailer re-send, then `job.cancelled` | O7 (2 samples) |
| Fines and tolls inside and outside job windows | O8 |
| Save load: clear, identical re-send, start, regression; continue the same trip | O9, O10 (1 sample) |
| Ferry attributed to the trip | O11 (1 sample) |
| A job in the start burst opens partial and survives the burst's timer restart | Inference from O1 |
| Outcome after the clear attaches when nothing lies between | concept.md, October 13, 2026 (not observed; O6 does not exclude it) |
| Game mode change marks the trip ambiguous | concept.md, October 13, 2026 |
| Save load of a different job or no job; load window absorbing the regression | concept.md, October 14, 2026, and synthetic inference |
| A save from before a cargo-market pickup is not continued (`cargoLoaded` differs) | concept.md, October 14, 2026, with O3 and O10; the sequence itself is synthetic |
| Fines while a job is untracked are ambiguous | concept.md, October 13, 2026 |
| Train crossing, profile switch, quick-job replacement, mid-trip timer restart, late attach after a job started, plugin restart, reconnection, UTC set back | Synthetic inference |
| A sleep appears only as a forward game-time jump on the same clock | CAP-01 run 2 (concept.md, "Sleep and unannounced game-time jumps"); the T17 thresholds are inference |
| Odometer, fuel and refuels through readings; road-service teleport; reading holes; position jumps; crossings labelled from a transfer between readings | Synthetic inference (PR-2); no real trace of readings was reviewed for these rules |

## PR-1 interpretations of the plan

The plan's transitions table leaves these cases open. They are listed here for review:

- **Load window.** It extends T12 to every trip opened outside a running simulation: a regression right after the first start, or a timer restart before it, belongs to the load that restored the job. Without it, the O1 start burst and a save load of a different job would close the trip they just loaded.
- **Regression and load state.** A regression never starts a session load (fix round 1). Otherwise the job accepted after a save load would open with a false `opened-at-load` cause.
- **Reload check, `job.cleared`.** It returns to awaiting-outcome; it is treated as part of the load burst.
- **Reload check, different job.** It opens the new trip from the different configuration, not from the superseded re-send.
- **Reload check, `timers.restart`.** It resolves as "other decisive event", but the new trip keeps a load window instead of closing again at once.
- **Reload check, outcome.** It closes the old trip and opens none (fix round 1).
- **Re-send with a different `cargoLoaded` after a clear.** It is a not-merged continuation, never a reload check (fix round 1).
- **Outcome guard.** It applies after any replacement or load, not only after a clear.
- **Untracked jobs.** Fines, tolls and transfers while a job is untracked are `ambiguous`, not `free-driving` (fix round 1, replacing the PR-1 reading of T14).
- **Replayed events.** A checkpoint job applies only from the checkpoint's `nextEventSeq` on, and a replayed configuration opens a partial trip with `opened-before-attach` rather than `late-attach` (fix round 2).

## PR-2 interpretations of the plan

T16 and T17 leave these cases open. They are listed here for review:

- **Active at both readings.** A step counts only when the trip was active at both of its readings, and `job.cleared` ends the run of active readings. The distance between the last reading and the opening, a clear or a disconnection is therefore not counted; at 20 Hz snapshots that is at most one 50 ms step.
- **Reading holes.** A hole downgrades any open trip whose window contains both readings, whatever its phase, while distance and fuel count only while active. Fix round 1 replaced "running at both readings" with running time split by the stream's simulation states. The odometer step across a hole is still counted when it is continuous: the odometer is cumulative, so the distance is observed, not fabricated; only the samples are missing.
- **Annotations need a trip.** A jump, refuel or odometer discontinuity with no open trip, or while the trip is not active, adds no effect; no annotation is session-level.
- **Game-time jumps (fix round 1).** A per-step rule missed a ferry spread over many readings (CAP-01 run 8: about 90 game minutes per real minute, 0–2 minutes per reading). The 60 s window finds it; the annotation grows instead of repeating.
- **Position jumps.** They reuse the crossing label of T17 and add `possible-teleport` as the inference otherwise. The margin is the separate `POSITION_JUMP_MARGIN_METERS` (50 m).
- **Refuel episodes.** Consecutive refuelled steps are one annotation with growing litres, and different episodes never merge, so the litres are never lost to merging. Fuel used is not clamped at zero: small increases larger than the consumption would make it negative and stay visible.
- **"Always before a close".** The close carries an observed-distance update whenever the value changed since the last one, so no close leaves a change unsent; an unchanged value is not written again.
- **`odometerDeltaM`.** Only the reconnection's `disconnected` interval records it, always: null when queued, then from the first reading of the new connection while the interval still waits; gaps close the trip and carry none. It is null without an odometer or a known truck at either end, or after a truck change (brand, model or plate): no change between possibly different trucks is recorded (advisory review on PR #72).
- **Crossings by time (fix round 1).** The crossing label follows the transfer's source time, not its place in the stream, so a replayed transfer counts by when it happened. concept.md asks for a jump "next to such an event"; 300 s is the provisional meaning of "next to". A transfer after the jump does not relabel it.
- **Resumed cleared trips (fix round 1).** `TripSeed.awaitingOutcome` resumes a cleared trip awaiting its outcome; without the flag a resumed trip is active, as before.
- **Separate episodes (fix round 3).** Game-time jumps no longer merge: a later same-label sleep folded into a waiting one, and its growth then rewrote the earlier range. Waiting holes count towards the per-connection cap only on the current capture clock. A refuel episode continues only over counted steps, so a refuel after a disconnection, an opening or a clear starts a new episode.
- **Jump growth and queue position (fix round 2).** Growth is judged over at least 1 s, because at 20 Hz one ordinary minute tick within half a second looked faster than the rate and repeated or extended a sleep. A continuation starts at the end of the sent annotation. A growing jump or refuel is found anywhere in the waiting annotations, because a position jump queued in the same step would otherwise hide it.
- **Holes per connection (fix round 2).** Only holes of the current connection (from its first reading) are counted or extended, so a `sample-loss` interval never spans a `not-connected` one.
- **Holes merged (fix round 1).** Contiguous holes extend one interval; beyond four waiting holes per trip the last one is extended over the readings between, marked `includesReadings`. A UTC label that is not a non-negative safe integer is absent, as for events.
- **Readings of another session.** A reading of a session that is not the current connection's is refused with `UNKNOWN_SESSION`, like an item; PR-1 ignored every reading.
