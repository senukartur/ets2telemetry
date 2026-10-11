# SP-01 required actual game sessions

SP01-G01 has **partial actual-session evidence**; the remaining sessions and unobserved G01 criteria are pending. See the [initial G01 record](sessions/sp01-g01.md) and [follow-up](sessions/sp01-g01-followup.md) for owner observations, raw-receipt boundaries, failed launches and cleanup. Executable discovery, SDK-derived code, replay and native/synthetic tests do not establish compatibility. Coordinate the frozen candidate, safe project-only DLL installation, app process containment and duration with the owner before starting. Native Windows CUA APIs are disabled in this environment; the owner supplies game interaction. Do not automate driving, account input, purchases or client installation.

Run the early sessions in this order:

| Session | Game/client | Display mode | Status |
| --- | --- | --- | --- |
| SP01-G01 | ETS2 / TruckersMP (owner confirmed; exact client version uncollected) | Borderless (owner confirmed context) | Partial October 11: initial load/values/hide; follow-up owner-confirmed return/updates/input/click-through/tray action and natural app/service exit 0; mandatory observations incomplete |
| SP01-G02 | ATS / TruckersMP | Borderless | Pending |
| SP01-G03 | One of ETS2/ATS / single-player | Windowed | Pending |
| SP01-G04 | One of ETS2/ATS / Convoy | Windowed or borderless; record actual mode | Pending |

These four sessions are only SP-01. Full ET-009 later requires both games × single-player/Convoy/TruckersMP × windowed/borderless, plus CAP-01 and the production prototype criteria.

G01 does not check off a complete session. The follow-up owner confirmed Alt+Tab return with continuing updates, working keyboard/mouse without observed focus loss, clicks reaching game elements beneath the overlay, and overlay disappearance after tray exit; raw receipts establish natural app Job completion and service exit 0. These are manual observations, not instrumented focus or accuracy measurements. Exact client/environment metadata, stopped/reverse/fuel comparisons, unavailable channels, pause/resume, minimize/restore, window recreation, DPI/monitor changes, game-first launch, app restart/reconnect, comparable performance and latency remain unchecked. Two initial cumulative OS CPU/memory samples do not satisfy performance measurement. The initial run's deadline exit 124 remains separate from the follow-up's natural exit 0; no independent game exit code was collected.

For **each** session record: UTC start/end; candidate commit and app source/build hashes; installed DLL and SDK archive SHA256; archive 1.15/API 1.01 and SDK-reported telemetry game API version; exact game/client executable/product/build versions; Windows build; CPU/GPU/driver/RAM; monitor arrangement/resolution/refresh/DPI; display mode; ordinary/elevated privileges; launch order; game test profile identifier without player personal data; evidence artifact IDs; result and unresolved observations. Discovery versions in [validation](validation.md) must be reread at the session, especially after game/client updates.

1. Verify the game log reports `ETS2Telemetry SP-01 loaded` and SDK game/API version. Record a denied plugin load or unsupported client explicitly. Never work around rejection using a rendering hook or arbitrary memory read.
2. Compare actual stopped and moving speed/fuel to game displays. Verify stopped speed is zero, reverse speed displays its magnitude, fuel unit is liters, and missing channels show `—`. A pause indicator should match the observed SDK state; no trip average or journal is claimed.
3. Drive with the overlay visible. Click controls beneath the overlay, move the mouse, and use keyboard controls. Confirm focus stays with the game and the window never takes it on showing/moving. Capture a short safe stationary input observation before driving.
4. Alt+Tab to another application, minimize/restore, and reopen a game window. Record disappearance/reappearance and any stuck overlay or stale reading. REG-016 needs actual observations, not only BrowserWindow flags.
5. Move the window or change monitor/DPI where available. Record placement with monitor origins and scales; unavailable hardware combinations remain pending. Do not infer mixed-DPI support from one monitor.
6. Exercise app-first and game-first launch order across the sessions; close/restart the app while the game continues. Check reconnect and current values. The plugin must not stall a game without a reader. Do not pretend unobserved launch order passed.
7. Pause/resume, load a save or return to the main menu, and resume. Record discontinuities and channel availability. This experiment has no accounting data to preserve and no offline history.
8. Exit SP-01 through its tray; observe utility child and app termination. Then close the game/client and inspect its normal shutdown. Restart only if needed to investigate a recorded failure; preserve the original result.
9. Record comparable CPU/memory and game frame-time observations with and without the overlay. State the measurement method and duration. A short session is not a one-hour performance guarantee.
10. If measuring the 200 ms display target, define clock mapping or a bounded capture method first (for example synchronized high-frame-rate capture of a known game-visible speed transition and overlay transition, with frame quantization/error bounds). Raw SDK time minus app time is invalid without mapping. Otherwise mark latency **unmeasured**.

After sessions, record a concise observed-failure list and the proceed/investigate/retire decision. Any required missing or failed session keeps SP-01 incomplete and ET-002a gated. Decide whether to retire this experiment or extract specific proven findings into separately reviewed production work; no automatic source promotion.
