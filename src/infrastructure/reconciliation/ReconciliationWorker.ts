import { ReconciliationEngine } from '../../application/services/ReconciliationEngine';

export interface ReconciliationWorkerConfig {
  readonly intervalMs: number;
  readonly triggeredBy: string;
}

const DEFAULT_CONFIG: ReconciliationWorkerConfig = {
  intervalMs: 300_000, // 5 minutes
  triggeredBy: 'reconciliation-worker',
};

/**
 * Periodic reconciliation worker.
 *
 * Runs a full sweep at a configurable interval.
 * Single-worker design — does not overlap runs.
 * If a sweep is in progress when the timer fires, the next sweep is skipped.
 */
export class ReconciliationWorker {
  private readonly engine: ReconciliationEngine;
  private readonly config: ReconciliationWorkerConfig;
  private running = false;
  private sweepInProgress = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(engine: ReconciliationEngine, config?: Partial<ReconciliationWorkerConfig>) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
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
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single sweep. Exposed for testing.
   */
  async runOnce(): Promise<void> {
    if (this.sweepInProgress) return;
    this.sweepInProgress = true;
    try {
      await this.engine.runFullSweep(this.config.triggeredBy);
    } finally {
      this.sweepInProgress = false;
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
