import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './connection';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Runs the schema migration idempotently.
 * Safe to call on every startup — all DDL uses IF NOT EXISTS / DO $$.
 */
export async function runMigration(): Promise<void> {
  const sql = readFileSync(resolve(__dirname, 'migration.sql'), 'utf-8');
  const pool = getPool();
  await pool.query(sql);
}
