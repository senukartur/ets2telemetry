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
