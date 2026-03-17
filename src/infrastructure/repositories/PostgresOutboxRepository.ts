import { PoolClient } from 'pg';
import { OutboxEvent, OutboxEventStatus, OutboxEventTopic } from '../../domain/entities/OutboxEvent';
import { OutboxRepository, OutboxDiagnostics } from '../../domain/interfaces/OutboxRepository';
import { PostgresClient } from '../db/PostgresClient';

/**
 * Row shape from the outbox_events table.
 */
interface OutboxRow {
  id: string;
  topic: OutboxEventTopic;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  dedup_key: string;
  status: OutboxEventStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: OutboxRow): OutboxEvent {
  return OutboxEvent.restore({
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    dedupKey: row.dedup_key,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: new Date(row.available_at),
    lockedAt: row.locked_at ? new Date(row.locked_at) : null,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    result: row.result,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

/**
 * PostgreSQL-backed outbox repository.
 *
 * leaseNextBatch uses SELECT ... FOR UPDATE SKIP LOCKED for
 * safe concurrent worker polling without blocking.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  async create(event: OutboxEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox_events (
        id, topic, aggregate_type, aggregate_id, payload, dedup_key,
        status, attempt_count, max_attempts, available_at,
        locked_at, locked_by, last_error, result, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        event.id,
        event.topic,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload),
        event.dedupKey,
        event.status,
        event.attemptCount,
        event.maxAttempts,
        event.availableAt,
        event.lockedAt,
        event.lockedBy,
        event.lastError,
        event.result ? JSON.stringify(event.result) : null,
        event.createdAt,
        event.updatedAt,
      ],
    );
  }

  async findById(id: string): Promise<OutboxEvent | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToEntity(rows[0] as OutboxRow);
  }

  async findByDedupKey(dedupKey: string): Promise<OutboxEvent | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events WHERE dedup_key = $1`,
      [dedupKey],
    );
    if (rows.length === 0) return null;
    return rowToEntity(rows[0] as OutboxRow);
  }

  /**
   * Atomic lease acquisition using FOR UPDATE SKIP LOCKED.
   *
   * This ensures multiple workers can poll concurrently without
   * double-processing: each worker gets a disjoint batch.
   */
  async leaseNextBatch(workerId: string, batchSize: number, now: Date): Promise<OutboxEvent[]> {
    const { rows } = await this.db.query(
      `UPDATE outbox_events
       SET status = 'PROCESSING',
           locked_at = $1,
           locked_by = $2,
           attempt_count = attempt_count + 1,
           updated_at = $1
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE status = 'PENDING' AND available_at <= $1
         ORDER BY available_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       RETURNING *`,
      [now, workerId, batchSize],
    );
    return rows.map((row) => rowToEntity(row as OutboxRow));
  }

  async save(event: OutboxEvent): Promise<void> {
    await this.db.query(
      `UPDATE outbox_events
       SET status = $2,
           attempt_count = $3,
           available_at = $4,
           locked_at = $5,
           locked_by = $6,
           last_error = $7,
           result = $8,
           updated_at = $9
       WHERE id = $1`,
      [
        event.id,
        event.status,
        event.attemptCount,
        event.availableAt,
        event.lockedAt,
        event.lockedBy,
        event.lastError,
        event.result ? JSON.stringify(event.result) : null,
        event.updatedAt,
      ],
    );
  }

  async findStaleLeases(olderThan: Date): Promise<OutboxEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events
       WHERE status = 'PROCESSING' AND locked_at < $1
       ORDER BY locked_at ASC`,
      [olderThan],
    );
    return rows.map((row) => rowToEntity(row as OutboxRow));
  }

  async findByStatus(status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events
       WHERE status = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [status, limit],
    );
    return rows.map((row) => rowToEntity(row as OutboxRow));
  }

  async findByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events
       WHERE aggregate_type = $1 AND aggregate_id = $2
       ORDER BY created_at ASC`,
      [aggregateType, aggregateId],
    );
    return rows.map((row) => rowToEntity(row as OutboxRow));
  }

  async findByTopicAndStatus(topic: OutboxEventTopic, status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM outbox_events
       WHERE topic = $1 AND status = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      [topic, status, limit],
    );
    return rows.map((row) => rowToEntity(row as OutboxRow));
  }

  async diagnostics(): Promise<OutboxDiagnostics> {
    const { rows } = await this.db.query(
      `SELECT status, COUNT(*)::int AS count FROM outbox_events GROUP BY status`,
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status as string] = row.count as number;
    }

    return {
      pending: counts['PENDING'] ?? 0,
      processing: counts['PROCESSING'] ?? 0,
      succeeded: counts['SUCCEEDED'] ?? 0,
      failed: counts['FAILED'] ?? 0,
      deadLetter: counts['DEAD_LETTER'] ?? 0,
    };
  }
}
