# Safety Specification — Luxury Watch Rental Platform

**Document type:** Formal safety and correctness specification
**Scope:** Payment backend, escrow lifecycle, provider integration, reconciliation
**Derived from:** Current codebase, adversarial test suites, audit phases N.3–N.9
**Last updated:** 2026-03-18

---

## A. System Scope

### What the backend does

This is a payment-adjacent backend for a luxury watch rental marketplace. It manages:

- Rental lifecycle (creation, payment authorization, capture, return confirmation, fund release, refund)
- Escrow state machine governing when funds can be released to watch owners
- External payment provider integration (Stripe) via an outbox pattern for durable side effects
- Webhook ingestion for provider-initiated state changes
- Reconciliation of internal state against provider truth
- Drift detection, conservative auto-repair, and escalation for unresolvable discrepancies

### What the backend does NOT do

- It does not hold funds in an internal wallet or platform-controlled balance
- It does not perform direct database-level fund transfers between users
- It does not implement a full accounting ledger
- It does not provide a customer-facing UI
- It does not handle KYC, AML, or regulatory compliance directly (delegates to Stripe Connect)
- It does not implement real-time streaming reconciliation; reconciliation is periodic (sweep-based)

### Maturity

This backend has undergone targeted adversarial auditing across phases N.3–N.9, covering:

- Outbox durability and idempotency (N.3–N.4)
- Outbox recovery correctness under edge cases (N.5)
- Crash-window transfer truth convergence (N.6)
- Retention and discoverability guarantees (N.7)
- Observability hardening for stuck transfer detection (N.8)
- Runtime invariant enforcement and change-resistance guards (N.9)

**This is a compliance-sensitive, payment-adjacent backend.** Changes to payment paths, provider integration, reconciliation logic, or outbox behavior must be reviewed with the same rigor as changes to a financial system.

---

## B. Core Financial Safety Claims

### Claim 1: No duplicate money movement under modeled paths

**Statement:** A single rental cannot trigger more than one Stripe transfer to the owner's connected account.

**Proof sources:**
- Stripe idempotency key `transfer_{rentalId}` in `StripePaymentProvider.transferToConnectedAccount()` (`src/infrastructure/payments/StripePaymentProvider.ts`)
- Outbox dedup key `transfer:{rentalId}` prevents duplicate outbox events (`src/domain/entities/OutboxEvent.ts`, enforced in `OutboxRepository.create()`)
- `releaseFunds()` FSM guard: only callable from `EXTERNAL_PAYMENT_CAPTURED` state, transitions to terminal `FUNDS_RELEASED_TO_OWNER` (`src/domain/entities/Rental.ts:323-340`)
- `TransferToOwnerHandler.completeRentalRelease()` skips if already `FUNDS_RELEASED_TO_OWNER` (idempotent)

**Caveats:** Depends on Stripe honoring idempotency keys. If Stripe's idempotency window expires and the same key is reused with different parameters, behavior is Stripe-defined.

### Claim 2: Provider state-changing commands are idempotent

**Statement:** All Stripe API calls that change state use deterministic idempotency keys derived from business identifiers.

**Proof sources:**
- `StripePaymentProvider` (`src/infrastructure/payments/StripePaymentProvider.ts`):
  - Account creation: `account_{ownerId}`
  - Checkout: `checkout_{rentalId}`
  - Capture: `capture_{paymentIntentId}`
  - Refund: `refund_{paymentIntentId}`
  - Transfer: `transfer_{rentalId}`

**Caveats:** Idempotency depends on Stripe's key TTL (currently 24 hours). Operations retried beyond this window are not guaranteed idempotent by Stripe.

### Claim 3: Crash-window transfer truth converges safely

**Statement:** When a Stripe transfer succeeds but the local rental write-back fails (OCC conflict, crash, dispute lock), the transfer ID is durably captured in the outbox event result and recovered during the next reconciliation sweep.

**Proof sources:**
- `TransferToOwnerHandler.handle()` always returns `{ transferId }` regardless of `completeRentalRelease()` success (`src/infrastructure/outbox/ProviderCommandHandlers.ts`)
- `OutboxEvent.markSucceeded(now, { transferId })` persists the result durably
- `ReconciliationEngine.recoverTransferIdFromOutbox()` recovers the ID (`src/application/services/ReconciliationEngine.ts:320-336`)
- `ReconciliationEngine.attemptTransferBackfill()` completes the state transition (`src/application/services/ReconciliationEngine.ts:270-299`)
- Adversarial test suite: `tests/adversarial/transferBackfillCompletion.test.ts` (13 tests)

**Caveats:** Depends on SUCCEEDED outbox events remaining queryable (see Section I).

### Claim 4: Reconciliation is conservative

**Statement:** Only two drift types are auto-repairable. All others require human review or freeze.

**Proof sources:**
- `DriftTaxonomy.classify()` (`src/domain/services/DriftTaxonomy.ts`):
  - Auto-repairable: `PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED`, `PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN`
  - All others: `autoRepairAllowed: false`, require freeze and/or review
- `RepairPolicy.canAutoRepair()` enforces monotonic-only, forward-only repairs (`src/domain/reconciliation/RepairPolicy.ts`)

### Claim 5: Ambiguity does not cause silent data corruption

**Statement:** When a provider call's outcome is ambiguous (network timeout on a state-changing operation), the system does not assume success or failure. Reconciliation detects and converges the actual state.

**Proof sources:**
- `ProviderError.ambiguous` is true only for `PROVIDER_NETWORK_TIMEOUT` with `isStateChanging: true` (`src/domain/errors/ProviderError.ts`)
- Outbox retry with exponential backoff retries ambiguous operations; Stripe idempotency keys ensure safe replay
- Reconciliation full sweep compares internal state against provider truth regardless of operation outcome

### Claim 6: Webhooks are deduplicated and ordering-safe under modeled cases

**Statement:** Duplicate webhook deliveries are rejected. The system handles out-of-order webhooks by relying on FSM guards that reject invalid transitions.

**Proof sources:**
- `ProcessedWebhookEventStore` persistent dedup by Stripe event ID (`src/http/webhookController.ts`)
- Stripe signature verification (`constructEvent`)
- Rental FSM `transitionTo()` rejects invalid state transitions (`src/domain/entities/Rental.ts:286-296`)
- Optimistic concurrency prevents concurrent webhook processing from corrupting state

---

## C. Invariants

### 1. Payment / Provider Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| All state-changing Stripe calls use idempotency keys | `StripePaymentProvider` hardcodes key derivation | Duplicate provider-side effect if broken | `src/infrastructure/payments/StripePaymentProvider.ts` |
| Provider errors are classified with ambiguity flag | `ProviderError` constructor sets `ambiguous` | Ambiguous outcome treated as definite if broken | `src/domain/errors/ProviderError.ts` |
| Only `transferToConnectedAccount` can release funds to owners | Single call site in `TransferToOwnerHandler` | Unauthorized fund movement if bypassed | `src/infrastructure/outbox/ProviderCommandHandlers.ts` |

### 2. Rental Lifecycle Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| Escrow FSM transitions are validated | `Rental.transitionTo()` checks `VALID_TRANSITIONS` map | `INVALID_ESCROW_TRANSITION` DomainError | `src/domain/entities/Rental.ts:286-296` |
| Terminal states (`FUNDS_RELEASED_TO_OWNER`, `REFUNDED`) are irreversible | `VALID_TRANSITIONS` map: empty set for terminal states | Cannot transition out of terminal state | `src/domain/entities/Rental.ts:34` |
| At most one active rental per watch | Postgres partial unique index + application-level check | `WATCH_ALREADY_RESERVED` DomainError | `PostgresRentalRepository.save()`, `InMemoryRentalRepository.save()` |
| Version-based optimistic concurrency on all writes | `save()` checks `version - 1` against stored version | `VERSION_CONFLICT` DomainError | Both repository implementations |

### 3. Release / Payout Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| Funds cannot be released without confirmed return | `releaseFunds()` checks `_returnConfirmed` | `RETURN_NOT_CONFIRMED` DomainError | `src/domain/entities/Rental.ts:324-327` |
| Funds cannot be released during open dispute | `releaseFunds()` checks `_disputeOpen` | `DISPUTE_LOCK` DomainError | `src/domain/entities/Rental.ts:328-331` |
| Refund impossible after release | `markRefunded()` checks status | `INVALID_ESCROW_TRANSITION` DomainError | `src/domain/entities/Rental.ts:375-381` |

### 4. Reconciliation Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| Full sweep covers ALL rentals | `runFullSweep()` calls `rentalRepo.findAll()` | Stuck rentals missed if filtered | `src/application/services/ReconciliationEngine.ts`, test #16 in `invariantEnforcement.test.ts` |
| Auto-repair is monotonic (forward-only) | `RepairPolicy.canAutoRepair()` + `DriftTaxonomy` | Backward state regression if broken | `src/domain/reconciliation/RepairPolicy.ts` |
| Critical drifts trigger freeze, not auto-repair | `DriftTaxonomy.classify()` returns `freezeRequired: true` | Unreviewed critical drift if broken | `src/domain/services/DriftTaxonomy.ts` |

### 5. Outbox Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| Outbox events are created atomically with domain state | Design pattern (same transaction) | Phantom side effects if broken | `src/infrastructure/outbox/ProviderCommandHandlers.ts` |
| Dedup key prevents duplicate outbox events | `OutboxRepository.create()` throws on key conflict | Duplicate provider commands if broken | Both outbox repository implementations |
| SUCCEEDED events must not be deleted | `deleteEvent()` guard via `shouldBlockOutboxDeletion()` | `TransferInvariantViolation` thrown | `src/domain/invariants/TransferTruthInvariants.ts`, tests #1-3 in `invariantEnforcement.test.ts` |

### 6. Retention / Recovery Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| `findByAggregate` returns all events (no LIMIT) | Structural (no LIMIT in query) + `assertEventCollectionComplete()` warning | Truncated recovery if LIMIT added | `PostgresOutboxRepository.findByAggregate()`, `ReconciliationEngine.recoverTransferIdFromOutbox()` |
| Rental.externalTransferId always wins over outbox fallback | `assertTransferPrecedence()` guard in `reconcileOne()` | `TransferInvariantViolation` on conflict | Tests #6-10 in `invariantEnforcement.test.ts` |
| Recovered transfer IDs must match Stripe format | `isValidTransferId()` guard in `reconcileOne()` | Malformed ID rejected with `[INVARIANT_GUARD]` warning | Tests #11-15 in `invariantEnforcement.test.ts` |

### 7. Diagnostics / Observability Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| Diagnostics services are read-only | Structural (no `save()` calls) | State corruption if mutation added | Tests #17-19 in `invariantEnforcement.test.ts` |
| Stuck transfer detection covers all stuck rentals | `findStuckTransferTruth()` query | Stuck rentals invisible if query broken | Tests #1-3 in `transferDiagnosticsObservability.test.ts` |

### 8. Change-Resistance Invariants

| Invariant | Enforcement | Failure Mode | Code / Tests |
|---|---|---|---|
| No synthetic transfer IDs accepted | `isValidTransferId()` regex: `^tr_[a-zA-Z0-9_]+$` | Fabricated truth accepted if broken | `src/domain/invariants/TransferTruthInvariants.ts` |
| Precedence conflict detected, not silently resolved | `assertTransferPrecedence()` throws on mismatch | Silent data corruption if broken | `src/domain/invariants/TransferTruthInvariants.ts` |
| Backfill failures are logged with classification | `[SAFETY_WARNING]` console output with OCC detection | Silent failures if logging removed | `ReconciliationEngine.attemptTransferBackfill()` |

---

## D. Provider Truth Model

### Truth Hierarchy

| Priority | Source | When Authoritative | Update Frequency |
|---|---|---|---|
| 1 | **Provider snapshot** (live Stripe API query) | During reconciliation sweeps | On-demand (every 5 min in sweep) |
| 2 | **Webhook delivery** | Real-time provider-initiated events | As Stripe delivers (seconds to minutes) |
| 3 | **Outbox event result** | Crash-window recovery only | At outbox event completion |
| 4 | **Internal persisted state** (Rental entity) | Normal operation after successful write-back | On every domain mutation |

### When each source is primary

- **Normal operation:** Internal state is kept in sync via webhooks and command responses. Internal state is the operational primary.
- **Reconciliation:** Provider snapshot is the authoritative truth. Internal state is compared against it. Drifts are detected when they disagree.
- **Crash-window recovery:** Outbox event result is the fallback source when internal state was not updated after a successful provider operation.

### Fallback behavior

- `Rental.externalTransferId` (internal) is the primary source for transfer truth.
- If null, `recoverTransferIdFromOutbox()` queries outbox events as fallback.
- If both exist and match, internal wins (no-op).
- If both exist and differ, `assertTransferPrecedence()` throws — no silent resolution.
- If neither exists, no transfer verification occurs (safe no-op).

### Ambiguity handling

Ambiguous outcomes (network timeout on state-changing operations) are not resolved locally. The system:
1. Retries via outbox with exponential backoff and Stripe idempotency keys
2. If retries exhaust, event goes to DEAD_LETTER for admin review
3. Reconciliation sweep detects the actual provider state and creates findings

### Convergence

Internal state converges to provider truth through:
1. **Webhooks:** Real-time forward-sync for authorization, capture, refund, dispute events
2. **Outbox retry:** Retries failed operations with idempotency keys
3. **Reconciliation sweep:** Periodic full comparison detects all remaining drifts
4. **Backfill:** Crash-window transfer truth is recovered from outbox and written to rental

---

## E. Ambiguous Outcome Model

### What counts as ambiguous

An outcome is ambiguous when:
- A network timeout or connection reset occurs during a **state-changing** Stripe API call
- The caller cannot determine if the operation succeeded or failed at the provider

### How ProviderError represents it

```
ProviderError {
  code: 'PROVIDER_NETWORK_TIMEOUT',
  isStateChanging: true,
  retryable: true,
  ambiguous: true  // only true for NETWORK_TIMEOUT + isStateChanging
}
```

Enforced in `src/domain/errors/ProviderError.ts:44-46`.

### Convergence path

1. **Outbox retry:** The operation is retried with the same idempotency key. Stripe returns the original result if the first call succeeded, or processes the call if it didn't.
2. **Dead letter:** If max retries exceeded, admin intervention is flagged.
3. **Reconciliation:** The sweep compares internal state against provider truth and creates findings for any drift.

### What is NOT modeled

There is no explicit "ambiguous" state in the escrow FSM. The rental stays in its last known good state. This is acceptable because:
- Stripe idempotency keys make retries safe
- Reconciliation detects the actual outcome regardless
- Adding an AMBIGUOUS state would complicate the FSM without improving safety (the system already converges)

---

## F. Crash-Window Transfer Truth Model

### Full sequence

```
T+0    Stripe transfer API call succeeds → returns { transferId: 'tr_xxx' }
       ↓
T+0    TransferToOwnerHandler.handle() receives transferId
       ↓
T+0    completeRentalRelease() attempts: releaseFunds(transferId) + rentalRepo.save()
       ↓
       ╔══════════════════════════════════════════════════════════════╗
       ║  CRASH WINDOW: Write-back fails (OCC conflict, crash,      ║
       ║  dispute lock, network error). Rental stays CAPTURED.       ║
       ║  externalTransferId remains null.                           ║
       ╚══════════════════════════════════════════════════════════════╝
       ↓
T+0    TransferToOwnerHandler returns { transferId } regardless of write-back outcome
       ↓
T+0    OutboxWorker calls event.markSucceeded(now, { transferId })
       ↓
T+0    OutboxRepository.save(event) → SUCCEEDED event with result.transferId is DURABLE
       ↓
       ══════════════ CRASH WINDOW IS NOW BOUNDED ══════════════
       ↓
T+5min ReconciliationWorker.runFullSweep() fires
       ↓
       ReconciliationEngine.reconcileOne(rental):
         1. rental.externalTransferId === null → enter fallback path
         2. recoverTransferIdFromOutbox(rentalId):
            a. findByAggregate('Rental', rentalId) → all events
            b. assertEventCollectionComplete() → INVARIANT 2 check
            c. Filter: topic='payment.transfer_to_owner', status='SUCCEEDED', result.transferId present
            d. Return transferId
         3. isValidTransferId(transferId) → INVARIANT 4 check
         4. assertTransferPrecedence(null, transferId) → INVARIANT 3 check (returns 'recovered')
         5. attemptTransferBackfill(rental, transferId):
            a. rental.releaseFunds(transferId) → CAPTURED → FUNDS_RELEASED_TO_OWNER
            b. rentalRepo.save(rental) → durable write-back
            c. Audit log: 'reconciliation_transfer_backfill'
         6. Rebuild internal snapshot from updated rental
         7. Fetch transfer snapshot from Stripe → verify transfer truth
       ↓
T+5min Rental is now in FUNDS_RELEASED_TO_OWNER with externalTransferId set
       CRASH WINDOW CLOSED. Truth converged.
```

### Operator visibility

- `GET /admin/transfers/stuck` shows all rentals in transfer-truth limbo
- `GET /admin/transfers/stuck/:rentalId` shows outbox correlation and recovery classification
- `HealthMonitor` reports DEGRADED/NOT_READY if stuck count exceeds thresholds
- Backfill success is audited (`reconciliation_transfer_backfill`)
- Backfill failure is logged with `[SAFETY_WARNING]` classification

---

## G. Reconciliation Model

### Drift Types

| Drift Type | Severity | Auto-Repair | Action | Description |
|---|---|---|---|---|
| `PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED` | HIGH | Yes | SYNC_INTERNAL | Provider captured funds, internal not updated |
| `PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN` | HIGH | Yes | SYNC_INTERNAL | Provider dispute open, internal clean |
| `INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING` | HIGH | No | OPEN_REVIEW | Internal authorized but provider has no record |
| `INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED` | CRITICAL | No | FREEZE_ENTITY | Internal claims released, provider disagrees |
| `INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED` | MEDIUM | No | OPEN_REVIEW | Internal dispute flag stale |
| `REFUND_STATE_MISMATCH` | HIGH | No | FREEZE_ENTITY | Refund state disagreement |
| `CONNECTED_ACCOUNT_STATE_MISMATCH` | LOW | No | ENQUEUE_RECHECK | Connected account state mismatch |
| `DUPLICATE_PROVIDER_REFERENCE` | CRITICAL | No | FREEZE_ENTITY | Same provider ref linked to multiple records |
| `ORPHAN_PROVIDER_OBJECT` | LOW | No | ENQUEUE_RECHECK | Provider object with no internal match |
| `ORPHAN_INTERNAL_RECORD` | MEDIUM | No | OPEN_REVIEW | Internal record with no provider match |
| `TRANSFER_REVERSED_BUT_INTERNAL_RELEASED` | CRITICAL | No | FREEZE_ENTITY | Provider reversed transfer, internal says released |
| `TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED` | CRITICAL | No | FREEZE_ENTITY | Provider has no transfer record, internal says released |

### Auto-repair policy

Auto-repair is permitted only when ALL of the following hold (enforced in `RepairPolicy`):
1. `DriftTaxonomy.classify()` returns `autoRepairAllowed: true`
2. The repair is monotonic (forward-only state sync)
3. External provider truth is authoritative for the specific field
4. No money release ambiguity is involved
5. The operation is idempotent

Only 2 of 12 drift types qualify.

### Escalation model

- **CRITICAL severity:** `freezeRequired: true` — entity is frozen, manual review required
- **HIGH severity (non-auto-repairable):** `reviewRequired: true` — review case opened
- **MEDIUM/LOW:** `OPEN_REVIEW` or `ENQUEUE_RECHECK` — lower urgency follow-up

Finding lifecycle: `OPEN → ACKNOWLEDGED → REPAIRED/SUPPRESSED` or `OPEN → ESCALATED → REPAIRED/SUPPRESSED`.

---

## H. Webhook Safety Model

### Verification chain

1. **Stripe signature verification:** `stripe.webhooks.constructEvent()` validates HMAC signature against webhook secret. Invalid signatures are rejected with 400.
2. **Event ID dedup:** `ProcessedWebhookEventStore` persists processed Stripe event IDs. Duplicate deliveries return 200 (acknowledged) without processing.
3. **FSM validation:** `Rental.transitionTo()` rejects invalid state transitions, preventing out-of-order webhooks from corrupting state.
4. **Optimistic concurrency:** Version-based OCC prevents concurrent webhook processing from causing lost updates.
5. **Audit logging:** All webhook-triggered state changes are audited.

### Supported events

| Stripe Event | Handler | Effect |
|---|---|---|
| `payment_intent.amount_capturable_updated` | `handlePaymentAuthorized` | Transition to `EXTERNAL_PAYMENT_AUTHORIZED` |
| `charge.captured` | `handlePaymentCaptured` | Transition to `EXTERNAL_PAYMENT_CAPTURED` |
| `payment_intent.payment_failed` | `handlePaymentFailed` | Transition to `REFUNDED` |
| `charge.refunded` | `handleChargeRefunded` | Transition to `REFUNDED` |
| `charge.dispute.created` | `handleDisputeOpened` | Transition to `DISPUTED` |
| `charge.dispute.closed` | `handleDisputeClosed` | Resolve dispute, restore to `CAPTURED` |

### Unsupported events

Unknown event types are acknowledged (200 response) but not processed. No state change occurs.

### Out-of-order handling

The system does not implement explicit ordering. Instead, FSM guards reject invalid transitions. For example, if `charge.captured` arrives before `payment_intent.amount_capturable_updated`, the capture handler will succeed because the FSM allows `AWAITING_EXTERNAL_PAYMENT → EXTERNAL_PAYMENT_CAPTURED` is not a valid transition — only `AUTHORIZED → CAPTURED`. The webhook is acknowledged but has no effect. Reconciliation later detects the drift and converges.

---

## I. Retention / Evidence Survival

**This section documents a critical dependency.**

### Current retention model

| Property | Status |
|---|---|
| Delete method for outbox events | Exists with INVARIANT 1 guard: `deleteEvent()` throws `TransferInvariantViolation` on SUCCEEDED events |
| TTL / expiry on outbox events | None. No TTL column in schema, no expiry logic. |
| Scheduled cleanup / purge | None. No cron job, no background purge, no retention policy. |
| Archival mechanism | None. |
| Effective retention | **UNBOUNDED.** SUCCEEDED outbox events persist indefinitely. |

### Why this matters

Transfer truth recovery depends on SUCCEEDED outbox events with `result.transferId` remaining queryable. Specifically:

1. `recoverTransferIdFromOutbox()` queries `findByAggregate('Rental', rentalId)` which returns **all** events for the aggregate (no LIMIT, no pagination).
2. The query filters for `topic = 'payment.transfer_to_owner'`, `status = 'SUCCEEDED'`, and `result.transferId` being a non-empty string.
3. If the SUCCEEDED event is absent (deleted, archived, expired), recovery returns `null` — fail-safe (no false findings, but no transfer verification either).

### Critical constraint

**Current safety depends on unbounded retention of SUCCEEDED outbox events.**

If any retention mechanism (TTL, DELETE, archival, pruning, cleanup job) is introduced in the future:

> Transfer-truth recovery must be proven to complete (backfill the rental) before the evidence is deleted, or the crash-window convergence guarantee documented in Section F is invalidated.

This constraint is enforced at runtime by:
- `shouldBlockOutboxDeletion()` returning `true` for SUCCEEDED events
- `deleteEvent()` throwing `TransferInvariantViolation` if attempted
- `assertEventCollectionComplete()` warning on suspicious truncation patterns

### Evidence

- No delete/cleanup code exists in `PostgresOutboxRepository` or `InMemoryOutboxRepository` (beyond the guarded `deleteEvent()`)
- No TTL columns in `migration.sql`
- Retention proven by `tests/adversarial/retentionAndDiscoverability.test.ts` (7 tests)
- Guard proven by `tests/adversarial/invariantEnforcement.test.ts` (tests #1-3)

---

## J. Operational Observability

### What operators can inspect today

| Capability | Endpoint / Mechanism | Scope |
|---|---|---|
| Stuck transfer detection | `GET /admin/transfers/stuck` | All rentals in CAPTURED + returnConfirmed + no transferId + older than threshold |
| Per-rental transfer diagnostics | `GET /admin/transfers/stuck/:rentalId` | Rental state + outbox events + recovery classification |
| Outbox status dashboard | `GET /admin/outbox/status` | Counts by status (pending, processing, succeeded, failed, dead_letter) |
| Dead letter inspection | `GET /admin/outbox/dead-letters` | Failed outbox events requiring admin attention |
| Outbox event lookup | `GET /admin/outbox/events/:eventId` | Single event details |
| Aggregate event history | `GET /admin/outbox/aggregates/:type/:id` | All outbox events for an entity |
| Reconciliation findings | Admin reconciliation routes | Open findings by severity, drift type |
| Health / readiness | `GET /health`, `GET /ready` | System health including stuck transfer count |
| Incident forensics | `IncidentSnapshotBuilder.buildForRental()` | Audit trail + outbox events + reconciliation findings for a rental |
| Full sweep reconciliation | `ReconciliationWorker` (automatic, every 5 min) | All rentals checked against provider truth |

### Recovery classification

The stuck transfer diagnostics service classifies each stuck rental as:

| Classification | Meaning | Operator Action |
|---|---|---|
| `will_recover_via_reconciliation` | SUCCEEDED outbox event with valid transferId exists | No action needed; next sweep will backfill |
| `already_recoverable` | Rental already has externalTransferId | Should not appear in stuck list |
| `needs_manual_intervention` | No SUCCEEDED event, or no transferId in result | Investigate: check Stripe dashboard, dead letters, outbox events |

### Health signals

| Signal | Threshold | Health Status |
|---|---|---|
| Stuck transfer count >= `stuckTransferDegradedThreshold` (default: 5) | Configurable | DEGRADED |
| Stuck transfer count >= `stuckTransferNotReadyThreshold` (default: 20) | Configurable | NOT_READY |
| Outbox backlog >= degraded threshold (default: 100) | Configurable | DEGRADED |
| Outbox backlog >= not-ready threshold (default: 500) | Configurable | NOT_READY |
| Unresolved CRITICAL reconciliation findings >= threshold (default: 10) | Configurable | DEGRADED |

---

## K. Known Limitations / Reservations

| # | Limitation | Safety Impact | Operational Impact | Future Risk |
|---|---|---|---|---|
| 1 | No explicit "ambiguous" escrow state | None under current model — retries + reconciliation converge | Operators cannot see ambiguous-in-flight status directly | Low — adding an AMBIGUOUS state would complicate FSM without improving convergence |
| 2 | Reconciliation is periodic (5 min sweep), not real-time | Crash-window truth convergence bounded by sweep interval | Up to 5 minutes of stale truth after crash-window event | Low — acceptable for current scale; configurable interval |
| 3 | Webhook out-of-order handling relies on FSM rejection, not explicit sequencing | Safe under current FSM — invalid transitions are rejected | Silently dropped webhooks require reconciliation to converge | Medium — if FSM transitions become more permissive, ordering safety weakens |
| 4 | No internal accounting ledger | Money flow is tracked only through provider state + rental escrow | No independent audit trail of fund movements separate from Stripe | Medium — enterprise compliance may require independent ledger |
| 5 | Stripe idempotency key TTL (24 hours) is externally controlled | Operations retried beyond 24 hours may not be idempotent | Extremely unlikely under normal operation (outbox retries exhaust in minutes) | Low |
| 6 | Full sweep processes ALL rentals including converged ones | No correctness impact — converged rentals are fast no-ops | Performance cost scales linearly with total rental count | Medium at scale — may need index-based filtering for active-only sweeps |
| 7 | `assertEventCollectionComplete()` uses heuristic (suspicious round numbers) | Cannot definitively detect LIMIT truncation without query metadata | Warning-only, not blocking | Low — real enforcement is structural (no LIMIT in query) |
| 8 | Transfer ID validation uses regex, not Stripe API verification | Accepts any string matching `^tr_[a-zA-Z0-9_]+$` | Could accept a well-formatted but non-existent ID | Low — Stripe API fetch would fail, creating a CRITICAL finding |
| 9 | No dedicated retention policy management | Safe under current unbounded model | SUCCEEDED events grow unboundedly | Medium at scale — eventual need for archival with completion proof |

---

## L. Change-Risk Warnings

| Future Change | Why Dangerous | What Must Be Re-Proven |
|---|---|---|
| **Adding outbox retention/cleanup/TTL** | SUCCEEDED events may be deleted before transfer-truth backfill completes | Prove that all crash-window rentals are backfilled before evidence deletion; update `shouldBlockOutboxDeletion` |
| **Adding LIMIT/pagination to `findByAggregate`** | Outbox recovery may miss the SUCCEEDED transfer event | Prove that the relevant event is always within the returned window; update `assertEventCollectionComplete` |
| **Filtering `findAll()` in reconciliation sweep** | Eligible stuck rentals may be skipped | Prove that the filter does not exclude rentals needing backfill or drift detection |
| **Changing fallback precedence logic** | Outbox truth could overwrite persisted truth | Prove that `assertTransferPrecedence` still prevents silent conflict resolution |
| **Introducing mutation into diagnostics services** | Side effects during read-only admin queries | Verify no `save()`, `releaseFunds()`, or outbox event creation in diagnostics paths |
| **Changing provider idempotency key derivation** | Same operation may be processed twice by Stripe | Prove that new key scheme preserves exactly-once semantics for all provider operations |
| **Changing webhook event type handling** | New event types may bypass FSM guards | Prove that FSM transitions remain valid and out-of-order delivery is still safe |
| **Adding alternate release paths (bypass outbox)** | Fund release without outbox event loses crash-window safety net | Prove that the alternate path has equivalent idempotency and recovery guarantees |
| **Removing or weakening FSM transition guards** | Invalid state transitions become possible | Re-audit all webhook handlers, reconciliation auto-repair, and backfill paths |
| **Making `completeRentalRelease` non-idempotent** | Double write-back could corrupt state | Prove idempotency is preserved or add explicit guard |

---

## M. Required Regression Checks for Future Changes

### Before merging changes to payment-adjacent code:

- [ ] **Outbox retention:** If modifying outbox cleanup/archival, prove that SUCCEEDED events needed for transfer-truth recovery are retained until backfill completes.
- [ ] **Query completeness:** If modifying `findByAggregate` or any outbox query used by recovery, verify no LIMIT/pagination/filter that could omit relevant events.
- [ ] **Reconciliation coverage:** If modifying `runFullSweep` or `findAll`, verify all rentals are still checked.
- [ ] **Idempotency keys:** If modifying provider call idempotency keys, verify uniqueness and determinism for all operation types.
- [ ] **FSM transitions:** If modifying `VALID_TRANSITIONS` or adding new escrow states, re-audit webhook handlers, backfill, and auto-repair paths.
- [ ] **Transfer ID format:** If changing Stripe transfer ID format expectations, update `isValidTransferId` regex.
- [ ] **Diagnostics read-only:** If adding new diagnostics methods, verify no mutation calls (`save()`, `releaseFunds()`, outbox event creation).
- [ ] **Precedence enforcement:** If modifying recovery fallback logic, verify `assertTransferPrecedence` is still called and conflict detection is preserved.
- [ ] **Run full test suite:** `npx vitest run` must pass with zero failures.
- [ ] **Adversarial test suites must pass:**
  - `tests/adversarial/outboxRecoveryCorrectness.test.ts` (23 tests)
  - `tests/adversarial/transferBackfillCompletion.test.ts` (13 tests)
  - `tests/adversarial/retentionAndDiscoverability.test.ts` (7 tests)
  - `tests/adversarial/transferDiagnosticsObservability.test.ts` (14 tests)
  - `tests/adversarial/invariantEnforcement.test.ts` (21 tests)

---

## N. Audit Status Summary

### What is proven safe

- No duplicate money movement under Stripe idempotency key model
- Crash-window transfer truth converges within one reconciliation sweep (≤5 min)
- Reconciliation is conservative: only 2 of 12 drift types are auto-repairable
- Critical drifts (reversed transfers, missing transfers) trigger freeze + manual review
- Outbox recovery correctly selects SUCCEEDED events, rejects malformed results
- Precedence enforcement prevents silent conflict between persisted and recovered truth
- Transfer ID format validation rejects non-Stripe IDs
- Diagnostics are structurally read-only
- Webhooks are deduplicated, signature-verified, and FSM-guarded

### What is safe with assumptions

- **Unbounded outbox retention assumed.** If retention is bounded, crash-window convergence must be re-proven.
- **Stripe idempotency key TTL (24 hours) assumed.** If Stripe changes this, retry safety must be re-evaluated.
- **Webhook ordering handled by FSM rejection, not sequencing.** If FSM becomes more permissive, ordering safety must be re-audited.
- **Single reconciliation worker per cluster assumed** (enforced by distributed lease). If lease mechanism fails, concurrent sweeps could produce duplicate findings (non-corrupting but noisy).

### What is intentionally deferred

- Independent accounting ledger (not required for current operational model)
- Real-time reconciliation / streaming drift detection (periodic sweep is sufficient at current scale)
- Explicit ambiguous escrow state (retries + reconciliation converge without it)
- Outbox retention policy management (unbounded retention is safe; bounded retention needs completion proof)

### Confidence level

**High confidence** in the modeled paths. The system has been adversarially audited across 6 phases with 78+ targeted tests covering crash-window recovery, edge-case rejection, retention guarantees, precedence enforcement, and invariant violations. Safety depends on documented assumptions remaining true.

---

*Formal safety spec created from current code and tests without unsupported claims.*
