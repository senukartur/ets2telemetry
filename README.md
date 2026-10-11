# ETS2Telemetry

A planned Windows telemetry utility for **Euro Truck Simulator 2 (ETS2)** and **American Truck Simulator (ATS)**, intended for drivers in a virtual trucking company.

The local MVP will display live truck metrics in an overlay, maintain a trip journal, and record one telemetry sample per real second during active simulation. It will work without an account or internet connection.

## Project status

**ET-001 scaffold, as of October 11, 2026.** The repository contains a minimal React/Electron window, telemetry utilityProcess and isolated SQLite worker probe, pinned npm workspaces, Forge packaging, and a C++17 x64 placeholder DLL. Build, typecheck, 118 Node tests, native CTest and bounded packaged startup checks passed. Native Windows install, repair, update, both installed worker/security smokes and uninstall completed with normal exits and empty Jobs. Acceptance combines that actual cycle with a separately reviewed correction to the uninstall residue check; the original failed wrapper report is retained. Existing user files and shortcuts were preserved, and owned test files were cleaned up. One earlier Playwright startup timeout remains unexplained flakiness. See [the validation record](docs/validation/et-001.md) for exact artifacts, independent review and evidence limits. Native launches are owner-authorized; no further VM run is required. That merged scaffold baseline did not include protocol, game adapter, recorder, overlay, server or CI.

Compatibility with either game, Convoy, and TruckersMP is required but has not yet been tested. Overlay behavior, resource usage, and display latency also require real-game validation.

**ET-022 candidate, hosted evidence recorded.** Windows x64 CI connects scaffold checks to pull requests, main pushes and manual runs, with isolated development and packaged worker probes and retained diagnostics. Clean and restored hosted jobs passed all 122 tests, native CTest and both smokes in 199/200 seconds; a deliberate assertion failed the job between them. Final PR-head verification, independent review and owner merge remain required. See [ET-022 validation](docs/validation/et-022.md). See [CI commands and evidence](docs/ci.md) and the [regression registry](docs/regression-registry.md). The preceding ET-001 status describes the merged scaffold baseline.

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

The scaffold pins Node/npm and application dependencies. Electron main supervises a telemetry utilityProcess, which owns the dedicated storage worker. The current probe writes only temporary synthetic data.

## Implementation sequence

1. Build the complete game-to-overlay path for speed and fuel; validate it in ETS2 and ATS, including TruckersMP.
2. Add connection states, reconnection, tray behavior, settings, game-window tracking, and monitor/DPI handling.
3. Add reliable trip accounting, SQLite persistence, one-second recording, the journal, and export.
4. Add game discovery, safe plugin installation, packaging, and updates that preserve history.
5. Specify and implement the separate server and company website phase.

## Documentation

- [Project concept and requirements](concept.md): product requirements, architecture, recording rules, implementation sequence, acceptance criteria, and primary research sources.
- [Agent instructions](AGENTS.md): repository-wide working rules and the current handoff.
- [Testing and regression strategy](TESTING.md): scaffold checks, permanent scenarios, CI/merge policy, and pending real-game acceptance evidence.
- [Windows setup](docs/setup.md): pinned tools, build/test/package entrypoints, process boundaries, SDK acquisition, and remaining checks.
- [Implementation coordinator](COORDINATOR.md): Trello execution, subagent assignments, worktree ownership, independent review, and recovery handoffs.
- [Coordinator launch prompt](docs/prompts/coordinator-start.md): copy into a separate local Codex chat to coordinate the prototype and prepare PRs for owner review.

Read `concept.md` before planning or implementing changes. Internal documentation and explanatory code comments must be written in English. Temporary Trello planning manifests stay local and must not be committed.

## Git workflow

Work in short-lived task branches and open pull requests targeting `main`. Use `feat/`, `fix/`, `docs/`, or `chore/` branch prefixes. Report validation results in the PR, resolve review feedback, and use squash merging. The owner merges by default; agents need explicit authorization to merge. GitHub automatically deletes merged branches.

Enable the local guard in each checkout:

```powershell
git config --local core.hooksPath .githooks
```

The hook blocks direct pushes to remote `main`. Server-side branch protection is unavailable for this private repository on the current plan, so the local guard and working rules currently enforce the process within this checkout. Windows CI is implemented with hosted clean/failure/restoration evidence; final current-head validation and owner review still gate merging.

See [Git workflow rules](AGENTS.md#git-workflow) for branch, PR, history, validation, and release policies.

## Development setup

Follow [Windows setup](docs/setup.md). Node/npm and Visual Studio/CMake paths were inspected; packaging, GUI startup, and installation commands remain subject to the ET-001 acceptance record.

<!-- ET-024 path-filter probe; this PR is closed without merging. -->
