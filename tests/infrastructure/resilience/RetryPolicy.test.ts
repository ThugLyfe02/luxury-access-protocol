import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry, calculateBackoff, isRetryable } from '../../../src/infrastructure/resilience/RetryPolicy';
import { FailureCategory } from '../../../src/infrastructure/resilience/FailureClassification';

describe('RetryPolicy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isRetryable', () => {
    it('returns true for DEPENDENCY_TRANSIENT', () => {
      expect(isRetryable(FailureCategory.DEPENDENCY_TRANSIENT)).toBe(true);
    });

    it('returns true for TIMEOUT', () => {
      expect(isRetryable(FailureCategory.TIMEOUT)).toBe(true);
    });

    it('returns false for CLIENT_VALIDATION', () => {
      expect(isRetryable(FailureCategory.CLIENT_VALIDATION)).toBe(false);
    });

    it('returns false for AUTH', () => {
      expect(isRetryable(FailureCategory.AUTH)).toBe(false);
    });

    it('returns false for DOMAIN_HARD_STOP', () => {
      expect(isRetryable(FailureCategory.DOMAIN_HARD_STOP)).toBe(false);
    });

    it('returns false for INTERNAL_UNEXPECTED', () => {
      expect(isRetryable(FailureCategory.INTERNAL_UNEXPECTED)).toBe(false);
    });
  });

  describe('calculateBackoff', () => {
    it('increases exponentially', () => {
      const config = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 16000, jitterMs: 0 };
      expect(calculateBackoff(0, config)).toBe(1000);
      expect(calculateBackoff(1, config)).toBe(2000);
      expect(calculateBackoff(2, config)).toBe(4000);
      expect(calculateBackoff(3, config)).toBe(8000);
    });

    it('caps at maxDelayMs', () => {
      const config = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000, jitterMs: 0 };
      expect(calculateBackoff(10, config)).toBe(5000);
    });

    it('adds jitter', () => {
      const config = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 16000, jitterMs: 500 };
      const delay = calculateBackoff(0, config);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThan(1500);
    });
  });

  describe('withRetry', () => {
    it('succeeds immediately on first try', async () => {
      const result = await withRetry(
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
        async () => 'success',
      );
      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
    });

    it('retries transient failures and succeeds', async () => {
      let attempt = 0;
      const result = await withRetry(
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
        async () => {
          attempt++;
          if (attempt < 3) {
            const err = new Error('network error'); // classified as transient
            throw err;
          }
          return 'recovered';
        },
      );
      expect(result.success).toBe(true);
      expect(result.result).toBe('recovered');
      expect(result.attempts).toBe(3);
    });

    it('does NOT retry non-retryable errors', async () => {
      let attempts = 0;
      const result = await withRetry(
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
        async () => {
          attempts++;
          const err = new Error('validation failed');
          (err as any).code = 'INVALID_OWNER'; // CLIENT_VALIDATION — not retryable
          throw err;
        },
      );
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // Failed on first try, no retry
    });

    it('exhausts retries and returns failure', async () => {
      const err = new Error('econnrefused'); // transient
      const result = await withRetry(
        { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitterMs: 0 },
        async () => { throw err; },
      );
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3); // initial + 2 retries
      expect(result.lastError).toBe(err);
    });
  });
});
