# Disposable VMware packaged acceptance

These sources prepare an inert, self-contained test kit and run the packaged lifecycle only inside the owner-authorized VMware guest. Physical-host Electron, application and installer launches remain prohibited. The coordinator exclusively owns VM startup, its independent outer watchdog, transfer, interactive scheduled-task dispatch, log export, shutdown and clean-snapshot restoration. Preparation does not perform any of those actions.

The kit carries the unchanged reviewed package, portable Node 24.19.0, playwright-core 1.64.0 (no downloaded browsers), and the existing package verifier and Job Object helper. Every file is included in a SHA256 manifest; supply its reviewed hash separately to the guest wrapper. `-IncludeInstaller` can copy maker artifacts for a later lifecycle attempt; this harness does not execute them or establish install/update/uninstall acceptance.

From the task checkout, plan or prepare a fresh directory:

```powershell
./tests/vm/Prepare-AcceptanceKit.ps1
./tests/vm/Prepare-AcceptanceKit.ps1 -Prepare -OutputDirectory 'D:\Projects\ETS2Telemetry\.local\vm-lab\acceptance-prep\kit-<unique-id>'
```

The coordinator archives the directory contents, transfers them without shared folders or networking, and expands them into the distinct `C:\ETS2ET001Acceptance` root. Preserve the old `C:\ETS2VMwareLab` baseline. After baseline preflight and interactive guest login, dispatch this command in the guest desktop session through the coordinator's bounded scheduled task:

```powershell
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File 'C:\ETS2ET001Acceptance\harness\Invoke-GuestAcceptance.ps1' -Run -ExpectedManifestSha256 '<reviewed kit manifest SHA256>' -ExpectedPackageSha256 'ffd4227c69487d31b63b8f92f1de4205103ec68648d4c11e8336ad061015d69f' -ExpectedAsarSha256 '2356ed080cb8854e2358065b3a209632814ae0777951ed3d41d447dbc11d2790' -OuterDeadlineUtc '<UTC deadline of already armed outer watchdog>'
```

This is a guest command, never a physical-host command. The explicit run switch alone is not authorization. The wrapper refuses a wrong UUID, VMware identity, baseline marker, kit path, stale outer deadline, manifest corruption, extra kit files, existing application instance, or changed package before loading Node or Electron. The externally supplied deadline is a dispatch assertion, not proof that the host watchdog is armed; the coordinator must independently verify that watcher and export its identity.

The existing inner Job Object starts portable Node directly with explicit executable/arguments, suspended, assigns it before execution, and contains Node plus every Electron descendant. Its limits are 60 seconds, 16 processes, 2 GiB committed memory, 25% system CPU and 1 MiB retained per output stream. The pinned upstream Playwright Electron launcher uses a Windows command shell inside that inherited Job. `application.process()` therefore identifies that launcher, not Electron main. The kit preserves upstream framework bytes; actual Electron/service orderly-exit evidence is their `APP_EXIT`/`SERVICE_EXIT` records plus complete Job drain. The driver has a 52-second total deadline and an 8-second ordinary close deadline. It preserves failed assertions and exceptions without retrying or replacing them with cleanup success.

Two launches use distinct working directories outside the package and isolated TEMP/TMP, APPDATA/LOCALAPPDATA, Chromium profile and diagnostic directories. Each requires visible service/storage readiness, a synthetic scaffold status, sandbox/context isolation, disabled Node integration, absent renderer `require`/`process`, and a frozen bridge exposing only `getStatus`. It verifies the temporary SQLite probe exists before close and is removed afterward, contained launcher exit 0 without a signal, `APP_EXIT`/`SERVICE_EXIT` code 0 and the service stopped report. No production history is used. Job exit 0 establishes no remaining owned descendants; 124 (deadline) and 125 (orphan cleanup) fail acceptance.

Export the whole `evidence` directory before shutdown. `evidence/latest.json` points to the unique run; `guest-result.json`, `driver-result.json`, `guest-guard.json`, per-launch application/service JSONL, and Job stdout/stderr/owned PID retain the proof. Failed guest preconditions produce a failure report once the guest identity and kit root have been established. Identity rejection intentionally cannot write test files on another machine. A green driver result alone is insufficient: the wrapper must pass, the Job must exit 0, package fingerprints must still match, and the coordinator must confirm export, VM off, and restoration of the clean snapshot.

Installed package lifecycle, preserved data, longer stability and actual game compatibility remain separate pending criteria. Preparation and static parsing do not establish any runtime result.
