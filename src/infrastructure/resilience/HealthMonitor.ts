/**
 * Truthful health/readiness monitor.
 *
 * Three states:
 * - HEALTHY: all systems nominal
 * - DEGRADED: system partially operational, some non-critical services impaired
 * - NOT_READY: system cannot safely serve critical traffic
 *
 * Liveness ≠ readiness. A process can be alive but not ready.
 */

import { CircuitBreaker, CircuitBreakerDiagnostics } from './CircuitBreaker';
import { ResilienceConfig } from './ResilienceConfig';

export type SystemHealth = 'HEALTHY' | 'DEGRADED' | 'NOT_READY';

export interface HealthCheckResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly message?: string;
}

export interface WorkerStatus {
  readonly name: string;
  readonly running: boolean;
  readonly lastHeartbeat: Date | null;
  readonly consecutiveFailures: number;
}

export interface HealthReport {
  readonly status: SystemHealth;
  readonly checks: HealthCheckResult[];
  readonly degradedReasons: string[];
  readonly workers: WorkerStatus[];
  readonly breakers: CircuitBreakerDiagnostics[];
  readonly timestamp: Date;
}

export interface BacklogProvider {
  outboxPending(): Promise<number>;
  reconUnresolvedCritical(): Promise<number>;
}

export class HealthMonitor {
  private readonly config: ResilienceConfig;
  private readonly breakers: CircuitBreaker[];
  private readonly workerStatuses = new Map<string, WorkerStatus>();
  private readonly backlogProvider: BacklogProvider | null;
  private dbHealthy = true;

  constructor(
    config: ResilienceConfig,
    breakers: CircuitBreaker[],
    backlogProvider: BacklogProvider | null = null,
  ) {
    this.config = config;
    this.breakers = breakers;
    this.backlogProvider = backlogProvider;
  }

  /** Update DB connectivity status */
  setDbHealthy(healthy: boolean): void {
    this.dbHealthy = healthy;
  }

  /** Record worker heartbeat */
  recordWorkerHeartbeat(name: string, running: boolean, failures: number = 0): void {
    this.workerStatuses.set(name, {
      name,
      running,
      lastHeartbeat: new Date(),
      consecutiveFailures: failures,
    });
  }

  /** Liveness: is the process alive? Always true if this method is callable. */
  isAlive(): boolean {
    return true;
  }

  /** Readiness: can we safely serve critical traffic? */
  async isReady(): Promise<boolean> {
    const report = await this.getReport();
    return report.status !== 'NOT_READY';
  }

  /**
   * Full health report with all checks.
   */
  async getReport(): Promise<HealthReport> {
    const checks: HealthCheckResult[] = [];
    const degradedReasons: string[] = [];
    let notReady = false;

    // 1. DB connectivity
    checks.push({ name: 'database', healthy: this.dbHealthy });
    if (!this.dbHealthy) {
      notReady = true;
      degradedReasons.push('Database unavailable');
    }

    // 2. Circuit breakers
    for (const breaker of this.breakers) {
      const state = breaker.state;
      const healthy = state === 'CLOSED';
      checks.push({
        name: `breaker:${breaker.name}`,
        healthy,
        message: `state=${state}`,
      });
      if (state === 'OPEN') {
        degradedReasons.push(`Circuit breaker '${breaker.name}' is OPEN`);
        // Provider breaker open = degraded (not necessarily NOT_READY, depends on route)
      }
    }

    // 3. Worker health
    const now = Date.now();
    for (const ws of this.workerStatuses.values()) {
      const stale = ws.lastHeartbeat
        ? (now - ws.lastHeartbeat.getTime() > this.config.workerHeartbeatStaleMs)
        : true;
      const healthy = ws.running && !stale;
      checks.push({
        name: `worker:${ws.name}`,
        healthy,
        message: stale ? 'heartbeat stale' : ws.running ? 'running' : 'stopped',
      });
      if (!healthy && ws.name === 'outbox-worker') {
        degradedReasons.push(`Worker '${ws.name}' unhealthy`);
      }
    }

    // 4. Backlog thresholds
    if (this.backlogProvider) {
      try {
        const outboxPending = await this.backlogProvider.outboxPending();
        const outboxHealthy = outboxPending < this.config.outboxBacklogDegradedThreshold;
        checks.push({
          name: 'outbox-backlog',
          healthy: outboxHealthy,
          message: `pending=${outboxPending}`,
        });
        if (outboxPending >= this.config.outboxBacklogNotReadyThreshold) {
          notReady = true;
          degradedReasons.push(`Outbox backlog critical: ${outboxPending} pending`);
        } else if (outboxPending >= this.config.outboxBacklogDegradedThreshold) {
          degradedReasons.push(`Outbox backlog elevated: ${outboxPending} pending`);
        }
      } catch {
        checks.push({ name: 'outbox-backlog', healthy: false, message: 'check failed' });
        degradedReasons.push('Outbox backlog check failed');
      }

      try {
        const reconCritical = await this.backlogProvider.reconUnresolvedCritical();
        const reconHealthy = reconCritical < this.config.reconUnresolvedCriticalThreshold;
        checks.push({
          name: 'reconciliation-backlog',
          healthy: reconHealthy,
          message: `unresolved_critical=${reconCritical}`,
        });
        if (!reconHealthy) {
          degradedReasons.push(`Reconciliation: ${reconCritical} unresolved CRITICAL findings`);
        }
      } catch {
        checks.push({ name: 'reconciliation-backlog', healthy: false, message: 'check failed' });
      }
    }

    const status: SystemHealth = notReady ? 'NOT_READY' : degradedReasons.length > 0 ? 'DEGRADED' : 'HEALTHY';

    return {
      status,
      checks,
      degradedReasons,
      workers: Array.from(this.workerStatuses.values()),
      breakers: this.breakers.map(b => b.diagnostics()),
      timestamp: new Date(),
    };
  }
}
