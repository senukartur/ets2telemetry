export interface ProbeWorker {
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): Promise<void>;
}

export interface ProbeDependencies {
  createDirectory(): Promise<string>;
  createWorker(directory: string): ProbeWorker;
  removeDirectory(directory: string): Promise<void>;
  report(message: {type: 'ready' | 'failed' | 'stopped'; code?: string}): void;
  diagnose?(event: string, detail?: unknown): void;
}

// The scaffold owns only a temporary SQLite probe. Production recording is a later task.
export class ServiceProbe {
  private initialization: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private directory: string | undefined;
  private worker: ProbeWorker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private settled = false;
  private failed = false;

  constructor(private readonly dependencies: ProbeDependencies) {}

  start(): Promise<void> {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    this.shutdown ??= this.dispose();
    return this.shutdown;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fail(code: string, error?: unknown): void {
    if (this.stopping || this.failed) return;
    this.failed = true;
    this.settled = true;
    this.clearTimer();
    this.dependencies.diagnose?.(code, error);
    this.dependencies.report({type: 'failed', code});
    void this.stop();
  }

  private async initialize(): Promise<void> {
    if (this.stopping) return;
    try {
      this.directory = await this.dependencies.createDirectory();
      this.dependencies.diagnose?.('PROBE_DIRECTORY_CREATED');
      // Shutdown waits for this initialization before removing its directory.
      if (this.stopping) return;
      this.worker = this.dependencies.createWorker(this.directory);
      this.dependencies.diagnose?.('STORAGE_WORKER_CREATED');
      this.timer = setTimeout(() => this.fail('STORAGE_TIMEOUT'), 10000);
      this.worker.onMessage(message => {
        if (this.stopping || this.settled) return;
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'verified') {
          this.fail('STORAGE_PROBE_FAILED', message);
          return;
        }
        this.settled = true;
        this.clearTimer();
        this.dependencies.diagnose?.('STORAGE_VERIFIED');
        this.dependencies.report({type: 'ready'});
      });
      this.worker.onError(error => this.fail('STORAGE_WORKER_FAILED', error));
      this.worker.onExit(code => {if (!this.settled || code !== 0) this.fail('STORAGE_WORKER_EXIT', {code});});
    } catch (error) {
      this.fail('SERVICE_START_FAILED', error);
    }
  }

  private async dispose(): Promise<void> {
    try {
      await this.initialization;
      if (this.worker) await this.worker.terminate();
      if (this.directory) await this.dependencies.removeDirectory(this.directory);
      this.dependencies.report({type: 'stopped'});
    } catch (error) {
      this.dependencies.diagnose?.('SERVICE_STOP_FAILED', error);
      this.dependencies.report({type: 'failed', code: 'SERVICE_STOP_FAILED'});
    }
  }
}
