import {execFile} from 'node:child_process';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import {checkedPaths, checkInstalled, checkInstallTest, checkLaunchEnvironment, checkRunPlan, checkRunSignal, FACTS_VARIABLE, factsEvidence, installedEnvironment,
  InstallerGuardError, isGuardedProcess, isHostedRunner, minimalPath, normalizePath, ownsRegistration, parseUninstallString, resolveRealLocation, runLayout,
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

describe('Windows-initiated uninstall (ET-018 PR-3)', () => {
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
