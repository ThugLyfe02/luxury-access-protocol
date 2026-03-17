import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, InMemoryRateLimiterAdapter } from '../../../src/infrastructure/resilience/RateLimiter';

describe('RateLimiter', () => {
  let adapter: InMemoryRateLimiterAdapter;
  let limiter: RateLimiter;

  beforeEach(() => {
    adapter = new InMemoryRateLimiterAdapter();
    limiter = new RateLimiter(adapter, 60_000, 5); // 5 requests per 60s
  });

  it('allows requests within limit', () => {
    const now = 1000000;
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('user:1', now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });

  it('blocks requests exceeding limit', () => {
    const now = 1000000;
    for (let i = 0; i < 5; i++) {
      limiter.check('user:1', now);
    }
    const result = limiter.check('user:1', now);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after window expires', () => {
    const now = 1000000;
    for (let i = 0; i < 5; i++) {
      limiter.check('user:1', now);
    }
    // After window
    const result = limiter.check('user:1', now + 60_001);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('tracks separate keys independently', () => {
    const now = 1000000;
    for (let i = 0; i < 5; i++) {
      limiter.check('user:1', now);
    }
    const result = limiter.check('user:2', now);
    expect(result.allowed).toBe(true);
  });

  it('returns correct resetAt time', () => {
    const now = 1000000;
    const result = limiter.check('user:1', now);
    expect(result.resetAt).toBe(now + 60_000);
  });

  it('rejects invalid constructor args', () => {
    expect(() => new RateLimiter(adapter, 0, 5)).toThrow('windowMs must be > 0');
    expect(() => new RateLimiter(adapter, 1000, 0)).toThrow('maxRequests must be >= 1');
  });

  it('provides config getter', () => {
    expect(limiter.config).toEqual({ windowMs: 60_000, maxRequests: 5 });
  });
});
