# Releases

ET-018 PR-6 (October 18, 2026) records what a release build is made of and whether it is signed. It implements plan decisions U14 to U16 and the owner's decisions O1 and O2 of October 18, 2026 ([concept.md](../concept.md#et-018-authorization--october-18-2026)). **Nothing has been published.** This document describes the channel and the checks; it authorizes no publication, certificate, paid service or auto-update.

## Channel (O2)

- **Where.** A GitHub Release on the public repository, labelled **"unsigned internal alpha"** in its title and notes. ET-055 UP4 amended O2 for production on October 28, 2026: a production release is an **ordinary** release that GitHub marks latest, titled `Yukon Union Telemetry <version> – unsigned internal alpha` and tagged `v<version>`, so that `releases/latest` serves it to installed builds. A staging release is a **pre-release** titled `Staging <version> – unsigned, for testing` and tagged `staging-v<version>`; it never becomes latest.
- **Who decides.** Every publication needs the owner's explicit authorization for that release. A merge, a passing CI run or an uploaded artifact is never a publication, and an agent never runs `gh release create` or edits a release without that authorization. Since ET-055 PR-9 every release goes through the dispatch-only [release workflow](#release-workflow-et-055): approving its `release-staging` environment is the owner's authorization of that staging release (UP16), and a production release needs the owner's offline signature and the `release-production` approval.
- **What is not a channel.** The Windows CI artifact `windows-installer-<run>-<attempt>` is identity evidence, not a publication or a distribution channel: it comes zipped, carries no release notes or label and expires after 14 days. It is not private, though. On this public repository any signed-in GitHub user can download Actions artifacts, so every push to `main` and every dispatch makes the unsigned Setup effectively public for 14 days. The artifact must therefore follow the [public repository rule](../AGENTS.md#repository-visibility-and-license--october-16-2026): it never holds a secret, token, personal path, account, player or profile data, or a raw capture. Its four files are build outputs with relative names only.
- **In-app updates (ET-055).** This bullet replaced "No auto-update" on October 28, 2026 (UP1). An installed build checks its channel's feed 15 s after its first readiness and then every 6 h, and downloads and installs only after the user's click; see [update feed](#update-feed-et-055) and [application lifecycle](app-lifecycle.md#in-app-updates-et-055). A build verifies only manifests signed by a public key it compiled (step 0 of the [release checklist](#release-checklist)). Since October 28, 2026 production and staging builds each compile the owner's key of their channel; every build made before that refuses every manifest. The installer lifecycle shows that a repair and an update through a local feed keep the data ([installer testing](installer-testing.md)); a real update from a published release is not yet observed.

## Update feed (ET-055)

ET-055 PR-6 (October 28, 2026) implements the client side of decisions UP3 to UP7 ([concept.md](../concept.md#et-055-in-app-updates-and-staging-channel--october-28-2026)). The [release workflow](#release-workflow-et-055) of PR-9 writes and publishes these files; **nothing has been published**.

**Where each channel looks.** A build only ever reads its own channel's feed, fixed when it is built:

| Channel | Requests |
| --- | --- |
| Production | `https://github.com/senukartur/ets2telemetry/releases/latest/download/update-manifest.json` and `update-manifest.json.sig`. `releases/latest` serves the newest ordinary release and never a pre-release, so a production release must be an ordinary release that GitHub marks latest (O2 as amended by UP4). |
| Staging | `GET https://api.github.com/repos/senukartur/ets2telemetry/releases?per_page=30` (at most 1 MiB in 10 s); among entries that are a pre-release, not a draft, tagged `staging-v<x.y.z>-stg.<6 digits>` and carrying an `update-manifest.json` asset, the highest NuGet version wins, whatever order the list has. Then `releases/download/<tag>/update-manifest.json` and `.sig`. |

The manifest and the signature are each at most 16 KiB and fetched within 10 s. 403 and 429 (GitHub's rate limits; the unauthenticated REST limit is 60 requests per hour per IP address) and network errors are a quiet `OFFLINE`. Requests go through Electron's `net.fetch`, so the system proxy applies, with a fixed User-Agent `YukonUnionTelemetry-Updater`, no cookies, no identifier and, apart from the list's `per_page`, no query string. GitHub still sees the IP address of every check.

**Update manifest, format v1.** `update-manifest.json` is one JSON object with exactly these keys:

| Key | Value |
| --- | --- |
| `format` | `ets2telemetry.update-manifest.v1` |
| `channel` | `production` or `staging`; must equal the build's channel |
| `appVersion` | The application version, for example `0.2.0` or `0.2.0-stg.000042` |
| `nugetVersion` | Its NuGet form (`0.2.0`, `0.2.0-stg000042`); must equal electron-winstaller's conversion of `appVersion` |
| `package` | `{tag, name, size, sha256, sha1}`: the release tag (`v<appVersion>` or `staging-v<appVersion>`), the nupkg name exactly `<Squirrel id>-<nugetVersion>-full.nupkg`, its size (1 byte to 400 MiB) and its lower-case hex SHA-256 and SHA-1 |
| `publishedUtc` | UTC ISO time with `Z` |
| `keyId` | The id of the key that signed it |

`update-manifest.json.sig` holds the base64 Ed25519 signature over the manifest's exact bytes (an optional final line break is accepted). The application verifies it with `node:crypto` against the public keys compiled into `apps/desktop/src/updater/update-keys.ts` for its own channel, chosen by `keyId`; rotation lists the new key beside the old one until no supported release is signed with the old one. After the signature it refuses, with fixed codes, a manifest of the other channel, a tag that is not the release it came from (staging) or not `v<appVersion>` (production, whose `/latest` redirect hides the tag), a package name other than its own exact one (the comparison is exact, so a name that only starts with another channel's Squirrel id is refused too), and a version that is not newer. It never takes a URL from the manifest: the package URL is rebuilt as `releases/download/<tag>/<name>`, redirects are followed, and integrity comes from the size and both hashes, checked while the file is written. The [release workflow](#release-workflow-et-055) publishes `update-manifest.json`, `update-manifest.json.sig`, the nupkg and `RELEASES` as release assets of the same tag, beside Setup and `release-identity.json`.

**The test feed.** Only an installation in a marked test root with an isolated profile inside that root (the hosted update lifecycle of PR-8) may set `ETS2TELEMETRY_UPDATE_TEST_FEED` to a loopback origin `http://127.0.0.1:<port>`, which then serves both the web and the REST paths, and `ETS2TELEMETRY_UPDATE_TEST_PUBLIC_KEY` to a test key with key id `test`. A production or staging installation ignores both variables.

## Release artifacts

Names below are the production channel's. A staging build (ET-055, [build channels](setup.md#build-channels-et-055)) writes `YukonUnionTelemetry-Staging-Setup-<version>.exe` and `ETS2TelemetryStagingDesktop-<NuGet version>-full.nupkg` (the staging Squirrel id) from `out/ETS2Telemetry Desktop Staging-win32-x64`, with the version `<package.json version>-stg.<6-digit run>`; `inspect-package` and `release-identity.mjs` check the names of the channel that `ETS2TELEMETRY_BUILD_CHANNEL` selects, so run them with the build's variables. Since ET-055 PR-4 a local build is staging: a production build is accepted only on a GitHub-hosted Actions runner or with the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1`, and agents never make one, so a production release artifact comes from Windows CI on `main` ([CI](ci.md#build-channels-et-055-pr-4)). The [release workflow](#release-workflow-et-055) of ET-055 PR-9 publishes them; the [release checklist](#release-checklist) lists the steps around it.

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
- **Uninstall.** After `--removeShortcut`, the hook deletes this install's old-name shortcuts in the same two places without requiring a current one. The receipt keeps its fields: `shortcuts` is `removed` only when `--removeShortcut` succeeded, no owned old-name shortcut failed to delete and none was left undecided (past the deadline, uninspectable or unreadable), otherwise `failed`; a shortcut proven foreign does not count ([uninstall](uninstall.md)).
- **Not touched.** Taskbar and Start pins (the user made them; Squirrel retargets them, and they keep their old label until pinned again), the `Artur Sianiuk` folder, other files and the autostart Run value.
- **Limitation.** The hook finds the Start menu as `<Roaming AppData known folder>\Microsoft\Windows\Start Menu\Programs`. A Start Menu redirected apart from Roaming AppData is not found, and its old shortcut stays.

Only the artifact built by Windows CI on `main`, a push to `main` or a dispatch on `main`, is ever shipped, never a local build or a branch dispatch's staging artifact (ET-055 PR-4): MSVC builds are not reproducible, and the [released plugin list](plugin-setup.md#released-plugin-list) must name the shipped DLL's hash.

## Release identity

`scripts/release-identity.mjs` reads the portable package `out/ETS2Telemetry Desktop-win32-x64`, the make output and the vendored Squirrel binaries in `node_modules/electron-winstaller/vendor`. It writes `out/make/squirrel.windows/x64/release-identity.json` and runs nothing it inspects. Every name in the file is relative; no machine path, user name or temporary folder enters it.

| Field | Content |
| --- | --- |
| `channel` | The build channel, `production` or `staging` (ET-055, `scripts/build-channel.mjs`); every name the identity checks is that channel's. |
| `builtBy` | Who built the artifacts (ET-055 PR-4, UP13): `{"kind": "github-actions", "runId": "<GITHUB_RUN_ID>"}` in GitHub Actions, or `{"kind": "local", "runId": null}`. A GitHub Actions build without a valid `GITHUB_RUN_ID` fails. The [release workflow](#release-workflow-et-055) accepts only artifacts whose run id is the `main` run it downloads from. |
| `source` | `commit` (`git rev-parse HEAD`), `sourceCommit` (`ETS2TELEMETRY_SOURCE_COMMIT` on CI) and `treeClean` (no tracked change). |
| `versions` | `app` (the build version: `package.json`, with `-stg.<run>` in staging), `nuget`, `electron` (the packaged runtime's `version` file, which must equal the `package.json` pin) and `plugin` (the bundle manifest's `appVersion`, which must equal `app`). |
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

Windows CI runs both on pushes to `main` and on dispatch, after the maker, and uploads the four files as `windows-installer-<run>-<attempt>` for 14 days; since ET-055 PR-4 a dispatch on any other branch builds staging and uploads `windows-installer-staging-<run>-<attempt>`, which is never installed as production ([ci](ci.md#et-018-release-artifact-identity)).

## Release workflow (ET-055)

ET-055 PR-9 (October 28, 2026) adds `.github/workflows/release.yml` and the scripts in `scripts/release/`. It implements UP4, UP5, UP13 and UP16 ([concept.md](../concept.md#et-055-in-app-updates-and-staging-channel--october-28-2026)). **The workflow has never been dispatched and nothing has been published.** The two environments, the staging secret and both public keys are the owner's one-time setup in step 0 below. On October 28, 2026 both public keys were added, and the owner created both environments and the staging secret. A released build without a channel's key would stop the workflow at its manifest step with `No compiled <channel> update key in the released build`.

**Dispatch only.** The workflow never runs on pushes or pull requests. A dispatch must be made on `main` and takes:

| Input | Meaning |
| --- | --- |
| `run_id` | A Windows CI run on `main`. The API answer must name `.github/workflows/windows-ci.yml` of this repository (not a fork), the branch name `main`, the event `push` or `workflow_dispatch`, and a completed, successful run. Because a branch name is only a name, the workflow also refuses the release while a tag named `main` exists, reads the main branch's commit from the unambiguous `git/ref/heads/main`, and requires `compare/<run commit>...<main's commit>` to be `identical` or `ahead` with the run's commit as the merge base, so the commit is in the main branch's history. The installer artifact of its latest attempt is used: `windows-installer-<run>-<attempt>` for production, `windows-installer-staging-<run>-<attempt>` for staging. Artifacts expire after 14 days, so a release must finish within that time |
| `channel` | `staging` (the default) or `production` |
| `mode` | `release` (the default): staging signs and publishes a pre-release, production creates a draft and stops. `publish_signed`: production only, after the owner signed |
| `signature` | `publish_signed` only: the one base64 line of the owner's `update-manifest.json.sig`, which is not secret |
| `key_id` | Optional: the keyId the manifest names. Empty selects the channel's only key compiled at the run's commit; with several such keys, during a rotation, it must be given |

**Jobs and permissions.** The workflow's default permission is `contents: read`. Every job runs on the GitHub-hosted `ubuntu-24.04` runner, and its actions are pinned by commit as in Windows CI. Inputs reach scripts only through the environment. No job runs `npm ci`: the scripts use only `node:` modules.
- **Concurrency.** One group, `release`, with `cancel-in-progress: false`: one release runs and at most one more dispatch waits. GitHub keeps one pending run per group, so a further dispatch cancels the waiting one, never the running one.
- **Compiled keys.** Every job that writes or verifies a manifest fetches the CI run's commit and takes `apps/desktop/src/updater/update-keys.ts` from it (`git show <commit>:<path>`), never from the dispatch checkout. The scripts read that copy through Node's type stripping (`--keys-file`). A manifest therefore names, and is verified against, only a key the released build compiled, and a build that ships without a key of its channel is never released with a manifest no installation of it could verify.
- **GitHub answers.** Every GET whose 404 is an answer (the latest release, a tag, the run, `refs/heads/main`, the comparison) goes through `scripts/release/gh-get.sh`: exit 0 with the body, 44 when gh's error line ends exactly in `(HTTP 404)`, with an empty file, and 1 for any other failure. The final `releases/latest` confirmation retries a failure like a stale answer and decides only after its last try. `gh api` writes a 404's error body to standard output, so the body of a failed request is never read as a tag, and a failed request never passes as "missing".
- **Candidate artifact.** `verify` hands the checked files to the publish job as `release-candidate-<run>-<attempt>`, kept for 7 days. The owner must approve the environment within those 7 days; after that the dispatch is repeated.

| Job | Runs when | Environment and permissions | What it does |
| --- | --- | --- | --- |
| `verify` | always | none; `contents: read`, `actions: read` | Refuses a dispatch outside `main` or an invalid input, checks the run (`scripts/release/check-github-release.mjs run`) and that its commit is on main (`ancestry`, after refusing a tag `main`), reads the compiled keys at that commit, downloads its installer artifact with `gh run download` and checks it with `scripts/release/write-update-manifest.mjs`. In mode `release` it writes the unsigned `update-manifest.json` and the release notes. For production it refuses a version that is not higher than the current latest release (`newer`). It hands the files to the next job as a 7-day artifact |
| `publish-staging` | `staging`, `release` | `release-staging`; `contents: write` | Signs with the environment secret `UPDATE_SIGNING_KEY_STAGING`, verifies the signature against the staging keys of the run's commit and the artifact, refuses an existing release or tag, and creates the pre-release on the run's commit with all six assets and `--latest=false`. Then it confirms the release's flags and assets and that `releases/latest` did not change |
| `draft-production` | `production`, `release` | `release-production`; `contents: write` | Refuses an existing release or tag and creates a **draft** on the run's commit with Setup, the nupkg, `RELEASES`, `release-identity.json` and the unsigned manifest. It prints the owner's signing commands in the job summary. Nothing is published |
| `publish-production` | `production`, `publish_signed` | `release-production`; `contents: write` | Finds exactly one draft with the tag, checks its target and assets, and compares its files byte for byte with the run's artifact. It verifies the given signature against the production keys of the run's commit and the artifact, checks again that the version is higher than the current latest release, uploads the `.sig` and publishes the release with `make_latest=true`. Then it confirms the assets, that the tag names the run's commit and that `releases/latest` names the tag (six tries, 10 s apart); otherwise it fails with an error |

**What the artifact check refuses** (`write-update-manifest.mjs`):
- a folder that does not hold exactly Setup, the nupkg, `RELEASES` and `release-identity.json`;
- an identity of the other channel, a `builtBy` other than `github-actions` with the downloaded run's id, a commit other than the run's head, or `treeClean` not true;
- a production version with a staging label, or a staging version that is not `x.y.z-stg.<6 digits>` or carries the local run number `000000` (UP15: every such build has the same version);
- a NuGet version other than electron-winstaller's conversion;
- Setup or the nupkg not named exactly as the channel names them, the nupkg exactly `<Squirrel id>-<NuGet version>-full.nupkg`;
- any size or SHA-256 that differs from the identity, and a `RELEASES` line that does not name the nupkg with its SHA-1 and size.

The manifest it writes has exactly the [v1 keys](#update-feed-et-055). Its `package` fields come from the verified nupkg, `publishedUtc` is the time it was written (for production, the time of the draft) and `keyId` names a key of the channel compiled at the run's commit.

**Production version order** (`check-github-release.mjs newer`). The latest release's tag must be `v<version>`, and the new version must be higher by the application's own NuGet SemVer comparison, after electron-winstaller's conversion: `0.1.0-alpha.10` becomes `0.1.0-alpha10`, which sorts below `alpha9`, so it is refused (step 1). Without a latest release any production version passes. An installed build would refuse an equal or lower version as `NOT_NEWER` or `DOWNGRADE`.

**Keys and signatures** (`scripts/release/generate-update-key.mjs` and `sign-update-manifest.mjs`):
- A key pair is Ed25519. The private key is an unencrypted PKCS#8 PEM file. The generator writes it only to a new file outside every Git working tree and refuses any path inside the repository.
- The keyId is `<channel>-<first 16 hex digits of the SHA-256 of the raw public key>`. The signer refuses a manifest whose keyId is not its own key's keyId, so a manifest written for another key or channel is never signed.
- The signer writes `update-manifest.json.sig`: the base64 signature over the exact manifest bytes and a line break. It reads the key from a file outside every Git working tree or, only in GitHub Actions and only for a staging manifest, from a named environment variable.
- It never prints, logs or writes the key. It prints only what it signed: the channel, version, tag, package name, size, SHA-256 and keyId.
- The owner's production key is never given to the workflow or to an agent.

`tests/unit/release-scripts.test.ts` and `tests/unit/release-workflow.test.ts` cover the scripts and the workflow text (REG-019). They show that a manifest written and signed by the scripts is accepted by the application's own verifier, and refused after any byte change, with a wrong key and in a build of the other channel. A corpus of malformed manifests and signatures gets the same answer from the scripts and the application. The workflow itself and `gh-get.sh` have not run.

## Release checklist

Each item is required. Only step 4 publishes, and only with the owner's authorization for that release.

0. **One-time setup (owner only; ET-055 UP5 and UP16).** Before the first release with the updater:
   1. **Production key, offline.** On a machine the private key never leaves, and outside any Git checkout, the owner runs `node scripts/release/generate-update-key.mjs --channel production --out <new file outside the repository>`. It prints one line, `{keyId: 'production-…', publicKey: '…'}`. Keep the private key file offline and backed up: if it is lost, no installed build can verify a newer production release until a build with a new key is installed by hand. **Done on October 28, 2026:** the owner generated the production key, `production-611eb870520f2b0f`, and the staging key, `staging-9a83aca3ea8c5402`.
   2. **Staging key.** `node scripts/release/generate-update-key.mjs --channel staging --out <new file outside the repository>`.
   3. **Public keys in a PR.** A PR adds each printed line to its channel's list in `UPDATE_PUBLIC_KEYS` in `apps/desktop/src/updater/update-keys.ts`, and updates the tests that pin the shipped empty lists. Only public keys belong there. Every manifest is refused with `SIGNATURE_INVALID` by a build without the key, so the first build with a key reaches installations by a manual Setup (UP20). Both keys are in the lists since October 28, 2026.
   4. **Environments.** In the repository settings, create the environments `release-staging` and `release-production`, each with the owner as its required reviewer and deployments limited to the `main` branch.
   5. **Staging secret.** Add the whole content of the staging private key file as the `release-staging` environment secret `UPDATE_SIGNING_KEY_STAGING`, then delete the local copy or keep it offline. The production key is never stored in GitHub.

   Agents never generate, hold or use a real signing key, and never create the environments or the secret.
1. **Version.** A PR sets `package.json` `version` to a plain `x.y.z` version higher than every earlier release, for example `0.1.2`, then `0.1.3`. Since ET-055 a prerelease label such as `0.1.0-alpha.1` is no longer usable: the main run builds staging from the same base, and the staging resolver (`STAGING_BASE` in `scripts/build-channel.mjs`) and the production installer lifecycle (`LIFECYCLE_VERSION`) both require a plain `x.y.z`, so the run would fail and leave nothing to release (coordinator decision under owner delegation, October 28, 2026). The release title still says "unsigned internal alpha". Never ship two releases with the same version: Squirrel would treat the second as a repair of the first instead of an update, and the released plugin list would get two entries with the same `appVersion`. Setup is `YukonUnionTelemetry-Setup-<version>.exe`, the package `ETS2TelemetryDesktop-<version>-full.nupkg` and the installed folder `app-<version>`. The updater compares by SemVer 2.0 precedence, so a new version must be higher there too. A staging release takes its version from the staging run number (UP15) and needs no version PR; its base is the same `package.json` version, so it is never lower than the last production version.
   - **Toolchain check (October 18, 2026, historical: prerelease labels are not usable since ET-055).** With `0.1.0-alpha.1` in a local working copy, `npm run make`, `npm run inspect:package -- --installer` and `node scripts/release-identity.mjs` all passed, with the names above, `versions.nuget` `0.1.0-alpha1`, the plugin bundle's `appVersion` `0.1.0-alpha.1` and the executable's file and product version `0.1.0-alpha.1`. Installing it and Squirrel's ordering of two alphas were not observed; the installer lifecycle of the version PR is the first check.
   - **Installer lifecycle.** It pins its installer versions (`0.1.0`, the `app-0.1.0` folder, the registered version, and the `0.1.1` fixture). Since ET-055 PR-4 it finds Setup by the name the build evidence gives (`node scripts/build-channel.mjs --built`), so a new version no longer needs a new Setup name in the harness; update the lifecycle's pinned versions in the same PR, and keep its fixture version above the new version.
2. **Build.** After the merge, the push to `main` runs Windows CI, which builds the production channel there (`ETS2TELEMETRY_BUILD_CHANNEL=production` in GitHub Actions, ET-055 PR-4); a local or agent build is staging and is never a release artifact. All three jobs must pass, including the installer lifecycle. Note the run id. A staging release needs a `main` run that uploaded `windows-installer-staging-<run>-<attempt>` with `release-identity.json` and a real staging run number. On `main`, the job `windows-staging-build` (ET-055 PR-5) builds that artifact: since PR-9 it sets `ETS2TELEMETRY_STAGING_RUN_NUMBER` to `github.run_number` zero-padded to 6 digits (the resolver accepts 1 to 6 digits; a 7-digit run number stops the job), so the version is `<package.json version>-stg.<NNNNNN>`, writes `release-identity.json` and uploads `windows-installer-staging-<run>-<attempt>` with Setup, the nupkg, `RELEASES` and the identity, before its side-by-side hand-off `windows-staging-input-<run>-<attempt>` and its lifecycle, which use the same build. A branch dispatch and every pull request still build `-stg.000000`, which the release workflow refuses. The same `main` run therefore provides both release artifacts. The first such hosted run has not happened yet.
3. **Check the identity.** The CI step has already refused `HashMismatch` and `UnknownError` (the [signing status gate](#release-identity)), and the release workflow checks the channel, `builtBy`, the commit, `treeClean`, the versions and every hash. Before dispatching, the owner still downloads the artifact and reads `release-identity.json`: the other statuses are as recorded below, and any `NotTrusted`, `NotSupportedFileFormat` or `Incompatible` is explained before the release goes on.
4. **Publish**, per channel, with the owner's authorization for this release. Approve each environment within 7 days of its dispatch, while the candidate artifact exists; otherwise dispatch again.
   - **Staging.** Dispatch `gh workflow run release.yml --repo senukartur/ets2telemetry --ref main -f run_id=<run> -f channel=staging`. Approving the `release-staging` deployment is the authorization to publish this staging release (UP16). The job signs, publishes the pre-release `staging-v<version>` and confirms that `releases/latest` did not change. Steps 5 and 6 do not apply to staging, and its released plugin list may stay empty (UP17).
   - **Production**, in two dispatches:
     1. Dispatch `gh workflow run release.yml --repo senukartur/ets2telemetry --ref main -f run_id=<run> -f channel=production` and approve `release-production`. The job creates the draft `v<version>` with the unsigned manifest and prints the signing commands in its summary.
     2. On the offline machine, in a checkout of `main`, run `gh release download v<version> --repo senukartur/ets2telemetry --pattern update-manifest.json --dir <folder>`, or carry the file there, then `node scripts/release/sign-update-manifest.mjs --manifest <folder>\update-manifest.json --key <production private key file>`. Compare the printed tag, package name, size and SHA-256 with the draft's nupkg and `release-identity.json`.
     3. Dispatch `gh workflow run release.yml --repo senukartur/ets2telemetry --ref main -f run_id=<run> -f channel=production -f mode=publish_signed -f "signature=$((Get-Content -LiteralPath <folder>\update-manifest.json.sig -Raw).Trim())"` and approve `release-production`. The job verifies the signature, uploads it, publishes with `make_latest=true` and fails unless `releases/latest` names the new tag. If it fails after publishing, the release is already public: inspect it on GitHub, mark it latest by hand if needed, and do not dispatch again.
   - The release notes give the source commit, the CI run, the SHA-256 of Setup and of the nupkg, the unsigned consequences below and the checks that remain pending (real games, TruckersMP, a clean machine; see the [ET-018 validation](validation/et-018.md)). Without an explicit choice, GitHub's `releases/latest` is the non-draft, non-pre-release release with the newest `created_at`, which is the date of the release's commit, not its version, so a release on an older commit would not become latest (plan risk R4). The workflow refuses a version that is not higher than the current latest before the draft and again before publishing, sets `make_latest=true`, and fails if `releases/latest` still does not name the new tag.
5. **Released plugin list (production).** This step still applies to every production release the workflow publishes. After publication and before the next release build, a PR appends `{"appVersion": "<package.json version>", "sha256": "<plugin.sha256>"}`, with the full version (for example `0.1.2`), to `native/telemetry-plugin/released-plugins.json`. `plugin.sha256` in the identity equals the shipped `resources/telemetry-plugin/plugin-manifest.json`. Never remove an entry ([released plugin list](plugin-setup.md#released-plugin-list)).
6. **Signing follow-up (production).** This step still applies. After the first alpha is published, apply to the SignPath Foundation (O1, [TD-014](technical-debt.md#td-014-code-signing)).

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
