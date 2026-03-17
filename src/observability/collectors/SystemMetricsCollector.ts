/**
 * Collects system-level metrics from resilience infrastructure.
 *
 * Pulls current state from circuit breakers, rate limiters, and health monitor.
 * Non-blocking. No domain mutation.
 */

import { MetricsRegistry } from '../metrics/MetricsRegistry';
import { CircuitBreaker } from '../../infrastructure/resilience/CircuitBreaker';

export class SystemMetricsCollector {
  private readonly registry: MetricsRegistry;
  private readonly breakers: CircuitBreaker[];

  constructor(registry: MetricsRegistry, breakers: CircuitBreaker[]) {
    this.registry = registry;
    this.breakers = breakers;
  }

  /** Record a circuit breaker trip (CLOSED→OPEN) */
  recordBreakerTrip(component: string): void {
    this.registry.counter('circuit_breaker_open_total', { component }).increment();
  }

  /** Record a circuit breaker half-open probe */
  recordBreakerHalfOpen(): void {
    this.registry.counter('circuit_breaker_half_open_total').increment();
  }

  /** Record a timeout occurrence */
  recordTimeout(component: string): void {
    this.registry.counter('timeout_total', { component }).increment();
  }

  /** Record a retry attempt */
  recordRetry(category: string): void {
    this.registry.counter('retry_total', { category }).increment();
  }

  /** Record retry exhaustion */
  recordRetryExhausted(): void {
    this.registry.counter('retry_exhausted_total').increment();
  }

  /** Record a rate limit rejection */
  recordRateLimitRejection(route: string): void {
    this.registry.counter('rate_limit_rejections_total', { route }).increment();
  }

  /** Record a concurrency limit rejection */
  recordConcurrencyRejection(component: string): void {
    this.registry.counter('concurrency_rejections_total', { component }).increment();
  }

  /** Record an idempotency cache hit */
  recordIdempotencyHit(): void {
    this.registry.counter('idempotency_hits_total').increment();
  }

  /** Record an idempotency conflict */
  recordIdempotencyConflict(): void {
    this.registry.counter('idempotency_conflicts_total').increment();
  }

  /** Update breaker state gauges from current breaker state */
  refreshBreakerGauges(): void {
    for (const breaker of this.breakers) {
      const state = breaker.state;
      this.registry.gauge('circuit_breaker_state', { component: breaker.name })
        .set(state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2);
    }
  }
}
