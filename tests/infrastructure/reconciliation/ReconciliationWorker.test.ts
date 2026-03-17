import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconciliationWorker } from '../../../src/infrastructure/reconciliation/ReconciliationWorker';
import { ReconciliationEngine } from '../../../src/application/services/ReconciliationEngine';

describe('ReconciliationWorker', () => {
  let mockEngine: { runFullSweep: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    mockEngine = {
      runFullSweep: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and schedules sweeps', () => {
    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 1000,
      triggeredBy: 'test-worker',
    });

    worker.start();
    expect(worker.isRunning).toBe(true);

    // No sweep yet — first sweep fires after intervalMs
    expect(mockEngine.runFullSweep).not.toHaveBeenCalled();

    worker.stop();
  });

  it('fires sweep after interval', async () => {
    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 1000,
      triggeredBy: 'test-worker',
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockEngine.runFullSweep).toHaveBeenCalledWith('test-worker');

    worker.stop();
  });

  it('stops cleanly', () => {
    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 1000,
      triggeredBy: 'test-worker',
    });

    worker.start();
    worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  it('does not start twice', () => {
    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 1000,
      triggeredBy: 'test-worker',
    });

    worker.start();
    worker.start(); // Second call should be no-op
    worker.stop();
  });

  it('runOnce executes a single sweep', async () => {
    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 60_000,
      triggeredBy: 'test-worker',
    });

    await worker.runOnce();
    expect(mockEngine.runFullSweep).toHaveBeenCalledTimes(1);
  });

  it('does not overlap sweeps', async () => {
    let resolveFirst!: () => void;
    const firstSweepPromise = new Promise<void>(r => { resolveFirst = r; });
    mockEngine.runFullSweep.mockReturnValueOnce(firstSweepPromise);

    const worker = new ReconciliationWorker(mockEngine as unknown as ReconciliationEngine, {
      intervalMs: 60_000,
      triggeredBy: 'test-worker',
    });

    // Start first sweep
    const firstCall = worker.runOnce();

    // Try to start second sweep while first is in progress
    await worker.runOnce(); // Should skip because sweepInProgress

    // Only one call should have been made
    expect(mockEngine.runFullSweep).toHaveBeenCalledTimes(1);

    // Complete the first sweep
    resolveFirst();
    await firstCall;
  });
});
