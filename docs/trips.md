# Trip lifecycle and completeness

ET-014 adds a pure, deterministic trip reducer in [packages/telemetry-core/src/trips](../packages/telemetry-core/src/trips). It turns committed protocol v1 events and gaps, session changes, checkpoint hydration and disconnections into the storage `TripEffect` lists that [storage](storage.md#storage-api) applies in the same transaction as the event or gap. The coordinator adopted decisions T1–T20 under the owner's standing delegation of October 15, 2026 ([concept.md](../concept.md#et-014-authorization--october-15-2026)).

Status (October 15, 2026):

- **PR-1**: the event-driven lifecycle, identity, attribution and completeness. It covers T1–T15 and T18–T20 as they apply to events.
- **PR-2**: [readings accounting](#readings-accounting-t16-t17) (T16, T17): observed distance, fuel used, refuels, game-time jumps, crossings, position jumps and reading holes, plus replay of the ET-005b simulator scenarios against hand-written trip expectations.
- Nothing records yet. No storage schema, wire, preload/IPC, renderer or native code changes. ET-015a wires the reducer into commits.
- **ET-015a PR-2 (October 16, 2026)**: the [caller contract](#caller-contract-for-et-015a) below is implemented by `TripRecorderSink` ([telemetry service v1](telemetry-service-v1.md#trip-recorder-et-015a)) and proven against the real storage worker, killed processes and injected storage failures with synthetic sources only. The running service still passes no sink, so production records nothing yet.
- **ET-015b PR-2 (October 16, 2026)**: the pure [one-second sampler](#one-second-sampler-et-015b) chooses which readings become history samples and builds their storage rows. Nothing calls it yet; ET-015b PR-3 runs it in the trip recorder.
- **ET-016 PR-6 (October 16, 2026)**: fuel used is persisted like observed distance (J8, storage gap S-1 resolved): on carriers when it changed, before every close, and resumed from cold-start seeds. A negative total is stored as `invalid` ([Persistence](#readings-accounting-t16-t17)).
- **ET-016 PR-7 (October 17, 2026)**: [late-attach trips](#late-attach-trips-j9) (J9, storage gap S-2 resolved). A job seen in a checkpoint while the game's slot is idle opens a partial trip from the checkpoint once the replayed events have drained, stored by `openAttachedTrip`. This supersedes T9's rule that such a job stays untracked until an identical `job.configured` arrives.
- Behaviour seen in real traces rests only on the reviewed CAP-01 observations O1–O11 ([CAP-01a validation](validation/cap-01a.md)). Everything else is synthetic inference and stays pending until real-game sessions ([ET-014 validation](validation/et-014.md)).

## Interface

All values are plain data: uint64 values stay decimal strings, and the state survives structured cloning and JSON. The reducer never mutates its inputs. It imports the storage effect types as types only from `packages/storage/src/api.ts` (T2); the [boundary test](../tests/unit/telemetry-core-boundaries.test.ts) allows exactly that import.

| Export | Purpose |
| --- | --- |
| `initialTripState()` | No connection, no session, every game idle |
| `stepTrip(state, input)` | `{ok: true, state, effects}` or `{ok: false, code}` with `ORDER_VIOLATION`, `COVERAGE_MISMATCH` or `UNKNOWN_SESSION` |
| `tripView(state, game)` | Phase, untracked job, the open trip and the last closed trip of one game |
| `tripUuidFor(pluginSessionId, jobEventSeq)`, `jobKey(job)` | Trip identity (T4) and job identity (T6) |
| `attachTripUuidFor(pluginSessionId, nextEventSeq)`, `dueAttach(state)` | The UUID of a [late-attach trip](#late-attach-trips-j9), and the late-attach trip the caller must open now (`{pluginSessionId, nextEventSeq, job}` or null) (J9) |
| `MAX_EFFECTS` (16), `MAX_ANNOTATIONS_PER_COMMIT` (8) | Per-commit bounds (T18); a test checks that `MAX_EFFECTS` equals storage's |
| `initialSamplerState()`, `sampleReading(state, {message, receivedUtcMs, view})` | The [one-second sampler](#one-second-sampler-et-015b) (ET-015b): `{state, decision, row}`, where `row` is a storage `SampleInput` or null |

Inputs (`TripInput`):

| Kind | Carries | Effects |
| --- | --- | --- |
| `session` | The validated welcome, the coverage `upsertSession` returned, and `openTrips` (`TripSeed[]`) on a cold start | None; decided effects wait in the game's queue |
| `checkpoint` | The connection's checkpoint and, optionally, its receipt label `receivedUtcMs` | None (hydration). While the game's slot is idle, its job becomes the connection's pending late-attach trip (J9) |
| `attach` | `receivedUtcMs`, the last fallback of the start label | The effects of the due [late-attach trip](#late-attach-trips-j9), for the storage command `openAttachedTrip`, never for an event or gap commit |
| `event`, `gap` | The message, `coveredThrough` read right before the commit, and `receivedUtcMs` | The effects for that message's commit |
| `reading` | A normalized state of the current connection (the checkpoint's and each snapshot's), with its source identity, capture time and UTC label | None; distance and fuel accumulate, and annotations or a reading-hole downgrade wait for the game's next carrier |
| `disconnected` | — | None |

## Caller contract for ET-015a

ET-015a PR-2 implements this contract in [trip-recorder.ts](../apps/desktop/src/trip-recorder.ts), as a durable sink at the head of the ingestion's one FIFO ([telemetry service v1](telemetry-service-v1.md#trip-recorder-et-015a)). How each rule maps to it:

- adoption after the commit, and a kept state after a failed commit, in `commit`;
- the disconnection is stepped lazily: when the next welcome's session opens and the reducer still has a connection, `disconnected` is stepped before `session` (R6). The interval comes from the session's last item and reading, so the time of the step does not matter;
- readings arrive in stream order with the items through the same FIFO (R5);
- the receipt label is captured when the frame is decoded (R8);
- seeds are read at the first durable welcome per game (R15, below);
- an `ok: false` result becomes an `unavailable` sink code (`TRIP_ORDER_VIOLATION`, `TRIP_COVERAGE_MISMATCH`, `TRIP_UNKNOWN_SESSION`; R7);
- a due late-attach trip (ET-016 PR-7) is opened by DurableDelivery's `attach` op at the head of the FIFO, right after the reading or commit that made it due, in `openAttach`: step `attach`, store the effects with `openAttachedTrip`, adopt on `committed` or `duplicate`.

**Adopt after commit (T3).** For each event or gap, the caller:

1. reads `committedThrough()` right before the commit, as the storage caller rule requires;
2. steps the reducer;
3. commits the message with the returned effects;
4. adopts the returned state only when storage reports `committed`, `duplicate`, `covered` or `conflict`.

On a retryable or failed commit the caller keeps the old state. When the item is redelivered, it is stepped from that kept state, so no effect of an earlier commit is lost or repeated. Effects queued by the reconnection, such as its `not-connected` interval, or a replayed configuration's `opened-before-attach` cause, may be added to it. Non-carrier inputs (session, checkpoint, disconnected) are adopted immediately. An `ok: false` result fails closed: durable delivery must stop, as for any other contract violation.

**Late attach (J9).** After stepping a checkpoint or adopting a commit, the caller asks `dueAttach(state)`. When it returns a request, the caller steps `{kind: 'attach', receivedUtcMs}` before any other item of the connection, stores the effects with `openAttachedTrip({...request, effects})` and adopts the state only on `committed` or `duplicate` (T3). On a failure the state is kept; the connection fails like a failed commit, and the next connection's checkpoint decides again. An event or gap stepped while an attach is due is `ORDER_VIOLATION`, and so is an `attach` with none due.

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
- `jobKey` is `jobKey()` of the trip's stored job configuration: its `job.configured` record, or for a late-attach trip the stored checkpoint job (`TripRecord.checkpointJob`, ET-016 PR-7). With null, no later job ever matches it;
- `lastObservedUtcMs` is the label of the session's last stored item that has a usable label; for a late-attach trip, of the last such item at or after the checkpoint's `nextEventSeq`, else the trip's start label, which the attach made the session's last label (PR-7 review round 1);
- `observedDistanceM` (PR-2) is the trip's stored observed distance when it is available; a resumed trip accumulates from it, so its next update never replaces the stored value with a smaller one;
- `fuelUsedL` (ET-016 PR-6, J8) is the trip's stored fuel used when it is available; a resumed trip accumulates fuel used from it in the same way. A stored `invalid` or `not-observed` value is not passed, so the resumed trip counts fuel used from its next continuous fuel step. After a stored `invalid` (a negative total), the next stored value can therefore overstate the trip by at most that dropped negative total, which is bounded by the summed noise increases; the trip is already partial (`consumer-restart`);
- `awaitingOutcome` (PR-2 fix round 1) is true when the trip's job was cleared before the stop: the session's last stored `job.configured` or `job.cleared` event after the trip's opening event (`openedEventSeq`, which can follow the job configuration, for example for a reload trip) is a `job.cleared`. The trip then resumes awaiting its outcome, so free driving after the clear adds no distance, and a later outcome still attaches;
- a seed of another plugin session closes as `restart` at the new session's first commit (T11);
- a seed of the same session resumes as an active trip (awaiting its outcome with `awaitingOutcome`) and becomes partial with a `not-connected` interval (`consumer-restart`): the consumer was not running for part of it. Its reload-check phase, load window and money totals are not rebuilt. Its `cargoLoaded` is unknown too, so after a clear its identical re-send never matches: an O10 save load then closes the resumed trip and opens a not-merged continuation, which is the conservative result.

**Seed rules (ET-015a, R4).** The recorder builds the seeds with `readTripSeeds` ([trip-seeds.ts](../apps/desktop/src/trip-seeds.ts)) from stored rows only, by fixed rules that mirror `TripStorageModel.seeds()` of the trip replay; the reducer is not run over stored items:

- the open trips of the welcome's game come from `listTrips({game, outcome: 'open'})`, page by page;
- `jobKey` is `jobKey()` of the stored `job.configured` record at the trip's job configuration eventSeq, or null when that row is missing or of another type; for a trip opened from a checkpoint it is `jobKey()` of `TripRecord.checkpointJob.values`, and no event is read for it (ET-016 PR-7);
- `lastObservedUtcMs` is the label of the session's stored event with the highest eventSeq that has a usable label (`occurred.utcUnixMs`, available and a safe integer); for a trip opened from a checkpoint, only an event at or after its `nextEventSeq` counts, and without one it is the trip's start label (PR-7 review round 1). A label from before the checkpoint would otherwise end a later restart or gap close before the trip's start, clamped with a false `utc-label-jump`;
- `observedDistanceM` is the stored value when it is available;
- `fuelUsedL` is the stored value when it is available (ET-016 PR-6);
- `awaitingOutcome` is true when the session's last `job.configured` or `job.cleared` event after the trip's opening event is a `job.cleared`. A trip opened from a checkpoint has no opening event; its opening point is the checkpoint's `nextEventSeq` − 1, so only events at or after `nextEventSeq` count, and the session scan starts there.

The seeds are read only when the reducer has no session of the welcome's game, that is at the first durable welcome per game in the recorder's lifetime (R15). Later welcomes rely on the reducer's own memory, which never closes a trip twice.

**Truck and trailer references after a restart.** Seeds carry trips, not the session's current configuration. After a service restart, the reducer starts the session at the stored coverage and does not know the truck and trailer references of events committed before it. A trip opened later in that session therefore gets no truck or trailer reference until a `truck.configured` or `trailer.configured` is committed again. A redelivered duplicate does not count, because the reducer skips an eventSeq at or below its processed point. Example: in `tests/fixtures/recording/normal-delivery-backlog.rows.expected.json`, the truck (eventSeq 1) was committed by the first service, so the restarted service opens trip@3 with `truckConfigurationEventSeq: null` but with trailer 2, which it committed itself.

**Storage gaps (T19).** No storage change is part of ET-014. Their dispositions, decided in ET-015a (R11):

| # | Gap | Disposition |
| --- | --- | --- |
| S-1 | No fuel-used column on trips; PR-2 reports fuel used, refuelled litres and refuel episodes in the view only. `trip.close` has no detail, so the close carries none of them | Moved to ET-016, in one schema v2 migration with S-2 and the journal indexes. **Resolved in ET-016 PR-6** (J8): schema version 2 has `trips.fuel_used_l`, and the reducer persists fuel used with `trip.update fuelUsedL` like observed distance (see [Persistence](#readings-accounting-t16-t17)). Refuelled litres and episodes stay `refuel` annotations |
| S-2 | A late-attached job cannot open a trip from the checkpoint: storage opens trips only at a job configuration event, and hydration stores no configuration rows. The job stays untracked until an identical `job.configured` arrives | Moved to ET-016 (schema v2 and concept §7 wording). It changes T9, a product behaviour: a job accepted before the app starts is never recorded as a trip. **Resolved in ET-016 PR-7** (J9): schema version 2 stores checkpoint job configurations and checkpoint-opened trips, and `openAttachedTrip` opens a [late-attach trip](#late-attach-trips-j9). This restores concept §3 and REG-003: a job accepted before the application attached is recorded as a partial trip |
| S-3 | The synchronous `EffectsHook` of the durable sink got no commit result, so it could not follow T3 | **Resolved in ET-015a PR-2**: the hook is removed, and `TripRecorderSink` steps, commits and then adopts |
| S-4 | Continuations have no column; they live in completeness `detail` JSON (`continuationOf`) | Kept as is |

**Trip view consumers (R17, H7).** The recorder's `view(game)` returns `tripView` of its adopted state. A trip appears in it only after the event that opened it is committed, and an event or gap changes it only once committed; session and reading steps are adopted at once. A consumer that binds data to a trip, such as a one-second sample, uses `view.current.tripUuid` only while `view.phase` is `active` and `view.untrackedJob` is false. In every other case the reference is null:

- the game is idle;
- the trip is awaiting its outcome after `job.cleared`;
- the trip is in a reload check;
- a job is untracked: the job of a trip a gap closed (free driving or ambiguous), or a checkpoint job seen while idle until its late-attach trip opens;
- the view is of another game than the reading (a defensive check in the sampler).

A reading reaches the recorder in FIFO order after the items before it, so a sample taken when the reading arrives sees the trip state left by the commits before it, never by a commit still waiting.

**Rebuild instead of seeds (answered in ET-015a, R4).** The alternative was to rebuild the state by replaying the session's stored items through the reducer from coverage 0. It is rejected: the storage read API lists events but not gaps, readings are not stored (so distance and reading holes could not be rebuilt), and it would cost a whole session's events at every start while still losing the readings-based state. Seeds are read instead; what a seeded trip loses is listed above.

## States and transitions

Each game has one slot with at most one open trip. Without an open trip the slot is **idle**. An open trip is in one of three phases:

- **active**;
- **awaiting-outcome**, after `job.cleared`;
- **reload-check**, after an identical re-send following a clear.

A newly opened trip also has a **load window**. If its job was configured outside a running simulation, the window lasts until the next `simulation.started` and for the one event right after it. A `timers.restart` or `gameTime.regression` inside the window is the load that restored this job (O1, O10), so it does not close the trip.

The session's **load state** is `loading` from a fresh session until its first `simulation.started`, and again after `timers.restart` until the next start (O1). A `gameTime.regression` never starts a load: it follows the start of the load it ends (O10), so it leaves the state unchanged, or sets `running` when it occurred while running. The state is `unknown` after a gap or when the reducer joins a session that already has committed events.

A job is **untracked** when it is known or likely active but no trip tracks it: the job of a trip that a gap closed before its clear or outcome, or a checkpoint job seen while idle until its [late-attach trip](#late-attach-trips-j9) opens (J9; T9 kept it untracked until an identical `job.configured`). It stays untracked until `job.cleared`, an outcome or a new trip. A later checkpoint while idle replaces it, or clears it when that checkpoint shows no job. A new plugin session starts with none.

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
| any | checkpoint | unchanged | none; the session keeps the checkpoint's `nextEventSeq`, and an idle slot records the checkpoint job as untracked from that point on and as the connection's pending late-attach trip (J9) |
| idle, a late-attach trip due (replayed events drained) | `attach` | active (new) | through `openAttachedTrip`: the slot's queued lifecycle effects, then `trip.open` from the checkpoint job with a `late-attach` cause and a continuation cause (J9) |
| open, when the replayed events drain | — | unchanged | the pending late-attach trip is dropped: the open trip (for example from an identical replayed configuration) tracks the game |

**Plugin exit (ET-015c, G16).** A plugin exit writes no interval of its own; T11 is the rule that keeps its uncertainty: the next plugin session of the game closes the open trip as `restart`, partial, at its first commit (`tests/storage/recording-status.test.ts` (g)).

Cause intervals on `trip.open` make the new trip partial:

- `opened-at-load` (`discontinuity`): the session is loading (T12);
- `late-attach` (`not-connected`): the trip opened from a checkpoint job (J9, `source: 'checkpoint'`); or, at an event, an identical job was untracked since a checkpoint and this configuration is not replayed (T9; since J9 only when the late-attach trip could not open because a trip was open when the replayed events drained);
- `opened-before-attach` (`not-connected`): the configuration is replayed from before the connection's checkpoint;
- `{cause, continuationOf, decision: 'not-merged'}` (`discontinuity`): the last trip of this game closed without an outcome and had the same job key. Its close reason is the cause: `restart` (T11), `gap`, `discontinuity` or `configuration-cleared`. A candidate that crosses a plugin restart is `restart`, and an outcome clears it. Identical jobs are never merged.

### Interval detail keys

Every `completeness.add` of the reducer carries a `detail` object (storage keeps it as JSON). Event sequence numbers in it are uint64 decimal strings.

| `detail.cause` | Interval kind | Other keys |
| --- | --- | --- |
| `opened-at-load` | `discontinuity` | `atEventSeq`: the event that opened the trip, or the timer restart inside its load window |
| `late-attach` | `not-connected` | `atEventSeq`: the opening event. A trip opened from a checkpoint (J9) has instead `source: 'checkpoint'` and `nextEventSeq`: the checkpoint's `nextEventSeq` |
| `opened-before-attach` | `not-connected` | `atEventSeq`: the replayed opening event |
| `restart`, `gap`, `discontinuity`, `configuration-cleared` | `discontinuity` | `continuationOf`: the earlier trip's UUID; `decision`: `not-merged`; `atEventSeq`: the opening event, or for a trip opened from a checkpoint `source: 'checkpoint'` and `nextEventSeq` |
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

## Late-attach trips (J9)

ET-016 PR-7 implements J9 ([concept.md](../concept.md#et-016-authorization--october-16-2026)), which supersedes T9: a job accepted before the recorder attached is recorded as a partial trip, as concept §3 and REG-003 require, instead of staying untracked until an identical `job.configured` arrives.

- **When.** A checkpoint while the game's slot is idle and its job is available sets the connection's pending late-attach trip. It is due once the session's processed point reaches the checkpoint's `nextEventSeq` − 1, so the retained events replayed after the checkpoint are stepped first. If a trip is open at that point (an identical replayed `job.configured` opened it with `opened-before-attach`, or a different replayed job), no late-attach trip opens. A disconnection, a new checkpoint or a new plugin session drops a pending one. A live item stepped before it opened (possible only while it waits behind queued lifecycle effects, below) drops it too when it contradicts the checkpoint's job: a live `job.cleared`, `job.delivered` or `job.cancelled`, or a gap over eventSeqs at or after `nextEventSeq`, which may hide such an event; any other live item leaves the job as the checkpoint showed it (PR-7 review round 1). A disconnection keeps the checkpoint's untracked job, which is still likely active; the next checkpoint replaces or clears it.
- **What.** The trip opens from the checkpoint's job, partial, with a `not-connected` interval `{cause: 'late-attach', source: 'checkpoint', nextEventSeq}` and, when the game's last trip closed without an outcome and had the same job key, a not-merged continuation interval. It starts at the checkpoint state's capture UTC label (else the session's last label, else the receipt label), capture time and clock, with the checkpoint status's game mode. It has no truck or trailer reference until a `truck.configured` or `trailer.configured` is committed again (J22, [TD-007](technical-debt.md)); the first one is a reference, not a `truck-change`. Opened outside a running simulation, it keeps a load window like a trip opened at an event (T12). The attach is the session's latest labelled point, so a following gap closes the trip at its start label.
- **How it is stored.** The effects are the slot's queued lifecycle effects (such as the restart close of an earlier session's trip, so one trip of the game is open at a time) followed by the `trip.open` and its intervals. They go to `openAttachedTrip({pluginSessionId, nextEventSeq, job, effects})` ([storage](storage.md#late-attach-trips-et-016b-pr-7)), never to an event or gap commit: no coverage change and no ACK. The attach waits while the queued lifecycle effects would not fit beside its own three in one command (16 effects); the next commit drains them. Queued annotations wait for the next commit. A live fine, toll or transfer committed while the attach waits has no trip yet, so it is attributed `ambiguous` and changes no trip totals (T14), while the trip that then opens starts at the earlier checkpoint label and its journal window from `nextEventSeq` lists that event. Totals and the window therefore disagree for that event. This is accepted: it needs more than 13 queued lifecycle effects, for example many stale open trips closed at a restart, and attributing an event to a trip that did not exist when it was committed would contradict T14 (PR-7 advisory review).
- **Restart idempotence.** After a service restart the stored trip is a cold-start seed with its checkpoint job key, so the slot is not idle and no late attach is due; an identical re-send is the same job. Should a recorder attach again at the same checkpoint anyway (an answer lost), storage answers `duplicate`, and the recorder adopts the trip: never a second trip.
- **Untracked jobs.** With J9 a job is untracked when a gap closed its trip before its clear or outcome, or when it started before recording and its late-attach trip has not opened (or a live gap prevented it). The recording status carries only a flag, so the dashboard and tray text names both causes ([application lifecycle](app-lifecycle.md)).

PR-7 interpretations, listed for review: the trip starts at the checkpoint's own label, clock and game mode rather than the session's, because it opens at the checkpoint; it gets no `opened-at-load` cause (J9 lists only the late-attach and continuation causes) but keeps the load window; and queued lifecycle effects travel with the attach so that a restart close never leaves two open trips of one game. The evidence basis is synthetic inference: real late-attach checkpoints remain pending.

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
- **Late-attach trip UUID (J9).** The same shape over SHA-256(`ets2telemetry-trip-attach-v1:` + pluginSessionId + `:` + the checkpoint's `nextEventSeq`). Its own prefix keeps it apart from every event-opened trip, and storage keeps at most one checkpoint job per session and `nextEventSeq`, so the same attach is a storage `duplicate`, never a second trip.
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
| Fuel used | The summed `consumed` litres minus the summed `increaseLiters` of `unchanged` steps (increases of at most `FUEL_NOISE_LITERS`), over continuous fuel steps, plus the stored value of a resumed trip. Not observed before the first one unless a value was stored. Persisted in `trips.fuel_used_l` (S-1, ET-016 PR-6) |
| Refuels | A `refuelled` step is never consumption. Consecutive counted refuelled steps form one episode (a step that is not counted ends it); its `refuel` annotation's litres grow while it waits, and a continuation after it was sent is marked `continues`. The view reports refuelled litres and the number of episodes |
| Connection hole | `disconnected` drops the session's last reading, so the first step of the next connection starts fresh. The reconnection's `not-connected` interval records `odometerDeltaM` from the first reading of the new connection, null without an odometer or a known truck at either end, or after a truck change; that change is never added to the trip |

**Persistence.** Observed distance is persisted with `trip.update observedDistanceM` on each commit carrier when it changed since the last update, and right before every close (outcome, gap, discontinuity, different job, configuration cleared and restart), so a close never leaves a change unsent. A distance that was never observed is not written: storage keeps `not-observed`.

Since ET-016 PR-6 (J8), fuel used follows the same rule with `trip.update fuelUsedL`. When both changed, one `trip.update` carries both, so a carrier never needs an extra effect. Fuel used that was never observed is not written, and zero is a value. Fuel used is not clamped (see the PR-2 interpretations below), but storage holds only a value of at least zero (`CHECK (fuel_used_l >= 0)`) and refuses anything else as `INVALID_INPUT`, which would fail the whole commit and stop durable delivery. A negative total is therefore persisted as `{available: false, reason: 'invalid'}`: the value is not representable, so it is marked invalid rather than clamped to zero or left stale. When later steps make the total non-negative again, the value replaces it, and the close always persists the final state. The trip view still shows the negative value. A resumed trip does not resume from a stored `invalid` value; it counts from its next continuous fuel step, like a trip whose fuel used was never observed. A refuel stays a `refuel` annotation and never changes fuel used.

**Provisional thresholds (T17).** They are named constants in `accounting.ts` and stay provisional until real sessions confirm them ([ET-014 validation](validation/et-014.md)):

| Constant | Value | Rule |
| --- | --- | --- |
| `GAME_TIME_JUMP_MINUTES`, `GAME_TIME_JUMP_RATE`, `GAME_TIME_WINDOW_SECONDS`, `GAME_TIME_GROWTH_SECONDS` | 30 game minutes; 60 game minutes per real minute; 60 s; 1 s | A forward advance on one game clock of at least 30 minutes at more than 60 minutes per real minute is a `game-time-jump` (normal driving runs at about 19, a ferry at about 90). It is measured from the previous reading, however long ago, and from each reading of the last 60 s (kept at most one per second), so a ferry spread over many readings is found as well as a single-step sleep. The jump starts at the latest such reading. While the window still shows it, it grows only by an advance faster than 60 per real minute since its last growth, measured over at least 1 s of real time, so normal driving after a sleep does not extend it: an ordinary minute tick right after the jump is never that fast over a whole second |
| `CROSSING_WINDOW_SECONDS` | 300 s | A jump is labelled `crossing` when a ferry or train event's source time lies at most 300 s before the jump's start or between its start and the current reading, so a snapshot between the event and the jump does not matter; else `possible-sleep`, an inference. A transfer that arrives after the jump does not relabel it |
| `MAX_PLAUSIBLE_SPEED_MPS`, `POSITION_JUMP_MARGIN_METERS` | 100 m/s; 50 m | A straight-line position step longer than 100 m/s × elapsed + 50 m is a `position-jump`, labelled `crossing` or `possible-teleport` the same way |
| `READING_HOLE_SECONDS` | 5 s | At least 5 s of running simulation between two readings of one connection is a reading hole: the trip becomes partial with a `sample-loss` interval. Running time starts from the earlier reading's state and switches at each live event's `occurred.simulation`, at its source time, so driving and then a pause is a hole while a paused stretch is not. A hole that starts where the waiting one ended extends it; at most four holes of one trip, connection and capture clock wait, and a fifth extends the last one. A hole never extends a waiting hole of an earlier connection. Coalesced snapshots never create an interval, because only running time between readings counts, never skipped message `seq` values |

Readings without an open trip of their session change no trip and add no effect: no annotation is session-level.

## One-second sampler (ET-015b)

[`history-samples.ts`](../packages/telemetry-core/src/history-samples.ts) decides which protocol v1 readings (a connection's checkpoint and each snapshot) become one-second history samples, and builds their `SampleInput` rows for storage's `appendSamples` ([storage](storage.md#storage-api)). It is pure and deterministic. It reads no clock and runs no timer, and it never mutates its inputs. It imports `SampleInput` as a type only from `packages/storage/src/api.ts`, as T2 allows. The coordinator adopted decisions H1–H17 ([concept.md](../concept.md#et-015b-authorization--october-16-2026)). PR-3 calls `sampleReading` from the trip recorder at the head of the DurableDelivery FIFO (H2), after the reading has stepped the reducer.

**Tick (H3).** The tick is the absolute source second `floor(capture.monotonicNs / 1e9)`, kept per plugin session and capture clock. The first qualifying reading in each second is sampled, and its `capture.monotonicNs` becomes the sample's time. Game time and UTC never set the cadence, so a sleep, a save load or a UTC change does not add or skip samples. A rule such as "at least 1 s since the last sample" would drift when readings jitter: at 20 Hz with ±10 ms jitter it gives about 3,500 rows per hour instead of 3,600.

**Freshness (H4).** The sampler remembers, per game, the plugin session and capture clock of the last reading, its `boundaryOrder` and the last sampled second. Each reading gets one decision:

| Decision | When | Effect |
| --- | --- | --- |
| `baseline` | The first reading of a plugin session in the sampler's lifetime, or the first reading of a new plugin session of the game | The session is remembered with no sampled second; no row. A restart checkpoint that carries an old slot therefore never becomes a row, but a fresh reading later in the same second can |
| `stale` | `boundaryOrder` is not strictly above the session's previous reading, across connections | Nothing changes, whatever the reading's age |
| `not-running` | Fresh, but `simulation` is `paused` or `unavailable` | The boundary advances; no row |
| `out-of-range` | Fresh and running, but the capture time is above 2^63−1 ns, which storage refuses | The boundary advances; no row |
| `same-second` | Fresh and running, but its second is not above the last sampled second on its clock | The boundary advances; no row |
| `sampled` | Fresh, running, a new second and in range | The second is remembered; `row` is the sample |

The sampler keeps only the current capture clock and its last sampled second. A capture clock change is not expected within a plugin session: [protocol v1](protocol/v1.md#5-envelopes-identity-sequences-and-time) §5 rejects one within a connection, and the plugin keeps one QPC clock per session. If one happens across connections, the new clock starts with no sampled second. The live display's 500 ms staleness rule is not used.

**Pauses and holes (H5).** Paused and unavailable readings produce no row. After a resume or a reconnection the next qualifying second is sampled, and missed seconds are never filled. The sampler adds no interval for source holes: the reducer already records `sample-loss` reading holes and `not-connected` intervals on trips (T17).

**Rows (H7, H13, H14).**

- **Units.** Values are copied in the wire's canonical units, unchanged: m/s, L, L/100 km (already ×100 on the wire), m, rpm and the gear index.
- **Availability.** Each availability object loses its wire `unit` key, because storage accepts exactly `{available, value}` or `{available, reason}`. Zero stays a value, and each unavailable reason is kept.
- **Position.** It comes from `worldPlacement.position` in game coordinates. Orientation is not stored (OD-6).
- **Game time.** `gameTime` is always present as `{minutes, clockId}`: the minutes as a number, or the unavailable reason, on the game time's own clock.
- **UTC.** `utcMs` is the reading's `captureUtcUnixMs` when it is available and a safe integer. Otherwise it is `receivedUtcMs`, the consumer's label taken when the frame was decoded (H13). The caller must pass a non-negative safe integer. UTC, game time and source time stay in separate columns.
- **Trip reference.** `tripUuid` follows the [trip view rule](#caller-contract-for-et-015a) (R17, H7): the open trip only while it is active, no job is untracked and the view is of the reading's game, otherwise null.

The sampler writes nothing. Storage enforces one row per session, clock and second as well (H6, ET-015b PR-1), but only when the caller passes `{uniqueSeconds: true}` to `appendSamples`: it skips a row whose second is at or below that of the session's latest stored row, when that row is on the same clock, or of an earlier row of the same batch on that clock. A row that returns to a clock after another clock's row is not compared with that clock's older rows ([storage](storage.md#storage-api)); the producer keeps one capture clock per plugin session. Batching, flushing and loss accounting (H8–H12) belong to the recorder pipeline (ET-015b PR-3). Real-game cadence, snapshot flow while paused and performance stay pending ([ET-015b validation](validation/et-015b.md)).

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
- **Replayed events.** A checkpoint job applies only from the checkpoint's `nextEventSeq` on, and a replayed configuration opens a partial trip with `opened-before-attach` rather than `late-attach` (fix round 2). Since ET-016 PR-7 (J9) the checkpoint job itself opens a late-attach trip once the replay drains, unless a trip is open then.

## PR-2 interpretations of the plan

T16 and T17 leave these cases open. They are listed here for review:

- **Active at both readings.** A step counts only when the trip was active at both of its readings, and `job.cleared` ends the run of active readings. The distance between the last reading and the opening, a clear or a disconnection is therefore not counted; at 20 Hz snapshots that is at most one 50 ms step.
- **Reading holes.** A hole downgrades any open trip whose window contains both readings, whatever its phase, while distance and fuel count only while active. Fix round 1 replaced "running at both readings" with running time split by the stream's simulation states. The odometer step across a hole is still counted when it is continuous: the odometer is cumulative, so the distance is observed, not fabricated; only the samples are missing.
- **Annotations need a trip.** A jump, refuel or odometer discontinuity with no open trip, or while the trip is not active, adds no effect; no annotation is session-level.
- **Game-time jumps (fix round 1).** A per-step rule missed a ferry spread over many readings (CAP-01 run 8: about 90 game minutes per real minute, 0–2 minutes per reading). The 60 s window finds it; the annotation grows instead of repeating.
- **Position jumps.** They reuse the crossing label of T17 and add `possible-teleport` as the inference otherwise. The margin is the separate `POSITION_JUMP_MARGIN_METERS` (50 m).
- **Refuel episodes.** Consecutive refuelled steps are one annotation with growing litres, and different episodes never merge, so the litres are never lost to merging. Fuel used is not clamped at zero: small increases larger than the consumption would make it negative and stay visible. Since ET-016 PR-6 such a total is stored as `invalid` (see Persistence).
- **"Always before a close".** The close carries an observed-distance update whenever the value changed since the last one, so no close leaves a change unsent; an unchanged value is not written again. Since ET-016 PR-6 the same update carries fuel used.
- **`odometerDeltaM`.** Only the reconnection's `disconnected` interval records it, always: null when queued, then from the first reading of the new connection while the interval still waits; gaps close the trip and carry none. It is null without an odometer or a known truck at either end, or after a truck change (brand, model or plate): no change between possibly different trucks is recorded (advisory review on PR #72).
- **Crossings by time (fix round 1).** The crossing label follows the transfer's source time, not its place in the stream, so a replayed transfer counts by when it happened. concept.md asks for a jump "next to such an event"; 300 s is the provisional meaning of "next to". A transfer after the jump does not relabel it.
- **Resumed cleared trips (fix round 1).** `TripSeed.awaitingOutcome` resumes a cleared trip awaiting its outcome; without the flag a resumed trip is active, as before.
- **Separate episodes (fix round 3).** Game-time jumps no longer merge: a later same-label sleep folded into a waiting one, and its growth then rewrote the earlier range. Waiting holes count towards the per-connection cap only on the current capture clock. A refuel episode continues only over counted steps, so a refuel after a disconnection, an opening or a clear starts a new episode.
- **Jump growth and queue position (fix round 2).** Growth is judged over at least 1 s, because at 20 Hz one ordinary minute tick within half a second looked faster than the rate and repeated or extended a sleep. A continuation starts at the end of the sent annotation. A growing jump or refuel is found anywhere in the waiting annotations, because a position jump queued in the same step would otherwise hide it.
- **Holes per connection (fix round 2).** Only holes of the current connection (from its first reading) are counted or extended, so a `sample-loss` interval never spans a `not-connected` one.
- **Holes merged (fix round 1).** Contiguous holes extend one interval; beyond four waiting holes per trip the last one is extended over the readings between, marked `includesReadings`. A UTC label that is not a non-negative safe integer is absent, as for events.
- **Readings of another session.** A reading of a session that is not the current connection's is refused with `UNKNOWN_SESSION`, like an item; PR-1 ignored every reading.
