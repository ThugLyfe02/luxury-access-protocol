-- Phase M: Multi-Instance Coordination Tables
-- Idempotent: safe to run multiple times (IF NOT EXISTS)

-- ============================================================
-- DISTRIBUTED LEASES
-- ============================================================
-- Postgres-backed singleton lease for coordinating exclusive
-- jobs (e.g., reconciliation sweep) across multiple instances.
-- All timestamp comparisons use DB now() to avoid clock skew.
-- ============================================================

CREATE TABLE IF NOT EXISTS distributed_leases (
  lease_name   TEXT        PRIMARY KEY,
  owner_id     TEXT        NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  renewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until  TIMESTAMPTZ NOT NULL,
  version      INTEGER     NOT NULL DEFAULT 1,
  metadata     JSONB
);

-- ============================================================
-- RATE LIMIT COUNTERS
-- ============================================================
-- Postgres-backed distributed rate limit counters.
-- Fixed-window counter with atomic upsert for cluster-wide
-- request rate enforcement.
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key          TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_cleanup
  ON rate_limit_counters (window_start);

-- ============================================================
-- WORKER REGISTRATIONS
-- ============================================================
-- Tracks all active worker instances across the cluster.
-- Heartbeat-based liveness detection. Workers update
-- heartbeat_at periodically; stale workers are detected
-- by comparing heartbeat_at to now().
-- ============================================================

CREATE TABLE IF NOT EXISTS worker_registrations (
  worker_id    TEXT        PRIMARY KEY,
  worker_type  TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT        NOT NULL DEFAULT 'RUNNING',
  metadata     JSONB
);

CREATE INDEX IF NOT EXISTS idx_worker_registrations_stale
  ON worker_registrations (heartbeat_at)
  WHERE status = 'RUNNING';
