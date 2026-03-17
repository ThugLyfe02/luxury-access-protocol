import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../../../src/infrastructure/resilience/Timeout';

describe('Timeout', () => {
  it('resolves if operation completes before timeout', async () => {
    const result = await withTimeout('fast-op', 1000, async () => 'done');
    expect(result).toBe('done');
  });

  it('rejects with TimeoutError if operation exceeds timeout', async () => {
    await expect(
      withTimeout('slow-op', 50, () => new Promise(resolve => setTimeout(resolve, 200))),
    ).rejects.toThrow(TimeoutError);
  });

  it('TimeoutError contains operation name and timeout value', async () => {
    try {
      await withTimeout('my-operation', 10, () => new Promise(resolve => setTimeout(resolve, 200)));
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
      const te = error as TimeoutError;
      expect(te.operation).toBe('my-operation');
      expect(te.timeoutMs).toBe(10);
      expect(te.message).toContain('my-operation');
      expect(te.message).toContain('10ms');
    }
  });

  it('propagates errors from the operation (not timeout)', async () => {
    await expect(
      withTimeout('fail-op', 1000, async () => { throw new Error('operation failed'); }),
    ).rejects.toThrow('operation failed');
  });

  it('rejects if timeoutMs is <= 0', async () => {
    await expect(
      withTimeout('bad-timeout', 0, async () => 'x'),
    ).rejects.toThrow('Invalid timeout');
  });

  it('rejects with negative timeout', async () => {
    await expect(
      withTimeout('neg', -1, async () => 'x'),
    ).rejects.toThrow('Invalid timeout');
  });

  it('does not hang — timeout triggers even if promise never resolves', async () => {
    const start = Date.now();
    await expect(
      withTimeout('never-resolve', 50, () => new Promise<string>(() => { /* never resolves */ })),
    ).rejects.toThrow(TimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // Generous upper bound
  });
});
