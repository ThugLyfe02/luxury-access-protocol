-- luxury-access-protocol schema migration
-- Idempotent: safe to run multiple times (IF NOT EXISTS / CREATE OR REPLACE)

-- ============================================================
-- ENUM TYPES
-- ============================================================

DO $$ BEGIN
  CREATE TYPE marketplace_role AS ENUM ('RENTER', 'OWNER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('UNVERIFIED', 'VERIFIED_BY_PARTNER', 'VERIFIED_IN_VAULT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE escrow_status AS ENUM (
    'NOT_STARTED',
    'AWAITING_EXTERNAL_PAYMENT',
    'EXTERNAL_PAYMENT_AUTHORIZED',
    'EXTERNAL_PAYMENT_CAPTURED',
    'FUNDS_RELEASED_TO_OWNER',
    'DISPUTED',
    'REFUNDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  role          marketplace_role    NOT NULL,
  trust_score   INTEGER             NOT NULL CHECK (trust_score >= 0 AND trust_score <= 100),
  chargebacks_count INTEGER         NOT NULL DEFAULT 0 CHECK (chargebacks_count >= 0),
  disputes_count    INTEGER         NOT NULL DEFAULT 0 CHECK (disputes_count >= 0),
  is_frozen     BOOLEAN             NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  version       INTEGER             NOT NULL DEFAULT 0 CHECK (version >= 0)
);

-- ============================================================
-- WATCHES
-- ============================================================

CREATE TABLE IF NOT EXISTS watches (
  id                  UUID PRIMARY KEY,
  owner_id            UUID                NOT NULL REFERENCES users(id),
  market_value        NUMERIC(12,2)       NOT NULL CHECK (market_value > 0),
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  is_available        BOOLEAN             NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ         NOT NULL DEFAULT now(),
  version             INTEGER             NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_watches_owner_id ON watches(owner_id);

-- ============================================================
-- RENTALS
-- ============================================================

CREATE TABLE IF NOT EXISTS rentals (
  id                          UUID PRIMARY KEY,
  renter_id                   UUID          NOT NULL REFERENCES users(id),
  watch_id                    UUID          NOT NULL REFERENCES watches(id),
  rental_price                NUMERIC(12,2) NOT NULL CHECK (rental_price > 0),
  escrow_status               escrow_status NOT NULL DEFAULT 'NOT_STARTED',
  external_payment_intent_id  TEXT,
  external_transfer_id        TEXT,
  return_confirmed            BOOLEAN       NOT NULL DEFAULT FALSE,
  dispute_open                BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  version                     INTEGER       NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rentals_renter_id ON rentals(renter_id);
CREATE INDEX IF NOT EXISTS idx_rentals_watch_id ON rentals(watch_id);
CREATE INDEX IF NOT EXISTS idx_rentals_external_payment_intent_id
  ON rentals(external_payment_intent_id)
  WHERE external_payment_intent_id IS NOT NULL;

-- ============================================================
-- DOUBLE-RENTAL PREVENTION (CRITICAL)
-- ============================================================
-- A partial unique index that prevents two non-terminal rentals
-- for the same watch. Terminal states (FUNDS_RELEASED_TO_OWNER,
-- REFUNDED) are excluded, so a watch can have many completed
-- rentals but at most ONE active rental.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_rentals_one_active_per_watch
  ON rentals(watch_id)
  WHERE escrow_status NOT IN ('FUNDS_RELEASED_TO_OWNER', 'REFUNDED');

-- ============================================================
-- OWNER CONNECTED ACCOUNTS (Stripe Connect)
-- ============================================================
-- Stores the external payment provider's connected account ID
-- for watch owners. Decoupled from the User domain entity to
-- keep payment-provider concerns out of the domain layer.
-- ============================================================

CREATE TABLE IF NOT EXISTS owner_connected_accounts (
  user_id               UUID PRIMARY KEY REFERENCES users(id),
  connected_account_id  TEXT        NOT NULL,
  onboarding_complete   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_connected_accounts_account_id
  ON owner_connected_accounts(connected_account_id);

-- ============================================================
-- PROCESSED WEBHOOK EVENTS (Idempotency)
-- ============================================================
-- Tracks external webhook event IDs that have been successfully
-- processed. Prevents duplicate event processing across restarts.
-- The unique constraint on external_event_id ensures at-most-once
-- semantics even under concurrent delivery.
-- ============================================================

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id TEXT        NOT NULL UNIQUE,
  rental_id         TEXT        NOT NULL,
  event_type        TEXT        NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
  ON processed_webhook_events(processed_at);

-- ============================================================
-- ENUM: insurance_claim_status
-- ============================================================

DO $$ BEGIN
  CREATE TYPE insurance_claim_status AS ENUM (
    'FILED', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'PAID_OUT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: review_status
-- ============================================================

DO $$ BEGIN
  CREATE TYPE review_status AS ENUM (
    'OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: review_severity
-- ============================================================

DO $$ BEGIN
  CREATE TYPE review_severity AS ENUM (
    'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: freezable_entity_type
-- ============================================================

DO $$ BEGIN
  CREATE TYPE freezable_entity_type AS ENUM ('USER', 'WATCH', 'RENTAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- INSURANCE CLAIMS
-- ============================================================

CREATE TABLE IF NOT EXISTS claims (
  id              UUID PRIMARY KEY,
  policy_id       TEXT                   NOT NULL,
  rental_id       TEXT                   NOT NULL,
  watch_id        TEXT                   NOT NULL,
  claim_amount    NUMERIC(12,2)          NOT NULL CHECK (claim_amount > 0),
  reason          TEXT                   NOT NULL,
  filed_at        TIMESTAMPTZ            NOT NULL,
  status          insurance_claim_status NOT NULL DEFAULT 'FILED',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  paid_out_at     TIMESTAMPTZ,
  payout_amount   NUMERIC(12,2),
  denial_reason   TEXT,
  created_at      TIMESTAMPTZ            NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ            NOT NULL DEFAULT now(),
  version         INTEGER                NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_claims_rental_id ON claims(rental_id);
CREATE INDEX IF NOT EXISTS idx_claims_watch_id ON claims(watch_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);

-- ============================================================
-- MANUAL REVIEWS
-- ============================================================

CREATE TABLE IF NOT EXISTS manual_reviews (
  id              UUID PRIMARY KEY,
  rental_id       TEXT                NOT NULL,
  severity        review_severity     NOT NULL,
  reason          TEXT                NOT NULL,
  status          review_status       NOT NULL DEFAULT 'OPEN',
  assigned_to     TEXT,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT,
  freeze_targets  JSONB               NOT NULL DEFAULT '[]'::jsonb,
  sla_deadline    TIMESTAMPTZ         NOT NULL,
  notes           JSONB               NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT now(),
  version         INTEGER             NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_manual_reviews_rental_id ON manual_reviews(rental_id);
CREATE INDEX IF NOT EXISTS idx_manual_reviews_status ON manual_reviews(status);

-- ============================================================
-- SYSTEM FREEZES
-- ============================================================

CREATE TABLE IF NOT EXISTS freezes (
  id              UUID PRIMARY KEY,
  entity_type     freezable_entity_type NOT NULL,
  entity_id       TEXT                  NOT NULL,
  reason          TEXT                  NOT NULL,
  frozen_by       TEXT                  NOT NULL,
  active          BOOLEAN               NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ           NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_freezes_entity
  ON freezes(entity_type, entity_id)
  WHERE active = TRUE;

-- ============================================================
-- AUDIT LOGS (APPEND-ONLY — NO UPDATE, NO DELETE)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY,
  actor_id        TEXT                NOT NULL,
  action_type     TEXT                NOT NULL,
  entity_type     TEXT                NOT NULL,
  entity_id       TEXT                NOT NULL,
  metadata        JSONB               NOT NULL DEFAULT '{}'::jsonb,
  timestamp       TIMESTAMPTZ         NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_timestamp
  ON audit_logs(actor_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id
  ON audit_logs(entity_id);

-- ============================================================
-- IDEMPOTENCY KEYS
-- ============================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  payload_hash    TEXT        NOT NULL,
  response_status INTEGER     NOT NULL,
  response_body   TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique key is the PK itself — prevents duplicate inserts

-- ============================================================
-- ENUM: outbox_event_status
-- ============================================================

DO $$ BEGIN
  CREATE TYPE outbox_event_status AS ENUM (
    'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: outbox_event_topic
-- ============================================================

DO $$ BEGIN
  CREATE TYPE outbox_event_topic AS ENUM (
    'payment.checkout_session.create',
    'payment.capture',
    'payment.refund',
    'payment.transfer_to_owner',
    'payment.connected_account.create',
    'payment.onboarding_link.create'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- OUTBOX EVENTS (Transactional Outbox Pattern)
-- ============================================================
-- Durable side-effect queue. Events are written atomically
-- alongside domain state changes. The outbox worker polls
-- for PENDING events and processes them asynchronously.
--
-- Key guarantees:
-- - dedup_key UNIQUE prevents duplicate side effects
-- - status + available_at index enables efficient polling
-- - locked_by/locked_at support worker lease acquisition
-- - attempt_count + max_attempts enforce retry limits
-- ============================================================

CREATE TABLE IF NOT EXISTS outbox_events (
  id              UUID PRIMARY KEY,
  topic           outbox_event_topic   NOT NULL,
  aggregate_type  TEXT                 NOT NULL,
  aggregate_id    TEXT                 NOT NULL,
  payload         JSONB                NOT NULL DEFAULT '{}'::jsonb,
  dedup_key       TEXT                 NOT NULL UNIQUE,
  status          outbox_event_status  NOT NULL DEFAULT 'PENDING',
  attempt_count   INTEGER              NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts    INTEGER              NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at    TIMESTAMPTZ          NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  last_error      TEXT,
  result          JSONB,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ          NOT NULL DEFAULT now()
);

-- Primary polling index: find PENDING events that are ready
CREATE INDEX IF NOT EXISTS idx_outbox_events_poll
  ON outbox_events(status, available_at)
  WHERE status = 'PENDING';

-- Dead letter inspection
CREATE INDEX IF NOT EXISTS idx_outbox_events_dead_letter
  ON outbox_events(status, created_at)
  WHERE status = 'DEAD_LETTER';

-- Stale lease detection: find PROCESSING events with old locks
CREATE INDEX IF NOT EXISTS idx_outbox_events_stale_leases
  ON outbox_events(status, locked_at)
  WHERE status = 'PROCESSING';

-- Aggregate lookup: find all outbox events for a given aggregate
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
  ON outbox_events(aggregate_type, aggregate_id);

-- ============================================================
-- ENUM: reconciliation_run_status
-- ============================================================

DO $$ BEGIN
  CREATE TYPE reconciliation_run_status AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: reconciliation_finding_status
-- ============================================================

DO $$ BEGIN
  CREATE TYPE reconciliation_finding_status AS ENUM (
    'OPEN', 'ACKNOWLEDGED', 'REPAIRED', 'SUPPRESSED', 'ESCALATED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ENUM: reconciliation_severity
-- ============================================================

DO $$ BEGIN
  CREATE TYPE reconciliation_severity AS ENUM (
    'INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- RECONCILIATION RUNS
-- ============================================================

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                    UUID PRIMARY KEY,
  triggered_by          TEXT                        NOT NULL,
  status                reconciliation_run_status   NOT NULL DEFAULT 'RUNNING',
  started_at            TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  total_checked         INTEGER                     NOT NULL DEFAULT 0 CHECK (total_checked >= 0),
  total_findings        INTEGER                     NOT NULL DEFAULT 0 CHECK (total_findings >= 0),
  findings_by_severity  JSONB                       NOT NULL DEFAULT '{}'::jsonb,
  repaired_count        INTEGER                     NOT NULL DEFAULT 0 CHECK (repaired_count >= 0),
  escalated_count       INTEGER                     NOT NULL DEFAULT 0 CHECK (escalated_count >= 0),
  failed_checks         INTEGER                     NOT NULL DEFAULT 0 CHECK (failed_checks >= 0),
  error                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status
  ON reconciliation_runs(status, started_at);

-- ============================================================
-- RECONCILIATION FINDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id                    UUID PRIMARY KEY,
  run_id                UUID                            NOT NULL REFERENCES reconciliation_runs(id),
  aggregate_type        TEXT                            NOT NULL,
  aggregate_id          TEXT                            NOT NULL,
  provider_object_ids   JSONB                           NOT NULL DEFAULT '[]'::jsonb,
  internal_snapshot     JSONB                           NOT NULL DEFAULT '{}'::jsonb,
  provider_snapshot     JSONB                           NOT NULL DEFAULT '{}'::jsonb,
  drift_type            TEXT                            NOT NULL,
  severity              reconciliation_severity         NOT NULL,
  recommended_action    TEXT                            NOT NULL,
  status                reconciliation_finding_status   NOT NULL DEFAULT 'OPEN',
  created_at            TIMESTAMPTZ                     NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,
  resolved_by           TEXT,
  repair_action         TEXT,
  metadata              JSONB                           NOT NULL DEFAULT '{}'::jsonb
);

-- Unresolved findings by severity (most important queries)
CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_unresolved
  ON reconciliation_findings(severity, created_at)
  WHERE status NOT IN ('REPAIRED', 'SUPPRESSED');

-- Aggregate lookup
CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_aggregate
  ON reconciliation_findings(aggregate_type, aggregate_id);

-- Run history
CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_run
  ON reconciliation_findings(run_id);

-- Dedup: open finding per aggregate + drift type
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_findings_open_dedup
  ON reconciliation_findings(aggregate_type, aggregate_id, drift_type)
  WHERE status NOT IN ('REPAIRED', 'SUPPRESSED');
