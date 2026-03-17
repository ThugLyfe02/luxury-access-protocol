import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from '../../../src/infrastructure/resilience/ConcurrencyLimiter';

describe('ConcurrencyLimiter', () => {
  it('allows execution within limit', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const result = await limiter.tryExecute(async () => 42);
    expect(result).toEqual({ executed: true, result: 42 });
    expect(limiter.activeCount).toBe(0); // completed
  });

  it('rejects when at max concurrency', async () => {
    const limiter = new ConcurrencyLimiter(1);

    // Hold one slot open
    let resolveFirst!: () => void;
    const firstPromise = limiter.tryExecute(
      () => new Promise<string>(resolve => { resolveFirst = () => resolve('first'); }),
    );

    // Second should be rejected
    const second = await limiter.tryExecute(async () => 'second');
    expect(second).toEqual({ executed: false });

    // Clean up
    resolveFirst();
    await firstPromise;
  });

  it('tracks active count correctly', async () => {
    const limiter = new ConcurrencyLimiter(5);
    expect(limiter.activeCount).toBe(0);

    let resolveFirst!: () => void;
    const p = limiter.tryExecute(
      () => new Promise<void>(resolve => { resolveFirst = resolve; }),
    );

    // Give microtask a chance to start
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(limiter.activeCount).toBe(1);

    resolveFirst();
    await p;
    expect(limiter.activeCount).toBe(0);
  });

  it('tracks total executed and rejected', async () => {
    const limiter = new ConcurrencyLimiter(1);

    await limiter.tryExecute(async () => 'a');
    await limiter.tryExecute(async () => 'b');

    expect(limiter.totalExecuted).toBe(2);
    expect(limiter.totalRejected).toBe(0);
  });

  it('executeBatch processes items in bounded chunks', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    const { results, executed } = await limiter.executeBatch(items, async (item) => {
      processed.push(item);
      return item * 2;
    });

    expect(executed).toBe(5);
    expect(results).toHaveLength(5);
    expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns diagnostics', async () => {
    const limiter = new ConcurrencyLimiter(3);
    await limiter.tryExecute(async () => 'x');

    const diag = limiter.diagnostics();
    expect(diag.maxConcurrency).toBe(3);
    expect(diag.active).toBe(0);
    expect(diag.totalExecuted).toBe(1);
    expect(diag.totalRejected).toBe(0);
  });

  it('rejects invalid maxConcurrency', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow('maxConcurrency must be >= 1');
  });
});
