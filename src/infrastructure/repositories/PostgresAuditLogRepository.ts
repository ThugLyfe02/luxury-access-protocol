import { PoolClient } from 'pg';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';
import { PostgresClient } from '../db/PostgresClient';

/**
 * PostgreSQL-backed audit log repository.
 * APPEND-ONLY: no updates, no deletes.
 */
export class PostgresAuditLogRepository implements AuditLogRepository {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  async log(entry: AuditLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (id, actor_id, action_type, entity_type, entity_id, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id, entry.actorId, entry.actionType,
        entry.entityType, entry.entityId,
        JSON.stringify(entry.metadata), entry.timestamp,
      ],
    );
  }

  async findByEntityId(entityId: string): Promise<ReadonlyArray<AuditLogEntry>> {
    const { rows } = await this.db.query(
      `SELECT id, actor_id, action_type, entity_type, entity_id, metadata, timestamp
       FROM audit_logs WHERE entity_id = $1 ORDER BY timestamp ASC`,
      [entityId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findByActorId(actorId: string): Promise<ReadonlyArray<AuditLogEntry>> {
    const { rows } = await this.db.query(
      `SELECT id, actor_id, action_type, entity_type, entity_id, metadata, timestamp
       FROM audit_logs WHERE actor_id = $1 ORDER BY timestamp ASC`,
      [actorId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  entries(): ReadonlyArray<AuditLogEntry> {
    throw new Error('entries() not supported on PostgresAuditLogRepository — use findByEntityId or findByActorId');
  }

  private hydrateRow(row: Record<string, unknown>): AuditLogEntry {
    const metadata = typeof row.metadata === 'string'
      ? JSON.parse(row.metadata)
      : row.metadata;

    return {
      id: row.id as string,
      actorId: row.actor_id as string,
      actionType: row.action_type as string,
      entityType: row.entity_type as string,
      entityId: row.entity_id as string,
      metadata: metadata as Record<string, unknown>,
      timestamp: new Date(row.timestamp as string),
    };
  }
}
