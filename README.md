# ETS2Telemetry

A planned Windows telemetry utility for **Euro Truck Simulator 2 (ETS2)** and **American Truck Simulator (ATS)**, intended for drivers in a virtual trucking company.

The local MVP will display live truck metrics in an overlay, maintain a trip journal, and record one telemetry sample per real second during active simulation. It will work without an account or internet connection.

## Project status

**Design stage, as of October 10, 2026.** This repository contains requirements and working instructions. No application, native plugin, server, build scripts, or test suite has been implemented. Application dependencies and native build tools have not been verified.

Compatibility with either game, Convoy, and TruckersMP is required but has not yet been tested. Overlay behavior, resource usage, and display latency also require real-game validation.

## Planned MVP

- Windows x64 support for ETS2 and ATS, including TruckersMP, single-player, and Convoy.
- Live speed, gear, RPM, fuel, consumption, range, and available job information.
- A transparent overlay for windowed and borderless fullscreen play, with mouse pass-through and no focus stealing while driving.
- A local trip journal, gameplay events, one-second samples, and JSON export.
- Explicit handling of pauses, disconnections, late attachment, save loading, and incomplete recordings.
- Tray operation so closing the main window does not stop recording.

Exclusive fullscreen, rendering hooks, and arbitrary game memory reads are outside the MVP. Website development, accounts, company permissions, server synchronization, and online reporting belong to a later phase. Visual design is deferred until the telemetry path works.

## Working architecture

| Component | Planned technology |
| --- | --- |
| Desktop application | Electron, React, TypeScript, Vite |
| Game plugin | Project-owned C++17 DLL, official SCS Telemetry SDK, CMake, MSVC |
| Local transport | Windows Named Pipes |
| Storage | SQLite through better-sqlite3 in a dedicated worker |
| Distribution | Electron Forge |
| Validation | Vitest, Playwright, simulation/replay, and real game sessions |

The plugin will copy telemetry in SDK callbacks and send it from a background thread. The application will process telemetry independently of React, expose a narrow typed preload/IPC interface, and persist history locally.

The live display target is up to **20 Hz**, separate from history sampling at **1 Hz**. The planned database location is `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`.

These technologies are architecture choices, not installed application dependencies. Compatible versions will be pinned when scaffolding begins.

## Implementation sequence

1. Build the complete game-to-overlay path for speed and fuel; validate it in ETS2 and ATS, including TruckersMP.
2. Add connection states, reconnection, tray behavior, settings, game-window tracking, and monitor/DPI handling.
3. Add reliable trip accounting, SQLite persistence, one-second recording, the journal, and export.
4. Add game discovery, safe plugin installation, packaging, and updates that preserve history.
5. Specify and implement the separate server and company website phase.

## Documentation

- [Project concept and requirements](concept.md): product requirements, architecture, recording rules, implementation sequence, acceptance criteria, and primary research sources.
- [Agent instructions](AGENTS.md): repository-wide working rules and the current handoff.

Read `concept.md` before planning or implementing changes. Internal documentation and explanatory code comments must be written in English. Temporary Trello planning manifests stay local and must not be committed.

## Development setup

Git for Windows and GitHub CLI are configured on the owner's workstation. The application development toolchain has not been established, so there are no application install, build, run, or test commands yet.

Document verified setup commands and dependency versions when the first implementation milestone is scaffolded.
