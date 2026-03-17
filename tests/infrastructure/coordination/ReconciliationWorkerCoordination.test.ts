import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconciliationWorker } from '../../../src/infrastructure/reconciliation/ReconciliationWorker';
import { ReconciliationEngine } from '../../../src/application/services/ReconciliationEngine';
import { DistributedLeaseManager } from '../../../src/infrastructure/coordination/DistributedLeaseManager';

describe('ReconciliationWorker with Distributed Lease', () => {
  let mockEngine: { runFullSweep: ReturnType<typeof vi.fn> };
  let mockLeaseManager: {
    acquire: ReturnType<typeof vi.fn>;
    renew: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockEngine = {
      runFullSweep: vi.fn().mockResolvedValue(undefined),
    };
    mockLeaseManager = {
      acquire: vi.fn(),
      renew: vi.fn(),
      release: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWorker(workerId: string = 'worker-1') {
    return new ReconciliationWorker(
      mockEngine as unknown as ReconciliationEngine,
      { intervalMs: 1000, triggeredBy: 'test-worker' },
      mockLeaseManager as unknown as DistributedLeaseManager,
      workerId,
    );
  }

  it('acquires lease before running sweep', async () => {
    mockLeaseManager.acquire.mockResolvedValue({
      leaseName: 'reconciliation-sweep',
      ownerId: 'worker-1',
      acquiredAt: new Date(),
      renewedAt: new Date(),
      leaseUntil: new Date(Date.now() + 2000),
      version: 1,
      metadata: null,
    });
    mockLeaseManager.release.mockResolvedValue(true);

    const worker = createWorker();
    await worker.runOnce();

    expect(mockLeaseManager.acquire).toHaveBeenCalledWith({
      leaseName: 'reconciliation-sweep',
      ownerId: 'worker-1',
      ttlMs: 2000, // intervalMs * 2
      metadata: { triggeredBy: 'test-worker' },
    });
    expect(mockEngine.runFullSweep).toHaveBeenCalledWith('test-worker');
    expect(mockLeaseManager.release).toHaveBeenCalledWith('reconciliation-sweep', 'worker-1');
  });

  it('skips sweep when lease is held by another instance', async () => {
    mockLeaseManager.acquire.mockResolvedValue(null);

    const worker = createWorker();
    await worker.runOnce();

    expect(mockLeaseManager.acquire).toHaveBeenCalled();
    expect(mockEngine.runFullSweep).not.toHaveBeenCalled();
    expect(mockLeaseManager.release).not.toHaveBeenCalled();
  });

  it('releases lease even when sweep throws', async () => {
    mockLeaseManager.acquire.mockResolvedValue({
      leaseName: 'reconciliation-sweep',
      ownerId: 'worker-1',
      acquiredAt: new Date(),
      renewedAt: new Date(),
      leaseUntil: new Date(Date.now() + 2000),
      version: 1,
      metadata: null,
    });
    mockLeaseManager.release.mockResolvedValue(true);
    mockEngine.runFullSweep.mockRejectedValue(new Error('sweep failed'));

    const worker = createWorker();

    await expect(worker.runOnce()).rejects.toThrow('sweep failed');

    expect(mockLeaseManager.release).toHaveBeenCalledWith('reconciliation-sweep', 'worker-1');
  });

  it('two workers: only one runs sweep (double leader prevention)', async () => {
    // Worker 1 acquires successfully
    mockLeaseManager.acquire
      .mockResolvedValueOnce({
        leaseName: 'reconciliation-sweep',
        ownerId: 'worker-1',
        acquiredAt: new Date(),
        renewedAt: new Date(),
        leaseUntil: new Date(Date.now() + 2000),
        version: 1,
        metadata: null,
      })
      // Worker 2 gets null (already held)
      .mockResolvedValueOnce(null);

    mockLeaseManager.release.mockResolvedValue(true);

    const worker1 = createWorker('worker-1');
    const worker2 = createWorker('worker-2');

    await worker1.runOnce();
    await worker2.runOnce();

    expect(mockEngine.runFullSweep).toHaveBeenCalledTimes(1);
  });

  it('works without lease manager (backward compatible)', async () => {
    const worker = new ReconciliationWorker(
      mockEngine as unknown as ReconciliationEngine,
      { intervalMs: 1000, triggeredBy: 'test-worker' },
    );

    await worker.runOnce();

    expect(mockEngine.runFullSweep).toHaveBeenCalledTimes(1);
  });

  it('does not overlap sweeps even with lease manager', async () => {
    let resolveFirst!: () => void;
    const firstSweepPromise = new Promise<void>(r => { resolveFirst = r; });
    mockEngine.runFullSweep.mockReturnValueOnce(firstSweepPromise);

    mockLeaseManager.acquire.mockResolvedValue({
      leaseName: 'reconciliation-sweep',
      ownerId: 'worker-1',
      acquiredAt: new Date(),
      renewedAt: new Date(),
      leaseUntil: new Date(Date.now() + 2000),
      version: 1,
      metadata: null,
    });
    mockLeaseManager.release.mockResolvedValue(true);

    const worker = createWorker();

    const firstCall = worker.runOnce();
    // Let the first call's acquire resolve and reach sweepInProgress = true
    await vi.advanceTimersByTimeAsync(0);

    await worker.runOnce(); // Should skip — sweepInProgress

    expect(mockEngine.runFullSweep).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstCall;
  });

  it('releaseLease releases the singleton lease', async () => {
    mockLeaseManager.release.mockResolvedValue(true);

    const worker = createWorker();
    await worker.releaseLease();

    expect(mockLeaseManager.release).toHaveBeenCalledWith('reconciliation-sweep', 'worker-1');
  });

  it('releaseLease is a no-op without lease manager', async () => {
    const worker = new ReconciliationWorker(
      mockEngine as unknown as ReconciliationEngine,
      { intervalMs: 1000, triggeredBy: 'test-worker' },
    );

    // Should not throw
    await worker.releaseLease();
  });
});
