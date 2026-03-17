/**
 * SLO evaluator. Computes rolling-window health from in-memory metrics.
 *
 * Returns healthy/degraded/critical for each SLO.
 * No external deps. Pure computation over metric snapshots.
 */

import {
  SLOHealth,
  SLOResult,
  SLO_RENTAL_SUCCESS,
  SLO_WEBHOOK_SUCCESS,
  SLO_RECONCILIATION_LAG,
  SLO_DEAD_LETTER_RATE,
} from './SLODefinitions';
import { MetricsRegistry } from '../metrics/MetricsRegistry';
import { ReconciliationDiagnostics } from '../../domain/interfaces/ReconciliationRepository';
import { OutboxDiagnostics } from '../../domain/interfaces/OutboxRepository';

/** Data sources for SLO evaluation */
export interface SLODataSources {
  getOutboxDiagnostics(): Promise<OutboxDiagnostics>;
  getReconciliationDiagnostics(): Promise<ReconciliationDiagnostics>;
}

function rateHealth(actual: number, target: number): SLOHealth {
  if (actual >= target) return 'healthy';
  if (actual >= target * 0.95) return 'degraded'; // within 5% of target
  return 'critical';
}

function lagHealth(actualMs: number, targetMs: number): SLOHealth {
  if (actualMs <= targetMs) return 'healthy';
  if (actualMs <= targetMs * 2) return 'degraded';
  return 'critical';
}

function maxPercentHealth(actual: number, target: number): SLOHealth {
  if (actual <= target) return 'healthy';
  if (actual <= target * 2) return 'degraded';
  return 'critical';
}

export class SLOEvaluator {
  private readonly registry: MetricsRegistry;
  private readonly dataSources: SLODataSources;

  constructor(registry: MetricsRegistry, dataSources: SLODataSources) {
    this.registry = registry;
    this.dataSources = dataSources;
  }

  async evaluate(): Promise<SLOResult[]> {
    const results: SLOResult[] = [];

    // 1. Rental success rate
    const rentalSuccess = this.registry.counter('rental_initiation_success_total').value;
    const rentalFailure = this.registry.counter('rental_initiation_failure_total').value;
    const rentalTotal = rentalSuccess + rentalFailure;
    const rentalRate = rentalTotal > 0 ? (rentalSuccess / rentalTotal) * 100 : 100;
    results.push({
      name: SLO_RENTAL_SUCCESS.name,
      status: rateHealth(rentalRate, SLO_RENTAL_SUCCESS.targetPercent!),
      currentValue: Math.round(rentalRate * 100) / 100,
      target: SLO_RENTAL_SUCCESS.targetPercent!,
      unit: '%',
      windowMs: SLO_RENTAL_SUCCESS.windowMs,
    });

    // 2. Webhook processing success
    const webhookTotal = this.registry.counter('webhook_events_total').value;
    const webhookDuplicates = this.registry.counter('webhook_duplicate_total').value;
    const webhookEffective = webhookTotal - webhookDuplicates;
    const webhookRate = webhookTotal > 0 ? (webhookEffective / webhookTotal) * 100 : 100;
    results.push({
      name: SLO_WEBHOOK_SUCCESS.name,
      status: rateHealth(webhookRate, SLO_WEBHOOK_SUCCESS.targetPercent!),
      currentValue: Math.round(webhookRate * 100) / 100,
      target: SLO_WEBHOOK_SUCCESS.targetPercent!,
      unit: '%',
      windowMs: SLO_WEBHOOK_SUCCESS.windowMs,
    });

    // 3. Reconciliation lag
    try {
      const reconDiag = await this.dataSources.getReconciliationDiagnostics();
      const lagMs = reconDiag.lastSuccessfulRun
        ? Date.now() - reconDiag.lastSuccessfulRun.getTime()
        : Infinity;
      const effectiveLag = lagMs === Infinity ? SLO_RECONCILIATION_LAG.targetMaxMs! * 10 : lagMs;
      results.push({
        name: SLO_RECONCILIATION_LAG.name,
        status: lagMs === Infinity ? 'critical' : lagHealth(lagMs, SLO_RECONCILIATION_LAG.targetMaxMs!),
        currentValue: Math.round(effectiveLag),
        target: SLO_RECONCILIATION_LAG.targetMaxMs!,
        unit: 'ms',
        windowMs: SLO_RECONCILIATION_LAG.windowMs,
      });
    } catch {
      results.push({
        name: SLO_RECONCILIATION_LAG.name,
        status: 'critical',
        currentValue: -1,
        target: SLO_RECONCILIATION_LAG.targetMaxMs!,
        unit: 'ms',
        windowMs: SLO_RECONCILIATION_LAG.windowMs,
      });
    }

    // 4. Dead-letter rate
    try {
      const outboxDiag = await this.dataSources.getOutboxDiagnostics();
      const total = outboxDiag.pending + outboxDiag.processing + outboxDiag.succeeded + outboxDiag.failed + outboxDiag.deadLetter;
      const dlRate = total > 0 ? (outboxDiag.deadLetter / total) * 100 : 0;
      results.push({
        name: SLO_DEAD_LETTER_RATE.name,
        status: maxPercentHealth(dlRate, SLO_DEAD_LETTER_RATE.targetMaxPercent!),
        currentValue: Math.round(dlRate * 1000) / 1000,
        target: SLO_DEAD_LETTER_RATE.targetMaxPercent!,
        unit: '%',
        windowMs: SLO_DEAD_LETTER_RATE.windowMs,
      });
    } catch {
      results.push({
        name: SLO_DEAD_LETTER_RATE.name,
        status: 'critical',
        currentValue: -1,
        target: SLO_DEAD_LETTER_RATE.targetMaxPercent!,
        unit: '%',
        windowMs: SLO_DEAD_LETTER_RATE.windowMs,
      });
    }

    return results;
  }
}
