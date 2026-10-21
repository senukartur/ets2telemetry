import {describe, expect, it, vi} from 'vitest';
import {
  applyAutostartRegistration,
  queryAutostartStatus,
  removeAutostartLoginItem,
  resolveAutostartTarget,
  type AutostartTarget,
  type LoginItemOptions,
  type LoginItemPorts
} from '../../apps/desktop/src/autostart';
import type {UninstallRoots} from '../../apps/desktop/src/uninstall/roots';

describe('autostart target resolution', () => {
  it('returns undefined when roots resolution is not ok (e.g. ROOT_MISMATCH)', () => {
    const roots: UninstallRoots = {ok: false, code: 'ROOT_MISMATCH'};
    expect(resolveAutostartTarget(roots, 'C:\\app\\ETS2TelemetryDesktop.exe')).toBeUndefined();
  });

  it('returns undefined when roots resolution is NOT_INSTALLED (portable/dev)', () => {
    const roots: UninstallRoots = {ok: false, code: 'NOT_INSTALLED'};
    expect(resolveAutostartTarget(roots, 'C:\\portable\\ETS2TelemetryDesktop.exe')).toBeUndefined();
  });

  it('resolves Update.exe and hidden start args for production installs', () => {
    const roots: UninstallRoots = {
      ok: true,
      mode: 'production',
      appDirectory: 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.1.0',
      installRoot: 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop',
      base: 'C:\\Users\\User\\AppData\\Local',
      dataRoot: 'C:\\Users\\User\\AppData\\Local\\ETS2Telemetry'
    };
    const executable = 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe';
    const target = resolveAutostartTarget(roots, executable);
    expect(target).toEqual({
      path: 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop\\Update.exe',
      args: ['--processStart', '"ETS2TelemetryDesktop.exe"', '--process-start-args', '"--hidden"']
    });
  });

  it('resolves Update.exe and hidden start args for test-root installs', () => {
    const roots: UninstallRoots = {
      ok: true,
      mode: 'test-root',
      appDirectory: 'D:\\temp\\LocalAppData\\ETS2TelemetryDesktop\\app-0.1.0',
      installRoot: 'D:\\temp\\LocalAppData\\ETS2TelemetryDesktop',
      base: 'D:\\temp\\LocalAppData',
      dataRoot: 'D:\\temp\\LocalAppData\\ETS2Telemetry',
      testRoot: 'D:\\temp',
      testFile: {profileDir: 'D:\\temp\\profile', runOnceKey: null, shortcuts: false}
    };
    const executable = 'D:\\temp\\LocalAppData\\ETS2TelemetryDesktop\\app-0.1.0\\ETS2TelemetryDesktop.exe';
    const target = resolveAutostartTarget(roots, executable);
    expect(target).toEqual({
      path: 'D:\\temp\\LocalAppData\\ETS2TelemetryDesktop\\Update.exe',
      args: ['--processStart', '"ETS2TelemetryDesktop.exe"', '--process-start-args', '"--hidden"']
    });
  });
});

describe('autostart query', () => {
  const target: AutostartTarget = {
    path: 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop\\Update.exe',
    args: ['--processStart', '"ETS2TelemetryDesktop.exe"', '--process-start-args', '"--hidden"']
  };

  it('returns not-installed when target is undefined', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn()
    };
    expect(queryAutostartStatus(ports, undefined)).toBe('not-installed');
    expect(ports.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it('returns registered when openAtLogin is true', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn().mockReturnValue({openAtLogin: true}),
      setLoginItemSettings: vi.fn()
    };
    expect(queryAutostartStatus(ports, target)).toBe('registered');
    expect(ports.getLoginItemSettings).toHaveBeenCalledWith({
      path: target.path,
      args: [...target.args]
    });
  });

  it('returns unregistered when openAtLogin is false', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn().mockReturnValue({openAtLogin: false}),
      setLoginItemSettings: vi.fn()
    };
    expect(queryAutostartStatus(ports, target)).toBe('unregistered');
  });

  it('returns failed when getLoginItemSettings throws', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn().mockImplementation(() => {
        throw new Error('API error');
      }),
      setLoginItemSettings: vi.fn()
    };
    expect(queryAutostartStatus(ports, target)).toBe('failed');
  });
});

describe('autostart apply registration', () => {
  const target: AutostartTarget = {
    path: 'C:\\Users\\User\\AppData\\Local\\ETS2TelemetryDesktop\\Update.exe',
    args: ['--processStart', '"ETS2TelemetryDesktop.exe"', '--process-start-args', '"--hidden"']
  };

  it('returns not-installed when target is undefined', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn()
    };
    expect(applyAutostartRegistration(ports, undefined, true)).toBe('not-installed');
    expect(ports.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('enables login item and returns registered', () => {
    let current = false;
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(() => ({openAtLogin: current})),
      setLoginItemSettings: vi.fn((opts: LoginItemOptions) => {
        current = opts.openAtLogin;
      })
    };
    expect(applyAutostartRegistration(ports, target, true)).toBe('registered');
    expect(ports.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: target.path,
      args: [...target.args]
    });
    expect(current).toBe(true);
  });

  it('disables login item and returns unregistered', () => {
    let current = true;
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(() => ({openAtLogin: current})),
      setLoginItemSettings: vi.fn((opts: LoginItemOptions) => {
        current = opts.openAtLogin;
      })
    };
    expect(applyAutostartRegistration(ports, target, false)).toBe('unregistered');
    expect(ports.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: target.path,
      args: [...target.args]
    });
    expect(current).toBe(false);
  });

  it('returns failed when setLoginItemSettings throws', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(() => ({openAtLogin: false})),
      setLoginItemSettings: vi.fn().mockImplementation(() => {
        throw new Error('OS error');
      })
    };
    expect(applyAutostartRegistration(ports, target, true)).toBe('failed');
  });

  it('returns failed when live status does not match requested state', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(() => ({openAtLogin: false})),
      setLoginItemSettings: vi.fn()
    };
    expect(applyAutostartRegistration(ports, target, true)).toBe('failed');
  });
});

describe('remove autostart login item', () => {
  it('calls setLoginItemSettings with openAtLogin: false and returns true', () => {
    const setLoginItemSettings = vi.fn();
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings
    };
    const ok = removeAutostartLoginItem(ports, 'C:\\InstallRoot', 'ETS2TelemetryDesktop.exe');
    expect(ok).toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'C:\\InstallRoot\\Update.exe',
      args: ['--processStart', '"ETS2TelemetryDesktop.exe"', '--process-start-args', '"--hidden"']
    });
  });

  it('catches exceptions and returns false', () => {
    const ports: LoginItemPorts = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn().mockImplementation(() => {
        throw new Error('Permission denied');
      })
    };
    const ok = removeAutostartLoginItem(ports, 'C:\\InstallRoot', 'ETS2TelemetryDesktop.exe');
    expect(ok).toBe(false);
  });
});
