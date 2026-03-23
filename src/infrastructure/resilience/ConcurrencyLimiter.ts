/**
 * Bounded concurrency limiter for worker dispatch.
 *
 * Ensures at most N operations run in parallel.
 * Prevents "process everything now" behavior.
 */

export class ConcurrencyLimiter {
  private readonly maxConcurrency: number;
  private running = 0;
  private _totalExecuted = 0;
  private _totalRejected = 0;

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) throw new Error('maxConcurrency must be >= 1');
    this.maxConcurrency = maxConcurrency;
  }

  get activeCount(): number {
    return this.running;
  }

  get available(): boolean {
    return this.running < this.maxConcurrency;
  }

  get totalExecuted(): number {
    return this._totalExecuted;
  }

  get totalRejected(): number {
    return this._totalRejected;
  }

  /**
   * Execute a function if concurrency slot is available.
   * Returns null if rejected due to concurrency limit.
   */
  async tryExecute<T>(fn: () => Promise<T>): Promise<{ executed: true; result: T } | { executed: false }> {
    if (this.running >= this.maxConcurrency) {
      this._totalRejected++;
      return { executed: false };
    }

    this.running++;
    this._totalExecuted++;
    try {
      const result = await fn();
      return { executed: true, result };
    } finally {
      this.running--;
    }
  }

  /**
   * Execute up to maxConcurrency tasks from a batch.
   * Returns results for executed items.
   */
  async executeBatch<T, R>(
    items: T[],
    handler: (item: T) => Promise<R>,
  ): Promise<{ results: Array<{ item: T; result: R } | { item: T; error: Error }>; executed: number; skipped: number }> {
    const results: Array<{ item: T; result: R } | { item: T; error: Error }> = [];
    let executed = 0;
    let skipped = 0;

    // Process in chunks of maxConcurrency
    for (let i = 0; i < items.length; i += this.maxConcurrency) {
      const chunk = items.slice(i, i + this.maxConcurrency);
      const promises = chunk.map(async (item) => {
        const outcome = await this.tryExecute(() => handler(item));
        if (outcome.executed) {
          executed++;
          return { item, result: outcome.result };
        }
        skipped++;
        return null;
      });

      const chunkResults = await Promise.allSettled(promises);
      for (const settled of chunkResults) {
        if (settled.status === 'fulfilled' && settled.value) {
          results.push(settled.value);
        } else if (settled.status === 'rejected') {
          // Should not happen with tryExecute, but handle defensively
          executed++;
          results.push({ item: chunk[0], error: settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason)) });
        }
      }
    }

    return { results, executed, skipped };
  }

  diagnostics(): { maxConcurrency: number; active: number; totalExecuted: number; totalRejected: number } {
    return {
      maxConcurrency: this.maxConcurrency,
      active: this.running,
      totalExecuted: this._totalExecuted,
      totalRejected: this._totalRejected,
    };
  }
}
