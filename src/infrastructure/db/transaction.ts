import { Pool, PoolClient } from 'pg';
import { getPool } from './connection';

/**
 * Executes `fn` inside a single database transaction.
 *
 * - BEGIN is issued before `fn` runs.
 * - COMMIT is issued if `fn` resolves.
 * - ROLLBACK is issued if `fn` rejects (the original error is re-thrown).
 * - The PoolClient is always released back to the pool.
 *
 * Callers pass the PoolClient to repository methods so all reads
 * and writes within a single business operation share one transaction.
 */
export async function runInTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  pool?: Pool,
): Promise<T> {
  const p = pool ?? getPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
