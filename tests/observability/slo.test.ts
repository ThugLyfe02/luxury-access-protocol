import { describe, it, expect, beforeEach } from 'vitest';
import { SLOEvaluator } from '../../src/observability/slos/SLOEvaluator';
import { MetricsRegistry } from '../../src/observability/metrics/MetricsRegistry';

describe('SLOEvaluator', () => {
  let registry: MetricsRegistry;
  let evaluator: SLOEvaluator;

  const mockDataSources = {
    getOutboxDiagnostics: async () => ({
      pending: 0,
      processing: 0,
      succeeded: 100,
      failed: 0,
      deadLetter: 0,
    }),
    getReconciliationDiagnostics: async () => ({
      unresolvedCount: 0,
      countBySeverity: {},
      countByDriftType: {},
      lastSuccessfulRun: new Date(),
      lastFailedRun: null,
      repairSuccessCount: 0,
      oldestUnresolvedFinding: null,
    }),
  };

  beforeEach(() => {
    MetricsRegistry.resetForTesting();
    registry = MetricsRegistry.getInstance();
    evaluator = new SLOEvaluator(registry, mockDataSources);
  });

  it('all SLOs are healthy with no traffic', async () => {
    const results = await evaluator.evaluate();
    expect(results).toHaveLength(4);
    expect(results.every(r => r.status === 'healthy')).toBe(true);
  });

  it('rental success rate is healthy at 100%', async () => {
    registry.counter('rental_initiation_success_total').increment(100);
    const results = await evaluator.evaluate();
    const rental = results.find(r => r.name === 'rental_success_rate')!;
    expect(rental.status).toBe('healthy');
    expect(rental.currentValue).toBe(100);
  });

  it('rental success rate is degraded near target', async () => {
    registry.counter('rental_initiation_success_total').increment(95);
    registry.counter('rental_initiation_failure_total').increment(5);
    const results = await evaluator.evaluate();
    const rental = results.find(r => r.name === 'rental_success_rate')!;
    expect(rental.status).toBe('degraded');
  });

  it('rental success rate is critical below threshold', async () => {
    registry.counter('rental_initiation_success_total').increment(90);
    registry.counter('rental_initiation_failure_total').increment(10);
    const results = await evaluator.evaluate();
    const rental = results.find(r => r.name === 'rental_success_rate')!;
    expect(rental.status).toBe('critical');
  });

  it('webhook success rate tracks duplicates', async () => {
    registry.counter('webhook_events_total').increment(1000);
    registry.counter('webhook_duplicate_total').increment(1);

    const results = await evaluator.evaluate();
    const webhook = results.find(r => r.name === 'webhook_processing_success')!;
    expect(webhook.status).toBe('healthy');
    expect(webhook.currentValue).toBe(99.9);
  });

  it('reconciliation lag is critical when no run exists', async () => {
    const noRunDataSources = {
      ...mockDataSources,
      getReconciliationDiagnostics: async () => ({
        unresolvedCount: 0,
        countBySeverity: {},
        countByDriftType: {},
        lastSuccessfulRun: null,
        lastFailedRun: null,
        repairSuccessCount: 0,
        oldestUnresolvedFinding: null,
      }),
    };

    const eval2 = new SLOEvaluator(registry, noRunDataSources);
    const results = await eval2.evaluate();
    const recon = results.find(r => r.name === 'reconciliation_completion_lag')!;
    expect(recon.status).toBe('critical');
  });

  it('dead letter rate is healthy at 0%', async () => {
    const results = await evaluator.evaluate();
    const dl = results.find(r => r.name === 'dead_letter_rate')!;
    expect(dl.status).toBe('healthy');
    expect(dl.currentValue).toBe(0);
  });

  it('dead letter rate is critical when high', async () => {
    const highDLDataSources = {
      ...mockDataSources,
      getOutboxDiagnostics: async () => ({
        pending: 0,
        processing: 0,
        succeeded: 90,
        failed: 0,
        deadLetter: 10,
      }),
    };

    const eval2 = new SLOEvaluator(registry, highDLDataSources);
    const results = await eval2.evaluate();
    const dl = results.find(r => r.name === 'dead_letter_rate')!;
    expect(dl.status).toBe('critical');
    expect(dl.currentValue).toBe(10);
  });

  it('handles data source errors gracefully', async () => {
    const failingDataSources = {
      getOutboxDiagnostics: async () => { throw new Error('DB down'); },
      getReconciliationDiagnostics: async () => { throw new Error('DB down'); },
    };

    const eval2 = new SLOEvaluator(registry, failingDataSources);
    const results = await eval2.evaluate();

    const recon = results.find(r => r.name === 'reconciliation_completion_lag')!;
    expect(recon.status).toBe('critical');

    const dl = results.find(r => r.name === 'dead_letter_rate')!;
    expect(dl.status).toBe('critical');
  });

  it('returns correct units and targets', async () => {
    const results = await evaluator.evaluate();

    const rental = results.find(r => r.name === 'rental_success_rate')!;
    expect(rental.unit).toBe('%');
    expect(rental.target).toBe(99);

    const webhook = results.find(r => r.name === 'webhook_processing_success')!;
    expect(webhook.unit).toBe('%');
    expect(webhook.target).toBe(99.5);

    const recon = results.find(r => r.name === 'reconciliation_completion_lag')!;
    expect(recon.unit).toBe('ms');
    expect(recon.target).toBe(300_000);

    const dl = results.find(r => r.name === 'dead_letter_rate')!;
    expect(dl.unit).toBe('%');
    expect(dl.target).toBe(0.1);
  });
});
