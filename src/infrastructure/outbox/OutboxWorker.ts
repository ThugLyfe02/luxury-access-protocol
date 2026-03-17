import { OutboxRepository } from '../../domain/interfaces/OutboxRepository';
import { OutboxDispatcher } from './OutboxDispatcher';
import { classifyFailure } from './FailureClassifier';

export interface OutboxWorkerConfig {
  /** Unique worker ID for lease acquisition */
  readonly workerId: string;
  /** Max events to lease per poll cycle */
  readonly batchSize: number;
  /** Milliseconds between poll cycles */
  readonly pollIntervalMs: number;
  /** Events locked longer than this are considered stale (ms) */
  readonly staleLeaseThresholdMs: number;
}

const DEFAULT_CONFIG: OutboxWorkerConfig = {
  workerId: `worker-${process.pid}`,
  batchSize: 10,
  pollIntervalMs: 1000,
  staleLeaseThresholdMs: 60_000, // 1 minute
};

export interface OutboxWorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: OutboxWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Asynchronous outbox event processor.
 *
 * Lifecycle:
 * 1. Poll for PENDING events (leaseNextBatch)
 * 2. Dispatch each to its topic handler
 * 3. Mark succeeded or failed based on outcome
 * 4. Periodically recover stale leases from dead workers
 *
 * The worker is designed to run as a background loop in the server
 * process or as a standalone worker process.
 */
export class OutboxWorker {
  private readonly repo: OutboxRepository;
  private readonly dispatcher: OutboxDispatcher;
  private readonly config: OutboxWorkerConfig;
  private readonly logger: OutboxWorkerLogger;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    repo: OutboxRepository,
    dispatcher: OutboxDispatcher,
    config?: Partial<OutboxWorkerConfig>,
    logger?: OutboxWorkerLogger,
  ) {
    this.repo = repo;
    this.dispatcher = dispatcher;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger ?? noopLogger;
  }

  /**
   * Start the polling loop.
   * Non-blocking — returns immediately. The loop runs asynchronously.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('Outbox worker started', { workerId: this.config.workerId });
    this.scheduleNextPoll();
  }

  /**
   * Stop the polling loop gracefully.
   * In-flight processing will complete; no new polls will start.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info('Outbox worker stopped', { workerId: this.config.workerId });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Execute a single poll cycle.
   * Exposed publicly for testing — production uses start/stop.
   */
  async pollOnce(): Promise<number> {
    const now = new Date();
    let processed = 0;

    try {
      // 1. Recover stale leases
      await this.recoverStaleLeases(now);

      // 2. Lease next batch
      const events = await this.repo.leaseNextBatch(
        this.config.workerId,
        this.config.batchSize,
        now,
      );

      if (events.length === 0) return 0;

      this.logger.info('Leased outbox events', {
        count: events.length,
        workerId: this.config.workerId,
      });

      // 3. Process each event
      for (const event of events) {
        await this.processEvent(event);
        processed++;
      }
    } catch (error) {
      this.logger.error('Poll cycle error', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
    }

    return processed;
  }

  private async processEvent(event: import('../../domain/entities/OutboxEvent').OutboxEvent): Promise<void> {
    const now = new Date();

    try {
      const handler = this.dispatcher.getHandler(event.topic);
      const result = await handler.handle(event);

      event.markSucceeded(now, result);
      await this.repo.save(event);

      this.logger.info('Outbox event succeeded', {
        eventId: event.id,
        topic: event.topic,
        aggregateId: event.aggregateId,
      });
    } catch (error) {
      const classified = classifyFailure(error);

      this.logger.warn('Outbox event failed', {
        eventId: event.id,
        topic: event.topic,
        kind: classified.kind,
        message: classified.message,
        attemptCount: event.attemptCount,
        maxAttempts: event.maxAttempts,
      });

      event.markFailed(new Date(), classified.message, classified.kind === 'permanent');
      await this.repo.save(event);

      if (event.status === 'DEAD_LETTER') {
        this.logger.error('Outbox event moved to dead letter', {
          eventId: event.id,
          topic: event.topic,
          aggregateId: event.aggregateId,
          lastError: classified.message,
        });
      }
    }
  }

  private async recoverStaleLeases(now: Date): Promise<void> {
    const threshold = new Date(now.getTime() - this.config.staleLeaseThresholdMs);
    const staleEvents = await this.repo.findStaleLeases(threshold);

    for (const event of staleEvents) {
      event.releaseStaleLease(now);
      await this.repo.save(event);

      this.logger.warn('Released stale outbox lease', {
        eventId: event.id,
        topic: event.topic,
        previousWorker: event.lockedBy,
      });
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNextPoll();
    }, this.config.pollIntervalMs);
  }
}
