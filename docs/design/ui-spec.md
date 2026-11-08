# Desktop UI specification (Yukon Union style)

Status: design target, October 19, 2026. This document and [the mockup](mockup.html) describe the final look of the desktop application and its overlay. They do not change product requirements, contracts or acceptance criteria, and they do not authorize implementation. Each implementing package needs its own card and follows [the agent rules](../agent-rules.md).

The owner asked for a final mockup that matches the Yukon Union community dashboard, adds the Hard Mode status from [ET-026](https://trello.com/c/Cl5oNGTw), and can be implemented by agents. The owner chose: files in the repository, English with a Russian variant, the "Yukon Union Telemetry" brand, and screens for account and sync, first run, and empty and error states besides Live, Journal, Trip details, Settings, Hard Mode and the overlay.

## 1. How to use this folder

| File | Role |
| --- | --- |
| [ui-spec.md](ui-spec.md) | This document: rules, components, screens, data bindings and states. **Authoritative for behaviour and structure.** |
| [tokens.css](tokens.css) | Colours, type, shapes and the shadcn variable mapping. **Authoritative for values.** |
| [mockup.html](mockup.html) | Interactive reference: open it in a browser. Controls switch screen, language, game, connection, Hard Mode result and an **Inspect** view that labels every region with its spec id. Authoritative for layout and proportions only. |
| [assets/logo.png](assets/logo.png) | The application logo (bear head), white line art on a transparent background, 1024 × 1024 PNG. Rules in [§3 Logo](#3-tokens-type-and-icons). |
| [assets/app-icon.png](assets/app-icon.png) | A 256 px preview of the application icon (the "road merge" mark). Rules in [§3 Application icon](#3-tokens-type-and-icons). |

Precedence: docs/agent-rules.md and docs/CONCEPT.md (product and data rules) → this spec → tokens.css → the mockup's pixels. If the mockup and this spec disagree, follow this spec and report the difference.

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
3. **Unavailable is not zero.** A missing value shows `—` (or is hidden where the rules say so), never `0`. A value that stops updating becomes unavailable: on Live a stale stream shows dashes dimmed to the muted colour and a stale badge, never frozen numbers.
4. **Keep the data distinctions.** Planned, observed and game-reported distance; expected income and revenue or penalty; real time and game time; job outcome and recording completeness. Each pair is shown side by side and labelled, never merged.
5. **Name the SDK values honestly.** Average consumption is labelled "SDK mean, not a trip average" (ATS: "mostly static"). Range is "the game's estimate". Money is exact raw digits with the currency code, without grouping or symbols (`48210 EUR`).
6. **Dark only.** There is no light theme. `color-scheme: dark` is set on `:root`.
7. **Desktop density.** One step denser than the web dashboard: body 13 px, controls 32 px, status chips 24 px. Interactive targets are at least 32 px (a 24 px chip that is a button extends its hit area to 32 px); text contrast is at least 4.5:1.

## 3. Tokens, type and icons

Values are in [tokens.css](tokens.css). Summary:

| Use | Token | Value |
| --- | --- | --- |
| Work area | `--yu-bg-app` | `#0E1525` |
| Title bar, sidebar, top bar | `--yu-bg-chrome` | `#0A101D` |
| Cards, menus | `--yu-bg-card` | `#121A29` |
| Selected segment, inline tags, route track | `--yu-bg-raised` | `#1E293B` |
| Active sidebar item | `--yu-nav-active-bg` | `#182238` |
| Table header, nested blocks | `--yu-bg-inset` | `#1A2332` |
| Card border / input border / row divider / chrome edge | `--yu-border` / `--yu-border-input` / `--yu-divider` / `--yu-divider-chrome` | `#1E2A40` / `#4B5563` / `#1A2335` / `#1C2638` |
| Text strong / text / secondary / muted | `--yu-text-strong` / `--yu-text` / `--yu-text-secondary` / `--yu-text-muted` | `#F8FAFC` / `#E2E8F0` / `#A3B1C6` / `#8492A8` |
| Non-text only (inactive nav icons, gauge ticks, separators) | `--yu-text-subtle` | `#64748B` (3:1; never for text) |
| Accent (buttons, selection, active nav) | `--yu-accent` | `#2563EB`, white text |
| Accent light (focus ring, progress, gauge arc, links) | `--yu-accent-light` | `#60A5FA` |
| Status ok / warn / error / neutral | `--yu-ok-*` / `--yu-warn-*` / `--yu-err-*` / `--yu-neutral-*` | `#34D399`, `#FBBF24`, `#FCA5A5` on 10% tints with 30% borders; neutral `#A3B1C6` on `#151D2C` (tokens.css) |
| Game chips | `--yu-ets2-*` (sky) / `--yu-ats-*` (violet) | see tokens.css |
| Metric tile highlight | `--yu-tile-gradient`, `--yu-tile-border` | blue; `--yu-tile-teal-*` for money |
| Live instrument | `--yu-instrument-gradient`, `--yu-gear-bg`, `--yu-gear-border` | `#13203A` to `#121A29`; gear box `#10203D` with a `#2F5BC4` border |

The compact mockup (T1) uses `#64748B` for muted text, which measures 3.66:1 on a card. Muted text uses `#8492A8` instead, which keeps 4.5:1 on every surface (§9); `#64748B` is `--yu-text-subtle` and only colours non-text marks.

**Wiring.** Replace the neutral `:root` and `.dark` colour blocks in `apps/desktop/src/index.css` with the shadcn mapping block from tokens.css, and add the `--yu-*` block. Do not add a `.dark` class switch. The overlay's own stylesheet (`apps/desktop/src/renderer.css`) imports only the `--yu-ov-*` block; it never loads `index.css` or the shadcn base styles.

**Type.** Huninn is bundled with pinned `@fontsource/huninn` 5.3.1. Both renderers load local Latin, Latin Extended and Cyrillic subsets of the Regular (400) face through `fonts.css`. Existing CSS weights remain unchanged; the browser matches Medium (500) to Regular and synthesizes Bold (700), as in the approved preview. Body text uses 400, labels and displayed values use 500, and headings use 700; controls previously using 600 use 500. Text uses grayscale antialiasing across the application to avoid coloured subpixel fringes on Windows. Never load Google Fonts at runtime; the application must work offline. Use `font-variant-numeric: tabular-nums` for every number column, metric and live value. Scale: page title 18 px/700 at the top of the content, card title 15 px/700 (13 px/700 on the compact Live cards), body 13 px, sidebar item 13 px, recording status label 12 px/500, meta 12 px, sidebar group label 11 px/500 uppercase with 0.5 px tracking, metric 28 px/500.

**Signature detail.** Every card title has a 3 px `--yu-accent` bar on its left and a 10 px text indent (`border-left: 3px solid; padding-left: 10px`). The compact Live cards use a 13 px header row with a bottom line instead.

**Shapes.** Cards 8 px radius, buttons, inputs and chips 6 px, badges 6 px, inline tags 4 px. Card padding 14–16 px; gaps between Live blocks 12 px.

**Logo.** `assets/logo.png`, chosen by the owner on October 19, 2026; it replaces the earlier community emblem everywhere in this design.
- It is white line art on a transparent background, so place it only on the dark surfaces (`--yu-bg-chrome`, `--yu-bg-app`, `--yu-bg-card`). Never put it on a light, accent or status-coloured plate.
- Use it unchanged: no recolouring, cropping, rotation, outlines, shadows or glow, and keep its proportions.
- Keep clear space of at least 1/8 of its size on every side.
- Minimum size 20 px. Below that the outline fades into grey, so the tray, taskbar, desktop shortcut and installer use the application icon below instead.
- Sizes in this design: 28 px in the sidebar lockup, 40 px in the first-run lockup, 64 px in Settings → About. The title bar has no logo.
- Next to the product name it is decorative (`alt=""`); alone, its alt text is "Yukon Union Telemetry".
- Bundle the file with the application (no remote URL). Generate the Windows `.ico` sizes from the 1024 px master.

**Application icon.** Chosen by the owner on October 22, 2026 for the taskbar, the desktop shortcut and the notification area, because the bear did not read at small sizes. It is a separate mark: the bear stays the logo inside the application, and the logo rules above do not apply to the icon. `scripts/generate-app-icons.mjs` draws it; rerun it and commit the outputs whenever the design changes.
- **Road merge.** Two roads join into one and form a Y: Yukon, and the union of drivers. The roads are white `#F8FAFC` with an amber `#FFB300` centre line, on a rounded tile with a `--yu-accent`-to-`--yu-bg-chrome` ("twilight") gradient.
- **48 px and above: liquid glass.** Blurred cyan and violet aurora light glows behind the tile and is refracted through frosted, translucent roads with lit edges. The centre line is dashed and glows, a soft shadow lies under the roads, and the tile has a top gloss and a white rim lit from the top left.
- **Below 48 px and in the tray: the small mark.** The glass turns to noise, so the roads are solid and wider, the centre line is a solid amber line and only the rim remains.
- `resources/icon/app.ico` (16–256 px) is embedded in the executable and is the Setup icon, so the taskbar, shortcuts and windows show it. Squirrel's Update.exe keeps its vendored icon.
- **Staging.** The staging channel's icon, `resources/staging/icon/app.ico`, is the same mark with an amber `#FFB300` flag across the upper right corner and a dark edge, chosen by the owner on October 29, 2026 so that the two installed applications can be told apart; the tray icon carries the same flag, and its status dot is unchanged.
- The notification-area icon is the small mark with a status dot in the lower right corner: green `#34D399` ready, amber `#F59E0B` starting, restarting or exiting, red `#EF4444` failed. The tray tooltip states the status in words, so the dot is never the only signal. Green is `--yu-online`; amber and red are icon-only values with no token, defined by the generator and `TRAY_TONE_RGB` in `apps/desktop/src/tray-icon.ts`, which a unit test keeps equal.

**Icons.** `lucide-react` (already a dependency) with `strokeWidth={1.8}`, round caps and joins. Sizes: 12–14 px inside chips, badges and small buttons, 16 px default and in the sidebar, 22 px in the waiting banner, 28 px in empty states. Icon names used:

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
| Next mandatory break (ET-052) | `Coffee` beside the row label; its urgency badge pairs `Hourglass` (soon, warn tone) or `TriangleAlert` (due, error tone) with a word |
| Connection lost, paused | `WifiOff`, `Pause` |
| Folder, export, refresh, exit | `FolderOpen`, `Download`, `RefreshCw`, `Power` |

## 4. Application shell

Design canvas 1280 × 800; minimum window 1100 × 720. Layout: title bar (32 px), then a row of sidebar (216 px) and main column (top bar 48 px plus scrolling content with 16 px 20 px 24 px padding). The content starts with the page header: the screen title 18 px/700 (`screen-title`, focused on every route change) and, on Live, a 12 px subline.

| Spec id | What | Implementation |
| --- | --- | --- |
| `shell.titlebar` | Window title bar, `#0A101D`, "Yukon Union Telemetry" 12 px `--yu-text-secondary`; no logo | Electron `titleBarStyle: 'hidden'` with `titleBarOverlay: {color: '#0A101D', symbolColor: '#94A3B8', height: 32}`; native caption buttons stay. Closing still hides to the tray (ET-011). |
| `shell.sidebar` | Navigation column, 216 px, `#0A101D`, right border `#1C2638`, padding 12 px 10 px, sections 14 px apart | A plain `nav`; items are buttons with `aria-current="page"` when active |
| `shell.sidebar.lockup` | Logo 28 px, "Yukon Union" 14 px/700, "Telemetry · ETS2 · ATS" 11 px muted | The logo is decorative here (`alt=""`); follow the logo rules in §3 |
| `shell.sidebar.nav` | Groups: **Drive** (Live, Hard Mode, Journal), **Application** (Settings), **Company** (Account & sync; always discoverable). Group labels 11 px/500 uppercase muted | Items at least 32 px, padding 5 px 8 px, radius 6 px, 16 px icon; the label wraps to a second line and is never cut off or ellipsized. Active item: `--yu-nav-active-bg`, `--yu-text-strong`, `--yu-accent-light` icon; others `--yu-text-secondary` with a `--yu-text-subtle` icon (`shell/sidebar-nav.tsx`) |
| `shell.sidebar.recording` | Recording indicator at the bottom, a 32 px ghost row: an 8 px dot, a one- or two-word label, a Test badge for a synthetic or replay database, and an info icon (lucide `Info`, muted, brighter on hover) that shows a tooltip exists. Dot colours: `--yu-dot-ok` recording; `--yu-dot-warn` paused, waiting, opening; `--yu-dot-err` interrupted, retrying, stopped; `--yu-dot-neutral` otherwise. A ring spreads from the dot while the recorder is active (2.4 s recording or waiting, 1.6 s opening, 1.2 s interrupted or retrying), a paused dot breathes, and every other state stays still. The dot animates only while the window has focus; reduced motion stops both | Bound to `AppState.health.recording` (`RecordingHealth`); label from `RECORDING_STATE_LABEL_TEXT`, colour from `recordingTone`, animation from `recordingMotion`. A focusable button opens a shadcn `tooltip` on hover and keyboard focus, to the right: the Recording row's headline, detail, alert and loss lines. The tray keeps `RECORDING_STATE_SHORT_TEXT` |
| `shell.sidebar.update` | Update control directly below the recording indicator (ET-055 UP10), a 32 px ghost row with `#93C5FD` text. Hidden while the update is idle, checking or unsupported. A native `button` (Tab, Enter, Space, visible focus ring) with lucide `ArrowUpCircle` (offer, refusal) or `RefreshCw` (busy, ready, failure) and a 7 px `--yu-accent-light` dot at the right end while an update can be installed or finished; the dot pulses only while the window has focus and never under reduced motion, and the busy icon turns under the same rule. Texts: available "Update to 0.2.0" / "Обновить до 0.2.0", accessible name "Update to 0.2.0: download and install the available update" / "Обновить до 0.2.0: скачать и установить доступное обновление", which begins with the visible label (WCAG 2.5.3 Label in Name); downloading "Downloading… 42%" / "Загрузка… 42%" with a 4 px `role="progressbar"` (`aria-valuenow`) under it; installing "Installing…" / "Установка…"; restarting "Restarting…" / "Перезапуск…"; ready "Restart to finish" / "Перезапустить для завершения"; refused "Close the game to update" / "Закройте игру, чтобы обновить", "Could not check running games" / "Не удалось проверить запущенные игры", "Another task is running – Retry" / "Выполняется другая задача – Повторить", "The app is closing" / "Программа закрывается" (warn tone, still enabled); failed "Update failed – Retry" / "Не удалось обновить – Повторить" (error tone) with a tooltip and description of fixed text per failure code | Bound to `AppState.update` (`UpdateView`); words from `updateControlText` (`update-control-text.ts`). A click calls `updateApplication()`; while downloading, installing or restarting the button is `aria-disabled` and keeps focus. A persistent polite `role="status"` region announces the offer and each phase (never each percentage); a failure is announced once as `role="alert"`. The tooltip wrapper stays mounted while the button is shown, so the button keeps focus across `failed`. Known limits: a repeated identical refusal (the same words again) is not re-announced, because the live region text does not change; and when About's manual check finds an update, the sidebar region and About's result both announce it |
| `shell.sidebar.version` | Version line under the update control (ET-055 UP11): "Version 0.1.1" / "Версия 0.1.1", 11 px muted, tabular numbers; an unpackaged run shows "Development build" / "Сборка для разработки"; a staging build adds a warn-toned "Staging" badge in both languages | Bound to `AppState.application`; words from `versionLineText`. The visible words are `aria-hidden` and one accessible sentence replaces them: "Version 0.2.0-stg.000042, staging build" / "Версия 0.2.0-stg.000042, тестовая сборка (staging)". Main's fallback version `0.0.0` reads "Version unknown" / "Версия неизвестна" |
| `exit-application` | Exit at the bottom: an outline button with `--yu-divider-chrome` border on `--yu-bg-app`, `Power` icon; the language is chosen in Settings > General | Exit calls `exitApplication()` (explicit full exit); its tooltip and description say that closing the window keeps the app in the tray |
| `shell.topbar` | 48 px, padding 8 px 16 px, wraps: breadcrumbs on the left, status chips on the right | `shell/top-bar.tsx` |
| `shell.breadcrumb` | Group / page, for example "Drive / Live" ("Вождение / Сейчас"); the current page is `aria-current="page"`, the separator is decorative | `nav` named "You are here" ("Где вы") |
| `shell.status` | Chips in this order: game connection, plugin, Hard Mode, site sync (configured origins only). 24 px, radius 6 px, 12 px/500, 0 8 px padding, 13 px icon; the game chip has a 6 px dot | A `role="group"` named "Status" ("Состояние"), not a live region. See the table below |

Top-bar status chips:

| Chip | Source | ok | warn | error | neutral |
| --- | --- | --- | --- | --- | --- |
| Game connection | `LiveTelemetry.status` | `connected`: "ETS2 · Single-player", or "ETS2 · Connected" without a known mode | `paused`: "ETS2 paused" | `stale`, `disconnected`: "ETS2 · No current data" / "ETS2 · Disconnected" (never an age); `incompatible`, `service-failed`: the status word | `waiting`: "Waiting for the game"; `unavailable`, `restarting`: the status word |
| Plugin | `AppState.plugins` targets (`PluginTargetState`) | all discovered games `installed` ("Plugin 2/2") | any `outdated`, `working` | any `blocked` | `missing`, `excluded` only |
| Hard Mode | ET-026 status (ET-026c) | all 12 pass ("Hard Mode 12/12") | some fail ("Hard Mode 10/12") | lost during the current trip ("Hard Mode lost") | not evaluated ("Hard Mode unknown") |
| Site sync | Validated upload status DTO, configured origins only | Durable upload progress / sent | Offline, backoff, identity pending or queue pressure | Authentication required or reconciliation hold | Hidden when the deployment origin is unset |

"Plugin n/m" counts the installed targets of the games that are not excluded; while not all are installed the state words follow ("Plugin 1/2 · Blocked"). The game mode comes from the current v1 mode evidence: TruckersMP only with strong evidence, single-player with strong evidence or the ordinary weak module scan; otherwise only the game and the connection word are shown.

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
| Hard Mode page | `card`, `button`, `tooltip` | Inline evidence and caveats; ordinary page scroll, no drawer (ET-047) |
| Language menu | `dropdown-menu` (add) | Panel `--yu-bg-card`, selected item `--yu-accent` with white text |
| Tooltips on icon-only items | `tooltip` (add) | Overlay icons have no tooltips (the overlay never takes the mouse while driving) |
| Charts | `chart` (add, Recharts) or plain SVG | Area under the line at 16% opacity, grid `--yu-divider`, last point emphasized |

## 5. Screens

### 5.1 Live (`live.*`)

The main screen while driving. It follows the owner-chosen variant B (instrument cluster), restyled.

Owner-requested amendment, October 22, 2026 (ET-012e): the central speed number and its accessible description use integer km/h or mph after unit conversion. Show the number and unit once in the gauge; remove the duplicate speed paragraph below it. Preserve the full-precision numeric gauge ratio, existing fuel decimals and journal/export precision.

| Spec id | Content | Data binding |
| --- | --- | --- |
| `live.sub` | Page subline under the title: "Real-time game data · ETS2, values are current" / "game paused, values are current" / "game connection is incomplete" / "values are out of date and dimmed · <reason>" / "game not connected"; no update-rate claim | The Live state; the stale reason reads "no new data from the game" for the expiry reasons |
| `live.waiting` | Banner above the instrument with a 44 px icon tile: "Waiting for the game" and what to do, or the status word and the connection text; also in the partial state, titled "Connection incomplete" ("Подключение неполное") with the text "Game connection is incomplete…", and beside an incompatible v1 source, where it names the mismatch; never for stale | `LiveTelemetry.status`, `gameConnectionText`; values show `—` except those of a current stream in the partial state |
| `live.instrument` | Full-width card on `--yu-instrument-gradient` with a `--yu-border` line: gauge, gear and fuel wrap in one row (gaps 16 px 28 px, padding 14 px 18 px) under a visually hidden "Instruments" heading | — |
| `live.instrument.gauge` | 260 px gauge, geometry unchanged: outer ring = speed on the shared `speedGaugeFraction` scale (0–130 km/h or 0–80 mph, 256°, ticks every 10, labels every 20), inner arc = engine RPM, centre speed 48 px/500 with unit, RPM text in the bottom gap; tick lines `--yu-text-subtle`, labels muted | `speed`, `engine-rpm` from telemetry-core's live view in the game's unit profile |
| `live.instrument.gear` | A 120 px column: "Gear", the 46 px/500 gear box (`--yu-gear-bg`, `--yu-gear-border`), and under it the paused badge or the stale badge `live.stale` (`WifiOff` and the status word) | `gear` (`N`, `1…n`, `R1…Rn`); in the displayed game's manual gear display mode (ET-050) `1L`, `1H`, `2L`, `2H`… with the same `N` and `R1…Rn`; since ET-050b the labels follow the truck's SDK H-shifter layout while it is current for the same truck (for example `LL`, `LH`, `1L`…`8H`), otherwise that pattern |
| `live.instrument.fuel` | 22 × 150 px tank (fill `--yu-ok-fg`, below 30% `--yu-progress-pending`), "Fuel: 73.0 L" with "of <capacity> · <level>", range with "game's estimate", SDK average consumption with its note | `fuel`, `fuel-capacity`, `fuel-level`, `estimated-range`, `sdk-average-consumption` |
| `hardMode.screen` | Dedicated Hard Mode page (ET-047), replacing the former Live card: status chip (Active / Not active / Lost for this trip), "N of 12" with a progress bar, a two-column list of the 12 criteria with ✓/✕, hints attached to each parameter name on hover/keyboard focus, and all detected/required/state/reason/cvar details inline | ET-026 status IPC (ET-026c). When lost, an error badge says which setting changed, its value and the time |
| `live.job` | Current job: a header row with tags (cargo · mass, market, deadline), each only when its field has a value; origin city and company, a plain 6 px route line without a progress fill or truck marker, destination city and company; Remaining with "planned …", Expected income and, while v1 carries it, the next mandatory break with its badge (`live.job.break.badge`). Without a job: "No active job. The fields appear when the game reports a job." or the job's unavailable reason | `cargo`, `cargo-mass`, `market`, `deadline`, `source-city/company`, `destination-city/company`, `route-remaining`, `planned-distance`, `expected-income`, `mandatory-break`. Observed distance and route progress are not shown: the renderer has no observed trip distance |
| `live.trip` | This trip: the recording completeness badge (Complete ok, Partial warn, Unknown neutral), `—` without an open trip; no real time, game time or fuel used rows | `AppState.health.recording.trip.completeness` |
| `live.truck` | Truck, plate, trailer(s), odometer | `truck`, `truck-plate`, `trailers`, `odometer` |
| `live.session` | Game clock (`Day N, HH:MM`), mode (Single-player or TruckersMP, by the rule in §4), protocol ("v0", "v0 + v1", or "v1" while only v1 is carried), lost events; mode and lost events only while v1 is carried | `game-time`, v1 game-mode evidence, the carried protocols, `event-loss` |
| `live.details` row `live-mandatory-break` (ET-052) | In the Time section after the delivery deadline: `Coffee` icon and the label "Next mandatory break" (RU "До обязательного перерыва") with the note "game time", the value `H h M min` (RU `H ч M мин`) clamped at `0 min`, and for a current soon (1 to 119 min) or due (0 or less) value a badge `live-mandatory-break-badge`: warn tone, `Hourglass` and "Soon" ("Скоро"), or error tone, `TriangleAlert` and "Break due" ("Пора"); a normal value (120 min or more) has no badge. The badge is `role="img"` named "<label>: <word>"; the icon is decorative and the colour never carries the meaning alone. Not observed, not supported or invalid reads "unavailable" with its reason; a stale v1 source reads "unavailable (not current)"; hidden without a carried v1 source. The overlay section follows in a later package | `mandatory-break` (v1 minor 2 `state.nextMandatoryBreak`), live only, never recorded (D4) |

The cards This trip, Truck and Game session share one wrapping row (each at least 260 px); the field list `live.details` stays collapsed at the bottom. The Live column is at most 1100 px wide.

States (`data-live-state` on `live-telemetry`): **Connected**: current values. **Paused**: values stay current with the paused badge. **Partial**: one telemetry stream is current and the other is not, in either direction (the rule of `gameConnectionText`; an incompatible v1 source is not partial: current v0 data stays connected and the banner names the mismatch): the waiting banner titled "Connection incomplete" with "Game connection is incomplete…", the current stream's values shown normally and the other stream's as dashes; no stale badge and no dimming. **Stale** (`stale` or `disconnected` with no current stream): values become dimmed dashes with the stale badge in the instrument, never shown as current; no waiting banner. Dimmed means the value text in the strong and body colours turns `--yu-text-muted` (no opacity): the speed number, the gear, the fuel amount, range and consumption values, the job metrics, the route cities and the card values except the recording badge. Labels, notes, info hints, badges and values already in the secondary or muted colour (the RPM caption, the route companies, the fuel capacity line) are unchanged. **Waiting** (every other status): banner and dashes. **Incompatible**: the waiting banner with the version text (see §6).

### 5.2 Hard Mode page and supplementary hints (`hardMode.screen`, `hardMode.hint*`)

Owner decision, October 23, 2026 (ET-047): Hard Mode is a dedicated Drive destination between Live and Journal. This supersedes the October 21 drawer requirement. The Live instrument spans the available content width. Keep the global top-bar Hard Mode status on every route.

The full page shows a summary with status, N/12, progress, source/observation age and Check again, followed by twelve inline detected/required/state/reason/cvar entries and persisted/read-only/manual-delivery caveats. Retain first-loss value/time even after settings recover. No View checklist trigger or Hard Mode drawer remains. Use two columns when the card is wider than 680px, otherwise one, with normal page scrolling and wrapping. Reuse Yukon tokens, offline Huninn and lucide Flame; status includes text/icons as well as color.

The existing parameter hints remain optional supplementary information: hover/focus, Escape dismissal, normal Tab order. Essential evidence and explanations are always inline. Changing language updates the page without changing evidence. The dashboard-lifetime controller remains shared with the shell; navigating or refreshing cannot restore trip qualification. Focus moves to the screen heading after route changes. Keep EN/RU parity, keyboard operation and visible focus. Validate minimum/wide desktop widths; renderer emulation does not establish native Windows DPI acceptance.

### 5.3 Journal (`journal.*`)

| Spec id | Content | Data binding |
| --- | --- | --- |
| `journal.filters` | Segmented game filter (All, ETS2, ATS), outcome select, recording select, search field, trip count | `JournalTripsQuery` `game`, `outcome`, `completeness`. Search is a proposal: it needs a storage query that does not exist yet; omit it until then |
| `journal.table` | Columns: Started (local date and time), Game chip, Cargo (+ `HM` badge for Hard Mode trips; a job market badge below, with `Special transport` for a special job), Route (cities, companies below), Distance (observed, "of planned" below), Revenue (revenue, or −penalty in error colour; "expected …" below), Outcome, Recording, optional Sync, chevron | `JournalTripSummary`; Hard Mode from `is_hard_mode` (ET-026b); Sync uses validated per-root/revision queued, sending, identity-pending, held or durably sent status and appears only after upload is implemented and configured; sent never means company acceptance |
| `journal.pager` | "Page N · 50 trips per page · the journal does not update by itself", Previous / Next; **Refresh** in the top bar | Cursor paging as today (ET-016) |

Outcome badges: open → ◌ "In progress" (neutral); delivered → ✓ (ok); cancelled → ✕ (error); none → "No outcome" (neutral). The mockup also shows **Delivered late** (warn); that needs a defined lateness rule from stored data and is a proposal, not a current field. Recording badges: complete ✓ ok, partial ⚠ warn, unknown ◌ neutral. A row opens Trip details. Empty journal: see §6.

### 5.4 Trip details (`trip.*`)

| Spec id | Content | Data binding |
| --- | --- | --- |
| `trip.header` | Back to the journal, cargo as title, chips (game, mode, job market, Special transport for a special job, outcome, recording, Hard Mode), route and companies and start time | `JournalTripDetail` |
| `trip.export` | **Export JSON** (secondary button) | `exportJournalTrip` (ET-016 PR-5) |
| `trip.tiles` | Four tiles: distance observed (hero gradient; "planned …" and "game reported …" below), revenue or penalty (teal; "expected …"), real time ("… game time"), fuel used ("from samples, refuels excluded") | Observed `observedDistanceM`, planned from the job, game-reported from the outcome record; money as exact text |
| `trip.detailTabs` | Segmented tabs **Summary** (speed chart from 1 Hz samples, gaps shaded warn, missing data hatched), **Timeline** (events with time, coloured dot, title, detail), **Completeness** (recorded vs gap bar and interval count) | Samples, `journalEvents`, `journalIntervals` |
| `trip.speedChart` | Area chart, grid `--yu-divider`, y ticks in the trip's unit, start time and duration on the x axis | `listSamples` |
| `trip.hardMode` | Qualifies / does not qualify, the evaluation at job start and at delivery, "Settings snapshot kept with the trip" | `is_hard_mode`, `hard_mode_details` (ET-026b) |
| `trip.money` | Fines, tolls, ferries and trains | Money totals of the trip detail; never netted or converted |

### 5.5 Settings (`settings.*`)

Settings have their own screen (mockup T5, ET-078): a 170 px left sub-navigation (`settings.nav`) in the order General, Overlay, Game plugin, Diagnostics, About, beside one panel column up to 1100 px wide; at 900 px and below the sub-navigation stacks above the panel. The items are native buttons (Tab, then Enter or Space), at least 32 px tall, with `aria-current="page"` on the selected one; the selection survives route changes within a session and resets to General on restart. Panels stay mounted and switch with `hidden`. Each panel except Overlay opens with an 18 px heading and a muted subline, then section cards (8 px radius, 13 px heading row with an optional right-aligned note) of compact rows: the label (500) and a 12 px muted hint on the left, the control on the right, a line between rows, and a result region spanning the row under its button. Segmented controls are compact (26 px segments in a 2 px track); selects and buttons are 32 px. The page title stays the h1, weights are 500 and 700 rather than the mockup's 600, and hints use the muted AA colour instead of the mockup's slate.

| Panel | Spec id | Rows |
| --- | --- | --- |
| General | `settings.general` | Interface: language (dropdown English / Русский, the note on game-provided names as its hint), Start with Windows (badge and switch, the not-installed note in the hint) and Closing the window (read-only "Hide to tray", the close-to-tray explanation as its hint); Display units (`settings.units`): one segmented control per game, Metric (km/h, L) / US customary (mph, gal), with the note that stored data does not change; Gear display (`gear-display-card`, ET-050): the description as the section note, one row per game with Automatic / Manual range-splitter / Crawler first and the committed mode's example labels as the hint ("For example: C1, C2, 1L…"); each option keeps its info icon and own hint on hover or keyboard focus (`gear-display-<game>-<mode>-tooltip`), which is also its accessible description; Current track: show switch, state line, source, style, opacity and position rows |
| Overlay | `settings.overlay` | One card with labelled visibility, layout (four thumbnails), position/size and one Sections block (presets as a labelled button group under its heading, then the grouped section switches; ET-053). All sixteen section labels, icons and switches are on this page; no separate sections destination or Choose sections action. Background opacity remains informational **Planned** text below the card. |
| Game plugin | `settings.plugin` | The connection diagnosis, mode note and running line, then one block per game: game badge, title and the "Manage the plugin for this game" switch; notes; each listed folder by its label (never a path) with its own status badge and icon (installed, outdated, missing, excluded, blocked, working) and details, "Show plugin file" and, only when offered, "Open game plugins folder"; "Choose game folder…"; one Retry for the card. There is no per-game Reinstall or Update |
| Diagnostics | `settings.data` | Data source: the native source select and the State row (startup line, `telemetry-status`, origin and freshness, connection badge); Application status: service and storage badges, recording headline, details and gaps, the last problem only while the service is not failing, the recording alert and the prototype notice; Diagnostic bundle (`settings.data.bundle`): "Export diagnostics…", available in every plugin mode and sharing the Game plugin card's action controller |
| About | `settings.about` | Brand block `settings.about.brand` (logo 56 px, "Yukon Union Telemetry", "Telemetry · ETS2 · ATS" and the version line `settings.about.version`, the same text as `shell.sidebar.version`); an Updates row with **Check for updates** / **Проверить обновления** (`settings.about.update`, ET-055), which calls `checkForUpdates()` and answers beside the button as an ET-045b action result with fixed text ("Checking for updates…", "You have the latest version.", "Version 0.2.0 is available…", "Could not check for updates." with the failure reason, and "Could not start a check. Try again." / "Не удалось начать проверку. Повторите попытку." in the failure style when the bridge call itself fails, never an earlier check's outcome); it waits ("Checking for updates…") only while the bridge reply shows a running check, and otherwise answers at once from the reply (a standing offer answers with its version, a throttled check with the latest finished one); busy, with the note "An update is already installed. Finish it with the button in the sidebar.", in `ready`; disabled with the note "Updates are checked only in an installed copy of the app." where the launch never checks; a Font row whose summary opens the Huninn SIL Open Font License; Uninstall as a row with the destructive button and the data-loss warning always visible under it (ET-018) |

Settings save as today: a choice shows as selected only after main saved it; a refused save shows its message in the same card. ET-048 keeps one mounted `OverlaySettingsCard`, with one Overlay heading, h3 block headings and h4 Driving / Fuel / Job / Time groups. No nested scroller, tabs or accordion: the existing content area scrolls, controls wrap, and lower controls remain keyboard reachable at renderer zoom. Owner follow-up, October 24, 2026: remove the parenthetical technical requirement notes below individual section labels in both languages. Keep the general unavailable/stale explanation and the existing data-availability rules.

Edit position enters the existing main-owned draft. Layout is unavailable during editing; presets and section switches keep their existing availability. Scale/reset change only the draft, Cancel writes nothing and Done uses the existing durable save. Visibility-off prevents editing and a committed off save discards the draft; a failed save retains the committed selection and existing error. Read-only guards and the final-enabled-section guard remain. ET-048 changes presentation only: settings v6, preload/IPC, geometry and ET-045 corrections retain their existing contracts.

### 5.6 Account and sync (`account.*`, Dashboard upload)

Account & sync is implemented and always discoverable. Both compiled origins remain unset: the packaged screen explains unavailable configuration without token controls, chip or Journal column. A configured origin permits token entry before an owner exists; Journal decorations additionally require a settled confirmed owner and validated page facts. Show the real connection/upload state instead of a "Later" or "not in this version" chip. Local recording remains available throughout; no history download or restore control is provided.

| Spec id | Content |
| --- | --- |
| `account.token` | Masked token entry with show/hide for the currently entered value only; verify against the configured Dashboard, then confirm the authenticated account and all retained eligible history before binding/uploading. Clear the entered token after submission or cancellation; saved credentials are never read back into the renderer. Note "Uploading is not acceptance: trips are reviewed on the dashboard." See the agreed [upload specification](../dashboard-upload.md#connection-credentials-and-ownership). |
| `account.status` | Verified owner identifiers, service origin and channel; unconfigured, verifying, awaiting confirmation, connected, offline/backoff, authentication required, identity pending, reconciliation hold and queue pressure. Show source backlog separately from frozen queued/held counts, last durable upload and a fixed actionable diagnostic; never expose another owner's data. |
| `account.firstSync` | Initial enumeration progress and distinct trips durably sent, with changing totals explicit. Distinguish scan complete from all work delivered; identity-pending/held roots remain visible and are never counted as sent. |

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
| `states.noToken` | Origin configured but no confirmed owner; Account & sync remains accessible | Verify token, then confirm owner/scope |
| `states.offline` | Configured upload has no network; local recording continues and pending work is retained | Show backlog and retry status |
| `states.firstSync` | Initial history enumeration/upload, including identity-pending and held records | Separate scan progress from durable trip delivery |

## 7. Overlay (`overlay.*`)

The overlay keeps its own minimal stylesheet with the `--yu-ov-*` tokens: panel `rgba(11,17,32,.80)` (background opacity sets alpha directly: 40–100%, default 80%), border `rgba(55,65,81,.9)`, text `#F3F4F6`, icons muted, accent `#60A5FA`, fuel `#8FD3AE`, low fuel `#E8C58A`, problems `#F3B4A4`. Huninn is bundled into the overlay as well. No backdrop blur. Values use tabular figures.

The October 22 ET-012e amendment applies integer speed to all four layouts. Ordinary values use 20 px in Strip, 13 px in Card, 12 px in the Cluster panel and 14 px in HUD; preserve the existing primary speed/gear hierarchy, label and unit sizes, fixed row heights and styles. In the implemented Strip and HUD, primary speed remains 22 px and 16 px respectively. The saved vertical placement also aligns painted content inside the stable reserved window: top at `y = 0`, centre at `0.5`, bottom at `1`. Dragging freezes that internal anchor until release; placement accuracy and possible release adjustment require the focused owner checks described in [the minimal overlay](../minimal-overlay.md#geometry-and-placements-et-012b).

ET-045d amendment, October 24, 2026 (owner request, ET-045 items 7, 8 and 2): values are slightly smaller and never below the 12 px labels; units and details are 12 px except the 11 px Cluster RPM unit, which is a unit, not a value. Strip values are 17 px and speed 19 px, both weight 700; Card row values and the hero RPM 12 px and the hero speed 34, 24 or 16 px at weight 700 for three, two or one hero parts, with the gear at 19 px (16 px alone); the Cluster gauge speed 34 px, its gear 14 px and its RPM a 12 px number with an 11 px unit; Cluster panel values stay 12 px; HUD values 13 px and speed 15 px. In the strip, speed, gear and RPM reserve the width of `000`, `R0` and `0000` with right-aligned digits, so a change of digit count never moves a section; RPM shows its unit separately in every layout. The Cluster centre places the gear just above the exactly centred speed and the RPM just below it, each capped so it stays inside the inner ring. This supersedes, for typography only, the October 22 sizes above and the historical "speed 22 px/800" in the `overlay.strip` row below; layouts, anchors and window sizes are unchanged. See [the minimal overlay](../minimal-overlay.md#stable-numbers-and-value-typography-et-045d-october-24-2026).

ET-052 amendment, October 26, 2026: the overlay gains the section `mandatory-break` (Time group, last): lucide `Coffee`, full label "Next mandatory break" / "До обязательного перерыва", short label "Break" / "Перерыв", value `H h M min` (RU `H ч M мин`) clamped at `0 min`, strip cap 150 px with a data-reserve of the localized "00 h 00 min". Urgency cues (ET-045b asks for more than colour; the owner-approved cue is partial for soon, an open readability point for the real-game check): soon (1 to 119 minutes) is orange colour plus the accessible name, due (zero or less) is red colour plus an underline plus the accessible name; soon (1 to 119 minutes) is `--yu-ov-break-soon` #FB923C, due (zero or less) is `--yu-ov-break-due` #F87171 and underlined, and the item has `data-urgency` and an accessible name with the state word (soon / due now, скоро / пора). 120 minutes or more has the normal text colour; a carried v1 source without a value shows a dash. The default windows grow one row (card 210 × 287, cluster 308 × 203, HUD 224 × 265, strip 1280 × 82 DIP at scale 1). Proposal-level mockup layouts keep their illustrative content.

Cruise control: the overlay section `cruise-control` (Driving group, after RPM) uses lucide `CircleGauge` (distinct from speed's `Gauge`), full label "Cruise control" / "Круиз-контроль" and short label "Cruise" / "Круиз". It shows the set speed like the speed section, `OFF` / `ВЫКЛ` at zero and a dash while the value is unavailable; its strip item has a fixed width.

ET-050 amendment, October 25, 2026: every overlay layout shows the gear in the displayed game's gear display mode (`3` or `2L`, `16` or `8H`; `N` and `R1…Rn` in both). The strip's gear reserve no longer depends on the value: it is the widest of `R0`, `0H` and `0L`, so switching modes or shifting between `1L` and `1H` never moves a section. L and H stay Latin in Russian. Window sizes, row heights and caps are unchanged. ET-050b amendment, October 25, 2026: manual labels follow the truck's gearbox layout while it is current for the same truck (`LL`, `LH`, `1L`…`8H` on the ATS Mack), and the strip reserve adds `LH` and `LL` (B8).

ET-045f amendment, October 24, 2026 (ET-045 item 3, owner decision D4): the Cluster's outer ring is a numeric speed arc in the accent `#60A5FA` on the `live.instrument.gauge` scale (0–130 km/h or 0–80 mph in the displayed profile), from 12 o'clock clockwise, with no arc at a displayed 0, in reverse or without a current speed; the inner RPM arc uses `#2563EB` (`--yu-ov-rpm`). The arc eases over 150 ms linear between updates and does not animate under reduced motion. It is driven by a validated numeric overlay field, not by display text. See [the minimal overlay](../minimal-overlay.md#cluster-speed-arc-et-045f-october-24-2026).

| Spec id | Layout | Default anchor |
| --- | --- | --- |
| `overlay.strip` | One 38 px row with icons instead of labels; groups separated by thin dividers; speed 22 px/800, gear in a blue-outlined chip, mini bars for RPM and fuel | Top centre (clear of the in-game route advisor at the bottom right) |
| `overlay.card` | 310 px card: speed 48 px with gear chip and RPM, fuel bar, job block, game time and Hard Mode row | Top right |
| `overlay.cluster` | Round gauge (speed ring `#60A5FA`, RPM arc `#2563EB`, gear) and a side panel for the other sections | Bottom left |
| `overlay.hud` | Text only with a strong shadow, no panel | Top left |

Behaviour is unchanged from ET-012a/b: sections come from `overlay.sections` and the layout from `overlay.layout`; a section without data is hidden; stale values are greyed with a "No signal 12 s" tag; paused shows a "Paused" tag; while no game is connected the overlay is hidden. Layout-edit mode draws a 2 px dashed `--yu-ov-edit` outline, a drag handle and an edit bar with Reset and Done.

**Hard Mode indicator.** Not a section: a fixed, mandatory element at the end of every layout, without a setting, preset entry or settings migration. Lucide `Flame`, then `HM` (Strip, HUD) or "Hard Mode" (Card, Cluster panel), then a fixed 14 px cue slot. Active `--yu-ov-hm-active` #8FD3AE with a check (`12/12` in Card and Cluster); not active, also unknown or unconfirmed, `--yu-ov-hm-inactive` #E8C58A without a check, with `N/12` in Card, Cluster and HUD when a rule is known and no count in the Strip; lost for the current trip `--yu-ov-hm-lost` #F87171 with a cross, `HM` struck through in Strip and HUD, `lost` / `потерян` in Card and Cluster. Accessible names carry the state in words. It adds one row to Card, Cluster panel and HUD and a 100 px strip item; see [the minimal overlay](../minimal-overlay.md#hard-mode-indicator).

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
- Gauges and charts have an accessible name; their numbers also appear as text. For the Live speed gauge, its visible SVG number/unit and localized accessible image name satisfy this requirement; no duplicate paragraph is required.
- Minimum interactive size 32 px; contrast at least 4.5:1. Measured WCAG ratios of the token pairs on their surfaces: text 14.13 on a card and 15.42 on the chrome; secondary text 8.01 on a card, 8.75 on the chrome and 6.73 on a tag; muted text 5.52 on a card, 5.78 on the work area, 6.03 on the chrome and 5.14 at the start of the instrument gradient; strong text 15.15 on the active nav item and 15.49 in the gear box; the update label 10.54 on the chrome; white on the accent 5.17; status chips on their tints over the chrome 8.38 (ok), 9.56 (warn), 8.91 (error) and 7.77 (neutral), over a card 7.58, 8.64 and 8.03. Non-text marks in `--yu-text-subtle` measure 3.66 on a card and 3.99 on the chrome (3:1 needed); the active nav icon 6.23. Stale dashes in the muted colour measure 5.52 on a card, 5.14 at the start of the instrument gradient and 5.14 in the gear box; labels, hints and badges keep their own contrast, and the stale badge names the state. Re-check any new pair.

## 10. Suggested implementation order

These are suggestions for future cards; none is authorized by this document.

1. **UI foundation**: tokens in index.css, Huninn, badge variants, title bar overlay, the shell (sidebar, top bar, recording box) and screen routing. Move the current cards into the new screens without changing behaviour.
2. **Live** restyle (variant B) on the existing live view.
3. **Journal and Trip details** restyle on the existing ET-016 reads.
4. **Settings** screen with sub-navigation (moves the existing units, overlay, plugin, uninstall and diagnostics cards).
5. **ET-026c**: Hard Mode card, parameter hints, journal badge and the optional overlay section, after ET-026a/b.
6. **Russian UI**: localization framework and the Russian dictionary.
7. **First run** wizard.
8. **Account and sync**: implement the accepted Dashboard upload interface after its service/credential prerequisites; use the visibility and state rules in §5.6.

## 11. Open points for the owner

- Window title and brand: the mockup uses "Yukon Union Telemetry"; the installer, tray and repository name still say ETS2Telemetry.
- Small logo sizes: resolved on October 22, 2026 by the "road merge" application icon in §3; the bear stays the in-app logo.
- Review the Russian translation.
- Start with Windows: needs an explicit authorization (autostart is currently out of scope).
- The "Delivered late" outcome display is a proposal.
- Journal search needs a new storage query.


## ET-028 implementation mapping and accepted read-boundary limits — October 21, 2026

The renderer implements the approved dark Yukon shell and local screen routing. Main window geometry is 1280×800, minimum 1100×720, with a 32px native title-bar overlay; only the title strip drags. The 220px sidebar, persistent status chips and 200px Settings navigation use the canonical tokens and unchanged bear. Both renderers bundle Huninn 5.3.1 independently. Existing package/shortcut/data identities and small Windows/tray icons remain unchanged.

| Reference region | Implemented binding / deliberate limit |
| --- | --- |
| Live instrument / job | Normalized current v0 numbers drive geometry; independently fresh matching v1 supplies job names. Job spans the row below instrument/Hard Mode. Full existing field set and provenance remain below. |
| Live trip / route progress | RecordingHealth exposes no observed trip distance, fuel or duration. These are explicitly unavailable; no demo totals or progress are substituted. |
| Journal table | Started, game chip, cargo/HM, route, observed/planned distance, expected income versus unavailable actual revenue, outcome, completeness, optional owner-scoped Sync and fuel remain reachable in a bounded horizontal table. No per-row detail queries. |
| Trip header / four tiles | One detail query supplies cargo/route/companies/start/chips, observed/planned/game-reported distances, exact outcome money and fuel. Missing hero values use a dash plus a small reason; money keeps exact raw digits/currency with a separate basis note. Aggregate real/game durations are unavailable. |
| Trip chart | Summary and Samples read only the currently mounted page (≤300). Independent source-monotonic elapsed axes per segment; UTC labels only. No line crosses unavailable speed, missing seconds, changed clock or non-increasing time. Raw paged tables remain. |
| Settings | General/Units segmented controls; four Overlay thumbnail cards; existing read-only/committed-save authority, sixteen sections, last-enabled guard and position editing. Unsupported show/opacity/autostart/backup are Planned, version/statistics unavailable. Source selection/raw diagnostic details live in Data. |
| Account / first run | Account uses the existing upload service: masked token, candidate/scope confirmation, explicit cancellation/settlement and disconnect, distinct-source progress and fixed error messages. Unset origins show an informational state. First-run help remains separate; no onboarding backend is introduced. |
| Overlay | Independent transparent CSS with yu-ov tokens and Huninn. Card hierarchy shares the existing reserved 24px rows; speed/gear/RPM subsets never manufacture disabled fields. The cluster's validated numeric RPM fraction draws an inner arc. The existing renderer bridge has formatted speed only, so its outer track is decorative, with no invented speed progress or IPC extension. Superseded for the Cluster by ET-045f (October 24, 2026): a validated numeric `speedRing` payload field, without a new IPC channel or bridge method, draws the outer speed arc (§7). |

App-owned EN/RU labels and numeric unit labels are localized; raw SDK names, money digits/currency codes, protocol/audit enums and cvars remain unchanged. All twelve Hard Mode hints/drawer rows, observation boundaries and irreversible first loss remain governed by ET-026; this task changes presentation only.

Spec IDs use compatible existing IDs where established (`hard-mode-*`, `journal-*`, `overlay-*`) plus `shell.*`, `settings.*`, `live.instrument*`, `trip.header`, `trip.tiles`, `trip.chart` and `trip.hardMode`. Native caption behavior, actual Windows 100%/150% scaling, game overlay input/focus/z-order and performance require manual evidence; viewport screenshots do not establish them.

ET-028 Live compaction keeps all twelve actual parameter names with state icons and complete accessible rule/state labels, hover/keyboard hints, source/age and both actions. The grid uses two columns below a 360px card width, three only above that threshold, with wrapping and ≥32px targets. A short saved-settings limitation stays visible; full observation/manual-parking/qualification caveats remain in the accessible 470px drawer. Current Live screenshot checks require the Job heading and both route endpoints fully inside the content viewport without scrolling, and separately reject overflowing parameter labels.


## ET-047 current presentation — October 23, 2026

ET-047 supersedes earlier compact-card/drawer descriptions, including the dated ET-028 compaction notes below. Live has one full-width instrument above Job. Hard Mode lives between Live and Journal, and exposes all evidence/caveats inline. Optional tooltips do not hide essential information. Existing ET-026 qualification, freshness and source authority remain unchanged. See [ET-047 validation](../validation/et-047.md).

## ET-045b action results — October 24, 2026

The answer of a user action appears next to the control that started it, as the next element after the control or its row, never as a toast, a card-wide status line or a line far from its control. The first adopter is the Game plugin card; see [game plugin setup](../plugin-setup.md#the-game-plugin-card).

| Severity | Tone tokens | Icon | Word (EN / RU) |
| --- | --- | --- | --- |
| Information | `--yu-neutral-*` | `Info` | Information / Информация |
| Done | `--yu-ok-*` | `CircleCheck` | Done / Готово |
| Refused | `--yu-warn-*` | `Ban` | Refused / Отклонено |
| Failed | `--yu-err-*` | `CircleX` | Failed / Ошибка |

- **Shape.** A shadcn Alert with the tone's text, background and border, a 3 px left border, the icon (`aria-hidden`), a title "{severity} — {action}" that names the action and its game, and the fixed answer text in the tone colour. Icon and word always accompany the tone, never colour alone.
- **Announcements.** Information, done and refused live in a persistent polite `role="status"` region that exists from the first render; a failure appears alone as `role="alert"`, outside it. The control names its shown result in `aria-describedby`.
- **Focus and lifetime.** A pending control stays focusable (`aria-disabled`); focus returns to the control only when it was lost. One current result per card: it stays until the next action of that card, with no auto-hide and no dismiss button.
- **Not yet adopted.** The Journal export result, the uninstall card result, the settings, overlay, autostart and language save messages and the Hard Mode lines keep their existing presentation; each is a follow-up candidate.


ET-049 implementation, October 24, 2026: Settings > Overlay replaces the Planned opacity placeholder with a labelled EN/RU slider (40–100%, whole percentages, default 80%). Since the owner follow-up on October 25, one adjacent percentage follows the thumb during a held gesture; the separate Saved label is removed. The painted overlay retains the committed percentage until durable success. Release/keyboard commit writes once, pending disables interaction, refusal restores the thumb and displayed percentage and retains the contextual error. Strip/Card and both Cluster background surfaces follow percentage/100; Minimal remains text-only. Foreground, stale dimming, edit styling and transparent margins are independent. This supersedes opacity's Planned status in the historical implementation snapshot above. See [settings](../settings.md#current-format-v7-background-opacity-et-049).

### Overlay scale range (ET-045e, October 24, 2026)

The overlay's **Scale** control (`settings.overlay`) keeps its existing **Smaller** / **Larger** buttons and "Scale: N%" / "Размер: N%" text; no slider is implemented. Since ET-045e the percentage is a setting in 50–300% in 10% steps, and the overlay's zoom is the setting × 0.7, so the new 100% looks like the earlier 70%. Smaller is disabled at 50% and Larger at 300%; Reset returns to 100%. Saved percentages are kept, so they now look about 30% smaller. The strip keeps up to 1280 DIP of the game window's width at 100% and below, so a smaller setting only shrinks its text. See [the minimal overlay](../minimal-overlay.md#rebased-scale-and-strip-width-et-045e-october-24-2026); the visual comparison with the earlier 70% is pending owner review in [ET-045e validation](../validation/et-045e.md).
