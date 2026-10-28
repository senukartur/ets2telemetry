# Technical Debt and Deferred Capabilities

These entries record owner-approved deferrals, or coordinator decisions under the owner's delegation when an entry is explicitly labelled as such. They do not expand the current milestone or establish an implementation choice.

## TD-001: Game screenshots containing the telemetry overlay

Recorded October 12, 2026, at the owner's request during ET-008 validation. Status: deferred; implementation has not started. Related card: [ET-008](https://trello.com/c/37RpcL1u/9-et-008-display-a-minimal-speed-and-fuel-overlay).

### Problem and desired outcome

The current overlay is a separate transparent Electron window over the game. A game-only capture can omit that window even when the player sees it. The supplied ETS2 screenshots contain no overlay pixels; the precise capture path was not instrumented. This is a capture limitation, not evidence that the overlay was hidden.

The future capability should provide game screenshots containing the visible telemetry overlay, including verified behavior for Steam screenshot capture. Preserve Electron/React for the interface where practical. Merely adding an always-on-top flag does not establish Steam capture compatibility.

### Future investigation

- Compare an application-owned screenshot that captures or composites the game and overlay with integration that draws the overlay into the game rendering path. The former can provide a combined image without guaranteeing inclusion in Steam's own capture.
- Determine how Steam captures each supported game and when overlay composition occurs. Do not promise inclusion based only on an injected overlay or a successful desktop screenshot.
- Evaluate native rendering integration or a supported Electron overlay platform only after an architecture decision. Rendering hooks remain outside the current MVP; recording this debt does not authorize them now.
- Check the then-current TruckersMP integration rules and validate both games in actual single-player and TruckersMP sessions (Convoy is deferred by the October 12, 2026 owner decision). Preserve click-through, focus, hiding, telemetry isolation and the absence of arbitrary game-memory reads.

### Completion evidence

Record application/game/client versions, capture tool and hotkey, display mode and source commit. In both ETS2 and ATS, demonstrate screenshots with the expected visible overlay through each claimed capture path, including Steam where support is claimed. Check foreground/minimize behavior and DPI/window placement, and measure added latency, resource use and frame-time impact. A desktop capture or synthetic fixture alone cannot accept the Steam or TruckersMP result.

### Research boundaries

[Trucky's official 2025 report](https://truckyapp.com/blog/announcements/2025-wrap-up/) identifies Electron, so Electron itself is not an inherent barrier. [Overwolf's Electron API](https://dev.overwolf.com/ow-electron/reference/Overwolf-electron-APIs/overlay/interfaces/GameLaunchEvent/) documents game-overlay injection. Neither source proves the capture mechanism of the owner's installed Trucky or VTSBase versions, or guarantees Steam screenshot inclusion. [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) exposes screen/window capture sources; [Steam screenshots](https://partner.steamgames.com/doc/features/screenshots) describe Steam's capture integration. Recheck these APIs during the future investigation.

## TD-002: Bus and car jobs

Recorded by owner decision on October 13, 2026.

SDK 1.15 defines `bus_job` and `car_job` configurations and the `car_job.delivered` and `car_job.cancelled` events, which include `vehicle.damage`. Every observed session start sends empty `bus_job` and `car_job` configurations. Bus content is not yet released for ETS2, car jobs in ATS are recent, and TruckersMP buses are not of interest for now, so these job types are outside the current validation and trip scope.

**Future work:**
- Capture real bus and car jobs.
- Define their trip representation, including vehicle damage and passenger or car-specific attributes.
- Extend ET-014 attribution and the journal.

**Until then:** tolerate the empty configurations and never create trips from them.

## TD-003: Live driving controls and navigation fields

Recorded October 15, 2026 by the coordinator during ET-010 planning. **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-010 authorization in [concept.md](../concept.md#et-010-authorization--october-15-2026)). The owner may revise it.

Protocol v1 minor 0 does not carry cruise control, throttle, brake and clutch inputs, navigation time, the navigation speed limit, the parking brake or lights. The ET-010 live dashboard therefore covers the MVP field set only: the concept §6 overlay metrics, the §7 sample fields, job, truck and trailer identity and source validity ([live telemetry fields](live-telemetry-fields.md)).

**Future work:**
- Add these channels in a v1 minor revision with fixtures, in both the TypeScript and C++ representations.
- Capture and review them in real sessions before showing them.
- Extend telemetry-core normalization and the dashboard.

**Until then:** do not show or infer these values; nothing in the current protocol carries them.

## TD-004: Restore loss counted once in the live loss totals

Recorded October 16, 2026 by the coordinator after the ET-015c PR-3 review. **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-015c authorization in [concept.md](../concept.md#et-015c-authorization--october-16-2026)). The owner may revise it.

`recordCompleteness(…, {ifAbsent: true})` reports success both when it inserts the `restore-loss` interval and when an equal row already exists. A telemetry service that records the restore loss of a plugin session therefore cannot tell whether an earlier service in the same plugin session already recorded it, and counts it again. After a service restart in the same plugin session, main's totals since the application started show `restoreLoss` 2 and `lostEvents` twice A − C, while the database holds one row ([recording status](telemetry-service-v1.md#recording-status-et-015c)). The database is correct.

**Future work:**
- `recordCompleteness` with `ifAbsent` should report whether it inserted, so the live loss totals count a restore loss once.
- The trip recorder then counts a restore loss only when it was inserted.

**Until then:** a service restart in the same plugin session overstates `restoreLoss` and `lostEvents` in the live recording status; the totals shown by ET-015c PR-4 are an upper bound in that case. No storage API change is authorized by this entry.

## TD-005: Loss totals hidden while the recording status is unknown

Recorded October 16, 2026 by the coordinator after the advisory review of ET-015c PR-4 (PR #91). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-015c authorization in [concept.md](../concept.md#et-015c-authorization--october-16-2026)). The owner may revise it.

Main keeps the loss totals of earlier service processes in its loss base, but `{state: 'unknown'}` carries no losses ([recording status](telemetry-service-v1.md#recording-status-et-015c)). The dashboard therefore hides the "Gaps recorded since Yukon Union Telemetry started" lines whenever the service fails, exits or restarts, until the next service reports a status; they then reappear with the earlier processes' counts added. After the supervisor's restarts are exhausted the status stays `unknown`, so the totals stay hidden until the application restarts, which starts new totals ([dashboard](app-lifecycle.md#recording-on-the-dashboard-and-in-the-tray-et-015c-pr-4)). The database is correct.

**Future work:**
- Carry main's retained loss totals through the `unknown` state, for example with an optional `losses` field on `unknown`, so the dashboard keeps showing the gaps recorded since start while the service is not running.

**Until then:** the loss lines are hidden while the recording status is `unknown`. No `AppState` contract change is authorized by this entry.

## TD-006: Trip average consumption

Recorded October 17, 2026 by the coordinator with ET-016 PR-5 (decision J21). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-016 authorization in [concept.md](../concept.md#et-016-authorization--october-16-2026)). The owner may revise it.

The SDK's average consumption is the truck computer's running mean, not a value of one trip, and the project has no defined calculation of a trip's own average consumption (for example fuel used over observed distance, with refuels, connection holes and reading gaps accounted for). The journal therefore shows and the [trip export](journal-export.md) writes the trip's fuel used and observed distance as separate stored values, and the SDK mean only per one-second sample, marked as the SDK mean ([journal display rules](journal.md#the-journal-tab-j12j14)).

**Future work:**
- Define a trip average consumption (its formula, which intervals it excludes, and when it is unavailable) and show it in the journal; adding it to the export bumps `formatVersion`.

**Until then:** no trip average fuel consumption is shown or exported. No schema, export format or display change is authorized by this entry.

## TD-007: Truck and trailer identity of late-attach trips

Recorded October 17, 2026 by the coordinator with ET-016b PR-7 (decision J22). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-016 authorization in [concept.md](../concept.md#et-016-authorization--october-16-2026)). The owner may revise it.

A [late-attach trip](trips.md#late-attach-trips-j9) opens from a protocol v1 checkpoint's job. The checkpoint also carries the current truck and trailer configuration, but storage keeps truck and trailer configurations only as rows of `truck.configured` and `trailer.configured` events, so `openAttachedTrip` stores no truck or trailer reference ([storage](storage.md#late-attach-trips-et-016b-pr-7)). The trip gets one only when the game sends `truck.configured` or `trailer.configured` again and that event is committed; until then the journal shows no truck or trailers for it. Configurations the session committed before the checkpoint are not referenced either.

**Future work:**
- Store the checkpoint's truck and trailer configuration with the late-attach trip (checkpoint configuration rows, as for the job), or reference the session's latest committed configurations when they equal the checkpoint's.

**Until then:** a late-attach trip may have no truck or trailer identity. No schema or storage API change is authorized by this entry.

## TD-008: Full trailer configuration list in the trip export

Recorded October 17, 2026 by the coordinator after the ET-016 PR-5 review (round 1). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-016 authorization in [concept.md](../concept.md#et-016-authorization--october-16-2026)). The owner may revise it.

A trip keeps every trailer configuration it was given, but the journal detail carries only the latest 10 in commit order with the trip's `total` ([journal reads](journal.md#read-commands-and-bounds-j5)), and there is no paged trailer read. Trip export format version 1 writes that same `trailers` section ([trip export](journal-export.md#format-version-1)). A trip with more than 10 trailer configurations therefore exports only the latest 10 and `total`; an earlier configuration appears only as a `trailer.configured` event when that event lies inside the trip's J7 timeline window, and otherwise nowhere in the export.

**Future work:**
- A paged trailer read in the storage worker and the journal routing, and an export that writes the trip's complete trailer list, which bumps `formatVersion`.

**Until then:** the export holds at most 10 trailer configurations, with the total. No storage read, IPC or format change is authorized by this entry.

## TD-009: Elevated copy helper for protected game folders

Recorded October 17, 2026 by the coordinator with ET-017 PR-6. Decision P12 (no elevated helper for the MVP) is one the owner agreed to explicitly on October 17, 2026; this entry records the deferred helper (see the ET-017 authorization in [concept.md](../concept.md#et-017-authorization--october-17-2026)).

Plugin setup runs with the user's rights only. When Windows denies access to a game's `bin\win_x64\plugins` folder or the plugin file is read-only, the folder shows `PERMISSION_DENIED` or `READ_ONLY_FILE`, the [Game plugin card](plugin-setup.md#the-game-plugin-card) offers "Show plugin file" and "Open game plugins folder", and the driver copies the verified bundled DLL by hand. A copy with the bundled hash is then adopted on the next run.

**Future work:**
- A separate, minimal elevated helper (a UAC prompt on demand) that copies only the verified bundled DLL into one validated plugins folder, with the same SHA-256 verification, atomic rename and ownership rules as the in-process installer, and no other authority.

**Until then:** protected folders need the manual copy. No elevation, service or scheduled task is authorized by this entry.

## TD-010: Path-aware running-game detection

Recorded October 17, 2026 by the coordinator with ET-017 PR-6 (from decision P7). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

Setup decides that a game or TruckersMP runs by image name only (`eurotrucks2.exe`, `amtrucks.exe`, a `truckersmp*` prefix; [running games](plugin-setup.md#running-games)). Any process with such a name blocks every folder of that game, also one started from another game folder, and a renamed executable is not seen; the operating system's file lock still prevents a change to a plugin a running game has loaded.

**Future work:**
- Match a running process by its image path against each game folder, so that one installation's running game blocks only that folder, without reading other users' processes or needing elevation.

**Until then:** name-based blocking stays conservative. No process inspection beyond the bounded `tasklist` listing is authorized by this entry.

## TD-011: In-app replacement of an unrecognized plugin file

Recorded October 17, 2026 by the coordinator with ET-017 PR-6 (from decision P6). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

A file with the plugin's name whose hash this application does not recognize (not the bundled, a released or the recorded one) is `UNRECOGNIZED_FILE`. It is never replaced, renamed or removed; the card tells the driver to move it away and press Retry ([ownership](plugin-setup.md#ownership-p6)). A plugin copied by hand from a development build is such a file.

**Future work:**
- An explicit, confirmed "Replace this file" action that first moves the unrecognized file to a recoverable backup beside it, then installs the bundled plugin with the usual checks.

**Until then:** the driver moves the file by hand. No in-app replacement or deletion of an unrecognized file is authorized by this entry.

## TD-012: In-place restore of the history database

Recorded October 18, 2026 by the coordinator with ET-018 PR-6 (plan U17). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral** (see the ET-018 authorization in [concept.md](../concept.md#et-018-authorization--october-18-2026)). The owner may revise it.

Storage can restore a verified backup only to a new path ([storage](storage.md)); an earlier version of that page deferred the in-place replacement of the live database to ET-018. ET-018's card covers packaging, upgrades and uninstall, not restore, so ET-018 does not implement it. A user who needs an older history today has no in-app way to put a backup in place of `data\telemetry.sqlite`.

**Future work:**
- An explicit, confirmed restore in the application that stops recording and the storage worker, keeps the current database as a verified backup, restores the chosen backup through the existing verified path and reopens it, and accounts for the coverage the producer has already acknowledged (the `restore-loss` marker of ET-015a).

**Until then:** restore writes only to a new path. No in-place replacement of the live database is authorized by this entry.

## TD-013: Squirrel vendor residue in the binary root

Recorded October 18, 2026 by the coordinator with ET-018 PR-3 (plan U4, which planned this entry for PR-6). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

After an uninstall, Squirrel (the version pinned by electron-winstaller 5.4.4) leaves part of its own binary root `%LOCALAPPDATA%\ETS2TelemetryDesktop`: `Update.exe`, which runs the uninstall and cannot delete itself, `app-<version>\squirrel.exe`, the one-space `.dead` marker, and sometimes an `app-<version>\.dead` marker. Its `DeleteDirectoryOrJustGiveUp` does not retry a file that something holds for a moment, so a stock Electron runtime file can also remain in `app-<version>\`: hosted runs left `v8_context_snapshot.bin` with no process of this application running. Earlier runs left `vk_swiftshader.dll`, `vk_swiftshader_icd.json` and `v8_context_snapshot.bin` while the hook's own GPU and network-service child processes were still ending; PR-3 removed those children. The residue holds no data and no file of this application's own: not the executable, the application archive or the plugin. It is cosmetic: a reinstall replaces the folder (Squirrel logs "already exists, burning it to the ground"), and the folder can be deleted by hand. The installer lifecycle checks the residue strictly ([binary root residue](installer-testing.md#binary-root-residue)).

**Future work:**
- Remove the folder after Squirrel exits, for example from the deferred cleanup at the next sign-in (ET-018 PR-5) or a short-lived helper outside the folder.

**Until then:** the folder stays until a reinstall or a manual delete. Nothing else is authorized by this entry.

## TD-014: Code signing

Recorded October 18, 2026 by the coordinator with ET-018 PR-6. Decision O1, an unsigned internal alpha now and an application to the SignPath Foundation after the first alpha release, is the owner's explicit decision of October 18, 2026 (see the ET-018 authorization in [concept.md](../concept.md#et-018-authorization--october-18-2026)); this entry records the deferred signing.

No file this project builds is signed. `release-identity.json` records each PE image's Authenticode status ([releases](release.md#signing)). Until the builds are signed, SmartScreen shows "Unknown publisher" for Setup, and Smart App Control, when it is on, blocks the application with no per-application override.

**Future work:**
- Apply to the SignPath Foundation after the first alpha is published, and sign the application executable and its execution stub, the broker, the plugin DLL, Setup, `Update.exe` and `squirrel.exe` with RFC 3161 timestamps, from CI without keeping a private key in the repository.
- Sign the plugin DLL before the build stages it, so that the bundle manifest, the install registry's ownership hashes and the released plugin list name the signed bytes.

**Until then:** releases are unsigned internal alphas, labelled so. No certificate, signing service or paid product is authorized by this entry.

## TD-015: Only the win32-x64 better-sqlite3 binding in the package

Recorded October 18, 2026 by the coordinator with ET-018 PR-6, from the PR review. **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

The x64 package carries every prebuilt binding that better-sqlite3 13.0.3 ships under `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/`: `win32-x64.node`, which the storage worker loads, and `win32-arm64.node`, `darwin-arm64.node`, `darwin-x64.node`, `linux-arm64.node`, `linux-x64.node`, `linuxmusl-arm64.node` and `linuxmusl-x64.node`, which Windows x64 never loads. `release-identity.json` lists them (the PE images in `peImages`, the ELF and Mach-O ones in `foreignNodeAddons`; [releases](release.md#release-identity)). They add size and unsigned native files to every release without any use.

**Future work:**
- Package only `prebuilds/win32-x64.node`, through the Forge `ignore` filter or an `afterCopy` hook, and add an `inspect:package` assertion that no other prebuild is present, while the storage worker still resolves its binding.

**Until then:** the package ships all prebuilds, and the release identity records each with its hash. No packaging change is authorized by this entry.

## TD-016: A stale checkpoint's job ended inside a replayed gap

Recorded October 18, 2026 by the coordinator with the ET-016 stale-checkpoint fix (ET-019 finding F1). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

A checkpoint's state is the slot published at the last frame boundary (OD-5 S7), while its `nextEventSeq` is the end of the event store (OD-5 S11), so the state can lag the replayed events ([trips](trips.md#stale-checkpoints)). The fix drops a pending late-attach trip when a replayed `job.cleared`, `job.configured` or outcome carries configuration-revision evidence that the checkpoint's job ended or was replaced. A replayed gap carries no revision, and the checkpoint state carries no source-clock time to compare with the gap's lost times. When a lagging state's job was cleared or delivered inside a replayed gap, for example an offline gap within the last frame before a connection, the late-attach trip still opens for a job that may have ended. It is partial with its `late-attach` interval, and the gap is stored as a session-level interval, but the trip itself may not correspond to an active job.

Dropping the late-attach trip at every replayed gap is not an option. J9's main case is a job accepted while the application was absent: its events are offline loss, so the replay before the trip opens is exactly such a gap (`app-absent-hydration`). That rule would lose the trip that J9 and REG-003 require. The window is the same one as F1: at most about one frame at a connection, or more after a skipped try-lock.

**Future work:**
- Give the consumer evidence to order a replayed gap against the checkpoint state, for example the state's publication time in the source clock, or the configuration revision of the lost range. Either is a protocol v1 change and needs its own decision. With it, drop the trip only when the gap provably lies after the state's publication.
- Observe real late-attach checkpoints from both games to measure how often the window occurs.

**Until then:** the behaviour above stands, the trip stays partial, and no wire, schema or native change is authorized by this entry.

## TD-017: Coverage-guided fuzzing (libFuzzer / native)

Recorded October 19, 2026 by the coordinator with ET-019 PR-9 (decision D5 of the ET-019 plan). **This entry is a coordinator decision under the owner's standing delegation of October 15, 2026, not an individually owner-approved deferral.** The owner may revise it.

The protocol parsers are fuzzed only by seeded mutation: `tests/unit/protocol-fuzz.test.ts` mutates the valid shared fixtures for the TypeScript payload decoders, frame decoders and broker stdout readers ([ET-019 validation](validation/et-019.md#pr-9-seeded-mutation-fuzzing-of-the-typescript-frame-parsers-october-19-2026)), and the native CTest cases `snapshot-transport-contract-fuzz`, `v1-producer-contract-fuzz` and `v1-transport-contract-fuzz` run fixed seeded mutations of their own. Neither is guided by coverage: a mutation that reaches a new branch is not kept and mutated further, so a defect behind a deep chain of conditions can stay unreached however many inputs run. The C++ parsers (`protocol-v0.cpp`, `protocol-v1.cpp`, the CAP0 hello and the broker's stdin control stream) have no generated-input campaign beyond those cases.

**Future work:**
- Add coverage-guided fuzz targets for the C++ v0, v1 and CAP0 decoders and the broker control stream, for example libFuzzer with AddressSanitizer in a separate clang-cl build, seeded from the shared fixtures, with a bounded run in the extended CI job and the corpus kept outside the repository unless reviewed.
- Consider a coverage-guided JavaScript fuzzer for the TypeScript decoders once one fits the pinned toolchain without install scripts.
- Done in ET-019 PR-10 (October 19, 2026): `ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER` multiplies the iteration counts of the three native seeded fuzz cases (default 1 on PR runs, x50 in the `Windows x64 extended campaigns` job; plan decision D4). The seeds are unchanged; see [the extended campaigns](ci.md#et-019-extended-campaigns). This makes the seeded campaigns longer, not coverage-guided.

**Until then:** the seeded campaigns above are the only generated-input coverage of the parsers. No new toolchain, dependency, CI job or native build is authorized by this entry.

## TD-018: A broker that exits mid-session is not restarted (resolved by ET-034)

Recorded October 19, 2026 by the coordinator with ET-019 PR-8 ([finding](validation/et-019.md#pr-8-findings)). **This entry was a coordinator decision under the owner's standing delegation of October 15, 2026.** Resolved October 19, 2026 by ET-034.

The documented recovery rules make exit 1 after an authority receipt final: telemetry-service-v0.md says "Exit 1, receipt/relay violations and protocol or identity failures remain final incompatible states", and E9 gives "other broker rejections" `incompatible` with no reconnection ([telemetry service v1](telemetry-service-v1.md#reconnection-e9)). The source stays `incompatible` until the user selects it again. A broker that crashes, or that the user or an antivirus product kills (the alpha is unsigned, TD-014), exits like an authority failure: `TerminateProcess` gives exit code 1, and the only difference is the missing diagnostic line (stage `unreported`). So such an exit stops both the v0 overlay feed and v1 for that game, although the plugin session survives and a fresh broker would resume it with nothing lost (`tests/integration/v1-chain-process-death.test.ts`, case 1).

**Resolution (ET-034, October 19, 2026):**
- An exit after an authority receipt is classified as retryable `disconnected` with the E9 backoff when either holds:
  - it reports no diagnostic stage (`unreported`);
  - it carries a crash exit code (`code === null`, `code < 0`, `(code >>> 0) >= 0x80000000`, or `code > 4`).
- Diagnosed authority failures (exit 1 with a known diagnostic stage) and pre-receipt rejections remain final `incompatible` states.
- Reconnection rules amended in `docs/telemetry-service-v0.md` and `docs/telemetry-service-v1.md` (E9).
- Integration test in `tests/integration/v1-chain-process-death.test.ts` case 1 extended to verify that a killed broker restarts within the E9 backoff, reconnects, and resumes the plugin session without loss or duplicates, while diagnosed authority failures remain final.

## TD-019: Stale discovery records accumulate (resolved by ET-033)

Recorded October 19, 2026 by the coordinator with ET-019 PR-8 ([finding](validation/et-019.md#pr-8-findings)). **This entry was a coordinator decision under the owner's standing delegation of October 15, 2026.** Resolved October 19, 2026 by ET-033.

A crashed or killed game leaves its v0 and v1 discovery records behind. Before ET-033, `native/telemetry-plugin/src/pipe-discovery.cpp` removed only its own record in its destructor, the client never deleted records, and `native/telemetry-client/src/client.cpp` counted every UUID-named `.json` record before the game filter and the liveness check, failing closed above 128 records or 256 directory entries; a reused PID whose `OpenProcess` returned `ERROR_ACCESS_DENIED` also failed discovery closed.

**Resolution (ET-033, October 19, 2026):**
- During directory enumeration, `native/telemetry-client/src/client.cpp` validates all ten record fields for both `ets2` and `ats`, checks process liveness before counting records toward the 256-entry / 128-record bounds, and sweeps demonstrably stale records via `sweep_stale_record` (`CreateFileW` with `DELETE | READ_CONTROL`, `FILE_SHARE_READ | FILE_SHARE_DELETE`, and `FILE_FLAG_OPEN_REPARSE_POINT`, tolerating `ERROR_FILE_NOT_FOUND`, `ERROR_DELETE_PENDING`, and `ERROR_SHARING_VIOLATION`, then `SetFileInformationByHandle(FileDispositionInfo)`) while preserving ownership, ACL, reparse and `BY_HANDLE_FILE_INFORMATION` identity checks ([native transport boundary](native-transport-boundary-v0.md#discovery-and-service-policy)).
- When `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid)` returns `ERROR_ACCESS_DENIED` on a reused PID, the broker probes `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)` + `GetProcessTimes` (failing closed if that process is still live with the recorded `processCreationTime`, or sweeping immediately if that open returns `ERROR_INVALID_PARAMETER`) and then sweeps the record only when **both** the derived pipe endpoint does not exist (`WaitNamedPipeW` returns `ERROR_FILE_NOT_FOUND`) **and** `sweep_stale_record` succeeds; otherwise it fails closed at stage `server-process`.
- Covered by `native-pipe-client-{creation,dead,stale-live,dead-live}` (including 260 stale records alongside one live server, reused inaccessible PIDs, >256 non-record entries and >128 live records) and `tests/integration/v1-chain-process-death.test.ts` case 2.

## TD-020: Gearbox labels the SDK cannot describe

Recorded October 25, 2026 by the coordinator with ET-050b PR-6 ([validation](validation/et-050b.md)). **This entry was a coordinator decision under the owner's approval of ET-050b (B1–B9).**

ET-050b derives manual gear labels from the SDK H-shifter layout, because the SDK exposes no transmission names. The derivation cannot know:
- the game's own gear names (`transmission_names` in the truck definitions), so a modded or unusual gearbox may differ from the in-game dashboard;
- reverse names such as `RL`/`RH` or `RLL`, so reverse stays `R1`…`Rn` (B4);
- the crawler naming of each gearbox: since the amendment of October 26, 2026 the crawler is named by game (ETS2 `C1`/`C2`, ATS `LL`/`LH`, B5). Only `C1` on an ETS2 Scania GRSO925R was observed; `C2`, the unsplit ETS2 `C` and other ETS2 crawler gearboxes are unobserved; two gearboxes with the same H-shifter layout can be named differently (the ETS2 Scania G38CMR 13+1 reads `C, 1, 2, 3…` where the GRSO925R reads `C1, C2, 1L…`), which the user covers with the `crawler` display mode chosen per game (owner option B, October 26, 2026);
- layouts whose low range holds more than one extra cell (more than one crawler), which fall back to the formula; and any range layout whose low range holds exactly one more cell than its high range is labelled as having a crawler;
- a truck change without a following `hshifter` callback: the previous layout stays with the new truck's counts until the counts disagree with the slots (then the formula) or a new callback arrives, so a window with the old layout's labels is possible when the counts happen to match. Since the crawler gear mode of October 26, 2026 only the forward count is checked against the slots, because the H-shifter may reach fewer reverse gears than the truck has; a new truck that differs only in its reverse count no longer reveals a stale layout, although reverse still reads R1…Rn.

**Until then:** the formula is the fallback, and the owner's real-game checks decide whether any of these needs work. Reading game files or adding a model table is not authorized by this entry.

## TD-021: The session's protocol minor in the stored identity

Recorded October 25, 2026 by the coordinator with ET-050b PR-6, from the PR-5 review. **This entry was a coordinator decision under the owner's approval of ET-050b (B1–B9).**

`upsertSession` in `packages/storage/src/sqlite/writes.ts` compares `protocol_minor` with the stored plugin session, so a minor change within one plugin session is `SESSION_CONFLICT`, which the durable sink maps to `unavailable` (fail-closed, nothing lost). Plugin setup never replaces the DLL while a game runs, so a supported update cannot cause it; it occurs only after an application downgrade during a game session with a minor-1 plugin loaded, or with a development build that has PR-4 but not PR-5. Release constraint (ET-052): the claim that a supported update cannot cause it (plugin setup never replaces the DLL while a game runs) holds only if the plugin that serves minor 2 (PR-3) and the application that offers minor 2 (PR-4) ship in the same release. A release with PR-3 but not PR-4 has a plugin that can serve minor 2 while the application offers 1: the application records a session at minor 1 (`plugin_sessions.protocol_minor` = 1), and if the user then updates to the PR-4 build (which offers 2) while that game is still running, the same plugin session negotiates minor 2, `upsertSession` fails with `SESSION_CONFLICT`, recording fails closed until the game restarts, and nothing committed is lost. `GAME_HISTORY_RECORDING` is true, so this path is reachable. It is not a code defect in PR-3; PR-3 and PR-4 must be released together, or the owner must explicitly accept the conflict. No release is authorized by this work.

**Before `GAME_HISTORY_RECORDING` is enabled,** the enablement PR decides whether `upsertSession` should stop comparing `protocol_minor`, keeping the first-seen minor in `plugin_sessions` and the per-event minor in `events.protocol_minor`. No schema or storage change is authorized by this entry.

**Resolution (October 25, 2026):** the game history recording enablement ([AGENTS.md](../AGENTS.md#game-history-recording-enablement--october-25-2026)) keeps `upsertSession` comparing `protocol_minor`. A minor change inside one plugin session stays `SESSION_CONFLICT`, which the durable sink maps to `unavailable`: recording stops for the service lifetime and fails closed, and nothing committed is lost. Plugin setup never replaces the DLL while a game runs, so a supported update cannot cause it. This is a coordinator decision under the owner's enablement authorization; relaxing the comparison is a storage change for its own package if a real session ever needs it. The ET-052 release constraint in the entry above qualifies the claim that a supported update cannot cause it.

## TD-022: Delta update packages

Recorded October 28, 2026 by the coordinator with ET-055 PR-6. **This entry is a coordinator decision under the owner's approval of ET-055 (UP3); the plan lists delta packages as out of scope.**

The in-app update downloads the full nupkg (`<Squirrel id>-<NuGet version>-full.nupkg`, at most 400 MiB) every time. Squirrel can apply delta packages, which would make an update smaller, but a delta needs the exact previous full package as its base, its own entry in RELEASES and its own hashes in the signed manifest. Supporting it means extending manifest v1 (a new format version), the release workflow and the RELEASES line the application writes, plus a full-package fallback when the base is missing. Until then every update is a full download.

## TD-023: Authenticode check of a downloaded update

Recorded October 28, 2026 by the coordinator with ET-055 PR-6. **This entry is a coordinator decision under the owner's approval of ET-055 (UP5).**

The download's integrity rests on the Ed25519-signed manifest: its size, SHA-256 and SHA-1 must match before Squirrel applies the package. Builds are unsigned ([TD-014](#td-014-code-signing)), so the application does not check an Authenticode signature of the new executable. Once releases are code signed, the updater should also verify, before `Update.exe --update`, that the package's executables carry a valid signature of the project's certificate, as a second, independent check. That needs the package to be opened before the apply and a pinned signer identity; it waits for TD-014.

## TD-024: No setting to turn update checks off

Recorded October 28, 2026 by the coordinator with ET-055 PR-6, after the owner's UP6 decision of October 28, 2026 that checks run at launch and every 6 h with no setting to disable them.

An installed build always checks its channel's feed: 15 s after its first readiness and every 6 h. It sends no identifier, but GitHub sees the IP address of every check, and a network that blocks GitHub turns every check into a silent `OFFLINE`. A user who does not want the check has no switch; an isolated or portable launch is the only launch that never checks. A future setting would need a settings format version, a narrow setter and the user guide; it needs the owner's decision first.
