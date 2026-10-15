# Trip lifecycle and completeness

ET-014 adds a pure, deterministic trip reducer in [packages/telemetry-core/src/trips](../packages/telemetry-core/src/trips). It turns committed protocol v1 events and gaps, session changes, checkpoint hydration and disconnections into the storage `TripEffect` lists that [storage](storage.md#storage-api) applies in the same transaction as the event or gap. The coordinator adopted decisions T1–T20 under the owner's standing delegation of October 15, 2026 ([concept.md](../concept.md#et-014-authorization--october-15-2026)).

Status (October 15, 2026):

- **PR-1** (this document): the event-driven lifecycle, identity, attribution and completeness. It covers T1–T15 and T18–T20 as they apply to events.
- **PR-2**: readings accounting (T16, T17): observed distance, fuel used, refuels, game-time jumps, crossings and reading holes, plus replay of the ET-005b simulator scenarios. Until then the reducer accepts the `reading` input and ignores it.
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
| `reading` | A normalized sample | None until PR-2 |
| `disconnected` | — | None |

## Caller contract for ET-015a

**Adopt after commit (T3).** For each event or gap, the caller:

1. reads `committedThrough()` right before the commit, as the storage caller rule requires;
2. steps the reducer;
3. commits the message with the returned effects;
4. adopts the returned state only when storage reports `committed`, `duplicate`, `covered` or `conflict`.

On a retryable or failed commit the caller keeps the old state. When the item is redelivered, the reducer then returns the same effects. Non-carrier inputs (session, checkpoint, disconnected) are adopted immediately. An `ok: false` result fails closed: durable delivery must stop, as for any other contract violation.

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
- a seed of another plugin session closes as `restart` at the new session's first commit (T11);
- a seed of the same session resumes as an active trip and becomes partial with a `not-connected` interval (`consumer-restart`): the consumer was not running for part of it. Its phase, load window and money totals are not rebuilt.

**Storage gaps (T19).** No storage change is part of ET-014. These gaps go to ET-015a or ET-016:

| # | Gap | Proposed owner |
| --- | --- | --- |
| S-1 | No fuel-used column on trips; PR-2 reports fuel used in the view only | Schema v2 `observed_fuel_used_l`, ET-015a |
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

The session's **load state** is `loading` from a fresh session until its first `simulation.started`, and again after `timers.restart` or `gameTime.regression`. It is `unknown` after a gap or when the reducer joins a session that already has committed events.

| From | Trigger | To | Effects |
| --- | --- | --- | --- |
| idle | `job.configured` | active | `trip.open` at this event with the session's current truck and trailer references and game mode; cause intervals below |
| active | same-key `job.configured` | active | none; `cargoLoaded` is updated (O3) |
| active | different-key `job.configured` | active (new) | close `{none, different-job, partial}`; open the new trip |
| active | `job.cleared` | awaiting-outcome | none |
| awaiting-outcome | same-key `job.configured` | reload-check | none |
| awaiting-outcome or reload-check | different-key `job.configured` | active (new) | close `{none, configuration-cleared, partial}`; open the new trip |
| active or awaiting-outcome | `job.delivered` / `job.cancelled` | idle | attribute `trip`; close `{outcome, this-event}`, `complete` after a clean window, else `partial` |
| active, in its load window before the start | `job.delivered` / `job.cancelled` | active | attribute `ambiguous`; the trip stays open (T14) |
| active, in its load window | `timers.restart` | active | trip.update `partial` and an `opened-at-load` interval, once |
| active, in its load window | `gameTime.regression` | active | trip.update `partial`; a `save-load` interval |
| active or awaiting-outcome, outside the load window | `timers.restart` or `gameTime.regression` | idle | close `{none, discontinuity, partial}` |
| reload-check | `gameTime.regression` | active (same trip) | trip.update `partial`; a `save-load` interval (O10) |
| reload-check | `job.cleared` | awaiting-outcome | none |
| reload-check | truck/trailer configure or clear, pause or start, same-key re-send, `source.gameMode` | reload-check | as in active |
| reload-check | `timers.restart`, a fine, toll, ferry, train or outcome | active (new) | close `{none, configuration-cleared, partial}`; open a new trip from the re-send (`jobConfiguration: {eventSeq}`) with a `reload` continuation interval. A gameplay event is attributed `ambiguous`, and an outcome does not close the new trip. After a timer restart the new trip keeps a load window |
| any open | gap with a new suffix | idle | close `{none, gap, partial}` and the gap interval (T10) |
| idle | gap with a new suffix | idle | a session-level gap interval |
| any open | `truck.configured` with different values | unchanged | trip.update `truckConfiguration: this-event`; a `truck-change` annotation unless it is the first truck reference |
| any open | `trailer.configured` with different values for its slot | unchanged | trip.update `trailerConfigurations: [this-event]` |
| any open | `source.gameMode` that differs from the trip's mode | unchanged | trip.update `gameModeAmbiguous: true`, once |
| open trip of an earlier session of the game | new session | idle | close `{none, restart, partial}` at the new session's first commit |
| open trip of this session | reconnection after `disconnected` | unchanged | trip.update `partial`; a `not-connected` interval from the last item before the disconnection |
| any | checkpoint | unchanged | none; an idle slot records the checkpoint job as untracked (T9) |

Cause intervals on `trip.open` make the new trip partial:

- `opened-at-load` (`discontinuity`): the session is loading (T12);
- `late-attach` (`not-connected`): an identical job was untracked (T9);
- `{cause, continuationOf, decision: 'not-merged'}` (`discontinuity`): the last trip of this game closed without an outcome and had the same job key. Its close reason is the cause: `restart` (T11), `gap`, `discontinuity` or `configuration-cleared`. Identical jobs are never merged.

## Attribution (T14)

Each gameplay event (`job.delivered`, `job.cancelled`, `player.fined`, `player.tollgate.paid`, `player.use.ferry`, `player.use.train`) gets exactly one `event.attribute` in its own commit. Other events get none.

| Attribution | When |
| --- | --- |
| `trip` | An active trip's window, including an outcome that attaches after the clear |
| `trip-before-loaded` | An active `cargo_market` job whose `cargoLoaded` is available and false (O3) |
| `free-driving` | No open trip, or a fine, toll or transfer after the clear |
| `ambiguous` | A gameplay event that resolves a reload check; the outcome of an untracked job or with no attachable trip; an outcome before the first start of a replaced or loaded configuration |

Money is summed per trip as exact BigInt digits per currency and SDK type. Fines before loading are kept apart from other fines. Free-driving and ambiguous events change no trip totals.

## Identity

- **Trip UUID (T4).** The first 128 bits of SHA-256(`ets2telemetry-trip-v1:` + pluginSessionId + `:` + eventSeq of the configuring job event), written as 8-4-4-4-12 lowercase hex like the simulator's seeded ids, without RFC 4122 version bits. A replay or redelivery therefore yields the same UUID. telemetry-core has its own SHA-256, checked against NIST vectors and `node:crypto`.
- **Job key (T6).** The canonical tuple of every `job.configured` field except `cargoLoaded`, with availability, reason, unit and money currency. A cargo-market pickup re-send is therefore the same job (O3).
- **Truck and trailer.** A re-send with identical values changes nothing; different values update the reference.

## Time and money (T15)

- **UTC label.** `occurred.utcUnixMs`, else the session's last label, else `receivedUtcMs`. A gap carries no UTC, so a gap close uses the session's last label. A restart close uses the old session's last observed label, a lower bound.
- **Clamp.** Storage requires `ended_utc_ms >= started_utc_ms`, and a violation would fail the commit and stop durable delivery. An end before the start is therefore clamped to the start and annotated `utc-label-jump`.
- **Real duration.** Real time comes from `occurred.monotonicNs` within one session's source clock (`realDurationNs` in the view). Trips never span plugin sessions.
- **Game time.** Game-time spans stay within one game clock. Sleeps and crossings are included and annotated, never subtracted (PR-2).
- **Money and distance.** Planned distance and expected income come from the job; revenue, delivered distance and the cancellation penalty from the outcome event. They are never converted, netted or mixed. Observed distance is PR-2.

## What "complete" means (T13)

A trip opens `unknown` and stays `unknown` while nothing is known to be missing. It becomes `partial` on:

- an event loss or not-connected interval;
- a reconnection or consumer restart;
- a save load;
- an ambiguous or not-merged continuation;
- a late attach;
- an opening during a load;
- a close without an outcome;
- a reading hole (PR-2).

It is `complete` only when its gameplay outcome closes it after a clean window. Annotations (`truck-change`, `utc-label-jump`, and the PR-2 game-time and position annotations) are `discontinuity` intervals with `detail.annotation: true` and never downgrade.

A delivered trip can be partial, and a complete trip says nothing about readings until PR-2. Completion status and recording completeness stay separate (concept.md §7).

## Effect bounds (T18)

A commit carries at most 16 effects, in this order:

1. queued lifecycle effects (restart closes and not-connected updates decided at a session input);
2. the carrier's own effects;
3. at most 8 annotations.

The carrier's own effects always fit (at most five) because they may reference `this-event`. Queued effects never reference `this-event`, so they wait in order for the game's next commit. Consecutive queued annotations of the same trip and cause merge into one with `count` and `lastAtEventSeq`.

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
| Train crossing, profile switch, quick-job replacement, mid-trip timer restart, late attach after a job started, plugin restart, reconnection, UTC set back | Synthetic inference |

## PR-1 interpretations of the plan

The plan's transitions table leaves these cases open. They are listed here for review:

- **Load window.** It extends T12 to trips opened while paused and running: a regression right after the first start, or a timer restart before it, belongs to the load that restored the job. Without it, the O1 start burst and a save load of a different job would close the trip they just loaded.
- **Reload check, `job.cleared`.** It returns to awaiting-outcome; it is treated as part of the load burst.
- **Reload check, different job.** It opens the new trip from the different configuration, not from the superseded re-send.
- **Reload check, `timers.restart`.** It resolves as "other decisive event", but the new trip keeps a load window instead of closing again at once.
- **Outcome guard.** It applies after any replacement or load, not only after a clear.
- **Untracked jobs.** Fines while hydration shows an untracked job are `free-driving`, following T14 literally: no window is open.
