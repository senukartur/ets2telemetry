/** A bounded sliding window, independent of process lifetime and application wall-clock changes. */
export class RecoveryBudget {
  private attempts: number[] = [];
  private previous = -Infinity;
  constructor(private readonly now = () => performance.now(), private readonly limit = 2, private readonly windowMs = 60000) {}
  take(): number | undefined {
    const time = this.now();
    if (!Number.isFinite(time) || time < 0 || time < this.previous) return undefined;
    this.previous = time;
    this.attempts = this.attempts.filter(attempt => time - attempt < this.windowMs);
    if (this.attempts.length >= this.limit) return undefined;
    this.attempts.push(time);
    return this.attempts.length;
  }
}
