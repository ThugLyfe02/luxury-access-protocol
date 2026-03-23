import { describe, it, expect } from 'vitest';
import { loadResilienceConfig } from '../../../src/infrastructure/resilience/ResilienceConfig';

describe('ResilienceConfig', () => {
  it('loads default config with valid values', () => {
    const config = loadResilienceConfig();
    expect(config.providerCallTimeoutMs).toBe(15_000);
    expect(config.breakerFailureThreshold).toBe(5);
    expect(config.outboxWorkerConcurrency).toBe(5);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.maxRetryAttempts).toBe(3);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts valid overrides', () => {
    const config = loadResilienceConfig({
      providerCallTimeoutMs: 5_000,
      breakerFailureThreshold: 10,
    });
    expect(config.providerCallTimeoutMs).toBe(5_000);
    expect(config.breakerFailureThreshold).toBe(10);
  });

  it('rejects zero timeout', () => {
    expect(() => loadResilienceConfig({ providerCallTimeoutMs: 0 })).toThrow('providerCallTimeoutMs must be > 0');
  });

  it('rejects negative timeout', () => {
    expect(() => loadResilienceConfig({ dbQueryTimeoutMs: -1 })).toThrow('dbQueryTimeoutMs must be > 0');
  });

  it('rejects zero breaker threshold', () => {
    expect(() => loadResilienceConfig({ breakerFailureThreshold: 0 })).toThrow('breakerFailureThreshold must be >= 1');
  });

  it('rejects zero concurrency', () => {
    expect(() => loadResilienceConfig({ outboxWorkerConcurrency: 0 })).toThrow('outboxWorkerConcurrency must be >= 1');
  });

  it('rejects invalid backlog threshold ordering', () => {
    expect(() => loadResilienceConfig({
      outboxBacklogDegradedThreshold: 100,
      outboxBacklogNotReadyThreshold: 50,
    })).toThrow('outboxBacklogNotReadyThreshold must be > outboxBacklogDegradedThreshold');
  });

  it('rejects maxDelayMs < baseDelayMs', () => {
    expect(() => loadResilienceConfig({
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 1000,
    })).toThrow('retryMaxDelayMs must be >= retryBaseDelayMs');
  });

  it('collects all errors in one throw', () => {
    try {
      loadResilienceConfig({
        providerCallTimeoutMs: 0,
        breakerFailureThreshold: 0,
        outboxWorkerConcurrency: 0,
      });
      expect.fail('Should have thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('providerCallTimeoutMs');
      expect(msg).toContain('breakerFailureThreshold');
      expect(msg).toContain('outboxWorkerConcurrency');
    }
  });
});
