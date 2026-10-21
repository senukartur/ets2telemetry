# Desktop UI specification (Yukon Union style)

Status: design target, October 19, 2026. This document and [the mockup](mockup.html) describe the final look of the desktop application and its overlay. They do not change product requirements, contracts or acceptance criteria, and they do not authorize implementation. Each implementing package needs its own card and follows [AGENTS.md](../../AGENTS.md).

The owner asked for a final mockup that matches the Yukon Union community dashboard, adds the Hard Mode status from [ET-026](https://trello.com/c/Cl5oNGTw), and can be implemented by agents. The owner chose: files in the repository, English with a Russian variant, the "Yukon Union Telemetry" brand, and screens for account and sync, first run, and empty and error states besides Live, Journal, Trip details, Settings, Hard Mode and the overlay.

## 1. How to use this folder

| File | Role |
| --- | --- |
| [ui-spec.md](ui-spec.md) | This document: rules, components, screens, data bindings and states. **Authoritative for behaviour and structure.** |
| [tokens.css](tokens.css) | Colours, type, shapes and the shadcn variable mapping. **Authoritative for values.** |
| [mockup.html](mockup.html) | Interactive reference: open it in a browser. Controls switch screen, language, game, connection, Hard Mode result and an **Inspect** view that labels every region with its spec id. Authoritative for layout and proportions only. |
| [assets/logo.png](assets/logo.png) | The application logo (bear head), white line art on a transparent background, 1024 × 1024 PNG. Rules in [§3 Logo](#3-tokens-type-and-icons). |
| [assets/app-icon.png](assets/app-icon.png) | A 256 px preview of the application icon generated from the logo. Rules in [§3 Application icon](#3-tokens-type-and-icons). |

Precedence: AGENTS.md and concept.md (product and data rules) → this spec → tokens.css → the mockup's pixels. If the mockup and this spec disagree, follow this spec and report the difference.

**Spec ids.** Every region in the mockup carries `data-spec="<id>"`, for example `live.hardMode`. Reuse the id as the component's `data-testid` (or as its prefix), so that tests, reviews and this document point at the same thing. The tables below list every id.

**Strings.** The mockup's `I18N` object holds every visible English string and a proposed Russian translation, keyed like `live.speed` or `hm.c.truckstab`. Use these keys and texts when adding entries to `apps/desktop/src/strings.ts`. Existing strings in strings.ts win over the mockup where they already cover the same text; the mockup shortens some of them for density, so align them in the implementing PR and say so.

**Sample data.** All values in the mockup are invented examples. Game data (cargo, city and company names, truck models) is shown as the game sends it and is never translated by the application.

## 2. Principles
### ET-029 note: Localization (Option B)

In ET-029, the Russian localization and i18n framework are implemented following Option B (approved by owner):
- Standalone `LanguageCard` on the dashboard allows switching between English (`en`) and Russian (`ru`).
- Switching language updates dashboard, overlay and tray immediately without restart, and persists via format v4 settings.
- Translation dictionary parity is verified by unit tests, matching keys from `mockup.html`.
- When the multi-page Yukon Union shell is introduced, the language selector will migrate into the shell header/sidebar.


1. **Status is always visible.** The top bar shows the game connection, plugin, Hard Mode and (later) dashboard sync on every screen. The sidebar shows the recording state.
2. **Status is never colour alone.** Every status pairs a colour with an icon and a word: ✓ success, ◷ waiting or warning, ✕ error, ◌ neutral or offline. The accent blue is for actions and selection only, never for status.
3. **Unavailable is not zero.** A missing value shows `—` (or is hidden where the rules say so), never `0`. Stale values stay visible but are greyed (`opacity: .45`) and carry a stale badge.
4. **Keep the data distinctions.** Planned, observed and game-reported distance; expected income and revenue or penalty; real time and game time; job outcome and recording completeness. Each pair is shown side by side and labelled, never merged.
5. **Name the SDK values honestly.** Average consumption is labelled "SDK mean, not a trip average" (ATS: "mostly static"). Range is "the game's estimate". Money is exact raw digits with the currency code, without grouping or symbols (`48210 EUR`).
6. **Dark only.** There is no light theme. `color-scheme: dark` is set on `:root`.
7. **Desktop density.** One step denser than the web dashboard: body 13 px, controls 32–36 px. Interactive targets are at least 32 px; text contrast is at least 4.5:1.

## 3. Tokens, type and icons

Values are in [tokens.css](tokens.css). Summary:

| Use | Token | Value |
| --- | --- | --- |
| Work area | `--yu-bg-app` | `#111827` |
| Title bar, sidebar, top bar | `--yu-bg-chrome` | `#0B1120` |
| Cards, menus | `--yu-bg-card` | `#1F2937` |
| Table header, nested blocks | `--yu-bg-inset` | `#1A2332` |
| Card border / input border / row divider | `--yu-border` / `--yu-border-input` / `--yu-divider` | `#374151` / `#4B5563` / `#2B3544` |
| Text / secondary / muted | `--yu-text` / `--yu-text-secondary` / `--yu-text-muted` | `#F3F4F6` / `#D1D5DB` / `#9CA3AF` |
| Accent (buttons, selection, active nav) | `--yu-accent` | `#2563EB`, white text |
| Accent light (focus ring, progress, gauge arc, links) | `--yu-accent-light` | `#60A5FA` |
| Status ok / warn / error / neutral | `--yu-ok-*` / `--yu-warn-*` / `--yu-err-*` / `--yu-neutral-*` | see tokens.css (text, background, border triples) |
| Game chips | `--yu-ets2-*` (sky) / `--yu-ats-*` (violet) | see tokens.css |
| Metric tile highlight | `--yu-tile-gradient`, `--yu-tile-border` | blue; `--yu-tile-teal-*` for money |

**Wiring.** Replace the neutral `:root` and `.dark` colour blocks in `apps/desktop/src/index.css` with the shadcn mapping block from tokens.css, and add the `--yu-*` block. Do not add a `.dark` class switch. The overlay's own stylesheet (`apps/desktop/src/renderer.css`) imports only the `--yu-ov-*` block; it never loads `index.css` or the shadcn base styles.

**Type.** Onest replaces Geist: add `@fontsource-variable/onest` (pinned like the other packages) and import it where `@fontsource-variable/geist` is imported today; remove Geist. Never load Google Fonts at runtime; the application must work offline. Use `font-variant-numeric: tabular-nums` for every number column, metric and live value. Scale: screen title 24 px/700 (top bar 18 px/700), card title 15 px/600, body 13 px, meta 12 px, sidebar group label 11 px/600 uppercase with 0.6 px tracking, metric 28 px/800.

**Signature detail.** Every card title has a 3 px `--yu-accent` bar on its left and a 10 px text indent (`border-left: 3px solid; padding-left: 10px`).

**Shapes.** Cards 12 px radius, buttons and inputs 10 px, chips 8 px, badges 6 px. Card padding 14–16 px; gaps between blocks 14 px.

**Logo.** `assets/logo.png`, chosen by the owner on October 19, 2026; it replaces the earlier community emblem everywhere in this design.
- It is white line art on a transparent background, so place it only on the dark surfaces (`--yu-bg-chrome`, `--yu-bg-app`, `--yu-bg-card`). Never put it on a light, accent or status-coloured plate.
- Use it unchanged: no recolouring, cropping, rotation, outlines, shadows or glow, and keep its proportions.
- Keep clear space of at least 1/8 of its size on every side.
- Minimum size 20 px. Below that the outline fades into grey, so 16 px uses (tray, taskbar, installer) use the application icon below.
- Sizes in this design: 20 px in the title bar, 40 px in the sidebar and first-run lockups, 64 px in Settings → About.
- Next to the product name it is decorative (`alt=""`); alone, its alt text is "Yukon Union Telemetry".
- Bundle the file with the application (no remote URL). Generate the Windows `.ico` sizes from the 1024 px master.

**Application icon.** Added on October 21, 2026 at the owner's request for the taskbar and the notification area. It is a separate mark, so the logo rules above about plates and shadows do not apply to it. `scripts/generate-app-icons.mjs` renders it from `assets/logo.png`; rerun it and commit the outputs whenever the logo changes.
- The bear in `--yu-bg-chrome`-to-`--yu-accent` gradient tile with rounded corners and a `--yu-accent-light` rim, so it reads on light and dark taskbars.
- 48 px and above keep every inner stroke of the logo, as cut-outs, with a soft shadow below the bear. Below 48 px the silhouette is filled and only the open mouth and the eye are cut out in `--yu-bg-chrome`, because thinner strokes fade.
- `resources/icon/app.ico` (16–256 px) is embedded in the executable and is the Setup icon, so the taskbar, shortcuts and windows show it. Squirrel's Update.exe keeps its vendored icon.
- The notification-area icon is the small mark with a status dot in the lower right corner: green `#34D399` ready, amber `#F59E0B` starting, restarting or exiting, red `#EF4444` failed. The tray tooltip states the status in words, so the dot is never the only signal. Green is `--yu-online`; amber and red are icon-only values with no token, defined by the generator and `TRAY_TONE_RGB` in `apps/desktop/src/tray-icon.ts`, which a unit test keeps equal.

**Icons.** `lucide-react` (already a dependency) with `strokeWidth={1.8}`, round caps and joins. Sizes: 14 px inside badges and small buttons, 16 px default, 18 px in the sidebar, 28 px in empty states. Icon names used:

| Meaning | lucide-react |
| --- | --- |
| Live | `Gauge` |
| Journal | `BookOpen` |
| Settings | `Settings2` |
| Account and sync | `Cloud` (offline: `CloudOff`) |
| Hard Mode | `Flame` in every state; the state is carried by the chip colour and its words ("Hard Mode ✓", "Hard Mode 10/12", "Hard Mode lost"). Do not use shield or badge-check shapes: the owner asked for a mark that cannot be confused with VTCBase's |
| Plugin | `Plug` |
| Recording | a dot (`--yu-online` with a 3 px 18% halo when recording) |
| Cargo, origin, destination | `Package`, `MapPin`, `Flag` |
| Distance driven, range, consumption | `Route`, `Navigation`, `Droplet` |
| Deadline, game time, income | `Clock`, `Calendar`, `Coins` |
| Connection lost, paused | `WifiOff`, `Pause` |
| Folder, export, refresh, exit | `FolderOpen`, `Download`, `RefreshCw`, `Power` |

## 4. Application shell

Design canvas 1280 × 800; minimum window 1100 × 720. Layout: title bar (32 px), then a row of sidebar (220 px) and main column (top bar 52 px plus scrolling content with 18–20 px padding).

| Spec id | What | Implementation |
| --- | --- | --- |
| `shell.titlebar` | Window title bar, `#0B1120`, logo 20 px and "Yukon Union Telemetry" | Electron `titleBarStyle: 'hidden'` with `titleBarOverlay: {color: '#0B1120', symbolColor: '#D1D5DB', height: 32}`; native caption buttons stay. Closing still hides to the tray (ET-011). |
| `shell.sidebar` | Navigation column, `#0B1120`, right border `#1F2937` | shadcn `sidebar` component or a plain `nav`; items are buttons with `aria-current="page"` when active |
| `shell.sidebar.lockup` | Logo 40 px, "Yukon Union" 15 px/700, "Telemetry · ETS2 · ATS" 11 px muted | The logo is decorative here (`alt=""`); follow the logo rules in §3 |
| `shell.sidebar.nav` | Groups: **Drive** (Live, Journal), **Application** (Settings), **Company · Later** (Account & sync) | Active item: `--yu-selected-bg`, `--yu-selected-border`, `--yu-selected-fg`, 600 weight; others `--yu-text-secondary`; height 38 px, radius 10 px |
| `shell.sidebar.recording` | Recording box at the bottom: dot, headline, one detail line | Bound to `AppState.health.recording` (`RecordingHealth`); texts from `RECORDING_STATE_SHORT_TEXT` |
| — | Language button (globe, code, chevron) and Exit | Language opens a menu (shadcn `dropdown-menu`) with English and Русский. Exit calls `exitApplication()` (explicit full exit) |
| `shell.topbar` | Screen title and status chips | — |
| `shell.topbar.status` | Chips: game connection, plugin, Hard Mode, dashboard sync (Later) | See the table below |

Top-bar status chips:

| Chip | Source | ok | warn | error | neutral |
| --- | --- | --- | --- | --- | --- |
| Game connection | `LiveTelemetry.status` | `connected`: "ETS2 · Single-player" with the live dot | `paused` | `stale`, `disconnected`, `incompatible`, `service-failed` | `waiting`, `unavailable`, `restarting` |
| Plugin | `AppState.plugins` targets (`PluginTargetState`) | all discovered games `installed` ("Plugin 2/2") | any `outdated`, `working` | any `blocked` | `missing`, `excluded` only |
| Hard Mode | ET-026 status (new IPC, ET-026c) | all 12 pass | some fail ("Hard Mode 10/12") | lost during the current trip | not evaluated (no profile read yet) |
| Dashboard sync | server phase | — | — | — | Later: dashed outline chip, hidden until sync exists |

Game mode text comes from the trip's game-mode evidence; while it is unknown, show only the game.

### Component mapping

| Spec element | shadcn component (in `apps/desktop/src/components/ui`) | Notes |
| --- | --- | --- |
| Card with title bar | `card` (exists) | Card radius 12 px (`rounded-xl`); title gets the left bar |
| Primary / secondary / danger button | `button` (exists) | Variants `default` (blue), `outline` (border `--yu-border-input`), `destructive` rendered as an outline in `--yu-err-fg` |
| Status chip and badge | `badge` (exists) | Add variants `ok`, `warn`, `error`, `neutral`, `ets2`, `ats`, `later` (dashed) |
| Segmented control | `tabs` (exists) or `toggle-group` (add) | Track `--yu-bg-input` with `--yu-border`; selected `--yu-accent` with white text |
| Table | `table` (exists) | Header `--yu-bg-inset`, 12 px muted; rows divided by `--yu-divider`; no zebra; numbers right-aligned |
| Switch, select, radio | `switch`, `select`, `radio-group` (exist) | Checked uses `--yu-accent` |
| Slider | `slider` (add) | Track `--yu-border`, range `--yu-accent-light` |
| Progress bar | `progress` (add) | 8 px high; fill `--yu-accent-light`, `--yu-ok-fg` when complete, `--yu-progress-pending` for low fuel or pending |
| Hard Mode parameter hints | `tooltip` | Each of the twelve parameter names: hover and keyboard focus; noninteractive, Escape dismissal |
| Hard Mode checklist drawer | `sheet` (installed Radix Dialog) | Right drawer, 470px maximum viewport width; modal focus trap, Escape and focus restoration |
| Language menu | `dropdown-menu` (add) | Panel `--yu-bg-card`, selected item `--yu-accent` with white text |
| Tooltips on icon-only items | `tooltip` (add) | Overlay icons have no tooltips (the overlay never takes the mouse while driving) |
| Charts | `chart` (add, Recharts) or plain SVG | Area under the line at 16% opacity, grid `--yu-divider`, last point emphasized |

## 5. Screens

### 5.1 Live (`live.*`)

The main screen while driving. It follows the owner-chosen variant B (instrument cluster), restyled.

| Spec id | Content | Data binding |
| --- | --- | --- |
| `live.waiting` | Shown only while waiting for a game: empty-state banner above the cards | `LiveTelemetry.status = 'waiting'`; all values show `—` |
| `live.instrument` | Hero tile (`--yu-tile-gradient`) holding the gauge, the gear and the fuel block | — |
| `live.instrument.gauge` | 260 px gauge: outer ring = speed (0–130 km/h or 0–80 mph, ticks every 10, labels every 20), inner arc = engine RPM, centre speed 54 px/800 with unit, RPM text below | `speed`, `engine-rpm` from telemetry-core's live view in the game's unit profile |
| `live.instrument.gear` | Gear block 64 px, stale or paused badge under it | `gear` (`N`, `1…n`, `R1…Rn`) |
| `live.instrument.fuel` | Vertical tank (fill `--yu-ok-fg`, below 30% `--yu-progress-pending`), fuel amount and capacity with %, range with "game's estimate", SDK average consumption with its note | `fuel`, `fuel-capacity`, `fuel-level`, `estimated-range`, `sdk-average-consumption` |
| `live.hardMode` | Hard Mode card: status chip (Active / Not active / Lost for this trip), "N of 12" with a progress bar, a two-column list of the 12 criteria with ✓/✕, hints attached to each parameter name on hover/keyboard focus, and View checklist opening the right drawer | ET-026 status IPC (ET-026c). When lost, an error badge says which setting changed, its value and the time |
| `live.job` | Current job: cargo and mass badge, market badge, deadline badge; a route progress line with a truck marker; origin city and company, driven, remaining with "planned …", expected income, destination city and company | `cargo`, `cargo-mass`, `market`, `deadline`, `source-city/company`, `destination-city/company`, `route-remaining`, `planned-distance`, `expected-income`; driven = observed distance of the open trip (ET-014). A field without data is hidden, not zero |
| `live.trip` | This trip: real time, game time, fuel used, recording completeness badge | Open trip from `AppState.health.recording` and the trip recorder |
| `live.truck` | Truck, plate, trailer(s), odometer | `truck`, `truck-plate`, `trailers`, `odometer` |
| `live.session` | Game clock (`Day N, HH:MM`), mode, protocol, lost events | `game-time`, `game-mode`, protocol, `event-loss` |

States: **Waiting**: banner and dashes. **Paused**: values stay current with a ◷ paused badge. **Stale or disconnected**: values greyed with a ✕ "stale 12 s" badge; never shown as current. **Incompatible**: error banner (see §6).

### 5.2 Hard Mode parameter hints and checklist (`hardMode.hint*`, `hardMode.sheet`)

Latest owner clarification, October 21, 2026: restore the mockup's 470px right checklist Sheet with View checklist and Check again, while retaining all twelve compact-card parameter-name hints. This supersedes the earlier no-drawer refinement. Use the accepted ET-029 selected-language EN/RU framework for every Hard Mode label, status, reason, source/age, notice and trip explanation; preserve SDK names and raw audit/cvar evidence.

| Spec id | Content |
| --- | --- |
| `hardMode.sheet` | Accessible 470px right drawer with title/count, twelve detected/required/state/reason rows, source/age, bounded Check again, retained first loss and read-only/persisted-setting notices |
| `hardMode.hint` | Noninteractive hint on name hover and keyboard focus: friendly/exact raw **Detected**, **Required**, state, a localized friendly reason and optional secondary cvar |
| `live.hardMode.criteria` | Twelve names with explicit pass/fail/unknown words and ✓/✕/? icons; visible keyboard focus |
| `live.hardMode.source` | Sanitized source category (Local / Steam Cloud / Synthetic or replay / Unproven) and observation age, readable in the card; no profile name, account or filesystem path crosses IPC |
| `live.hardMode.refresh` | **Check again**, bounded read-only refresh, loading/unavailable text in the card |
| `live.hardMode.notice` | Read-only/persisted-setting boundary and current settings versus trip qualification; first loss retains value/time even when all current rules pass |

Hints open on hover or focus, dismiss with Escape without moving focus, and contain no links or controls. Tab moves normally through the parameter names. The separate checklist drawer traps focus while open, closes on Escape and restores focus to View checklist. Selected-language changes update both hints and an already-open drawer without changing evidence or qualification.

The 12 criteria use the owner-approved observed persisted-setting matrix: realistic fuel `g_fuel_simulation = 1`; air brakes `g_hardcore_simulation = 1`; police `g_police = 1`; fatigue `g_fatigue = 1`; speed limiter `g_use_speed_limiter = 1`; truck stability `g_truck_stability ≤ 0.5`; trailer stability `g_trailer_stability ≤ 0.5`; configured skilled parking `g_simple_parking_doubles = 0` and `g_parking_difficulty = 2`; rain `g_bad_weather_factor ≥ 0.12`; road events `g_road_events ≥ 0.30`; braking intensity `g_brake_intensity ≤ 0.75`; traffic `g_traffic ≥ 1.0`. Display booleans as On/Off and fractions as percentages, retaining the exact raw value alongside. The evaluator owns comparisons and its `1e-6` tolerance. Manual completion additionally requires available `autoParkUsed == false` at delivery; actual Expert placement is not verified. Explain that unpersisted runtime settings/transient changes between observations are not detected. Unknown/failure/source switch/interruption irreversibly loses qualification, preserving the first lost value/time even when current settings recover.

### 5.3 Journal (`journal.*`)

| Spec id | Content | Data binding |
| --- | --- | --- |
| `journal.filters` | Segmented game filter (All, ETS2, ATS), outcome select, recording select, search field, trip count | `JournalTripsQuery` `game`, `outcome`, `completeness`. Search is a proposal: it needs a storage query that does not exist yet; omit it until then |
| `journal.table` | Columns: Started (local date and time), Game chip, Cargo (+ `HM` badge for Hard Mode trips), Route (cities, companies below), Distance (observed, "of planned" below), Revenue (revenue, or −penalty in error colour; "expected …" below), Outcome, Recording, Sync (Later), chevron | `JournalTripSummary`; Hard Mode from `is_hard_mode` (ET-026b); Sync from the server phase |
| `journal.pager` | "Page N · 50 trips per page · the journal does not update by itself", Previous / Next; **Refresh** in the top bar | Cursor paging as today (ET-016) |

Outcome badges: open → ◌ "In progress" (neutral); delivered → ✓ (ok); cancelled → ✕ (error); none → "No outcome" (neutral). The mockup also shows **Delivered late** (warn); that needs a defined lateness rule from stored data and is a proposal, not a current field. Recording badges: complete ✓ ok, partial ⚠ warn, unknown ◌ neutral. A row opens Trip details. Empty journal: see §6.

### 5.4 Trip details (`trip.*`)

| Spec id | Content | Data binding |
| --- | --- | --- |
| `trip.header` | Back to the journal, cargo as title, chips (game, outcome, recording, Hard Mode), route and companies and start time | `JournalTripDetail` |
| `trip.export` | **Export JSON** (secondary button) | `exportJournalTrip` (ET-016 PR-5) |
| `trip.tiles` | Four tiles: distance observed (hero gradient; "planned …" and "game reported …" below), revenue or penalty (teal; "expected …"), real time ("… game time"), fuel used ("from samples, refuels excluded") | Observed `observedDistanceM`, planned from the job, game-reported from the outcome record; money as exact text |
| `trip.detailTabs` | Segmented tabs **Summary** (speed chart from 1 Hz samples, gaps shaded warn, missing data hatched), **Timeline** (events with time, coloured dot, title, detail), **Completeness** (recorded vs gap bar and interval count) | Samples, `journalEvents`, `journalIntervals` |
| `trip.speedChart` | Area chart, grid `--yu-divider`, y ticks in the trip's unit, start time and duration on the x axis | `listSamples` |
| `trip.hardMode` | Qualifies / does not qualify, the evaluation at job start and at delivery, "Settings snapshot kept with the trip" | `is_hard_mode`, `hard_mode_details` (ET-026b) |
| `trip.money` | Fines, tolls, ferries and trains | Money totals of the trip detail; never netted or converted |

### 5.5 Settings (`settings.*`)

Settings move from the single long Live column to their own screen with a left sub-navigation (`settings.nav`, 200 px, same item style as the sidebar). Each panel is one card.

| Panel | Spec id | Rows |
| --- | --- | --- |
| General | `settings.general` | Interface language (segmented English / Русский); Start with Windows (switch, marked **Planned**: autostart is not authorized); Closing the window (read-only: hides to the tray) |
| Units | `settings.units` | One segmented control per game: Metric (km/h, L) / US customary (mph, gal); note that stored values never change |
| Overlay | `settings.overlay` | Show overlay (switch); `settings.overlay.layout`: four layout cards with thumbnails (Strip, Card, Cluster, Minimal); Sections ("N of M sections shown", button to the next panel); Scale and Background opacity sliders; `settings.overlay.edit`: **Move overlay** (primary), which starts layout-edit mode (ET-012b) |
| Overlay sections | `settings.sections` | `settings.sections.presets` (Everything, Job focus, Driving only) in the card header; `settings.sections.groups`: switches grouped Driving / Fuel / Job / Time / Status with requirement notes (`needs protocol v1`, `needs trip tracking`, `ids until v1`) from `OVERLAY_SECTION_REQUIREMENTS`; hint "A section without data stays hidden; it never shows zero." |
| Game plugin | `settings.plugin` | One row per game: path, status badge (`installed` ✓ / `outdated` ◷ / `missing` / `blocked` ✕), Reinstall, Open folder |
| Data and storage | `settings.data` | Database path, size and trip count, backup with "Create backup", diagnostics bundle |
| About | `settings.about` | Brand block `settings.about.brand` (logo 64 px, "Yukon Union Telemetry", "Telemetry · ETS2 · ATS"); version; Uninstall (danger outline) with the existing data-loss warning flow (ET-018) |

Settings save as today: a choice shows as selected only after main saved it; a refused save shows its message in the same card.

### 5.6 Account and sync (`account.*`, server phase)

Not part of the MVP; drawn so that the shell reserves its place and the dashboard work can align. The top of the screen carries a dashed "Server phase · not in this version" chip, and the sidebar group is marked **Later**. Do not ship non-functional controls: until the server phase, hide the screen and the sync chip and column.

| Spec id | Content |
| --- | --- |
| `account.token` | Masked token field with a show/hide button, **Save and connect**, note "Uploading is not acceptance: trips are reviewed on the dashboard." |
| `account.status` | Dashboard connection (Connected as … / offline), upload queue count, last upload |
| `account.firstSync` | First history upload progress "87 of 143 trips" |

### 5.7 First run (`onboarding.*`)

A full-window wizard without the sidebar. Left column (`onboarding.steps`, 300 px, chrome colour): lockup, title, four steps with number circles (current = accent, done = ok check). Right column (`onboarding.step`): "Step N of 4", step title, content, Back and Next (Start on the last step).

1. **Find games**: list of discovered installations; "Game not found" with **Choose folder** (existing manual-folder flow, ET-017).
2. **Install plugin**: both games "Ready to install", **Install plugin**; the existing rules hold (only while the game is closed, hash-verified, never overwriting an unrecognized file).
3. **Language and units**: the same controls as Settings.
4. **Overlay**: the four layout cards.

## 6. Empty and error states (`states.*`)

Each state is an icon in a 52 px rounded square (error and warning states tint it), a 16 px/700 title, one sentence that says what to do, and at most one action.

| Spec id | When | Action |
| --- | --- | --- |
| `states.gameNotFound` | Discovery found no ETS2 or ATS | Choose folder |
| `states.pluginMissing` | A discovered game has no plugin | Install plugin |
| `states.waiting` | No game connected (also `live.waiting`) | — |
| `states.connectionLost` | `stale` or `disconnected` | — (values greyed; the gap is recorded) |
| `states.versionMismatch` | `incompatible` or plugin `outdated` | — (close the game to update) |
| `states.recordingStopped` | Recording `stopped` | Open folder |
| `states.journalEmpty` | No trips (filters: use the existing "No trips match these filters") | — |
| `states.noToken` | Server phase: no token | Add token |
| `states.offline` | Server phase: no network, trips queued | — |
| `states.firstSync` | Server phase: first history upload running | progress bar |

## 7. Overlay (`overlay.*`)

The overlay keeps its own minimal stylesheet with the `--yu-ov-*` tokens: panel `rgba(11,17,32,.80)` (the opacity setting scales the alpha), border `rgba(55,65,81,.9)`, text `#F3F4F6`, icons muted, accent `#60A5FA`, fuel `#8FD3AE`, low fuel `#E8C58A`, problems `#F3B4A4`. Onest is bundled into the overlay as well. No backdrop blur. Values use tabular figures.

| Spec id | Layout | Default anchor |
| --- | --- | --- |
| `overlay.strip` | One 38 px row with icons instead of labels; groups separated by thin dividers; speed 22 px/800, gear in a blue-outlined chip, mini bars for RPM and fuel | Top centre (clear of the in-game route advisor at the bottom right) |
| `overlay.card` | 310 px card: speed 48 px with gear chip and RPM, fuel bar, job block, game time and Hard Mode row | Top right |
| `overlay.cluster` | Round gauge (speed ring `#60A5FA`, RPM arc `#2563EB`, gear) and a side panel for the other sections | Bottom left |
| `overlay.hud` | Text only with a strong shadow, no panel | Top left |

Behaviour is unchanged from ET-012a/b: sections come from `overlay.sections` and the layout from `overlay.layout`; a section without data is hidden; stale values are greyed with a "No signal 12 s" tag; paused shows a "Paused" tag; while no game is connected the overlay is hidden. Layout-edit mode draws a 2 px dashed `--yu-ov-edit` outline, a drag handle and an edit bar with Reset and Done.

**Proposed new section `hard-mode`** (group **Status**): the `Flame` icon with `HM` (ok colour) or `HM N/12` (problem colour). Adding it requires extending `OVERLAY_SECTION_IDS`, the settings migration and the presets (Everything and Job focus include it) in the ET-026c package.

## 8. Localization

English is the canonical UI language today (`apps/desktop/src/strings.ts`). The mockup adds a Russian translation for review. The application has no localization framework yet, so a Russian UI is its own package: a language setting, a dictionary per language with the same keys, and a check that every key exists in every language (the mockup's harness performs exactly that check). Rules:

- Translate application text only. Game data (cargo, cities, companies, trailer names) arrives already localized by the game and is never translated.
- Units are translated (`км/ч`, `л`, `миль/ч`); currency codes and money digits are not.
- Russian strings are about 20–30% longer. Layouts must wrap or truncate with a tooltip, never clip; check both languages at the minimum window size.
- Dates use the language's month names (`Oct 15, 09:14` / `15 окт, 09:14`); game time uses "Day N" / "День N".

## 9. Accessibility

- Sidebar items and tabs are real buttons with `aria-current` or `aria-selected`; icon-only buttons have `aria-label`.
- Focus ring: 2 px `--yu-accent-light` with a 2 px offset on every interactive element.
- Status is never colour alone (icon and word).
- Gauges and charts have an accessible name; their numbers also appear as text.
- Minimum interactive size 32 px; contrast at least 4.5:1. Measured WCAG ratios of the token pairs on their surfaces: muted text on a card 5.78, on the work area 6.99, on the table header 6.22; white on the accent 5.17; status texts on their backgrounds 9.15 (ok) to 10.96 (neutral); game chips 9.08 (ATS) and 9.60 (ETS2). Re-check any new pair.

## 10. Suggested implementation order

These are suggestions for future cards; none is authorized by this document.

1. **UI foundation**: tokens in index.css, Onest, badge variants, title bar overlay, the shell (sidebar, top bar, recording box) and screen routing. Move the current cards into the new screens without changing behaviour.
2. **Live** restyle (variant B) on the existing live view.
3. **Journal and Trip details** restyle on the existing ET-016 reads.
4. **Settings** screen with sub-navigation (moves the existing units, overlay, plugin, uninstall and diagnostics cards).
5. **ET-026c**: Hard Mode card, parameter hints, journal badge and the optional overlay section, after ET-026a/b.
6. **Russian UI**: localization framework and the Russian dictionary.
7. **First run** wizard.
8. **Account and sync**: only with the server phase (ET-101 and later).

## 11. Open points for the owner

- Window title and brand: the mockup uses "Yukon Union Telemetry"; the installer, tray and repository name still say ETS2Telemetry.
- Small logo sizes: resolved on October 21, 2026 by the application icon in §3 (a filled silhouette with the mouth and eye cut out).
- Review the Russian translation.
- Start with Windows: needs an explicit authorization (autostart is currently out of scope).
- The overlay `hard-mode` section and the "Delivered late" outcome display are proposals.
- Journal search needs a new storage query.


## ET-028 implementation mapping and accepted read-boundary limits — October 21, 2026

The renderer implements the approved dark Yukon shell and local screen routing. Main window geometry is 1280×800, minimum 1100×720, with a 32px native title-bar overlay; only the title strip drags. The 220px sidebar, persistent status chips and 200px Settings navigation use the canonical tokens and unchanged bear. Both renderers bundle Onest 5.3.1 independently. Existing package/shortcut/data identities and small Windows/tray icons remain unchanged.

| Reference region | Implemented binding / deliberate limit |
| --- | --- |
| Live instrument / job | Normalized current v0 numbers drive geometry; independently fresh matching v1 supplies job names. Job spans the row below instrument/Hard Mode. Full existing field set and provenance remain below. |
| Live trip / route progress | RecordingHealth exposes no observed trip distance, fuel or duration. These are explicitly unavailable; no demo totals or progress are substituted. |
| Journal table | Started, game chip, cargo/HM, route, observed/planned distance, expected income versus unavailable actual revenue, outcome, completeness, Sync Later and fuel remain reachable in a bounded horizontal table. No per-row detail queries. |
| Trip header / four tiles | One detail query supplies cargo/route/companies/start/chips, observed/planned/game-reported distances, exact outcome money and fuel. Missing hero values use a dash plus a small reason; money keeps exact raw digits/currency with a separate basis note. Aggregate real/game durations are unavailable. |
| Trip chart | Summary and Samples read only the currently mounted page (≤300). Independent source-monotonic elapsed axes per segment; UTC labels only. No line crosses unavailable speed, missing seconds, changed clock or non-increasing time. Raw paged tables remain. |
| Settings | General/Units segmented controls; four Overlay thumbnail cards; existing read-only/committed-save authority, fourteen sections, last-enabled guard and position editing. Unsupported show/opacity/autostart/backup are Planned, version/statistics unavailable. Source selection/raw diagnostic details live in Data. |
| Account / first run | Informational Later screen and General help only. No credential, sync, onboarding or autostart backend/control is invented. This owner-approved placeholder supersedes the reference's hidden-until-server-phase suggestion. |
| Overlay | Independent transparent CSS with yu-ov tokens and Onest. Card hierarchy shares the existing reserved 24px rows; speed/gear/RPM subsets never manufacture disabled fields. The cluster's validated numeric RPM fraction draws an inner arc. The existing renderer bridge has formatted speed only, so its outer track is decorative, with no invented speed progress or IPC extension. |

App-owned EN/RU labels and numeric unit labels are localized; raw SDK names, money digits/currency codes, protocol/audit enums and cvars remain unchanged. All twelve Hard Mode hints/drawer rows, observation boundaries and irreversible first loss remain governed by ET-026; this task changes presentation only.

Spec IDs use compatible existing IDs where established (`hard-mode-*`, `journal-*`, `overlay-*`) plus `shell.*`, `settings.*`, `live.instrument*`, `trip.header`, `trip.tiles`, `trip.chart` and `trip.hardMode`. Native caption behavior, actual Windows 100%/150% scaling, game overlay input/focus/z-order and performance require manual evidence; viewport screenshots do not establish them.

ET-028 Live compaction keeps all twelve actual parameter names with state icons and complete accessible rule/state labels, hover/keyboard hints, source/age and both actions. The grid uses two columns below a 360px card width, three only above that threshold, with wrapping and ≥32px targets. A short saved-settings limitation stays visible; full observation/manual-parking/qualification caveats remain in the accessible 470px drawer. Current Live screenshot checks require the Job heading and both route endpoints fully inside the content viewport without scrolling, and separately reject overflowing parameter labels.
