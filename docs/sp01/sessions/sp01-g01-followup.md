# SP01-G01 follow-up: Alt+Tab, input and natural app exit

Recorded October 11, 2026. **G01 remains partial.** This separate follow-up supplies observations missing from the [initial attempt](sp01-g01.md); its natural exit does not relabel the initial deadline **124** as passing. See the [current session checklist](../game-checklist.md) and [validation record](../validation.md). PR [#8](https://github.com/senukartur/ets2telemetry/pull/8) remains draft and ET-002a remains gated.

## Frozen identity and duration

| Item | Recorded identity / boundary |
| --- | --- |
| Runtime source | `415bfacb56b567d253947e059bcb89c2192d7e5c`, branch `feat/sp-01-game-overlay-spike`; later documentation commits are not labeled as this run's tested source |
| Input comparison | All ten recorded runtime artifact hashes match the initial `fc80688653588ce82375e6b93319091d31063c1d` manifest |
| Game / context | ETS2 executable 1.61.1.1; Steam build 25482642; requested ETS2 / TruckersMP borderless follow-up in the owner's previously confirmed context; exact client version uncollected |
| SDK | Archive 1.15 SHA256 `77504F14D2AC1405BA70EE3A97351662ADBB39C0CF9D3A085423F01D37BC28EC`; static game-log lines report telemetry API 1.01 and game API 1.20 / eut2 |
| DLL | SHA256 `0583DEC72B3A712E02F03CD94218E6DB81FBBF915441AF5915B4A662873344ED` |
| SDK license | SHA256 `DA45FFCA18F44F1FD26B4FB8DA8767BBF0F052799C60838C1E8FBEE4FBE07B50` |
| Electron executable | SHA256 `2529B494F4123F152BCE346051F7BD855EF95006424A561953CF17C49A3D1BA8` |
| Approved maximum | 600,000 ms (ten minutes), not the observed run duration |
| Actual app wrapper interval | 10:37:19.1633855–10:41:36.5274467 UTC; about 257.364 s / 4m17s |
| Containment | 16 processes / 2 GiB / 25% CPU / kill-on-close; game excluded from app Job |

No new exact multiplayer client, renderer security, monitor/DPI or display-mode measurement is inferred from this follow-up. The local manifests retain source/build identities without copying personal paths or SID into Git.

## Owner observations and raw receipts

| Criterion | Evidence | Boundary |
| --- | --- | --- |
| Overlay returns after Alt+Tab | Owner observation 1, 10:44:23.3963826 UTC | Manual observation; initial run had not tested return |
| Values continue updating after return | Explicit owner clarification 2, 10:44:58.1779607 UTC | No numeric accuracy or latency measurement |
| Keyboard/mouse work; no focus loss noticed | Owner observation 1 | No instrumented focus trace or proof for untested window/DPI changes |
| Clicks reach game elements beneath the overlay | Explicit owner clarification 2 | Specific manual pass-through observation |
| Overlay disappears after **Exit SP-01** | Owner observation 1 | Tray action reported by owner |
| App/service terminate naturally | App launch receipt exit 0, `normalCompletion=true`, null error; stdout `SP01_SERVICE_EXIT:0`; app stderr empty | Natural Job completion within maximum, not forced deadline cleanup |
| No problems noticed; game closed after actions | Owner observation 1; later process inventory empty | No independent game exit code, performance or stability proof |

The follow-up before capture at **10:37:01.0868643 UTC** already contained two project static load/API lines. After capture at **10:44:23.7429164 UTC** retained those lines with `beforeProjectLineCount=2`. This is not fresh zero-baseline DLL-load proof; the initial attempt's zero-before capture remains the separate load evidence. Neither capture is an SDK callback corpus or production ACK test.

## Installation, cleanup and retained evidence

The two exact project files were installed from the frozen inputs at **10:37:03.8375823 UTC**, with installation finishing at **10:37:05.0485975 UTC**. After owner game closure and process checks, receipt-owned removal occurred at **10:44:25.6433966 UTC**. Independent verification at **10:44:26.0236993 UTC** found both project files absent, nine unrelated plugin hashes and lengths identical to the install inventory, and no game/client/app processes. No unrelated plugin or directory was removed.

Ignored evidence roots in the coordinator's control checkout are `.local/sp01-manual/g01-20261011-followup1` and `g01-followup-preparation`. They preserve candidate inputs, preparation review, duration/deadline, install/remove, before/after capture, launch/stdout/stderr, owner observations and cleanup verification. Keep raw logs, personal paths, SID, player/account text and browser-profile files out of Git. The original capture/launcher failures, initial deadline 124 and failed synthetic run remain in their original evidence roots.

## Remaining scope

G01 still needs exact client and remaining environment metadata; stopped/reverse/fuel-unit accuracy and unavailable channels; pause/resume/save or menu discontinuities; minimize/restore/window recreation; monitor/DPI changes; game-first launch and app restart/reconnect; comparable with/without CPU/memory and frame-time observations; and defined latency measurement. Game closure was reported, but its independent exit code was not recorded.

G02 ATS / TruckersMP borderless, G03 one single-player windowed session, G04 one Convoy session and the proceed/investigate/retire decision remain pending. Longer stability remains unverified and belongs to later sustained-recording/release validation. No SP-01 acceptance, full TruckersMP compatibility, real history, CAP-01 corpus or wholesale production source promotion is claimed.
