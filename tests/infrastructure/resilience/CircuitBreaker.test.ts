import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../../src/infrastructure/resilience/CircuitBreaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker({
      name: 'test-breaker',
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenMaxProbes: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('CLOSED state', () => {
    it('starts in CLOSED state', () => {
      expect(breaker.state).toBe('CLOSED');
    });

    it('passes through successful calls', async () => {
      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);
      expect(breaker.state).toBe('CLOSED');
    });

    it('remains CLOSED below failure threshold', async () => {
      for (let i = 0; i < 2; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      expect(breaker.state).toBe('CLOSED');
    });

    it('resets failure count on success', async () => {
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      await breaker.execute(async () => 'ok'); // success resets count
      // Need 3 more failures to trip
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      expect(breaker.state).toBe('CLOSED');
    });
  });

  describe('CLOSED → OPEN transition', () => {
    it('opens after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      expect(breaker.state).toBe('OPEN');
    });

    it('fails fast when OPEN', async () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }

      await expect(
        breaker.execute(async () => 'should not reach'),
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    it('CircuitBreakerOpenError has correct properties', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }

      try {
        await breaker.execute(async () => 'nope');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitBreakerOpenError);
        const cbe = error as CircuitBreakerOpenError;
        expect(cbe.breakerName).toBe('test-breaker');
        expect(cbe.openSince).toBeInstanceOf(Date);
        expect(cbe.cooldownMs).toBe(5000);
      }
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after cooldown', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      expect(breaker.state).toBe('OPEN');

      vi.advanceTimersByTime(5000);
      expect(breaker.state).toBe('HALF_OPEN');
    });

    it('allows one probe in HALF_OPEN', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      vi.advanceTimersByTime(5000);

      // First probe allowed
      const result = await breaker.execute(async () => 'recovered');
      expect(result).toBe('recovered');
    });

    it('rejects additional probes beyond halfOpenMaxProbes', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      vi.advanceTimersByTime(5000);

      // First probe fails
      await breaker.execute(async () => { throw new Error('still failing'); }).catch(() => {});
      // Breaker goes back to OPEN, additional probes rejected
      await expect(
        breaker.execute(async () => 'nope'),
      ).rejects.toThrow(CircuitBreakerOpenError);
    });
  });

  describe('HALF_OPEN → CLOSED transition', () => {
    it('closes on successful probe', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      vi.advanceTimersByTime(5000);

      await breaker.execute(async () => 'ok');
      expect(breaker.state).toBe('CLOSED');
    });
  });

  describe('HALF_OPEN → OPEN transition', () => {
    it('reopens on failed probe', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      vi.advanceTimersByTime(5000);
      expect(breaker.state).toBe('HALF_OPEN');

      await breaker.execute(async () => { throw new Error('still failing'); }).catch(() => {});
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('diagnostics', () => {
    it('returns correct diagnostics', async () => {
      await breaker.execute(async () => 'ok');
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});

      const diag = breaker.diagnostics();
      expect(diag.name).toBe('test-breaker');
      expect(diag.state).toBe('CLOSED');
      expect(diag.successCount).toBe(1);
      expect(diag.failureCount).toBe(1);
      expect(diag.lastSuccessAt).toBeInstanceOf(Date);
      expect(diag.lastFailureAt).toBeInstanceOf(Date);
      expect(diag.totalTrips).toBe(0);
    });

    it('tracks total trips', async () => {
      // Trip once
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      vi.advanceTimersByTime(5000);
      await breaker.execute(async () => 'recover');

      // Trip again
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }

      expect(breaker.diagnostics().totalTrips).toBe(2);
    });
  });

  describe('forceOpen / forceClose', () => {
    it('forceOpen opens the breaker', () => {
      breaker.forceOpen();
      expect(breaker.state).toBe('OPEN');
    });

    it('forceClose closes an open breaker', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
      }
      breaker.forceClose();
      expect(breaker.state).toBe('CLOSED');
    });
  });
});
