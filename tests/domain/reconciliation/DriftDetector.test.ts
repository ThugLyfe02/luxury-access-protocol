import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../../../src/domain/reconciliation/DriftDetector';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { InternalPaymentSnapshot } from '../../../src/domain/reconciliation/InternalSnapshot';
import { ProviderPaymentSnapshot } from '../../../src/domain/reconciliation/ProviderSnapshot';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeInternal(overrides: Partial<InternalPaymentSnapshot> = {}): InternalPaymentSnapshot {
  return {
    rentalId: 'rental-1',
    escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
    externalPaymentIntentId: 'pi_test',
    rentalPrice: 500,
    returnConfirmed: false,
    disputeOpen: false,
    renterId: 'renter-1',
    watchId: 'watch-1',
    version: 1,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderPaymentSnapshot> = {}): ProviderPaymentSnapshot {
  return {
    paymentIntentId: 'pi_test',
    status: 'requires_capture',
    amountCaptured: 0,
    amountRefunded: 0,
    currency: 'usd',
    disputeOpen: false,
    disputeStatus: null,
    metadata: {},
    fetchedAt: NOW,
    ...overrides,
  };
}

describe('DriftDetector', () => {
  describe('detectPaymentDrift', () => {
    it('returns empty array when internal and provider are in sync (authorized vs requires_capture)', () => {
      const drifts = DriftDetector.detectPaymentDrift(makeInternal(), makeProvider());
      expect(drifts).toHaveLength(0);
    });

    it('returns empty array when no external payment intent and no provider', () => {
      const internal = makeInternal({
        externalPaymentIntentId: null,
        escrowStatus: EscrowStatus.NOT_STARTED,
      });
      const drifts = DriftDetector.detectPaymentDrift(internal, null);
      expect(drifts).toHaveLength(0);
    });

    // ORPHAN_INTERNAL_RECORD: internal has payment reference but provider returns null
    it('detects ORPHAN_INTERNAL_RECORD when provider returns null for committed payment', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_CAPTURED });
      const drifts = DriftDetector.detectPaymentDrift(internal, null);

      expect(drifts).toHaveLength(1);
      expect(drifts[0].driftType).toBe(DriftType.ORPHAN_INTERNAL_RECORD);
      expect(drifts[0].providerObjectIds).toContain('pi_test');
    });

    it('does not flag ORPHAN_INTERNAL_RECORD when escrow is NOT_STARTED', () => {
      const internal = makeInternal({
        escrowStatus: EscrowStatus.NOT_STARTED,
        externalPaymentIntentId: 'pi_test',
      });
      const drifts = DriftDetector.detectPaymentDrift(internal, null);
      expect(drifts).toHaveLength(0);
    });

    // INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING
    it('detects INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING when provider canceled', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      const provider = makeProvider({ status: 'canceled' });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING)).toBe(true);
    });

    it('detects INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING when provider unknown', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      const provider = makeProvider({ status: 'unknown' });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING)).toBe(true);
    });

    it('does NOT flag when internal authorized and provider requires_capture', () => {
      const drifts = DriftDetector.detectPaymentDrift(
        makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED }),
        makeProvider({ status: 'requires_capture' }),
      );
      expect(drifts.filter(d => d.driftType === DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING)).toHaveLength(0);
    });

    // PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED
    it('detects PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      const provider = makeProvider({ status: 'succeeded', amountCaptured: 500 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED)).toBe(true);
    });

    it('does NOT flag PROVIDER_CAPTURED when internal already captured', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_CAPTURED });
      const provider = makeProvider({ status: 'succeeded', amountCaptured: 500 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.filter(d => d.driftType === DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED)).toHaveLength(0);
    });

    // INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED
    it('detects INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.FUNDS_RELEASED_TO_OWNER });
      const provider = makeProvider({ status: 'requires_capture', amountCaptured: 0 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED)).toBe(true);
    });

    // PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN
    it('detects PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN', () => {
      const internal = makeInternal({
        escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
        disputeOpen: false,
      });
      const provider = makeProvider({
        status: 'succeeded',
        amountCaptured: 500,
        disputeOpen: true,
        disputeStatus: 'needs_response',
      });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN)).toBe(true);
    });

    // INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED
    it('detects INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED', () => {
      const internal = makeInternal({
        escrowStatus: EscrowStatus.DISPUTED,
        disputeOpen: true,
      });
      const provider = makeProvider({
        status: 'succeeded',
        amountCaptured: 500,
        disputeOpen: false,
      });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED)).toBe(true);
    });

    // REFUND_STATE_MISMATCH — internal refunded but provider shows no refund
    it('detects REFUND_STATE_MISMATCH when internal refunded but provider has no refund', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.REFUNDED });
      const provider = makeProvider({ status: 'succeeded', amountCaptured: 500, amountRefunded: 0 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.REFUND_STATE_MISMATCH)).toBe(true);
    });

    // REFUND_STATE_MISMATCH — provider refunded but internal not
    it('detects REFUND_STATE_MISMATCH when provider has refund but internal does not', () => {
      const internal = makeInternal({
        escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
        disputeOpen: false,
      });
      const provider = makeProvider({ status: 'succeeded', amountCaptured: 500, amountRefunded: 200 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.some(d => d.driftType === DriftType.REFUND_STATE_MISMATCH)).toBe(true);
    });

    // Multiple drifts can coexist
    it('detects multiple drifts simultaneously', () => {
      // Internal authorized, provider captured + dispute open
      const internal = makeInternal({
        escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
        disputeOpen: false,
      });
      const provider = makeProvider({
        status: 'succeeded',
        amountCaptured: 500,
        disputeOpen: true,
      });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      // Should detect both PROVIDER_CAPTURED and PROVIDER_DISPUTE
      const types = drifts.map(d => d.driftType);
      expect(types).toContain(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED);
      expect(types).toContain(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN);
    });

    // Snapshots are captured in drift
    it('captures internal and provider snapshots in drift', () => {
      const internal = makeInternal({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      const provider = makeProvider({ status: 'succeeded', amountCaptured: 500 });
      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      expect(drifts.length).toBeGreaterThan(0);
      expect(drifts[0].internalSnapshot).toBeDefined();
      expect(drifts[0].providerSnapshot).toBeDefined();
      expect(drifts[0].providerObjectIds).toContain('pi_test');
    });
  });
});
