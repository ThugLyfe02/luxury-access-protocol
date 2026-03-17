import { PoolClient } from 'pg';
import { ProcessedWebhookEventStore } from '../../http/webhookController';
import { PostgresClient } from '../db/PostgresClient';

/**
 * PostgreSQL-backed webhook event store.
 * Survives process restarts — event IDs are persisted.
 *
 * The UNIQUE constraint on external_event_id prevents double-processing
 * even under concurrent webhook deliveries from the payment provider.
 */
export class PostgresWebhookEventStore implements ProcessedWebhookEventStore {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  async has(eventId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM processed_webhook_events WHERE external_event_id = $1`,
      [eventId],
    );
    return rows.length > 0;
  }

  async add(eventId: string, rentalId: string, eventType: string): Promise<void> {
    await this.db.query(
      `INSERT INTO processed_webhook_events (external_event_id, rental_id, event_type, processed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (external_event_id) DO NOTHING`,
      [eventId, rentalId, eventType],
    );
  }
}
