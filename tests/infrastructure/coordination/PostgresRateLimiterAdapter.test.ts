import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresRateLimiterAdapter } from '../../../src/infrastructure/coordination/PostgresRateLimiterAdapter';
import { RateLimiter } from '../../../src/infrastructure/resilience/RateLimiter';

const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

describe('PostgresRateLimiterAdapter', () => {
  let adapter: PostgresRateLimiterAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockQuery.mockReset();
    adapter = new PostgresRateLimiterAdapter(60_000);
  });

  describe('checkAndIncrement', () => {
    it('inserts a new counter and returns count=1', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const result = await adapter.checkAndIncrement('rental-init:actor:user-42', 1000000);

      expect(result.count).toBe(1);
      expect(result.windowStart).toBe(960000); // 1000000 - (1000000 % 60000) = 960000
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO rate_limit_counters');
      expect(sql).toContain('ON CONFLICT');
      expect(params[0]).toBe('rental-init:actor:user-42');
    });

    it('increments existing counter and returns new count', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 5 }] });

      const result = await adapter.checkAndIncrement('rental-init:actor:user-42', 1000000);

      expect(result.count).toBe(5);
    });

    it('window start aligns to fixed window boundary', async () => {
      const windowMs = 60_000;
      const adapter60 = new PostgresRateLimiterAdapter(windowMs);

      mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      const result = await adapter60.checkAndIncrement('test-key', 123_456);

      // 123456 % 60000 = 3456, so windowStart = 123456 - 3456 = 120000
      expect(result.windowStart).toBe(120_000);
    });

    it('triggers probabilistic cleanup after 100 calls', async () => {
      // Always resolve with a valid response
      mockQuery.mockResolvedValue({ rows: [{ count: 1 }], rowCount: 0 });

      // Make 100 calls
      for (let i = 0; i < 100; i++) {
        await adapter.checkAndIncrement('key', 1000000 + i);
      }

      // Need to wait for async cleanup
      await new Promise(r => setTimeout(r, 10));

      // Verify cleanup query was issued
      const cleanupCalls = mockQuery.mock.calls.filter(([sql]: [string]) =>
        sql.includes('DELETE FROM rate_limit_counters'),
      );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('synchronous interface methods', () => {
    it('get returns null (not used for Postgres)', () => {
      expect(adapter.get('any-key')).toBeNull();
    });

    it('set is a no-op', () => {
      adapter.set('any-key', { count: 1, windowStart: 0 });
      // No error
    });

    it('cleanup is a no-op', () => {
      adapter.cleanup(0, 0);
      // No error
    });
  });

  describe('integration with RateLimiter.checkAsync', () => {
    it('allows requests within limit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      const limiter = new RateLimiter(adapter, 60_000, 10);

      const result = await limiter.checkAsync('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it('rejects requests over limit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 11 }] });
      const limiter = new RateLimiter(adapter, 60_000, 10);

      const result = await limiter.checkAsync('test-key');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('exact limit count is allowed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 10 }] });
      const limiter = new RateLimiter(adapter, 60_000, 10);

      const result = await limiter.checkAsync('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });
  });
});
