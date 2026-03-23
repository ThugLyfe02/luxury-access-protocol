import { getPool } from '../db/connection';

export type WorkerType = 'api' | 'outbox' | 'reconciliation';
export type WorkerStatus = 'RUNNING' | 'STOPPED' | 'STALE';

export interface WorkerRegistration {
  readonly workerId: string;
  readonly workerType: WorkerType;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly status: WorkerStatus;
  readonly metadata: Record<string, unknown> | null;
}

/**
 * Postgres-backed worker registration and heartbeat service.
 *
 * Workers register on startup, heartbeat periodically, and
 * deregister on shutdown. Stale workers are detected by comparing
 * heartbeat_at to now() on the DB server (no clock-skew risk).
 */
export class WorkerRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs: number = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  /**
   * Register a worker in the cluster.
   */
  async register(workerId: string, workerType: WorkerType, metadata?: Record<string, unknown>): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO worker_registrations (worker_id, worker_type, status, metadata)
       VALUES ($1, $2, 'RUNNING', $3)
       ON CONFLICT (worker_id) DO UPDATE
       SET status = 'RUNNING', heartbeat_at = now(), started_at = now(), metadata = $3`,
      [workerId, workerType, metadata ? JSON.stringify(metadata) : null],
    );
  }

  /**
   * Send a heartbeat for a worker.
   */
  async heartbeat(workerId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE worker_registrations SET heartbeat_at = now() WHERE worker_id = $1 AND status = 'RUNNING'`,
      [workerId],
    );
  }

  /**
   * Mark a worker as STOPPED (graceful shutdown).
   */
  async deregister(workerId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE worker_registrations SET status = 'STOPPED', heartbeat_at = now() WHERE worker_id = $1`,
      [workerId],
    );
  }

  /**
   * Find workers whose heartbeat is older than the given threshold.
   */
  async findStaleWorkers(staleThresholdMs: number): Promise<WorkerRegistration[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT worker_id, worker_type, started_at, heartbeat_at, status, metadata
       FROM worker_registrations
       WHERE heartbeat_at < now() - ($1 || ' milliseconds')::interval
         AND status = 'RUNNING'`,
      [staleThresholdMs],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Mark stale workers as STALE.
   */
  async markStaleWorkers(staleThresholdMs: number): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE worker_registrations
       SET status = 'STALE'
       WHERE heartbeat_at < now() - ($1 || ' milliseconds')::interval
         AND status = 'RUNNING'`,
      [staleThresholdMs],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get all registered workers.
   */
  async getAll(): Promise<WorkerRegistration[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT worker_id, worker_type, started_at, heartbeat_at, status, metadata
       FROM worker_registrations
       ORDER BY started_at DESC`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * Get only RUNNING workers.
   */
  async getRunning(): Promise<WorkerRegistration[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT worker_id, worker_type, started_at, heartbeat_at, status, metadata
       FROM worker_registrations
       WHERE status = 'RUNNING'
       ORDER BY started_at DESC`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * Clean up old STOPPED entries (housekeeping).
   */
  async cleanupStopped(olderThanMs: number = 86_400_000): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM worker_registrations
       WHERE status IN ('STOPPED', 'STALE')
         AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
      [olderThanMs],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Start periodic heartbeat for a worker.
   */
  startHeartbeat(workerId: string): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat(workerId).catch(() => {
        // Heartbeat failure is non-fatal; next heartbeat will retry
      });
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop the periodic heartbeat.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function mapRow(row: Record<string, unknown>): WorkerRegistration {
  return {
    workerId: row.worker_id as string,
    workerType: row.worker_type as WorkerType,
    startedAt: new Date(row.started_at as string),
    heartbeatAt: new Date(row.heartbeat_at as string),
    status: row.status as WorkerStatus,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}
