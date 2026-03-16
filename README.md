# luxury-access-protocol

Backend for a regulated luxury watch rental marketplace. Under active reconstruction.

**Status: NOT production-ready.** No persistence, no HTTP layer, no tests, no auth. See [RECONSTRUCTION_LEDGER.md](./RECONSTRUCTION_LEDGER.md) for detailed phase history and known gaps.

---

## What this is

A domain-driven TypeScript backend for a marketplace where renters pay to access luxury watches owned by others. The platform facilitates the transaction but **never holds rental principal**. All fund movement goes through Stripe Connect (separate charges and transfers model).

## What this is not

- Not a runnable application. There is no composition root, no HTTP server, no database.
- Not a wallet, ledger, or custodial system. The platform does not hold, warehouse, or move user funds.
- Not feature-complete. Many domain areas are modeled but not wired into application flows.

---

## Architecture

### Layers

```
src/
├── domain/           # Business rules. No external dependencies.
│   ├── entities/     # Stateful objects with constructor validation and guarded transitions.
│   ├── enums/        # String enums. No logic.
│   ├── errors/       # DomainError class and error code definitions.
│   ├── interfaces/   # Port definitions (PaymentProvider, repository contracts).
│   └── services/     # Stateless domain services (static methods, throws-only side effects).
│
├── application/      # Orchestration. Calls domain services and entities. Thin.
│   └── services/     # InitiateRentalService, MarketplacePaymentService.
│
└── infrastructure/   # Adapter implementations. Currently stubs only.
    └── payments/     # StripePaymentProvider (all methods throw 'Not implemented').
```

### Dependency direction

`infrastructure → application → domain`

Domain has zero imports from application or infrastructure. Application imports from domain only. Infrastructure implements domain interfaces.

### Entry points

There are exactly 2 application services:

**InitiateRentalService.execute()** — Creates a rental. Gate sequence:
1. Anti-custody firewall (RegulatoryGuardrails)
2. Geographic containment (CompliancePolicy)
3. KYC verification (RiskPolicy)
4. Core risk policy: self-rental, high-risk, verification, role ceiling (RiskPolicy)
5. Insurance coverage for high-value watches (RiskPolicy)
6. Tier-based value ceiling (TierEngine)
7. Unit economics viability (UnitEconomicsGuard)
8. Risk analysis with signal collection (RiskAnalyzer)
9. Rental entity creation
10. External checkout session via PaymentProvider
11. Transition to AWAITING_EXTERNAL_PAYMENT

**MarketplacePaymentService** — Handles post-initiation lifecycle:
- `handlePaymentAuthorized(rental)` — External authorization event
- `handlePaymentCaptured(rental)` — External capture event
- `handlePaymentRefunded(rental)` — External refund event
- `handleDisputeOpened(rental)` — Dispute freeze
- `handleDisputeResolved(rental)` — Dispute unfreeze (no auto-release)
- `confirmReturn(rental)` — Physical return confirmation
- `releaseToOwner(params)` — Transfer to owner's connected account (6 hard gates)

### Rental state machine

```
NOT_STARTED
  → AWAITING_EXTERNAL_PAYMENT
    → EXTERNAL_PAYMENT_AUTHORIZED
      → EXTERNAL_PAYMENT_CAPTURED
        → FUNDS_RELEASED_TO_OWNER (terminal)
        → DISPUTED
        → REFUNDED (terminal)
      → REFUNDED (terminal)
      → DISPUTED
    → REFUNDED (terminal)

DISPUTED
  → EXTERNAL_PAYMENT_CAPTURED (recovery — no entity method yet)
  → REFUNDED (terminal)
```

### Release gates

Fund release requires ALL of:
1. escrowStatus === EXTERNAL_PAYMENT_CAPTURED
2. returnConfirmed === true
3. disputeOpen === false
4. No blocking manual review cases (HIGH/CRITICAL unresolved)
5. Valid owner connected account ID
6. Positive finite share amount

Gates are enforced at both the entity level (`Rental.releaseFunds()`) and the service level (`releaseToOwner()`).

---

## Non-custody constraint

The platform must never hold rental principal. This is enforced by:
- **RegulatoryGuardrails**: Scans operation names and context for 13 forbidden custody keywords at runtime.
- **PaymentProvider interface**: Models Stripe Connect operations only (createCheckoutSession, authorizePayment, capturePayment, refundPayment, transferToConnectedAccount). No internal fund movement methods exist.
- **No ledger entity**: Ledger error codes exist in ErrorCodes.ts but no ledger implementation exists. Those codes are unresolved — see RECONSTRUCTION_LEDGER.md.

---

## What the system does NOT yet do

| Area | Status |
|---|---|
| Persist anything | No repositories implemented. No database. All state is in-memory. |
| Authenticate callers | No auth/authz on any entry point. |
| Verify webhook signatures | No HTTP layer. Webhook handlers trust the caller. |
| Enforce idempotency | No idempotency tokens on payment events. |
| Check KYC/insurance at release | Checked at initiation only. Expiry mid-rental is undetected. |
| Enforce custody chain at release | ChainOfCustody/ConditionReport entities exist but are not wired. |
| Compute tier from user data | TierEngine.computeTier() exists but is never called. Tier is caller-provided. |
| Save review cases | Created by RiskAnalyzer but never persisted. |
| Prevent direct Rental construction in advanced state | Constructor accepts any escrowStatus. |
| Recover from resolved disputes | No method transitions DISPUTED → CAPTURED after resolution. |
| Enforce platform exposure caps | Error codes exist, no enforcement. |
| Enforce inventory minimums | Error code exists, no enforcement. |

---

## Unsafe assumptions

Do NOT assume:
- That compiling means correctness. The type system compiles cleanly but hides architectural gaps.
- That the existence of an entity means it is wired. ChainOfCustody, ConditionReport, CustodyEvent are not referenced by any application service.
- That the existence of a repository interface means persistence works. None are implemented or consumed.
- That error codes being defined means they are enforced. 17 of 42 are never thrown.
- That StripePaymentProvider is functional. It is a stub that throws on every call.
- That TierEngine.computeTier() is called. It is not. The orchestrator trusts caller-provided tier.

---

## Build

```sh
npm install
npm run typecheck
```

Requires Node.js 18+ and TypeScript 5.4+.

---

## Reconstruction progress

See [RECONSTRUCTION_LEDGER.md](./RECONSTRUCTION_LEDGER.md) for:
- Phase-by-phase build history
- Files created/modified per phase
- Unresolved structural gaps (ranked by severity)
- Known risk surfaces
