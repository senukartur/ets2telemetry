# Native game-window monitor

ET-007 adds an SDK-independent `ets2telemetry::window::Monitor`. It copies one latest typed `Snapshot`; it does not serialize messages, retain window history, render an overlay, or call the SCS API. The accepted protocol v0 and SDK adapter remain unchanged. **Transport serializer binding is pending**: no game-window metadata is currently published through a pipe by this package. ET-008 must consume the agreed physical-coordinate contract through the centrally integrated transport; it must not treat a numeric HWND as renderer authority.

## Identity and lifecycle

`start(sdk_game_id, plugin_session_id)` verifies the actual current process using a retained `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)` handle, `QueryFullProcessImageNameW`, `GetProcessId`, `GetProcessTimes`, and `ProcessIdToSessionId`. `eut2` requires basename `eurotrucks2.exe`; `ats` requires `amtrucks.exe`. An SDK claim alone is rejected. The retained creation token and Windows session are checked on each poll. This verifies the loaded host's executable name and lifetime, not its publisher signature or the authenticity of arbitrary renamed executables. The monitor does not scan/open another game's process or read game memory.

The SDK export creates the monitor only after successful adapter initialization. Official shutdown signals, joins and retires it before unregistering SDK callbacks. There is no DllMain and no static-destructor thread join. The SDK must call its official shutdown before unloading the plugin; forced DLL removal while its worker runs is unsupported. Lifecycle methods have a single SDK-thread owner; `latest()` may be called concurrently and returns an owned fixed-size copy. A failed identity check leaves telemetry initialization available but window metadata `identity_rejected`; this avoids inventing a window in a foreign SDK test host.

The worker owns a 50 ms polling/message loop and an out-of-context destruction WinEvent hook. Hook callbacks only invalidate the tracked window identity; they never call SCS, serialize, allocate an application event queue, or send messages to the game window. Each iteration drains at most 256 messages and enumerates at most 4096 top-level windows, checking cancellation. A saturated drain, failed DPI/hook/query operation, or incomplete enumeration produces unavailable metadata. There is one latest slot, no spool, and no durable event semantics. The 50 ms cadence is independent of 1 Hz history sampling.

`stop()` signals an owned event and joins the worker; waits are cancellation-aware. The worker unhooks and restores its previous thread DPI context before exiting. Controlled tests assert a measured stop under 500 ms; Windows scheduling and synchronous system queries prevent interpreting that measurement as a universal hard real-time guarantee. No process is terminated by this component.

## Selection and invalidation

Candidates must be actual current-process top-level root windows, have no owner window, lack `WS_EX_TOOLWINDOW`, and be visible. More than one eligible candidate fails closed with `ambiguous` and zero public HWND. An already tracked valid hidden/minimized window is retained and reported with visibility/minimized flags. A different newly visible candidate while the tracked identity survives also remains ambiguous across polls, rather than silently choosing a different window. Destroying/invalidation of the tracked window clears it; a subsequent unique selection advances `window_generation` even when an observed destruction is followed by reuse of the numeric HWND. Repeated observations of the same identity do not advance its generation. `revision` advances on publication and across restart; these counters are local to a Monitor object, with SDK session identity retained separately.

Ownership is checked before and after geometry queries, and a destruction hook is required for availability. Windows observations are asynchronous: consumers must use the captured state as transient metadata, not as authorization to operate on an HWND. The controlled fixture observed recreation with a different numeric handle; numeric reuse and game-specific recreation remain pending actual observations.

## Coordinate and availability contract

The worker sets and verifies `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` using `SetThreadDpiAwarenessContext`, and restores it on exit. It never changes process-wide or game-thread DPI awareness. `GetClientRect` plus `ClientToScreen` acquire the client area in desktop physical pixel coordinates in this explicit querying context. Signed `x/y` preserve negative monitor origins; unsigned width/height describe extents. `MonitorFromWindow`/`GetMonitorInfoW` report the nearest monitor's physical desktop bounds. `GetDpiForWindow` is the window's effective DPI, which depends on that window's awareness; it is not a substitute for Electron's monitor conversion. ET-008 uses `screenToDipRect` for Electron placement. Actual game/DPI behavior still needs the REG-016 matrix.

`Status::available` means a validated window identity and visibility/minimize/foreground/monitor metadata are available. `client_bounds_available` separately states whether the current positive-size client rectangle was acquired. Actual minimized Windows fixtures returned 0x0 client geometry: the monitor keeps their minimized identity with `client_bounds_available=false` and empty bounds; it never repeats cached geometry as current. A later serializer must explicitly omit/unavailable a v0 window payload when its required geometry is unavailable, and the consumer must hide its overlay. That integration and its contract tests are pending.

Foreground means exact equality with `GetForegroundWindow()`. The monitor never requests foreground, changes focus/z-order, injects input, modifies game window styles, or installs rendering hooks. `display_mode` is always `unknown`: client/monitor geometry and window styles cannot prove windowed/borderless/exclusive rendering. Exclusive fullscreen injection is outside scope.

## Verification

The controlled console test uses real owned Windows windows and a separately owned process fixture, shown with no activation. It checks rejection of false SDK claims, actual PID separation, physical negative bounds, DPI context isolation, move/resize, all available monitor moves, tool/owned-window exclusion, stable ambiguity, hidden/minimized/restore state, destruction/recreation, concurrent readers, cancellation and restart. CTest bounds the parent; the peer has its own finite exit deadline, readiness/stop events and normal owned cleanup. The `ETS2TELEMETRY_WINDOW_TEST_HOST` override is compiled only into separate console-test libraries, absent from the production monitor/DLL target. ASan copies instrument those console libraries only.

See [the validation record](validation/et-007.md) for measured outcomes and missing acceptance evidence. No controlled window test establishes real-game focus/input safety, TruckersMP compatibility, exclusive/borderless detection, mixed-DPI behavior on absent displays, or overlay acceptance.

## Primary references

- [Microsoft: GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)
- [Microsoft: SetThreadDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext)
- [Microsoft: High DPI desktop application development](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)
- [Microsoft: SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
- [Microsoft: Process and thread functions](https://learn.microsoft.com/en-us/windows/win32/procthread/process-and-thread-functions)
