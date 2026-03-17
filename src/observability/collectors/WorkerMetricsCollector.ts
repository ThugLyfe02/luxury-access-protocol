/**
 * Collects outbox worker metrics.
 * Non-blocking. O(1) per operation.
 */

import { MetricsRegistry } from '../metrics/MetricsRegistry';

export class WorkerMetricsCollector {
  private readonly registry: MetricsRegistry;

  constructor(registry: MetricsRegistry) {
    this.registry = registry;
  }

  /** Record outbox event processing latency */
  recordOutboxProcessingLatency(ms: number): void {
    this.registry.histogram('outbox_processing_latency_ms').observe(ms);
  }

  /** Update outbox backlog gauge */
  setOutboxBacklogSize(size: number): void {
    this.registry.gauge('outbox_backlog_size').set(size);
  }

  /** Record a dead-letter event */
  recordDeadLetter(): void {
    this.registry.counter('outbox_dead_letter_total').increment();
  }

  /** Record successful outbox event processing */
  recordOutboxSuccess(): void {
    this.registry.counter('outbox_processing_success_total').increment();
  }

  /** Record failed outbox event processing */
  recordOutboxFailure(): void {
    this.registry.counter('outbox_processing_failure_total').increment();
  }
}
