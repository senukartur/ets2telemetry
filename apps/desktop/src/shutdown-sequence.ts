import type {DiagnosticFacts} from './diagnostics';

/** Ordered service shutdown phases: stop new input, write pending work, then release storage. */
export const SHUTDOWN_PHASES = ['intake', 'flush', 'storage'] as const;
export type ShutdownPhase = typeof SHUTDOWN_PHASES[number];
/**
 * The whole sequence must finish before main's 3000 ms kill deadline. The sum of every phase's
 * largest step budget is checked against this bound at registration time.
 */
export const SERVICE_STOP_BUDGET_MS = 2500;

export interface ShutdownStep {
  /** Fixed lowercase code written to diagnostics; never a path or runtime value. */
  name: string;
  budgetMs: number;
  run(): Promise<void> | void;
}
export type ShutdownOutcome = 'ok' | 'failed' | 'timeout';
export interface ShutdownTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
const systemTimers: ShutdownTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now()
};

/**
 * Runs registered service shutdown steps once, phase by phase. Steps within a phase run in parallel and
 * each is bounded by its own budget, so a phase lasts at most its largest step budget. A failed or late
 * step is recorded and the sequence continues; the result reports whether every step finished cleanly.
 */
export class ShutdownSequence {
  private readonly phases = new Map<ShutdownPhase, ShutdownStep[]>(SHUTDOWN_PHASES.map(phase => [phase, []]));
  private result: Promise<{clean: boolean}> | undefined;

  constructor(private readonly log: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void,
    private readonly timers: ShutdownTimers = systemTimers) {}

  register(phase: ShutdownPhase, step: ShutdownStep): void {
    if (this.result) throw new Error('Shutdown has already started');
    const steps = this.phases.get(phase);
    if (!steps) throw new Error('Unknown shutdown phase');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(step.name)) throw new Error('Invalid shutdown step name');
    if (!Number.isSafeInteger(step.budgetMs) || step.budgetMs <= 0) throw new Error('Invalid shutdown step budget');
    if ([...this.phases.values()].some(registered => registered.some(existing => existing.name === step.name))) throw new Error('Duplicate shutdown step');
    const total = SHUTDOWN_PHASES.reduce((sum, name) => sum + Math.max(0, ...(name === phase ? [...steps, step] : this.phases.get(name)!).map(entry => entry.budgetMs)), 0);
    if (total > SERVICE_STOP_BUDGET_MS) throw new Error('Shutdown budget exceeded');
    steps.push({...step});
  }

  /** Total of the largest step budget in each phase: the sequence's upper bound. */
  get budgetMs(): number {
    return SHUTDOWN_PHASES.reduce((sum, phase) => sum + Math.max(0, ...this.phases.get(phase)!.map(step => step.budgetMs)), 0);
  }

  run(): Promise<{clean: boolean}> {
    this.result ??= this.execute();
    return this.result;
  }

  private async execute(): Promise<{clean: boolean}> {
    let clean = true;
    for (const phase of SHUTDOWN_PHASES) {
      const outcomes = await Promise.all(this.phases.get(phase)!.map(step => this.runStep(phase, step)));
      if (outcomes.some(outcome => outcome !== 'ok')) clean = false;
    }
    return {clean};
  }

  private runStep(phase: ShutdownPhase, step: ShutdownStep): Promise<ShutdownOutcome> {
    const started = this.timers.now();
    return new Promise<ShutdownOutcome>(resolve => {
      let settled = false;
      const settle = (outcome: ShutdownOutcome) => {
        if (settled) return;
        settled = true; this.timers.clearTimeout(timer);
        const elapsed = this.timers.now() - started;
        this.log('SHUTDOWN_STEP', undefined, {phase, name: step.name, outcome, ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null});
        resolve(outcome);
      };
      const timer = this.timers.setTimeout(() => settle('timeout'), step.budgetMs);
      try {Promise.resolve(step.run()).then(() => settle('ok'), () => settle('failed'));}
      catch {settle('failed');}
    });
  }
}
