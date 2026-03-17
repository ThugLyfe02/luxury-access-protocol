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
