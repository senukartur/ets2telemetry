# ET-044: standalone native event validation

The owner authorized preparing real native event checks and restoring the installed broker's trusted path on October 23, 2026, with **no Computer Use and no application history recording**. This document describes the diagnostic client and procedure; it does not claim that game events, replay or native `end` have passed.

## Scope and trust

The diagnostic client uses the existing `NativePipeClient` in protocol-v1 mode. The broker validates discovery, Windows identity and the real pipe peer; the client compares every message's complete source identity with that native authority receipt. Synthetic/replay authority is refused. Native/wire/SQLite code and `GAME_HISTORY_RECORDING` are unchanged.

The local installed candidate exhausted both four-entry policies because retained validation artifacts still exist. Deleting evidence to make pruning happen, increasing the bound or allowing arbitrary peers is unnecessary. For this **closed-game, closed-application validation environment**, old policy bytes/owner ACLs were archived, then the **unchanged installed broker** republished its own exact canonical path/SHA-256 under the existing protected owner-only lock/atomic-publication mechanism. Both policies now contain that installed artifact. Old binaries and original policy bytes/ACLs remain preserved. The same procedure first reproduced full-cap rejection and successful publication in isolated protected directories. No product policy limit, parser, ACL or trust rule was weakened.

Publication returned the expected native `waiting` result with no game. That establishes provisioning, not real game authority or compatibility. This is an operational ET-044 recovery, not a general automatic trust-retirement feature. Prior trusted artifact paths can be republished by their normal brokers later and will consume slots again; avoid unrelated launches during this validation.

## Diagnostic durability and limits

- `tools/telemetry-validation/src/event-probe.ts` uses the existing strict `V1Consumer` and `DurableAckCursor`.
- Events, gaps, checkpoint and controls are appended and `fsync` completes **before** the local diagnostic cursor commits coverage and an ACK can be returned. A write/sync failure stops the run without acknowledging that coverage.
- This persists **diagnostic evidence files**, not a SQLite database, application samples, trip records or Journal data. ACK observations here do not establish the application's history-worker transaction/ACK boundary.
- An initial producer ACK boundary may predate this capture. It is recorded as `priorProducerAckBoundary`; no earlier events are invented. Reconnection retains the same client ID and local cursor within this process; restarting the CLI does not resume an earlier capture.
- Replayed event contents must equal the previously persisted occurrence/record contents. Frames are always validated; complete diagnostic snapshots are sampled at most once per second to bound evidence size. This is not the history sampler or a measurement of all snapshot timing.
- Limits: 15–1800 real seconds, 64 MiB evidence, 64 authorized connections, 16 plugin sessions and 10,000 distinct captured events per session. Reaching a limit is an explicit stop/error, never silent evidence loss followed by ACK.
- An actual protocol `end` is recorded separately from transport closure. Missing `end` remains missing, including when the native peer disappears first. No `end` is inferred from a game process exit.
- Closing the probe sends EOF and awaits the owned broker's completion before reopening/finalizing. The observation deadline is not a universal kernel-I/O shutdown guarantee; no forced kill or orphaned replacement is used.
- Raw names, source IDs and game fields stay in ignored `.local/validation`; never commit or upload them. The console prints event types/sequences rather than raw record bodies. No personal-data redaction claim is made for the local raw captures.

## Build and controls

Use the repository's pinned Node/npm. From the task checkout:

```powershell
node scripts/build-event-probe.mjs
```

The output is `.local/validation-tools/game-events.cjs`. It requires all six options:

```text
--game ets2|ats
--broker <absolute verified installed telemetry-pipe-client.exe>
--sha256 <exact lowercase broker SHA-256>
--discovery <absolute owned transport\v1 directory>
--output <fresh absolute directory below this checkout's .local\validation>
--seconds <15..1800>
```

The output parent must already exist and have no reparse ancestry. Evidence is created exclusively. The program refuses to start while the desktop application runs. The desktop must remain closed throughout; use the standalone probe as the sole v1 consumer. The broker hash is checked again before reconnection, while the broker independently holds and verifies image/peer identity.

Operator stdin commands (not renderer/game input):

| Command | Purpose |
| --- | --- |
| `status` | Report diagnostic counts and session cursors. |
| `mark <short label>` | Add a bounded operator observation label. |
| `acks off` / `acks on` | Persist evidence but withhold/resume diagnostic ACK delivery. |
| `reconnect` | EOF/join the current broker, then reconnect with the same client ID/cursors. |
| `stop` | Stop intake, join the broker, close evidence and write `summary.json`. |

`send` evidence rows describe outgoing intent; they do not prove that a producer accepted an ACK. Compare later producer delivery boundaries/checkpoint/status when asserting acceptance. Keep errors, loss counters and timing uncertainty.

## Owner-operated game order

Do not ask for game actions until the installed broker hash/policies, no-game preflight and preserved real-history baseline are checked. The owner operates all game/UI controls.

1. Keep telemetry and TruckersMP closed. Start the bounded probe, then ask the owner to start **ETS2 single-player**, window 2560×1440, load the normal profile and park. Windows remains 5120×2160/150%; Windows labels are English. Do not change saves or game/plugin files for this procedure.
2. Audit the native authority, welcome event grant/capabilities, checkpoint, initial loss/ACK baseline and registered clock reply. No safe UI progression is requested if those checks fail.
3. While parked, use menu/pause/resume to expose actual simulation events. Record the game observations and compare occurrence/capture clocks, event sequence, configuration revisions and retained delivery status. Missing optional events remain unobserved, not fabricated.
4. For the distinct replay branch, the operator withholds ACKs, asks for one safe parked transition, confirms it was persisted, then reconnects. Compare exact replayed event contents before resuming ACKs; check actual producer acknowledgement separately. No forced disconnect, process fault or online driving action is involved.
5. Ask for normal game Exit, observe whether an actual `end` arrives, then one normal restart if needed to compare plugin sessions. If only transport disconnection is observed, keep `end` unverified.
6. Stop the probe, verify broker/process drain and compare history/settings/plugin/policy identities. Application history must remain byte-preserved. Repeat only genuinely missing assertions in ATS/TMP; no full accepted UI campaign is introduced.

No recording-enabled reference job, one-hour recording, application Journal/export or game-performance acceptance follows from this procedure.

## Automated preparation evidence

Focused tests cover correct event/gap ACKs, persistence failure before ACK, withheld ACK/replay/deduplication, changed replay, authority mismatch, synthetic-authority refusal, clock reply registration, actual-end distinction, pre-existing producer boundary, separate plugin sessions, snapshot sampling and bounded exclusive files. Existing protocol and broker adapter tests are reused.

The first changed-redelivery test used an invalid game-time shape and failed at schema validation; corrected only that test input to a valid changed occurrence. A first shell command used the host's unpinned npm and failed the engine check; the pinned toolchain then installed cleanly. A wrong direct compiler path failed before typechecking; `npm run typecheck` is the actual successful check. Preserve these orchestration failures in local evidence rather than treating them as product failures.

The first full unit run had 4,669 passes and two timeouts in the existing windowless Electron single-instance tests: dependencies had been installed with scripts disabled and `node_modules/electron/dist/electron.exe` was absent. The pinned Electron installer is required before the full suite; no timeout or test expectation was weakened.

After installing Electron, the default-parallel full run had 4,663 passes and eight existing I/O/registry failures (seven 5-second timeouts and one `STEAM_REGISTRY_TIMEOUT`). Running the same suite with two workers passed all 4,671 tests in 134.86 seconds, with no timeout/expectation change. Preserve the failures as environment/timing observations rather than asserting a proven cause or unconditional default-parallel pass. A subsequent replay-comparison refinement uses the existing pure `canonicalJson` helper so object-member order alone cannot change an event's fingerprint; its regression is part of the final checks.

Actual real-game results will be recorded separately. The earlier ET-044 renderer freeze and ET-045/ET-046 findings remain unresolved by this tool.
