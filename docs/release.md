# Releases

ET-018 PR-6 (October 18, 2026) records what a release build is made of and whether it is signed. It implements plan decisions U14 to U16 and the owner's decisions O1 and O2 of October 18, 2026 ([concept.md](../concept.md#et-018-authorization--october-18-2026)). **Nothing has been published.** This document describes the channel and the checks; it authorizes no publication, certificate, paid service or auto-update.

## Channel (O2)

- **Where.** A GitHub Releases **pre-release** on the public repository, labelled **"unsigned internal alpha"** in its title and notes.
- **Who decides.** Every publication needs the owner's explicit authorization for that release. A merge, a passing CI run or an uploaded artifact is never a publication, and an agent never runs `gh release create` or edits a release without that authorization.
- **What is not a channel.** The Windows CI artifact `windows-installer-<run>-<attempt>` is identity evidence, not a publication or a distribution channel: it comes zipped, carries no release notes or label and expires after 14 days. It is not private, though. On this public repository any signed-in GitHub user can download Actions artifacts, so every push to `main` and every dispatch makes the unsigned Setup effectively public for 14 days. The artifact must therefore follow the [public repository rule](../AGENTS.md#repository-visibility-and-license--october-16-2026): it never holds a secret, token, personal path, account, player or profile data, or a raw capture. Its four files are build outputs with relative names only.
- **No auto-update.** The application has no update feed and checks for nothing. The installer lifecycle shows that a repair and an update through a local feed keep the data ([installer testing](installer-testing.md)); running a newer published Setup over an installed version is not yet observed.

## Release artifacts

`npm run make` writes the Squirrel distributable to `out/make/squirrel.windows/x64/`:

| File | What it is |
| --- | --- |
| `YukonUnionTelemetry-Setup-<version>.exe` | The installer the user runs. The name comes from `setupExe` in `forge.config.cjs`; it carries the `package.json` version. Before ET-045h it was `ETS2Telemetry-Setup-<version>.exe`. |
| `ETS2TelemetryDesktop-<version>-full.nupkg` | The full NuGet package that Setup installs, with the application under `lib/net45/`. A prerelease version loses the dots in its label (`0.2.0-beta.1` becomes `0.2.0-beta1`), as electron-winstaller converts it. |
| `RELEASES` | One line: the package's SHA-1, its name and its size. |
| `release-identity.json` | Written by `node scripts/release-identity.mjs` after the make; see below. |

The maker also sets `title` (`Yukon Union Telemetry`, the Installed apps DisplayName), `authors` (`Yukon Union Telemetry contributors`, the Installed apps Publisher, which electron-winstaller also uses for the NuGet `owners` and `copyright`; `ETS2Telemetry contributors` before ET-045h) and `description` in the package's nuspec ([product name](#product-name-et-045h)).

### Installed apps icon (ET-045g)

Windows Settings → Installed apps showed the Electron atom, while the window, tray, taskbar, Start menu and Desktop icons were right. The cause is in the pinned tools: electron-winstaller 5.4.4 sets `iconUrl` to the Electron icon on GitHub when the maker gives none, and Squirrel's `CreateUninstallerRegistryEntry` (commit `eef37460ae`) downloads it into `<install root>\app.ico` and points the uninstall entry's `DisplayIcon` at that file, but only when the file does not exist yet ([installer testing](installer-testing.md#squirrel-behaviour-of-the-pinned-electron-winstaller)). `setupIcon` changes only Setup.exe's own icon.

Under owner decision D3 of October 24, 2026 our own hooks fix it, without relying on `iconUrl`:

- Forge ships `resources/icon` as an extra resource, so every installed version has `app-<version>\resources\icon\app.ico`, the tracked icon that is also embedded in the executable and Setup. `inspect-package.mjs` requires exactly that file with the tracked bytes; `--installer` checks that the NuGet package carries the same files.
- `--squirrel-install` and `--squirrel-updated` run before Squirrel's registration. Beside the shortcuts, they place that icon at `<install root>\app.ico` (atomically, read back and compared, never through a link; a failure keeps the previous file) and set `DisplayIcon` of `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ETS2TelemetryDesktop` to `<install root>\app-<version>\ETS2TelemetryDesktop.exe,0` through `reg.exe` with fixed arguments, one retry and 2 s per attempt (`apps/desktop/src/installed-app-icon.ts`). With `app.ico` in place Squirrel downloads nothing and leaves `DisplayIcon` alone. The value changes with every version, so Windows is not expected to reuse an icon it cached for the old value; the owner check confirms it. Nothing clears the icon cache.
- `iconUrl` stays the default: electron-winstaller accepts HTTP(S) URLs only, and no other value was verified.

Residual risks, by which part of the hook fails:

- **The icon placement fails on a fresh install.** Then `app.ico` is missing, so Squirrel downloads the atom again (online) and points `DisplayIcon` at it for that version.
- **The `DisplayIcon` write fails after the icon was placed, on a fresh install.** Squirrel then skips its icon branch, because `app.ico` exists, so the entry has no `DisplayIcon`. Windows shows a generic icon until the next install or update.
- **The `DisplayIcon` write fails on an update.** The entry keeps its old value. If that value is Squirrel's `<install root>\app.ico`, the file now holds the product bytes. If it is the previous version's executable, it still shows the product icon while that `app-` folder exists. After two such failures in a row, the value names an `app-` folder that no longer exists, and Windows shows a generic icon, not the atom. If Squirrel's install fails after the hook created the key, a key with only `DisplayIcon` stays; it has no `DisplayName`, so Installed apps does not list it, and the next install or uninstall replaces or deletes it. Names, the Setup file name and the Squirrel id are unchanged here (ET-045h). The real Installed apps view remains an owner check ([ET-045g validation](validation/et-045g.md)).

### Product name (ET-045h)

Under owner decision D2 of October 24, 2026 the product's user-facing name is **Yukon Union Telemetry**. Only display names changed; every technical identity stays, so an update keeps one installation, one Installed apps entry, the single-instance lock, the settings, the history and the plugin ownership.

| What Windows shows | Source | Value |
| --- | --- | --- |
| Installed apps DisplayName | nuspec `title` (maker `title`) | `Yukon Union Telemetry` |
| Installed apps Publisher | nuspec `authors` (maker `authors`) | `Yukon Union Telemetry contributors` |
| Shortcut name, Task Manager, file Properties | executable `ProductName` and `FileDescription` (`packagerConfig.win32metadata`) | `Yukon Union Telemetry` |
| Start menu folder | executable `CompanyName` | `Artur Sianiuk` (pinned to the value packager inferred before; H2) |
| Setup file | maker `setupExe` | `YukonUnionTelemetry-Setup-<version>.exe` |

Unchanged on purpose: `package.json` `productName` `ETS2Telemetry Desktop` (it decides `%APPDATA%\ETS2Telemetry Desktop`, the single-instance lock and `out/ETS2Telemetry Desktop-win32-x64`), the Squirrel id `ETS2TelemetryDesktop` (the install root `%LOCALAPPDATA%\ETS2TelemetryDesktop`, the Uninstall key and the shortcut AUMID), the executable `ETS2TelemetryDesktop.exe` and its `OriginalFilename`, `appBundleId`, the data root `%LOCALAPPDATA%\ETS2Telemetry`, the plugin DLL, pipes, environment variables, the RunOnce value and the receipt, export and diagnostic schemas and file names. Changing `productName` or the Squirrel id would move userData and the lock and create a parallel installation with a second Uninstall entry.

`inspect-package.mjs` reads the executable's version resource through one bounded Windows PowerShell call (`[Diagnostics.FileVersionInfo]`, nothing is run) and requires `ProductName` = `FileDescription` = `Yukon Union Telemetry`, `CompanyName` = `Artur Sianiuk` and `OriginalFilename` = `ETS2TelemetryDesktop.exe`. `--installer` and the release identity also require the nuspec `title` and `authors` above. `tests/unit/product-name.test.ts` fails on any user-facing "ETS2Telemetry" outside literal folder and file names.

### Shortcut migration (ET-045h)

Squirrel names a shortcut after the executable's `ProductName` and puts the Start menu entry in `Programs\<CompanyName>` (pinned commit `eef37460ae`). Before ET-045h that was `ETS2Telemetry Desktop.lnk`; now it is `Yukon Union Telemetry.lnk`. `Update.exe --createShortcut` writes only the current name and `--removeShortcut` removes only the current name, so without migration an updated install would show both shortcuts and an uninstall would leave the old one.

- **Install and updated.** A newer Setup over an existing install runs `--squirrel-install`; only `Update.exe --update` runs `--squirrel-updated`. Both hooks, after `--createShortcut` succeeded, delete `ETS2Telemetry Desktop.lnk` on the Desktop and in `Programs\Artur Sianiuk` (`apps/desktop/src/legacy-shortcuts.ts`), but only when:
  - it is a plain file of at most 64 KiB, not a link;
  - the new-name shortcut exists beside it, so the user is never left without one;
  - it can be read (Electron's `shell.readShortcutLink`) and belongs to this install: no AUMID or Squirrel's `com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop`, and a target of the install root's stub `ETS2TelemetryDesktop.exe`, an `app-<version>\ETS2TelemetryDesktop.exe`, or `Update.exe --processStart ETS2TelemetryDesktop.exe` (optionally with `--process-start-args <one argument>`).

  A foreign, unreadable or unexpected file with the old name is kept. The step has a 1 s budget and runs beside the deferral disarm, so the hooks' worst case stays 12 s inside Squirrel's 15 s. A kept old shortcut still starts the application (it points at the stub), and the next install or update tries again.
- **Uninstall.** After `--removeShortcut`, the hook deletes this install's old-name shortcuts in the same two places without requiring a current one. The receipt keeps its fields: `shortcuts` is `removed` only when `--removeShortcut` succeeded and no owned old-name shortcut failed to delete, otherwise `failed`.
- **Not touched.** Taskbar and Start pins (the user made them; Squirrel retargets them, and they keep their old label until pinned again), the `Artur Sianiuk` folder, other files and the autostart Run value.
- **Limitation.** The hook finds the Start menu as `<Roaming AppData known folder>\Microsoft\Windows\Start Menu\Programs`. A Start Menu redirected apart from Roaming AppData is not found, and its old shortcut stays.

Only the artifact built by Windows CI on a push to `main` or a dispatch is ever shipped, never a local build: MSVC builds are not reproducible, and the [released plugin list](plugin-setup.md#released-plugin-list) must name the shipped DLL's hash.

## Release identity

`scripts/release-identity.mjs` reads the portable package `out/ETS2Telemetry Desktop-win32-x64`, the make output and the vendored Squirrel binaries in `node_modules/electron-winstaller/vendor`. It writes `out/make/squirrel.windows/x64/release-identity.json` and runs nothing it inspects. Every name in the file is relative; no machine path, user name or temporary folder enters it.

| Field | Content |
| --- | --- |
| `source` | `commit` (`git rev-parse HEAD`), `sourceCommit` (`ETS2TELEMETRY_SOURCE_COMMIT` on CI) and `treeClean` (no tracked change). |
| `versions` | `app` (`package.json`), `nuget`, `electron` (the packaged runtime's `version` file, which must equal the `package.json` pin) and `plugin` (the bundle manifest's `appVersion`, which must equal `app`). |
| `artifacts` | Name, size and SHA-256 of Setup, the full package and RELEASES. |
| `package` | The portable package fingerprint of `scripts/package-integrity.mjs`, the number of files the NuGet package carries, the package files it leaves out and Squirrel's additions. |
| `plugin` | The plugin DLL's SHA-256 and size. The bundle is verified first (`verifyPluginBundle`): the DLL bytes must equal the manifest's hash and size. |
| `broker` | The native broker's SHA-256, which must equal `executableSha256` in its `build-evidence.json`. |
| `squirrel` | `updateExe`: the payload's `lib/net45/squirrel.exe`, which Squirrel installs as `Update.exe` and which must equal the vendored `Squirrel.exe`; the execution stubs Squirrel generates; the SHA-256 of the vendored `Squirrel.exe`, `Setup.exe` and `StubExecutable.exe`. |
| `peImages` | Every PE image with its location (`package`, `nupkg` or `installer`), relative path, size, SHA-256, machine and Authenticode result: `status`, `signer` (the certificate subject or null), `thumbprint` and `timestamped`. |
| `foreignNodeAddons` | The ELF and Mach-O prebuilds of other platforms that better-sqlite3 ships; Windows never loads them and Authenticode does not apply to them. |
| `signing` | The recorded decision and the count of images per status. |

**Finding PE images.** The script walks the package tree and reads each file's header (`MZ`, the `e_lfanew` offset and `PE\0\0`); no list of names is kept. A PE image with any name is listed. An `.exe` or `.dll` that is not a PE image fails, and so does a `.node` file that is neither a PE image nor an ELF or Mach-O image. The nupkg's own additions and Setup are listed too.

**Packed native code.** The walk sees only files on disk, so native code packed inside `resources/app.asar` would escape it, and Windows could not load it from there anyway. `npm run inspect:package` and the identity therefore fail when an archive entry that is not physically unpacked has a `.node`, `.dll` or `.exe` name or a PE, ELF or Mach-O header under any name (`Native code packed inside app.asar: <entries>`). Today every such file is unpacked into `resources/app.asar.unpacked`, where the walk lists it.

**Authenticode.** One Windows PowerShell 5.1 call (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`) runs a fixed script with `PSModulePath` set to Windows PowerShell's own module folder, as `steam-registry.ts` does. The script imports only the built-in `Microsoft.PowerShell.Security` module by its full path under `$PSHOME` and calls `Get-AuthenticodeSignature` on each file. The paths arrive on standard input as base64 UTF-8, so a path never becomes script text and non-ASCII names survive. The output is parsed strictly: one line per file in order, a status from `SignatureStatus` (`Valid`, `UnknownError`, `NotSigned`, `HashMismatch`, `NotTrusted`, `NotSupportedFileFormat`, `Incompatible`) and a signer only with a thumbprint. The NuGet-only images are extracted to a temporary folder for the check and removed after.

**Signing status gate.** The identity fails, and writes no file, when any PE image reports one of these statuses, with the fixed message `Authenticode <status>: <location> <relative path>`:

| Status | Why it fails |
| --- | --- |
| `HashMismatch` | A signed file whose bytes changed after signing: tampered or corrupt. |
| `UnknownError` | Windows PowerShell maps only a few WinVerifyTrust results to named statuses (no error, a bad algorithm, no signature, a bad digest or message, an unknown provider, explicit distrust) and every other result to `UnknownError`. Besides a malformed signature or a verifier fault, it therefore covers an untrusted root, a certificate that expired without a timestamp, a revoked certificate and a chain that cannot be built. These are deterministic: a rerun gives the same result, and a person must inspect the file before any release. An unsigned PE image reports `NotSigned` (observed locally on a synthetic image), not `UnknownError`. |

`NotSigned` is expected for the unsigned alpha and is recorded. `NotTrusted` means only that a certificate is explicitly distrusted (trust-store problems such as an untrusted root are `UnknownError`), and `NotSupportedFileFormat` and `Incompatible` depend on the file type and the Windows version; they are recorded without failing, and step 3 of the checklist looks at them.

### Installer inspection

`npm run inspect:package -- --installer` runs the usual portable inspection and then checks the make output:

- the folder holds exactly Setup, the full package and RELEASES (and `release-identity.json` once written), so a stale Setup of another version fails;
- RELEASES has one entry that names the package with its SHA-1 and size;
- the nuspec has the id `ETS2TelemetryDesktop`, the converted `package.json` version, the title `Yukon Union Telemetry` and the authors `Yukon Union Telemetry contributors` (ET-045h);
- the package's payload carries exactly the **projection** of the portable package, with the same SHA-256 for every file.

The projection follows the `<files>` rules of electron-winstaller 5.4.4's `template.nuspectemplate`: `locales\**`, `resources\**`, top-level `*.bin`, `*.dll`, `*.pak`, `*.exe.config` and `*.exe.sig`, `icudtl.dat`, `LICENSE`, the application executable, and `vk_swiftshader_icd.json` and `swiftshader\**`. The portable package's other files are left out; today these are `LICENSES.chromium.html` and `version`. A left-out file that is a native image fails, because it would ship in the portable package only.

The known Squirrel additions are `lib/net45/squirrel.exe`, an `<name>_ExecutionStub.exe` for each top-level executable, the nuspec, `[Content_Types].xml`, `_rels/.rels` and one `package/services/metadata/core-properties/<32 hex>.psmdcp`. Any other entry fails, and so does a missing projected file or a missing `squirrel.exe` or stub. The ZIP reader accepts stored and deflated entries only and checks each entry's CRC-32 and size.

Windows CI runs both on pushes to `main` and on dispatch, after the maker, and uploads the four files as `windows-installer-<run>-<attempt>` for 14 days ([ci](ci.md#et-018-release-artifact-identity)).

## Release checklist

Each item is required. Step 4 needs the owner's explicit authorization for this release; no other step publishes anything.

1. **Version.** A PR sets `package.json` `version` to a version no earlier build has used: every alpha gets its own prerelease version, for example `0.1.0-alpha.1`, then `0.1.0-alpha.2`. Never ship two alphas with the same version: Squirrel would treat the second as a repair of the first instead of an update, and the released plugin list would get two entries with the same `appVersion`. NuGet drops the dots of the label (`0.1.0-alpha1`), so Setup is `YukonUnionTelemetry-Setup-0.1.0-alpha.1.exe`, the package `ETS2TelemetryDesktop-0.1.0-alpha1-full.nupkg` and the installed folder `app-0.1.0-alpha1`. NuGet's version 1 rules compare that label as text, so `alpha10` would sort before `alpha2`: after `alpha.9`, move to the next patch version instead.
   - **Toolchain check (October 18, 2026).** With `0.1.0-alpha.1` in a local working copy, `npm run make`, `npm run inspect:package -- --installer` and `node scripts/release-identity.mjs` all passed, with the names above, `versions.nuget` `0.1.0-alpha1`, the plugin bundle's `appVersion` `0.1.0-alpha.1` and the executable's file and product version `0.1.0-alpha.1`. Installing it and Squirrel's ordering of two alphas were not observed; the installer lifecycle of the version PR is the first check.
   - **Installer lifecycle.** It pins its installer versions (`0.1.0`, the `app-0.1.0` folder, the registered version, and the `0.1.1` fixture) and finds Setup by name. `tests/unit/release-identity.test.ts` fails until `scripts/installer/Invoke-InstallerLifecycle.ps1` names the new Setup, so update the lifecycle's versions in the same PR; its fixture version must stay above the new version.
2. **Build.** After the merge, the push to `main` runs Windows CI. All three jobs must pass, including the installer lifecycle; download `windows-installer-<run>-<attempt>` from that run.
3. **Check the identity.** The CI step has already refused `HashMismatch` and `UnknownError` (the [signing status gate](#release-identity)), so an identity file exists only without them. Then look in `release-identity.json`: `source.commit` is the merged `main` head and `treeClean` is true; `versions` are as expected; the SHA-256 of each downloaded file equals `artifacts`; the other statuses are as recorded below, and any `NotTrusted`, `NotSupportedFileFormat` or `Incompatible` is explained before the release goes on.
4. **Publish.** With the owner's authorization only: create a GitHub pre-release with the tag `v<package.json version>`, exactly `v` followed by `versions.app` of the identity (for example `v0.1.0-alpha.1`), on `source.commit`, a title that contains "unsigned internal alpha", and the four files exactly as downloaded. The notes give the SHA-256 of Setup, the unsigned consequences below and the checks that remain pending (real games, TruckersMP, a clean machine; see the [ET-018 validation](validation/et-018.md)).
5. **Released plugin list.** After publication and before the next release build, a PR appends `{"appVersion": "<package.json version>", "sha256": "<plugin.sha256>"}`, with the full prerelease version (for example `0.1.0-alpha.1`), to `native/telemetry-plugin/released-plugins.json`. `plugin.sha256` in the identity equals the shipped `resources/telemetry-plugin/plugin-manifest.json`. Never remove an entry ([released plugin list](plugin-setup.md#released-plugin-list)).
6. **Signing follow-up.** After the first alpha is published, apply to the SignPath Foundation (O1, [TD-014](technical-debt.md#td-014-code-signing)).

## Signing

**Decision (O1, owner, October 18, 2026).** Builds are an unsigned internal alpha for now, and nothing is bought. After the first alpha release the project applies to the SignPath Foundation. The signing status of every PE image is recorded in `release-identity.json`.

Options assessed by the plan (U16):

| Option | Cost | Limits |
| --- | --- | --- |
| Azure Artifact Signing | about $9.99/month | Individuals only in the USA and Canada, so the owner would need an EU organization |
| SignPath Foundation | free for OSI-licensed projects | Certificate issued to SignPath; needs an existing release and reputation, so apply after the first alpha |
| Certum Open Source in the Cloud | from €49 | Interactive 2FA, so no CI key custody |
| Another CA's OV certificate | $150–300 per year | Needs a cloud HSM |

- **Validity and timestamps.** Certificates are valid for at most about 460 days. Signatures need RFC 3161 timestamps so that they stay valid after the certificate expires.
- **What to sign.** The application executable and its execution stub, the broker executable, the plugin DLL, Setup, `Update.exe` and `squirrel.exe`.
- **The plugin DLL first.** It must be signed before the build stages it, because the bundle manifest, the install registry's ownership hashes and the released plugin list must all name the signed bytes. A signed DLL therefore has a new hash, which the released list must carry before a later version can recognize it.
- **Not ours to sign.** Electron's DLLs and better-sqlite3's `.node` addons are third-party files.

**Observed statuses.** On the local make of October 18, 2026 (commit `b7392cd` with the PR-6 changes, not a release), 14 PE images were found: 12 `NotSigned`, among them every file of this project, Electron's executable and runtime DLLs, both better-sqlite3 Windows addons, the Squirrel helper, the stub and Setup, and 2 `Valid`: `d3dcompiler_47.dll` and `dxil.dll`, signed by Microsoft Windows with a timestamp. The hosted dispatch [39124098698](https://github.com/senukartur/ets2telemetry/actions/runs/39124098698) found the same statuses for the same 14 images; there the two Microsoft DLLs report the signer `CN=Microsoft Corporation`, because Get-AuthenticodeSignature reports the signature it validates on each machine ([ET-018 validation](validation/et-018.md#hosted-run-1)).

### Consequences of an unsigned alpha

- **SmartScreen.** Windows shows "Windows protected your PC" for the downloaded Setup, with the publisher "Unknown publisher". The user has to choose "More info" and then "Run anyway". Without a signature, reputation is tied to the file itself, so every new build starts without any.
- **Smart App Control.** On a Windows 11 PC where Smart App Control is on, an unsigned application without reputation is blocked, with no per-application override. Evaluation mode can block it as well.
- **Antivirus.** Heuristics may flag an unsigned installer, and an unsigned application that writes a DLL into a game folder.
- **Pending checks.** The SmartScreen prompt, Smart App Control in its on and evaluation modes and the antivirus reaction stay manual checks on a clean Windows machine ([ET-018 validation](validation/et-018.md)). A signed build's SmartScreen reputation is pending O1's follow-up.
