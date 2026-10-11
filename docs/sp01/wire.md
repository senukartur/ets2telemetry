# Experimental SP-01 wire format

This format is deliberately separate from the future shared production contracts. `v` is exactly `sp01-1`. Transport is newline-delimited UTF-8 JSON over the DLL-owned byte-mode Windows Named Pipe. A frame excluding newline is at most 2,048 bytes. The decoder retains at most that many incomplete bytes and rejects malformed UTF-8, invalid JSON, oversized frames/chunks, incompatible game/version, changed session on an existing connection, and non-increasing wire sequence. Network chunks are limited to 65,536 bytes. No inbound commands or ACKs are supported by the DLL.

Endpoint: `\\.\pipe\ETS2Telemetry.SP01.<current-user-SID>.<eut2|ats>`. The protected DACL grants access only to that user; `PIPE_REJECT_REMOTE_CLIENTS` rejects remote access, and `FILE_FLAG_FIRST_PIPE_INSTANCE` refuses an existing server collision. Only one client instance exists. A different local process with the same user's rights is not an authenticated game source; this experimental transport makes no stronger identity claim. The app retries every 250 ms and clears readings on disconnect/invalid input. Each plugin initialization generates a 32-digit hexadecimal GUID-derived session identity. Reconnection keeps that identity and continues increasing wire sequence.

| Field | Type and meaning |
| --- | --- |
| `session`, `game`, `v` | 32 lowercase hexadecimal digits; `eut2` or `ats`; exact experimental version |
| `seq` | Increasing serialized-message number as a decimal uint64 string; heartbeats included |
| `frame` | SDK frame-end callback counter, decimal uint64 string; can repeat in heartbeats |
| `renderUs`, `simulationUs` | Raw SDK microsecond timestamps as decimal uint64 strings; may restart; not UTC |
| `dropped` | Queue-overflow count as decimal uint64 string; no event-completeness claim |
| `speedMps`, `fuelLitres` | Finite number or `null`; SDK speedometer m/s and remaining liters |
| `paused`, `timerRestart` | SDK pause state and most recently copied frame restart flag |
| `window` | `visible` boolean and integer physical-screen `x`, `y`, `width`, `height` |

The app accepts speed from -200 to 200 m/s, fuel from 0 to 100,000 L, screen coordinates ±100,000 and nonnegative dimensions up to 100,000. Visible dimensions must be positive. Numeric zero is valid. NaN/infinity and negative fuel serialize as unavailable. Extra incoming fields are removed before crossing the UI boundary. Sequence/timestamps are strings to preserve uint64 precision beyond JavaScript's safe integers.

The SDK queue is single producer/single consumer because the official SDK calls the plugin from one game main thread. Full queues drop new frames and count them; the worker drains queued snapshots to the newest available value. Frame counter gaps also reveal ordinary coalescing. A missing/slow client cannot execute I/O or take a lock in a callback. Connect/write operations use overlapped I/O, a 100 ms operation deadline, and a stop event. Cancellation is completed before releasing its OVERLAPPED/buffer; shutdown waits for that Windows cancellation completion. Console checks establish observed bounded completion, not a universal OS scheduling guarantee.

Foreground visibility comes from a window owned by the current game PID, excluding minimized/invisible windows. Windows screen rectangles are converted to Electron DIP coordinates with `screenToDipRect` before placement. This requires actual mixed-DPI/monitor validation. A heartbeat refreshes visibility even while paused. No reading is current after 500 ms without a received heartbeat or after one second of unchanged frame count while unpaused. Hidden/disconnected windows clear their UI readings as well. End-to-end 200 ms latency remains an unmeasured target: SDK and app clock domains are not mapped here.

Native console transport tests use unique PID/tick names. SDK callback tests compile the same plugin source into a console harness with an exclusive per-PID `.sdk-test.<pid>` suffix; the actual game DLL has no such override. The synthetic desktop fixture uses `.synthetic.<pid>`, explicitly selected by the smoke client, and never occupies the game endpoint.
