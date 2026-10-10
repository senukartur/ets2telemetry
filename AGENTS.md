# Agent Instructions

## Start Here

Read [concept.md](concept.md) before planning or implementing changes. It contains the product requirements, architecture baseline, implementation sequence, acceptance criteria, and research sources. This file contains repository-wide working instructions and a compact handoff.

Keep the two documents consistent. Use `concept.md` for detailed product decisions and this file for instructions that apply across tasks. Explicit user instructions take precedence over this documentation.

## Documentation Language

**Write all internal documentation that may be committed to Git in English.** This is an explicit owner requirement.

It applies to Markdown files, agent instructions, plans saved in the repository, architecture notes, decision records, setup guides, API documentation, and explanatory code comments/docstrings. New documents and edits to existing documents must follow this rule.

Continue conversation with the owner in their preferred language, currently Russian. The documentation rule does not select the product's UI language. Preserve proper names, external identifiers, localized game data, and test fixtures where their original values matter.

## Current Project State

At the initial handoff on October 10, 2026:

- The repository directory contains documentation only. No application, plugin, server, or test suite has been implemented.
- The initial directory was not a Git repository. Inspect the current state before using Git commands; do not assume this remains true after later work.
- The working environment is Windows with PowerShell. No development toolchain installation has been verified.
- No package manager, dependency versions, build scripts, or CI workflows have been established.
- Research covered the official SCS SDK 1.15 archive and relevant Electron, Node.js, and TruckersMP documentation.
- Compatibility, overlay behavior, latency, and game performance have not been tested in a running game.
- The SQLite storage estimate was measured using a synthetic in-memory model, not the product.

Treat this as a dated baseline, inspect actual files on each task, and update this section when implementation changes the project state. Do not invent existing commands, implemented features, or successful checks.

Git setup update on October 10, 2026:

- The local directory is now a Git repository. Local `main` tracks the existing `origin/main` history, including its original README.
- The `origin` remote is `https://github.com/senukartur/ets2telemetry.git`.
- Git for Windows 2.55.0.windows.5 with Git Credential Manager 2.9.1 is installed at `C:\Program Files\Git\cmd\git.exe`. The Codex runtime also provides Git 2.53.0.windows.3. GitHub CLI 2.102.0 is installed at `C:\Program Files\GitHub CLI\gh.exe`.
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The repository is private and the authenticated account has admin permission.
- The repository-local commit identity is `Artur Sianiuk <15032912+senukartur@users.noreply.github.com>`. Pulls require a fast-forward (`pull.ff=only`), and pushes use `push.default=simple`.
- Fetch, `git pull --ff-only`, and the initial documentation push succeeded. The published documentation includes `README.md`, `AGENTS.md`, and `concept.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`; do not commit it.
- Use Git for local history and synchronization, and GitHub CLI for pull requests and GitHub checks. A GitHub MCP server is not required for this workflow.
- The application and native development toolchains remain unverified.

## Product Requirements to Preserve

- Build an ETS2 and ATS telemetry utility for a virtual trucking company.
- Target Windows x64 first. TruckersMP compatibility is required; validate single-player and Convoy as well.
- The MVP is local and works without an account or internet connection: live telemetry, an overlay, a trip journal, and one-second samples.
- Support windowed and borderless fullscreen overlays. Exclusive fullscreen, rendering hooks, and arbitrary game memory reads are outside the MVP.
- Keep website development, accounts, company permissions, server synchronization, and online reporting in the later server phase.
- Visual design is deferred. Start with a functional, readable UI.
- The owner knows React and TypeScript and is new to desktop development. Explain unfamiliar native and desktop concepts clearly.

## Architecture Baseline

| Area | Working choice |
| --- | --- |
| Desktop and UI | Electron, React, TypeScript, Vite |
| Game integration | Project-owned C++17 DLL using the official SCS Telemetry SDK; CMake and MSVC |
| Local transport | Windows Named Pipes |
| Persistence | SQLite through better-sqlite3 in a dedicated worker |
| Packaging | Electron Forge |
| Validation | Vitest, Playwright, simulation/replay, and actual game sessions |
| Later server direction | Node.js, TypeScript, Fastify, PostgreSQL, React |

These are planned choices, not installed dependencies. Pin compatible versions when scaffolding. Distinguish SDK archive versions from API versions and game versions.

Keep telemetry processing and trip accounting separate from React components so they can be tested without the UI. Keep the plugin, application transport, persistence, and overlay responsibilities distinct. Expose narrow typed interfaces across boundaries.

## Implementation Constraints

### Game Integration and Transport

- Keep SDK callbacks short. Copy data in callbacks; perform serialization and transport work on a background thread.
- Call SCS APIs only in the callback context allowed by the SDK. Never call them from the transport worker.
- A missing or slow application must not stall the game. Bound buffers and report event gaps rather than silently treating incomplete data as complete.
- Version the protocol and preserve session identity and message ordering. Validate incoming messages and document the wire format alongside implementation.
- Coalesce live snapshots when appropriate. Preserve gameplay events separately, acknowledge them after persistence, and handle redelivery without duplicates.
- Restrict pipes to the local user and reject remote access.
- Install the DLL in the selected game's `bin/win_x64/plugins` directory. Change it only while the game is closed, and manage only this project's plugin.
- Use real game tests to establish TruckersMP support. Do not infer compatibility solely from successful single-player tests or documentation.

### Overlay and Electron

- Use a transparent window that passes mouse input to the game and does not steal focus while driving.
- Track the game window and hide the overlay when the game is minimized or another application is foreground. Account for monitor and DPI changes.
- Keep the display update target of up to **20 Hz** separate from the history sampling rate of **1 Hz**.
- Use context isolation, sandboxed renderers, and a narrow preload/IPC API. Do not give React direct Node.js or filesystem access.
- Closing the main window must not silently end recording. Full application exit must be explicit.

### Data Integrity and Storage

- Store the database under `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, resolved at runtime, separately from application binaries.
- Preserve data across application updates and use schema migrations. The MVP has no automatic history deletion.
- Store trip summaries, gameplay events, and samples separately. Prefer numeric internal references in sample rows, keeping stable UUIDs in entity records.
- Generate project-owned record IDs. Do not assume the game exposes a globally unique job ID.
- Distinguish unavailable values from zero, real time from game time, planned distance from observed/delivered distance, and expected income from actual revenue.
- Record one sample per real second during active simulation, including road stops. Represent pauses as events without adding duplicate paused samples.
- Keep completion status separate from recording completeness. Missing job configuration alone does not prove delivery; ambiguous continuations must not be merged automatically.
- Handle late attachment, reconnection, save loading, timer resets, truck changes, and refueling explicitly. Do not fabricate data for missing intervals.
- Convert SDK average consumption from liters/km to liters/100 km for display. Do not equate it with a trip-specific average without a defined calculation.
- Treat game-world coordinates as game coordinates, not latitude/longitude.
- Keep synthetic/replay data distinguishable from real history.

The working storage allowance is about **100 MB per 100 hours** at 1 Hz (estimated range: 60-120 MB). Re-measure once the actual schema exists; do not present this as a guaranteed limit.

## Workflow and Verification

Work on the milestone requested by the user. Routine implementation decisions within the agreed requirements do not require repeated confirmation. Discuss changes to product requirements or major architecture before committing to them.

The first implementation milestone is a complete path from game telemetry to a working speed/fuel overlay in both games, including TruckersMP. Subsequent milestones add application behavior, reliable recording, and distribution. Follow the sequence and acceptance criteria in `concept.md`.

- Inspect the actual project state before choosing commands or editing files. Prefer `rg` for searches.
- Use PowerShell-safe quoting and literal paths. Avoid Unix-only command assumptions in development instructions.
- Add documented setup/build/test commands when the corresponding tooling exists; do not document placeholders as working commands.
- Run checks appropriate to the change. For documentation-only work, inspect content, links, and Markdown structure; do not scaffold application tests.
- For telemetry logic, test units, lifecycle events, duplicates, missing data, and discontinuities using simulation/replay.
- For integration, record the tested game/client versions and display mode. Test both games, the required multiplayer modes, launch order, reconnects, and overlay behavior.
- Measure resource usage and frame-time impact during real sessions. The 200 ms display latency goal is a target until measured.
- If a required game or tool is unavailable, report exactly what was checked and what remains unverified.
- Keep changes focused and preserve unrelated work. Update the relevant documentation when requirements, interfaces, setup, or implementation status change.

Consult the primary sources linked in `concept.md` when validating SDK or framework behavior. Examples of other telemetry utilities may help, but receiving them from the owner is not a prerequisite for implementation.
