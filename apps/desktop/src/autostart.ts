import path from 'node:path';
import type {AutostartRegistrationStatus} from '../../../packages/contracts/src';
import type {UninstallRoots} from './uninstall/roots';

// Start with Windows login item registration (ET-031; docs/app-lifecycle.md).
// Encapsulates target resolution, live status queries, registration and uninstall deregistration.

export interface LoginItemOptions {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

export interface LoginItemStatus {
  openAtLogin: boolean;
  executableWillLaunchAtLogin?: boolean;
}

export interface LoginItemPorts {
  getLoginItemSettings(options?: {path?: string; args?: string[]}): LoginItemStatus;
  setLoginItemSettings(settings: LoginItemOptions): void;
}

export interface AutostartTarget {
  readonly path: string;
  readonly args: readonly string[];
}

/**
 * Resolves the login item target from uninstall roots.
 * Returns undefined when roots are not an installed Squirrel deployment ('production' or 'test-root').
 */
export function resolveAutostartTarget(roots: UninstallRoots, executable: string): AutostartTarget | undefined {
  if (!roots.ok) return undefined;
  if (roots.mode !== 'production' && roots.mode !== 'test-root') return undefined;
  const exeName = path.win32.basename(executable);
  return {
    path: path.win32.join(roots.installRoot, 'Update.exe'),
    args: ['--processStart', `"${exeName}"`, '--process-start-args', '"--hidden"']
  };
}

/**
 * Queries the current login item registration status.
 * If target is undefined (unpackaged or portable), returns 'not-installed'.
 */
export function queryAutostartStatus(
  ports: LoginItemPorts,
  target: AutostartTarget | undefined
): AutostartRegistrationStatus {
  if (!target) return 'not-installed';
  try {
    const status = ports.getLoginItemSettings({path: target.path, args: [...target.args]});
    if (status.openAtLogin && status.executableWillLaunchAtLogin !== false) {
      return 'registered';
    }
    return 'unregistered';
  } catch {
    return 'failed';
  }
}

/**
 * Applies the desired autostart setting via login item ports.
 * Returns the resulting registration status.
 */
export function applyAutostartRegistration(
  ports: LoginItemPorts,
  target: AutostartTarget | undefined,
  enabled: boolean
): AutostartRegistrationStatus {
  if (!target) return 'not-installed';
  try {
    ports.setLoginItemSettings({
      openAtLogin: enabled,
      path: target.path,
      args: [...target.args]
    });
    const status = ports.getLoginItemSettings({path: target.path, args: [...target.args]});
    if (enabled) {
      if (status.openAtLogin && status.executableWillLaunchAtLogin === false) {
        return 'unregistered';
      }
      return status.openAtLogin ? 'registered' : 'failed';
    }
    return status.openAtLogin ? 'failed' : 'unregistered';
  } catch {
    return 'failed';
  }
}

/**
 * Deregisters the login item during Windows or in-app uninstall.
 */
export function removeAutostartLoginItem(
  ports: LoginItemPorts,
  installRoot: string,
  executableName: string
): boolean {
  try {
    ports.setLoginItemSettings({
      openAtLogin: false,
      path: path.win32.join(installRoot, 'Update.exe'),
      args: ['--processStart', `"${executableName}"`, '--process-start-args', '"--hidden"']
    });
    return true;
  } catch {
    return false;
  }
}
