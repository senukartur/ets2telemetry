import type {BuildChannel} from './build-channel.mjs';

export const EXECUTOR_FILE: 'Complete-ETS2TelemetryUninstall.ps1';
export const EXECUTOR_SOURCE: string;
export const EXECUTOR_STAGE: string;
export function stampExecutorChannel(text: string, channel: BuildChannel): string;
export function executorBytes(channel: BuildChannel, root?: string): Buffer;
export function stageUninstallExecutor(channel: BuildChannel, root?: string): Buffer;
