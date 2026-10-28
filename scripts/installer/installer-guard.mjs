import path from 'node:path';
import {BUILD_CHANNELS, BUILD_IDENTITIES} from '../build-channel.mjs';

// ET-018 PR-1 (U12): the fail-closed guards of the installer lifecycle harness (docs/installer-testing.md). Every check is
// a pure decision over facts the harness gathers: the real known folders (resolved by Windows, never from environment
// variables), the Steam libraries, the uninstall registration, the running processes, the run root's marker files and
// each path's real location. Nothing here reads the registry, lists processes or touches the file system; the only
// file-system access is the injected `realpath` of resolveRealLocation. A refusal throws InstallerGuardError with a
// fixed code and never names a path, so a refusal message can be logged and uploaded.
//
// ET-055 PR-5 (UP12, UP19): every name that differs between the build channels (the install root and Uninstall key, the
// data root, the executable, the display names, the AUMID, the plugin file, the RunOnce value and the receipts) comes
// from lifecycleIdentity(channel), which derives it from scripts/build-channel.mjs. A run installs the channel of the
// build that was made, or, in the side-by-side scenario, both channels into one run root; every check names the channel
// it judges. The real roots of both channels are always protected.

/** The run root's folder name: `installer-` and a 32-digit lower-case hexadecimal identifier. */
export const RUN_ROOT_NAME = /^installer-[0-9a-f]{32}$/;
/** The ET-017 test-root marker (apps/desktop/src/plugin-setup/mode.ts); the run root holds it like a plugin test root. */
export const PLUGIN_TEST_ROOT_MARKER = 'ets2telemetry-plugin-test-root.marker';
/** The installer test file of the run root (plan U3): its format, version and fixed name. */
export const INSTALL_TEST_FILE = 'ets2telemetry-install-test.json';
export const INSTALL_TEST_FORMAT = 'ets2telemetry.install-test';
export const INSTALL_TEST_VERSION = 1;
/** The per-run RunOnce key a later deferred cleanup may use (plan U7); PR-1 writes null. */
export const RUN_ONCE_KEY = /^HKCU\\Software\\ETS2Telemetry-Test-[0-9a-f]{32}\\RunOnce$/;
/** The production Squirrel application name, binary root folder and uninstall registration key (lifecycleIdentity has both channels'). */
export const PRODUCT_ROOT = BUILD_IDENTITIES.production.squirrelId;
/** The production data root under a LocalAppData folder. */
export const DATA_ROOT = BUILD_IDENTITIES.production.dataRootName;
/** Electron's production Roaming userData folder (the productName). */
export const ROAMING_ROOT = BUILD_IDENTITIES.production.productName;

export class InstallerGuardError extends Error {
  /** @param {string} code @param {string} [detail] a relative name inside the run root, never a machine path */
  constructor(code, detail) {
    super(`Installer lifecycle refused: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'InstallerGuardError';
    this.code = code;
  }
}
const refuse = (code, detail) => {throw new InstallerGuardError(code, detail);};

/** The Installed apps Publisher of both channels since ET-045h (forge.config.cjs `authors`). */
export const PRODUCT_PUBLISHER = 'Yukon Union Telemetry contributors';
/**
 * ET-055 PR-5: the names the lifecycle checks for one build channel, from BUILD_IDENTITIES (scripts/build-channel.mjs,
 * which tests/unit/channel-identity.test.ts pins to apps/desktop/src/channel.ts). `productRoot` is the Squirrel id: the
 * binary root's folder name and the HKCU Uninstall key's name. `roamingRoot` is Electron's productName folder under
 * Roaming. `appUserModelId` is Squirrel's shortcut AUMID, which Electron also uses as the autostart Run value name.
 * `executorReceiptPrefix` names the deferred-cleanup executor's receipt (resources/uninstall/Complete-ETS2TelemetryUninstall.ps1).
 */
export function lifecycleIdentity(channel) {
  if (!BUILD_CHANNELS.includes(channel)) refuse('LIFECYCLE_CHANNEL_UNKNOWN');
  const identity = BUILD_IDENTITIES[channel];
  return Object.freeze({channel, productRoot: identity.squirrelId, dataRoot: identity.dataRootName, roamingRoot: identity.productName,
    executable: `${identity.executableName}.exe`, displayName: identity.displayName, publisher: PRODUCT_PUBLISHER,
    legacyDisplayNames: Object.freeze([...identity.legacyShortcutNames]), appUserModelId: `com.squirrel.${identity.squirrelId}.${identity.executableName}`,
    pluginFile: identity.pluginFileName, runOnceValue: identity.runOnceValue, receiptPrefix: identity.receiptPrefix,
    executorReceiptPrefix: `${identity.dataRootName}-deferred-cleanup-`});
}
/** Both channels' lifecycle identities, production first. */
export const LIFECYCLE_IDENTITIES = Object.freeze(BUILD_CHANNELS.map(lifecycleIdentity));
/** The channels one run installs: one channel, or both for the side-by-side scenario; each at most once. */
export function checkRunChannels(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > BUILD_CHANNELS.length || new Set(channels).size !== channels.length ||
    channels.some(channel => !BUILD_CHANNELS.includes(channel))) refuse('RUN_CHANNELS_INVALID');
  return channels;
}

const LIFECYCLE_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-stg\.\d{6})?$/;
/** electron-winstaller's convertVersion (scripts/release-identity.mjs nugetVersion): the prerelease label without dots. */
const installedVersionOf = version => version.replace(/^(\d+\.\d+\.\d+)-(.*)$/, (_match, main, label) => `${main}-${label.replace(/\./g, '')}`);
/**
 * ET-055 PR-5: the versions of a lifecycle run from the application version of the build that was made (UP15): `0.1.0` in
 * production, `0.1.0-stg.000000` in staging. Install A is that build; the upgrade fixture B raises its patch number and
 * keeps its staging label (`0.1.1`, `0.1.1-stg.000000`), so B sorts above A in both channels. `package` is the version
 * the installer package carries, `installed` its NuGet form, which Squirrel names `app-<version>` and writes as the
 * registration's DisplayVersion. `appVersion` is what the application reports in both installs: the fixture repacks A's
 * bytes, so B's application still reports A's version. A production build carries a plain version, a staging build one
 * with its `-stg.<6 digits>` label.
 */
export function lifecycleVersions(channel, appVersion) {
  return Object.freeze({channel, appVersion, a: lifecycleFixtureVersion(channel, appVersion, 0), b: lifecycleFixtureVersion(channel, appVersion, 1)});
}
/**
 * ET-055 PR-8: the version of an upgrade fixture `step` patch numbers above the build's (0: the build itself, 1: B, 2:
 * the update-from-feed scenario's C, `0.1.2` or `0.1.2-stg.000000`), as lifecycleVersions derives B; the same refusals.
 */
export function lifecycleFixtureVersion(channel, appVersion, step) {
  const match = typeof appVersion === 'string' ? LIFECYCLE_VERSION.exec(appVersion) : null;
  if (!BUILD_CHANNELS.includes(channel) || !match || (channel === 'production') !== (match[4] === undefined) || ![0, 1, 2].includes(step)) refuse('LIFECYCLE_VERSION_INVALID');
  const version = `${match[1]}.${match[2]}.${Number(match[3]) + step}${match[4] ?? ''}`;
  return Object.freeze({package: version, installed: installedVersionOf(version)});
}

/** A Windows drive path such as `C:\folder`; UNC, device, relative and drive-relative paths are not. */
export function isDrivePath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\0]/.test(value);
}
/** Normalized, without a trailing separator, lower case: Windows paths compare case-insensitively. */
export function normalizePath(value) {
  return path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
}
/** Whether `candidate` is `parent` or lies inside it, by normalized path. */
export function isInside(candidate, parent) {
  const child = normalizePath(candidate), root = normalizePath(parent);
  return child === root || child.startsWith(`${root}\\`);
}

/**
 * The CI signal (U12): the harness runs on a GitHub-hosted runner. `allowLocal` is the owner-requested local run (O6,
 * `-AllowLocal`): it skips the signal, so only the fact-based guards protect the machine. Agents never pass it. Since
 * ET-018 PR-3 the application's own Squirrel handler skips the shortcuts of a test install whose test file says so,
 * which the harness writes for every run that is not on a hosted runner.
 */
export function checkRunSignal(env, {allowLocal = false} = {}) {
  if (allowLocal === true) return;
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') refuse('LOCAL_RUN_REFUSED');
}
/**
 * ET-055 PR-4 and PR-5 (UP13): the build channel of a Setup the lifecycle may install. Outside a GitHub-hosted runner (an
 * owner-requested -AllowLocal run) only a staging Setup may be installed, never the production identity of the owner's
 * installed application, so a production Setup runs on a hosted runner only, and with it the side-by-side scenario, which
 * installs both. A staging Setup runs on a hosted runner, or locally under -AllowLocal and every fact-based guard below;
 * checkRunSignal decides that part.
 */
export function checkSetupChannel(channel, env) {
  if (channel !== 'production' && channel !== 'staging') refuse('SETUP_CHANNEL_UNKNOWN');
  if (channel === 'production' && (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted')) refuse('LOCAL_PRODUCTION_REFUSED');
}
/**
 * The one top-level folder Windows may create under any LOCALAPPDATA a process runs with: the shell and Update.exe add
 * `Microsoft\Windows\Caches` (and possibly more below `Microsoft`) beside the decoy's sentinels. Nothing else is allowed.
 */
export const DECOY_OS_FOLDER = 'Microsoft';
/**
 * The decoy check of the Windows-initiated uninstall (ET-018 PR-3, U12). `before` and `after` are trees keyed by the
 * relative path (a folder ends with `\`), with `{directory: true}` or `{size, sha256}` values. Every entry of `before`
 * must be in `after` with the same value; a new entry is allowed only below the top-level `Microsoft` folder and never
 * with a component named `ETS2Telemetry*`. Returns the number of allowed new entries; throws the first refusal.
 */
export function checkDecoyUnchanged(before, after) {
  for (const [entry, value] of Object.entries(before)) {
    if (!Object.hasOwn(after, entry)) refuse('DECOY_ENTRY_REMOVED');
    const now = after[entry];
    if (JSON.stringify({directory: now.directory ?? false, size: now.size ?? null, sha256: now.sha256 ?? null}) !==
      JSON.stringify({directory: value.directory ?? false, size: value.size ?? null, sha256: value.sha256 ?? null})) refuse('DECOY_ENTRY_CHANGED');
  }
  let allowed = 0;
  for (const entry of Object.keys(after)) {
    if (Object.hasOwn(before, entry)) continue;
    const parts = entry.split('\\').filter(Boolean);
    if (parts.some(part => part.toLowerCase().startsWith('ets2telemetry'))) refuse('DECOY_PRODUCT_ENTRY_ADDED');
    if (parts[0]?.toLowerCase() !== DECOY_OS_FOLDER.toLowerCase()) refuse('DECOY_ENTRY_ADDED');
    allowed++;
  }
  return allowed;
}

/** SQLite's sidecar files beside a database in `data\`: they come and go with the open connection and its checkpoints. */
const DATA_SIDECAR = /^data\\[^\\]+\.sqlite-(wal|shm|journal)$/i;
/** A database file in `data\`, compared by presence only: a checkpoint rewrites its pages without any data change. */
const DATA_DATABASE = /^data\\[^\\]+\.sqlite$/i;
/** Entries a blocked in-app uninstall must leave in the data root: the history folder and database, the plugin registry. */
export const DATA_ROOT_REQUIRED = Object.freeze(['data\\', 'data\\telemetry.sqlite', 'plugins\\', 'plugins\\setup.json']);
/**
 * ET-018 PR-4: a blocked in-app uninstall changes nothing in the data root. `before` is taken while the application runs
 * and `after` once it closed orderly, which checkpoints the history database's WAL and removes it. So the SQLite sidecars
 * of `data\` are left out of the comparison, and a database file there is compared by presence. Every entry of
 * DATA_ROOT_REQUIRED must be in both; every other entry must keep its kind, size and hash (plugins\setup.json among
 * them), and none may appear or disappear. Refuses with the entry's relative name; returns the number of sidecars left
 * out. `before` and `after` map relative names to `{directory}` or `{size, sha256}`, like the driver's tree().
 */
export function checkDataRootUnchanged(before, after) {
  let sidecars = 0;
  const view = tree => {
    const rows = new Map();
    for (const [entry, value] of Object.entries(tree ?? {})) {
      if (DATA_SIDECAR.test(entry)) {sidecars++; continue;}
      rows.set(entry, DATA_DATABASE.test(entry) ? 'present'
        : JSON.stringify({directory: value?.directory ?? false, size: value?.size ?? null, sha256: value?.sha256 ?? null}));
    }
    return rows;
  };
  const was = view(before), now = view(after);
  for (const entry of DATA_ROOT_REQUIRED) if (!was.has(entry) || !now.has(entry)) refuse('DATA_ROOT_REQUIRED_MISSING', entry);
  for (const [entry, value] of was) {
    if (!now.has(entry)) refuse('DATA_ROOT_ENTRY_REMOVED', entry);
    if (now.get(entry) !== value) refuse('DATA_ROOT_ENTRY_CHANGED', entry);
  }
  for (const entry of now.keys()) if (!was.has(entry)) refuse('DATA_ROOT_ENTRY_ADDED', entry);
  return sidecars;
}

/** The binary-root listing of the harness holds at most this many entries; a longer one refuses. */
export const RESIDUE_MAX_ENTRIES = 256;
const APP_FOLDER = /^app-\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** Names that are never Electron runtime files, whatever the distribution lists: both channels' and Squirrel's executables. */
const NEVER_RUNTIME = new Set(['electron.exe', ...BUILD_CHANNELS.map(channel => `${BUILD_IDENTITIES[channel].executableName}.exe`.toLowerCase()), 'squirrel.exe', 'update.exe']);
/**
 * The Electron runtime file names, from a listing of the installed `node_modules/electron/dist`: its top-level files
 * except `electron.exe` (renamed to the product's executable in a package), and the files of its `locales` folder.
 * Its `resources` folder and every other folder are not runtime files. `entries` holds `{name, directory}` rows of
 * the top level and `locales` the file names of `locales`. Names are compared case-insensitively.
 */
export function electronRuntimeNames(entries, locales) {
  if (!Array.isArray(entries) || !entries.some(entry => !entry.directory && /\.(bin|dll|pak|dat)$/i.test(entry.name))) refuse('ELECTRON_DIST_INVALID');
  return {
    files: new Set(entries.filter(entry => !entry.directory && !NEVER_RUNTIME.has(entry.name.toLowerCase())).map(entry => entry.name.toLowerCase())),
    locales: new Set((locales ?? []).map(name => name.toLowerCase()))
  };
}
/**
 * The binary root after a Windows-initiated uninstall (ET-018 PR-3; docs/installer-testing.md, "Binary root residue").
 * `listing` holds the harness's rows `{relative, kind, reparse, vendorHelper, deadMarker}` with `/`-separated names
 * relative to the binary root. Allowed: `app-<version>` folders; `Update.exe` and `app-<version>/squirrel.exe` with
 * the installed helper's bytes; the root `.dead` (required) and `app-<version>/.dead`, one space each. Tolerated and
 * reported: Electron runtime files (`runtime`, from electronRuntimeNames) at the top of an `app-<version>` folder and in
 * its `locales` folder. Anything else fails with its relative name: the product's executable, `resources` and
 * everything below it, a link, any other file or folder. Returns the vendor helper count and the tolerated names.
 */
export function checkUninstallResidue(listing, runtime) {
  if (!Array.isArray(listing) || listing.length > RESIDUE_MAX_ENTRIES) refuse('UNINSTALL_RESIDUE_TOO_LARGE');
  let marker = false, vendorFiles = 0;
  const tolerated = [];
  for (const row of listing) {
    const name = String(row?.relative ?? '');
    const parts = name.split('/');
    const inApp = parts.length >= 2 && APP_FOLDER.test(parts[0]);
    if (row.reparse !== false) refuse('UNINSTALL_REPARSE_POINT', name);
    if (row.kind === 'directory') {
      if (parts.length === 1 && APP_FOLDER.test(parts[0])) continue;
      if (inApp && parts.length === 2 && parts[1].toLowerCase() === 'locales') {tolerated.push(name); continue;}
      refuse('UNINSTALL_UNEXPECTED_DIRECTORY', name);
    }
    if (row.kind !== 'file') refuse('UNINSTALL_UNEXPECTED_FILE', name);
    const leaf = parts.at(-1).toLowerCase();
    if ((parts.length === 1 && leaf === '.dead') || (inApp && parts.length === 2 && leaf === '.dead')) {
      if (row.deadMarker !== true) refuse('UNINSTALL_MARKER_INVALID', name);
      if (parts.length === 1) marker = true;
      continue;
    }
    if ((parts.length === 1 && leaf === 'update.exe') || (inApp && parts.length === 2 && leaf === 'squirrel.exe')) {
      if (row.vendorHelper !== true) refuse('UNINSTALL_VENDOR_HELPER_CHANGED', name);
      vendorFiles++;
      continue;
    }
    if (inApp && parts.length === 2 && runtime.files.has(leaf)) {tolerated.push(name); continue;}
    if (inApp && parts.length === 3 && parts[1].toLowerCase() === 'locales' && runtime.locales.has(leaf)) {tolerated.push(name); continue;}
    refuse('UNINSTALL_UNEXPECTED_FILE', name);
  }
  if (!marker) refuse('UNINSTALL_ROOT_OR_MARKER_MISSING');
  return {vendorFiles, tolerated};
}

/** True only on a GitHub-hosted runner; the test install creates real shortcuts only there (U12). */
export const isHostedRunner = env => env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';

/**
 * The registered UninstallString (ET-018 PR-3, U12): exactly the quoted `Update.exe` of the channel's binary root in the
 * run root and `--uninstall`, optionally followed by Squirrel's `-s`. Returns the program and its arguments; anything
 * else, the other channel's Update.exe included, refuses.
 */
export function parseUninstallString(value, runRoot, channel) {
  const match = typeof value === 'string' ? /^"([^"]+)"((?: +[^ "]+)*) *$/.exec(value) : null;
  if (!match) refuse('UNINSTALL_STRING_INVALID');
  const program = match[1], args = match[2].trim().split(/ +/).filter(Boolean);
  if (normalizePath(program) !== normalizePath(path.win32.join(runLayout(runRoot, channel).binaryRoot, 'Update.exe'))) refuse('UNINSTALL_STRING_OUTSIDE_RUN_ROOT');
  if (!(args.length === 1 && args[0] === '--uninstall') && !(args.length === 2 && args[0] === '--uninstall' && args[1] === '-s')) refuse('UNINSTALL_STRING_INVALID');
  return {program, args};
}
/**
 * The environment of the Windows-initiated uninstall (ET-018 PR-3, U12): the caller's environment without PATH, Node,
 * npm, Electron and every ETS2TELEMETRY_ variable, LOCALAPPDATA set to the decoy, APPDATA, TEMP and TMP inside R, and
 * SQUIRREL_TEMP = R\LocalAppData. The decoy must lie inside R and must not be the real LocalAppData.
 */
export function uninstallEnvironment(base, {runRoot, real, decoy}) {
  const layout = runFolders(runRoot);
  if (!isDrivePath(decoy) || !isInside(decoy, runRoot) || normalizePath(decoy) === normalizePath(runRoot)) refuse('DECOY_OUTSIDE_RUN_ROOT');
  if (!isDrivePath(real?.localAppData) || isInside(decoy, real.localAppData) || isInside(real.localAppData, decoy)) refuse('DECOY_IS_REAL_ROOT');
  const env = installedEnvironment(base, {LOCALAPPDATA: decoy, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp, SQUIRREL_TEMP: layout.squirrelTemp});
  if (Object.keys(env).some(key => key.toUpperCase().startsWith('ETS2TELEMETRY_'))) refuse('UNINSTALL_ENVIRONMENT_INVALID');
  return env;
}

/**
 * The folders of run root R that both channels share (U12): B = R\LocalAppData is both SQUIRREL_TEMP and the LOCALAPPDATA
 * of every launch, and the profile is the installer test file's profileDir.
 */
export function runFolders(runRoot) {
  const base = path.win32.join(runRoot, 'LocalAppData');
  return {
    runRoot, base, squirrelTemp: base, temp: path.win32.join(runRoot, 'temp'), appData: path.win32.join(runRoot, 'AppData'),
    profile: path.win32.join(runRoot, 'profile'), cwd: path.win32.join(runRoot, 'cwd'), diagnostics: path.win32.join(runRoot, 'diagnostics'),
    exports: path.win32.join(runRoot, 'exports'), fixture: path.win32.join(runRoot, 'fixture'),
    pluginMarker: path.win32.join(runRoot, PLUGIN_TEST_ROOT_MARKER), installTest: path.win32.join(runRoot, INSTALL_TEST_FILE)
  };
}
/**
 * The run layout of one channel under run root R (U12): runFolders and the channel's own roots in B, so Squirrel's binary
 * root becomes B\<Squirrel id> (B\ETS2TelemetryDesktop, B\ETS2TelemetryStagingDesktop) and the data root B\<data root>
 * (B\ETS2Telemetry, B\ETS2TelemetryStaging).
 */
export function runLayout(runRoot, channel) {
  const identity = lifecycleIdentity(channel), folders = runFolders(runRoot);
  return {...folders, channel, dataRoot: path.win32.join(folders.base, identity.dataRoot), binaryRoot: path.win32.join(folders.base, identity.productRoot)};
}

/** The protected locations of the real user: both channels' data, binary and Roaming roots, and every Steam library. */
export function protectedRoots(real, steamLibraries = []) {
  if (!isDrivePath(real?.localAppData) || !isDrivePath(real?.roamingAppData)) refuse('KNOWN_FOLDER_UNAVAILABLE');
  for (const library of steamLibraries) if (!isDrivePath(library)) refuse('STEAM_LIBRARY_INVALID');
  return {
    real: LIFECYCLE_IDENTITIES.flatMap(identity => [path.win32.join(real.localAppData, identity.dataRoot), path.win32.join(real.localAppData, identity.productRoot),
      path.win32.join(real.roamingAppData, identity.roamingRoot)]),
    steam: [...steamLibraries]
  };
}

/**
 * The real location of `target`: the realpath of its nearest existing ancestor, joined with the components that do not
 * exist yet. A junction or symbolic link in any existing ancestor is therefore followed. `realpath` is injected so the
 * decision stays testable.
 */
export async function resolveRealLocation(target, realpath) {
  let probe = path.win32.normalize(target);
  const rest = [];
  for (;;) {
    try {return path.win32.join(await realpath(probe), ...rest);} catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.win32.dirname(probe);
      if (parent === probe) return path.win32.normalize(target);
      rest.unshift(path.win32.basename(probe));
      probe = parent;
    }
  }
}

/** The library paths of a Steam `libraryfolders.vdf` (`"path" "<value>"`), unescaped; other keys are ignored. */
export function steamLibraryPaths(vdf) {
  if (typeof vdf !== 'string') return [];
  return [...vdf.matchAll(/"path"\s*"((?:[^"\\]|\\.)*)"/gi)].map(match => match[1].replace(/\\(.)/g, '$1'));
}

/** The product executables of both channels, lower case and without `.exe`. */
const PRODUCT_PROCESSES = new Set(LIFECYCLE_IDENTITIES.map(identity => identity.executable.toLowerCase().replace(/\.exe$/, '')));
/**
 * The product and game processes that refuse a run: the application of either channel, ETS2, ATS and any TruckersMP
 * process. A staging run on the owner's machine therefore also waits until the installed production application has exited.
 */
export function isGuardedProcess(name) {
  const value = String(name).toLowerCase().replace(/\.exe$/, '');
  return PRODUCT_PROCESSES.has(value) || value === 'eurotrucks2' || value === 'amtrucks' || value.startsWith('truckersmp');
}

/** Validates the parsed installer test file: fixed format and version, and every path inside the run root. */
export function checkInstallTest(document, runRoot) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) refuse('INSTALL_TEST_INVALID');
  const keys = Object.keys(document).sort().join(',');
  if (keys !== 'format,profileDir,runOnceKey,shortcuts,version' || document.format !== INSTALL_TEST_FORMAT || document.version !== INSTALL_TEST_VERSION ||
    typeof document.shortcuts !== 'boolean' || !isDrivePath(document.profileDir) || !isInside(document.profileDir, runRoot) ||
    normalizePath(document.profileDir) === normalizePath(runRoot) ||
    (document.runOnceKey !== null && (typeof document.runOnceKey !== 'string' || !RUN_ONCE_KEY.test(document.runOnceKey)))) refuse('INSTALL_TEST_INVALID');
}

/**
 * The fail-closed preflight (U12), before any installer or launch. `facts`:
 *
 * - `runRoot`: R, an absolute drive path named `installer-<32 hex>`, not a drive root;
 * - `real`: `{localAppData, roamingAppData}`, the known folders Windows resolved (never the environment variables);
 * - `steamLibraries`: the Steam library folders (the SteamPath value and libraryfolders.vdf), possibly empty;
 * - `paths`: every other path the run uses (evidence, decoy, ...), checked like the layout's;
 * - `resolved`: the real location of each checked path by its normalized raw path (resolveRealLocation);
 * - `decoy`: optional; a LOCALAPPDATA decoy (ET-018 PR-3) that must not be the real LocalAppData;
 * - `channels`: the build channels this run installs (checkRunChannels): the built one, or both side by side;
 * - `realBinaryRootExists`, `registrationExists`: per channel, the real `%LOCALAPPDATA%\<Squirrel id>` and the HKCU
 *   uninstall key of that name. Every channel the run installs must have neither: its test install writes that key. A
 *   channel the run does not install is not judged, so a staging run may proceed beside an installed production copy;
 * - `processes`: the names of the running processes;
 * - `markers`: `{pluginMarker, installTest}` once R exists (`pluginMarker` a regular file, `installTest` the parsed file);
 *   `null` before R is created (phase `plan`).
 *
 * Throws the first refusal; returns the checked paths otherwise.
 */
export function checkRunPlan(facts) {
  const {runRoot} = facts;
  if (!isDrivePath(runRoot) || !path.win32.isAbsolute(runRoot) || /^[A-Za-z]:\\*$/.test(path.win32.normalize(runRoot)) ||
    !RUN_ROOT_NAME.test(path.win32.basename(path.win32.normalize(runRoot).replace(/\\+$/, '')))) refuse('RUN_ROOT_INVALID');
  const channels = checkRunChannels(facts.channels);
  const roots = protectedRoots(facts.real, facts.steamLibraries ?? []);
  const checked = checkedPaths(facts);
  for (const candidate of checked) if (!isDrivePath(candidate)) refuse('PATH_INVALID');
  if (facts.decoy && (normalizePath(facts.decoy) === normalizePath(facts.real.localAppData) ||
    normalizePath(locationOf(facts, facts.decoy)) === normalizePath(facts.real.localAppData))) refuse('DECOY_IS_REAL_ROOT');
  for (const candidate of checked) {
    for (const location of [candidate, locationOf(facts, candidate)]) {
      if (roots.real.some(root => isInside(location, root))) refuse('PATH_IN_REAL_ROOT');
      if (roots.steam.some(root => isInside(location, root))) refuse('PATH_IN_STEAM_LIBRARY');
    }
  }
  // Deleting R at the end must never reach a protected folder, so none may lie inside R either.
  for (const location of [runRoot, locationOf(facts, runRoot)]) {
    if ([...roots.real, ...roots.steam, facts.real.localAppData, facts.real.roamingAppData].some(root => isInside(root, location))) refuse('RUN_ROOT_CONTAINS_PROTECTED');
  }
  // A Steam library list that exists but could not be read could hide a library the run root lies in.
  if (facts.steamLibrariesUnreadable === true) refuse('STEAM_LIBRARIES_UNREADABLE');
  for (const channel of channels) if (facts.realBinaryRootExists?.[channel] !== false) refuse('REAL_INSTALL_PRESENT', channel);
  for (const channel of channels) if (facts.registrationExists?.[channel] !== false) refuse('REGISTRATION_PRESENT', channel);
  if (!Array.isArray(facts.processes)) refuse('PROCESS_LIST_UNAVAILABLE');
  if (facts.processes.some(isGuardedProcess)) refuse('PROCESS_RUNNING');
  if (facts.markers !== null) {
    if (facts.markers?.pluginMarker !== true) refuse('MARKER_MISSING');
    if (facts.markers.installTest === undefined || facts.markers.installTest === null) refuse('MARKER_MISSING');
    checkInstallTest(facts.markers.installTest, runRoot);
  }
  return checked;
}
/**
 * Every path checkRunPlan checks: the shared run folders, the data and binary roots of both channels, the extra paths and
 * the decoy with both channels' data and binary roots in it. Both channels' roots are checked whatever the run installs,
 * so the list does not depend on facts the guard is about to judge.
 */
export function checkedPaths({runRoot, paths = [], decoy}) {
  const layouts = LIFECYCLE_IDENTITIES.map(identity => runLayout(runRoot, identity.channel));
  return [...Object.values(runFolders(runRoot)), ...layouts.flatMap(layout => [layout.dataRoot, layout.binaryRoot]), ...paths,
    ...(decoy ? [decoy, ...LIFECYCLE_IDENTITIES.flatMap(identity => [path.win32.join(decoy, identity.dataRoot), path.win32.join(decoy, identity.productRoot)])] : [])];
}
function locationOf(facts, candidate) {
  const resolved = facts.resolved?.[normalizePath(candidate)];
  if (typeof resolved !== 'string' || !isDrivePath(resolved)) refuse('PATH_UNRESOLVED');
  return resolved;
}

/**
 * After each install, repair and update (U12): the HKCU registration's InstallLocation and the binary root must be exactly
 * the channel's R\LocalAppData\<Squirrel id>, by raw and real location, and that channel's real binary root must still be
 * absent. Otherwise the run aborts at once and never uninstalls. `facts`: `{runRoot, channel, installLocation, binaryRoot,
 * resolvedInstallLocation, resolvedBinaryRoot, realBinaryRootExists}`.
 */
export function checkInstalled(facts) {
  const expected = runLayout(facts.runRoot, facts.channel).binaryRoot;
  if (typeof facts.installLocation !== 'string' || facts.installLocation === '') refuse('REGISTRATION_MISSING');
  for (const location of [facts.installLocation, facts.binaryRoot, facts.resolvedInstallLocation, facts.resolvedBinaryRoot]) {
    if (!isDrivePath(location) || normalizePath(location) !== normalizePath(expected)) refuse('INSTALL_OUTSIDE_RUN_ROOT');
  }
  if (facts.realBinaryRootExists !== false) refuse('REAL_INSTALL_PRESENT');
}

/** The production executable Squirrel installs in every `app-<version>` folder (lifecycleIdentity(channel).executable for either channel). */
export const PRODUCT_EXECUTABLE = lifecycleIdentity('production').executable;
/** Squirrel's own icon file in the binary root (`CreateUninstallerRegistryEntry` at the pinned Squirrel commit). */
export const ROOT_ICON_FILE = 'app.ico';
/**
 * ET-045g: the shape of the HKCU registration's DisplayIcon value, without recording it (it is a machine path).
 * `displayIcon` is the raw value the harness read, `binaryRoot` the channel's binary root in R, `version` the installed
 * version and `channel` the build channel, whose executable carries the product icon (ET-055 PR-5).
 * Shapes: `root-app-ico` (Squirrel's `<binaryRoot>\app.ico`), `app-exe-index-0` (`<binaryRoot>\app-<v>\<executable>,0`),
 * `absent` (no value or an empty one) and `other` (anything else: quoted, relative, another folder, file or index).
 * `versionMatches` says whether `app-<v>` names `version`; it is null for every other shape.
 */
export function classifyRegistrationIcon({displayIcon, binaryRoot, version, channel}) {
  const executable = lifecycleIdentity(channel).executable;
  const other = {shape: 'other', versionMatches: null};
  if (displayIcon === undefined || displayIcon === null || displayIcon === '') return {shape: 'absent', versionMatches: null};
  if (typeof displayIcon !== 'string' || !isDrivePath(displayIcon) || !isDrivePath(binaryRoot) || /["\r\n]/.test(displayIcon) ||
    displayIcon.split(/[\\/]/).some(part => part === '.' || part === '..')) return other;
  if (normalizePath(displayIcon) === normalizePath(path.win32.join(binaryRoot, ROOT_ICON_FILE))) return {shape: 'root-app-ico', versionMatches: null};
  const match = /^(.+)\\([^\\]+)\\([^\\]+),0$/.exec(displayIcon);
  if (match && normalizePath(match[1]) === normalizePath(binaryRoot) && APP_FOLDER.test(match[2]) && match[3].toLowerCase() === executable.toLowerCase()) {
    return {shape: 'app-exe-index-0', versionMatches: typeof version === 'string' && match[2] === `app-${version}`};
  }
  return other;
}
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * ET-045g, after each install, repair and update: the Installed apps entry shows the product icon. `observation` is the
 * driver's icon record: `displayIcon` from classifyRegistrationIcon, `rootIcon` the binary root's app.ico
 * `{regularFile, sha256}`, `bundledIcon` the installed version's `resources\icon\app.ico` `{regularFile, sha256}` and
 * `trackedSha256` the tracked resources/icon/app.ico. DisplayIcon must name icon 0 of the installed version's executable,
 * and both icon files must have the tracked bytes. Throws the first refusal.
 */
export function checkRegistrationIcon(observation) {
  const {displayIcon, rootIcon, bundledIcon, trackedSha256} = observation ?? {};
  if (typeof trackedSha256 !== 'string' || !SHA256_HEX.test(trackedSha256)) refuse('TRACKED_ICON_INVALID');
  if (displayIcon?.shape !== 'app-exe-index-0') refuse('DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE', typeof displayIcon?.shape === 'string' ? displayIcon.shape : undefined);
  if (displayIcon.versionMatches !== true) refuse('DISPLAY_ICON_VERSION_MISMATCH');
  if (bundledIcon?.regularFile !== true || bundledIcon.sha256 !== trackedSha256) refuse('BUNDLED_ICON_NOT_PRODUCT');
  if (rootIcon?.regularFile !== true || rootIcon.sha256 !== trackedSha256) refuse('ROOT_ICON_NOT_PRODUCT');
}

/** The minimal PATH of an installed launch (U11): only Windows' own folders, no Node, npm, Git or build tools. */
export function minimalPath(systemRoot) {
  if (!isDrivePath(systemRoot)) refuse('SYSTEM_ROOT_INVALID');
  return [path.win32.join(systemRoot, 'System32'), path.win32.normalize(systemRoot).replace(/\\+$/, ''),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
}
/**
 * The environment of an installed launch (U11, U12): the caller's environment without PATH, Node, npm, Electron and every
 * ETS2TELEMETRY_ variable (so a stray ETS2TELEMETRY_PLUGIN_SETUP=real can never reach it), then the minimal PATH and the
 * given overrides. Windows variable names are case-insensitive, so a base key that differs only in case is dropped too.
 */
export function installedEnvironment(base, overrides) {
  const replaced = new Set(Object.keys(overrides).map(key => key.toUpperCase()));
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper === 'PATH' || replaced.has(upper) || /^(NPM_|NODE_|ELECTRON_|ETS2TELEMETRY_)/.test(upper) || upper === 'NODE') continue;
    env[key] = value;
  }
  return {...env, Path: minimalPath(base.SystemRoot ?? base.SYSTEMROOT), ...overrides};
}
/**
 * The last check before a launch inside the run root (U12): LOCALAPPDATA, APPDATA, TEMP, TMP, the profile and the
 * diagnostic folder must lie inside R, and LOCALAPPDATA must not be the real known folder. `env` is the launch environment.
 */
export function checkLaunchEnvironment(env, {runRoot, real}) {
  for (const name of ['LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR']) {
    const value = Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
    if (!isDrivePath(value) || !isInside(value, runRoot)) refuse('LAUNCH_ENVIRONMENT_OUTSIDE_RUN_ROOT');
  }
  const localAppData = Object.entries(env).find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')[1];
  if (!isDrivePath(real?.localAppData) || isInside(localAppData, real.localAppData) || isInside(real.localAppData, localAppData)) refuse('LAUNCH_ENVIRONMENT_REAL_ROOT');
  if (Object.entries(env).some(([key, value]) => key.toUpperCase() === 'ETS2TELEMETRY_PLUGIN_SETUP' && value !== undefined && value !== '')) refuse('LAUNCH_ENVIRONMENT_PLUGIN_SETUP');
}

/**
 * The environment variable that carries the harness's machine facts to one driver command. Facts never go to a file:
 * the evidence is uploaded publicly on CI and would stay on disk after a local run. The driver deletes the variable from
 * its own environment as soon as it has read it, so no installer or application launch inherits it.
 */
export const FACTS_VARIABLE = 'ETS2TELEMETRY_INSTALLER_FACTS';
/** A registered DisplayVersion of fixed form: a plain version or one with a NuGet prerelease label such as `stg000000`. */
const DISPLAY_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z]{1,20})?$/;
/** A registration's evidence: its DisplayVersion of fixed form and whether its InstallLocation lies inside the run root. */
const registrationEvidence = (registration, runRoot) => registration ? {
  displayVersion: typeof registration.displayVersion === 'string' && DISPLAY_VERSION.test(registration.displayVersion) ? registration.displayVersion : null,
  installLocationInsideRunRoot: isDrivePath(registration.installLocation) && isDrivePath(runRoot) && isInside(registration.installLocation, runRoot)} : null;
/**
 * What the evidence may keep of the machine facts: only booleans, counts, the matched product and game image names and a
 * registered version of fixed form. No path, Steam library list or process name of the machine is ever recorded.
 * `runRoot` decides whether the registration's InstallLocation lies inside the run root. `channel`, `registration`,
 * `realBinaryRootExists` and `registrationExists` describe the channel of the driver command; ET-055 PR-5 adds
 * `channels`, the same facts of both channels (`realBinaryRoots`, `registrations`) that the preflight judges.
 */
export function factsEvidence(facts, runRoot) {
  const processes = Array.isArray(facts?.processes) ? facts.processes : null;
  const perChannel = read => Object.fromEntries(BUILD_CHANNELS.map(channel => [channel, read(channel)]));
  return {
    knownFoldersResolved: isDrivePath(facts?.real?.localAppData) && isDrivePath(facts?.real?.roamingAppData),
    channel: BUILD_CHANNELS.includes(facts?.channel) ? facts.channel : null,
    realBinaryRootExists: facts?.realBinaryRootExists === true,
    registrationExists: facts?.registrationExists === true,
    registration: registrationEvidence(facts?.registration, runRoot),
    channels: {realBinaryRoots: perChannel(channel => facts?.realBinaryRoots?.[channel] === true),
      registrations: perChannel(channel => registrationEvidence(facts?.registrations?.[channel], runRoot))},
    steamPathPresent: isDrivePath(facts?.steamPath),
    steamLibraries: (isDrivePath(facts?.steamPath) ? 1 : 0) + steamLibraryPaths(facts?.libraryFolders ?? '').length,
    steamLibrariesUnreadable: facts?.steamLibrariesUnreadable === true,
    processesListed: processes ? processes.length : null,
    guardedProcesses: processes ? [...new Set(processes.filter(isGuardedProcess).map(name => {
      const value = String(name).toLowerCase();
      return value.startsWith('truckersmp') ? 'truckersmp*' : value.endsWith('.exe') ? value : `${value}.exe`;
    }))].sort() : null
  };
}

/** Cleanup may delete the HKCU uninstall key only when it points into this run root (CI only). */
export function ownsRegistration(runRoot, installLocation) {
  return isDrivePath(installLocation) && isDrivePath(runRoot) && isInside(installLocation, runRoot) && normalizePath(installLocation) !== normalizePath(runRoot);
}

// --- ET-045h: the product name, the shortcuts and the single Uninstall entry --------------------------------------------

/** The production Installed apps DisplayName and shortcut name since ET-045h (forge.config.cjs `title`, `win32metadata.ProductName`). */
export const PRODUCT_DISPLAY_NAME = lifecycleIdentity('production').displayName;
/** The shortcut name and DisplayName of every production build before ET-045h; staging has no earlier name. */
export const LEGACY_DISPLAY_NAME = lifecycleIdentity('production').legacyDisplayNames[0];
/** The Start menu folder Squirrel puts the shortcut in (forge.config.cjs `win32metadata.CompanyName`). */
export const SHORTCUT_COMPANY = 'Artur Sianiuk';
export const SHORTCUT_LOCATIONS = Object.freeze(['desktop', 'start-menu']);
const LINK_ROW = /^(desktop|start-menu)\|([^|]*)\|([^|]+)$/;
/** A relative folder or file name: no drive, no leading or doubled separator, no `..`, nothing that could be a machine path. */
const relativeName = value => typeof value === 'string' && value.length <= 128 && !/[:\0]/.test(value) && !/^[\\/]/.test(value)
  && !value.split(/[\\/]/).some(part => part === '..' || part === '.' || (value !== '' && part === ''));

/**
 * ET-045h: the harness's product shortcuts of one channel (links on the Desktop or in the Start menu whose target lies in
 * that channel's binary root in R), each `<location>|<folder>|<name>`: the location, the folder relative to it ('' for the
 * location itself) and the file name without `.lnk`. Names only, never a path. Returns, per location, how many carry the
 * channel's current name, one of its legacy names (production: "ETS2Telemetry Desktop"; staging has none) or another
 * name, and the folders of the current-name links. Throws on a malformed row.
 */
export function classifyProductLinks(rows, channel) {
  const identity = lifecycleIdentity(channel);
  const result = {total: 0};
  for (const location of SHORTCUT_LOCATIONS) result[location] = {current: 0, legacy: 0, other: 0, currentFolders: []};
  for (const row of rows) {
    const match = typeof row === 'string' ? LINK_ROW.exec(row) : null;
    if (!match || !relativeName(match[2]) || !relativeName(match[3]) || match[3].includes('\\') || match[3].includes('/')) refuse('PRODUCT_LINK_ROW_INVALID');
    const [, location, folder, name] = match;
    const entry = result[location];
    result.total++;
    if (name === identity.displayName) {entry.current++; entry.currentFolders.push(folder);}
    else if (identity.legacyDisplayNames.includes(name)) entry.legacy++;
    else entry.other++;
  }
  return result;
}
/**
 * ET-045h: `installed` (a hosted install whose test file asks for shortcuts): exactly one current-name product shortcut on
 * the Desktop itself and one in the Start menu's company folder, and no product shortcut of the legacy or any other
 * name. `none` (after an uninstall, or a run without shortcuts): no product shortcut of any name. Throws the first refusal.
 */
export function checkProductLinks(classification, expectation) {
  if (expectation === 'none') {
    if (classification.total !== 0) refuse('PRODUCT_SHORTCUT_UNEXPECTED', String(classification.total));
    return;
  }
  if (expectation !== 'installed') refuse('PRODUCT_LINK_EXPECTATION_INVALID');
  for (const location of SHORTCUT_LOCATIONS) {
    const entry = classification[location];
    if (entry.legacy !== 0) refuse('LEGACY_SHORTCUT_REMAINS', location);
    if (entry.other !== 0) refuse('PRODUCT_SHORTCUT_OTHER_NAME', location);
    if (entry.current === 0) refuse('PRODUCT_SHORTCUT_MISSING', location);
    if (entry.current !== 1) refuse('PRODUCT_SHORTCUT_DUPLICATE', location);
    if (entry.currentFolders[0] !== (location === 'desktop' ? '' : SHORTCUT_COMPANY)) refuse('PRODUCT_SHORTCUT_FOLDER', location);
  }
}
/**
 * ET-045h: one installation keeps one Installed apps entry. `rows` are the HKCU Uninstall subkeys the harness read, per
 * registry view, as `{view, name, installLocation}`. Among those whose InstallLocation lies in `channel`'s binary root in
 * the run root, every view holds at most one, at least one view holds one, and each is named that channel's Squirrel id.
 * ET-055 PR-5: any other row inside the run root must be the other channel's own entry (named its Squirrel id, in its
 * binary root), as in the side-by-side scenario; anything else is foreign. Returns names only. Throws the first refusal.
 */
export function checkUninstallEntries(rows, runRoot, channel) {
  if (!Array.isArray(rows)) refuse('UNINSTALL_ENTRIES_INVALID');
  const inRoot = (row, name) => isDrivePath(row?.installLocation) && isDrivePath(runRoot) && isInside(row.installLocation, runLayout(runRoot, name).binaryRoot);
  const inside = rows.filter(row => isDrivePath(row?.installLocation) && isDrivePath(runRoot) && isInside(row.installLocation, runRoot));
  const own = inside.filter(row => inRoot(row, channel));
  if (own.length === 0) refuse('UNINSTALL_ENTRY_MISSING');
  const perView = new Map();
  for (const row of own) perView.set(row.view, (perView.get(row.view) ?? 0) + 1);
  if ([...perView.values()].some(count => count > 1)) refuse('UNINSTALL_ENTRY_DUPLICATE');
  if (own.some(row => row.name !== lifecycleIdentity(channel).productRoot)) refuse('UNINSTALL_ENTRY_FOREIGN_NAME');
  const others = inside.filter(row => !own.includes(row));
  const otherChannel = row => BUILD_CHANNELS.find(name => name !== channel && inRoot(row, name) && row.name === lifecycleIdentity(name).productRoot);
  if (others.some(row => otherChannel(row) === undefined)) refuse('UNINSTALL_ENTRY_FOREIGN_NAME');
  return {views: perView.size, names: [...new Set(own.map(row => row.name))], otherChannels: [...new Set(others.map(otherChannel))].sort()};
}
/**
 * ET-045h: the registration's DisplayName and Publisher are the channel's (Squirrel writes both from the nuspec on every
 * install and update): "Yukon Union Telemetry" or "Yukon Union Telemetry Staging", with the one Publisher of both.
 */
export function checkRegistrationNames(registration, channel) {
  const identity = lifecycleIdentity(channel);
  if (registration?.displayName !== identity.displayName) refuse('DISPLAY_NAME_NOT_PRODUCT');
  if (registration?.publisher !== identity.publisher) refuse('PUBLISHER_NOT_PRODUCT');
  return {displayName: identity.displayName, publisher: identity.publisher};
}

// --- ET-055 PR-5: two channels side by side in one run root ----------------------------------------------------------

/**
 * The shortcuts' AUMIDs (System.AppUserModel.ID, which Squirrel sets to `com.squirrel.<id>.<exe>`): `rows` are
 * `<location>|<name>|<aumid>` for the channel's current-name shortcuts the harness found. Every one must carry the
 * channel's AUMID, which is never the other channel's. Names and AUMIDs only. Returns the count; throws the first refusal.
 */
export function checkShortcutIdentities(rows, channel) {
  const identity = lifecycleIdentity(channel);
  if (LIFECYCLE_IDENTITIES.some(other => other.channel !== channel && other.appUserModelId === identity.appUserModelId)) refuse('AUMID_SHARED');
  if (!Array.isArray(rows) || rows.length === 0) refuse('SHORTCUT_IDENTITIES_MISSING');
  for (const row of rows) {
    const match = typeof row === 'string' ? /^(desktop|start-menu)\|([^|]+)\|([^|]*)$/.exec(row) : null;
    if (!match || !relativeName(match[2])) refuse('SHORTCUT_IDENTITY_ROW_INVALID');
    if (match[2] !== identity.displayName) refuse('SHORTCUT_IDENTITY_NAME', match[1]);
    if (match[3] !== identity.appUserModelId) refuse('SHORTCUT_AUMID_DIFFERS', match[1]);
  }
  return rows.length;
}
/**
 * The other channel's state recorded before and after one channel's install, uninstall or executor run: each value a
 * JSON-ready record of names, hashes, sizes and times (no path). `after` must hold exactly the keys of `before`, each with
 * the same value. Refuses with the first changed key's name; returns the key count.
 */
export function checkOtherChannelUnchanged(before, after) {
  if (before === null || typeof before !== 'object' || Array.isArray(before) || after === null || typeof after !== 'object' || Array.isArray(after)) {
    refuse('OTHER_CHANNEL_STATE_INVALID');
  }
  const keys = Object.keys(before).sort();
  if (keys.length === 0) refuse('OTHER_CHANNEL_STATE_INVALID');
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(after).sort())) refuse('OTHER_CHANNEL_STATE_KEYS_DIFFER');
  for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) refuse('OTHER_CHANNEL_CHANGED', key);
  return keys.length;
}
