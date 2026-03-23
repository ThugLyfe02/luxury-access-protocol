/**
 * System diagnostics service.
 *
 * Provides structured snapshots of system state for admin visibility.
 * Read-only. No domain mutation. Non-blocking where possible.
 */

import { CircuitBreaker, CircuitBreakerDiagnostics } from '../../infrastructure/resilience/CircuitBreaker';
import { HealthMonitor, WorkerStatus, HealthCheckResult } from '../../infrastructure/resilience/HealthMonitor';
import { OutboxDiagnostics } from '../../domain/interfaces/OutboxRepository';
import { ReconciliationDiagnostics } from '../../domain/interfaces/ReconciliationRepository';
import { MetricsRegistry } from '../metrics/MetricsRegistry';

export interface SystemSnapshot {
  readonly timestamp: string;
  readonly breakers: CircuitBreakerDiagnostics[];
  readonly workers: WorkerStatus[];
  readonly healthChecks: HealthCheckResult[];
  readonly outbox: OutboxDiagnostics;
  readonly reconciliation: ReconciliationDiagnostics;
  readonly metricsCount: number;
}

export interface OutboxDiagnosticsSnapshot {
  readonly backlogSize: number;
  readonly deadLetterCount: number;
  readonly processingCount: number;
  readonly succeededCount: number;
}

export interface ReconciliationDiagnosticsSnapshot {
  readonly unresolvedCriticalCount: number;
  readonly lastSuccessfulRun: string | null;
  readonly lastFailedRun: string | null;
  readonly repairSuccessCount: number;
  readonly oldestUnresolvedFinding: string | null;
}

export interface DiagnosticsDataSources {
  getOutboxDiagnostics(): Promise<OutboxDiagnostics>;
  getReconciliationDiagnostics(): Promise<ReconciliationDiagnostics>;
}

export class SystemDiagnosticsService {
  private readonly breakers: CircuitBreaker[];
  private readonly healthMonitor: HealthMonitor;
  private readonly dataSources: DiagnosticsDataSources;
  private readonly registry: MetricsRegistry;

  constructor(
    breakers: CircuitBreaker[],
    healthMonitor: HealthMonitor,
    dataSources: DiagnosticsDataSources,
    registry: MetricsRegistry,
  ) {
    this.breakers = breakers;
    this.healthMonitor = healthMonitor;
    this.dataSources = dataSources;
    this.registry = registry;
  }

  async getSystemSnapshot(): Promise<SystemSnapshot> {
    const healthReport = await this.healthMonitor.getReport();
    const outbox = await this.dataSources.getOutboxDiagnostics();
    const reconciliation = await this.dataSources.getReconciliationDiagnostics();

    return {
      timestamp: new Date().toISOString(),
      breakers: this.breakers.map(b => b.diagnostics()),
      workers: healthReport.workers,
      healthChecks: healthReport.checks,
      outbox,
      reconciliation,
      metricsCount: this.registry.getSnapshot().length,
    };
  }

  async getOutboxDiagnostics(): Promise<OutboxDiagnosticsSnapshot> {
    const diag = await this.dataSources.getOutboxDiagnostics();
    return {
      backlogSize: diag.pending + diag.processing,
      deadLetterCount: diag.deadLetter,
      processingCount: diag.processing,
      succeededCount: diag.succeeded,
    };
  }

  async getReconciliationDiagnostics(): Promise<ReconciliationDiagnosticsSnapshot> {
    const diag = await this.dataSources.getReconciliationDiagnostics();
    return {
      unresolvedCriticalCount: diag.countBySeverity['CRITICAL'] ?? 0,
      lastSuccessfulRun: diag.lastSuccessfulRun?.toISOString() ?? null,
      lastFailedRun: diag.lastFailedRun?.toISOString() ?? null,
      repairSuccessCount: diag.repairSuccessCount,
      oldestUnresolvedFinding: diag.oldestUnresolvedFinding?.toISOString() ?? null,
    };
  }

  getWorkerStatus(): WorkerStatus[] {
    // Pull from health monitor report synchronously via cached worker data
    return Array.from((this.healthMonitor as any).workerStatuses?.values?.() ?? []);
  }
}
