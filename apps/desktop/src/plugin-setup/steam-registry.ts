import path from 'node:path';
import {canonicalDirectory, nodePluginFs, type PluginReadFileSystem, type SteamRootResult} from './steam-discovery';
import {nodeExecFile, runFixedProgram, systemRoot, type ExecFilePort} from './fixed-program';

// Reads where Steam is installed (ET-017 P1; docs/plugin-setup.md, "Steam root"). One fixed Windows PowerShell call
// reads exactly two registry values, HKCU\Software\Valve\Steam\SteamPath and, as the fallback,
// HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath, and prints them as base64 UTF-8 inside JSON so the console code
// page cannot change a non-ASCII path. reg.exe is not used: it prints in the OEM code page.
//
// The script uses .NET calls and string concatenation only, no cmdlet, so it never autoloads a module. The child also
// gets only Windows PowerShell's own module folder in PSModulePath: a pwsh 7 parent (such as the CI tests job) exports
// module folders whose modules Windows PowerShell 5.1 cannot load.

export const STEAM_USER_KEY = 'HKEY_CURRENT_USER\\Software\\Valve\\Steam';
export const STEAM_MACHINE_KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam';
export const STEAM_REGISTRY_TIMEOUT_MS = 5000;
export const STEAM_REGISTRY_MAX_OUTPUT_BYTES = 16 * 1024;
/** Longest decoded registry value accepted, in UTF-8 bytes. */
const MAX_VALUE_BYTES = 4096;
/**
 * Keys tests may point the fixed script at instead of Valve's: a per-run key under HKCU\Software, optionally with one
 * plain subkey standing in for the machine-wide key. Nothing else is accepted, so the script never reads another key.
 */
const TEST_KEY = /^HKEY_CURRENT_USER\\Software\\ETS2Telemetry-Test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\[A-Za-z0-9]{1,32})?$/;

export interface SteamRegistryKeys {readonly user: string; readonly machine: string}

/** The fixed script text; only the two key names vary, and only between Valve's keys and validated test keys. */
export function steamRegistryScript(keys?: SteamRegistryKeys): string {
  const user = keys?.user ?? STEAM_USER_KEY, machine = keys?.machine ?? STEAM_MACHINE_KEY;
  if (keys && (!TEST_KEY.test(user) || !TEST_KEY.test(machine))) throw new Error('Steam registry test keys rejected');
  return [
    "$ErrorActionPreference = 'Stop'",
    // Base64 needs no JSON escaping, so the output is built as text: a quoted base64 value or null. Each value is read
    // on its own, so an unreadable machine-wide key never loses a readable SteamPath, and the reverse.
    'function Read-Value([string]$Key, [string]$Name) {',
    "  try { $value = [Microsoft.Win32.Registry]::GetValue($Key, $Name, $null) } catch { return 'null' }",
    `  if ($value -is [string]) { '"' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) + '"' } else { 'null' }`,
    '}',
    `[Console]::Out.Write('{"steamPath":' + (Read-Value '${user}' 'SteamPath') + ',"installPath":' + (Read-Value '${machine}' 'InstallPath') + '}')`
  ].join('\n');
}

/** The absolute path of Windows PowerShell 5.1. */
export function powershellPath(env: Readonly<Record<string, string | undefined>>): string {
  return path.win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The child's environment: the parent's, with PSModulePath (in any letter case) replaced by Windows PowerShell's own
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`.
 */
export function windowsPowerShellEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const child = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  child.PSModulePath = path.win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return child;
}

export type SteamRegistryValues = {readonly ok: true; readonly steamPath: string | null; readonly installPath: string | null} | {readonly ok: false; readonly code: SteamRegistryErrorCode};
export type SteamRegistryErrorCode = 'STEAM_REGISTRY_TIMEOUT' | 'STEAM_REGISTRY_OUTPUT_TOO_LARGE' | 'STEAM_REGISTRY_OUTPUT_INVALID' | 'STEAM_REGISTRY_FAILED' | 'STEAM_REGISTRY_ABORTED';

const decoder = new TextDecoder('utf-8', {fatal: true});
function decodeValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_VALUE_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  // A canonical encoding round-trips exactly; anything else was not produced by the fixed script.
  if (bytes.toString('base64') !== value || bytes.length > MAX_VALUE_BYTES) return undefined;
  try {return decoder.decode(bytes);} catch {return undefined;}
}

/** Parses the script's output: exactly `{"steamPath": <base64>|null, "installPath": <base64>|null}`. */
export function parseSteamRegistryOutput(stdout: Buffer): SteamRegistryValues {
  let parsed: unknown;
  try {parsed = JSON.parse(stdout.toString('utf8').trim());} catch {return {ok: false, code: 'STEAM_REGISTRY_OUTPUT_INVALID'};}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok: false, code: 'STEAM_REGISTRY_OUTPUT_INVALID'};
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'installPath,steamPath') return {ok: false, code: 'STEAM_REGISTRY_OUTPUT_INVALID'};
  const steamPath = decodeValue(record.steamPath), installPath = decodeValue(record.installPath);
  if (steamPath === undefined || installPath === undefined) return {ok: false, code: 'STEAM_REGISTRY_OUTPUT_INVALID'};
  return {ok: true, steamPath, installPath};
}

export interface SteamRegistryOptions {
  execFile?: ExecFilePort;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  /** Tests only: a per-run HKCU key instead of Valve's keys. Production never passes it. */
  testKeys?: SteamRegistryKeys;
}

/** Runs the fixed script once and returns the two raw values. */
export async function readSteamRegistryValues(options: SteamRegistryOptions = {}): Promise<SteamRegistryValues> {
  const env = options.env ?? process.env;
  const result = await runFixedProgram(options.execFile ?? nodeExecFile, powershellPath(env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', steamRegistryScript(options.testKeys)],
    {timeoutMs: STEAM_REGISTRY_TIMEOUT_MS, maxOutputBytes: STEAM_REGISTRY_MAX_OUTPUT_BYTES, signal: options.signal,
      env: windowsPowerShellEnvironment(env)});
  if (!result.ok) {
    return {ok: false, code: result.failure === 'timeout' ? 'STEAM_REGISTRY_TIMEOUT' : result.failure === 'output-too-large' ? 'STEAM_REGISTRY_OUTPUT_TOO_LARGE'
      : result.failure === 'aborted' ? 'STEAM_REGISTRY_ABORTED' : 'STEAM_REGISTRY_FAILED'};
  }
  return parseSteamRegistryOutput(result.stdout);
}

/**
 * The canonical Steam root: SteamPath when it names an existing local folder, otherwise InstallPath. Both are
 * normalized with path.win32 and resolved through realpath; UNC, device and missing paths are not used.
 */
export async function readSteamRoot(options: SteamRegistryOptions & {fs?: PluginReadFileSystem} = {}): Promise<SteamRootResult> {
  const values = await readSteamRegistryValues(options);
  if (!values.ok) return {kind: 'failed', code: values.code};
  const fs = options.fs ?? nodePluginFs;
  for (const candidate of [values.steamPath, values.installPath]) {
    if (candidate === null) continue;
    const root = await canonicalDirectory(fs, candidate);
    if (root) return {kind: 'found', path: root.path};
  }
  return {kind: 'not-found'};
}
