import type {DiagnosticFacts} from './diagnostics';
import {CLOSE_TERMINATE_RESERVE_MS, HISTORY_CLOSE_GRACE_MS, HISTORY_STORAGE_STEP_NAME} from './history-storage';

/** Ordered service shutdown phases: stop new input, write pending work, then release storage. */
export const SHUTDOWN_PHASES = ['intake', 'flush', 'storage'] as const;
export type ShutdownPhase = typeof SHUTDOWN_PHASES[number];
/**
 * Nominal allocation before main's 3000 ms kill deadline. Registration checks the sum of phase maxima.
 * Event-loop verdict turns and history-close floors retain their existing scheduling limits.
 */
export const SERVICE_STOP_BUDGET_MS = 2500;

export interface ShutdownStepContext {
  budgetMs: number;
  graceMs?: number;
}

export interface ShutdownStep {
  /** Fixed lowercase code written to diagnostics; never a path or runtime value. */
  name: string;
  budgetMs: number;
  run(context?: ShutdownStepContext): Promise<void> | void;
}
export type ShutdownOutcome = 'ok' | 'failed' | 'timeout';
export interface ShutdownTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Runs a callback after the event loop's next poll phase, which delivers the I/O that arrived before it. */
  setImmediate(callback: () => void): unknown;
  clearImmediate(handle: unknown): void;
  now(): number;
}
const systemTimers: ShutdownTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setImmediate: callback => setImmediate(callback),
  clearImmediate: handle => clearImmediate(handle as ReturnType<typeof setImmediate>),
  now: () => performance.now()
};

/**
 * Runs registered service shutdown steps once, phase by phase. Steps within a phase run in parallel and
 * each uses its effective budget (recording may borrow unused intake, then history uses actual remaining time). A failed or late
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

  /** Total of the largest nominal step budget in each phase; not an absolute physical scheduler deadline. */
  get budgetMs(): number {
    return SHUTDOWN_PHASES.reduce((sum, phase) => sum + Math.max(0, ...this.phases.get(phase)!.map(step => step.budgetMs)), 0);
  }

  run(): Promise<{clean: boolean}> {
    this.result ??= this.execute();
    return this.result;
  }

  private async execute(): Promise<{clean: boolean}> {
    let clean = true;
    const sequenceStarted = this.timers.now();
    for (const phase of SHUTDOWN_PHASES) {
      const steps = this.phases.get(phase)!;
      let contexts: ShutdownStepContext[] | undefined;
      if (phase === 'flush') {
        const elapsed = this.timers.now() - sequenceStarted;
        const intakeBudget = Math.max(0, ...this.phases.get('intake')!.map(step => step.budgetMs));
        const storageBudget = Math.max(0, ...this.phases.get('storage')!.map(step => step.budgetMs));
        contexts = steps.map(step => {
          // Only recording borrows unused intake, preserving the registered parallel storage maximum.
          const extra = step.name === 'recording-flush' && Number.isFinite(elapsed) && elapsed >= 0
            ? Math.max(0, Math.min(intakeBudget - elapsed, SERVICE_STOP_BUDGET_MS - elapsed - storageBudget - step.budgetMs)) : 0;
          return {budgetMs: step.budgetMs + extra};
        });
      } else if (phase === 'storage') {
        const elapsed = this.timers.now() - sequenceStarted;
        const remainingStopBudget = Math.max(0, SERVICE_STOP_BUDGET_MS - elapsed);
        contexts = steps.map(step => {
          if (step.name === HISTORY_STORAGE_STEP_NAME) {
            const effectiveBudget = Math.max(step.budgetMs, remainingStopBudget);
            const graceMs = Math.max(HISTORY_CLOSE_GRACE_MS, effectiveBudget - CLOSE_TERMINATE_RESERVE_MS);
            return {budgetMs: effectiveBudget, graceMs};
          }
          return {budgetMs: step.budgetMs};
        });
      }
      const outcomes = await Promise.all(steps.map((step, index) => this.runStep(phase, step, contexts ? contexts[index] : {budgetMs: step.budgetMs})));
      if (outcomes.some(outcome => outcome !== 'ok')) clean = false;
    }
    return {clean};
  }

  /**
   * When the budget runs out, the `timeout` verdict waits one more turn of the event loop (an immediate). A service
   * thread that was blocked or not scheduled past the budget runs the due budget timer before the next poll phase
   * delivers the I/O that arrived meanwhile, so a step result that was already waiting still counts. A step that has
   * not finished by then times out; the turn is scheduled only after the budget expired.
   */
  private runStep(phase: ShutdownPhase, step: ShutdownStep, context?: ShutdownStepContext): Promise<ShutdownOutcome> {
    const started = this.timers.now();
    const effectiveBudget = context?.budgetMs ?? step.budgetMs;
    return new Promise<ShutdownOutcome>(resolve => {
      let settled = false, verdict: unknown;
      const settle = (outcome: ShutdownOutcome) => {
        if (settled) return;
        settled = true; this.timers.clearTimeout(timer); this.timers.clearImmediate(verdict);
        const elapsed = this.timers.now() - started;
        this.log('SHUTDOWN_STEP', undefined, {phase, name: step.name, outcome, ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null});
        resolve(outcome);
      };
      const timer = this.timers.setTimeout(() => { verdict = this.timers.setImmediate(() => settle('timeout')); }, effectiveBudget);
      try {Promise.resolve(step.run(context)).then(() => settle('ok'), () => settle('failed'));}
      catch {settle('failed');}
    });
  }
}
