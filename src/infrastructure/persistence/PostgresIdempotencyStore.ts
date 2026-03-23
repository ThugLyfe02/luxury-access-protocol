import { PoolClient } from 'pg';
import { IdempotencyStore, IdempotencyRecord } from '../../http/idempotency/IdempotencyStore';
import { PostgresClient } from '../db/PostgresClient';

/**
 * PostgreSQL-backed idempotency store.
 * Survives process restarts — keys are persisted in the DB.
 *
 * Guarantees:
 * - Same key + same hash → return cached response
 * - Same key + different hash → caller detects conflict via payloadHash mismatch
 * - New key → null (proceed)
 * - PK constraint prevents duplicate inserts under concurrency
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  async find(key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(
      `SELECT key, payload_hash, response_status, response_body, created_at
       FROM idempotency_keys WHERE key = $1`,
      [key],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      key: row.key as string,
      payloadHash: row.payload_hash as string,
      responseStatus: row.response_status as number,
      responseBody: row.response_body as string,
      createdAt: new Date(row.created_at as string),
    };
  }

  async save(record: IdempotencyRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO idempotency_keys (key, payload_hash, response_status, response_body, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING`,
      [record.key, record.payloadHash, record.responseStatus, record.responseBody, record.createdAt],
    );
  }
}
