# Reconstruction Ledger

Canonical record of what was built, when, and in what state.

This document is the source of truth for reconstruction progress.
If the code and this document disagree, investigate before trusting either.

---

## Phase R1 — Error Primitives

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/domain/errors/DomainError.ts` |
| Created | `src/domain/errors/ErrorCodes.ts` |

**Notes:**
- DomainError extends Error with `code` field and prototype fix.
- ErrorCodes.ts defines 42-code `DomainErrorCode` union type, ReadonlySet backing, and `isDomainErrorCode` type guard.
- Neither `DomainErrorCode` nor `isDomainErrorCode` is imported anywhere. All DomainError instances use raw string literals. This is a known gap.

---

## Phase 1 — Minimum Viable Domain Foundation

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/domain/enums/EscrowStatus.ts` |
| Created | `src/domain/enums/MarketplaceRole.ts` |
| Created | `src/domain/enums/VerificationStatus.ts` |
| Created | `src/domain/entities/User.ts` |
| Created | `src/domain/entities/Watch.ts` |
| Created | `src/domain/entities/Rental.ts` |
| Created | `src/domain/interfaces/PaymentProvider.ts` |
| Created | `src/infrastructure/payments/StripePaymentProvider.ts` |
| Created | `src/application/services/InitiateRentalService.ts` |

**Notes:**
- StripePaymentProvider is a stub. Every method throws `Error('Not implemented')`.
- InitiateRentalService was a thin orchestrator at this point, later modified in subsequent phases.

---

## Phase 2 — Risk/Compliance Enforcement

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/domain/enums/City.ts` |
| Created | `src/domain/services/RegulatoryGuardrails.ts` |
| Created | `src/domain/services/CompliancePolicy.ts` |
| Created | `src/domain/services/RiskPolicy.ts` |
| Created | `src/domain/services/UnitEconomicsGuard.ts` |
| Modified | `src/application/services/InitiateRentalService.ts` |

**Notes:**
- RegulatoryGuardrails scans operation names and context for 13 forbidden custody keywords.
- CompliancePolicy enforces NYC-only geographic containment.
- RiskPolicy enforces self-rental block, high-risk block, verification allowlist, role ceiling.
- UnitEconomicsGuard enforces margin floor with processing fees and loss buffer.

---

## Phase 2.1 — Hardening Pass

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Modified | `src/domain/services/RegulatoryGuardrails.ts` |
| Modified | `src/domain/services/CompliancePolicy.ts` |
| Modified | `src/domain/services/RiskPolicy.ts` |
| Modified | `src/domain/services/UnitEconomicsGuard.ts` |
| Modified | `src/application/services/InitiateRentalService.ts` |

**Notes:**
- Fixed: CompliancePolicy was defined but not called from InitiateRentalService.
- Fixed: Watch verification changed from denylist to explicit allowlist.
- Fixed: RegulatoryGuardrails JSON.stringify wrapped in try/catch.
- Fixed: UnitEconomicsGuard rejects NaN/Infinity/negative input.

---

## Phase: Core Domain Hardening

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/domain/enums/RenterTier.ts` |
| Modified | `src/domain/entities/Rental.ts` |
| Modified | `src/domain/interfaces/PaymentProvider.ts` |
| Modified | `src/infrastructure/payments/StripePaymentProvider.ts` |

**Notes:**
- Added `releaseFunds()` preconditions: returnConfirmed + !disputeOpen.
- Added `confirmReturn()`, `markDisputed()`, `resolveDispute()` to Rental.
- Added `transferToConnectedAccount` to PaymentProvider interface.
- RenterTier enum added (BRONZE through BLACK).

---

## Phase: Operational Risk Backbone

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/domain/enums/KycStatus.ts` |
| Created | `src/domain/enums/CustodyEventType.ts` |
| Created | `src/domain/enums/InsurancePolicyStatus.ts` |
| Created | `src/domain/enums/ReviewSeverity.ts` |
| Created | `src/domain/entities/KycProfile.ts` |
| Created | `src/domain/entities/CustodyEvent.ts` |
| Created | `src/domain/entities/ChainOfCustody.ts` |
| Created | `src/domain/entities/ConditionReport.ts` |
| Created | `src/domain/entities/InsurancePolicy.ts` |
| Created | `src/domain/entities/ManualReviewCase.ts` |
| Created | `src/domain/interfaces/KycRepository.ts` |
| Created | `src/domain/interfaces/InsuranceRepository.ts` |
| Created | `src/domain/interfaces/ReviewRepository.ts` |
| Created | `src/domain/services/RiskAnalyzer.ts` |
| Created | `src/domain/services/TierEngine.ts` |
| Modified | `src/domain/services/RiskPolicy.ts` |

**Notes:**
- KycProfile has FSM with PEP/sanctions flags.
- ChainOfCustody is append-only chronological log.
- ConditionReport has self-approval guard for high-value watches.
- InsurancePolicy has coverage/deductible/premium with active check.
- ManualReviewCase has severity-based blocking.
- RiskAnalyzer produces 7 signals, creates review cases.
- TierEngine computes tier from thresholds and enforces value ceilings.
- RiskPolicy gained `ensureKycVerified` and `ensureInsuranceActive` methods.

---

## Phase: Application Orchestration Wiring

**Status:** Complete
**Compile:** Pass

| Action | File |
|---|---|
| Created | `src/application/services/MarketplacePaymentService.ts` |
| Modified | `src/application/services/InitiateRentalService.ts` |

**Notes:**
- MarketplacePaymentService handles external payment events: authorized, captured, refunded, dispute open/resolve, return confirmation, release to owner.
- releaseToOwner has 6 hard gates: captured state, return confirmed, no dispute, no blocking reviews, valid connected account, positive amount.
- InitiateRentalService updated with full gate sequence: regulatory → compliance → KYC → risk policy → insurance → tier → economics → risk analysis.
- Critical risk signals block rental creation.

---

## Phase: Adversarial Audit

**Status:** Complete (read-only)

No files modified. Findings documented below.

---

## Unresolved Structural Gaps

These are known issues identified by adversarial audit. They are not bugs to fix casually — they require deliberate architectural decisions.

### Critical

| # | Gap | Impact |
|---|---|---|
| 1 | **Rental constructor accepts arbitrary escrowStatus** | Can construct Rental in CAPTURED/RELEASED state, bypassing entire lifecycle. |
| 2 | **Dispute resolution dead-end** | `resolveDispute()` clears `disputeOpen` but leaves `escrowStatus = DISPUTED`. No method transitions DISPUTED → CAPTURED. Resolved disputes can only reach REFUNDED. |
| 3 | **No persistence** | No RentalRepository. No save calls anywhere. All state is in-memory transient. |
| 4 | **releaseToOwner review gate is caller-controlled** | Caller provides `blockingReviewCases` array. Empty array bypasses the gate. |
| 5 | **Review cases never persisted** | InitiateRentalService creates ManualReviewCase but never saves it. |

### High

| # | Gap | Impact |
|---|---|---|
| 6 | **TierEngine.computeTier never called** | Tier passed as raw input to orchestrator. Caller can claim any tier. |
| 7 | **ChainOfCustody / ConditionReport not wired** | Entities exist. Zero references from application services. Not a release gate. |
| 8 | **KYC / insurance not rechecked at release** | Checked at initiation only. Expiry between initiation and release is undetected. |
| 9 | **17 of 42 error codes never thrown** | Phantom contracts in ErrorCodes.ts. |
| 10 | **ErrorCodes.ts type system completely unused** | DomainErrorCode and isDomainErrorCode never imported. |
| 11 | **3 repository interfaces never consumed** | KycRepository, InsuranceRepository, ReviewRepository exist but nothing imports them. |
| 12 | **StripePaymentProvider is a runtime stub** | Every method throws Error('Not implemented'). |
| 13 | **No auth/authz on any entry point** | MarketplacePaymentService accepts bare Rental objects. |
| 14 | **Critical signal check uses string literal instead of enum** | `s.severity === 'CRITICAL'` instead of `ReviewSeverity.CRITICAL`. |
| 15 | **KycProfile constructor allows VERIFIED without dates** | Can construct verified KYC with null verifiedAt/expiresAt. |

### Medium

| # | Gap | Impact |
|---|---|---|
| 16 | **`escrowStatus` field naming contains "escrow"** | Would trigger own regulatory scan if passed as context value. |
| 17 | **Ledger error codes imply future custody risk** | 3 ledger codes exist with no consumer. |
| 18 | **Platform exposure caps absent** | 3 error codes exist, zero enforcement. |
| 19 | **Inventory minimum absent** | Error code exists, zero enforcement. |
| 20 | **No idempotency on payment event handlers** | Duplicate webhook delivery would fail on FSM but has no idempotency token. |

---

## Known Risk Surfaces

| Surface | Risk | Mitigation status |
|---|---|---|
| Direct Rental construction | State injection | **Unmitigated** |
| Caller-provided tier | Privilege escalation | **Unmitigated** |
| Caller-provided review cases | Gate bypass | **Unmitigated** |
| Absent persistence | State loss | **Unmitigated** |
| Stub payment provider | Runtime failure | **Expected — not production code** |
| Ledger error codes | Regulatory signal | **Unmitigated — needs architectural decision** |
