import path from 'node:path';
import {CHANNEL} from './channel';

/**
 * Internal variable through which main hands the log root it resolved to the telemetry service it forks, so both
 * processes write under one root. Main always sets it in the service's environment and never reads it itself, so a
 * value in main's own launch environment has no effect.
 */
export const SERVICE_LOG_ROOT_VARIABLE = 'ETS2TELEMETRY_SERVICE_LOG_ROOT';

type Environment = Readonly<Record<string, string | undefined>>;

/** Where a process writes its startup diagnostics, and whether bounded error details are kept (diagnostic mode only). */
export interface LogLocation {readonly directory: string; readonly detailed: boolean}

/**
 * Main's log root: an explicit ETS2TELEMETRY_DIAGNOSTIC_DIR, which also turns detailed logs on; otherwise
 * %LOCALAPPDATA%\ETS2Telemetry\logs; without LOCALAPPDATA, <userData>\ETS2Telemetry\logs.
 */
export function mainLogLocation(env: Environment, userData: string): LogLocation {
  const diagnostic = env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  return {directory: diagnostic || path.join(env.LOCALAPPDATA || userData, CHANNEL.dataRootName, 'logs'), detailed: Boolean(diagnostic)};
}

/** The telemetry service's environment: main's own plus the log root main resolved. */
export function serviceEnvironment(env: Environment, logRoot: string): Record<string, string | undefined> {
  return {...env, [SERVICE_LOG_ROOT_VARIABLE]: logRoot};
}

/**
 * The service's log directory, the `service` subdirectory of the first of: the diagnostic override (detailed logs, the
 * same precedence as main); the absolute root main passed; for a service started without main,
 * %LOCALAPPDATA%\ETS2Telemetry\logs and then <temp>\ETS2Telemetry\logs.
 */
export function serviceLogLocation(env: Environment, temporary: string): LogLocation {
  const diagnostic = env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  const passed = env[SERVICE_LOG_ROOT_VARIABLE];
  const root = diagnostic || (passed && path.isAbsolute(passed) ? passed : path.join(env.LOCALAPPDATA || temporary, CHANNEL.dataRootName, 'logs'));
  return {directory: path.join(root, 'service'), detailed: Boolean(diagnostic)};
}
