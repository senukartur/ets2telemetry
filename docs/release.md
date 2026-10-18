# Releases

ET-018 PR-6 (October 18, 2026) records what a release build is made of and whether it is signed. It implements plan decisions U14 to U16 and the owner's decisions O1 and O2 of October 18, 2026 ([concept.md](../concept.md#et-018-authorization--october-18-2026)). **Nothing has been published.** This document describes the channel and the checks; it authorizes no publication, certificate, paid service or auto-update.

## Channel (O2)

- **Where.** A GitHub Releases **pre-release** on the public repository, labelled **"unsigned internal alpha"** in its title and notes.
- **Who decides.** Every publication needs the owner's explicit authorization for that release. A merge, a passing CI run or an uploaded artifact is never a publication, and an agent never runs `gh release create` or edits a release without that authorization.
- **What is not a channel.** The Windows CI artifact `windows-installer-<run>-<attempt>` is internal identity evidence only: it needs a GitHub sign-in, comes zipped and expires after 14 days.
- **No auto-update.** The application has no update feed and checks for nothing. The installer lifecycle shows that a repair and an update through a local feed keep the data ([installer testing](installer-testing.md)); running a newer published Setup over an installed version is not yet observed.

## Release artifacts

`npm run make` writes the Squirrel distributable to `out/make/squirrel.windows/x64/`:

| File | What it is |
| --- | --- |
| `ETS2Telemetry-Setup-<version>.exe` | The installer the user runs. The name comes from `setupExe` in `forge.config.cjs`; it carries the `package.json` version. |
| `ETS2TelemetryDesktop-<version>-full.nupkg` | The full NuGet package that Setup installs, with the application under `lib/net45/`. A prerelease version loses the dots in its label (`0.2.0-beta.1` becomes `0.2.0-beta1`), as electron-winstaller converts it. |
| `RELEASES` | One line: the package's SHA-1, its name and its size. |
| `release-identity.json` | Written by `node scripts/release-identity.mjs` after the make; see below. |

The maker also sets `authors` (`ETS2Telemetry contributors`, which electron-winstaller also uses for the NuGet `owners` and `copyright`) and `description` in the package's nuspec. They are cosmetic.

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

**Authenticode.** One Windows PowerShell 5.1 call (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`) runs a fixed script with `PSModulePath` set to Windows PowerShell's own module folder, as `steam-registry.ts` does. The script imports only the built-in `Microsoft.PowerShell.Security` module by its full path under `$PSHOME` and calls `Get-AuthenticodeSignature` on each file. The paths arrive on standard input as base64 UTF-8, so a path never becomes script text and non-ASCII names survive. The output is parsed strictly: one line per file in order, a status from `SignatureStatus` (`Valid`, `UnknownError`, `NotSigned`, `HashMismatch`, `NotTrusted`, `NotSupportedFileFormat`, `Incompatible`) and a signer only with a thumbprint. The NuGet-only images are extracted to a temporary folder for the check and removed after.

### Installer inspection

`npm run inspect:package -- --installer` runs the usual portable inspection and then checks the make output:

- the folder holds exactly Setup, the full package and RELEASES (and `release-identity.json` once written), so a stale Setup of another version fails;
- RELEASES has one entry that names the package with its SHA-1 and size;
- the nuspec has the id `ETS2TelemetryDesktop` and the converted `package.json` version;
- the package's payload carries exactly the **projection** of the portable package, with the same SHA-256 for every file.

The projection follows the `<files>` rules of electron-winstaller 5.4.4's `template.nuspectemplate`: `locales\**`, `resources\**`, top-level `*.bin`, `*.dll`, `*.pak`, `*.exe.config` and `*.exe.sig`, `icudtl.dat`, `LICENSE`, the application executable, and `vk_swiftshader_icd.json` and `swiftshader\**`. The portable package's other files are left out; today these are `LICENSES.chromium.html` and `version`. A left-out file that is a native image fails, because it would ship in the portable package only.

The known Squirrel additions are `lib/net45/squirrel.exe`, an `<name>_ExecutionStub.exe` for each top-level executable, the nuspec, `[Content_Types].xml`, `_rels/.rels` and one `package/services/metadata/core-properties/<32 hex>.psmdcp`. Any other entry fails, and so does a missing projected file or a missing `squirrel.exe` or stub. The ZIP reader accepts stored and deflated entries only and checks each entry's CRC-32 and size.

Windows CI runs both on pushes to `main` and on dispatch, after the maker, and uploads the four files as `windows-installer-<run>-<attempt>` for 14 days ([ci](ci.md#et-018-release-artifact-identity)).

## Release checklist

Each item is required. Steps 3 to 5 need the owner's explicit authorization for this release.

1. **Version.** A PR sets `package.json` `version` to the release version. The installer lifecycle pins its installer versions (`0.1.0` and the `0.1.1` fixture) and finds Setup by name; `tests/unit/release-identity.test.ts` fails until `scripts/installer/Invoke-InstallerLifecycle.ps1` names the new Setup, so update the lifecycle in the same PR.
2. **Build.** After the merge, the push to `main` runs Windows CI. All three jobs must pass, including the installer lifecycle; download `windows-installer-<run>-<attempt>` from that run.
3. **Check the identity.** In `release-identity.json`: `source.commit` is the merged `main` head and `treeClean` is true; `versions` are as expected; the SHA-256 of each downloaded file equals `artifacts`; the Authenticode statuses are as recorded below (any `HashMismatch` stops the release).
4. **Publish.** With the owner's authorization only: create a GitHub pre-release with the tag `v<version>-alpha.<n>` (for example `v0.1.0-alpha.1`) on `source.commit`, a title that contains "unsigned internal alpha", and the four files exactly as downloaded. The notes give the SHA-256 of Setup, the unsigned consequences below and the checks that remain pending (real games, TruckersMP, a clean machine; see the [ET-018 validation](validation/et-018.md)).
5. **Released plugin list.** After publication and before the next release build, a PR appends `{"appVersion": "<version>", "sha256": "<plugin.sha256>"}` to `native/telemetry-plugin/released-plugins.json`. `plugin.sha256` in the identity equals the shipped `resources/telemetry-plugin/plugin-manifest.json`. Never remove an entry ([released plugin list](plugin-setup.md#released-plugin-list)).
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

**Observed statuses.** On the local make of October 18, 2026 (commit `b7392cd` with the PR-6 changes, not a release), 14 PE images were found: 12 `NotSigned`, among them every file of this project, Electron's executable and runtime DLLs, both better-sqlite3 Windows addons, the Squirrel helper, the stub and Setup, and 2 `Valid`: `d3dcompiler_47.dll` and `dxil.dll`, signed by Microsoft Windows with a timestamp. The hosted statuses are recorded in the [ET-018 validation](validation/et-018.md#pr-6-release-artifact-identity-and-signing-status-october-18-2026).

### Consequences of an unsigned alpha

- **SmartScreen.** Windows shows "Windows protected your PC" for the downloaded Setup, with the publisher "Unknown publisher". The user has to choose "More info" and then "Run anyway". Without a signature, reputation is tied to the file itself, so every new build starts without any.
- **Smart App Control.** On a Windows 11 PC where Smart App Control is on, an unsigned application without reputation is blocked, with no per-application override. Evaluation mode can block it as well.
- **Antivirus.** Heuristics may flag an unsigned installer, and an unsigned application that writes a DLL into a game folder.
- **Pending checks.** The SmartScreen prompt, Smart App Control in its on and evaluation modes and the antivirus reaction stay manual checks on a clean Windows machine ([ET-018 validation](validation/et-018.md)). A signed build's SmartScreen reputation is pending O1's follow-up.
