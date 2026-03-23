import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './connection';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_FILES = [
  'migration.sql',
  'migration-002-coordination.sql',
];

/**
 * Runs all schema migrations idempotently in order.
 * Safe to call on every startup — all DDL uses IF NOT EXISTS / DO $$.
 */
export async function runMigration(): Promise<void> {
  const pool = getPool();
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(__dirname, file), 'utf-8');
    await pool.query(sql);
  }
}
