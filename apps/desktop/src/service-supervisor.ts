export interface SupervisedService {
  postMessage(message: {type: 'stop'}): void;
  kill(): boolean;
}

// Independent from Electron so shutdown races can be tested without launching the desktop.
export class ServiceSupervisor {
  private service: SupervisedService | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readySeen = false;
  private exited = false;
  private finished = false;
  private exitCode = 0;
  private restarts = 0;
  stopping = false;

  constructor(private readonly log: (event: string, detail?: unknown) => void,
    private readonly exit: (code: number) => void,
    private readonly recovery?: {restart(): void; state(state: 'service-failed' | 'restarting'): void; exhausted(): void}) {}

  attach(service: SupervisedService): void {
    this.exited = false; this.readySeen = false;
    this.service = service;
    this.timers.push(setTimeout(() => this.fail('SERVICE_START_TIMEOUT'), 15000));
    this.log('SERVICE_START_REQUESTED');
  }

  ready(): boolean {
    if (this.stopping || this.readySeen) return false;
    this.readySeen = true;
    this.clearTimers();
    this.log('SERVICE_READY');
    return true;
  }

  fail(code: string, detail?: unknown): void {
    if (this.finished) return;
    this.exitCode = 1;
    this.log(code, detail);
    this.stop();
  }

  serviceExited(code: number): void {
    this.exited = true;
    this.log('SERVICE_EXIT', {code});
    if (!this.stopping && this.recovery) {
      this.clearTimers(); this.readySeen = false; this.recovery.state('service-failed');
      if (this.restarts < 2) {
        const delay = this.restarts++ === 0 ? 250 : 1000;
        this.recovery.state('restarting');
        this.timers.push(setTimeout(() => {if (!this.stopping) this.recovery!.restart();}, delay));
      } else this.recovery.exhausted();
      return;
    }
    if (!this.stopping || code !== 0) this.exitCode = 1;
    this.finish();
  }

  stop(): void {
    if (this.stopping || this.finished) return;
    this.stopping = true;
    this.clearTimers();
    this.log('APP_STOP_REQUESTED');
    if (!this.service || this.exited) {this.finish(); return;}
    // Arm both deadlines before IPC. A failed send/kill cannot cancel the final deadline.
    this.timers.push(setTimeout(() => {
      this.exitCode = 1;
      this.log('SERVICE_STOP_TIMEOUT');
      try {if (!this.service?.kill()) this.log('SERVICE_KILL_REJECTED');}
      catch (error) {this.log('SERVICE_KILL_FAILED', error);}
    }, 3000));
    this.timers.push(setTimeout(() => {this.exitCode = 1; this.finish();}, 5000));
    try {this.service.postMessage({type: 'stop'});}
    catch (error) {this.exitCode = 1; this.log('SERVICE_STOP_SEND_FAILED', error);}
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopping = true;
    this.clearTimers();
    this.log('APP_EXIT', {code: this.exitCode});
    this.exit(this.exitCode);
  }
}
