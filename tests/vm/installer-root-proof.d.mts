export function validateRootSet(pids: unknown, consoleHost: unknown, driverPid: number, observerPid: number, controllerPid: number): number | null;
export function validateLateDriverConsole(frame: unknown, consoleHost: unknown, driverPid: number, observerPid: number, controllerPid: number): number;
export function validateStopSet(pids: unknown, consoleHost: unknown, lateFrame: unknown, driverPid: number, observerPid: number, controllerPid: number): number | null;
export function validateLateBinding(bound: unknown, current: unknown, consoleHost: unknown, driverPid: number, observerPid: number, controllerPid: number): void;
export function validateConsoleExit(receipt: unknown, consoleHost: unknown, driverPid: number, observerPid: number, controllerPid: number, lateFrame?: unknown): void;
export function validateFinalConsoleExit(receipt: unknown, lateFrame: unknown, consoleHost: unknown, driverPid: number, observerPid: number, controllerPid: number): void;
export function validateInstallerRoles(records: unknown, step: string, version: string, executable: string, selfUpdateExecutable: string): {hook: unknown; selfUpdates: unknown[]};
