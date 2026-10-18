# Uninstall cleanup engine

ET-018 PR-2 (October 18, 2026) adds the engine that removes this application's own plugin files and local data on uninstall, in `apps/desktop/src/uninstall/`. It implements the owner's [uninstall rule of October 16, 2026](../concept.md#uninstall-removes-local-data--october-16-2026) and the ET-017 [contract with ET-018](plugin-setup.md#install-registry). **Nothing runs it yet:** PR-3 calls it from the Squirrel uninstall hook and PR-4 from the in-app uninstall, and PR-5 adds the deferred cleanup at the next sign-in. Tests run it only on fake installs under guarded temporary folders.

| Module | Role |
| --- | --- |
| `roots.ts` | Derives the folders an uninstall may touch from the running executable (U3) |
| `pending-record.ts` | The atomic intent `<data root>\uninstall\pending.json` (U5 step 2) |
| `plugin-cleanup.ts` | Removes this application's plugin from the recorded game folders (U5 step 3) |
| `data-wipe.ts` | Removes the allowlisted data entries without following links (U4) |
| `engine.ts` | The order, the budget and the outcome (U5) |

## Roots

The central safety rule: an uninstall derives its folders from the running executable's install location, never from `%LOCALAPPDATA%` alone. `resolveUninstallRoots` reads the layout `<base>\ETS2TelemetryDesktop\app-<semver>\<executable>`:

- `app-<semver>` must be a folder named like Squirrel's version folders, and `ETS2TelemetryDesktop` must be a folder holding a regular `Update.exe`. Anything else, such as the portable package, an unpackaged or a development launch, is `NOT_INSTALLED`, and nothing is deleted.
- The base must be an absolute drive path, not a bare drive (checked before anything is read) and not a link: `LAYOUT_INVALID`.
- The data root is `<base>\ETS2Telemetry`; a link there is `DATA_ROOT_LINKED`.
- **Test-root mode.** When the base is named `LocalAppData` and its parent holds the ET-017 marker `ets2telemetry-plugin-test-root.marker` and a valid `ets2telemetry-install-test.json` (format `ets2telemetry.install-test`, version 1, a profile folder inside that parent, a RunOnce key `null` or `HKCU\Software\ETS2Telemetry-Test-<32 hex>\RunOnce`, and a `shortcuts` flag), the mode is `test-root`. The `LOCALAPPDATA` variable is ignored, and plugin cleanup is confined to that parent through the ET-017 confinement (`confineToRoot`). A marker or test file alone, or an invalid test file, is `TEST_ROOT_INVALID`, never production. A test install, even one uninstalled from Windows Settings, can therefore only wipe its own test root.
- **Production mode.** Otherwise the real location of the `LOCALAPPDATA` variable must equal the base's; a missing, relative or different value is `ROOT_MISMATCH`, and nothing is deleted.

The refusal codes carry no path. Only a successful result holds paths, and only main uses it.

## Intent

Before the first deletion the engine writes `<data root>\uninstall\pending.json` atomically (a synced temporary file renamed over it):

```json
{"format": "ets2telemetry.uninstall-pending", "version": 1, "phase": "plugins", "startedUtc": "...", "attempts": 1,
 "known": ["<sha256>", ...], "folders": [{"game": "ets2", "root": "...", "hashes": ["<sha256>"], "temps": ["..."], "createdPluginsDirectory": false}]}
```

- `known` holds the bundle's own and earlier released hashes; `hashes` the hashes recorded for that folder or named by a pending install or update; `temps` the exact temporary files of pending intents, each validated as the installer's name inside that folder's `plugins` folder.
- A later run merges the intent's folders with the registry's, so it can finish even after the registry is gone. `attempts` counts the runs.
- When the run defers, the intent keeps only the folders still blocked, with `phase: "deferred"`.
- Parsing is strict (at most 128 KiB, 32 folders, 257 known hashes); an invalid or linked file is ignored, never trusted.

## Plugin cleanup

The ET-017 contract, step by step:

- **Registry states.** Only a registry that loads as `loaded` or `empty` is acted on. An `invalid-file`, `newer-version` or `unreadable` registry touches no game folder; the run defers with `REGISTRY_INVALID`, `REGISTRY_NEWER` or `REGISTRY_UNREADABLE`, and `plugins\` stays with `setup.json` and any `setup.rejected-*.json`. An `empty` registry means nothing to clean.
- **Folders.** Every folder named by an install record or by a pending `install` or `update` intent, plus the intent's folders, each once. A pending removal adds no folder.
- **Running games.** One running-game check (`game-processes.ts`), at most 3 s, before any folder. A running game or TruckersMP client blocks that game's folders (`GAME_RUNNING`, `CLIENT_RUNNING`); a failed or slow check blocks all of them (`RUNNING_CHECK_FAILED`).
- **Per folder.** The layout is checked again without following links: a linked `bin`, `bin\win_x64` or `plugins` is `LINKED_FOLDER`, a missing folder whose parent still exists is `absent` (the game was uninstalled), and a missing parent, such as an unplugged drive, is `FOLDER_UNAVAILABLE`. Then the exact temporary files are removed when they are regular files, the DLL is removed only while its hash is a recorded, pending or known hash, and the `plugins` folder only when this application created it and it is empty.
- **Kept.** A file with the plugin's name and an unknown hash, and every other file, stays; that folder is reported as `unrecognized` and does not block. A read-only DLL is skipped and reported as `READ_ONLY_FILE`, because Node's unlink on Windows would clear the attribute.
- **Locks.** A sharing violation (`EBUSY`) on the unlink is retried after 20, 40, 60, 80 and 100 ms, then reported; `EPERM` (a mapped image or a denied delete) is reported at once. Both are `TARGET_LOCKED`. A DLL another process opened without read sharing fails the hash read with `EBUSY`, also `TARGET_LOCKED`.
- **Registry.** After each cleaned folder, its install record, pending intents and failure are removed from `setup.json`.

`plugin-installer.ts` now exports the shared `hashPluginFile` and `removeEmptyPluginsDirectory`; the installer calls them unchanged.

## What is removed

The data root's top-level allowlist is `data`, `backups`, `settings`, `logs`, `synthetic`, `plugins`, `captures`, `transport` and `uninstall`, compared case-insensitively. A unit test fails if `dataPaths()` names anything outside it.

- **The walker** lstats every entry and never follows a link: a symbolic link or junction is unlinked itself, so its target is never entered. It never clears a read-only attribute; a read-only file stays and is reported (`READ_ONLY_FILE`), as does a locked or denied entry (`TARGET_LOCKED`, `PERMISSION_DENIED`).
- **Unknown top-level entries** stay and are counted as `kept`; the data root is removed only when it is empty.
- **Never touched:** exports, other plugins and game files, `%LOCALAPPDATA%\SquirrelTemp`, Squirrel's own binaries and any server records.
- **Roaming userData (O7).** The engine calls an optional `removeRoamingUserData` hook only in production mode and only after a complete run. PR-3 and PR-4 wire it; in test-root mode the result is `not-applicable`.

## Order and outcome

1. Read-only preflight: roots, registry, previous intent, running games.
2. The intent, before anything is deleted. If it cannot be written, the run is `refused` with `INTENT_FAILED` and nothing changes.
3. Plugin cleanup, folder by folder, with the registry updated after each.
4. Every folder clean: the allowlisted data except `plugins` and `uninstall`, then `plugins`, then `uninstall`, then the empty data root.
5. A folder blocked or a data entry left: everything except `plugins` and `uninstall` goes, and the intent keeps what is left.

`runUninstall` returns `complete`, `deferred` or `refused` with one primary code and counts: plugins `removed`, `absent`, `unrecognized` and the `blocked` games with their reasons, data entries `removed`, `kept` and `failed`, whether the data root is gone, and the Roaming result. It never carries a path. `complete` means nothing of this application is left in a game folder or an allowlisted data entry; unknown entries may remain and are counted.

- **Budget.** The caller passes a monotonic clock and a deadline (PR-3 uses 8 s inside Squirrel's 10 s hook). Before each folder and each data entry the engine checks it; once spent, the run stops and defers with `BUDGET_EXPIRED`. It never reports `complete` with something left.
- **Interruption.** Every step can be cut off and run again: a run killed after any deletion leaves a state that the next run finishes, from the registry, the intent or what is on disk.

## Tests

Fake installs under the guarded temporary root of `tests/shared/guarded-fs.ts`, built by `tests/shared/uninstall-fixture.ts`; nothing touches a real folder or the registry. See [TESTING.md](../TESTING.md#et-018-uninstall-cleanup-engine--october-18-2026) and [ET-018 validation](validation/et-018.md#pr-2-the-uninstall-cleanup-engine-october-18-2026).
