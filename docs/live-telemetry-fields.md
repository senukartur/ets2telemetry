# Live telemetry fields and display rules

ET-010a adds pure live-telemetry normalization and per-game display profiles to `packages/telemetry-core`. This document is the field catalogue and the rule set those modules implement. The live dashboard that uses them is ET-010b; v1 rows on the dashboard are ET-010c. Nothing here changes the v0 or v1 wire, the preload/IPC bridge, storage, trip logic or recording. Real-source checks are pending; see [ET-010 validation](validation/et-010.md).

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

The package is pure TypeScript. It imports only its own modules and type-only declarations from `packages/contracts/src`; [telemetry-core-boundaries.test.ts](../tests/unit/telemetry-core-boundaries.test.ts) enforces this instead of a lint-config rule. The renderer calls these functions on each bridge update, at most 20 Hz. Labels and reason texts belong to the application (`apps/desktop/src/strings.ts`, ET-010b); `buildLiveView` returns formatted values, reason codes and notes.

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
| Speed | m/s, signed | `truck.speed` | v0, v1 | km/h or mph, 1 dp; a rounded −0.0 shows 0.0; negative means reverse |
| Gear | index | `truck.displayed.gear`, s32 | v0, v1 | `N`, `1`…`n`, `R1`…`Rn` |
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
| Observed distance | m | odometer steps | — | Step primitive only; ET-014 accumulates |
| Game time | game minutes | `game.time`, u32 | v0, v1 | `Day N, HH:MM`, N = ⌊minutes / 1,440⌋ + 1 (`game-time`) |
| Deadline | game minutes | job `delivery.time` − `game.time` | v1 | `in 5 h 12 min` or `late by 5 h 12 min`; missing when either is missing |
| Cargo, origin, destination | text | job config | v0 ids; v1 ids and names | Localized name, else id; a provided empty name falls through to the id |
| Cargo mass | kg | `cargo.mass` | v1 | t 1 dp or lb 0 dp |
| Market, special job | text, boolean | `job.market`, `is.special.job` | v1 | Raw market id; `yes`/`no` |
| Cargo loaded | boolean | `cargo.loaded` | v1 | Shown only for the `cargo_market` market (SDK 1.15: always true elsewhere) |
| Expected income | money u64 | job `income` | v0 `{rawValue, currency}`, v1 money | Exact raw digits, no grouping or symbol; `12345 EUR (SDK-documented)` or `12345 (currency unknown)` |
| Revenue, penalty | money s64 | `job.delivered`, `job.cancelled` | v1 events | Normalized only; a zero revenue stays `0` |
| Truck | text | truck config | v0 `truckId`; v1 brand, name, id, plate | Brand and model name, else model name, else model id; plate separately |
| Trailers | text | `trailer.N` config | v1, 10 slots | Per occupied slot: name, else body type, else id; an `invalid` slot shows `(invalid)`; joined by `, `. No occupied or invalid slot while current is the `absent` state `none` ("no trailer attached"), unless a slot is `not-supported`, which makes the row `not-supported`; only invalid slots make the row `invalid` |
| World position | game coordinates | `truck.world.placement` | v1 | `x …, y …, z …` 1 dp; game-world coordinates, not GPS (`game-world-coordinates`) |
| Bearing | degrees | placement heading | v1 | ((1 − heading) mod 1) × 360°, integer; 0° north, 90° east. The SDK heading is counterclockwise from north (`scssdk_value.h`) |
| Source | — | — | `LiveTelemetry`, v1 status | Game, origin (synthetic and replay flagged), status, current or paused, protocol; v1 game mode with method and confidence, and the total event loss |

Rounding uses `Number.prototype.toFixed` on the converted value, and a rounded negative zero is shown as positive zero for every quantity. A provided empty text value shows `(empty)`.

## Money

`MoneyValue` holds `raw` (an exact decimal string, never a JavaScript number), `sdkType` (`s64`, `u64` or `v0-decimal`) and a currency basis: `{basis: 'unknown'}` or `{basis: 'sdk-documented', code, source}`. The v0 wire spelling `verified` and the v1 `sdk-documented` both map to `sdk-documented`; the v0 name is frozen and does not mean a runtime observation. Currency is never inferred from the game, locale or profile, and money is never converted.

Money and distance values carry a kind. Money: `expected-income`, `revenue`, `penalty`, `fine`, `toll`, `transfer`. Distance: `planned`, `navigation-remaining`, `game-delivered`, `odometer`. Assigning one kind to another is a type error.

## Availability and currentness

`Reading<T>` is a value or a missing reason. `not-observed`, `not-supported` and `invalid` come from the wire. `not-carried` exists only inside telemetry-core: the protocol in use does not transport the field, for example navigation distance, trailers and game mode under v0. It never appears on the wire or in storage, and its rows are hidden.

| Situation | View |
| --- | --- |
| Fresh `connected` or `paused` with an observation (`isCurrent`) | Values shown; a missing field shows `unavailable` with its reason |
| `paused` status or paused simulation while current | Values shown; `connection.paused` drives a "game paused" banner |
| A road stop (unchanged fresh state) | Still current; speed `0.0 km/h` |
| `waiting`, `stale`, `incompatible`, `disconnected`, `unavailable`, `service-failed`, `restarting`, or not fresh | Every carried row `unavailable` with reason `not-current`; no dimmed last-known values. Without any normalized state, every row reads this way |
| Field not carried by the protocol in use | Row hidden. Carriage is a static table per protocol (`V0_CARRIED_FIELDS`; v1 carries every field), never inferred from a missing parent job or truck reading |
| No job while current | Job rows hidden; the job section carries the job's missing reason ("no job reported") |
| No trailer attached while current (v1: every slot empty, and no slot `not-supported`) | Trailers row in the `absent` state with text `none` and reason `no-trailer`. Per OD-6 an empty slot arrives as `not-observed`. The SDK delivers the initial configuration after `scs_telemetry_init()` succeeds and before any other callback ([scssdk_telemetry_event.h](../native/telemetry-plugin/vendor/scs-sdk-1.15/include/scssdk_telemetry_event.h) lines 63–69), so an empty slot in a current checkpoint is taken as no trailer. Bobtail versus a coupled trailer, including late attach, is still unverified in real sessions |

The application maps reasons to text: `not-observed` "not yet observed", `not-supported` "not provided by the game", `invalid` "invalid reading", `zero-consumption` "no consumption recorded", `no-trailer` "no trailer attached". A row reads `<Label>: <text>` or `<Label>: unavailable`, so the existing `Speed: unavailable` text is unchanged. Staleness comes from the existing ingestion and main-process freshness; telemetry-core adds no timer.

Hydrated checkpoint configuration is current state only. The view shows the job and never derives a delivery, cancellation or other gameplay effect from it.

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

Odometer precision: `truck.odometer` is an SDK float32 in km, so readings are quantized. One step (`float32Quantum`) is 1/16 km (62.5 m) from 2^19 = 524,288 km and 1/8 km (125 m) from 2^20 = 1,048,576 km. A 20 Hz step (50 ms) has a fixed threshold of 5 m + 50 m = 55 m, so without the precision-aware margin every increment of a high-mileage truck would be a jump. With it, the threshold at 2^19 km is 5 m + 125 m = 130 m, and at 2^20 km 5 m + 250 m = 255 m; at 1 Hz the fixed margin already covered one step. Round-to-nearest float32 is monotonic, so quantization alone never turns a non-decreasing odometer into a decrease, and any decrease stays `odometer-regressed`.

Caller contract for fuel: the 0.01 L band applies to refuel detection only. Ordinary steps are far smaller than the band (about 0.0075 L per second at 30–35 L/100 km and 80–90 km/h, and a twentieth of that at 20 Hz), so every decrease is reported as consumption. Over consecutive steps without a discontinuity or `unavailable`, the sum of `consumed` equals the sum of all decreases, and the net fuel drop is that sum minus the summed `increaseLiters` of `unchanged` steps. A `refuelled` step is never consumption, and a discontinuity or `unavailable` step contributes nothing.

## Field set and deferrals

The MVP field set is the concept §6 overlay metrics, the §7 sample fields, job, truck and trailer identity, and source validity. Cruise control, throttle, brake and clutch inputs, navigation time, the navigation speed limit, the parking brake and lights need a v1 minor revision and are deferred as [TD-003](technical-debt.md#td-003-live-driving-controls-and-navigation-fields). Live gameplay events are not shown on the dashboard; the journal (ET-016) shows them.
