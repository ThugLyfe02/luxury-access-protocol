import { Pool, PoolClient, QueryResult } from 'pg';
import { getPool } from './connection';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

/**
 * Retryable error codes from PostgreSQL.
 * These are transient failures that can be safely retried:
 * - 08006: connection_failure
 * - 08001: sqlclient_unable_to_establish_sqlconnection
 * - 08004: sqlserver_rejected_establishment_of_sqlconnection
 * - 40001: serialization_failure
 * - 40P01: deadlock_detected
 * - 57P01: admin_shutdown
 */
const RETRYABLE_PG_CODES = new Set([
  '08006', '08001', '08004', '40001', '40P01', '57P01',
]);

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PostgresClient wraps a Pool or PoolClient with retry-safe query execution.
 *
 * - On transient failures (connection drop, deadlock, serialization), retries
 *   with exponential backoff up to MAX_RETRIES.
 * - On non-transient failures, throws immediately — no silent swallowing.
 * - When wrapping a PoolClient (inside a transaction), retries are disabled
 *   because the transaction is already invalid after a failure.
 */
export class PostgresClient {
  private readonly executor: Pool | PoolClient;
  private readonly isTransaction: boolean;

  constructor(executor?: Pool | PoolClient, isTransaction?: boolean) {
    this.executor = executor ?? getPool();
    this.isTransaction = isTransaction ?? false;
  }

  /**
   * Execute a parameterized query with retry logic.
   * Never retries inside a transaction (the tx is already aborted).
   */
  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    if (this.isTransaction) {
      return this.executor.query(text, values);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.executor.query(text, values);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === MAX_RETRIES) {
          throw error;
        }

        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  /**
   * Create a transactional PostgresClient from a PoolClient.
   * Retries are disabled within transactions.
   */
  static fromTransaction(client: PoolClient): PostgresClient {
    return new PostgresClient(client, true);
  }
}
