# ETS2Telemetry: Product Concept

This file describes the product idea and how its features work. It is not a log.

**Changing this file.** Change it only when a feature is added or an existing feature's behavior changes. Edit the feature's description in place, in a few present-tense sentences. Do not add dates, task IDs, decisions, validation status or history: they belong in the PR description, the area's document in `docs/`, [DECISION-LOG.md](../DECISION-LOG.md) for owner decisions, and `docs/validation/` for real-game evidence. The earlier full concept and the dated design decisions are in [DESIGN-DECISIONS.md](../DESIGN-DECISIONS.md).

## Idea

**Yukon Union Telemetry** (technical name ETS2Telemetry) is a telemetry utility for **Euro Truck Simulator 2** and **American Truck Simulator**, made for the drivers of a virtual trucking company (VTC). It shows the essential driving data over the game, keeps a trip journal on its own, and records detailed samples for later analysis.

The current product is a local Windows x64 application. It works without an account or internet connection. A later phase adds a server and a company website with driver and company statistics, fed by the locally recorded data.

The owner knows React and TypeScript and is new to desktop development, so most of the product is TypeScript and React, and native code stays in one small game plugin.

## Principles

- **Official data only.** Telemetry comes from the official SCS Telemetry SDK through the project's own plugin. No game memory reads and no rendering hooks.
- **The game comes first.** The plugin only copies data in the game's callbacks and never waits for the application. A slow or missing application must not stall the game.
- **Honest data.** An unavailable value is never shown or stored as zero. Real time differs from game time, planned distance from driven distance, and expected income from actual revenue. Missing intervals are recorded as gaps, never filled in.
- **Real and test data never mix.** Simulated and replayed sources are marked as such and never written into the real history.
- **Out of the driver's way.** The overlay never takes focus or mouse input while driving. Closing the main window does not stop recording; leaving the application is an explicit action.
- **Local and private.** Data stays on the driver's computer. Uninstalling removes all of it.

## Features

### Game connection and plugin setup

On launch the application finds ETS2 and ATS in the Steam libraries and silently installs or updates its plugin in each game's `bin/win_x64/plugins` folder. It does this only while the game is closed, verifies the copied file, never replaces a file it does not recognize and leaves other plugins alone. A game can be excluded, which removes the plugin from it, or pointed to a manual folder. A protected folder gets instructions for a manual copy. A Game plugin card shows each game's state, a connection diagnosis and an opt-in diagnostic bundle that is saved locally and never uploaded.

The plugin streams over local named pipes that only the current Windows user can open. By default the application waits for a game and connects automatically to the available ETS2 or ATS plugin, whether the application or game starts first. If both games are available before attachment, Live asks which to use. An attached session stays selected when another game appears; after it ends, discovery resumes.

### Live dashboard

The Live screen shows the connection state and every live telemetry field: speed and RPM gauges, gear, fuel and range, the SDK average consumption, the current job (cargo, origin and destination, distance left, deadline, income), the truck and trailers, and game time. A value that stops updating becomes unavailable instead of staying frozen. Units follow a per-game profile, metric for ETS2 and US customary for ATS by default. Gears can be shown as automatic (1, 2, 3), manual range-splitter labels that follow the truck's gearbox layout (1L, 1H…), or crawler first (C, 1, 2…).

### Overlay

The overlay is a transparent window above the game in windowed or borderless fullscreen mode. It passes mouse clicks to the game, never takes focus, and hides when the game is minimized or another application is in front. It updates up to 20 times per second.

The driver chooses one of four layouts (Strip, the default, plus Card, Cluster and Minimal HUD) and which sections it shows, such as speed, gear, RPM, fuel, consumption, cargo, destination, distance left, deadline, income, game time and the time left until the next mandatory break. In an explicit edit mode the driver moves and resizes it (50–300%). The background opacity and whether the overlay is shown at all are saved settings.

### Trip recording

The application builds trips automatically from the game's job and delivery events and records them, with their events, gaps and one sample per real second of active driving, in a local SQLite database under `%LOCALAPPDATA%\ETS2Telemetry`. Pauses are recorded as events, not as repeated samples; free driving without a job is recorded too. Events are acknowledged to the plugin only after they are saved, so a crash or reconnection neither loses nor duplicates them.

A trip's outcome (delivered, cancelled, unknown) is kept separate from how completely it was recorded. A job that started before the application attached, a lost connection or lost events make the trip partial; an ambiguous continuation is never merged automatically. History is never deleted automatically and survives updates.

### Journal and export

The Journal lists the recorded trips page by page. A trip's details show its route, cargo, outcome, recording completeness, distances, fuel used, money, Hard Mode evidence, events and a chart of the current page of samples. A trip can be exported as versioned JSON; the export is a copy for the driver's records and cannot be imported back.

### Hard Mode

Hard Mode checks whether the game's persisted profile settings meet twelve realistic-driving rules (for example realistic fuel, air brakes and skilled parking) and shows each rule's state; a rule that does not pass also shows its detected and required value. A delivered trip qualifies only if every rule passed throughout the trip and the delivery was manual. Any failure or unknown value loses the trip's qualification for good. Hard Mode reads files only and is not anti-cheat proof.

### Application

The application runs in the notification area as a single instance. Closing the main window hides it; recording and the overlay continue until the driver chooses Exit. It can start with Windows and shows its interface in English or Russian. Game-provided names (cargo, cities, companies, trucks) are never translated.

### Installation, updates and uninstall

A Windows installer installs the application per user without administrator rights. The application checks its release channel for updates, verifies a signed manifest, and downloads and installs an update only when the driver clicks, and only while no game is running. Uninstalling removes the application, its plugin files and all local data. A separate staging channel installs beside the production one for testing.

## Supported environments

Windows x64, ETS2 and ATS, each in single-player and TruckersMP, in windowed and borderless fullscreen mode. Support for a combination is claimed only after a test in the real game. The built-in Convoy mode and exclusive fullscreen are not supported.

## Not in scope yet

- The server phase: driver accounts, company membership and permissions, synchronization of local data, reports and the company website (planned stack: Node.js, TypeScript, Fastify, PostgreSQL, React).
- A geographic map: game coordinates are game-world coordinates, not latitude and longitude.
- Telemetry of other TruckersMP players, and screenshots that include the overlay.

## How it works

```text
ETS2 / ATS (single-player or TruckersMP)
    | official SCS Telemetry SDK callbacks
    v
Project C++17 plugin DLL  --local named pipes-->  native broker
                                                      |
Electron main (windows, tray, supervision)  <--  telemetry service (utilityProcess)
    |-- main window (React, sandboxed)               `-- storage worker --> SQLite
    `-- overlay window (React, sandboxed)
```

The plugin serves live snapshots and durable gameplay events over a versioned protocol. The telemetry service validates them, builds the live view and trips, and saves history through its storage worker. Electron main owns the windows and passes the renderers only validated, formatted data through a narrow preload API; the renderers have no Node.js or file access. Details are in `docs/`: protocols in [docs/protocol](protocol), trips in [docs/trips.md](trips.md), storage in [docs/storage.md](storage.md), the overlay in [docs/minimal-overlay.md](minimal-overlay.md), and installation in [docs/user-guide.md](user-guide.md).
