export const RUN_ROOT_NAME: RegExp;
export const PLUGIN_TEST_ROOT_MARKER: string;
export const INSTALL_TEST_FILE: string;
export const INSTALL_TEST_FORMAT: string;
export const INSTALL_TEST_VERSION: number;
export const RUN_ONCE_KEY: RegExp;
export const PRODUCT_ROOT: string;
export const DATA_ROOT: string;
export const ROAMING_ROOT: string;

export class InstallerGuardError extends Error {
  constructor(code: string);
  readonly code: string;
}
export interface KnownFolders {localAppData: string; roamingAppData: string}
export interface InstallTest {format: string; version: number; profileDir: string; runOnceKey: string | null; shortcuts: boolean}
export interface RunLayout {
  runRoot: string; base: string; dataRoot: string; binaryRoot: string; squirrelTemp: string; temp: string; appData: string; profile: string;
  cwd: string; diagnostics: string; exports: string; fixture: string; pluginMarker: string; installTest: string;
}
export interface RunPlanFacts {
  runRoot: string;
  real: KnownFolders;
  steamLibraries?: string[];
  paths?: string[];
  decoy?: string;
  resolved: Record<string, string>;
  realBinaryRootExists: boolean;
  registrationExists: boolean;
  processes: string[];
  steamLibrariesUnreadable?: boolean;
  markers: {pluginMarker: boolean; installTest: unknown} | null;
}
export interface InstalledFacts {
  runRoot: string;
  installLocation: unknown;
  binaryRoot: string;
  resolvedInstallLocation: string | null;
  resolvedBinaryRoot: string;
  realBinaryRootExists: boolean;
}

export function isDrivePath(value: unknown): value is string;
export function normalizePath(value: string): string;
export function isInside(candidate: string, parent: string): boolean;
export function checkRunSignal(env: Readonly<Record<string, string | undefined>>, options?: {allowLocal?: boolean}): void;
export function isHostedRunner(env: Readonly<Record<string, string | undefined>>): boolean;
export const RESIDUE_MAX_ENTRIES: number;
export interface ElectronRuntimeNames {readonly files: ReadonlySet<string>; readonly locales: ReadonlySet<string>}
export function electronRuntimeNames(entries: readonly {name: string; directory: boolean}[], locales: readonly string[]): ElectronRuntimeNames;
export interface ResidueRow {relative: string; kind: 'file' | 'directory'; reparse: boolean; bytes?: number; vendorHelper?: boolean; deadMarker?: boolean}
export function checkUninstallResidue(listing: readonly ResidueRow[], runtime: ElectronRuntimeNames): {vendorFiles: number; tolerated: string[]};
export const DECOY_OS_FOLDER: string;
export type DecoyTree = Readonly<Record<string, {readonly directory?: boolean; readonly size?: number; readonly sha256?: string}>>;
export function checkDecoyUnchanged(before: DecoyTree, after: DecoyTree): number;
export const DATA_ROOT_REQUIRED: readonly string[];
export function checkDataRootUnchanged(before: DecoyTree, after: DecoyTree): number;
export function parseUninstallString(value: unknown, runRoot: string): {program: string; args: string[]};
export function uninstallEnvironment(base: Readonly<Record<string, string | undefined>>, options: {runRoot: string; real: {localAppData: string}; decoy: string}): Record<string, string>;
export function runLayout(runRoot: string): RunLayout;
export function protectedRoots(real: KnownFolders, steamLibraries?: string[]): {real: string[]; steam: string[]};
export function resolveRealLocation(target: string, realpath: (path: string) => Promise<string>): Promise<string>;
export function steamLibraryPaths(vdf: unknown): string[];
export function isGuardedProcess(name: string): boolean;
export function checkInstallTest(document: unknown, runRoot: string): void;
export function checkRunPlan(facts: RunPlanFacts): string[];
export function checkedPaths(facts: {runRoot: string; paths?: string[]; decoy?: string}): string[];
export function checkInstalled(facts: InstalledFacts): void;
export const PRODUCT_EXECUTABLE: string;
export const ROOT_ICON_FILE: string;
export type RegistrationIconShape = 'root-app-ico' | 'app-exe-index-0' | 'absent' | 'other';
export function classifyRegistrationIcon(facts: {displayIcon: unknown; binaryRoot: string; version: string}): {shape: RegistrationIconShape; versionMatches: boolean | null};
export interface IconFileObservation {regularFile: boolean; sha256: string | null}
export interface RegistrationIconObservation {
  displayIcon: {shape: RegistrationIconShape; versionMatches: boolean | null};
  rootIcon: IconFileObservation;
  bundledIcon: IconFileObservation;
  trackedSha256: string;
}
export function checkRegistrationIcon(observation: RegistrationIconObservation): void;
export function minimalPath(systemRoot: string | undefined): string;
export function installedEnvironment(base: Readonly<Record<string, string | undefined>>, overrides: Record<string, string>): Record<string, string>;
export function checkLaunchEnvironment(env: Readonly<Record<string, string | undefined>>, context: {runRoot: string; real: KnownFolders}): void;
export const FACTS_VARIABLE: string;
export interface FactsEvidence {
  knownFoldersResolved: boolean; realBinaryRootExists: boolean; registrationExists: boolean;
  registration: {displayVersion: string | null; installLocationInsideRunRoot: boolean} | null;
  steamPathPresent: boolean; steamLibraries: number; steamLibrariesUnreadable: boolean; processesListed: number | null; guardedProcesses: string[] | null;
}
export function factsEvidence(facts: unknown, runRoot: string): FactsEvidence;
export function ownsRegistration(runRoot: string, installLocation: string): boolean;
export const PRODUCT_DISPLAY_NAME: 'Yukon Union Telemetry';
export const PRODUCT_PUBLISHER: 'Yukon Union Telemetry contributors';
export const LEGACY_DISPLAY_NAME: 'ETS2Telemetry Desktop';
export const SHORTCUT_COMPANY: 'Artur Sianiuk';
export const SHORTCUT_LOCATIONS: readonly ['desktop', 'start-menu'];
export interface ProductLinkCounts {current: number; legacy: number; other: number; currentFolders: string[]}
export interface ProductLinkClassification {total: number; desktop: ProductLinkCounts; 'start-menu': ProductLinkCounts}
export function classifyProductLinks(rows: readonly string[]): ProductLinkClassification;
export function checkProductLinks(classification: ProductLinkClassification, expectation: 'installed' | 'none'): void;
export interface UninstallEntryRow {view: string; name: string; installLocation: string | null}
export function checkUninstallEntries(rows: readonly UninstallEntryRow[], runRoot: string): {views: number; names: string[]};
export function checkRegistrationNames(registration: {displayName?: unknown; publisher?: unknown} | null | undefined): {displayName: string; publisher: string};
