/**
 * Collects reconciliation metrics.
 * Non-blocking. O(1) per operation.
 */

import { MetricsRegistry } from '../metrics/MetricsRegistry';

export class ReconciliationMetricsCollector {
  private readonly registry: MetricsRegistry;

  constructor(registry: MetricsRegistry) {
    this.registry = registry;
  }

  /** Record a reconciliation run completion */
  recordRun(): void {
    this.registry.counter('reconciliation_runs_total').increment();
  }

  /** Record a critical finding */
  recordCriticalFinding(): void {
    this.registry.counter('reconciliation_critical_findings_total').increment();
  }

  /** Record an auto-repair */
  recordAutoRepair(): void {
    this.registry.counter('reconciliation_auto_repairs_total').increment();
  }

  /** Record a manual review required */
  recordManualRequired(): void {
    this.registry.counter('reconciliation_manual_required_total').increment();
  }

  /** Record a webhook event */
  recordWebhookEvent(): void {
    this.registry.counter('webhook_events_total').increment();
  }

  /** Record a duplicate webhook */
  recordWebhookDuplicate(): void {
    this.registry.counter('webhook_duplicate_total').increment();
  }

  /** Record webhook processing latency */
  recordWebhookLatency(ms: number): void {
    this.registry.histogram('webhook_processing_latency_ms').observe(ms);
  }

  /** Record rental initiation success */
  recordRentalSuccess(): void {
    this.registry.counter('rental_initiation_success_total').increment();
  }

  /** Record rental initiation failure */
  recordRentalFailure(): void {
    this.registry.counter('rental_initiation_failure_total').increment();
  }
}
