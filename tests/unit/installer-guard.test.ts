import {execFile} from 'node:child_process';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import {checkedPaths, checkInstalled, checkInstallTest, checkLaunchEnvironment, checkRunPlan, checkRunSignal, FACTS_VARIABLE, factsEvidence, installedEnvironment,
  checkDataRootUnchanged, checkDecoyUnchanged, checkUninstallResidue, DATA_ROOT_REQUIRED, electronRuntimeNames, InstallerGuardError, RESIDUE_MAX_ENTRIES, isGuardedProcess, isHostedRunner, minimalPath, normalizePath, ownsRegistration, parseUninstallString, resolveRealLocation, runLayout,
  steamLibraryPaths, uninstallEnvironment, type RunPlanFacts} from '../../scripts/installer/installer-guard.mjs';
import {temporaryResources} from '../shared/resources';

// ET-018 PR-1 (REG-017, U12): the installer lifecycle's fail-closed guards. Pure decisions over hand-written facts; no
// registry, process list or file system is read. The fixture user folders are fictitious.
const REAL = {localAppData: 'C:\\Users\\fixture\\AppData\\Local', roamingAppData: 'C:\\Users\\fixture\\AppData\\Roaming'};
const STEAM = ['C:\\Program Files (x86)\\Steam', 'E:\\SteamLibrary'];
const ID = '0123456789abcdef0123456789abcdef';
const RUN_ROOT = `D:\\a\\_temp\\installer-${ID}`;
const EVIDENCE = `D:\\a\\ets2telemetry\\ets2telemetry\\.local\\ci\\installer-${ID}-evidence`;
const installTest = (runRoot = RUN_ROOT) => ({format: 'ets2telemetry.install-test', version: 1, profileDir: `${runRoot}\\profile`, runOnceKey: null, shortcuts: true});

type FactChanges = Partial<RunPlanFacts> & {redirect?: Record<string, string>};
/** Facts of an intact run; `redirect` maps a raw path to its real location (a junction), every other path is itself. */
function facts(changes: FactChanges = {}): RunPlanFacts {
  const {redirect = {}, ...rest} = changes;
  const runRoot = rest.runRoot ?? RUN_ROOT;
  const base = {runRoot, paths: rest.paths ?? [EVIDENCE], ...(rest.decoy ? {decoy: rest.decoy} : {})};
  const resolved: Record<string, string> = {};
  for (const candidate of checkedPaths(base)) {
    const key = normalizePath(candidate);
    const prefix = Object.keys(redirect).find(raw => key === normalizePath(raw) || key.startsWith(`${normalizePath(raw)}\\`));
    resolved[key] = prefix ? path.win32.join(redirect[prefix], candidate.slice(prefix.length)) : candidate;
  }
  return {real: REAL, steamLibraries: STEAM, resolved, realBinaryRootExists: false, registrationExists: false, processes: ['explorer.exe', 'node.exe', 'pwsh.exe'],
    markers: {pluginMarker: true, installTest: installTest(runRoot)}, ...base, ...rest};
}
const refusal = (work: () => unknown) => {
  try {work();} catch (error) {
    expect(error).toBeInstanceOf(InstallerGuardError);
    return (error as InstallerGuardError).code;
  }
  return 'ACCEPTED';
};

describe('CI signal (local runs refused)', () => {
  it('runs only on a GitHub-hosted runner', () => {
    expect(refusal(() => checkRunSignal({GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'}))).toBe('ACCEPTED');
  });
  it.each([
    ['a local shell', {}],
    ['GitHub Actions on a self-hosted runner', {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'}],
    ['a hosted runner name without the Actions flag', {RUNNER_ENVIRONMENT: 'github-hosted'}],
    ['a differently cased flag', {GITHUB_ACTIONS: 'TRUE', RUNNER_ENVIRONMENT: 'github-hosted'}]
  ])('refuses %s', (_name, env) => expect(refusal(() => checkRunSignal(env))).toBe('LOCAL_RUN_REFUSED'));
  // ET-018 PR-3 lifted the earlier refusal: the application's own Squirrel handler now skips the shortcuts of a test install.
  // -AllowLocal is still the owner-requested run only (O6); agents never pass it.
  it('accepts -AllowLocal (an owner-requested local run) without the CI signal, and only the exact flag', () => {
    expect(refusal(() => checkRunSignal({}, {allowLocal: true}))).toBe('ACCEPTED');
    expect(refusal(() => checkRunSignal({}, {allowLocal: 'true' as unknown as boolean}))).toBe('LOCAL_RUN_REFUSED');
    expect(refusal(() => checkRunSignal({}, {allowLocal: false}))).toBe('LOCAL_RUN_REFUSED');
  });
  it('creates real shortcuts only on a GitHub-hosted runner', () => {
    expect(isHostedRunner({GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'})).toBe(true);
    expect(isHostedRunner({GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'})).toBe(false);
    expect(isHostedRunner({})).toBe(false);
  });
});

describe('binary root residue after an uninstall (ET-018 PR-3)', () => {
  // A distribution listing in the shape of node_modules/electron/dist (fixture names; the driver reads the real one).
  const runtime = electronRuntimeNames([
    {name: 'electron.exe', directory: false}, {name: 'v8_context_snapshot.bin', directory: false}, {name: 'vk_swiftshader.dll', directory: false},
    {name: 'resources.pak', directory: false}, {name: 'LICENSES.chromium.html', directory: false}, {name: 'locales', directory: true}, {name: 'resources', directory: true}
  ], ['en-US.pak', 'de.pak']);
  const file = (relative: string, flags: {vendorHelper?: boolean; deadMarker?: boolean} = {}) => ({relative, kind: 'file' as const, reparse: false, vendorHelper: false, deadMarker: false, ...flags});
  const folder = (relative: string, reparse = false) => ({relative, kind: 'directory' as const, reparse});
  const base = [folder('app-0.1.1'), file('.dead', {deadMarker: true}), file('Update.exe', {vendorHelper: true}), file('app-0.1.1/squirrel.exe', {vendorHelper: true})];
  it('allows Squirrel\'s own residue and tolerates Electron runtime files, which it reports', () => {
    expect(checkUninstallResidue(base, runtime)).toEqual({vendorFiles: 2, tolerated: []});
    expect(checkUninstallResidue([...base, file('app-0.1.1/v8_context_snapshot.bin'), file('app-0.1.1/VK_SWIFTSHADER.DLL'), folder('app-0.1.1/locales'),
      file('app-0.1.1/locales/en-US.pak'), file('app-0.1.0/.dead', {deadMarker: true})], runtime)).toEqual({vendorFiles: 2,
      tolerated: ['app-0.1.1/v8_context_snapshot.bin', 'app-0.1.1/VK_SWIFTSHADER.DLL', 'app-0.1.1/locales', 'app-0.1.1/locales/en-US.pak']});
  });
  it.each([
    ['the product executable', [file('app-0.1.1/ETS2TelemetryDesktop.exe')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['electron.exe, which is never a runtime file', [file('app-0.1.1/electron.exe')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['the application archive', [folder('app-0.1.1/resources'), file('app-0.1.1/resources/app.asar')], 'UNINSTALL_UNEXPECTED_DIRECTORY'],
    ['a file below resources', [file('app-0.1.1/resources/telemetry-plugin/ets2telemetry-plugin.dll')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['a runtime name below resources', [file('app-0.1.1/resources/v8_context_snapshot.bin')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['a runtime name at the top of the binary root', [file('v8_context_snapshot.bin')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['a link', [folder('app-0.1.1/locales', true)], 'UNINSTALL_REPARSE_POINT'],
    ['a linked runtime file', [{...file('app-0.1.1/v8_context_snapshot.bin'), reparse: true}], 'UNINSTALL_REPARSE_POINT'],
    ['an unknown file', [file('app-0.1.1/notes.txt')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['an unknown locale', [file('app-0.1.1/locales/xx.pak')], 'UNINSTALL_UNEXPECTED_FILE'],
    ['another folder', [folder('packages')], 'UNINSTALL_UNEXPECTED_DIRECTORY'],
    ['a changed helper', [file('app-0.1.0/squirrel.exe')], 'UNINSTALL_VENDOR_HELPER_CHANGED'],
    ['an invalid marker', [file('app-0.1.0/.dead')], 'UNINSTALL_MARKER_INVALID']
  ])('refuses %s', (_name, extra, code) => expect(refusal(() => checkUninstallResidue([...base, ...extra], runtime))).toBe(code));
  it('requires the root marker and bounds the listing', () => {
    expect(refusal(() => checkUninstallResidue(base.filter(row => row.relative !== '.dead'), runtime))).toBe('UNINSTALL_ROOT_OR_MARKER_MISSING');
    expect(refusal(() => checkUninstallResidue(Array.from({length: RESIDUE_MAX_ENTRIES + 1}, () => folder('app-0.1.1')), runtime))).toBe('UNINSTALL_RESIDUE_TOO_LARGE');
  });
  it('names the refused entry, never a machine path', () => {
    try {checkUninstallResidue([...base, file('app-0.1.1/ETS2TelemetryDesktop.exe')], runtime);} catch (error) {
      expect((error as Error).message).toBe('Installer lifecycle refused: UNINSTALL_UNEXPECTED_FILE (app-0.1.1/ETS2TelemetryDesktop.exe)');
    }
  });
  it('takes the runtime names from the distribution listing: electron.exe and folders other than locales are not runtime files', () => {
    expect([...runtime.files].sort()).toEqual(['licenses.chromium.html', 'resources.pak', 'v8_context_snapshot.bin', 'vk_swiftshader.dll']);
    expect([...runtime.locales].sort()).toEqual(['de.pak', 'en-us.pak']);
    expect(refusal(() => electronRuntimeNames([{name: 'notes.txt', directory: false}], []))).toBe('ELECTRON_DIST_INVALID');
  });
});

describe('Windows-initiated uninstall (ET-018 PR-3)', () => {
  // The decoy's trees as the driver's tree() records them: relative paths, folders ending with a backslash.
  const decoy = {
    'ETS2Telemetry\\': {directory: true}, 'ETS2Telemetry\\data\\': {directory: true},
    'ETS2Telemetry\\data\\telemetry.sqlite': {size: 55, sha256: 'a'.repeat(64)},
    'ETS2TelemetryDesktop\\': {directory: true}, 'ETS2TelemetryDesktop\\sentinel.txt': {size: 18, sha256: 'b'.repeat(64)}
  };
  const OS = {'Microsoft\\': {directory: true}, 'Microsoft\\Windows\\': {directory: true}, 'Microsoft\\Windows\\Caches\\': {directory: true}};
  it('allows the Microsoft folder Windows adds to the decoy, and nothing else', () => {
    expect(checkDecoyUnchanged(decoy, decoy)).toBe(0);
    expect(checkDecoyUnchanged(decoy, {...decoy, ...OS})).toBe(3);
    expect(checkDecoyUnchanged(decoy, {...decoy, ...OS, 'Microsoft\\Windows\\Caches\\cversions.db': {size: 4, sha256: 'c'.repeat(64)}})).toBe(4);
  });
  it.each([
    ['a new ETS2Telemetry entry', {...decoy, 'ETS2Telemetry\\logs\\': {directory: true}}, 'DECOY_PRODUCT_ENTRY_ADDED'],
    ['a new top-level ETS2Telemetry* folder', {...decoy, 'ETS2Telemetry Desktop\\': {directory: true}}, 'DECOY_PRODUCT_ENTRY_ADDED'],
    ['an ETS2Telemetry name below Microsoft', {...decoy, ...OS, 'Microsoft\\ETS2Telemetry\\': {directory: true}}, 'DECOY_PRODUCT_ENTRY_ADDED'],
    ['a changed sentinel', {...decoy, 'ETS2TelemetryDesktop\\sentinel.txt': {size: 18, sha256: 'd'.repeat(64)}}, 'DECOY_ENTRY_CHANGED'],
    ['a sentinel turned into a folder', {...decoy, 'ETS2Telemetry\\data\\telemetry.sqlite': {directory: true}}, 'DECOY_ENTRY_CHANGED'],
    ['a removed sentinel', Object.fromEntries(Object.entries(decoy).filter(([entry]) => !entry.endsWith('sentinel.txt'))), 'DECOY_ENTRY_REMOVED'],
    ['a new top-level entry other than Microsoft', {...decoy, ...OS, 'Temp\\': {directory: true}}, 'DECOY_ENTRY_ADDED'],
    ['a new top-level file', {...decoy, 'Microsoft.txt': {size: 1, sha256: 'e'.repeat(64)}}, 'DECOY_ENTRY_ADDED']
  ])('refuses %s', (_name, after, code) => expect(refusal(() => checkDecoyUnchanged(decoy, after))).toBe(code));
  const update = `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktop\\Update.exe`;
  it.each([[`"${update}" --uninstall`, ['--uninstall']], [`"${update}" --uninstall -s`, ['--uninstall', '-s']]] as const)('runs the registered %s', (value, args) => {
    expect(parseUninstallString(value, RUN_ROOT)).toEqual({program: update, args});
  });
  it.each([
    ['another Update.exe', `"C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\Update.exe" --uninstall`, 'UNINSTALL_STRING_OUTSIDE_RUN_ROOT'],
    ['an unquoted program', `${update} --uninstall`, 'UNINSTALL_STRING_INVALID'],
    ['another command', `"${update}" --update C:\\feed`, 'UNINSTALL_STRING_INVALID'],
    ['an extra argument', `"${update}" --uninstall -s --extra`, 'UNINSTALL_STRING_INVALID'],
    ['no value', undefined, 'UNINSTALL_STRING_INVALID']
  ])('refuses %s', (_name, value, code) => expect(refusal(() => parseUninstallString(value, RUN_ROOT))).toBe(code));
  it('runs with the decoy LOCALAPPDATA, R folders, the minimal PATH and no ETS2TELEMETRY_ variable', () => {
    const decoy = `${RUN_ROOT}\\decoy`;
    const env = uninstallEnvironment({SystemRoot: 'C:\\Windows', PATH: 'C:\\tools', LOCALAPPDATA: REAL.localAppData, ETS2TELEMETRY_PROFILE_DIR: `${RUN_ROOT}\\profile`,
      ets2telemetry_plugin_setup_root: RUN_ROOT, NODE_OPTIONS: '--x', USERNAME: 'fixture'}, {runRoot: RUN_ROOT, real: REAL, decoy});
    expect(env).toEqual({SystemRoot: 'C:\\Windows', USERNAME: 'fixture', Path: minimalPath('C:\\Windows'), LOCALAPPDATA: decoy, APPDATA: `${RUN_ROOT}\\AppData`,
      TEMP: `${RUN_ROOT}\\temp`, TMP: `${RUN_ROOT}\\temp`, SQUIRREL_TEMP: `${RUN_ROOT}\\LocalAppData`});
  });
  it.each([
    ['outside R', 'D:\\decoy', 'DECOY_OUTSIDE_RUN_ROOT'], ['R itself', RUN_ROOT, 'DECOY_OUTSIDE_RUN_ROOT'],
    ['the real LocalAppData', REAL.localAppData, 'DECOY_OUTSIDE_RUN_ROOT']
  ])('refuses a decoy %s', (_name, decoy, code) => {
    expect(refusal(() => uninstallEnvironment({SystemRoot: 'C:\\Windows'}, {runRoot: RUN_ROOT, real: REAL, decoy}))).toBe(code);
  });
  it('refuses a decoy when the real LocalAppData lies inside R', () => {
    expect(refusal(() => uninstallEnvironment({SystemRoot: 'C:\\Windows'}, {runRoot: RUN_ROOT, real: {localAppData: `${RUN_ROOT}\\decoy\\inner`}, decoy: `${RUN_ROOT}\\decoy`})))
      .toBe('DECOY_IS_REAL_ROOT');
  });
});

describe('preflight of the run root', () => {
  it('accepts an intact run root before and after its markers exist', () => {
    expect(refusal(() => checkRunPlan(facts()))).toBe('ACCEPTED');
    expect(refusal(() => checkRunPlan(facts({markers: null})))).toBe('ACCEPTED');
  });
  it('derives the binary root, data root and SQUIRREL_TEMP from R\\LocalAppData', () => {
    const layout = runLayout(RUN_ROOT);
    expect({base: layout.base, squirrelTemp: layout.squirrelTemp, binaryRoot: layout.binaryRoot, dataRoot: layout.dataRoot}).toEqual({
      base: `${RUN_ROOT}\\LocalAppData`, squirrelTemp: `${RUN_ROOT}\\LocalAppData`, binaryRoot: `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktop`,
      dataRoot: `${RUN_ROOT}\\LocalAppData\\ETS2Telemetry`});
  });
  it.each([
    ['the real data root', `${REAL.localAppData}\\ETS2Telemetry\\installer-${ID}`],
    ['the real binary root', `${REAL.localAppData}\\ETS2TelemetryDesktop\\installer-${ID}`],
    ['the real Roaming userData', `${REAL.roamingAppData}\\ETS2Telemetry Desktop\\installer-${ID}`],
    ['the real data root in other case', `c:\\users\\FIXTURE\\appdata\\local\\ets2telemetry\\installer-${ID}`]
  ])('refuses a run root inside %s', (_name, runRoot) => expect(refusal(() => checkRunPlan(facts({runRoot})))).toBe('PATH_IN_REAL_ROOT'));
  it.each([
    ['the default Steam library', `${STEAM[0]}\\steamapps\\installer-${ID}`],
    ['a second Steam library', `E:\\SteamLibrary\\installer-${ID}`]
  ])('refuses a run root inside %s', (_name, runRoot) => expect(refusal(() => checkRunPlan(facts({runRoot})))).toBe('PATH_IN_STEAM_LIBRARY'));
  it('refuses an evidence path inside a protected root', () => {
    expect(refusal(() => checkRunPlan(facts({paths: [`${REAL.localAppData}\\ETS2Telemetry\\evidence`]})))).toBe('PATH_IN_REAL_ROOT');
  });
  it('refuses R\\LocalAppData that is a junction to the real LocalAppData', () => {
    expect(refusal(() => checkRunPlan(facts({redirect: {[`${RUN_ROOT}\\LocalAppData`]: REAL.localAppData}})))).toBe('PATH_IN_REAL_ROOT');
  });
  it('refuses a run root that is a junction into a Steam library', () => {
    expect(refusal(() => checkRunPlan(facts({redirect: {[RUN_ROOT]: `${STEAM[1]}\\steamapps\\common`}})))).toBe('PATH_IN_STEAM_LIBRARY');
  });
  it('refuses a run root whose deletion would reach a protected folder', () => {
    expect(refusal(() => checkRunPlan(facts({redirect: {[RUN_ROOT]: 'C:\\Users\\fixture\\AppData'}})))).toBe('RUN_ROOT_CONTAINS_PROTECTED');
  });
  it.each([
    ['equal to the real LocalAppData', REAL.localAppData],
    ['equal in other case with a trailing separator', 'c:\\users\\fixture\\appdata\\LOCAL\\']
  ])('refuses a decoy %s', (_name, decoy) => expect(refusal(() => checkRunPlan(facts({decoy})))).toBe('DECOY_IS_REAL_ROOT'));
  it('refuses a decoy inside R that is a junction to the real LocalAppData', () => {
    const decoy = `${RUN_ROOT}\\decoy`;
    expect(refusal(() => checkRunPlan(facts({decoy})))).toBe('ACCEPTED');
    expect(refusal(() => checkRunPlan(facts({decoy, redirect: {[decoy]: REAL.localAppData}})))).toBe('DECOY_IS_REAL_ROOT');
  });
  it('refuses an existing real install or registration, and unknown state', () => {
    expect(refusal(() => checkRunPlan(facts({registrationExists: true})))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan(facts({realBinaryRootExists: true})))).toBe('REAL_INSTALL_PRESENT');
    expect(refusal(() => checkRunPlan({...facts(), registrationExists: undefined as unknown as boolean}))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan({...facts(), realBinaryRootExists: undefined as unknown as boolean}))).toBe('REAL_INSTALL_PRESENT');
  });
  it.each(['ETS2TelemetryDesktop.exe', 'eurotrucks2.exe', 'AMTRUCKS.EXE', 'TruckersMP-Launcher.exe', 'truckersmp-cli.exe'])('refuses a running %s', name => {
    expect(isGuardedProcess(name)).toBe(true);
    expect(refusal(() => checkRunPlan(facts({processes: ['explorer.exe', name]})))).toBe('PROCESS_RUNNING');
  });
  it('accepts unrelated processes and refuses an unreadable process list', () => {
    expect(['steam.exe', 'eurotrucks2-helper.exe', 'node.exe'].some(isGuardedProcess)).toBe(false);
    expect(refusal(() => checkRunPlan({...facts(), processes: undefined as unknown as string[]}))).toBe('PROCESS_LIST_UNAVAILABLE');
  });
  it('refuses a missing marker or installer test file once R exists', () => {
    expect(refusal(() => checkRunPlan(facts({markers: {pluginMarker: false, installTest: installTest()}})))).toBe('MARKER_MISSING');
    expect(refusal(() => checkRunPlan(facts({markers: {pluginMarker: true, installTest: null}})))).toBe('MARKER_MISSING');
  });
  it.each([
    ['a foreign format', {...installTest(), format: 'other'}],
    ['another version', {...installTest(), version: 2}],
    ['a profile outside R', {...installTest(), profileDir: `${REAL.roamingAppData}\\ETS2Telemetry Desktop`}],
    ['the profile equal to R', {...installTest(), profileDir: RUN_ROOT}],
    ['an unexpected key', {...installTest(), extra: true}],
    ['a RunOnce key outside the test namespace', {...installTest(), runOnceKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'}],
    ['a non-boolean shortcut flag', {...installTest(), shortcuts: 'true'}],
    ['an array', []]
  ])('refuses an installer test file with %s', (_name, document) => {
    expect(refusal(() => checkRunPlan(facts({markers: {pluginMarker: true, installTest: document}})))).toBe('INSTALL_TEST_INVALID');
  });
  it('accepts a per-run RunOnce key in the test namespace', () => {
    expect(refusal(() => checkInstallTest({...installTest(), runOnceKey: `HKCU\\Software\\ETS2Telemetry-Test-${ID}\\RunOnce`}, RUN_ROOT))).toBe('ACCEPTED');
  });
  it.each([
    ['a name without the identifier', 'D:\\a\\_temp\\installer'],
    ['a drive root', 'D:\\'],
    ['a UNC path', `\\\\server\\share\\installer-${ID}`],
    ['a relative path', `installer-${ID}`],
    ['an upper-case identifier', `D:\\a\\_temp\\installer-${ID.toUpperCase()}`]
  ])('refuses a run root with %s', (_name, runRoot) => {
    expect(refusal(() => checkRunPlan({...facts(), runRoot}))).toBe('RUN_ROOT_INVALID');
  });
  it('refuses without the known folders or an unresolved path', () => {
    expect(refusal(() => checkRunPlan({...facts(), real: {localAppData: '', roamingAppData: REAL.roamingAppData}}))).toBe('KNOWN_FOLDER_UNAVAILABLE');
    expect(refusal(() => checkRunPlan({...facts(), resolved: {}}))).toBe('PATH_UNRESOLVED');
  });
});

describe('after each install', () => {
  const binaryRoot = runLayout(RUN_ROOT).binaryRoot;
  const installed = (changes = {}) => ({runRoot: RUN_ROOT, installLocation: binaryRoot, binaryRoot, resolvedInstallLocation: binaryRoot, resolvedBinaryRoot: binaryRoot,
    realBinaryRootExists: false, ...changes});
  it('accepts the binary root R\\LocalAppData\\ETS2TelemetryDesktop', () => expect(refusal(() => checkInstalled(installed()))).toBe('ACCEPTED'));
  it.each([
    ['an InstallLocation in the real LocalAppData', {installLocation: `${REAL.localAppData}\\ETS2TelemetryDesktop`}],
    ['an InstallLocation elsewhere inside R', {installLocation: `${RUN_ROOT}\\ETS2TelemetryDesktop`}],
    ['a binary root that resolves outside R', {resolvedBinaryRoot: `${REAL.localAppData}\\ETS2TelemetryDesktop`}],
    ['an InstallLocation that resolves outside R', {resolvedInstallLocation: `${REAL.localAppData}\\ETS2TelemetryDesktop`}]
  ])('aborts on %s', (_name, changes) => expect(refusal(() => checkInstalled(installed(changes)))).toBe('INSTALL_OUTSIDE_RUN_ROOT'));
  it('aborts without a registration or when the real binary root appeared', () => {
    expect(refusal(() => checkInstalled(installed({installLocation: undefined})))).toBe('REGISTRATION_MISSING');
    expect(refusal(() => checkInstalled(installed({realBinaryRootExists: true})))).toBe('REAL_INSTALL_PRESENT');
  });
  it('deletes only a registration that points into R', () => {
    expect(ownsRegistration(RUN_ROOT, binaryRoot)).toBe(true);
    expect(ownsRegistration(RUN_ROOT, `${REAL.localAppData}\\ETS2TelemetryDesktop`)).toBe(false);
    expect(ownsRegistration(RUN_ROOT, RUN_ROOT)).toBe(false);
    expect(ownsRegistration(RUN_ROOT, `${RUN_ROOT}-other\\LocalAppData\\ETS2TelemetryDesktop`)).toBe(false);
  });
});

describe('launch environment', () => {
  const layout = runLayout(RUN_ROOT);
  const overrides = {LOCALAPPDATA: layout.base, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp, ETS2TELEMETRY_PROFILE_DIR: layout.profile,
    ETS2TELEMETRY_DIAGNOSTIC_DIR: `${layout.diagnostics}\\launch-a`};
  it('uses the minimal PATH and drops development and ETS2Telemetry variables', () => {
    const env = installedEnvironment({SystemRoot: 'C:\\Windows', Path: 'C:\\node;C:\\Windows', NODE_OPTIONS: '--use-system-ca', npm_config_cache: 'C:\\npm',
      ELECTRON_RUN_AS_NODE: '1', ETS2TELEMETRY_PLUGIN_SETUP: 'real', LocalAppData: REAL.localAppData, USERNAME: 'fixture'}, overrides);
    expect(env).toEqual({SystemRoot: 'C:\\Windows', USERNAME: 'fixture', Path: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', ...overrides});
    expect(minimalPath('C:\\Windows\\')).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(refusal(() => checkLaunchEnvironment(env, {runRoot: RUN_ROOT, real: REAL}))).toBe('ACCEPTED');
  });
  it('refuses a launch that would receive the real LOCALAPPDATA', () => {
    expect(refusal(() => checkLaunchEnvironment({...overrides, LOCALAPPDATA: REAL.localAppData}, {runRoot: RUN_ROOT, real: REAL}))).toBe('LAUNCH_ENVIRONMENT_OUTSIDE_RUN_ROOT');
    // A run root inside the real LocalAppData passes the "inside R" check, so the real-root check must refuse it on its own.
    const nested = `${REAL.localAppData}\\installer-${ID}`;
    expect(refusal(() => checkLaunchEnvironment({...overrides, LOCALAPPDATA: `${nested}\\LocalAppData`, APPDATA: `${nested}\\AppData`, TEMP: `${nested}\\temp`,
      TMP: `${nested}\\temp`, ETS2TELEMETRY_PROFILE_DIR: `${nested}\\profile`, ETS2TELEMETRY_DIAGNOSTIC_DIR: `${nested}\\diagnostics`}, {runRoot: nested, real: REAL})))
      .toBe('LAUNCH_ENVIRONMENT_REAL_ROOT');
  });
  it.each(['TEMP', 'APPDATA', 'ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR'])('refuses %s outside R or missing', name => {
    expect(refusal(() => checkLaunchEnvironment({...overrides, [name]: 'C:\\Windows\\Temp'}, {runRoot: RUN_ROOT, real: REAL}))).toBe('LAUNCH_ENVIRONMENT_OUTSIDE_RUN_ROOT');
    const without: Record<string, string> = {...overrides};
    delete without[name];
    expect(refusal(() => checkLaunchEnvironment(without, {runRoot: RUN_ROOT, real: REAL}))).toBe('LAUNCH_ENVIRONMENT_OUTSIDE_RUN_ROOT');
  });
  it('refuses any ETS2TELEMETRY_PLUGIN_SETUP value', () => {
    expect(refusal(() => checkLaunchEnvironment({...overrides, ETS2TELEMETRY_PLUGIN_SETUP: 'real'}, {runRoot: RUN_ROOT, real: REAL}))).toBe('LAUNCH_ENVIRONMENT_PLUGIN_SETUP');
  });
});

describe('machine facts never reach the evidence', () => {
  // Facts as the harness gathers them: real known folders, a Steam path, a library list, a registration and processes.
  const VDF = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"E:\\\\SteamLibrary"\n\t}\n}\n';
  const machine = {real: REAL, realBinaryRootExists: false, registrationExists: true, steamPath: STEAM[0], libraryFolders: VDF, libraryFoldersState: 'read',
    registration: {installLocation: runLayout(RUN_ROOT).binaryRoot, displayVersion: '0.1.1', uninstallString: `"${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktop\\Update.exe" --uninstall`},
    processes: ['explorer.exe', 'fixture-private-tool.exe', 'eurotrucks2.exe', 'TruckersMP-Launcher.exe']};
  const DRIVE_PATH = /[A-Za-z]:[\\/]/;
  const assertClean = (text: string) => {
    expect(text).not.toMatch(DRIVE_PATH);
    expect(text).not.toMatch(/libraryfolders|"path"|SteamLibrary|fixture|explorer|uninstall/i);
  };
  it('keeps only booleans, counts and the matched product and game image names', () => {
    const evidence = factsEvidence(machine, RUN_ROOT);
    expect(evidence).toEqual({knownFoldersResolved: true, realBinaryRootExists: false, registrationExists: true,
      registration: {displayVersion: '0.1.1', installLocationInsideRunRoot: true}, steamPathPresent: true, steamLibraries: 3, steamLibrariesUnreadable: false,
      processesListed: 4, guardedProcesses: ['eurotrucks2.exe', 'truckersmp*']});
    assertClean(JSON.stringify(evidence));
  });
  it('drops a registered version that is not of fixed form', () => {
    expect(factsEvidence({...machine, registration: {...machine.registration, displayVersion: 'C:\\Users\\fixture'}}, RUN_ROOT).registration?.displayVersion).toBeNull();
  });
  it('refuses a Steam library list that exists but was unreadable', () => {
    expect(refusal(() => checkRunPlan(facts({steamLibrariesUnreadable: true})))).toBe('STEAM_LIBRARIES_UNREADABLE');
  });
  it('writes guard evidence without a path, the library list or process names (the driver itself)', async () => {
    const resources = await temporaryResources();
    try {
      const runRoot = path.join(resources.directory, `installer-${ID}`), evidence = path.join(resources.directory, `installer-${ID}-evidence`);
      await mkdir(evidence);
      const config = path.join(evidence, 'config.json');
      await writeFile(config, JSON.stringify({runRoot, evidence, setup: path.join(resources.directory, 'Setup.exe'), stepBudgetMs: 1000}));
      // A passing preflight: no registration and no running product or game; the private process name must still not appear.
      const passing = {...machine, registrationExists: false, registration: null, processes: ['explorer.exe', 'fixture-private-tool.exe']};
      const env = {...process.env, [FACTS_VARIABLE]: JSON.stringify(passing)};
      const {stdout} = await promisify(execFile)(process.execPath, [path.resolve('scripts/installer/installer-lifecycle.mjs'), 'guard', config, 'plan'],
        {env, encoding: 'utf8', timeout: 30000, windowsHide: true});
      expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toMatchObject({command: 'guard', passed: true});
      const names = await readdir(evidence);
      expect(names.sort()).toEqual(['config.json', 'guard-plan.json']);
      const text = await readFile(path.join(evidence, 'guard-plan.json'), 'utf8');
      assertClean(text);
      expect(JSON.parse(text).result).toEqual({phase: 'plan', facts: factsEvidence(passing, runRoot)});
    } finally {await resources.dispose();}
  }, 40000);
  it('never writes the facts to a file in the harness', async () => {
    const harness = await readFile(path.resolve('scripts/installer/Invoke-InstallerLifecycle.ps1'), 'utf8');
    expect(harness).not.toMatch(/facts\.json|factsFile/i);
    expect(harness).toContain('$env:ETS2TELEMETRY_INSTALLER_FACTS = Get-FactJson');
    expect(harness).toContain('Remove-Item Env:ETS2TELEMETRY_INSTALLER_FACTS');
    expect(FACTS_VARIABLE).toBe('ETS2TELEMETRY_INSTALLER_FACTS');
  });
});

describe('fact helpers', () => {
  it('reads the Steam library paths of libraryfolders.vdf', () => {
    const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t\t"label"\t\t""\n\t}\n\t"1"\n\t{\n\t\t"PATH"\t\t"E:\\\\SteamLibrary"\n\t}\n}\n';
    expect(steamLibraryPaths(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'E:\\SteamLibrary']);
    expect(steamLibraryPaths(undefined)).toEqual([]);
  });
  it('resolves a path through its nearest existing ancestor', async () => {
    const realpath = (candidate: string) => normalizePath(candidate) === normalizePath(RUN_ROOT) ? Promise.resolve('D:\\real-run')
      : Promise.reject(Object.assign(new Error('missing'), {code: 'ENOENT'}));
    expect(await resolveRealLocation(`${RUN_ROOT}\\LocalAppData\\ETS2Telemetry`, realpath)).toBe('D:\\real-run\\LocalAppData\\ETS2Telemetry');
    await expect(resolveRealLocation(RUN_ROOT, () => Promise.reject(Object.assign(new Error('denied'), {code: 'EACCES'})))).rejects.toThrow('denied');
  });
});
// ET-018 PR-4: every driver command of the harness runs as the root of its own BoundedProcess Job, which refuses a timeout
// above its cap (ArgumentOutOfRangeException) before anything starts. A step written with a larger timeout would fail the
// hosted lifecycle at that step, so the harness's literal timeouts are checked here against the cap in BoundedProcess.cs.
// ET-018 PR-4: the data root before (the application running) and after (closed orderly) a blocked in-app uninstall.
// Hosted run 39125478842 failed this comparison only because the running application's WAL was gone after the close.
describe('data root of a blocked in-app uninstall', () => {
  const file = (sha256: string, size = 10) => ({size, sha256});
  const BEFORE = {'data\\': {directory: true}, 'data\\telemetry.sqlite': file('a'.repeat(64), 4096), 'data\\telemetry.sqlite-wal': file('b'.repeat(64), 32_768),
    'data\\telemetry.sqlite-shm': file('c'.repeat(64), 32_768), 'plugins\\': {directory: true}, 'plugins\\setup.json': file('d'.repeat(64)),
    'settings\\': {directory: true}, 'settings\\settings.json': file('e'.repeat(64))};
  const without = (tree: Record<string, unknown>, ...names: string[]) => Object.fromEntries(Object.entries(tree).filter(([name]) => !names.includes(name))) as typeof BEFORE;
  /** The refusal's code and the entry it names, or ACCEPTED. */
  const outcome = (work: () => unknown) => {
    try {work(); return 'ACCEPTED';} catch (error) {
      expect(error).toBeInstanceOf(InstallerGuardError);
      return [(error as InstallerGuardError).code, /\((.*)\)$/.exec((error as Error).message)?.[1] ?? ''].join(' ').trim();
    }
  };
  it('leaves out the history database\'s sidecars and pages: a WAL that the close checkpointed away passes', () => {
    const after = {...without(BEFORE, 'data\\telemetry.sqlite-wal', 'data\\telemetry.sqlite-shm'), 'data\\telemetry.sqlite': file('f'.repeat(64), 8192)};
    expect(checkDataRootUnchanged(BEFORE, after)).toBe(2);
    expect(checkDataRootUnchanged(after, BEFORE)).toBe(2);
    expect(checkDataRootUnchanged(BEFORE, {...BEFORE, 'data\\telemetry.sqlite-journal': file('0'.repeat(64))})).toBe(5);
  });
  it('requires the history folder and database and the plugin registry on both sides', () => {
    expect(DATA_ROOT_REQUIRED).toEqual(['data\\', 'data\\telemetry.sqlite', 'plugins\\', 'plugins\\setup.json']);
    expect(outcome(() => checkDataRootUnchanged(BEFORE, without(BEFORE, 'data\\telemetry.sqlite')))).toBe('DATA_ROOT_REQUIRED_MISSING data\\telemetry.sqlite');
    expect(outcome(() => checkDataRootUnchanged(without(BEFORE, 'plugins\\setup.json'), without(BEFORE, 'plugins\\setup.json'))))
      .toBe('DATA_ROOT_REQUIRED_MISSING plugins\\setup.json');
    expect(outcome(() => checkDataRootUnchanged({}, {}))).toBe('DATA_ROOT_REQUIRED_MISSING data\\');
  });
  it('fails any other change: the registry\'s bytes, another entry changed, removed or added, a sidecar outside data', () => {
    expect(outcome(() => checkDataRootUnchanged(BEFORE, {...BEFORE, 'plugins\\setup.json': file('9'.repeat(64))}))).toBe('DATA_ROOT_ENTRY_CHANGED plugins\\setup.json');
    expect(outcome(() => checkDataRootUnchanged(BEFORE, {...BEFORE, 'settings\\settings.json': file('e'.repeat(64), 11)}))).toBe('DATA_ROOT_ENTRY_CHANGED settings\\settings.json');
    expect(outcome(() => checkDataRootUnchanged(BEFORE, without(BEFORE, 'settings\\settings.json')))).toBe('DATA_ROOT_ENTRY_REMOVED settings\\settings.json');
    expect(outcome(() => checkDataRootUnchanged(BEFORE, {...BEFORE, 'uninstall\\': {directory: true}}))).toBe('DATA_ROOT_ENTRY_ADDED uninstall\\');
    expect(outcome(() => checkDataRootUnchanged(BEFORE, {...BEFORE, 'synthetic\\x.sqlite-wal': file('1'.repeat(64))}))).toBe('DATA_ROOT_ENTRY_ADDED synthetic\\x.sqlite-wal');
    expect(outcome(() => checkDataRootUnchanged(BEFORE, {...BEFORE, 'data\\other.txt': file('2'.repeat(64))}))).toBe('DATA_ROOT_ENTRY_ADDED data\\other.txt');
    // Only a database and its sidecars are exempt from the hash; any other file in data\ keeps its bytes.
    const withNotes = {...BEFORE, 'data\\notes.txt': file('3'.repeat(64))};
    expect(outcome(() => checkDataRootUnchanged(withNotes, {...withNotes, 'data\\notes.txt': file('4'.repeat(64))}))).toBe('DATA_ROOT_ENTRY_CHANGED data\\notes.txt');
  });
});

describe('harness Job bounds', () => {
  const checkout = fileURLToPath(new URL('../..', import.meta.url));
  const read = (relative: string) => readFile(path.join(checkout, relative), 'utf8');
  async function jobCap(): Promise<number> {
    const match = /if \(timeoutMs<100 \|\| timeoutMs>(\d+)\) throw new ArgumentOutOfRangeException\("timeoutMs"\)/.exec(await read('scripts/watchdog/BoundedProcess.cs'));
    expect(match, 'BoundedProcess.Run timeout check').not.toBeNull();
    return Number(match![1]);
  }
  it('passes every Invoke-Driver call a literal timeout within the BoundedProcess cap', async () => {
    const cap = await jobCap();
    expect(cap).toBe(60000);
    const calls = (await read('scripts/installer/Invoke-InstallerLifecycle.ps1')).split(/\r?\n/)
      .filter(line => /\bInvoke-Driver\s+'/.test(line) && !/^\s*function\s/.test(line));
    expect(calls.length).toBeGreaterThan(30);
    const timeouts = calls.map(line => ({line: line.trim(), timeout: Number(/\s(\d+)\s*$/.exec(line)?.[1] ?? NaN)}));
    expect(timeouts.filter(call => !Number.isInteger(call.timeout) || call.timeout < 100 || call.timeout > cap)).toEqual([]);
    expect(timeouts.map(call => call.line)).toContain("Invoke-Driver 'app-uninstall' @('complete-app', $executableA, 'complete') 60000");
  });
  // Review of PR-4: a missing separator put one step's diagnostics beside R\diagnostics, outside the uploaded evidence.
  it('puts every diagnostic folder of the harness inside R\\diagnostics', async () => {
    const folders = [...(await read('scripts/installer/Invoke-InstallerLifecycle.ps1')).matchAll(/Join-Path \$runRoot '(diagnostics[^']*)'/g)].map(match => match[1]);
    expect(folders.length).toBeGreaterThan(5);
    expect(folders.filter(folder => folder !== 'diagnostics' && !/^diagnostics\\[a-z0-9.-]+$/.test(folder))).toEqual([]);
  });
  it('keeps the in-app uninstall run\'s own budget below the cap', async () => {
    const cap = await jobCap();
    const budget = Number(/const APP_UNINSTALL_RUN_BUDGET_MS = (\d+);/.exec(await read('scripts/installer/installer-lifecycle.mjs'))?.[1]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(cap - 5000);
  });
});
