import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import {checkedPaths, checkInstalled, checkInstallTest, checkLaunchEnvironment, checkRunPlan, checkRunSignal, checkSetupChannel, FACTS_VARIABLE, factsEvidence, installedEnvironment,
  checkDataRootUnchanged, checkDecoyUnchanged, checkRegistrationIcon, checkUninstallResidue, classifyRegistrationIcon, DATA_ROOT_REQUIRED, electronRuntimeNames, PRODUCT_EXECUTABLE, InstallerGuardError, RESIDUE_MAX_ENTRIES, isGuardedProcess, isHostedRunner, minimalPath, normalizePath, ownsRegistration, parseUninstallString, resolveRealLocation, runLayout,
  steamLibraryPaths, uninstallEnvironment, type RunPlanFacts} from '../../scripts/installer/installer-guard.mjs';
import {checkOtherChannelUnchanged, checkProductLinks, checkRegistrationNames, checkRunChannels, checkShortcutIdentities, checkUninstallEntries, classifyProductLinks, LIFECYCLE_IDENTITIES,
  lifecycleFixtureVersion, lifecycleIdentity, lifecycleVersions, protectedRoots} from '../../scripts/installer/installer-guard.mjs';
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
  return {real: REAL, steamLibraries: STEAM, resolved, channels: ['production'], realBinaryRootExists: {production: false, staging: false},
    registrationExists: {production: false, staging: false}, processes: ['explorer.exe', 'node.exe', 'pwsh.exe'],
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
  // ET-055 PR-4 (UP13): a local run never installs the production identity. ET-055 PR-5 lifted the staging refusal: a
  // staging Setup runs on a hosted runner, or locally under -AllowLocal (checkRunSignal) and every fact-based guard.
  it('installs a production Setup only on a GitHub-hosted runner, and a staging Setup anywhere the run signal allows', () => {
    const hosted = {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'};
    expect(refusal(() => checkSetupChannel('production', hosted))).toBe('ACCEPTED');
    for (const env of [{}, {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'}, {RUNNER_ENVIRONMENT: 'github-hosted'}, {GITHUB_ACTIONS: 'TRUE', RUNNER_ENVIRONMENT: 'github-hosted'},
      {ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: '1'}]) {
      expect(refusal(() => checkSetupChannel('production', env))).toBe('LOCAL_PRODUCTION_REFUSED');
    }
    expect(refusal(() => checkSetupChannel('staging', {}))).toBe('ACCEPTED');
    expect(refusal(() => checkSetupChannel('staging', hosted))).toBe('ACCEPTED');
    for (const channel of [undefined, '', 'Production', 'beta']) expect(refusal(() => checkSetupChannel(channel, hosted))).toBe('SETUP_CHANNEL_UNKNOWN');
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
  const stagingUpdate = `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktopStaging\\Update.exe`;
  it.each([[`"${update}" --uninstall`, ['--uninstall']], [`"${update}" --uninstall -s`, ['--uninstall', '-s']]] as const)('runs the registered %s', (value, args) => {
    expect(parseUninstallString(value, RUN_ROOT, 'production')).toEqual({program: update, args});
  });
  // ET-055 PR-5: each channel runs only its own Update.exe, never the other channel's in the same run root.
  it('runs only the channel\'s own Update.exe', () => {
    expect(parseUninstallString(`"${stagingUpdate}" --uninstall`, RUN_ROOT, 'staging')).toEqual({program: stagingUpdate, args: ['--uninstall']});
    expect(refusal(() => parseUninstallString(`"${stagingUpdate}" --uninstall`, RUN_ROOT, 'production'))).toBe('UNINSTALL_STRING_OUTSIDE_RUN_ROOT');
    expect(refusal(() => parseUninstallString(`"${update}" --uninstall`, RUN_ROOT, 'staging'))).toBe('UNINSTALL_STRING_OUTSIDE_RUN_ROOT');
    expect(refusal(() => parseUninstallString(`"${update}" --uninstall`, RUN_ROOT, 'beta'))).toBe('LIFECYCLE_CHANNEL_UNKNOWN');
  });
  it.each([
    ['another Update.exe', `"C:\\Users\\fixture\\AppData\\Local\\ETS2TelemetryDesktop\\Update.exe" --uninstall`, 'UNINSTALL_STRING_OUTSIDE_RUN_ROOT'],
    ['an unquoted program', `${update} --uninstall`, 'UNINSTALL_STRING_INVALID'],
    ['another command', `"${update}" --update C:\\feed`, 'UNINSTALL_STRING_INVALID'],
    ['an extra argument', `"${update}" --uninstall -s --extra`, 'UNINSTALL_STRING_INVALID'],
    ['no value', undefined, 'UNINSTALL_STRING_INVALID']
  ])('refuses %s', (_name, value, code) => expect(refusal(() => parseUninstallString(value, RUN_ROOT, 'production'))).toBe(code));
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
    const layout = runLayout(RUN_ROOT, 'production');
    expect({base: layout.base, squirrelTemp: layout.squirrelTemp, binaryRoot: layout.binaryRoot, dataRoot: layout.dataRoot}).toEqual({
      base: `${RUN_ROOT}\\LocalAppData`, squirrelTemp: `${RUN_ROOT}\\LocalAppData`, binaryRoot: `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktop`,
      dataRoot: `${RUN_ROOT}\\LocalAppData\\ETS2Telemetry`});
  });
  // ET-055 PR-5: the staging channel's roots sit beside production's in the same R\LocalAppData; the shared folders are one.
  it('derives the staging binary and data roots beside production\'s, and refuses an unknown channel', () => {
    const staging = runLayout(RUN_ROOT, 'staging'), production = runLayout(RUN_ROOT, 'production');
    expect({binaryRoot: staging.binaryRoot, dataRoot: staging.dataRoot, channel: staging.channel}).toEqual({binaryRoot: `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktopStaging`,
      dataRoot: `${RUN_ROOT}\\LocalAppData\\ETS2TelemetryStaging`, channel: 'staging'});
    expect({...staging, binaryRoot: '', dataRoot: '', channel: ''}).toEqual({...production, binaryRoot: '', dataRoot: '', channel: ''});
    expect(refusal(() => runLayout(RUN_ROOT, 'Staging'))).toBe('LIFECYCLE_CHANNEL_UNKNOWN');
    expect(refusal(() => runLayout(RUN_ROOT, undefined as unknown as string))).toBe('LIFECYCLE_CHANNEL_UNKNOWN');
  });
  it.each([
    ['the real data root', `${REAL.localAppData}\\ETS2Telemetry\\installer-${ID}`],
    ['the real binary root', `${REAL.localAppData}\\ETS2TelemetryDesktop\\installer-${ID}`],
    ['the real Roaming userData', `${REAL.roamingAppData}\\ETS2Telemetry Desktop\\installer-${ID}`],
    ['the real data root in other case', `c:\\users\\FIXTURE\\appdata\\local\\ets2telemetry\\installer-${ID}`],
    // ET-055 PR-5: both channels' real roots are protected, whatever the run installs.
    ['the real staging data root', `${REAL.localAppData}\\ETS2TelemetryStaging\\installer-${ID}`],
    ['the real staging binary root', `${REAL.localAppData}\\ETS2TelemetryDesktopStaging\\installer-${ID}`],
    ['the real staging Roaming userData', `${REAL.roamingAppData}\\ETS2Telemetry Desktop Staging\\installer-${ID}`]
  ])('refuses a run root inside %s', (_name, runRoot) => {
    expect(refusal(() => checkRunPlan(facts({runRoot})))).toBe('PATH_IN_REAL_ROOT');
    expect(refusal(() => checkRunPlan(facts({runRoot, channels: ['staging']})))).toBe('PATH_IN_REAL_ROOT');
  });
  it('protects the data, binary and Roaming roots of both channels', () => {
    expect(protectedRoots(REAL).real).toEqual([`${REAL.localAppData}\\ETS2Telemetry`, `${REAL.localAppData}\\ETS2TelemetryDesktop`, `${REAL.roamingAppData}\\ETS2Telemetry Desktop`,
      `${REAL.localAppData}\\ETS2TelemetryStaging`, `${REAL.localAppData}\\ETS2TelemetryDesktopStaging`, `${REAL.roamingAppData}\\ETS2Telemetry Desktop Staging`]);
  });
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
    expect(refusal(() => checkRunPlan(facts({registrationExists: {production: true, staging: false}})))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan(facts({realBinaryRootExists: {production: true, staging: false}})))).toBe('REAL_INSTALL_PRESENT');
    expect(refusal(() => checkRunPlan({...facts(), registrationExists: undefined as unknown as Record<string, boolean>}))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan({...facts(), realBinaryRootExists: undefined as unknown as Record<string, boolean>}))).toBe('REAL_INSTALL_PRESENT');
    expect(refusal(() => checkRunPlan(facts({registrationExists: {production: false}})))).toBe('ACCEPTED');
  });
  // ET-055 PR-5: the preflight judges every channel the run installs, and only those: a local staging run may proceed beside
  // the owner's installed production copy, but never beside an installed staging copy; the side-by-side run needs both absent.
  it('judges the real install and registration of every channel the run installs, and only those', () => {
    const production = {production: true, staging: false}, staging = {production: false, staging: true};
    expect(refusal(() => checkRunPlan(facts({channels: ['staging'], realBinaryRootExists: production, registrationExists: production})))).toBe('ACCEPTED');
    expect(refusal(() => checkRunPlan(facts({channels: ['staging'], realBinaryRootExists: staging})))).toBe('REAL_INSTALL_PRESENT');
    expect(refusal(() => checkRunPlan(facts({channels: ['staging'], registrationExists: staging})))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan(facts({channels: ['staging'], registrationExists: {production: false}})))).toBe('REGISTRATION_PRESENT');
    expect(refusal(() => checkRunPlan(facts({channels: ['production', 'staging']})))).toBe('ACCEPTED');
    expect(refusal(() => checkRunPlan(facts({channels: ['production', 'staging'], realBinaryRootExists: staging})))).toBe('REAL_INSTALL_PRESENT');
    expect(refusal(() => checkRunPlan(facts({channels: ['production', 'staging'], registrationExists: production})))).toBe('REGISTRATION_PRESENT');
  });
  it.each([[[]], [['production', 'production']], [['beta']], [['production', 'staging', 'production']], [undefined]])('refuses the run channels %j', channels => {
    expect(refusal(() => checkRunPlan(facts({channels: channels as string[]})))).toBe('RUN_CHANNELS_INVALID');
    expect(refusal(() => checkRunChannels(channels))).toBe('RUN_CHANNELS_INVALID');
  });
  it.each(['ETS2TelemetryDesktop.exe', 'ETS2TelemetryDesktopStaging.exe', 'eurotrucks2.exe', 'AMTRUCKS.EXE', 'TruckersMP-Launcher.exe', 'truckersmp-cli.exe'])('refuses a running %s', name => {
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
  const binaryRoot = runLayout(RUN_ROOT, 'production').binaryRoot, stagingRoot = runLayout(RUN_ROOT, 'staging').binaryRoot;
  const installed = (changes = {}) => ({runRoot: RUN_ROOT, channel: 'production', installLocation: binaryRoot, binaryRoot, resolvedInstallLocation: binaryRoot, resolvedBinaryRoot: binaryRoot,
    realBinaryRootExists: false, ...changes});
  it('accepts the binary root R\\LocalAppData\\ETS2TelemetryDesktop', () => expect(refusal(() => checkInstalled(installed()))).toBe('ACCEPTED'));
  // ET-055 PR-5: each channel's registration must name its own binary root, never the other channel's beside it.
  it('accepts the staging binary root for staging only', () => {
    const staging = {channel: 'staging', installLocation: stagingRoot, binaryRoot: stagingRoot, resolvedInstallLocation: stagingRoot, resolvedBinaryRoot: stagingRoot};
    expect(refusal(() => checkInstalled(installed(staging)))).toBe('ACCEPTED');
    expect(refusal(() => checkInstalled(installed({...staging, channel: 'production'})))).toBe('INSTALL_OUTSIDE_RUN_ROOT');
    expect(refusal(() => checkInstalled(installed({channel: 'staging'})))).toBe('INSTALL_OUTSIDE_RUN_ROOT');
  });
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

// ET-045h (REG-013, REG-017): the product name. The harness reads the product shortcuts (names only) and the HKCU Uninstall
// subkeys pointing into R; these pure checks decide.
describe('product shortcuts, the Uninstall entry and the display names (ET-045h)', () => {
  const NEW = 'Yukon Union Telemetry', OLD = 'ETS2Telemetry Desktop';
  const installedLinks = [`desktop||${NEW}`, `start-menu|Artur Sianiuk|${NEW}`];

  it('accepts one current-name shortcut per location after an install, in the Start menu company folder', () => {
    const classification = classifyProductLinks(installedLinks, 'production');
    expect(classification).toEqual({total: 2, desktop: {current: 1, legacy: 0, other: 0, currentFolders: ['']},
      'start-menu': {current: 1, legacy: 0, other: 0, currentFolders: ['Artur Sianiuk']}});
    expect(refusal(() => checkProductLinks(classification, 'installed'))).toBe('ACCEPTED');
  });
  it.each([
    ['an old-name shortcut beside the new one', [...installedLinks, `start-menu|Artur Sianiuk|${OLD}`], 'LEGACY_SHORTCUT_REMAINS'],
    ['only the old name on the Desktop', [`desktop||${OLD}`, installedLinks[1]], 'LEGACY_SHORTCUT_REMAINS'],
    ['a product shortcut of another name', [...installedLinks, 'desktop||Something else'], 'PRODUCT_SHORTCUT_OTHER_NAME'],
    ['no Start menu shortcut', [installedLinks[0]], 'PRODUCT_SHORTCUT_MISSING'],
    ['two Desktop shortcuts', [...installedLinks, `desktop|Folder|${NEW}`], 'PRODUCT_SHORTCUT_DUPLICATE'],
    ['a Start menu shortcut in another folder', [installedLinks[0], `start-menu|Other|${NEW}`], 'PRODUCT_SHORTCUT_FOLDER'],
    ['a Desktop shortcut in a subfolder', [`desktop|Folder|${NEW}`, installedLinks[1]], 'PRODUCT_SHORTCUT_FOLDER']
  ])('refuses %s after an install', (_name, rows, code) => expect(refusal(() => checkProductLinks(classifyProductLinks(rows, 'production'), 'installed'))).toBe(code));
  // ET-055 PR-5: the staging shortcuts carry the staging display name, and staging has no earlier name to migrate.
  it('classifies staging shortcuts by the staging display name, without legacy names', () => {
    const STAGING = 'Yukon Union Telemetry Staging', rows = [`desktop||${STAGING}`, `start-menu|Artur Sianiuk|${STAGING}`];
    expect(refusal(() => checkProductLinks(classifyProductLinks(rows, 'staging'), 'installed'))).toBe('ACCEPTED');
    expect(refusal(() => checkProductLinks(classifyProductLinks(installedLinks, 'staging'), 'installed'))).toBe('PRODUCT_SHORTCUT_OTHER_NAME');
    expect(refusal(() => checkProductLinks(classifyProductLinks(rows, 'production'), 'installed'))).toBe('PRODUCT_SHORTCUT_OTHER_NAME');
    expect(classifyProductLinks([...rows, `desktop||${OLD}`], 'staging').desktop).toEqual({current: 1, legacy: 0, other: 1, currentFolders: ['']});
  });
  it('accepts each channel\'s own AUMID on its shortcuts and never the other channel\'s', () => {
    const production = lifecycleIdentity('production'), staging = lifecycleIdentity('staging');
    expect([production.appUserModelId, staging.appUserModelId]).toEqual(['com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop',
      'com.squirrel.ETS2TelemetryDesktopStaging.ETS2TelemetryDesktopStaging']);
    expect(checkShortcutIdentities([`desktop|${NEW}|${production.appUserModelId}`, `start-menu|${NEW}|${production.appUserModelId}`], 'production')).toBe(2);
    expect(checkShortcutIdentities([`desktop|${staging.displayName}|${staging.appUserModelId}`], 'staging')).toBe(1);
    expect(refusal(() => checkShortcutIdentities([`desktop|${staging.displayName}|${production.appUserModelId}`], 'staging'))).toBe('SHORTCUT_AUMID_DIFFERS');
    expect(refusal(() => checkShortcutIdentities([`desktop|${NEW}|`], 'production'))).toBe('SHORTCUT_AUMID_DIFFERS');
    expect(refusal(() => checkShortcutIdentities([`desktop|${staging.displayName}|${production.appUserModelId}`], 'production'))).toBe('SHORTCUT_IDENTITY_NAME');
    expect(refusal(() => checkShortcutIdentities([], 'production'))).toBe('SHORTCUT_IDENTITIES_MISSING');
    expect(refusal(() => checkShortcutIdentities([`taskbar|${NEW}|${production.appUserModelId}`], 'production'))).toBe('SHORTCUT_IDENTITY_ROW_INVALID');
  });
  it('expects no product shortcut of any name after an uninstall', () => {
    expect(refusal(() => checkProductLinks(classifyProductLinks([], 'production'), 'none'))).toBe('ACCEPTED');
    expect(refusal(() => checkProductLinks(classifyProductLinks([`start-menu|Artur Sianiuk|${OLD}`], 'production'), 'none'))).toBe('PRODUCT_SHORTCUT_UNEXPECTED');
    expect(refusal(() => checkProductLinks(classifyProductLinks(installedLinks, 'production'), 'other' as 'none'))).toBe('PRODUCT_LINK_EXPECTATION_INVALID');
  });
  it.each([
    ['a path for a name', [`desktop||C:\\Users\\x\\${NEW}`]],
    ['an absolute folder', [`start-menu|C:\\Programs|${NEW}`]],
    ['a folder that climbs', [`start-menu|..\\Other|${NEW}`]],
    ['an unknown location', [`taskbar||${NEW}`]],
    ['a missing field', [`desktop|${NEW}`]],
    ['an empty name', ['desktop||']]
  ])('refuses a link row with %s', (_name, rows) => expect(refusal(() => classifyProductLinks(rows, 'production'))).toBe('PRODUCT_LINK_ROW_INVALID'));

  const binaryRoot = runLayout(RUN_ROOT, 'production').binaryRoot, stagingRoot = runLayout(RUN_ROOT, 'staging').binaryRoot;
  const entry = (view: string, name = 'ETS2TelemetryDesktop', installLocation: string | null = binaryRoot) => ({view, name, installLocation});
  it('accepts the one ETS2TelemetryDesktop entry, seen in both registry views', () => {
    expect(checkUninstallEntries([entry('Registry64'), entry('Registry32')], RUN_ROOT, 'production')).toEqual({views: 2, names: ['ETS2TelemetryDesktop'], otherChannels: []});
    expect(checkUninstallEntries([entry('Registry64'), entry('Registry64', 'Other', 'D:\\Other')], RUN_ROOT, 'production'))
      .toEqual({views: 1, names: ['ETS2TelemetryDesktop'], otherChannels: []});
  });
  // ET-055 PR-5: side by side, each channel keeps one entry of its own, and the other channel's own entry may sit beside it.
  it('accepts the other channel\'s own entry beside this channel\'s, and nothing else in R', () => {
    const staging = (view: string, name = 'ETS2TelemetryDesktopStaging', location: string | null = stagingRoot) => entry(view, name, location);
    const both = [entry('Registry64'), staging('Registry64')];
    expect(checkUninstallEntries(both, RUN_ROOT, 'production')).toEqual({views: 1, names: ['ETS2TelemetryDesktop'], otherChannels: ['staging']});
    expect(checkUninstallEntries(both, RUN_ROOT, 'staging')).toEqual({views: 1, names: ['ETS2TelemetryDesktopStaging'], otherChannels: ['production']});
    expect(refusal(() => checkUninstallEntries([staging('Registry64')], RUN_ROOT, 'production'))).toBe('UNINSTALL_ENTRY_MISSING');
    expect(refusal(() => checkUninstallEntries([entry('Registry64'), staging('Registry64', 'ETS2TelemetryDesktop')], RUN_ROOT, 'production'))).toBe('UNINSTALL_ENTRY_FOREIGN_NAME');
    expect(refusal(() => checkUninstallEntries([staging('Registry64'), staging('Registry64', 'ETS2TelemetryDesktopStaging2')], RUN_ROOT, 'staging')))
      .toBe('UNINSTALL_ENTRY_DUPLICATE');
    expect(refusal(() => checkUninstallEntries([entry('Registry64'), entry('Registry64', 'Other', `${RUN_ROOT}\\Other`)], RUN_ROOT, 'production'))).toBe('UNINSTALL_ENTRY_FOREIGN_NAME');
  });
  it.each([
    ['no entry', [], 'UNINSTALL_ENTRY_MISSING'],
    ['only an entry outside R', [entry('Registry64', 'ETS2TelemetryDesktop', `${REAL.localAppData}\\ETS2TelemetryDesktop`)], 'UNINSTALL_ENTRY_MISSING'],
    ['an entry without a location', [entry('Registry64', 'ETS2TelemetryDesktop', null)], 'UNINSTALL_ENTRY_MISSING'],
    ['two entries in one view', [entry('Registry64'), entry('Registry64', 'ETS2TelemetryDesktop2')], 'UNINSTALL_ENTRY_DUPLICATE'],
    ['a foreign key name inside R', [entry('Registry64', 'YukonUnionTelemetry')], 'UNINSTALL_ENTRY_FOREIGN_NAME']
  ])('refuses %s', (_name, rows, code) => expect(refusal(() => checkUninstallEntries(rows, RUN_ROOT, 'production'))).toBe(code));
  it('refuses rows that are not a list', () => expect(refusal(() => checkUninstallEntries(null as never, RUN_ROOT, 'production'))).toBe('UNINSTALL_ENTRIES_INVALID'));

  it('accepts only the product DisplayName and Publisher', () => {
    expect(checkRegistrationNames({displayName: NEW, publisher: 'Yukon Union Telemetry contributors'}, 'production')).toEqual({displayName: NEW,
      publisher: 'Yukon Union Telemetry contributors'});
    expect(refusal(() => checkRegistrationNames({displayName: OLD, publisher: 'Yukon Union Telemetry contributors'}, 'production'))).toBe('DISPLAY_NAME_NOT_PRODUCT');
    expect(refusal(() => checkRegistrationNames({displayName: NEW, publisher: 'ETS2Telemetry contributors'}, 'production'))).toBe('PUBLISHER_NOT_PRODUCT');
    expect(refusal(() => checkRegistrationNames(null, 'production'))).toBe('DISPLAY_NAME_NOT_PRODUCT');
    // ET-055 PR-5: the staging entry shows the staging display name, with the same Publisher.
    expect(checkRegistrationNames({displayName: 'Yukon Union Telemetry Staging', publisher: 'Yukon Union Telemetry contributors'}, 'staging').displayName)
      .toBe('Yukon Union Telemetry Staging');
    expect(refusal(() => checkRegistrationNames({displayName: NEW, publisher: 'Yukon Union Telemetry contributors'}, 'staging'))).toBe('DISPLAY_NAME_NOT_PRODUCT');
  });
});

// ET-045g (REG-017): the Installed apps icon. The harness reads the registration's DisplayIcon, and the driver records only
// its shape and the hash of the binary root's app.ico; the value is a machine path and never reaches the evidence.
describe('registration icon shape (ET-045g)', () => {
  const binaryRoot = runLayout(RUN_ROOT, 'production').binaryRoot;
  const shape = (displayIcon: unknown, version = '0.1.1') => classifyRegistrationIcon({displayIcon, binaryRoot, version, channel: 'production'});
  // ET-055 PR-5: the staging entry's icon is icon 0 of the staging executable in the staging binary root.
  it('recognizes the staging executable in the staging binary root only for staging', () => {
    const stagingRoot = runLayout(RUN_ROOT, 'staging').binaryRoot, value = `${stagingRoot}\\app-0.1.0-stg000000\\ETS2TelemetryDesktopStaging.exe,0`;
    expect(classifyRegistrationIcon({displayIcon: value, binaryRoot: stagingRoot, version: '0.1.0-stg000000', channel: 'staging'})).toEqual({shape: 'app-exe-index-0', versionMatches: true});
    expect(classifyRegistrationIcon({displayIcon: value, binaryRoot: stagingRoot, version: '0.1.0-stg000000', channel: 'production'})).toEqual({shape: 'other', versionMatches: null});
    expect(classifyRegistrationIcon({displayIcon: `${stagingRoot}\\app-0.1.0-stg000000\\ETS2TelemetryDesktop.exe,0`, binaryRoot: stagingRoot, version: '0.1.0-stg000000',
      channel: 'staging'})).toEqual({shape: 'other', versionMatches: null});
  });
  it('recognizes Squirrel\'s root app.ico, case-insensitively', () => {
    expect(shape(`${binaryRoot}\\app.ico`)).toEqual({shape: 'root-app-ico', versionMatches: null});
    expect(shape(`${binaryRoot.toUpperCase()}\\APP.ICO`)).toEqual({shape: 'root-app-ico', versionMatches: null});
  });
  it('recognizes the versioned product executable with icon index 0 and compares its version', () => {
    expect(PRODUCT_EXECUTABLE).toBe('ETS2TelemetryDesktop.exe');
    expect(shape(`${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`)).toEqual({shape: 'app-exe-index-0', versionMatches: true});
    expect(shape(`${binaryRoot}\\app-0.1.0\\ETS2TelemetryDesktop.exe,0`)).toEqual({shape: 'app-exe-index-0', versionMatches: false});
    expect(shape(`${binaryRoot}\\app-0.1.0-alpha1\\ETS2TelemetryDesktop.exe,0`, '0.1.0-alpha1')).toEqual({shape: 'app-exe-index-0', versionMatches: true});
  });
  it('reports no value or an empty one as absent', () => {
    for (const value of [undefined, null, '']) expect(shape(value)).toEqual({shape: 'absent', versionMatches: null});
  });
  it.each([
    ['a quoted value', `"${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe",0`],
    ['a relative value', 'app-0.1.1\\ETS2TelemetryDesktop.exe,0'],
    ['another icon index', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,1`],
    ['no icon index', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe`],
    ['another executable', `${binaryRoot}\\app-0.1.1\\Update.exe,0`],
    ['a folder that is not app-<version>', `${binaryRoot}\\resources\\ETS2TelemetryDesktop.exe,0`],
    ['another binary root', `${REAL.localAppData}\\ETS2TelemetryDesktop\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`],
    ['an app.ico elsewhere', `${REAL.localAppData}\\ETS2TelemetryDesktop\\app.ico`],
    ['a parent segment', `${binaryRoot}\\app-0.1.1\\..\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`],
    ['a downloaded URL', 'https://raw.githubusercontent.com/electron/electron/main/shell/browser/resources/win/electron.ico'],
    ['a number', 7]
  ])('reports %s as other', (_name, value) => expect(shape(value)).toEqual({shape: 'other', versionMatches: null}));

  const TRACKED = 'a'.repeat(64);
  const product = {regularFile: true, sha256: TRACKED};
  const observation = (displayIcon: unknown, changes: Record<string, unknown> = {}) => ({displayIcon: shape(displayIcon), rootIcon: product, bundledIcon: product,
    trackedSha256: TRACKED, ...changes}) as Parameters<typeof checkRegistrationIcon>[0];
  it('accepts icon 0 of the installed version\'s executable with the product icon in both places', () => {
    expect(refusal(() => checkRegistrationIcon(observation(`${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`)))).toBe('ACCEPTED');
  });
  it.each([
    ['a DisplayIcon of another version', `${binaryRoot}\\app-0.1.0\\ETS2TelemetryDesktop.exe,0`, {}, 'DISPLAY_ICON_VERSION_MISMATCH'],
    ['Squirrel\'s root app.ico', `${binaryRoot}\\app.ico`, {}, 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'],
    ['no DisplayIcon', null, {}, 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'],
    ['a quoted value', `"${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe",0`, {}, 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'],
    ['a relative value', 'app-0.1.1\\ETS2TelemetryDesktop.exe,0', {}, 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'],
    ['a root app.ico of other bytes', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`, {rootIcon: {regularFile: true, sha256: 'b'.repeat(64)}}, 'ROOT_ICON_NOT_PRODUCT'],
    ['no root app.ico', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`, {rootIcon: {regularFile: false, sha256: null}}, 'ROOT_ICON_NOT_PRODUCT'],
    ['a packaged icon of other bytes', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`, {bundledIcon: {regularFile: true, sha256: 'c'.repeat(64)}},
      'BUNDLED_ICON_NOT_PRODUCT'],
    ['no tracked hash', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`, {trackedSha256: 'not a hash'}, 'TRACKED_ICON_INVALID']
  ])('refuses %s', (_name, value, changes, code) => expect(refusal(() => checkRegistrationIcon(observation(value, changes)))).toBe(code));
});

describe('launch environment', () => {
  const layout = runLayout(RUN_ROOT, 'production');
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
  const registration = {installLocation: runLayout(RUN_ROOT, 'production').binaryRoot, displayVersion: '0.1.1',
    uninstallString: `"${RUN_ROOT}\\LocalAppData\\ETS2TelemetryDesktop\\Update.exe" --uninstall`};
  // ET-055 PR-5: the harness reports both channels' real binary roots and registrations, and the active channel's as before.
  const machine = {real: REAL, channel: 'production', realBinaryRootExists: false, registrationExists: true, steamPath: STEAM[0], libraryFolders: VDF, libraryFoldersState: 'read',
    registration, realBinaryRoots: {production: false, staging: false}, registrations: {production: registration, staging: null},
    processes: ['explorer.exe', 'fixture-private-tool.exe', 'eurotrucks2.exe', 'TruckersMP-Launcher.exe']};
  const DRIVE_PATH = /[A-Za-z]:[\\/]/;
  const assertClean = (text: string) => {
    expect(text).not.toMatch(DRIVE_PATH);
    expect(text).not.toMatch(/libraryfolders|"path"|SteamLibrary|fixture|explorer|uninstall/i);
  };
  it('keeps only booleans, counts and the matched product and game image names', () => {
    const evidence = factsEvidence(machine, RUN_ROOT);
    expect(evidence).toEqual({knownFoldersResolved: true, channel: 'production', realBinaryRootExists: false, registrationExists: true,
      registration: {displayVersion: '0.1.1', installLocationInsideRunRoot: true},
      channels: {realBinaryRoots: {production: false, staging: false}, registrations: {production: {displayVersion: '0.1.1', installLocationInsideRunRoot: true}, staging: null}},
      steamPathPresent: true, steamLibraries: 3, steamLibrariesUnreadable: false, processesListed: 4, guardedProcesses: ['eurotrucks2.exe', 'truckersmp*']});
    assertClean(JSON.stringify(evidence));
  });
  it('drops a registered version that is not of fixed form', () => {
    expect(factsEvidence({...machine, registration: {...machine.registration, displayVersion: 'C:\\Users\\fixture'}}, RUN_ROOT).registration?.displayVersion).toBeNull();
    // A staging DisplayVersion carries its NuGet prerelease label (ET-055 PR-5).
    expect(factsEvidence({...machine, registration: {...machine.registration, displayVersion: '0.1.0-stg000000'}}, RUN_ROOT).registration?.displayVersion).toBe('0.1.0-stg000000');
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
      await writeFile(config, JSON.stringify({runRoot, evidence, setup: path.join(resources.directory, 'Setup.exe'), stepBudgetMs: 1000, channel: 'production',
        channels: ['production'], appVersion: '0.1.0'}));
      // A passing preflight: no registration and no running product or game; the private process name must still not appear.
      const passing = {...machine, registrationExists: false, registration: null, registrations: {production: null, staging: null},
        processes: ['explorer.exe', 'fixture-private-tool.exe']};
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
  // ET-045g: the installed command's icon observation and check, and the legacy-icon plant, against a fake binary root in
  // a temporary run root. No registry is read or written: the registration comes in the facts.
  async function iconRun() {
    const resources = await temporaryResources();
    // The real location, so the driver's realpath checks of R's binary root agree with the raw path.
    const base = await realpath(resources.directory);
    const runRoot = path.join(base, `installer-${ID}`), evidence = path.join(base, `installer-${ID}-evidence`);
    const binaryRoot = runLayout(runRoot, 'production').binaryRoot;
    await mkdir(binaryRoot, {recursive: true});
    await mkdir(evidence);
    const config = path.join(evidence, 'config.json');
    await writeFile(config, JSON.stringify({runRoot, evidence, setup: path.join(base, 'Setup.exe'), stepBudgetMs: 1000, channel: 'production', channels: ['production'],
      appVersion: '0.1.0'}));
    /** Runs one driver command with this registration in the facts; resolves with its result line, also when it failed. */
    // ET-045h: the product DisplayName and Publisher and the one Uninstall entry in R, unless a case replaces them.
    const command = (args: string[], version: string, displayIcon: string | null, names: {displayName?: string; publisher?: string} = {},
      uninstallEntries: {view: string; name: string; installLocation: string}[] = [{view: 'Registry64', name: 'ETS2TelemetryDesktop', installLocation: binaryRoot}]) => {
      const registration = {installLocation: binaryRoot, displayVersion: version, uninstallString: `"${binaryRoot}\\Update.exe" --uninstall`, displayIcon,
        displayName: 'Yukon Union Telemetry', publisher: 'Yukon Union Telemetry contributors', ...names};
      const env = {...process.env, [FACTS_VARIABLE]: JSON.stringify({...machine, registration, uninstallEntries, realBinaryRootExists: false})};
      return new Promise<{passed: boolean; failure: {code?: string} | null}>((resolve, reject) => {
        execFile(process.execPath, [path.resolve('scripts/installer/installer-lifecycle.mjs'), args[0], config, ...args.slice(1)],
          {env, encoding: 'utf8', timeout: 30000, windowsHide: true}, (_error, stdout) => {
            try {resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1)!) as {passed: boolean; failure: {code?: string} | null});} catch {reject(new Error('DRIVER_OUTPUT_INVALID'));}
          });
      });
    };
    return {resources, runRoot, evidence, binaryRoot, command};
  }
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  it('records the DisplayIcon shape and both app.ico hashes without a path, then requires the product icon (the driver itself)', async () => {
    const {resources, evidence, binaryRoot, command} = await iconRun();
    try {
      // A synthetic one-entry ICO, distinct from the tracked product icon.
      const legacy = Buffer.alloc(22 + 8);
      legacy.writeUInt16LE(1, 2); legacy.writeUInt16LE(1, 4); legacy.writeUInt8(1, 6); legacy.writeUInt8(1, 7); legacy.writeUInt16LE(1, 10);
      legacy.writeUInt16LE(32, 12); legacy.writeUInt32LE(8, 14); legacy.writeUInt32LE(22, 18);
      const tracked = await readFile(path.resolve('resources/icon/app.ico'));
      const observed = async (label: string) => {
        const text = await readFile(path.join(evidence, `icon-${label}.json`), 'utf8');
        assertClean(text);
        return JSON.parse(text) as unknown;
      };
      const missing = {present: false, regularFile: false, bytes: null, sha256: null, equalsTracked: false, readError: null};
      // The pre-fix state: Squirrel's downloaded icon and its DisplayIcon. Recorded first, then refused.
      await writeFile(path.join(binaryRoot, 'app.ico'), legacy);
      expect(await command(['installed', 'install-0.1.0', '0.1.0'], '0.1.0', `${binaryRoot}\\app.ico`))
        .toMatchObject({passed: false, failure: {code: 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'}});
      expect(await observed('install-0.1.0')).toEqual({label: 'install-0.1.0', version: '0.1.0', displayIcon: {shape: 'root-app-ico', versionMatches: null},
        rootIcon: {present: true, regularFile: true, bytes: legacy.length, sha256: hash(legacy), equalsTracked: false, readError: null}, bundledIcon: missing,
        trackedSha256: hash(tracked)});
      // The fixed state of version 0.1.1: the hook's app.ico and the packaged icon have the tracked bytes.
      await writeFile(path.join(binaryRoot, 'app.ico'), tracked);
      await mkdir(path.join(binaryRoot, 'app-0.1.1', 'resources', 'icon'), {recursive: true});
      await writeFile(path.join(binaryRoot, 'app-0.1.1', 'resources', 'icon', 'app.ico'), tracked);
      expect(await command(['installed', 'update-0.1.1', '0.1.1'], '0.1.1', `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`)).toMatchObject({passed: true});
      // ET-045h: the old DisplayName or Publisher of an install made before the rename, or a second entry, is refused.
      const current = `${binaryRoot}\\app-0.1.1\\ETS2TelemetryDesktop.exe,0`;
      expect(await command(['installed', 'old-name-0.1.1', '0.1.1'], '0.1.1', current, {displayName: 'ETS2Telemetry Desktop'}))
        .toMatchObject({passed: false, failure: {code: 'DISPLAY_NAME_NOT_PRODUCT'}});
      expect(await command(['installed', 'old-publisher-0.1.1', '0.1.1'], '0.1.1', current, {publisher: 'ETS2Telemetry contributors'}))
        .toMatchObject({passed: false, failure: {code: 'PUBLISHER_NOT_PRODUCT'}});
      expect(await command(['installed', 'two-entries-0.1.1', '0.1.1'], '0.1.1', current, {}, [{view: 'Registry64', name: 'ETS2TelemetryDesktop', installLocation: binaryRoot},
        {view: 'Registry64', name: 'YukonUnionTelemetry', installLocation: binaryRoot}])).toMatchObject({passed: false, failure: {code: 'UNINSTALL_ENTRY_DUPLICATE'}});
      expect(await observed('update-0.1.1')).toMatchObject({displayIcon: {shape: 'app-exe-index-0', versionMatches: true},
        rootIcon: {present: true, sha256: hash(tracked), equalsTracked: true}, bundledIcon: {present: true, sha256: hash(tracked), equalsTracked: true}});
      // A DisplayIcon of the previous version, or no value at all, is refused.
      expect(await command(['installed', 'stale-0.1.1', '0.1.1'], '0.1.1', `${binaryRoot}\\app-0.1.0\\ETS2TelemetryDesktop.exe,0`))
        .toMatchObject({passed: false, failure: {code: 'DISPLAY_ICON_VERSION_MISMATCH'}});
      await rm(path.join(binaryRoot, 'app.ico'));
      expect(await command(['installed', 'repair-0.1.0', '0.1.0'], '0.1.0', null)).toMatchObject({passed: false, failure: {code: 'DISPLAY_ICON_NOT_PRODUCT_EXECUTABLE'}});
      expect(await observed('repair-0.1.0')).toMatchObject({displayIcon: {shape: 'absent', versionMatches: null}, rootIcon: missing});
      expect((await readdir(evidence)).sort()).toEqual(['config.json', 'icon-install-0.1.0.json', 'icon-old-name-0.1.1.json', 'icon-old-publisher-0.1.1.json',
        'icon-repair-0.1.0.json', 'icon-stale-0.1.1.json', 'icon-two-entries-0.1.1.json', 'icon-update-0.1.1.json', 'installed-install-0.1.0.json',
        'installed-old-name-0.1.1.json', 'installed-old-publisher-0.1.1.json', 'installed-repair-0.1.0.json', 'installed-stale-0.1.1.json',
        'installed-two-entries-0.1.1.json', 'installed-update-0.1.1.json']);
      for (const name of await readdir(evidence)) if (name.startsWith('installed-')) expect(await readFile(path.join(evidence, name), 'utf8')).not.toMatch(DRIVE_PATH);
    } finally {await resources.dispose();}
  }, 60000);
  it('plants a legacy app.ico and allows a DisplayIcon write only for views whose key points into R (the driver itself)', async () => {
    const {resources, runRoot, evidence, binaryRoot, command} = await iconRun();
    try {
      const tracked = await readFile(path.resolve('resources/icon/app.ico'));
      await writeFile(path.join(binaryRoot, 'app.ico'), tracked);
      expect(await command(['legacy-icon', 'before-update-0.1.1', binaryRoot, `${REAL.localAppData}\\ETS2TelemetryDesktop`], '0.1.0', null)).toMatchObject({passed: true});
      const planted = await readFile(path.join(binaryRoot, 'app.ico'));
      expect(planted.equals(tracked)).toBe(false);
      expect([planted.readUInt16LE(0), planted.readUInt16LE(2), planted.readUInt16LE(4)]).toEqual([0, 1, 1]);
      const text = await readFile(path.join(evidence, 'legacy-icon-before-update-0.1.1.json'), 'utf8');
      assertClean(text);
      expect((JSON.parse(text) as {result: unknown}).result).toEqual({legacySha256: hash(planted), replacedExisting: true, ownsRegistration: [true, false]});
      expect(await command(['legacy-icon', 'other', '-', '-'], '0.1.0', null)).toMatchObject({passed: true});
      expect((JSON.parse(await readFile(path.join(evidence, 'legacy-icon-other.json'), 'utf8')) as {result: {ownsRegistration: boolean[]}}).result.ownsRegistration)
        .toEqual([false, false]);
      // A registration outside R refuses before anything is written.
      await rm(path.join(binaryRoot, 'app.ico'));
      const outside = await new Promise<{passed: boolean; failure: {code?: string} | null}>((resolve, reject) => {
        const registration = {installLocation: `${REAL.localAppData}\\ETS2TelemetryDesktop`, displayVersion: '0.1.0', uninstallString: null, displayIcon: null};
        execFile(process.execPath, [path.resolve('scripts/installer/installer-lifecycle.mjs'), 'legacy-icon', path.join(evidence, 'config.json'), 'refused', '-', '-'],
          {env: {...process.env, [FACTS_VARIABLE]: JSON.stringify({...machine, registration, realBinaryRootExists: false})}, encoding: 'utf8', timeout: 30000, windowsHide: true},
          (_error, stdout) => {try {resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1)!) as {passed: boolean; failure: {code?: string} | null});} catch {reject(new Error('DRIVER_OUTPUT_INVALID'));}});
      });
      expect(outside).toMatchObject({passed: false, failure: {code: 'INSTALL_OUTSIDE_RUN_ROOT'}});
      expect(await readdir(binaryRoot)).toEqual([]);
      expect(runRoot).toContain(`installer-${ID}`);
    } finally {await resources.dispose();}
  }, 60000);
  it('never writes the facts to a file in the harness', async () => {
    const harness = await readFile(path.resolve('scripts/installer/Invoke-InstallerLifecycle.ps1'), 'utf8');
    expect(harness).not.toMatch(/facts\.json|factsFile/i);
    expect(harness).toContain('$env:ETS2TELEMETRY_INSTALLER_FACTS = Get-FactJson');
    expect(harness).toContain('Remove-Item Env:ETS2TELEMETRY_INSTALLER_FACTS');
    expect(FACTS_VARIABLE).toBe('ETS2TELEMETRY_INSTALLER_FACTS');
  });
});

// ET-055 PR-5 (REG-017, REG-019): the names and versions of a lifecycle run come from the build channel.
describe('channel identities and versions of a lifecycle run (ET-055 PR-5)', () => {
  it('derives both channels\' names from the build identities, with no name shared', () => {
    expect(LIFECYCLE_IDENTITIES.map(identity => identity.channel)).toEqual(['production', 'staging']);
    expect(lifecycleIdentity('production')).toEqual({channel: 'production', productRoot: 'ETS2TelemetryDesktop', dataRoot: 'ETS2Telemetry', roamingRoot: 'ETS2Telemetry Desktop',
      executable: 'ETS2TelemetryDesktop.exe', displayName: 'Yukon Union Telemetry', publisher: 'Yukon Union Telemetry contributors', legacyDisplayNames: ['ETS2Telemetry Desktop'],
      appUserModelId: 'com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop', pluginFile: 'ets2telemetry-plugin.dll', runOnceValue: 'ETS2TelemetryUninstall',
      receiptPrefix: 'ETS2Telemetry-uninstall-', executorReceiptPrefix: 'ETS2Telemetry-deferred-cleanup-'});
    expect(lifecycleIdentity('staging')).toEqual({channel: 'staging', productRoot: 'ETS2TelemetryDesktopStaging', dataRoot: 'ETS2TelemetryStaging',
      roamingRoot: 'ETS2Telemetry Desktop Staging', executable: 'ETS2TelemetryDesktopStaging.exe', displayName: 'Yukon Union Telemetry Staging',
      publisher: 'Yukon Union Telemetry contributors', legacyDisplayNames: [], appUserModelId: 'com.squirrel.ETS2TelemetryDesktopStaging.ETS2TelemetryDesktopStaging',
      pluginFile: 'ets2telemetry-plugin-staging.dll', runOnceValue: 'ETS2TelemetryStagingUninstall', receiptPrefix: 'ETS2TelemetryStaging-uninstall-',
      executorReceiptPrefix: 'ETS2TelemetryStaging-deferred-cleanup-'});
    const [production, staging] = LIFECYCLE_IDENTITIES;
    for (const field of ['productRoot', 'dataRoot', 'roamingRoot', 'executable', 'displayName', 'appUserModelId', 'pluginFile', 'runOnceValue', 'receiptPrefix',
      'executorReceiptPrefix'] as const) expect(staging[field], field).not.toBe(production[field]);
    expect(refusal(() => lifecycleIdentity('Production'))).toBe('LIFECYCLE_CHANNEL_UNKNOWN');
  });
  it('raises B\'s patch number above A in both channels and names the installed NuGet versions', () => {
    expect(lifecycleVersions('production', '0.1.0')).toEqual({channel: 'production', appVersion: '0.1.0', a: {package: '0.1.0', installed: '0.1.0'},
      b: {package: '0.1.1', installed: '0.1.1'}});
    expect(lifecycleVersions('staging', '0.1.0-stg.000042')).toEqual({channel: 'staging', appVersion: '0.1.0-stg.000042', a: {package: '0.1.0-stg.000042',
      installed: '0.1.0-stg000042'}, b: {package: '0.1.1-stg.000042', installed: '0.1.1-stg000042'}});
    expect(lifecycleVersions('production', '1.2.9').b.installed).toBe('1.2.10');
  });
  // ET-055 PR-8: the update-from-feed scenario's C, two patch numbers above A, and B and A from the same rule.
  it('derives fixture C two patch numbers above the build and refuses another step', () => {
    expect(lifecycleFixtureVersion('production', '0.1.0', 2)).toEqual({package: '0.1.2', installed: '0.1.2'});
    expect(lifecycleFixtureVersion('staging', '0.1.0-stg.000042', 2)).toEqual({package: '0.1.2-stg.000042', installed: '0.1.2-stg000042'});
    expect(lifecycleFixtureVersion('staging', '0.1.0-stg.000042', 1)).toEqual(lifecycleVersions('staging', '0.1.0-stg.000042').b);
    expect(lifecycleFixtureVersion('production', '0.1.0', 0)).toEqual(lifecycleVersions('production', '0.1.0').a);
    for (const step of [3, -1, 1.5]) expect(refusal(() => lifecycleFixtureVersion('production', '0.1.0', step))).toBe('LIFECYCLE_VERSION_INVALID');
    expect(refusal(() => lifecycleFixtureVersion('production', '0.1.0-stg.000000', 2))).toBe('LIFECYCLE_VERSION_INVALID');
  });
  it.each([['production', '0.1.0-stg.000000'], ['staging', '0.1.0'], ['staging', '0.1.0-stg.42'], ['production', '0.1.0-alpha.1'], ['beta', '0.1.0'], ['production', undefined]])(
    'refuses the version of channel %s: %s', (channel, version) => expect(refusal(() => lifecycleVersions(channel, version as string))).toBe('LIFECYCLE_VERSION_INVALID'));
  it('refuses the product executable of either channel in the residue', () => {
    const runtime = electronRuntimeNames([{name: 'ETS2TelemetryDesktopStaging.exe', directory: false}, {name: 'resources.pak', directory: false}], []);
    expect([...runtime.files]).toEqual(['resources.pak']);
    const base = [{relative: 'app-0.1.0-stg000000', kind: 'directory' as const, reparse: false}, {relative: '.dead', kind: 'file' as const, reparse: false, deadMarker: true}];
    expect(refusal(() => checkUninstallResidue([...base, {relative: 'app-0.1.0-stg000000/ETS2TelemetryDesktopStaging.exe', kind: 'file', reparse: false}], runtime)))
      .toBe('UNINSTALL_UNEXPECTED_FILE');
  });
  it('compares the other channel\'s state key by key and names the first change', () => {
    const before = {dataRoot: {'data\\': {directory: true}}, plugin: {sha256: 'a'.repeat(64), size: 3, mtimeMs: 1}, runOnce: null};
    expect(checkOtherChannelUnchanged(before, JSON.parse(JSON.stringify(before)))).toBe(3);
    expect(refusal(() => checkOtherChannelUnchanged(before, {...before, plugin: {...before.plugin, mtimeMs: 2}}))).toBe('OTHER_CHANNEL_CHANGED');
    expect(refusal(() => checkOtherChannelUnchanged(before, {...before, runOnce: 'b'.repeat(64)}))).toBe('OTHER_CHANNEL_CHANGED');
    expect(refusal(() => checkOtherChannelUnchanged(before, {dataRoot: before.dataRoot, plugin: before.plugin}))).toBe('OTHER_CHANNEL_STATE_KEYS_DIFFER');
    expect(refusal(() => checkOtherChannelUnchanged({}, {}))).toBe('OTHER_CHANNEL_STATE_INVALID');
    expect(refusal(() => checkOtherChannelUnchanged(null, before))).toBe('OTHER_CHANNEL_STATE_INVALID');
    try {checkOtherChannelUnchanged(before, {...before, runOnce: 'x'});} catch (error) {expect((error as Error).message).toBe('Installer lifecycle refused: OTHER_CHANNEL_CHANGED (runOnce)');}
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

// ET-045h fix round 1 (REG-013, REG-017): the hosted run 40134013831 failed right after links-install-0.1.0, because
// Assert-ProductLinks called `Split-Path -LiteralPath ... -Parent`, which no parameter set accepts; `-Plan` never runs the
// helpers. tests/windows/Test-InstallerLinkHelpers.ps1 loads the harness's shortcut helpers from its AST and runs them
// against fake Desktop and Start menu folders in a temporary folder, with Invoke-Driver replaced by a recorder, under
// Windows PowerShell 5.1 and, where installed (the hosted runner), PowerShell 7. No installer, registry write or real
// folder is used; Read-UninstallEntries only reads HKCU and finds nothing for a run root in the temporary folder.
describe('harness shortcut helpers at runtime (ET-045h)', () => {
  const checkout = fileURLToPath(new URL('../..', import.meta.url));
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pwsh = (process.env.PATH ?? '').split(path.delimiter).map(folder => path.join(folder, 'pwsh.exe')).find(file => existsSync(file));
  const shells: [string, string][] = [['Windows PowerShell 5.1', path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]];
  if (pwsh) shells.push(['PowerShell 7', pwsh]);
  // Windows PowerShell 5.1 started from PowerShell 7 (the hosted step's shell) inherits PS7's PSModulePath and then cannot
  // load its own Microsoft.PowerShell.Utility (Get-FileHash). 5.1 therefore gets an empty PSModulePath, under every spelling
  // of the name, so it computes its default module path, as tests/shared/runtime-receipt-validator.ts does.
  const environment = (shell: string) => shell === pwsh ? process.env
    : {...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')), PSModulePath: ''};
  // The temporary folder can be named in 8.3 form (C:\Users\RUNNER~1) while the helpers report long names, so the shortcut
  // folders are compared as real paths.
  const real = (file: unknown) => typeof file === 'string' ? realpathSync.native(file) : file;
  it.each(shells)('runs the shortcut helpers under %s', async (_name, shell) => {
    const resources = await temporaryResources();
    try {
      const root = path.join(resources.directory, 'helpers');
      await mkdir(root);
      const {stdout} = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(checkout, 'tests', 'windows', 'Test-InstallerLinkHelpers.ps1'), '-Harness', path.join(checkout, 'scripts', 'installer', 'Invoke-InstallerLifecycle.ps1'),
        '-Root', root], {encoding: 'utf8', timeout: 60000, windowsHide: true, env: environment(shell)});
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>;
      const folders = result.linkFolders as {desktop?: unknown; startMenu?: unknown} | undefined;
      expect({desktop: real(folders?.desktop), startMenu: real(folders?.startMenu)})
        .toEqual({desktop: real(path.join(root, 'Desktop')), startMenu: real(path.join(root, 'Programs', 'Artur Sianiuk'))});
      expect(result).toMatchObject({
        rowsInstalled: ['desktop||Yukon Union Telemetry', 'start-menu|Artur Sianiuk|Yukon Union Telemetry'],
        linksCall: {command: 'links', arguments: ['install-0.1.0', 'installed', 'desktop||Yukon Union Telemetry', 'start-menu|Artur Sianiuk|Yukon Union Telemetry'],
          timeoutMs: 30000},
        rowsWithOrphans: ['desktop||ETS2Telemetry Desktop', 'desktop||Yukon Union Telemetry', 'start-menu|Artur Sianiuk|ETS2Telemetry Desktop',
          'start-menu|Artur Sianiuk|Yukon Union Telemetry'],
        plantExists: 'PLANT_TARGET_EXISTS before again',
        notRemoved: 'LEGACY_SHORTCUT_NOT_REMOVED after install-again-0.1.0',
        orphansRemoved: 'ACCEPTED', plantedAfterAssert: 0,
        decoyKept: 'ACCEPTED', decoyDeleted: true, decoyChanged: 'FOREIGN_SHORTCUT_CHANGED after decoy',
        cleanupRemovedPlanted: true, cleanupKeptChanged: true, cleanupFailure: null,
        hostedOnly: 'LEGACY_NAMES_HOSTED_ONLY before local',
        uninstallEntries: [],
        steps: ['shortcuts-install-0.1.0', 'legacy-names-before-install-again-0.1.0', 'legacy-names-install-again-0.1.0', 'legacy-names-decoy',
          'legacy-names-before-complete-running']
      });
    } finally {await resources.dispose();}
  }, 90000);
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
  // ET-045g: the harness's registry value writes are the legacy DisplayIcon, after the driver's legacy-icon decision, and
  // (ET-045h) the old DisplayName and Publisher, after the driver's legacy-names decision.
  // ET-055 PR-5: and the planted autostart values of the side-by-side scenario, on a hosted runner only.
  it('writes a registry value only in Set-LegacyIcon, Set-LegacyNames and Set-PlantedRunValue, and only to views the driver says point into R', async () => {
    const harness = await read('scripts/installer/Invoke-InstallerLifecycle.ps1');
    const writes = [...harness.matchAll(/\.SetValue\(/g)];
    expect(writes).toHaveLength(4);
    const run = harness.slice(harness.indexOf('function Set-PlantedRunValue'), harness.indexOf('\n}', harness.indexOf('function Set-PlantedRunValue')));
    expect([...run.matchAll(/\.SetValue\(/g)]).toHaveLength(1);
    expect(run).toContain("if (!$hosted -or $Scenario -ne 'side-by-side') { throw ('RUN_VALUE_PLANT_HOSTED_ONLY for ' + $Channel) }");
    expect(run).toContain("if ($null -ne (Get-RunValue $Channel)) { throw ('RUN_VALUE_EXISTS for ' + $Channel) }");
    const names = harness.slice(harness.indexOf('function Set-LegacyNames'), harness.indexOf('\n}', harness.indexOf('function Set-LegacyNames')));
    expect([...names.matchAll(/\.SetValue\(/g)]).toHaveLength(2);
    expect(names.indexOf("Invoke-Driver 'legacy-names'")).toBeGreaterThan(-1);
    expect(names.indexOf("Invoke-Driver 'legacy-names'")).toBeLessThan(names.indexOf('.SetValue('));
    expect(names).toContain('if ($owned[$index] -ne $true) { continue }');
    expect(names).toContain("if (!$hosted) { throw ('LEGACY_NAMES_HOSTED_ONLY before ' + $Label) }");
    const body = harness.slice(harness.indexOf('function Set-LegacyIcon'), harness.indexOf('\n}', harness.indexOf('function Set-LegacyIcon')));
    expect(body).toContain('.SetValue(');
    expect(body.indexOf("Invoke-Driver 'legacy-icon'")).toBeGreaterThan(-1);
    expect(body.indexOf("Invoke-Driver 'legacy-icon'")).toBeLessThan(body.indexOf('.SetValue('));
    expect(body).toContain('if ($owned[$index] -ne $true) { continue }');
    expect(harness).toContain("Set-LegacyIcon 'before-update-0.1.1'");
  });
  // ET-055 PR-8: the update-from-feed commands run the application through a whole update under RunExtended (same Job
  // limits); each call gives a literal deadline above Run's cap and at most 300 s, and the driver's own budget for that
  // mode ends at least 30 s before it, so the command records its evidence before the Job ends it.
  it('passes every Invoke-DriverExtended call a literal RunExtended deadline above the driver\'s own budget', async () => {
    const cap = await jobCap();
    const harness = await read('scripts/installer/Invoke-InstallerLifecycle.ps1');
    expect(/if \(timeoutMs<60001 \|\| timeoutMs>6000000\) throw/.test(await read('scripts/watchdog/BoundedProcess.cs'))).toBe(true);
    const calls = harness.split(/\r?\n/).filter(line => /\bInvoke-DriverExtended\s+'/.test(line) && !/^\s*function\s/.test(line))
      .map(line => /Invoke-DriverExtended 'update-feed' @\('[a-z0-9.-]+', \$[A-Za-z]+, '(complete|interrupted)'\) (\d+)\s*$/.exec(line.trim()));
    expect(calls.map(call => call && [call[1], Number(call[2])])).toEqual([['complete', 240000], ['interrupted', 300000]]);
    const driver = await read('scripts/installer/installer-lifecycle.mjs');
    const budgets = /UPDATE_FEED_BUDGET_MS = Object\.freeze\(\{complete: (\d+), interrupted: (\d+)\}\)/.exec(driver);
    expect(budgets).not.toBeNull();
    for (const call of calls) {
      expect(Number(call![2])).toBeGreaterThan(cap);
      expect(Number(call![2])).toBeLessThanOrEqual(300000);
      expect(Number(call![2]) - Number(budgets![call![1] === 'complete' ? 1 : 2])).toBeGreaterThanOrEqual(30000);
    }
    expect(harness).toContain("if ($TimeoutMs -le 60000 -or $TimeoutMs -gt 300000) { throw ('EXTENDED_TIMEOUT_INVALID: ' + $Command) }");
    // The scenario refuses every run that is not on a GitHub-hosted runner, before any install.
    expect(harness.indexOf("throw 'UPDATE_FROM_FEED_HOSTED_ONLY:")).toBeGreaterThan(-1);
    expect(harness.indexOf("throw 'UPDATE_FROM_FEED_HOSTED_ONLY:")).toBeLessThan(harness.indexOf('function Invoke-Driver('));
  });
  it('keeps the in-app uninstall run\'s own budget below the cap', async () => {
    const cap = await jobCap();
    const budget = Number(/const APP_UNINSTALL_RUN_BUDGET_MS = (\d+);/.exec(await read('scripts/installer/installer-lifecycle.mjs'))?.[1]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(cap - 5000);
  });
});
