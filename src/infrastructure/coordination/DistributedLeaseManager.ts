import { getPool } from '../db/connection';

export interface Lease {
  readonly leaseName: string;
  readonly ownerId: string;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  readonly leaseUntil: Date;
  readonly version: number;
  readonly metadata: Record<string, unknown> | null;
}

export interface LeaseAcquireOptions {
  readonly leaseName: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Postgres-backed distributed lease manager.
 *
 * Provides acquire/renew/release/recover for singleton job coordination.
 * All timestamp comparisons use DB now() to avoid clock skew between pods.
 *
 * Non-blocking: acquire returns null if the lease is already held.
 */
export class DistributedLeaseManager {
  /**
   * Try to acquire a lease. Non-blocking.
   * Returns the lease if acquired, null if already held by another owner.
   */
  async acquire(opts: LeaseAcquireOptions): Promise<Lease | null> {
    const pool = getPool();

    // First, try to clean up expired leases for this name
    await pool.query(
      `DELETE FROM distributed_leases WHERE lease_name = $1 AND lease_until < now()`,
      [opts.leaseName],
    );

    // Then try to insert
    const result = await pool.query(
      `INSERT INTO distributed_leases (lease_name, owner_id, lease_until, metadata)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4)
       ON CONFLICT (lease_name) DO NOTHING
       RETURNING lease_name, owner_id, acquired_at, renewed_at, lease_until, version, metadata`,
      [opts.leaseName, opts.ownerId, opts.ttlMs, opts.metadata ? JSON.stringify(opts.metadata) : null],
    );

    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Renew a lease. Only succeeds if the caller still owns it and it hasn't expired.
   * Returns the renewed lease, or null if renewal failed (expired/stolen).
   */
  async renew(leaseName: string, ownerId: string, ttlMs: number): Promise<Lease | null> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE distributed_leases
       SET renewed_at = now(), lease_until = now() + ($3 || ' milliseconds')::interval, version = version + 1
       WHERE lease_name = $1 AND owner_id = $2 AND lease_until > now()
       RETURNING lease_name, owner_id, acquired_at, renewed_at, lease_until, version, metadata`,
      [leaseName, ownerId, ttlMs],
    );

    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Release a lease explicitly (graceful shutdown).
   * Only the owner can release their own lease.
   */
  async release(leaseName: string, ownerId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM distributed_leases WHERE lease_name = $1 AND owner_id = $2`,
      [leaseName, ownerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Release all leases held by a specific owner (used during shutdown).
   */
  async releaseAll(ownerId: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM distributed_leases WHERE owner_id = $1`,
      [ownerId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get the current holder of a lease, if any.
   */
  async get(leaseName: string): Promise<Lease | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT lease_name, owner_id, acquired_at, renewed_at, lease_until, version, metadata
       FROM distributed_leases
       WHERE lease_name = $1 AND lease_until > now()`,
      [leaseName],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Get all active leases (for admin visibility).
   */
  async getAll(): Promise<Lease[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT lease_name, owner_id, acquired_at, renewed_at, lease_until, version, metadata
       FROM distributed_leases
       WHERE lease_until > now()
       ORDER BY acquired_at DESC`,
    );
    return result.rows.map(mapRow);
  }
}

function mapRow(row: Record<string, unknown>): Lease {
  return {
    leaseName: row.lease_name as string,
    ownerId: row.owner_id as string,
    acquiredAt: new Date(row.acquired_at as string),
    renewedAt: new Date(row.renewed_at as string),
    leaseUntil: new Date(row.lease_until as string),
    version: row.version as number,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}
