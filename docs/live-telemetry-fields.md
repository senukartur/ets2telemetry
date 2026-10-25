# Live telemetry fields and display rules

ET-010a adds pure live-telemetry normalization and per-game display profiles to `packages/telemetry-core`. This document is the field catalogue and the rule set those modules implement. ET-010b shows the complete v0 field set on the dashboard through them (see [Dashboard](#dashboard)). ET-010c adds the fields only protocol v1 carries, from a whitelisted v1 projection on the same live update, to the dashboard card and the overlay sections (see [Protocol v1 rows](#protocol-v1-rows-et-010c)). Since ET-012a the overlay sections are formatted through the same view model in main (see [Overlay](#overlay)); since ET-010c the card and the overlay read every field through one combiner. Nothing here changes the v0 or v1 wire, the bridge methods or IPC channels, storage, trip logic or recording; ET-010c only adds the optional validated `v1` field to the live update payload. Real-source checks are pending; see [ET-010 validation](validation/et-010.md).

## Modules

| Module | Responsibility |
| --- | --- |
| [units.ts](../packages/telemetry-core/src/units.ts) | Exact conversion constants and numeric conversions from canonical units |
| [display-profile.ts](../packages/telemetry-core/src/display-profile.ts) | Display profiles `metric` and `us-customary`, per-game defaults and `resolveDisplayUnits` |
| [readings.ts](../packages/telemetry-core/src/readings.ts) | `Reading<T>`, `MissingReason`, money and distance kinds, `NormalizedLiveState` |
| [normalize-v0.ts](../packages/telemetry-core/src/normalize-v0.ts) | `normalizeV0State` |
| [normalize-v1.ts](../packages/telemetry-core/src/normalize-v1.ts) | `normalizeV1State`, `normalizeDeliveredRecord`, `normalizeCancelledRecord`, `moneyReading` |
| [format.ts](../packages/telemetry-core/src/format.ts) | Display strings and rounding |
| [derived.ts](../packages/telemetry-core/src/derived.ts) | Fuel level, deadline, bearing, odometer and fuel step primitives |
| [live-view.ts](../packages/telemetry-core/src/live-view.ts) | `isCurrent` and `buildLiveView` |

The package is pure TypeScript. It imports only its own modules and type-only declarations from `packages/contracts/src`; [telemetry-core-boundaries.test.ts](../tests/unit/telemetry-core-boundaries.test.ts) enforces this instead of a lint-config rule. The renderer calls these functions on each bridge update, at most 20 Hz. Labels, reason texts and note texts belong to the application (`apps/desktop/src/strings.ts`); `buildLiveView` returns formatted values, reason codes and notes.

## Canonical units and display profiles

Canonical values are the wire units and never change: speed m/s (negative is reverse), distances m, fuel L, consumption L/100 km (the SDK mean), mass kg, game time in game minutes, money as raw decimal strings, positions in game-world coordinates.

| Quantity | `metric` (ETS2 default) | `us-customary` (ATS default) |
| --- | --- | --- |
| Speed | km/h | mph |
| Distance | km | mi |
| Volume | L | US gal |
| Consumption | L/100 km | US mpg |
| Mass | t | lb |

Without a game the `metric` profile applies. `resolveDisplayUnits(game, {profile?, overrides?})` accepts an explicit profile and per-quantity overrides; unknown stored values are ignored. A later settings key can add to this seam without a migration.

Exact constants: mile 1,609.344 m; US gallon 3.785411784 L; pound 0.45359237 kg; 3.6 km/h per m/s; mph per m/s = 3,600 / 1,609.344. US mpg = 235.2145833… / (L/100 km), derived from the exact mile and gallon; the rounded 235.215 is not used.

## Field catalogue

| Field | Canonical | SDK source | Wire | Display (`metric` / `us-customary`) and rounding |
| --- | --- | --- | --- | --- |
| Speed | m/s, signed | `truck.speed` | v0, v1 | General telemetry-core formatting: km/h or mph, 1 dp, rounded −0.0 becomes 0.0. The Live gauge and overlay use the integer presentation override below; negative means reverse |
| Gear | index | `truck.displayed.gear`, s32 | v0, v1 | `N`, `1`…`n`, `R1`…`Rn`. Since ET-050 (October 25, 2026) the displayed game's gear display mode applies: `automatic` as before, `manual` shows forward gear g as `ceil(g / 2)` plus `L` (odd) or `H` (even), so `1L`, `1H`, `2L` … `8H`, with the same `N` and `R1`…`Rn`. Since ET-050b (October 25, 2026, decision B6) manual mode instead shows labels derived from the truck's SDK H-shifter layout (for example `LL`, `LH`, `1L`…`8H` on the ATS Mack 18-speed) while the protocol v1 projection is current, its truck model id equals v0's and the layout validates against the gear counts; otherwise, including a minor-0 plugin, the formula applies. One point, `liveSources`, formats the row for the dashboard and the overlay. Storage, samples, the journal and the export keep the raw integer index |
| Engine RPM | rpm | `truck.engine.rpm` | v0, v1 | integer, `600 rpm` |
| Fuel | L | `truck.fuel.amount` | v0, v1 | L or US gal, 1 dp |
| Fuel capacity | L | truck config `fuel.capacity` | v0, v1 | L or US gal, 0 dp |
| Fuel level (derived) | fraction | fuel / capacity | — | integer %; missing with the fuel's or capacity's reason; `invalid` for a provided capacity of 0 (no valid denominator) and above capacity × (1 + 10⁻⁶) |
| SDK average consumption | L/100 km | `truck.fuel.consumption.average` L/km × 100 | v0, v1 | L/100 km 1 dp; US mpg 1 dp for values above zero. Zero is `0.0 L/100 km` in metric and the reason `zero-consumption` in US mpg. Always the SDK mean (`sdk-mean` note), never a trip average. In ATS it also carries the `ats-mostly-static` note: the pinned ATS header says, as of v1.00, "The fuel_average_consumption is currently mostly static and depends on presence of the trailer and skills of the driver instead of the workload of the engine" ([scssdk_telemetry_ats.h](../native/telemetry-plugin/vendor/scs-sdk-1.15/include/amtrucks/scssdk_telemetry_ats.h) lines 63–65). The ETS2 header states no such limitation. Runtime behaviour in either game is unverified |
| Estimated range | m | `truck.fuel.range` km × 1,000 | v0, v1 | km or mi, 0 dp; the game's estimate (`game-estimate`), never computed here |
| Odometer | m | `truck.odometer` km × 1,000 | v0, v1 | km or mi, 1 dp |
| Route remaining | m | `truck.navigation.distance` | v1 | km or mi, 1 dp |
| Planned distance | m | job `planned_distance.km` × 1,000 | v0, v1 | km or mi, 0 dp; job offer, excludes ferry (`job-offer-excludes-ferry`) |
| Game-delivered distance | m | `job.delivered` `distance.km` | v1 event | Normalized only; the journal (ET-016) shows it |
| Observed distance | m | odometer steps | — | Step primitive; ET-014 accumulates per trip |
| Game time | game minutes | `game.time`, u32 | v0, v1 | `Day N, HH:MM`, N = ⌊minutes / 1,440⌋ + 1 (`game-time`) |
| Deadline | game minutes | job `delivery.time` − `game.time` | v1 | `in 5 h 12 min` or `late by 5 h 12 min`; missing when either is missing |
| Cargo, origin, destination | text | job config | v0 ids; v1 ids and names | Localized name, else id; a provided empty name falls through to the id |
| Cargo mass | kg | `cargo.mass` | v1 | t 1 dp or lb 0 dp |
| Market, special job | text, boolean | `job.market`, `is.special.job` | v1 | telemetry-core keeps the raw market id; since ET-045a the dashboard and journal show a label for the five SDK 1.15 values (below), an unknown value verbatim; `yes`/`no` |
| Cargo loaded | boolean | `cargo.loaded` | v1 | Shown only for the `cargo_market` market (SDK 1.15: always true elsewhere) |
| Expected income | money u64 | job `income` | v0 `{rawValue, currency}`, v1 money | Exact raw digits, no grouping or symbol; `12345 EUR (SDK-documented)` or `12345 (currency unknown)` |
| Revenue, penalty | money s64 | `job.delivered`, `job.cancelled` | v1 events | Normalized only; a zero revenue stays `0` |
| Truck | text | truck config | v0 `truckId`; v1 brand, name, id, plate | Brand and model name, else model name, else model id; plate separately. Under v0 the row is the model id; since ET-045a it shows v1's brand and name for the same model id (F4(c) below) |
| Trailers | text | `trailer.N` config | v1, 10 slots | Per occupied slot: name, else body type, else id; an `invalid` slot shows `(invalid)`; joined by `, `. No occupied or invalid slot while current is the `absent` state `none` ("no trailer attached"), unless a slot is `not-supported`, which makes the row `not-supported`; only invalid slots make the row `invalid` |
| World position | game coordinates | `truck.world.placement` | v1 | `x …, y …, z …` 1 dp; game-world coordinates, not GPS (`game-world-coordinates`) |
| Bearing | degrees | placement heading | v1 | ((1 − heading) mod 1) × 360°, integer; 0° north, 90° east. The SDK heading is counterclockwise from north (`scssdk_value.h`) |
| Source | — | — | `LiveTelemetry`, v1 status | Game, origin (synthetic and replay flagged), status, current or paused, protocol; v1 game mode with method and confidence, and the total event loss |

Rounding uses `Number.prototype.toFixed` on the converted value, and a rounded negative zero is shown as positive zero for every quantity. A provided empty text value shows `(empty)`.

Owner-requested presentation update, October 22, 2026 (ET-012e): the Live dashboard gauge, its accessible name and every overlay layout show speed as an integer after conversion to the selected game's km/h or mph profile. They use the existing `fixed(..., 0)` rounding, including negative values and normalization of rounded negative zero to `0`. For example, 25 m/s shows `90 km/h` or `56 mph`. The canonical numeric reading, gauge ratio, telemetry-core's general one-decimal formatter, journal samples and exports retain their existing precision. Fuel and consumption formatting are unchanged.

Standstill gauge, October 24, 2026 (ET-045a): the Live gauge draws no speed arc while the displayed integer is `0`. Its ratio is `0` then, so a tiny positive SDK speed such as 0.1 m/s (`0 km/h`) no longer paints the round line cap as a dot that blinks while the speed flickers around zero. Once the number is non-zero the ratio keeps its fractional precision (1.25 m/s shows `5` with the ratio 4.5/130). Unavailable or stale speed still has no ratio, reverse still draws no arc, and the RPM arc, the canonical reading, journal samples and exports are unchanged.

Job market labels (ET-045a). The dashboard's Job badge and market row and the journal's trip details show these labels; telemetry-core, the v1 projection, storage and the JSON export keep the raw value. Any other value, an inherited name such as `constructor` and `(empty)` are shown verbatim.

| SDK 1.15 `job.market` | English | Russian |
| --- | --- | --- |
| `cargo_market` | Cargo market | Рынок грузов |
| `quick_job` | Quick job | Быстрый заказ |
| `freight_market` | Freight market | Грузоперевозки |
| `external_contracts` | External contracts | Внешние контракты |
| `external_market` | External market | Внешний рынок |

## Money

`MoneyValue` holds `raw` (an exact decimal string, never a JavaScript number), `sdkType` (`s64`, `u64` or `v0-decimal`) and a currency basis: `{basis: 'unknown'}` or `{basis: 'sdk-documented', code, source}`. The v0 wire spelling `verified` and the v1 `sdk-documented` both map to `sdk-documented`; the v0 name is frozen and does not mean a runtime observation. Currency is never inferred from the game, locale or profile, and money is never converted.

Money and distance values carry a kind. Money: `expected-income`, `revenue`, `penalty`, `fine`, `toll`, `transfer`. Distance: `planned`, `navigation-remaining`, `game-delivered`, `odometer`. Assigning one kind to another is a type error.

## Availability and currentness

`Reading<T>` is a value or a missing reason. `not-observed`, `not-supported` and `invalid` come from the wire. `not-carried` exists only inside telemetry-core: the protocol in use does not transport the field, for example navigation distance, trailers and game mode under v0. It never appears on the wire or in storage, and its rows are hidden.

| Situation | View |
| --- | --- |
| Fresh `connected` or `paused` with an observation (`isCurrent`) | Values shown; a missing field shows `unavailable` with its reason |
| `paused` status or paused simulation while current | Values shown; `connection.paused` drives a "game paused" banner |
| A road stop (unchanged fresh state) | Still current; the Live gauge and overlay show `0 km/h` (general telemetry-core formatting remains `0.0 km/h`) |
| `waiting`, `stale`, `incompatible`, `disconnected`, `unavailable`, `service-failed`, `restarting`, or not fresh | Every carried row `unavailable` with reason `not-current`; no dimmed last-known values. Without any normalized state, every row reads this way |
| Field not carried by the protocol in use | Row hidden. Carriage is a static table per protocol (`V0_CARRIED_FIELDS`; v1 carries every field), never inferred from a missing parent job or truck reading |
| No job while current | Job rows hidden; the job section carries the job's missing reason ("no job reported") |
| No trailer attached while current (v1: every slot empty, and no slot `not-supported`) | Trailers row in the `absent` state with text `none` and reason `no-trailer`. Per OD-6 an empty slot arrives as `not-observed`. The SDK delivers the initial configuration after `scs_telemetry_init()` succeeds and before any other callback ([scssdk_telemetry_event.h](../native/telemetry-plugin/vendor/scs-sdk-1.15/include/scssdk_telemetry_event.h) lines 63–69), so an empty slot in a current checkpoint is taken as no trailer. Bobtail versus a coupled trailer, including late attach, is still unverified in real sessions |

The application maps reasons to text: `not-observed` "not yet observed", `not-supported` "not provided by the game", `invalid` "invalid reading", `not-current` "not current", `zero-consumption` "no consumption recorded", `no-trailer` "no trailer attached". The Live speed gauge shows a dash for unavailable speed and retains the localized `Speed: unavailable` description in its accessible name; fuel reads `<Label>: <text>` or `<Label>: unavailable`. The other rows use a label and value pair with the reason in parentheses (see [Dashboard](#dashboard)). Staleness comes from the existing ingestion and main-process freshness; telemetry-core adds no timer.

Hydrated checkpoint configuration is current state only. The view shows the job and never derives a delivery, cancellation or other gameplay effect from it.

## Dashboard

ET-010b adds the **Live telemetry** card ([live-dashboard.tsx](../apps/desktop/src/live-dashboard.tsx)) between the status card and the application status card of the main window. It is a thin map over the pure builder [live-dashboard-text.ts](../apps/desktop/src/live-dashboard-text.ts), which builds the view on each bridge update and adds the application's texts. ET-010b showed the v0 field set only; ET-010c adds the v1 rows, game mode and event loss through the combiner [live-sources.ts](../apps/desktop/src/live-sources.ts) (see [Protocol v1 rows](#protocol-v1-rows-et-010c)). Without a v1 observation for the current selection the card is exactly the ET-010b card.

- **Speed and fuel** use the Live instrument after its restyle. Since the October 22 ET-012e presentation update, speed appears once as the visible SVG number and unit (`live-speed-number`, `live-speed-unit`), with an accessible name on `live-speed-gauge`; the duplicate `speed` paragraph is removed. Fuel keeps its existing `fuel` value. The detailed field rows do not repeat them (`LEGACY_ROW_IDS`, decision B1). Their freshness gate remains `live.fresh`, which equals `isCurrent` in practice.
- **Sections** follow `buildLiveView`: Driving, Fuel, Distance, Time, Job, Vehicle and Position, then the Protocol v1 source section (ET-010c). A section is omitted when it has no rows and no missing subject, so Position never appears under v0 alone. Before the first observation telemetry-core reports every field as not current; the card still shows only the fields v0 carries (`carriesField`). A current update whose job reading was never reported shows the Job section with "No job reported"; a job reading that was rejected or is not provided keeps its reason instead, for example "Job unavailable (invalid reading)", so an unavailable job is never presented as the absence of a job.
- **Rows** are `<dt>`/`<dd>` pairs in one grid per section, like the application status card (decision B2). The label carries the note in parentheses; the value carries the reason in parentheses. Hidden rows (`hidden` state: not carried by the protocol in use or not applicable) are not rendered at all.
- **Paused**: current values stay visible under a "Game paused" status line.
- **Test ids**: the card is `live-telemetry`; each section `live-section-<section id>`; each value `live-<field id>`, with its reason in `live-<field id>-reason` and its note in `live-<field id>-note` (decision B3); the paused line `live-paused`, the no-job line `live-job-missing` and, since ET-010c, the v1 status line `live-v1-status`. Each id element holds only its text, without parentheses, so the smokes compare exact texts.
- **Strings**: `LIVE_FIELD_TEXT`, `VIEW_REASON_TEXT`, `FIELD_NOTE_TEXT` and `LIVE_SECTION_TEXT` in [strings.ts](../apps/desktop/src/strings.ts) are exhaustive records over telemetry-core's ids, so a new id does not compile without a text. The consumption label is "SDK average consumption" with the note "SDK mean, not a trip average"; no label or note calls a value a trip value.
- **Units** use the same rule as the speed and fuel lines: the displayed game's saved profile ([settings](settings.md)), or its ET-000 default before the settings arrive, and metric without a game. The ATS "mostly static" note follows the observation's source game instead. Under "Select a game" with an ATS source the card therefore shows metric units with the ATS note; this inconsistency is accepted and documented (decision B5).

Decisions B1–B6 are coordinator decisions under the owner's delegation of October 15, 2026 ([concept.md](../concept.md#et-010-authorization--october-15-2026)). Final styling and localization are not part of ET-010b.

## Protocol v1 rows (ET-010c)

The telemetry service runs protocol v1 beside v0, live-only ([service wiring](telemetry-service-v1.md#service-wiring)). Since ET-010c it attaches a whitelisted projection of its v1 source state to the existing coalesced live update as the optional field `LiveTelemetry.v1` (decision F1): selection, status, reason, freshness and, once observed, the source identity, seq, capture time, the current state without the game window, the game mode, the event-loss counts, the receipt time and the hydration flag (F2). It never carries the window or its handle, the clock mapping, the delivery cursor, continuity, the last `end` or durable status. Main and the dashboard preload validate the projection again with `parseLiveV1` and strip it when it is invalid or names another selection; the v0 update is kept and main logs `LIVE_V1_REJECTED` at occurrences 1, 2, 4, 8, … Each layer expires it on its own 500 ms clock (F3): the service's v1 ingestion ("No recent SDK capture"), main ("Main has no recent v1 SDK capture") and the preload ("Renderer has no recent v1 SDK capture"). New v0 data never renews v1 data and new v1 data never renews v0 data. A selection change, a service failure or restart and a replacement subscription clear or stale it. Bridge methods and IPC channels are unchanged (F10).

Every row has one source ([live-sources.ts](../apps/desktop/src/live-sources.ts), decision F4):

- **(a) One combiner.** `liveSources(live, units)` returns the v0 view, the v1 view, `v1Current`, the job identity and the paused state, and `field(id)` picks each field's source. The card and main's overlay projection both use it.
- **v0 rows stay on v0.** Every field v0 carries (`V0_CARRIED_FIELDS`) comes from the v0 observation, with v0's presence and currentness, even when v1 reports another value (for example the gear). Without a v0 observation those rows are not current although v1 is.
- **v1-only rows** (route remaining, deadline, source city and company, destination company, cargo mass, market, special job, cargo loaded, license plate, trailers, world position, heading, game mode, lost events) come from the v1 view under v1's own currentness. Without a v1 observation for the current selection they are hidden, as before ET-010c. After a v1 disconnect the observation is kept, so they read `unavailable` with "not current".
- **(b) Job identity guard.** The v1 job rows (deadline, source city and company, destination company, cargo mass, market, special job, cargo loaded) count only for the job v0 reports: v0 has a job and v1's cargo id and destination city id equal v0's. Another job, or no v1 job, makes them `unavailable` with "not current" (cargo loaded stays hidden when v1's own job is not a cargo-market job). Without a v0 job they are hidden. The non-job v1 rows are not guarded.
- **(c) Names.** Cargo and destination city keep v0's presence and currentness; while both sources are current and the job matches they show v1's localized name (else its id) instead of the game id. Since ET-045a the truck row does the same with its own guard: while both sources are current, both truck readings have a value and v1's model id equals v0's `truckId`, it shows v1's brand and name (else name, else id). Another model id keeps the v0 id. There is no id-to-model table, so an unrecognized id is never given an invented name.
- **(d) Paused.** v0 decides while it is current; otherwise current v1 data may report a paused game.
- **(e) Origin.** v1 data counts only when its origin and game equal the v0 observation's, whenever v0 has an observation.
- **Units** (F9) are the card's: the displayed game's profile, so 18,000 kg reads `18.0 t` or `39683 lb`.

The **Protocol v1 source** section (`live-section-source`, F5) appears last once a v1 observation exists for the current selection. Its status line `live-v1-status` reads `<status>: <reason>`, for example `connected: Validated current observation`; its rows are the game mode (`live-game-mode`, with method and confidence, or `unknown` until OD-3) and the total of lost events (`live-event-loss`, with the note "this version records no gameplay events": the live-only connection loses every event to the missing durable consumer).

## Overlay

ET-012a builds the overlay's sections in main through the same view model as the dashboard card, in the same per-game unit profile, so a value reads the same on both; since ET-010c both read every field through the combiner [live-sources.ts](../apps/desktop/src/live-sources.ts). The renderer receives only the formatted text and two validated gauge fractions in [0, 1], the RPM `ring` and, since ET-045f, the speed `speedRing` ([overlay-presentation.ts](../apps/desktop/src/overlay-presentation.ts)); no `LiveTelemetry` reaches the overlay renderer (ET-008 boundary, decision L7). For ET-010c only, coordinator decision C1 supersedes L7's statement that the bridge carries v0 only; `OverlayPresentation`, the overlay preload and the overlay IPC are unchanged.

| Section | Fields | Under protocol v0 alone | With protocol v1 (ET-010c) |
| --- | --- | --- | --- |
| Speed | `speed`. Since ET-045f a current value also carries `speedRing`, the fraction of the 130 km/h or 80 mph gauge scale of the displayed profile (the Live instrument's), capped at 1; it is 0 while the displayed integer is 0 and in reverse, and absent while the speed is unavailable or not current. The Cluster draws it as the outer arc | Shown | Unchanged (v0) |
| Gear | `gear` | Shown | Unchanged (v0) |
| RPM | `engine-rpm`, plus a ring fraction on a fixed 0–3000 rpm scale (L12) | Shown | Unchanged (v0) |
| Fuel | `fuel`, with `fuel-level` as detail | Shown; the percentage only while the capacity is known | Unchanged (v0) |
| Range | `estimated-range` (the game's estimate) | Shown | Unchanged (v0) |
| Consumption | `sdk-average-consumption` (the SDK mean, never a trip average). Since ET-045a it is labelled "Consumption" / "Расход" in every layout and in the section toggles, and the strip's "SDK mean" caption is removed; the dashboard keeps "SDK average consumption" with its note | Shown | Unchanged (v0) |
| Cargo | `cargo`, with `cargo-mass` as detail | Shown as the cargo id; the mass needs v1 | v1's cargo name and the mass for the same job; otherwise the v0 id without a mass |
| Origin | `source-city`, `source-company` | Hidden: v0 does not carry them | Shown for the same job |
| Destination | `destination-city`, `destination-company` | Shown as the destination city id; the company needs v1 | v1's city name and the company for the same job; otherwise the v0 id |
| Distance driven | none | Always hidden: it needs trip accounting (ET-014); the odometer is never a stand-in (REG-008, decision L8) | Unchanged: hidden |
| Distance remaining | `route-remaining` | Hidden: v0 does not carry the navigation distance | Shown, not job-guarded |
| Deadline | `deadline` | Hidden: v0 does not carry the delivery deadline | Shown for the same job, from v1's own game time |
| Expected income | `expected-income` (exact raw digits, no grouping, SDK-documented or unknown currency; never revenue). Since ET-045a the overlay shows `12345 EUR` without the "(SDK-documented)" suffix (telemetry-core `formatMoneyAmount`); an unknown currency still reads `(currency unknown)`. The dashboard, journal and export keep the suffix | Shown | Unchanged (v0) |
| Game time | `game-time` | Shown | Unchanged (v0) |

A section with several fields joins the fields that have a value with ", ". A part v0 does not carry counts as carried only while a v1 observation of the current selection and origin exists. A shown v1 section whose v1 carriage is lost while an update still carries a v0 observation (main stripped an invalid projection, or the v1 origin or game stopped matching) keeps an `unavailable` dash, current or not (L5); an update without a v0 observation (a selection change, a service failure or restart, a lost channel) clears it. A v1 part has a value only while the v0 data is current, the v1 data is current and, for job parts, both describe the same job; the overlay's overall state, freshness, source, paused state and placement stay v0's. The section states while current and while not current are described in [the minimal overlay](minimal-overlay.md#section-states).

## Step primitives (REG-008)

`odometerStep(prev, next)` and `fuelStep(prev, next)` compare two observations and keep no state. Each sample holds the source identity, the capture time and a normalized state.

| Result | Rule |
| --- | --- |
| `source-changed` | Game, origin, plugin session, process instance or capture clock differs |
| `truck-changed` | Truck identity differs: v0 truck id and its availability; v1 brand id, model id and plate |
| `game-clock-rotated` | The game-time clock id differs (timer restart or save load) |
| `unavailable` | A value is missing, or the capture time runs backwards |
| `odometer-regressed` | The odometer decreases |
| `odometer-jump` | The step exceeds 100 m/s × elapsed source seconds + the margin (teleport, ferry, train). The margin is the larger of 50 m and two float32 quanta of the larger reading (`odometerJumpMargin`) |
| `continuous` | Otherwise, with metres ≥ 0; a road stop is 0 m |
| Fuel `consumed` | Any decrease, with its exact amount in litres (> 0) |
| Fuel `refuelled` | An increase above 0.01 L, with its exact amount |
| Fuel `unchanged` | No change or an increase of at most 0.01 L, with that exact `increaseLiters` (≥ 0) |

Checks run in that order, so a save load that also regresses the odometer reports `game-clock-rotated`. The thresholds are named constants (`MAX_PLAUSIBLE_SPEED_MPS`, `ODOMETER_JUMP_MARGIN_METERS`, `FUEL_NOISE_LITERS`) and are provisional until real sessions confirm them. ET-014 decides what each result means for a trip.

Observed distance: ET-014 PR-2 accumulates these steps into trips, and fuel used and refuels from the fuel steps; which trip a step belongs to and how it is persisted are in [trips](trips.md#readings-accounting-t16-t17).

Odometer precision: `truck.odometer` is an SDK float32 in km, so readings are quantized. One step (`float32Quantum`) is 1/16 km (62.5 m) from 2^19 = 524,288 km and 1/8 km (125 m) from 2^20 = 1,048,576 km. A 20 Hz step (50 ms) has a fixed threshold of 5 m + 50 m = 55 m, so without the precision-aware margin every increment of a high-mileage truck would be a jump. With it, the threshold at 2^19 km is 5 m + 125 m = 130 m, and at 2^20 km 5 m + 250 m = 255 m; at 1 Hz the fixed margin already covered one step. Round-to-nearest float32 is monotonic, so quantization alone never turns a non-decreasing odometer into a decrease, and any decrease stays `odometer-regressed`.

Caller contract for fuel: the 0.01 L band applies to refuel detection only. Ordinary steps are far smaller than the band (about 0.0075 L per second at 30–35 L/100 km and 80–90 km/h, and a twentieth of that at 20 Hz), so every decrease is reported as consumption. Over consecutive steps without a discontinuity or `unavailable`, the sum of `consumed` equals the sum of all decreases, and the net fuel drop is that sum minus the summed `increaseLiters` of `unchanged` steps. A `refuelled` step is never consumption, and a discontinuity or `unavailable` step contributes nothing.

## Field set and deferrals

The MVP field set is the concept §6 overlay metrics, the §7 sample fields, job, truck and trailer identity, and source validity. Cruise control, throttle, brake and clutch inputs, navigation time, the navigation speed limit, the parking brake and lights need a v1 minor revision and are deferred as [TD-003](technical-debt.md#td-003-live-driving-controls-and-navigation-fields). Live gameplay events are not shown on the dashboard; the journal (ET-016) shows them.
