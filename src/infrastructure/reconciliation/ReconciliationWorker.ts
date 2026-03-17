import { ReconciliationEngine } from '../../application/services/ReconciliationEngine';
import { DistributedLeaseManager } from '../coordination/DistributedLeaseManager';

export interface ReconciliationWorkerConfig {
  readonly intervalMs: number;
  readonly triggeredBy: string;
}

const DEFAULT_CONFIG: ReconciliationWorkerConfig = {
  intervalMs: 300_000, // 5 minutes
  triggeredBy: 'reconciliation-worker',
};

const LEASE_NAME = 'reconciliation-sweep';

export interface ReconciliationWorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: ReconciliationWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Periodic reconciliation worker.
 *
 * Runs a full sweep at a configurable interval.
 * Single-worker design — does not overlap runs.
 * If a sweep is in progress when the timer fires, the next sweep is skipped.
 *
 * When a DistributedLeaseManager is provided, the worker acquires a cluster-wide
 * lease before running a sweep. Only one instance across the cluster can hold the
 * reconciliation-sweep lease at a time.
 */
export class ReconciliationWorker {
  private readonly engine: ReconciliationEngine;
  private readonly config: ReconciliationWorkerConfig;
  private readonly leaseManager: DistributedLeaseManager | null;
  private readonly workerId: string;
  private readonly logger: ReconciliationWorkerLogger;
  private running = false;
  private sweepInProgress = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    engine: ReconciliationEngine,
    config?: Partial<ReconciliationWorkerConfig>,
    leaseManager?: DistributedLeaseManager,
    workerId?: string,
    logger?: ReconciliationWorkerLogger,
  ) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.leaseManager = leaseManager ?? null;
    this.workerId = workerId ?? 'local';
    this.logger = logger ?? noopLogger;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopRenewal();
  }

  /**
   * Release the singleton lease (for graceful shutdown).
   */
  async releaseLease(): Promise<void> {
    if (this.leaseManager) {
      await this.leaseManager.release(LEASE_NAME, this.workerId);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single sweep. Exposed for testing.
   *
   * When a lease manager is configured:
   * 1. Attempt to acquire the singleton lease
   * 2. If acquired, run sweep with periodic lease renewal
   * 3. Release lease on completion
   * 4. If not acquired, skip (another instance holds the lease)
   */
  async runOnce(): Promise<void> {
    if (this.sweepInProgress) return;

    if (this.leaseManager) {
      await this.runWithLease();
    } else {
      await this.runLocal();
    }
  }

  private async runLocal(): Promise<void> {
    this.sweepInProgress = true;
    try {
      await this.engine.runFullSweep(this.config.triggeredBy);
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async runWithLease(): Promise<void> {
    const ttlMs = this.config.intervalMs * 2;

    const lease = await this.leaseManager!.acquire({
      leaseName: LEASE_NAME,
      ownerId: this.workerId,
      ttlMs,
      metadata: { triggeredBy: this.config.triggeredBy },
    });

    if (!lease) {
      this.logger.info('Reconciliation sweep skipped — lease held by another instance', {
        workerId: this.workerId,
      });
      return;
    }

    this.logger.info('Acquired reconciliation sweep lease', {
      workerId: this.workerId,
      leaseUntil: lease.leaseUntil.toISOString(),
    });

    this.sweepInProgress = true;
    let leaseValid = true;

    // Start periodic renewal (every intervalMs / 3)
    const renewalIntervalMs = Math.floor(this.config.intervalMs / 3);
    this.renewalTimer = setInterval(async () => {
      try {
        const renewed = await this.leaseManager!.renew(LEASE_NAME, this.workerId, ttlMs);
        if (!renewed) {
          leaseValid = false;
          this.logger.warn('Lease renewal failed — lease expired or stolen', {
            workerId: this.workerId,
          });
          this.stopRenewal();
        }
      } catch {
        // Renewal failure is non-fatal; will retry next interval
      }
    }, renewalIntervalMs);

    try {
      if (!leaseValid) {
        this.logger.warn('Aborting sweep — lease lost before execution', { workerId: this.workerId });
        return;
      }
      await this.engine.runFullSweep(this.config.triggeredBy);
    } finally {
      this.sweepInProgress = false;
      this.stopRenewal();
      // Release lease on completion (even if sweep failed)
      try {
        await this.leaseManager!.release(LEASE_NAME, this.workerId);
      } catch {
        // Release failure is non-fatal; lease will expire via TTL
      }
    }
  }

  private stopRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.runOnce();
      this.scheduleNext();
    }, this.config.intervalMs);
  }
}
