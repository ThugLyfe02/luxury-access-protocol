import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HealthMonitor, BacklogProvider } from '../../../src/infrastructure/resilience/HealthMonitor';
import { CircuitBreaker } from '../../../src/infrastructure/resilience/CircuitBreaker';
import { loadResilienceConfig } from '../../../src/infrastructure/resilience/ResilienceConfig';

describe('HealthMonitor', () => {
  const config = loadResilienceConfig({
    outboxBacklogDegradedThreshold: 10,
    outboxBacklogNotReadyThreshold: 50,
    reconUnresolvedCriticalThreshold: 5,
    workerHeartbeatStaleMs: 60_000,
  });

  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker({
      name: 'test-provider',
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenMaxProbes: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns HEALTHY when all checks pass', async () => {
    const monitor = new HealthMonitor(config, [breaker]);
    monitor.recordWorkerHeartbeat('outbox-worker', true);

    const report = await monitor.getReport();
    expect(report.status).toBe('HEALTHY');
    expect(report.degradedReasons).toHaveLength(0);
  });

  it('isAlive is always true', () => {
    const monitor = new HealthMonitor(config, []);
    expect(monitor.isAlive()).toBe(true);
  });

  it('returns NOT_READY when DB is unavailable', async () => {
    const monitor = new HealthMonitor(config, []);
    monitor.setDbHealthy(false);

    const report = await monitor.getReport();
    expect(report.status).toBe('NOT_READY');
    expect(report.degradedReasons).toContain('Database unavailable');
  });

  it('returns DEGRADED when circuit breaker is OPEN', async () => {
    const monitor = new HealthMonitor(config, [breaker]);

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }

    const report = await monitor.getReport();
    expect(report.status).toBe('DEGRADED');
    expect(report.degradedReasons.some(r => r.includes('OPEN'))).toBe(true);
  });

  it('returns DEGRADED when worker heartbeat is stale', async () => {
    const monitor = new HealthMonitor(config, []);
    monitor.recordWorkerHeartbeat('outbox-worker', true);

    // Advance past stale threshold
    vi.advanceTimersByTime(61_000);

    const report = await monitor.getReport();
    expect(report.status).toBe('DEGRADED');
    expect(report.degradedReasons.some(r => r.includes('outbox-worker'))).toBe(true);
  });

  it('returns DEGRADED when outbox backlog exceeds degraded threshold', async () => {
    const backlog: BacklogProvider = {
      outboxPending: async () => 15, // > 10 threshold
      reconUnresolvedCritical: async () => 0,
    };
    const monitor = new HealthMonitor(config, [], backlog);

    const report = await monitor.getReport();
    expect(report.status).toBe('DEGRADED');
    expect(report.degradedReasons.some(r => r.includes('Outbox backlog'))).toBe(true);
  });

  it('returns NOT_READY when outbox backlog exceeds NOT_READY threshold', async () => {
    const backlog: BacklogProvider = {
      outboxPending: async () => 55, // > 50 threshold
      reconUnresolvedCritical: async () => 0,
    };
    const monitor = new HealthMonitor(config, [], backlog);

    const report = await monitor.getReport();
    expect(report.status).toBe('NOT_READY');
  });

  it('returns DEGRADED when reconciliation critical count exceeds threshold', async () => {
    const backlog: BacklogProvider = {
      outboxPending: async () => 0,
      reconUnresolvedCritical: async () => 6, // > 5 threshold
    };
    const monitor = new HealthMonitor(config, [], backlog);

    const report = await monitor.getReport();
    expect(report.status).toBe('DEGRADED');
    expect(report.degradedReasons.some(r => r.includes('CRITICAL'))).toBe(true);
  });

  it('includes breaker diagnostics in report', async () => {
    const monitor = new HealthMonitor(config, [breaker]);
    const report = await monitor.getReport();
    expect(report.breakers).toHaveLength(1);
    expect(report.breakers[0].name).toBe('test-provider');
  });

  it('includes worker statuses in report', async () => {
    const monitor = new HealthMonitor(config, []);
    monitor.recordWorkerHeartbeat('outbox-worker', true);
    monitor.recordWorkerHeartbeat('reconciliation-worker', true);

    const report = await monitor.getReport();
    expect(report.workers).toHaveLength(2);
  });

  it('handles backlog check failures gracefully', async () => {
    const backlog: BacklogProvider = {
      outboxPending: async () => { throw new Error('DB down'); },
      reconUnresolvedCritical: async () => 0,
    };
    const monitor = new HealthMonitor(config, [], backlog);

    const report = await monitor.getReport();
    expect(report.checks.some(c => c.name === 'outbox-backlog' && !c.healthy)).toBe(true);
  });

  it('isReady returns true when status is HEALTHY', async () => {
    const monitor = new HealthMonitor(config, []);
    expect(await monitor.isReady()).toBe(true);
  });

  it('isReady returns false when status is NOT_READY', async () => {
    const monitor = new HealthMonitor(config, []);
    monitor.setDbHealthy(false);
    expect(await monitor.isReady()).toBe(false);
  });

  it('isReady returns true when status is DEGRADED', async () => {
    const backlog: BacklogProvider = {
      outboxPending: async () => 15,
      reconUnresolvedCritical: async () => 0,
    };
    const monitor = new HealthMonitor(config, [], backlog);
    expect(await monitor.isReady()).toBe(true); // DEGRADED is still ready
  });
});
