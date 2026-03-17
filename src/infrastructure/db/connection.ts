import { Pool } from 'pg';

let pool: Pool | null = null;

/**
 * Returns a singleton connection pool backed by DATABASE_URL.
 * Fails fast if DATABASE_URL is not set.
 */
export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is required but not set',
    );
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
}

/**
 * Gracefully shuts down the pool. Call once during process shutdown.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
