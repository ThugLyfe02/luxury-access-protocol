import { AsyncRateLimiterAdapter, RateLimiterEntry } from '../resilience/RateLimiter';
import { getPool } from '../db/connection';

/**
 * Postgres-backed distributed rate limiter adapter.
 *
 * Uses atomic upsert (INSERT ... ON CONFLICT DO UPDATE) to maintain
 * cluster-wide request counters. All instances share the same counters.
 *
 * Window alignment uses fixed-window truncation to the nearest boundary.
 *
 * Implements the existing RateLimiterAdapter interface — drop-in replacement
 * for InMemoryRateLimiterAdapter.
 */
export class PostgresRateLimiterAdapter implements AsyncRateLimiterAdapter {
  private readonly windowMs: number;
  private cleanupCounter = 0;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  get(key: string): RateLimiterEntry | null {
    // Synchronous interface — not used for Postgres path.
    // The RateLimiter calls get() then set(); for Postgres we use
    // the async checkAndIncrement instead. This exists only to
    // satisfy the interface contract.
    return null;
  }

  set(_key: string, _entry: RateLimiterEntry): void {
    // No-op for Postgres adapter. Counting is done atomically in checkAndIncrement.
  }

  cleanup(_now: number, _windowMs: number): void {
    // No-op for synchronous cleanup. Async cleanup is handled probabilistically.
  }

  /**
   * Atomic check-and-increment for distributed rate limiting.
   * Returns the new count after increment.
   *
   * Uses a fixed-window approach:
   * - Window start is truncated to the nearest windowMs boundary
   * - Atomic INSERT ... ON CONFLICT DO UPDATE ensures accurate counting
   * - Probabilistic cleanup of old entries (1-in-100 calls)
   */
  async checkAndIncrement(key: string, now: number): Promise<{ count: number; windowStart: number }> {
    const pool = getPool();
    const windowStart = new Date(now - (now % this.windowMs));

    const result = await pool.query(
      `INSERT INTO rate_limit_counters (key, window_start, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE
       SET count = rate_limit_counters.count + 1
       RETURNING count`,
      [key, windowStart],
    );

    const count = result.rows[0].count as number;

    // Probabilistic cleanup (1 in 100 calls)
    this.cleanupCounter++;
    if (this.cleanupCounter >= 100) {
      this.cleanupCounter = 0;
      this.asyncCleanup().catch(() => {});
    }

    return { count, windowStart: windowStart.getTime() };
  }

  private async asyncCleanup(): Promise<void> {
    const pool = getPool();
    const cutoff = new Date(Date.now() - this.windowMs * 2);
    await pool.query(
      `DELETE FROM rate_limit_counters WHERE window_start < $1`,
      [cutoff],
    );
  }
}
