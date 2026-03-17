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
