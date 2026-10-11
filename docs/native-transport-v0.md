# Native snapshot transport v0

ET-004a adds the Windows x64 plugin-side pipe server. It consumes only `Adapter::read_latest`, `read_current`, and `set_consumer`; the transport worker never calls an SCS API. SDK callbacks retain fixed-size copied state and use the adapter's nonblocking publication policy. JSON construction, policy inspection, hashing, discovery publication and overlapped pipe I/O belong to the transport thread. No gameplay effects, historical samples, disk spool, durable ACKs or v1 redelivery are implemented.

## Lifecycle and bounds

The explicit SDK initialization starts one owned worker. SDK shutdown signals its stop event, cancels synchronous inspection I/O on that owned thread, waits for overlapped cancellation completion, joins it, then shuts down the adapter. There is no custom `DllMain` and no detached worker. A worker, its operation buffers and events remain alive until cancellation completion is observed, including `CancelIoEx` completion races. Shutdown measures elapsed milliseconds; over 1,000 ms reports `shutdown_deadline_exceeded` rather than success. The join deliberately remains mandatory if an OS operation exceeds that target: returning while code still runs would make DLL unloading unsafe. The measured tests establish controlled local behavior, not a universal kernel/driver deadline guarantee.

Initialization waits at most 1,000 ms for local security, endpoint creation and discovery publication, using a dedicated startup-completion event signalled before any client connection/handshake. Failure or timeout cancels/joins the worker and unregisters the adapter before returning `SCS_RESULT_generic_error`. After validated SDK initialization parameters, the direct initialization caller invokes `common.log` once with a fixed sanitized error: `worker-creation`, `identity-security`, `source-identity`, `endpoint-creation`, `discovery-publication` or `timeout`. No path, exception text or peer payload enters that log. The pinned SDK readme permits game API calls only on the game's calling thread during a direct invocation; the worker never invokes the logger. Frame callbacks do not wait. Mandatory cancellation completion/join can extend total failed-init return beyond the 1,000 ms startup wait under slow OS I/O; a timeout is never reported as successful initialization. Runtime failures after successful startup retain failed status and retire the endpoint; additional runtime SDK logging is deferred, with disconnect visibility owned by the future application integration.

Each endpoint has one pipe instance, one possible handshake, and one active client. A second client receives a busy endpoint and cannot displace the current client. Hello has five real monotonic seconds. Each pending write has one second before connection retirement. There is one in-flight serialized frame, one replaceable unsent snapshot with at most one copied diagnostic batch, and the adapter's one current publication. Wire frames remain at most 65,536 payload bytes plus the four-byte prefix. Kernel input/output buffer requests are 65,540 bytes each. History does not accumulate when the application is absent.

Inbound hello has a tighter **4,096-byte payload** limit, plus its four-byte prefix. The server rejects a larger advertised length immediately when the complete prefix arrives, before the general decoder can accumulate its payload. A schema-valid hello padded with permitted JSON whitespace to exactly 4,096 bytes is accepted; 4,097 bytes is rejected. This transport limit does not change the general v0 wire-frame limit.

The worker reserves snapshot and optional diagnostic sequence numbers together before a current-state slot can replace another. Snapshot/diagnostic messages from that boundary are emitted in reserved order. Polling while a write is pending can replace only the later unsent slot. Replacing a slot increments coalescing and counts its copied observations as lost. Presentation sends are spaced by at least 50 ms; this is independent of later one-second history sampling. Welcome/checkpoint are not coalesced. After welcome, checkpoint copies current adapter state at a coherent boundary. Any later publication retained during checkpoint transmission remains eligible for live delivery; covered observations are explicitly counted as omitted rather than replayed.

Session sequence and continuity survive reconnection. Plugin-session identity rotates only with the next SDK initialization; process-instance identity remains the adapter's exact creation-FILETIME/PID lifetime identity. A uint64 sequence cannot wrap. Exhaustion retires the endpoint and discovery record; no new client receives current state until explicit SDK reinitialization/game reload establishes the next plugin session. The worker never reinitializes the SDK itself.

## Authentication and discovery ABI

`userTag` is **64 lowercase hex SHA-256 digits of the canonical current-user SID string encoded as UTF-8**, without a terminator. The canonical Windows SID representation is ASCII, for example `S-1-5-21-...`. The tag is a discriminator, not a secret or authentication mechanism.

The pipe name is exactly:

```text
\\.\pipe\ETS2Telemetry-{game}-v0-{userTag}-{windowsSessionId}-{processInstanceId}
```

The server uses `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`, non-inheritable handles and an explicit protected current-user DACL. It fails closed on a pre-existing pipe; it does not adopt that endpoint. It does not overwrite a foreign discovery file or generate an unverified alternative source identity.

The dedicated directories `%LOCALAPPDATA%\ETS2Telemetry\transport` and its `v0` child have protected owner/current-user-only DACLs. Existing reparse points and broad/inherited ACLs are rejected. The application root can retain its earlier scaffold ACL; the protected transport subtree is the authorization boundary. A discovery record is UTF-8 JSON, at most 4,096 bytes, named `{processInstanceId}.json` in `v0`, with exactly these fields:

| Field | Representation |
| --- | --- |
| `schemaVersion`, `protocolMajor` | Numbers `1`, `0` |
| `game` | `ets2` or `ats` |
| `userTag` | Lowercase 64-digit hash described above |
| `windowsSessionId`, `processId` | Exact uint32 JSON numbers |
| `processCreationTime` | Canonical decimal uint64 process-creation FILETIME |
| `processInstanceId`, `pluginSessionId` | Exact adapter UUIDs |
| `pipeName` | Derived complete pipe name |

The publisher writes a create-new temporary file with explicit owner-only security, flushes it, and atomically renames its held handle without replacing an existing destination. The original write/delete handle remains held with `FILE_SHARE_READ` only, preventing changes or name replacement while published. Read-only consumers must specify `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` so their sharing declarations permit that held publisher handle; these flags do not grant write/delete access. Retirement deletes via the original held file identity rather than reopening its name. Discovery fields and names remain untrusted hints; ET-006a verifies the actual connected game peer independently.

`service-policy.json` is a protected owner-only, non-reparse UTF-8 file in the same `v0` directory, at most 16,384 bytes. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "userTag": "<64 lowercase SHA-256 digits>",
  "windowsSessionId": 1,
  "allowedExecutables": [
    { "path": "\\\\?\\C:\\exact\\telemetry-client.exe", "sha256": "<64 lowercase SHA-256 digits>" }
  ]
}
```

There are 1–4 entries. Canonical final DOS paths have a 4,096 UTF-8-byte bound. Duplicate/unknown JSON keys, malformed types, oversized content, wrong user/session, invalid hashes, repeated paths, broad ACLs and reparse authority are rejected. A missing/invalid policy rejects the connection; it never permits arbitrary same-user clients. ET-006a/root owns provisioning for the fixed installed/development native broker artifact. Electron's broad executable path alone is not an allowed service identity.

The server obtains the actual client PID from the connected pipe, opens a constrained retained process handle, checks token SID and Windows session, retains creation FILETIME, opens the process image read-only without write/delete sharing, resolves its final path, and hashes through that same held file handle. The path/hash must match the protected policy. The worker rechecks the retained process's lifetime while connected. Process and image handles outlive the connection. PID reuse, claimed protocol IDs and discovery text cannot replace these checks. The executable sharing lock and held canonical image bind the inspected bytes during the local connection. This is a same-user local trust boundary; a compromised current-user account is outside its authentication claim.

## Copied diagnostics and loss

Diagnostics require hello opt-in. Only representable copied channel scalars (`bool`, `s32`, `u32`, exact `u64`, `float`, `double`, `string`) enter v0 diagnostic batches. Original availability reasons remain distinct; units use the explicit provisional `raw` label. The serializer does not invent scalar types for signed 64-bit values or world placement. Configuration/gameplay/lifecycle groups, callback order/index metadata and richer values belong to CAP-01's separate evidence format. Their observations are omitted from v0 and counted in `lostObservations`; duplicate channel observations in one batch are likewise counted. Source currency provenance is preserved only when the adapter supplies it. A partial required v0 job remains unavailable; source UTC and the deferred ET-007 game window are explicitly unavailable.

Adapter loss/offline/coalescing counters and transport omission/coalescing counts are combined with saturating uint64 arithmetic. A zero counter cannot establish historical completeness. Failed writes, discarded batches, disabled/offline observations and hydration-covered diagnostics never become durable gameplay effects. `seq` is outbound order, not a persistence acknowledgement or an event sequence.

## Verification

Release CTest cases `snapshot-transport-contract-{serialization,live,rejection,collision,coalescing,policy,fuzz}` exercise actual local Windows pipes with isolated temporary policy/discovery files. Each has a 30-second external bound; the five-second timeout remains a real measured case. Seeded raw-control mutations and randomized frame bursts exercise fail-closed parsing and ordered bounded replacement. `snapshot-transport-dll-contract` builds a separate `/MT` test-only DLL from the production implementation sources; its compile-guarded directory/status seam is absent from production exports. It checks official shutdown and `FreeLibrary` with a pending hello read, live read, and genuine kernel-backpressure write.

`snapshot-transport-reporting-contract` retains official-init tests for an actual foreign pipe, broad-ACL directory and foreign discovery file. Each must fail with one fixed reason logged on the direct SDK caller thread, promptly return, preserve the foreign object and safely unload. With `-DETS2TELEMETRY_ASAN_TESTS=ON`, `snapshot-transport-asan-test` and its seven original `snapshot-transport-asan-contract-*` cases instrument console/static test targets. The additional `snapshot-transport-asan-contract-reporting` instruments that test harness while loading the uninstrumented `/MT` test DLL. Production DLL code is uninstrumented `/MT`. See [ET-004a validation](validation/et-004a.md) for actual outcomes, failures and missing evidence. Controlled tests do not establish second-user/remote access rejection, real games, TruckersMP, Convoy, measured display latency or game frame-time impact.

For cross-package controlled evidence, the tests-only `snapshot-transport-game-host` target outputs `eurotrucks2.exe`. Run it with `host <absolute-test-only-DLL> <isolated-directory>` and redirected pipe stdin. It emits one bounded JSON ready receipt, invokes fake official SDK callbacks on its main thread, and stops/join/unloads normally on stdin EOF or `exit`. It creates no policy. This executable and the test-only DLL must never be shipped as game/product artifacts. Its source uses the production adapter's `origin:game`; the explicit `fixture:fake-sdk-host` ready receipt and validation record establish that this is controlled fake-host evidence, not a real ETS2 session. Cross-package checks must pin the source commits and DLL/host/broker artifact hashes.
