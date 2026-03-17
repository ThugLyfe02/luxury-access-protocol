/**
 * Route-aware rate limiter with clean error responses.
 *
 * Uses a sliding window counter per key (IP or actor).
 * Interface-based so it can evolve beyond in-memory.
 */

export interface RateLimiterEntry {
  count: number;
  windowStart: number;
}

export interface RateLimiterAdapter {
  /** Get current count for key. Returns null if no entry. */
  get(key: string): RateLimiterEntry | null;
  /** Set/update the entry for key. */
  set(key: string, entry: RateLimiterEntry): void;
  /** Clean up expired entries. */
  cleanup(now: number, windowMs: number): void;
}

/**
 * Extended adapter interface for distributed (async) rate limiting.
 * Adapters that implement this can be used with checkAsync().
 */
export interface AsyncRateLimiterAdapter extends RateLimiterAdapter {
  checkAndIncrement(key: string, now: number): Promise<{ count: number; windowStart: number }>;
}

/**
 * In-memory sliding-window rate limiter.
 * Explicit: this is a dev/test/single-process implementation.
 * For distributed deployment, replace the adapter with Redis-backed storage.
 */
export class InMemoryRateLimiterAdapter implements RateLimiterAdapter {
  private readonly store = new Map<string, RateLimiterEntry>();

  get(key: string): RateLimiterEntry | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, entry: RateLimiterEntry): void {
    this.store.set(key, entry);
  }

  cleanup(now: number, windowMs: number): void {
    for (const [key, entry] of this.store) {
      if (now - entry.windowStart > windowMs) {
        this.store.delete(key);
      }
    }
  }
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

export class RateLimiter {
  private readonly adapter: RateLimiterAdapter;
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private lastCleanup = 0;

  constructor(adapter: RateLimiterAdapter, windowMs: number, maxRequests: number) {
    if (windowMs <= 0) throw new Error('windowMs must be > 0');
    if (maxRequests < 1) throw new Error('maxRequests must be >= 1');
    this.adapter = adapter;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check and consume a request for the given key.
   * Returns whether the request is allowed and remaining quota.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    // Periodic cleanup (every 10 windows)
    if (now - this.lastCleanup > this.windowMs * 10) {
      this.adapter.cleanup(now, this.windowMs);
      this.lastCleanup = now;
    }

    const existing = this.adapter.get(key);

    if (!existing || now - existing.windowStart > this.windowMs) {
      // New window
      this.adapter.set(key, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAt: now + this.windowMs,
      };
    }

    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: existing.windowStart + this.windowMs,
      };
    }

    existing.count++;
    this.adapter.set(key, existing);
    return {
      allowed: true,
      remaining: this.maxRequests - existing.count,
      resetAt: existing.windowStart + this.windowMs,
    };
  }

  /**
   * Async check for distributed rate limiting.
   * Uses the adapter's checkAndIncrement if available (AsyncRateLimiterAdapter).
   * Falls back to synchronous check() otherwise.
   */
  async checkAsync(key: string, now: number = Date.now()): Promise<RateLimitResult> {
    if (!('checkAndIncrement' in this.adapter)) {
      return this.check(key, now);
    }
    const asyncAdapter = this.adapter as AsyncRateLimiterAdapter;

    const { count, windowStart } = await asyncAdapter.checkAndIncrement(key, now);
    const resetAt = windowStart + this.windowMs;

    if (count > this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - count,
      resetAt,
    };
  }

  get config(): { windowMs: number; maxRequests: number } {
    return { windowMs: this.windowMs, maxRequests: this.maxRequests };
  }
}
