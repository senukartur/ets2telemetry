# ET-006b broker v1 mode validation

## Scope

This record covers ET-006b PR-2, the protocol v1 mode of the native pipe broker, on branch `feat/v1-broker-mode` based on `864272b`. This PR implements coordinator decisions E3 (v1 service-policy provisioning) and E4 (the broker's v1 mode), which the coordinator adopted under the owner's standing delegation of October 15, 2026; the owner has not reviewed them individually. The dated "ET-006b authorization — October 15, 2026" paragraphs in `AGENTS.md` and `concept.md` record that authority; on October 15, 2026 the owner explicitly approved the coordinator writing them into this PR, so it does not depend on PR-1. The behavior is documented in [native broker control](../telemetry-service-v0.md#protocol-v1-mode) and [the native v1 transport](../native-transport-v1.md#pipe-discovery-and-policy).

Changed files: `native/telemetry-client/src/client.cpp`, `native/telemetry-client/CMakeLists.txt` (the broker and both fixtures link `protocol-v1.cpp`; new CTest cases), `native/telemetry-client/tests/client-test.cpp`, `scripts/source-inputs.mjs` (the broker build evidence now covers `native/telemetry-plugin/src/protocol-v1.cpp` and `.hpp`), and the documents linked above, [the native boundary](../native-transport-boundary-v0.md) and [CI](../ci.md).

The service does not launch the v1 mode yet: that is ET-006b PR-3. The v0 and CAP0 broker modes, the plugin, `apps/`, the protocol v1 contracts and fixtures are unchanged. No game was launched, and no file under `%LOCALAPPDATA%\ETS2Telemetry` was read or written: every case uses its own temporary directory under the fixture's per-run base directory.

## Cases

All 36 existing fixture cases are unchanged. Sixteen cases are new, each registered as `native-pipe-client-<case>` and as its AddressSanitizer twin `native-pipe-client-asan-<case>` through the same `CLIENT_TEST_CASES` list. The `*-case-list` entry checks that the CMake list and the fixture agree.

| Case | Checks |
| --- | --- |
| `v1-valid` | Six-key receipt with `"protocolMajor":1` and the host's PID, origin `game` and plugin session; the host authorizes the broker against `transport\v1\service-policy.json` and receives exactly the v1 `hello.json` frame; welcome and checkpoint relayed one per credit with no unsolicited output; `ack-1.json` and `clock-probe.json` sent as tagged frames reach the host byte for byte and in order; the relay then continues (`clock-reply.json`); EOF exits 3 and nothing else reaches the pipe |
| `v1-policy` | Without `transport\v1` the broker reports `waiting`, exits 2 and creates nothing; with it, the policy has exactly the four keys, schema 1, the current user tag and session, and one entry whose path and SHA-256 equal the broker image; the sibling `transport\v0` stays empty; no temporary file remains; a third run leaves the same file (file index) and bytes |
| `v1-major-mismatch`, `v1-name-mismatch`, `v1-collision` | A record with `protocolMajor: 0`, a record whose `pipeName` has the `v0` segment, and two live records each exit 1 with no stdout |
| `v1-v0-hello`, `v1-cap0-hello` | A v0 or CAP0 hello exits 1 at stage `hello`; the host reads EOF, so no byte reached the endpoint |
| `v1-client-kind` | A tagged frame holding a valid client `hello` exits 1 at `client-frame` with Win32 error 0; nothing after the hello reaches the host |
| `v1-client-oversize` | Tag `0x02` with length 4,097 exits 1 at `client-frame` with error 0, before any payload is read |
| `v1-bad-tag` | Tag `0x03` exits 1 at stage `relay`, like an invalid v0 credit |
| `v1-ack-while-quiet` | With a credit outstanding and the host silent, so the relay waits on its pending pipe read, an ACK still reaches the host, and the host's reply is relayed |
| `v1-write-deadline` | The host's pipe has no inbound quota and the host never reads, so the ACK write stays pending. With a credit outstanding, the broker exits 3 at `client-write` 5,016 ms after the ACK was sent (bound 4,500–12,000 ms), with error 995 (`ERROR_OPERATION_ABORTED`) from the observed cancellation; the host then reads EOF |
| `v1-capture-conflict` | `--protocol v1 --capture cap0`, `--capture cap0 --protocol v1`, `--protocol v2` and a bare `--protocol` each exit 1 at stage `arguments` with no stdout |
| `v1-partial-length` | Tag `0x02` followed by two of the four length bytes, then stdin EOF: exit 3 at stage `relay` (cancellation), never `client-frame`; nothing after the hello reaches the host |
| `v1-partial-payload` | Tag `0x02`, a full length and half of the `ack-1.json` payload, then stdin EOF: exit 3 at stage `relay`, never `client-frame`; nothing after the hello reaches the host |
| `v1-zero-length` | Tag `0x02` with length 0 exits 1 at `client-frame` with Win32 error 0 |

The last three cases were added in fix round 1 after independent review (pass 1) found that these documented control-stream promises had no test.

`v1-write-deadline` waits out the broker's 5 s client-write deadline and is registered with the timed cases (30 s backstop, 60 s under ASan). The plan's case list did not include it; it was added because the deadline and its cancellation are E4 requirements that no other case reaches.

## Checks run

Local host: Windows 11, Visual Studio 18 (MSVC 14.51.36231) with its bundled CMake 4.3.1-msvc1, pinned Node 24.19.0. The host was shared with other agents; builds used `CMAKE_BUILD_PARALLEL_LEVEL=4` and heavy steps ran one at a time.

| Command | Result |
| --- | --- |
| `npm ci` | 310 packages added, 0 vulnerabilities |
| `npm run build` | Exit 0, no MSVC warnings (the broker and fixture build with `/W4 /WX`) |
| `ctest --test-dir native/telemetry-client/build -C Release --output-on-failure --no-tests=error` | 50/50 passed (49 cases and the case list) in 30.6 s |
| Client ASan configure, build of `telemetry-pipe-client-asan` and `telemetry-client-test-asan`, `ctest ... -R '^native-pipe-client-asan-'` with the MSVC ASan runtime on `PATH` | 50/50 passed in 33.4 s |
| `npm run lint:install`, `npm run lint` | Zero findings |
| `npm test` | 60 files, 1,422 tests passed (includes `package-integrity.test.ts` and `broker-artifact.test.ts`) |
| `sourceHashes()` against `native/telemetry-client/build/Release/build-evidence.json` | 95 inputs, including `protocol-v1.cpp` and `protocol-v1.hpp`; the native evidence equals the current sources |
| `git diff --check` | Clean |

The ASan steps follow `.github/workflows/windows-ci.yml` except the generator: CI selects `Visual Studio 17 2022`, which is not installed on this host, so the local configure used the default `Visual Studio 18 2026` generator with `-A x64`. Hosted CI has not run on this branch.

## RED mutations

Each mutation was applied to `client.cpp`, the affected targets were rebuilt and the named cases run, then the file was restored from Git. All final results above were produced after the restore and a clean rebuild.

| Mutation | Outcome |
| --- | --- |
| v1 hello check removed (`v1::negotiate(v1::decode_payload(...))` deleted) | `v1-v0-hello` and `v1-cap0-hello` failed; `v1-valid` passed |
| Client-kind check removed (any valid client message forwarded) | `v1-client-kind` failed; `v1-valid` passed |
| Major check removed (`protocolMajor` accepted up to 1 in either mode) | `v1-major-mismatch` failed; `v1-valid` passed. A first attempt left `protocolMajor` unused, failed to compile under `/WX` and ran the old binary; it was redone and is not counted |
| Client-write deadline removed (`INFINITE` wait) | First run: the case **passed its exit code** and failed only its stage check, because the relay's existing 5 s credit wait ended the broker a few milliseconds earlier (`diag1 relay`). The case raced; it was fixed in `eb2928e` by sending a credit with the ACK, so the relay waits on its pipe read instead. Rerun: `v1-write-deadline` failed at the 15 s fixture bound |
| `CancelIoEx` and `GetOverlappedResult(TRUE)` removed from the client write (ASan build) | **Not detected**: `v1-write-deadline`, `v1-valid` and `v1-ack-while-quiet` passed. The pending write completes in the kernel when the handle closes, and AddressSanitizer does not observe kernel-mode writes into the released `OVERLAPPED` or buffer. The rule is enforced by review and documented, not by a test |

The ordering of client frames after the hello (`helloSent`) and the join of the reader before the pipe handle closes have no mutation that a test can observe deterministically; they are covered by review.

## Fix round 1

Independent review pass 1 on `5cdb3f4` approved with two minor findings and two nits:

- The documents pointed to `AGENTS.md` for ET-006b, which at that head still called ET-006b unauthorized. The dated authorization paragraphs are now part of this PR (see Scope).
- The control-stream promises for EOF inside a record and for length 0 had no test: `v1-partial-length`, `v1-partial-payload` and `v1-zero-length` were added.
- After the `helloSent`/`stop` wait, the reader now returns when `stop` is already set, so a decoded frame is never written while the broker shuts down.
- On `WAIT_FAILED` the client write saves `GetLastError()` before `CancelIoEx` and `GetOverlappedResult`, so the reported error is the wait failure.

Checks on the fixed tree, run one at a time on the same host:

| Command | Result |
| --- | --- |
| `npm run build` | Exit 0, no MSVC warnings |
| Client CTest Release, two runs | 53/53 passed each time (52 cases and the case list) |
| Client ASan configure, build and `ctest -R '^native-pipe-client-asan-'` | 53/53 passed in 34.1 s |

RED: both frame reads in the tagged reader were changed so that an EOF sets a `client-frame` failure. `v1-partial-length` and `v1-partial-payload` failed; `v1-zero-length` and `v1-valid` passed. The file was restored from a byte-identical backup (confirmed with `cmp`) and rebuilt before the results above.

The coordinator's lint, `npm test` and `git diff --check` results for the final head are listed in the PR.

## Pending

- ET-006b PR-3: the service launching the v1 mode, the six-key receipt check, the tagged writer and the `client-frame`/`client-write` stages in the service's known-stage list, and the chain test against the plugin's real v1 endpoint, which reads the broker-provisioned policy with `read_service_policy`.
- Hosted Windows CI, independent review and the merge gate.
- Packaged broker v1 mode in an installed application; second-user and remote-client rejection.
- Every real-game, TruckersMP and performance check. Convoy stays deferred.
