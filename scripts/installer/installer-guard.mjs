import path from 'node:path';

// ET-018 PR-1 (U12): the fail-closed guards of the installer lifecycle harness (docs/installer-testing.md). Every check is
// a pure decision over facts the harness gathers: the real known folders (resolved by Windows, never from environment
// variables), the Steam libraries, the uninstall registration, the running processes, the run root's marker files and
// each path's real location. Nothing here reads the registry, lists processes or touches the file system; the only
// file-system access is the injected `realpath` of resolveRealLocation. A refusal throws InstallerGuardError with a
// fixed code and never names a path, so a refusal message can be logged and uploaded.

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
/** The Squirrel application name, the binary root's folder name and the uninstall registration key's name. */
export const PRODUCT_ROOT = 'ETS2TelemetryDesktop';
/** The application's data root under a LocalAppData folder. */
export const DATA_ROOT = 'ETS2Telemetry';
/** Electron's Roaming userData folder (the product name). */
export const ROAMING_ROOT = 'ETS2Telemetry Desktop';

export class InstallerGuardError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`Installer lifecycle refused: ${code}`);
    this.name = 'InstallerGuardError';
    this.code = code;
  }
}
const refuse = code => {throw new InstallerGuardError(code);};

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
/** True only on a GitHub-hosted runner; the test install creates real shortcuts only there (U12). */
export const isHostedRunner = env => env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';

/**
 * The registered UninstallString (ET-018 PR-3, U12): exactly the quoted `Update.exe` of the run root's binary root and
 * `--uninstall`, optionally followed by Squirrel's `-s`. Returns the program and its arguments; anything else refuses.
 */
export function parseUninstallString(value, runRoot) {
  const match = typeof value === 'string' ? /^"([^"]+)"((?: +[^ "]+)*) *$/.exec(value) : null;
  if (!match) refuse('UNINSTALL_STRING_INVALID');
  const program = match[1], args = match[2].trim().split(/ +/).filter(Boolean);
  if (normalizePath(program) !== normalizePath(path.win32.join(runLayout(runRoot).binaryRoot, 'Update.exe'))) refuse('UNINSTALL_STRING_OUTSIDE_RUN_ROOT');
  if (!(args.length === 1 && args[0] === '--uninstall') && !(args.length === 2 && args[0] === '--uninstall' && args[1] === '-s')) refuse('UNINSTALL_STRING_INVALID');
  return {program, args};
}
/**
 * The environment of the Windows-initiated uninstall (ET-018 PR-3, U12): the caller's environment without PATH, Node,
 * npm, Electron and every ETS2TELEMETRY_ variable, LOCALAPPDATA set to the decoy, APPDATA, TEMP and TMP inside R, and
 * SQUIRREL_TEMP = R\LocalAppData. The decoy must lie inside R and must not be the real LocalAppData.
 */
export function uninstallEnvironment(base, {runRoot, real, decoy}) {
  const layout = runLayout(runRoot);
  if (!isDrivePath(decoy) || !isInside(decoy, runRoot) || normalizePath(decoy) === normalizePath(runRoot)) refuse('DECOY_OUTSIDE_RUN_ROOT');
  if (!isDrivePath(real?.localAppData) || isInside(decoy, real.localAppData) || isInside(real.localAppData, decoy)) refuse('DECOY_IS_REAL_ROOT');
  const env = installedEnvironment(base, {LOCALAPPDATA: decoy, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp, SQUIRREL_TEMP: layout.squirrelTemp});
  if (Object.keys(env).some(key => key.toUpperCase().startsWith('ETS2TELEMETRY_'))) refuse('UNINSTALL_ENVIRONMENT_INVALID');
  return env;
}

/**
 * The run layout under run root R (U12). B = R\LocalAppData is both SQUIRREL_TEMP (so Squirrel's binary root becomes
 * B\ETS2TelemetryDesktop) and the LOCALAPPDATA of every launch (so the data root is B\ETS2Telemetry).
 */
export function runLayout(runRoot) {
  const base = path.win32.join(runRoot, 'LocalAppData');
  return {
    runRoot, base, dataRoot: path.win32.join(base, DATA_ROOT), binaryRoot: path.win32.join(base, PRODUCT_ROOT),
    squirrelTemp: base, temp: path.win32.join(runRoot, 'temp'), appData: path.win32.join(runRoot, 'AppData'),
    profile: path.win32.join(runRoot, 'profile'), cwd: path.win32.join(runRoot, 'cwd'), diagnostics: path.win32.join(runRoot, 'diagnostics'),
    exports: path.win32.join(runRoot, 'exports'), fixture: path.win32.join(runRoot, 'fixture'),
    pluginMarker: path.win32.join(runRoot, PLUGIN_TEST_ROOT_MARKER), installTest: path.win32.join(runRoot, INSTALL_TEST_FILE)
  };
}

/** The protected locations of the real user: data, binary and Roaming roots, and every Steam library. */
export function protectedRoots(real, steamLibraries = []) {
  if (!isDrivePath(real?.localAppData) || !isDrivePath(real?.roamingAppData)) refuse('KNOWN_FOLDER_UNAVAILABLE');
  for (const library of steamLibraries) if (!isDrivePath(library)) refuse('STEAM_LIBRARY_INVALID');
  return {
    real: [path.win32.join(real.localAppData, DATA_ROOT), path.win32.join(real.localAppData, PRODUCT_ROOT), path.win32.join(real.roamingAppData, ROAMING_ROOT)],
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

/** The product and game processes that refuse a run: the application, ETS2, ATS and any TruckersMP process. */
export function isGuardedProcess(name) {
  const value = String(name).toLowerCase().replace(/\.exe$/, '');
  return value === 'ets2telemetrydesktop' || value === 'eurotrucks2' || value === 'amtrucks' || value.startsWith('truckersmp');
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
 * - `realBinaryRootExists`, `registrationExists`: the real `%LOCALAPPDATA%\ETS2TelemetryDesktop` and the HKCU uninstall key;
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
  if (facts.realBinaryRootExists !== false) refuse('REAL_INSTALL_PRESENT');
  if (facts.registrationExists !== false) refuse('REGISTRATION_PRESENT');
  if (!Array.isArray(facts.processes)) refuse('PROCESS_LIST_UNAVAILABLE');
  if (facts.processes.some(isGuardedProcess)) refuse('PROCESS_RUNNING');
  if (facts.markers !== null) {
    if (facts.markers?.pluginMarker !== true) refuse('MARKER_MISSING');
    if (facts.markers.installTest === undefined || facts.markers.installTest === null) refuse('MARKER_MISSING');
    checkInstallTest(facts.markers.installTest, runRoot);
  }
  return checked;
}
/** Every path checkRunPlan checks: the run layout, the extra paths and the decoy with its data and binary roots. */
export function checkedPaths({runRoot, paths = [], decoy}) {
  return [...Object.values(runLayout(runRoot)), ...paths, ...(decoy ? [decoy, path.win32.join(decoy, DATA_ROOT), path.win32.join(decoy, PRODUCT_ROOT)] : [])];
}
function locationOf(facts, candidate) {
  const resolved = facts.resolved?.[normalizePath(candidate)];
  if (typeof resolved !== 'string' || !isDrivePath(resolved)) refuse('PATH_UNRESOLVED');
  return resolved;
}

/**
 * After each install, repair and update (U12): the HKCU registration's InstallLocation and the binary root must be exactly
 * R\LocalAppData\ETS2TelemetryDesktop, by raw and real location, and the real binary root must still be absent.
 * Otherwise the run aborts at once and never uninstalls. `facts`: `{runRoot, installLocation, binaryRoot,
 * resolvedInstallLocation, resolvedBinaryRoot, realBinaryRootExists}`.
 */
export function checkInstalled(facts) {
  const expected = runLayout(facts.runRoot).binaryRoot;
  if (typeof facts.installLocation !== 'string' || facts.installLocation === '') refuse('REGISTRATION_MISSING');
  for (const location of [facts.installLocation, facts.binaryRoot, facts.resolvedInstallLocation, facts.resolvedBinaryRoot]) {
    if (!isDrivePath(location) || normalizePath(location) !== normalizePath(expected)) refuse('INSTALL_OUTSIDE_RUN_ROOT');
  }
  if (facts.realBinaryRootExists !== false) refuse('REAL_INSTALL_PRESENT');
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
/**
 * What the evidence may keep of the machine facts: only booleans, counts, the matched product and game image names and a
 * registered version of fixed form. No path, Steam library list or process name of the machine is ever recorded.
 * `runRoot` decides whether the registration's InstallLocation lies inside the run root.
 */
export function factsEvidence(facts, runRoot) {
  const processes = Array.isArray(facts?.processes) ? facts.processes : null;
  const registration = facts?.registration;
  const version = typeof registration?.displayVersion === 'string' && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(registration.displayVersion) ? registration.displayVersion : null;
  return {
    knownFoldersResolved: isDrivePath(facts?.real?.localAppData) && isDrivePath(facts?.real?.roamingAppData),
    realBinaryRootExists: facts?.realBinaryRootExists === true,
    registrationExists: facts?.registrationExists === true,
    registration: registration ? {displayVersion: version, installLocationInsideRunRoot: isDrivePath(registration.installLocation) && isDrivePath(runRoot) &&
      isInside(registration.installLocation, runRoot)} : null,
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
