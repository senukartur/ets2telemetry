# Dashboard upload specification

**Proposed specification; uploader implementation is not included.** [ET-101](https://trello.com/c/v8LZYyH3) defines the desktop side of [VTC-024](https://trello.com/c/aluAoQAX). The [owner's scope decision](../DECISION-LOG.md#et-101-dashboard-upload-scope--november-6-2026) permits preparation before ET-021. Implementation, deployment, release and merge require their own authorization; local MVP acceptance is not waived.

## Contract and product boundary

The existing Dashboard owns accounts, Steam linking, company permissions, token issuance/revocation, ingestion, canonical trips, review, qualifications, reports and notifications. Reuse its [HTTP v1.0 contract](https://github.com/senukartur/vtc-dashboard/blob/1f9e34ab1ffeb12eba9d624a8116d19b3e5bb27a/docs/contracts/telemetry-v1.md), [schema/examples](https://github.com/senukartur/vtc-dashboard/tree/1f9e34ab1ffeb12eba9d624a8116d19b3e5bb27a/docs/contracts) and [acceptance matrix](https://github.com/senukartur/vtc-dashboard/blob/1f9e34ab1ffeb12eba9d624a8116d19b3e5bb27a/docs/contracts/telemetry-v1-acceptance.md). Do not create another server, account system or wire format. Contract revisions must be coordinated with the Dashboard owner before either implementation changes.

The Dashboard telemetry module is opt-in and disabled by default; code and tests do not prove that any hosted origin has activated its migrations, grants or ingestion. Verify an explicitly isolated configured environment before integration; this specification authorizes no activation or production request.

After explicit connection, automatically upload every retained eligible game trip, including open, delivered, cancelled, partial and interrupted trips, without an age cutoff or per-trip selection. Continue with new trips and material changes. Free-driving samples without a trip are not upload records. Upload lifecycle summaries, not one-second samples, raw events, profile identities, positions, process/window details, paths, diagnostics or local exports. Real upload requires both a history-purpose database and game-origin evidence; synthetic/replay databases never qualify. An isolated synthetic server fixture must not relabel a recorded synthetic source as genuine game history.

There is no server-to-client history download, restoration or import, including after reinstall. Already uploaded evidence remains subject to Dashboard policies; uninstall deletes desktop history and synchronization state. Local recording and the overlay work without a token, internet or a healthy Dashboard. A durable upload receipt means **sent**, never accepted by the company. Company decisions and statistics are computed on the website, without being imported into the Journal.

## Existing components and required seams

| Boundary | Reuse | Required desktop extension |
| --- | --- | --- |
| Dashboard | [Telemetry routes and service](https://github.com/senukartur/vtc-dashboard/tree/1f9e34ab1ffeb12eba9d624a8116d19b3e5bb27a/apps/api/src/modules/telemetry), immutable source records, MySQL ownership/receipt constraints, browser token workspace | Client use of existing endpoints; scoped Dashboard fixes only for verified incompatibilities |
| Recorder | [Recording runtime](../apps/desktop/src/recording-runtime.ts), native ACK after local durability | Transactional upload discovery indication; no network work on the ACK path |
| Storage | [Single storage worker](storage.md), schema v4 logical memberships, immutable revisions and accounting snapshots | Private projection reads, owner bindings, durable discovery/materialization/queue/receipt commands and an additive migration |
| Journal | Logical trip UUIDs and revision-bound provenance | Upload status keyed to the agreed source identity; no renderer DTO/export reused as an upload payload |
| Electron main | Supervision, narrow preload, channel/data-root separation | Protected token adapter, fixed-origin configuration and validated connection/status IPC |
| UI | [Account and sync design](design/ui-spec.md#56-account-and-sync-account-server-phase) | Connection confirmation, safe status and errors; ET-032 owns presentation |

`getTrip`/`listTrips` are raw recorder reads; Journal queries project logical groups. Neither API is a durable global upload cursor. Journal detail limits (ten trailer configurations and fifty intervals) do not establish complete rule context. Existing snapshot cursors fix a trip/revision, not the initial upload scan. Do not derive correctness from `updatedUtcMs`, UI ordering or polling alone.

## Connection, credentials and ownership

1. The driver creates a personal token in the Dashboard's existing `/account/connections` workspace. The desktop never signs in with a Dashboard password or issues/revokes tokens through browser-session APIs.
2. Main validates a token submission of at most 128 UTF-8 bytes from the main-window preload (the current `vtc1_` token is ASCII). Use a fixed, channel-specific HTTPS origin configured outside the renderer. Show that origin before submitting a token for verification; reject URL userinfo, query, fragment and redirects. Production/staging origins are separate deployment configuration gates; test-only loopback overrides must not be available in release builds.
3. Call `GET /api/telemetry/v1/connection`; validate its exact supported contract, authoritative `accountId`, `companyId`, `identityEpoch` and limits. The existing response uses `contract: {major: 1, minor: 0}`, not an invented versions array. Do not infer nickname/roles from opaque IDs or introduce an unsupported profile-read route.
4. Before binding history, show the verified owner identifiers, origin, and the first-upload scope: every retained eligible trip, with a bounded scan/count preview or an explicit calculating state. Explain that previously unbound history binds once and that the SDK cannot prove its historical driver. Cancel leaves history unbound and sends no trip. Revalidate identity before final confirmation.
5. Persist a random `clientInstallationId` before registration. POST `/api/telemetry/v1/installations` with only `contract` and that ID. Persist the returned `installationId`, `bindingId`, `identityEpoch` and authoritative owner tuple before materializing uploads. Lost registration replies retry the same client ID.

Main owns the credential store. Use an OS-protected adapter, backed on Windows by Electron [safeStorage/DPAPI](https://www.electronjs.org/docs/latest/api/safe-storage), with no plaintext fallback; verify the exact API against the pinned Electron version. A typed token exists transiently in the entry control and one-shot IPC only; clear it after submission/cancellation. Never return a saved secret to the renderer, persist it in settings/SQLite rows, put it in environment/command-line arguments, or include it in errors, logs, exports or diagnostics. Only the trusted upload service receives the active credential over private IPC.

Credential replacement uses a generation identifier: write protected candidate bytes atomically, commit the confirmed binding plus generation, then activate that generation. On recovery, a missing/unreadable matching secret pauses upload; an orphan candidate never authorizes a binding or upload. Channel-specific credential files must join the installer/uninstaller data inventory; copying a database alone does not transfer a decryptable secret.

The permanent owner key is `(origin, accountId, companyId, identityEpoch)`, independent of token bytes. Rotation for the same owner/epoch resumes unchanged work. Another owner or epoch receives a distinct registration and cannot adopt bound history or pending envelopes. Disconnect pauses sending, stops assigning new unbound trips to that owner, and forgets the local credential without erasing bindings, history, pending work or receipts. Network/authentication pauses retain the configured owner. Reconnecting as another account requires confirmation for still-unbound records; existing bindings remain held for their owner. An open trip bound to A stays A's across a switch to B. Identity revocation is authoritative on every request; no expiration policy or automatic reconciliation is invented by the client.

## Source identity and summary projection

The v1 source key is `(provider, game, pluginSessionId, tripId)`; `databaseUuid` is provenance, not another deduplication dimension. Preserve source IDs across retries, application restart and consistent database copies. Event IDs are generated once; positive safe-integer HTTP revisions increase per source trip and are separate from SQLite revision row IDs. Never match source identity by cargo, route, name or timestamp.

**Logical-trip compatibility gate.** Schema v4 can join raw recordings from different plugin sessions into one Journal trip, including when profile proof arrives after a provisional singleton was created. The older VTC-024 discovery assumed raw single-session trips. Proposed mapping is the logical root UUID plus its opening plugin session, with all later observations remaining evidence of that root. Before freezing any real upload, ET-103a must establish, with Dashboard contract fixtures, how provisional membership, retirement, later association and cross-session occurrence references are represented. The v1 schema has no source-merge command or per-occurrence session field. Do not publish provisional children as independent trips, silently rewrite a frozen source key, reopen a remotely terminal source, or treat event sequences from different sessions as ordered. If one key has already been published before association, retain both frozen histories and hold affected work for explicit reconciliation. A proven v1-compatible mapping or separately agreed contract revision is a prerequisite to enabling this path; this specification does not authorize the latter.

| v1 group | Local source and required mapping |
| --- | --- |
| Outcome, completeness, close reason | Revision-bound logical projection, including irreversible losses and actual delivered/cancelled evidence. A resumable raw restart closure must not terminate a still-open logical trip. Initially terminal history needs no invented start request. |
| Opening and time | Stored opening/checkpoint provenance plus original event occurrence; final event and close carrier retain their own source session. Distinguish actual occurrence, checkpoint, inherited last-known label, receipt fallback and clock clamp. Set observed flags only from supported lifecycle evidence; unsupported time is unknown. Never use upload time or current qualification as historical fact. |
| Job and quantities | Stored job configuration: stable city/company/cargo IDs and original names, shipment mass versus unit mass/count, market and flags. Follow the wire field allowlist, not display strings. |
| Distances and fuel | Selected logical accounting path; planned, observed and SDK-delivered distances remain separate. Partial observed distance is a segment; reverted driving after a save load must not be summed twice. Use stored fuel availability and supported cargo-damage evidence. |
| Money | Native expected income as exact u64 decimal text; revenue and penalty as exact s64 text. Do not use Journal combined money or lossy Number conversions. Currency remains unknown unless SDK-documented evidence supports it. |
| Trailers and quality | Read all relevant snapshot-bound membership/configuration/interval evidence in bounded pages, not just latest detail windows. Ten active trailer slots are not ten historical configurations. Mark missed, changed or unavailable rule context explicitly; no partial page may imply complete context. |
| Context and versions | Persisted welcome/session versions and supported recorded metadata. Current source reads do not establish exact retail build, map namespace, DLC inventory or source locale; send unavailable rather than inferring `official` from fixtures or API version. Unknown catalog context can prevent automatic company credit without preventing honest upload. |
| Game mode | Retain opening evidence plus ambiguity across members. Unknown requires none/none; known requires supported detection and non-none confidence; single-player is weak. Never upload module names/paths or claim driver identity proof. |

Missing historical evidence stays unavailable; adding future capture cannot backfill it. Hard Mode's local flag is not company acceptance and is not an extra v1 field. Derive only the evidence supported by the frozen schema. If a value cannot fit without truncation, retain a visible projection hold and source pointer; do not discard data or fabricate a compatible value.

## Durable local state and transaction contract

All synchronization metadata resides in the history SQLite database under the existing WAL/FULL single-writer contract. Table/command names below are proposed private interfaces, not implemented API exports. Allocate the next migration number at implementation time; freeze versions 1–4 and add historical migration fixtures. Backup/digest/restore tooling and staging trip deletion must account for the new tables. Technical local database-copy recovery remains distinct from the cancelled product history download.

| Durable state | Required constraints |
| --- | --- |
| Installation and owner registrations | Stable local installation ID; unique confirmed owner/epoch registrations; protected-secret generation reference, never secret bytes |
| Source binding and projection head | One permanent owner per agreed source key; last compared source snapshot/material digest; monotone HTTP revision allocator and original provenance |
| Scan run | Owner, stable high-water boundary, bounded keyset cursor, scan-complete state and original backfill run UUID |
| Discovery work | Durable source revision/change position, including changes overlapping the scan; retain reconstructible source references while materialization is paused |
| Frozen envelopes | Unique event ID and source-key/revision; original registration, run/mode, contract/projector version, exact UTF-8 bytes and byte count; sending/backoff/held state |
| Receipts | Event ID, matching server receipt ID and first receipt time; committed before deleting envelope bytes or releasing queue capacity; sufficient identity/digest retained to detect contradictory retries |

Required operations cross only the private service/worker channel, with strict argument/result validation: begin/resume scan, page scan/discovery, pin/read projection context, compare-and-freeze, select eligible pending work, record attempt/hold, commit validated receipt, and read safe status. Renderers cannot invoke them or select paths, owners, arbitrary URLs, SQL or source purpose.

**T1 — discover with source commit.** Event/gap effects, checkpoint membership, completeness/Hard Mode changes, logical association/retirement and relevant sample accounting update their discovery indication in the same transaction as source history. Bind newly identified roots to the configured confirmed owner in this transaction, independently of queue capacity; provisional identities retain the opening owner context until the compatibility gate resolves their root. An account switch cannot take work recorded for a previous owner merely because serialization was delayed. Existing immutable logical revisions are useful source evidence but are not by themselves the complete upload change stream. A crash must not commit a change without discoverability. Ordinary per-second counters are not material open updates; use compact/coalesced work pointers while retaining reconstructible terminal, correction and uncertainty transitions. No serialization or HTTP runs inside a recorder transaction.

**T2 — begin and enumerate.** Atomically persist the scan's high-water boundary and durable change position with confirmed ownership. Walk retained eligible logical roots by stable key, in pages of at most 100; resolve the identity gate before assigning permanent keys. Binding/enumeration progress advances only with durable pending work or a pointer that guarantees later materialization. Recording and changes beyond the boundary remain discoverable. Scan/live paths share one comparison/revision allocator. A restart resumes the same run; another account cannot take it over.

**T3 — pin, compare and freeze.** Obtain a consistent logical snapshot and all necessary evidence within its immutable bounds. Heavy pagination may span worker turns, but every read must use that snapshot; source revisions required by pending work cannot be reclaimed. Compare normalized material evidence, excluding volatile upload time, against the stored projection head. In one transaction recheck owner, snapshot/progress and queue capacity, allocate a revision/event ID and store the exact final envelope before advancing progress. An equal projection records comparison progress without minting an event. A conflict restarts from a new snapshot, never combines pages from different revisions. Contract-invalid projections remain held. Initial completed/cancelled/closed records may start at revision 1; open context refreshes use higher `trip.started` revisions; later terminal changes use `trip.corrected`.

**T4 — remote receipt then local commit.** Send outside SQLite transactions. Validate the full bounded response, then atomically commit receipt/delivered state. Only subsequently clean up payload bytes and release capacity. A crash after remote commit but before local receipt commit retries the identical envelope, obtaining the same duplicate receipt; a crash after local commit cannot resend it as new work. Losing metadata produces a reconciliation hold, never fresh replacement IDs.

## Transport, scheduling and failures

Use bearer authentication only, one event per uncompressed UTF-8 JSON request to `/api/telemetry/v1/events`, and at most one upload request in flight. Enforce v1.0 shape/semantic checks and the contract's 65,536-byte/depth-16 limits before freezing. No arbitrary renderer-controlled request target, cookie fallback, redirects, disabled TLS validation or silent minor-version downgrade. Proposed client defaults are a 30 s total request deadline, control replies at most 16 KiB, receipt/error replies at most 4 KiB and response JSON depth at most 16; malformed or oversized replies cannot release work. These are resource bounds, not latency or throughput claims.

Accept only `202` with `stored` or `200` with `duplicate`, exact v1.0, the expected event ID, valid receipt identity and nonnegative safe first-receipt time. Persisted receipt identity/time cannot change on replay. A generic 2xx, timeout, malformed/truncated reply, wrong status/identity/version or server-side company decision is not an ACK. Native contiguous-event ACK remains a separate local durability mechanism.

| Result | Client action |
| --- | --- |
| 401 / 403 | Pause that owner's queue until credentials/eligibility are repaired; retain source bindings and work |
| 409 binding/identity conflict | Hold affected work for reconciliation; never reassign or overwrite evidence |
| 400 / 413 / 415 / 422 | Visible validation/size/media/version hold; repair through a reviewed compatible producer change, preserving original frozen evidence |
| 429 | Persist retry time from valid seconds/date `Retry-After` plus jitter; invalid header uses normal backoff |
| Network timeout / transient 5xx | Retry exact bytes with capped exponential full jitter, base 2 s and cap 5 min; timeout may follow a committed event |
| TLS / redirect / unknown failure / invalid receipt | Keep work and a fixed diagnostic; pause configuration faults, use bounded retries for transient reply faults, never hot-loop |

Attempts, backoff and holds survive restart. Schedule using the existing 60 events/minute, burst-10 server defaults and advertised compatible limits; these are not measured capacity. Use bounded fair scheduling (proposed: at most one backfill event between eligible live events) and skip temporarily ineligible/held work without discarding it. Out-of-order revisions remain valid under the server contract. Historical/delayed events retain frozen mode/run; they must not create false current activity.

At 10,000 pending serialized events or 64 MiB, pause only new materialization/enumeration. Already frozen eligible work keeps uploading; durable receipts free capacity and resume materialization automatically. Retain discovery positions and source changes during pressure; do not expire pending work, erase older history, or block the recorder on HTTP. The queue bound is not a total history/database-size guarantee. Storage work must yield between bounded pages and prioritize recorder commits; HTTP errors must not poison the local recording state.

On orderly exit stop new uploads, bound/cancel the in-flight request and retain ambiguous delivery for retry. Do not wait for a remote backlog to drain or extend the existing recording shutdown budget. Updates/restarts keep IDs, bindings, pending bytes, backoff and receipts. Uninstall removes all local state. Staging deletion must refuse deletion of source/revision data referenced by pending or held synchronization work until an explicit reviewed cleanup policy exists; it never issues a Dashboard delete.

## User-visible state

ET-032 implements the existing design on a safe status DTO: unconfigured, verifying, awaiting confirmation, connected, offline/backoff, authentication required, projection/reconciliation hold and queue pressure. Include owner identifiers, channel/origin, first-scan progress, unsynchronized source backlog separately from frozen queued events, held count, last durable upload and fixed actionable error. Counts must not expose another owner's trip data. First-upload progress counts distinct source trips, not HTTP attempts or revisions; changing totals and unresolved sources remain explicit.

Journal status is per agreed logical source/revision: queued, held, sending or sent after a durable local receipt. No company acceptance indicator is inferred. Account & sync remains discoverable when the feature is implemented but unconfigured; top-bar/Journal sync decorations appear only when configured. Masking/show-hide applies to the token currently entered, not a saved secret readback. RU/EN wording follows existing localization. No history restore controls are provided.

## Delivery ownership and entry gates

These are proposed allocations to existing cards, not authorization to implement or a second uploader backlog.

| Work owner | Deliverable and dependency |
| --- | --- |
| ET-101 | Review/accept this specification and resolve the logical-trip compatibility gate. Record product decisions only in the decision log; technical alternatives/review evidence belong in the PR. |
| ET-102 + Dashboard VTC-023 | Reuse existing ingestion; verify exact route/response/parser/auth/receipt compatibility. Replace obsolete separate-server/restore allocation; any required Dashboard change gets a scoped PR in that repository. No new PostgreSQL backend. |
| ET-103a | Consume the mapping agreed during ET-101 review, add logical source/occurrence compatibility fixtures and full projection API, and serialize storage migration ownership. Provisional joining, cross-session sequences, source retirement and raw-vs-logical API use must be resolved before enabling real materialization. |
| ET-103b | Additive durable metadata/discovery/scan/freeze/receipt transactions and historical migration/crash tests; depends on ET-103a mapping and accepted specification. |
| ET-103c | Main credential boundary, registration and service HTTP scheduler/recovery; depends on durable APIs and ET-102 compatibility. Fault tests precede real server use. |
| ET-032 | Confirmation flow, Account & sync, Journal/top-bar status using ET-103 data; no duplicate queue/credential logic. |
| ET-103d + VTC-024 | Actual desktop-to-isolated-Dashboard integration with real MySQL, backlog/crash/owner tests and separately authorized game evidence. |
| ET-104 + Dashboard report owners | Reconcile existing company review/qualification/analytics/notification effects with uploaded fixtures; replace obsolete website rebuild/restore requirements. Receipt success alone closes none of these gates. |

Resolve before affected implementation: the logical-v4/v1 mapping; complete immutable projection reads/change coverage; exact protected-secret API and recovery/IPC bounds; configured channel origins and isolated integration environment. Map/build/locale/DLC uncertainty remains explicit uploaded evidence unless a separate capture enhancement is justified. Keep the existing recorder enablement decision and check its actual validation record; do not reopen an obsolete `GAME_HISTORY_RECORDING=false` requirement from discovery notes. Preparation may precede ET-021; implementation readiness and local MVP acceptance are separate gates.

## Verification and acceptance

Use the Dashboard [P0–P11 procedures and TEL ledger](https://github.com/senukartur/vtc-dashboard/blob/1f9e34ab1ffeb12eba9d624a8116d19b3e5bb27a/docs/integrations/telemetry-verification.md) rather than copying its 36-case matrix. Its old raw-schema/recording-disabled observations are historical source findings; its suggestion of later remote restore is superseded for this client by the owner decision. Preserve technical consistent-database-copy tests. The minimum allocation is:

| Verification boundary | Cases and required evidence |
| --- | --- |
| Projection/contract | TEL-010–012, 018–023, 034–036; independently expected fixtures for logical cross-session identity, provisional join before/after freeze, restored-save accounting, more than ten configurations/fifty intervals, missing context, money extrema and RU/EN stable IDs |
| Storage/migration/crash | TEL-002/003, 028–031; real storage worker/temporary SQLite, killed subprocesses at discovery/scan/freeze/receipt/cleanup commits, copy/reopen and migration preservation; no mocks-only durability claim |
| Credential/transport/UI | TEL-013–018, 024–026; Windows secret-store failures, canary-secret absence, account switch during an open trip/request, token rotation/revocation, epoch change, redirects/TLS, malformed receipts, persisted retry and real UI statuses |
| Initial/live concurrency | TEL-028–031 plus logical association; history scan overlaps local recording, pressure by both count/bytes, restart while paused, continued drain/capacity release/resume with no omitted source changes |
| Dashboard effects | TEL-001, 003–009, 016/017, 027, 032/033; actual isolated MySQL and current consumers, once-only canonical credit, manual overlap, unknown historical qualification, freshness and permission filtering |
| Product boundary | TEL-035; a remote-only/manual trip never appears locally; reinstall starts with empty local history and new registration, never downloads prior Dashboard records |
| Real environment | P10 authorized ETS2/ATS sessions and supported mode evidence; P11 separately approved host TLS/redaction/rate/latency tests. Simulation, source inspection and old CI results do not satisfy these gates. |

Implementation PRs run `npm run test:affected`, relevant existing storage/contract/runtime lanes, then repository-required CI; Dashboard fixes use that repository's commands and actual MySQL lane. Add one regression-registry row per new test entry point and preserve applicable REG-003–014/017/018 scenarios. No uploader test command exists merely because this document proposes it. The specification can enter Review with its mappings and open compatibility gates explicit; implementation cards become Ready only after their prerequisites are resolved and authorized. ET-101 is not Done until its specification is accepted; VTC-024 remains incomplete until real client/game/integration evidence is accepted.
