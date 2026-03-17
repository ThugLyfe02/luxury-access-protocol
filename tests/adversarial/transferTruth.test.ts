/**
 * PHASE N.1 — TRANSFER TRUTH ADVERSARIAL SUITE
 *
 * Verifies that:
 * - Transfer ID is stored on Rental entity after release
 * - Reconciliation detects transfer mismatch (reversed, not found)
 * - Transfer mismatches escalate conservatively (freeze + review)
 * - No duplicate money movement under retry/replay
 * - Drift detection is deterministic
 */
import { describe, it, expect } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { DriftType } from '../../src/domain/enums/DriftType';
import { DriftDetector } from '../../src/domain/reconciliation/DriftDetector';
import { InternalSnapshotBuilder, InternalPaymentSnapshot } from '../../src/domain/reconciliation/InternalSnapshot';
import { ProviderTransferSnapshot } from '../../src/domain/reconciliation/ProviderSnapshot';
import { DriftTaxonomy } from '../../src/domain/services/DriftTaxonomy';

// ========================================================================
// HELPERS
// ========================================================================

function makeReleasedRental(transferId?: string): Rental {
  const rental = Rental.create({
    id: 'r-transfer-1',
    renterId: 'renter-1',
    watchId: 'w-1',
    rentalPrice: 500,
    createdAt: new Date(),
  });
  rental.startExternalPayment('pi_transfer_1');
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  rental.confirmReturn();
  rental.releaseFunds(transferId);
  return rental;
}

function makeTransferSnapshot(overrides?: Partial<ProviderTransferSnapshot>): ProviderTransferSnapshot {
  return {
    transferId: 'tr_test_1',
    status: 'paid',
    amount: 40000,
    currency: 'usd',
    destination: 'acct_owner_1',
    reversed: false,
    metadata: {},
    fetchedAt: new Date(),
    ...overrides,
  };
}

function makeInternalSnap(rental: Rental): InternalPaymentSnapshot {
  return InternalSnapshotBuilder.fromRental(rental);
}

// ========================================================================
// A. TRANSFER ID STORAGE
// ========================================================================

describe('Transfer Truth: Transfer ID Stored on Rental', () => {
  it('stores externalTransferId when releaseFunds is called with transferId', () => {
    const rental = makeReleasedRental('tr_stored_1');
    expect(rental.externalTransferId).toBe('tr_stored_1');
    expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });

  it('externalTransferId is null when releaseFunds is called without transferId', () => {
    const rental = makeReleasedRental();
    expect(rental.externalTransferId).toBeNull();
    expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });

  it('externalTransferId survives restore from persistence', () => {
    const rental = makeReleasedRental('tr_persist_1');
    const restored = Rental.restore({
      id: rental.id,
      renterId: rental.renterId,
      watchId: rental.watchId,
      rentalPrice: rental.rentalPrice,
      escrowStatus: rental.escrowStatus,
      externalPaymentIntentId: rental.externalPaymentIntentId,
      externalTransferId: rental.externalTransferId,
      returnConfirmed: rental.returnConfirmed,
      disputeOpen: rental.disputeOpen,
      createdAt: rental.createdAt,
      version: rental.version,
    });
    expect(restored.externalTransferId).toBe('tr_persist_1');
  });
});

// ========================================================================
// B. TRANSFER DRIFT DETECTION
// ========================================================================

describe('Transfer Truth: Drift Detection — Confirmed Success', () => {
  it('no drift when internal released and transfer confirmed paid', () => {
    const rental = makeReleasedRental('tr_confirmed_1');
    const internal = makeInternalSnap(rental);
    const transfer = makeTransferSnapshot({ transferId: 'tr_confirmed_1' });

    const drifts = DriftDetector.detectTransferDrift(internal, transfer);
    expect(drifts).toHaveLength(0);
  });
});

describe('Transfer Truth: Drift Detection — Transfer Not Found', () => {
  it('detects TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED when provider returns null', () => {
    const rental = makeReleasedRental('tr_missing_1');
    const internal = makeInternalSnap(rental);

    const drifts = DriftDetector.detectTransferDrift(internal, null);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].driftType).toBe(DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED);
    expect(drifts[0].providerObjectIds).toContain('tr_missing_1');
  });
});

describe('Transfer Truth: Drift Detection — Transfer Reversed', () => {
  it('detects TRANSFER_REVERSED_BUT_INTERNAL_RELEASED when provider shows reversed', () => {
    const rental = makeReleasedRental('tr_reversed_1');
    const internal = makeInternalSnap(rental);
    const transfer = makeTransferSnapshot({
      transferId: 'tr_reversed_1',
      reversed: true,
      status: 'reversed',
    });

    const drifts = DriftDetector.detectTransferDrift(internal, transfer);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].driftType).toBe(DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED);
    expect(drifts[0].providerObjectIds).toContain('tr_reversed_1');
  });
});

describe('Transfer Truth: Drift Detection — No Transfer ID', () => {
  it('skips transfer drift detection when no externalTransferId on internal snapshot', () => {
    const rental = makeReleasedRental(); // no transfer ID
    const internal = makeInternalSnap(rental);

    const drifts = DriftDetector.detectTransferDrift(internal, null);
    expect(drifts).toHaveLength(0);
  });
});

describe('Transfer Truth: Drift Detection — Non-released Rental', () => {
  it('skips transfer drift detection when rental is not in released state', () => {
    const rental = Rental.create({
      id: 'r-not-released',
      renterId: 'renter-1',
      watchId: 'w-1',
      rentalPrice: 500,
      createdAt: new Date(),
    });
    rental.startExternalPayment('pi_not_released');
    rental.markPaymentAuthorized();
    rental.markPaymentCaptured();
    const internal = makeInternalSnap(rental);

    const drifts = DriftDetector.detectTransferDrift(internal, null);
    expect(drifts).toHaveLength(0);
  });
});

// ========================================================================
// C. TRANSFER DRIFT ESCALATION
// ========================================================================

describe('Transfer Truth: Escalation Policy', () => {
  it('TRANSFER_REVERSED_BUT_INTERNAL_RELEASED is CRITICAL with freeze + review', () => {
    const classification = DriftTaxonomy.classify(DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED);
    expect(classification.severity).toBe('CRITICAL');
    expect(classification.freezeRequired).toBe(true);
    expect(classification.reviewRequired).toBe(true);
    expect(classification.autoRepairAllowed).toBe(false);
  });

  it('TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED is CRITICAL with freeze + review', () => {
    const classification = DriftTaxonomy.classify(DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED);
    expect(classification.severity).toBe('CRITICAL');
    expect(classification.freezeRequired).toBe(true);
    expect(classification.reviewRequired).toBe(true);
    expect(classification.autoRepairAllowed).toBe(false);
  });
});

// ========================================================================
// D. DUPLICATE TRANSFER TRUTH DELIVERY
// ========================================================================

describe('Transfer Truth: Duplicate Detection', () => {
  it('duplicate transfer drift detection produces same result (deterministic)', () => {
    const rental = makeReleasedRental('tr_dup_1');
    const internal = makeInternalSnap(rental);
    const transfer = makeTransferSnapshot({
      transferId: 'tr_dup_1',
      reversed: true,
      status: 'reversed',
    });

    const drifts1 = DriftDetector.detectTransferDrift(internal, transfer);
    const drifts2 = DriftDetector.detectTransferDrift(internal, transfer);

    expect(drifts1).toHaveLength(1);
    expect(drifts2).toHaveLength(1);
    expect(drifts1[0].driftType).toBe(drifts2[0].driftType);
  });
});

// ========================================================================
// E. NO-REGRESSION: EXISTING PAYMENT DRIFT STILL WORKS
// ========================================================================

describe('Transfer Truth: No Regression on Payment Drift', () => {
  it('INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED still fires for payment-level mismatch', () => {
    const rental = makeReleasedRental('tr_pay_mismatch');
    const internal = makeInternalSnap(rental);

    // Provider shows payment not captured (payment-level mismatch, separate from transfer)
    const providerPayment = {
      paymentIntentId: 'pi_transfer_1',
      status: 'requires_capture' as const,
      amountCaptured: 0,
      amountRefunded: 0,
      currency: 'usd',
      disputeOpen: false,
      disputeStatus: null,
      metadata: {},
      fetchedAt: new Date(),
    };

    const paymentDrifts = DriftDetector.detectPaymentDrift(internal, providerPayment);
    expect(paymentDrifts.some(d => d.driftType === DriftType.INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED)).toBe(true);
  });
});
