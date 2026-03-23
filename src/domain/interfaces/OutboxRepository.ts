import { OutboxEvent, OutboxEventStatus, OutboxEventTopic } from '../entities/OutboxEvent';

/**
 * Outbox event diagnostics snapshot.
 * Used by admin dashboards and health checks.
 */
export interface OutboxDiagnostics {
  readonly pending: number;
  readonly processing: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLetter: number;
}

/**
 * Repository for durable outbox events.
 *
 * Production path: Postgres-backed.
 * Test path: InMemory for unit/integration tests.
 *
 * All write operations are expected to be called within
 * the same DB transaction as the originating domain state change.
 */
export interface OutboxRepository {
  /**
   * Persist a new outbox event.
   * Must be called within the same transaction as the domain state change.
   * Throws on dedup_key conflict (duplicate side effect).
   */
  create(event: OutboxEvent): Promise<void>;

  /**
   * Find an event by ID.
   */
  findById(id: string): Promise<OutboxEvent | null>;

  /**
   * Find an event by its dedup key.
   */
  findByDedupKey(dedupKey: string): Promise<OutboxEvent | null>;

  /**
   * Lease the next batch of PENDING events whose availableAt <= now.
   * Atomically transitions them to PROCESSING and sets lock metadata.
   * Returns the leased events.
   *
   * @param workerId - Unique identifier of the polling worker
   * @param batchSize - Max events to lease in one poll
   * @param now - Current timestamp (injectable for testing)
   */
  leaseNextBatch(workerId: string, batchSize: number, now: Date): Promise<OutboxEvent[]>;

  /**
   * Save an event after processing (succeeded, failed, dead-lettered).
   * The caller is responsible for calling the appropriate entity method
   * (markSucceeded, markFailed, etc.) before saving.
   */
  save(event: OutboxEvent): Promise<void>;

  /**
   * Find PROCESSING events with locks older than the given threshold.
   * Used by the stale lease recovery process.
   */
  findStaleLeases(olderThan: Date): Promise<OutboxEvent[]>;

  /**
   * Find events by status, ordered by creation date.
   * Used for dead-letter inspection and diagnostics.
   */
  findByStatus(status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]>;

  /**
   * Find all events for a given aggregate.
   */
  findByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxEvent[]>;

  /**
   * Find events by topic and status.
   */
  findByTopicAndStatus(topic: OutboxEventTopic, status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]>;

  /**
   * Get diagnostic counts by status.
   */
  diagnostics(): Promise<OutboxDiagnostics>;
}
