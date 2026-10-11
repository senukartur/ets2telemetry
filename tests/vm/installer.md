# Disposable guest installer acceptance

This is a source-only preparation and guest-only runtime workflow for ET-001. Do not execute Node/Electron/Setup/Update on the physical host for acceptance. The coordinator owns fixture building, kit preparation, transport, VM boot and its independent outer watchdog, interactive dispatch, export, shutdown and clean-snapshot restoration. The four portable lifecycle harness files remain unchanged.

The original maker Setup installs 0.1.0. The upgrade feed is a private test fixture with NuGet version 0.1.1 and byte-identical original 0.1.0 application runtime, including ASAR metadata. It is not a product version change or release. Build the fixture only from a disposable clone: electron-winstaller copies its Squirrel executable into its input app directory. Do not run its synthetic Setup. Use only the fixture full NuGet and local RELEASES feed.

Plan or prepare from the task checkout; the preparation script never executes a binary or builds a fixture:

```powershell
./tests/vm/Prepare-InstallerKit.ps1
./tests/vm/Prepare-InstallerKit.ps1 -Prepare -OutputDirectory 'D:\Projects\ETS2Telemetry\.local\vm-lab\acceptance-prep\installer-kit-<unique-id>' -UpgradeFeed 'D:\Projects\ETS2Telemetry\.local\vm-lab\acceptance-prep\upgrade-fixture-3a69548\feed' -InstallerOutput 'D:\Projects\ETS2Telemetry\.local\worktrees\et-001\out\make\squirrel.windows\x64' -ExpectedSetupSha256 '<reviewed original Setup SHA256>' -ExpectedOriginalNugetSha256 '<reviewed original full NuGet SHA256>'
```

Preparation verifies the original maker preimages, frozen portable fingerprint and ASAR, original NuGet payload against frozen package bytes, and exact fixture/original NuGet runtime equivalence. It validates local RELEASES entries against SHA1/size. Every transferred byte receives a manifest SHA256. Layout is `installer/Setup.exe`, `feed/`, `tools/node.exe` and the unchanged Job helper, `node_modules/playwright-core/`, three `harness/` sources, and `kit-manifest.json`. The original NuGet is inspected on the host without extracting or executing it and need not be transferred. No browser download or guest development tool installation is needed.

Expand the verified kit into `C:\ETS2ET001Acceptance` in a pristine disposable guest, preserving `C:\ETS2VMwareLab`. The coordinator's separate installer runner must require at least 185 seconds remaining on the already armed 300-second outer watchdog immediately before dispatch. Existing portable-runner 85-second task and 115-second headroom limits are unsuitable for this workflow. Its installer task should allow the 160-second guest sequence plus verification/export allowance, remain bounded by the outer deadline, and independently inspect all six steps. If transfer leaves insufficient time, fail before execution and restore; do not extend or weaken the outer watchdog. No intermediate state snapshot is assumed or requested.

Guest invocation, never a physical-host command:

```powershell
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File 'C:\ETS2ET001Acceptance\harness\Invoke-GuestInstallerAcceptance.ps1' -Run -ExpectedManifestSha256 '<reviewed installer manifest SHA256>' -ExpectedPackageSha256 'ffd4227c69487d31b63b8f92f1de4205103ec68648d4c11e8336ad061015d69f' -ExpectedAsarSha256 '2356ed080cb8854e2358065b3a209632814ae0777951ed3d41d447dbc11d2790' -OuterDeadlineUtc '<already armed UTC outer deadline>'
```

The wrapper requires matching VMware UUID/manufacturer/model, original marker, exact root and manifest identity, all transferred hashes, and pristine per-user installation/data/registry/shortcut state. Real guest LOCALAPPDATA/APPDATA remain in use: Squirrel's per-user binary root is `ETS2TelemetryDesktop`, separately from application data `ETS2Telemetry`. Every step gets fresh TEMP/TMP, SQUIRREL_TEMP, profile and diagnostic paths under evidence. The global 160-second clock includes kit verification and postconditions; per-step Job limits use the smaller of their assigned limit and remaining global time, reserving five seconds. Budget exhaustion fails acceptance.

| Step | Actual operation | Maximum Job duration |
| --- | --- | --- |
| Install | Original `Setup.exe --silent` | 45 seconds |
| Repair | Same original `Setup.exe --silent` | 45 seconds |
| Installed smoke | Direct installed `app-0.1.0` EXE | 30 seconds |
| Upgrade | Installed `Update.exe --update <local feed>` | 45 seconds |
| Upgraded smoke | Direct installed `app-0.1.1` EXE | 30 seconds |
| Uninstall | Installed `Update.exe --uninstall --silent` | 30 seconds |

These are individual ceilings, not an additive time allowance. Each existing Job starts portable Node directly, suspended, and assigns it before execution. Limits remain 16 processes, 2 GiB committed memory, 25% system CPU and 1 MiB retained per stream. No watchdog code changes or kills by process name are introduced.

Inside that Job, the observer queries only its current Job PID list. WMI reads command lines for those owned PIDs; read-only held process handles retain their final exit codes. It records actual installer lifecycle hook arguments/version and requires hook exit 0. It also requires successful self-update helper observations for install/repair/update. Node remains alive after the primary updater exits until the observer sees only itself and Node, with all held child processes exited; then the observer exits naturally and Node returns. This handles the self-update helper's wait for its direct updater parent. Job exit 124 or 125 always fails. Missing fast-process observations fail and remain visible; there is no retry or alternate acceptance path.

Installed files must match the exact NuGet runtime set and every original runtime hash. The execution stub is explicitly mapped from its NuGet name into the binary root. Portable `LICENSES.chromium.html` and `version` are documented maker omissions; only bounded generated `Squirrel-UpdateSelf[.N].log` files are allowed additionally beside the installed Squirrel executable. The root updater must equal the reviewed Squirrel payload. Installed RELEASES must select only the tested full package with matching size/SHA1/SHA256; registry version/location/uninstall command and Desktop/Start Menu targets are checked. This proves selection of the tested installation version, while the smoke directly launches that version's EXE; shortcut/stub dispatch is not exercised.

Both installed smokes require visible storage/service readiness, a screenshot, the actual installed executable path, unchanged application metadata version 0.1.0, renderer isolation/sandbox/narrow frozen bridge, the SQLite probe before close and its removal afterward, application/service exit records 0, ordinary Playwright close within eight seconds and complete Job drain. Upstream Playwright's Windows shell wrapper remains inside the inherited Job and is explicitly recorded.

Five clearly synthetic file sentinels cover data, settings, archived logs, backups and project plugin metadata. The first contained Node step additionally creates a real small SQLite preservation fixture at `data/telemetry.sqlite` using built-in `node:sqlite`, with a synthetic table and row 42. Its database handle closes and immutable preimage JSON is saved before Setup starts. Every step checks that table and SQLite integrity read-only; the wrapper compares all six sentinel sizes/hashes after every operation, including uninstall. This establishes installer byte preservation, not production schema, migrations, game history or updater feature support. The scaffold's native storage probe still exercises its packaged better-sqlite3 worker separately.

Export the complete bounded `evidence/` directory and the separately verified host watcher/transport receipts before shutting down and restoring the clean snapshot. `latest.json` points to `guest-result.json`; each step retains guard, driver result, Job stdout/stderr/owned PID, read-only process observation, SQLite preimage where created, postcondition proof, bounded Squirrel logs and source map. The two smokes retain screenshots and application/service logs. Host acceptance requires six step driver passes and six Job exits 0, matching identities, overall budget compliance, sentinel/projection/registry/shortcut proofs, evidence export, confirmed VM off and confirmed clean restoration. Sources and static parsing alone establish no runtime result.

Primary lifecycle references match the local Squirrel binary's `2.0.1+eef37460ae` version: [command handling and log placement](https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Update/Program.cs), [hook and self-update ordering](https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Squirrel/UpdateManager.ApplyReleases.cs), [stub extraction mapping](https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Squirrel/ReleasePackage.cs), and [current Job read-only queries](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject).
