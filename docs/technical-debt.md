# Technical Debt and Deferred Capabilities

These entries record owner-approved deferrals. They do not expand the current milestone or establish an implementation choice.

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
